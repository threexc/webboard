// Dashboard: reads config.json and renders widgets. See README.md for config options.

const clean = kids => kids.flat(Infinity).filter(k => k != null && k !== false);
const fill = (e, ...kids) => e.replaceChildren(...clean(kids));
// Only http(s) links: a javascript: href from a feed would run code on this page when clicked.
const safeUrl = u => { try { return /^https?:$/.test(new URL(u).protocol) ? u : undefined; } catch { return undefined; } };
const el = (tag, props = {}, ...kids) => {
  if ('href' in props) props = { ...props, href: safeUrl(props.href) };
  const e = Object.assign(document.createElement(tag), props);
  if (props.href === undefined) e.removeAttribute('href');
  e.append(...clean(kids));
  return e;
};
const proxy = url => fetch('/proxy?url=' + encodeURIComponent(url)).then(r => {
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.text();
});
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---------- feeds (RSS 2.0 and Atom) ----------
const resolve = (link, base) => { try { return new URL(link, base).href; } catch { return ''; } };
async function loadFeed(url) {
  const xml = new DOMParser().parseFromString(await proxy(url), 'text/xml');
  const source = xml.querySelector('channel > title, feed > title')?.textContent.trim() || new URL(url).hostname;
  const items = [...xml.querySelectorAll('item, entry')].map(it => {
    const get = sel => it.querySelector(sel)?.textContent.trim() || '';
    const linkEl = it.querySelector('link[rel=alternate], link:not([rel])') || it.querySelector('link');
    return {
      title: get('title'),
      link: resolve(linkEl?.getAttribute('href') || linkEl?.textContent.trim() || '', url),
      html: get('description') || get('content') || get('summary'),
      date: new Date(get('pubDate') || get('updated') || get('published')),
      source,
    };
  });
  return { source, items };
}

// Turn digest feeds (e.g. HN Daily: one item per day listing stories) into one item per story:
// the first link inside each <li> of each item's content.
function expandDigest(feed) {
  const items = feed.items.flatMap(it =>
    [...new DOMParser().parseFromString(it.html, 'text/html').querySelectorAll('li')]
      .map(li => li.querySelector('a[href^="http"]')).filter(Boolean)
      .map(a => ({ title: a.textContent.trim(), link: a.getAttribute('href'), html: '', date: it.date, source: feed.source })));
  return { ...feed, items };
}

// Keep only harmless markup from feed HTML: a whitelist of tags, http(s) links, and span classes.
const SAFE_TAGS = new Set(['P', 'UL', 'OL', 'LI', 'A', 'BR', 'SPAN', 'EM', 'STRONG', 'B', 'I', 'CODE', 'BLOCKQUOTE']);
function sanitize(html) {
  const clean = node => [...node.childNodes].map(n => {
    if (n.nodeType === Node.TEXT_NODE) return document.createTextNode(n.textContent);
    if (n.nodeType !== Node.ELEMENT_NODE) return null;
    if (!SAFE_TAGS.has(n.tagName)) return el('span', {}, clean(n));
    const out = el(n.tagName.toLowerCase(), {}, clean(n));
    if (n.tagName === 'A' && /^https?:/i.test(n.getAttribute('href') || '')) out.href = n.getAttribute('href');
    if (n.tagName === 'SPAN' && n.className) out.className = n.className;
    return out;
  });
  return clean(new DOMParser().parseFromString(html, 'text/html').body);
}
const plain = (html, max = 220) => {
  const t = new DOMParser().parseFromString(html, 'text/html').body.textContent.trim().replace(/\s+/g, ' ');
  return t.length > max ? t.slice(0, max) + '…' : t;
};

