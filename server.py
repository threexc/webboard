#!/usr/bin/env python3
"""Serve the dashboard and proxy the feeds/calendars listed in config.json.

Browsers block cross-origin fetches of most RSS/ICS URLs (CORS), so the page
asks this server for them via /proxy?url=... . Only URLs that appear in
config.json are fetched, so the proxy can't be abused to reach other sites.

Calendar `urls` (often secret iCal links) never reach the browser: the served
config replaces them with "private:N" tokens that only this server resolves.

Usage:
  python3 server.py                        # local only: http://127.0.0.1:8800
  python3 server.py --host 0.0.0.0         # whole network
  DASHBOARD_PASSWORD=... python3 server.py --host 0.0.0.0   # require a password
Options: --port N, --allow-host NAME (extra hostname/IP clients may use; repeatable).
"""
import argparse
import base64
import hmac
import http.server
import ipaddress
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js"}
CACHE_SECONDS = 600
MAX_BYTES = 5 * 1024 * 1024
PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "")
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    # Scripts only from this server, so a javascript: link or injected markup can't run code.
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src * data:; connect-src 'self' https://api.open-meteo.com; frame-src http: https:; "
    "object-src 'none'; base-uri 'none'; form-action 'self'",
}
cache = {}  # url -> (fetched_at, body)
allowed_hosts = set()


def load_config():
    return json.loads((ROOT / "config.json").read_text())


def calendars(cfg):
    """Every calendar widget's config, including ones inside groups."""
    for w in cfg.get("widgets", []):
        for m in w.get("widgets", []) if w.get("type") == "group" else [w]:
            if m.get("type") == "calendar":
                yield m


def private_urls(cfg):
    """Personal calendar links, in order; the browser only sees their index."""
    return [u for cal in calendars(cfg) for u in cal.get("urls", [])]


def public_config(cfg):
    n = 0
    for cal in calendars(cfg):
        cal["urls"] = [f"private:{n + i}" for i in range(len(cal.get("urls", [])))]
        n += len(cal["urls"])
    return cfg


def allowed_urls(cfg):
    """Every string under a "url" or "urls" key anywhere in config.json."""
    found = set()

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "url" and isinstance(value, str):
                    found.add(value)
                elif key == "urls" and isinstance(value, list):
                    found.update(v for v in value if isinstance(v, str))
                    walk(value)  # entries may also be {"url": ...} objects
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(cfg)
    return found


class NoPrivateRedirects(urllib.request.HTTPRedirectHandler):
    """Follow redirects only to public internet addresses, so a feed can't bounce
    the proxy onto machines on your network."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parts = urllib.parse.urlparse(newurl)
        if parts.scheme not in ("http", "https"):
            raise urllib.error.URLError(f"refusing redirect to {newurl}")
        for info in socket.getaddrinfo(parts.hostname, parts.port or 443):
            if not ipaddress.ip_address(info[4][0]).is_global:
                raise urllib.error.URLError(f"refusing redirect to non-public address {newurl}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


opener = urllib.request.build_opener(NoPrivateRedirects)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (dashboard)"})
    with opener.open(req, timeout=15) as resp:
        body = resp.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        raise ValueError(f"response larger than {MAX_BYTES} bytes")
    return body


class Handler(http.server.BaseHTTPRequestHandler):
    def reply(self, status, body, content_type="text/plain; charset=utf-8", extra=()):
        self.send_response(status)
        for k, v in [("Content-Type", content_type), ("Content-Length", str(len(body))),
                     ("Cache-Control", "no-store"), *SECURITY_HEADERS.items(), *extra]:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        if not PASSWORD:
            return True
        scheme, _, token = (self.headers.get("Authorization") or "").partition(" ")
        try:
            given = base64.b64decode(token).decode().partition(":")[2]
        except ValueError:
            return False
        return scheme == "Basic" and hmac.compare_digest(given.encode(), PASSWORD.encode())

    def do_GET(self):
        # Reject unexpected Host names (blocks DNS-rebinding attacks from other websites).
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        if host not in allowed_hosts:
            return self.reply(403, f"Unknown host {host!r}; start the server with --allow-host {host}\n".encode())
        if not self.authorized():
            return self.reply(401, b"Password required\n", extra=[("WWW-Authenticate", 'Basic realm="dashboard"')])

        parsed = urllib.parse.urlparse(self.path)
        try:
            cfg = load_config()
        except ValueError as e:  # let the page show the JSON error
            if parsed.path == "/config.json":
                return self.reply(200, (ROOT / "config.json").read_bytes(), "application/json")
            return self.reply(500, f"config.json is invalid: {e}\n".encode())

        if parsed.path in STATIC:
            name = STATIC[parsed.path]
            kind = "text/html" if name.endswith(".html") else "text/javascript"
            return self.reply(200, (ROOT / name).read_bytes(), kind + "; charset=utf-8")
        if parsed.path == "/config.json":
            return self.reply(200, json.dumps(public_config(cfg)).encode(), "application/json")
        if parsed.path != "/proxy":
            return self.reply(404, b"Not found\n")

        url = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
        if url.startswith("private:"):
            secrets, index = private_urls(cfg), url[len("private:"):]
            url = secrets[int(index)] if index.isdigit() and int(index) < len(secrets) else ""
        if url not in allowed_urls(cfg):
            return self.reply(403, b"URL not listed in config.json\n")

        hit = cache.get(url)
        if not hit or time.time() - hit[0] > CACHE_SECONDS:
            try:
                hit = cache[url] = (time.time(), fetch(url))
            except Exception as e:
                if not hit:  # serve the stale copy if there is one
                    return self.reply(502, f"Fetch failed: {e}\n".encode())
        # Always plain text: the page parses it, and the browser must never run it as HTML.
        self.reply(200, hit[1])

    def log_message(self, fmt, *args):
        pass  # quiet


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Serve the dashboard.")
    ap.add_argument("--host", default="127.0.0.1", help="address to listen on (0.0.0.0 = all networks)")
    ap.add_argument("--port", type=int, default=8800)
    ap.add_argument("--allow-host", action="append", default=[], help="extra hostname/IP clients may use")
    args = ap.parse_args()

    name = socket.gethostname()
    allowed_hosts.update(["localhost", "127.0.0.1", "::1", name.lower(), f"{name.lower()}.local", args.host],
                         (h.lower() for h in args.allow_host))
    try:
        allowed_hosts.update(info[4][0] for info in socket.getaddrinfo(name, None))
    except OSError:
        pass
    try:  # this machine's LAN address (connecting a UDP socket sends no packets)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            allowed_hosts.add(s.getsockname()[0])
    except OSError:
        pass
    if args.host not in ("127.0.0.1", "localhost", "::1") and not PASSWORD:
        print("Warning: listening on the network with no DASHBOARD_PASSWORD set; anyone on the network can use it.")
    print(f"Dashboard on http://{args.host}:{args.port}  (accepted host names: {', '.join(sorted(allowed_hosts))})")
    http.server.ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
