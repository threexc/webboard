# Dashboard

A browser homepage driven by `config.json`. No dependencies beyond Python 3.

```sh
python3 server.py                  # this machine only: http://127.0.0.1:8800
python3 server.py --port 9000      # another port
```

Set your browser's homepage / new-tab page to `http://127.0.0.1:8800`.

The server exists because browsers block cross-origin fetches of RSS/ICS
files. It serves the page and proxies only URLs that appear in `config.json`
(cached for 10 minutes). Edit `config.json` and reload the page; no restart needed.

### On your local network

```sh
DASHBOARD_PASSWORD='choose-one' python3 server.py --host 0.0.0.0
```

- Without `DASHBOARD_PASSWORD`, anyone on the network can open it (the server
  warns about this). With it, browsers ask for a password (any username).
- The server only answers to names it knows: `localhost`, this machine's
  hostname (and `hostname.local`) and its IP addresses. If you reach it by
  another name, add `--allow-host that.name` (repeatable). This blocks
  DNS-rebinding attacks from other websites.
- It is plain HTTP, so the password and page travel unencrypted. For HTTPS,
  keep the default `--host 127.0.0.1` and put a reverse proxy such as Caddy in
  front (add the proxy's public hostname with `--allow-host`).

Security notes: only `index.html`, `app.js` and `config.json` are served (not
`.git` or other files); calendar `urls` are replaced with opaque tokens before
`config.json` reaches the browser, so secret iCal links stay on the server;
proxied responses are capped at 5 MB, always sent as plain text, and redirects
to private network addresses are refused; links from feeds must be http(s).

## Config

Top level: `title`, `columns` (grid width), `refreshMinutes`, `theme`
(any CSS variable: `--accent`, `--bg`, `--card`, `--fg`, `--muted`, `--line`),
`tickers`, `widgets`.

`tickers`: a list of scrolling headline rows, stacked at the top of the page:
`{ "label": "World", "urls": [feed URLs], "speed": px/sec, "limitPerFeed": n, "showSource": true }`.
`label` is the fixed tag on the left (optional); `showSource: false` hides each
headline's feed name. Hover a row to pause it. Empty list = no tickers.

Every widget takes `type`, `title`, and optionally `column` (pin to a grid column, 1 = leftmost), `span` (columns) and `rowSpan`.

| type       | options |
|------------|---------|
| `clock`    | `format24h` |
| `weather`  | `locations: [{ "name", "latitude", "longitude" }]`, `show` (panels, each with a dropdown; default 2), `units` (`metric`/`imperial`), `days` — data from open-meteo.com, no key |
| `calendar` | `urls` (`.ics` links, e.g. Google Calendar's "secret address in iCal format"), `daysAhead`, `holidays: { "regions": [{ "name", "url" }], "show", "count" }` (`show` dropdowns pick which regions' holidays appear; `count` upcoming holidays listed per region) |
| `headlines` | `groups: [{ "label", "color", "urls", "limitPerFeed" }]`, `height` (e.g. `"24em"`, or `"fill"` to stretch to the card's height, e.g. with `rowSpan`), `speed` (px/sec), `limitPerFeed`, `showSource` — one vertical scrolling list mixing all groups, newest first, each headline tagged with its group's colour (auto-picked if `color` omitted). A `urls` entry can be `{ "url", "expand": true }` to split digest feeds like HN Daily into one headline per story. Hover to pause. |
| `feed`     | `url` (RSS or Atom), `limit`, `summary` (show excerpt), `mode: "latest"` (render the newest item's content — good for digest feeds like HN Daily) |
| `todo`     | `id` (storage key) |
| `notes`    | `id` (storage key) |
| `links`    | `links: [{ "label", "href" }]` |
| `iframe`   | `src`, `height` — only for sites that allow framing |
| `group`    | `widgets: [...]` — several widgets stacked in one card (`span`/`rowSpan` go on the group) |

Notes, to-dos and dropdown choices live in the browser's localStorage for `127.0.0.1:8800`;
clearing site data deletes them.

Calendar limitation: recurring events (RRULE) aren't expanded, and events with
a TZID are shown as if in local time.

## Start at login (systemd user service)

```ini
# ~/.config/systemd/user/dashboard.service
[Unit]
Description=Browser dashboard

[Service]
ExecStart=/usr/bin/python3 %h/workspace/dashboard/server.py
# For network access, e.g.: --host 0.0.0.0, plus Environment=DASHBOARD_PASSWORD=...
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now dashboard
```

## Adding a widget type

Add a function to the `widgets` object in `app.js`: `name(w, body)` receives
the widget's config and an element to fill. Make it `async` and add its type to
`isAsync` in the boot code if it fetches data and should auto-refresh.