// ---------- calendar (.ics) ----------
// ponytail: recurring events (RRULE) are not expanded and TZID times are read as local time;
// swap in ical.js if you need full recurrence/timezone support.
function parseICS(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') ev = {};
    else if (line === 'END:VEVENT') { if (ev.start) events.push(ev); ev = null; }
    else if (ev) {
      const [, key, params, value] = line.match(/^([A-Z-]+)([^:]*):(.*)$/) || [];
      if (key === 'SUMMARY') ev.title = value.replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ');
      if (key === 'DTSTART') {
        const m = value.match(/^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)(Z)?)?/);
        if (!m) continue;
        const [, y, mo, d, h, mi, s, z] = m;
        ev.allDay = !h || params.includes('VALUE=DATE');
        ev.start = z ? new Date(Date.UTC(y, mo - 1, d, h, mi, s)) : new Date(y, mo - 1, d, h || 0, mi || 0, s || 0);
      }
    }
  }
  return events;
}
const sameDay = (a, b) => a.toDateString() === b.toDateString();

// ---------- weather (open-meteo.com, no key needed) ----------
const WMO = {
  0: ['☀️', 'Clear'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
  45: ['🌫️', 'Fog'], 48: ['🌫️', 'Rime fog'], 51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌧️', 'Heavy drizzle'],
  56: ['🌧️', 'Freezing drizzle'], 57: ['🌧️', 'Freezing drizzle'], 61: ['🌦️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'],
  66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'], 71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'],
  77: ['🌨️', 'Snow grains'], 80: ['🌦️', 'Showers'], 81: ['🌧️', 'Showers'], 82: ['⛈️', 'Violent showers'],
  85: ['🌨️', 'Snow showers'], 86: ['❄️', 'Snow showers'], 95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm, hail'], 99: ['⛈️', 'Thunderstorm, hail'],
};

// One forecast panel for a location ({ name, latitude, longitude }) from open-meteo.com.
async function forecast(w, loc) {
  const imperial = w.units === 'imperial';
  const q = new URLSearchParams({
    latitude: loc.latitude, longitude: loc.longitude, timezone: 'auto', forecast_days: w.days || 5,
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    temperature_unit: imperial ? 'fahrenheit' : 'celsius', wind_speed_unit: imperial ? 'mph' : 'kmh',
  });
  const r = await fetch('https://api.open-meteo.com/v1/forecast?' + q);
  if (!r.ok) throw new Error('weather ' + r.status);
  const { current: c, daily: d } = await r.json();
  const [icon, desc] = WMO[c.weather_code] || ['', ''];
  const deg = Math.round, wind = imperial ? 'mph' : 'km/h';
  return [
    el('div', { className: 'now', textContent: `${icon} ${deg(c.temperature_2m)}°` }),
    el('div', { textContent: `${desc} · feels ${deg(c.apparent_temperature)}° · ${deg(c.wind_speed_10m)} ${wind} · ${c.relative_humidity_2m}% RH` }),
    el('div', { className: 'days' }, d.time.map((t, i) => el('div', {},
      el('div', { className: 'muted', textContent: new Date(t + 'T12:00').toLocaleDateString([], { weekday: 'short' }) }),
      el('div', { textContent: (WMO[d.weather_code[i]] || [''])[0], title: (WMO[d.weather_code[i]] || ['', ''])[1] }),
      el('div', { textContent: `${deg(d.temperature_2m_max[i])}° / ${deg(d.temperature_2m_min[i])}°` }),
      el('div', { className: 'muted', textContent: `${d.precipitation_probability_max[i] ?? 0}% 💧` }),
    ))),
  ];
}

// `n` dropdowns choosing among `options` (each has a `name`); choices are remembered in localStorage.
function pickers(key, options, n, onChange) {
  n = Math.min(n, options.length);
  const chosen = store.get(key, []).filter(name => options.some(o => o.name === name)).slice(0, n);
  for (const o of options) if (chosen.length < n && !chosen.includes(o.name)) chosen.push(o.name);
  const selects = chosen.map((name, i) => el('select', {
    onchange: e => { chosen[i] = e.target.value; store.set(key, chosen); onChange(); },
  }, options.map(o => el('option', { value: o.name, textContent: o.name, selected: o.name === name }))));
  return { selects, picked: chosen.map(name => options.find(o => o.name === name)) };
}

// ---------- widgets: each fills `body`; `rerun` re-renders the widget ----------
const widgets = {
  clock(w, body) {
    const time = el('div', { className: 'time' }), date = el('div', { className: 'muted' });
    body.append(time, date);
    const tick = () => {
      const now = new Date();
      time.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: !w.format24h });
      date.textContent = now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    };
    tick();
    setInterval(tick, 1000);
  },

  async weather(w, body, rerun) {
    const locations = w.locations || [w];
    const { selects, picked } = pickers('weather:' + (w.id || w.title), locations, w.show ?? 2, rerun);
    const panels = await Promise.allSettled(picked.map(loc => forecast(w, loc)));
    fill(body, panels.map((p, i) => el('div', { className: 'panel' },
      locations.length > 1 ? selects[i] : el('div', { className: 'muted', textContent: picked[i].name }),
      p.status === 'fulfilled' ? p.value : el('div', { className: 'err', textContent: p.reason.message }))));
  },

  async calendar(w, body, rerun) {
    const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const regions = w.holidays?.regions || [];
    const { selects, picked } = pickers('holidays:' + (w.id || w.title), regions, w.holidays?.show ?? 2, rerun);
    const load = (url, holiday) => proxy(url).then(t => parseICS(t).map(e => ({ ...e, holiday })));
    const results = await Promise.allSettled([...(w.urls || []).map(u => load(u, null)), ...picked.map(r => load(r.url, r.name))]);
    const events = results.flatMap(r => r.status === 'fulfilled' ? r.value : []).sort((a, b) => a.start - b.start);
    const errors = results.filter(r => r.status === 'rejected').map(r => el('div', { className: 'err', textContent: r.reason.message }));
    const label = e => (e.title || '(untitled)') + (e.holiday && picked.length > 1 ? ` (${e.holiday})` : '');

    // Month grid, weeks starting Monday.
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
    const rows = [];
    for (let d = new Date(start); rows.length < 6; ) {
      const row = el('tr');
      for (let i = 0; i < 7; i++, d.setDate(d.getDate() + 1)) {
        const day = events.filter(e => sameDay(e.start, d));
        const cls = [sameDay(d, now) && 'today', d.getMonth() !== now.getMonth() && 'other',
          day.some(e => !e.holiday) && 'has', day.some(e => e.holiday) && 'holiday'];
        row.append(el('td', {}, el('span', { className: cls.filter(Boolean).join(' '), textContent: d.getDate(),
          title: day.map(label).join('\n'), style: 'display:inline-block;width:1.8em;line-height:1.8em' })));
      }
      rows.push(row);
    }

    // Regular events within the horizon, plus the next few holidays of each region however far away.
    const horizon = new Date(today); horizon.setDate(horizon.getDate() + (w.daysAhead || 14));
    const future = events.filter(e => e.start >= today);
    const holidays = picked.flatMap(r => future.filter(e => e.holiday === r.name).slice(0, w.holidays?.count ?? 3));
    const upcoming = future.filter(e => (!e.holiday && e.start < horizon) || holidays.includes(e));
    fill(body,
      el('div', { className: 'muted', textContent: now.toLocaleDateString([], { month: 'long', year: 'numeric' }) }),
      el('table', {}, el('tr', {}, ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(x => el('th', { textContent: x }))), rows),
      regions.length > 1 && el('div', { className: 'pickers' }, el('span', { className: 'muted', textContent: 'Holidays:' }), selects),
      errors,
      upcoming.length ? el('ul', { style: 'margin-top:.6em' }, upcoming.map(e => el('li', { className: e.holiday ? 'holiday' : '' },
        el('span', { className: 'muted', textContent: e.start.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) +
          (e.allDay ? '' : ' ' + e.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + ' ' }),
        label(e)))) : w.urls?.length || picked.length ? el('div', { className: 'muted', textContent: 'Nothing upcoming.' }) : null,
    );
  },

  // One vertical scrolling list of headlines from several feed groups, each with a colour-coded tag.
  async headlines(w, body) {
    body.classList.add('vticker');
    const palette = ['#d1495b', '#2e86ab', '#3b8b5a', '#8e5ad1', '#e07a3f', '#a07a12'];
    const groups = await Promise.all((w.groups || []).map(async (g, i) => {
      // A url entry is a string, or { "url", "expand": true } to split digest items into their links.
      const feeds = await Promise.allSettled((g.urls || []).map(u => typeof u === 'string' ? loadFeed(u)
        : loadFeed(u.url).then(f => u.expand ? expandDigest(f) : f)));
      return feeds.flatMap(f => f.status === 'fulfilled' ? f.value.items.slice(0, g.limitPerFeed ?? w.limitPerFeed ?? 8) : [])
        .map(it => ({ ...it, group: g.label, color: g.color || palette[i % palette.length] }));
    }));
    const items = groups.flat().sort((a, b) => b.date - a.date);
    if (!items.length) throw new Error('No feeds loaded');
    const run = () => items.map(it => el('div', { className: 'item' },
      it.group && el('span', { className: 'tag', textContent: it.group, style: `background:${it.color}` }),
      el('a', { href: it.link, textContent: it.title }),
      w.showSource !== false && el('span', { className: 'muted', textContent: ' · ' + it.source })));
    const track = el('div', { className: 'track' }, run(), run());  // two copies so the loop is seamless
    // height "fill": stretch to whatever height the card gets from the grid (e.g. with rowSpan).
    const stretch = w.height === 'fill';
    if (stretch) body.closest('section').classList.add('fill');
    fill(body, el('div', { className: 'view', style: stretch ? '' : `height:${w.height || '24em'}` }, track));
    track.style.animationDuration = (track.scrollHeight / 2) / (w.speed || 30) + 's';
  },

  async feed(w, body) {
    body.classList.add('feed');
    const { items } = await loadFeed(w.url);
    if (w.mode === 'latest') {  // render the newest item's own content (e.g. HN Daily's link list)
      const it = items[0];
      fill(body, el('a', { href: it.link, className: 'muted', textContent: it.title }), sanitize(it.html));
      return;
    }
    fill(body, el('ul', {}, items.slice(0, w.limit || 10).map(it => el('li', {},
      el('a', { href: it.link, textContent: it.title }),
      !isNaN(it.date) && el('span', { className: 'muted', textContent: ' · ' + it.date.toLocaleDateString() }),
      w.summary && it.html && el('div', { className: 'muted', textContent: plain(it.html) }),
    ))));
  },

  notes(w, body) {
    const key = 'notes:' + (w.id || w.title);
    const ta = el('textarea', { value: store.get(key, ''), placeholder: 'Write something…' });
    ta.addEventListener('input', () => store.set(key, ta.value));
    body.append(ta);
  },

  todo(w, body) {
    body.classList.add('todo');
    const key = 'todo:' + (w.id || w.title);
    let items = store.get(key, []);
    const input = el('input', { type: 'text', placeholder: 'Add a task…' });
    const list = el('ul');
    const save = () => { store.set(key, items); draw(); };
    const draw = () => list.replaceChildren(...items.map((it, i) => el('li', { className: it.done ? 'done' : '' },
      el('input', { type: 'checkbox', checked: it.done, onchange: () => { it.done = !it.done; save(); } }),
      el('span', { textContent: it.text }),
      el('button', { textContent: '✕', title: 'Delete', onclick: () => { items.splice(i, 1); save(); } }),
    )));
    const form = el('form', { onsubmit: e => {
      e.preventDefault();
      if (input.value.trim()) { items.push({ text: input.value.trim(), done: false }); input.value = ''; save(); }
    } }, input, el('button', { textContent: 'Add' }));
    body.append(form, list);
    draw();
  },

  links(w, body) {
    body.append(el('ul', {}, (w.links || []).map(l => el('li', {}, el('a', { href: l.href, textContent: l.label || l.href })))));
  },

  iframe(w, body) {  // only works for sites that allow being framed
    body.append(el('iframe', { src: w.src, style: w.height ? `height:${w.height}` : '' }));
  },
};

// ---------- tickers: one scrolling row per entry in cfg.tickers ----------
async function ticker(row, t) {
  const view = row.querySelector('.view');
  const feeds = await Promise.allSettled((t.urls || []).map(loadFeed));
  const items = feeds.flatMap(f => f.status === 'fulfilled' ? f.value.items.slice(0, t.limitPerFeed || 8) : []);
  if (!items.length) return view.replaceChildren(el('span', { className: 'err', textContent: ' No feeds loaded' }));
  items.sort((a, b) => b.date - a.date);
  const run = () => items.map(it => el('span', { className: 'item' },
    t.showSource !== false && el('span', { className: 'src', textContent: it.source }), el('a', { href: it.link, textContent: it.title })));
  const track = el('div', { className: 'track' }, run(), run());  // two copies so the loop is seamless
  view.replaceChildren(track);
  track.style.animationDuration = (track.scrollWidth / 2) / (t.speed || 80) + 's';
}

// ---------- boot ----------
(async () => {
  const text = await fetch('config.json').then(r => r.text());
  let cfg;
  try { cfg = JSON.parse(text); } catch (e) {
    // Show where the JSON is broken (a trailing comma is the usual culprit).
    return document.body.replaceChildren(el('pre', { className: 'err', style: 'padding:16px;white-space:pre-wrap',
      textContent: `config.json is not valid JSON: ${e.message}\n\nCommon causes: a trailing comma after the last item in a list, or a missing comma between items.` }));
  }
  document.title = cfg.title || 'Home';
  const root = document.documentElement.style;
  root.setProperty('--columns', cfg.columns || 3);
  for (const [k, v] of Object.entries(cfg.theme || {})) root.setProperty(k, v);

  const grid = document.getElementById('grid');
  const refreshers = [];
  const tickerBox = document.getElementById('tickers');
  for (const t of cfg.tickers || (cfg.ticker ? [cfg.ticker] : [])) {
    const row = el('div', { className: 'ticker' }, t.label && el('div', { className: 'label', textContent: t.label }), el('div', { className: 'view' }));
    tickerBox.append(row);
    const run = () => ticker(row, t);
    run();
    refreshers.push(run);
  }
  // Each widget gets its own card; a "group" puts several widgets in one card.
  const mount = (w, card) => {
    const fn = widgets[w.type];
    const isAsync = ['weather', 'calendar', 'feed', 'headlines'].includes(w.type);
    const body = el('div', { textContent: isAsync ? 'Loading…' : '', className: 'muted' });
    card.append(...clean([w.title && el('h2', { textContent: w.title }), body]));
    const run = async () => {
      try { body.className = ''; await (fn ? fn(w, body, run) : Promise.reject(new Error('Unknown widget type: ' + w.type))); }
      catch (e) { fill(body, el('div', { className: 'err', textContent: e.message })); }
    };
    run();
    if (isAsync) refreshers.push(run);
  };
  for (const w of cfg.widgets || []) {
    const members = w.type === 'group' ? w.widgets || [] : [w];
    const card = el('section', { className: [...members.map(m => m.type), w.rowSpan > 1 && 'tall'].filter(Boolean).join(' ') });
    if (w.span || w.column) card.style.gridColumn = `${w.column || 'auto'} / span ${w.span || 1}`;
    if (w.rowSpan) card.style.gridRow = `span ${w.rowSpan}`;
    grid.append(card);
    members.forEach(m => mount(m, card));
  }
  setInterval(() => refreshers.forEach(f => f()), (cfg.refreshMinutes || 15) * 60_000);
})();
