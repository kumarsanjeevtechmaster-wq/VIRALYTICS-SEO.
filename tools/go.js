#!/usr/bin/env node
/* =============================================================================
   go.js — the "type a domain, get an answer" layer.

     node tools/go.js            →  http://localhost:8420  (dashboard + live lookups)

   What you can then do, in the browser, without touching a terminal again:
     • type any domain → 3-second health snapshot (is it crawlable, what's broken)
     • type a few keywords → where that site shows up in a public search result page
     • run a full crawl → saves a self-contained live-<domain>.html report you can send
   Everything is read-only, on your own machine, costs ₹0, and never stores anything
   on someone else's site.

   Endpoints (same origin, no CORS surprises):
     GET /                    the dashboard, with the domain box injected
     GET /api/health          { ok: true, version, node }
     GET /api/quick?site=…    instant snapshot (+ &kws=a,b,c for rank sampling)
     GET /api/audit?site=…    full crawl → writes reports/live-<domain>.html
     GET /api/live/<file>     download a saved report
     POST /api/snapshot      dashboard saves its run-history → out/<domain>/history.json
   ============================================================================= */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), url = require('url'),
      cp = require('child_process');
const { quick, collect, serpSample } = require('./live.js');
const PY = (() => { for (const c of ['python3', 'python']) { try { const r = cp.spawnSync(c, ['--version']); if (r.status === 0) return c } catch (e) {} } return 'python3' })();  // Windows par 'python' hota hai
process.on('uncaughtException', e => console.error('uncaughtException (kept alive):', e && e.message || e));
process.on('unhandledRejection', e => console.error('unhandledRejection (kept alive):', e && e.message || e));

const ROOT = path.join(__dirname, '..');
const PORT = +(process.env.PORT || process.argv[2] || 8420);
const REPORTS = path.join(ROOT, 'reports');
const CACHE = new Map();                            // site → { at, data }
const TTL = 10 * 60 * 1000;                         // don't hammer the same site twice in 10 min
const VERSION = 'go.js v1 · read-only · local only';

/* ---------------------------------------------------------------- the box */
const UI = fs.readFileSync(path.join(__dirname, 'live-ui.js'), 'utf8');

function withUi(html) {
  const tag = '<script>/*live-ui*/' + UI + '</script>';
  if (html.includes('/*live-ui*/')) return html;                  // already installed
  return html.includes('</body>') ? html.replace('</body>', tag + '\n</body>') : html + tag;
}

function readIndex() {
  for (const p of ['index.html', 'app/index.html', 'dist/index.html']) {
    const f = path.join(ROOT, p);
    if (fs.existsSync(f)) return { file: f, html: fs.readFileSync(f, 'utf8') };
  }
  throw new Error('index.html not found next to tools/ — keep the dashboard file in the same folder');
}

/* ------------------------------------------------------------------ api */
const send = (res, code, obj, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store',
                        'access-control-allow-origin': '*' });
  res.end(type.startsWith('application/json') ? JSON.stringify(obj) : obj);
};
const safeHost = s => String(s || '').replace(/[^a-z0-9.\-]/gi, '').replace(/^\.+/, '').slice(0, 80);
const norm = s => { s = safeHost(String(s || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));
  return s.includes('.') ? s : '' };

async function handleApi(req, res, u) {
  const route = u.pathname;
  if (route === '/api/health') return send(res, 200, { ok: true, version: VERSION, node: process.version, reports: fs.existsSync(REPORTS) ? fs.readdirSync(REPORTS).filter(f => f.endsWith('.html')).length : 0 });

  if (route === '/api/snapshot' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e5) req.destroy() });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        const dom = norm(j.domain || '');
        const hist = Array.isArray(j.hist) ? j.hist.slice(-24) : [];
        if (!dom) return send(res, 400, { ok: false, error: 'domain missing in body' });
        const dir = path.join(ROOT, 'out', dom);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify(hist));
        return send(res, 200, { ok: true, saved: hist.length, file: 'out/' + dom + '/history.json' });
      } catch (e) { return send(res, 400, { ok: false, error: 'bad body: ' + e.message }) }
    });
    return;
  }

  if (route.startsWith('/api/live/')) {
    const name = path.basename(route.slice('/api/live/'.length));
    if (!/^live-[a-z0-9.\-]+(\.html|-PLAN\.md)$/i.test(name)) return send(res, 400, { ok: false, error: 'bad name' });
    const f = path.join(REPORTS, name);
    if (!fs.existsSync(f)) return send(res, 404, { ok: false, error: 'report not built yet' });
    res.writeHead(200, { 'content-type': name.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
      'content-disposition': 'attachment; filename="' + name + '"', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(f));
  }

  const site = norm(u.query.site || u.query.domain);
  if (!site) return send(res, 400, { ok: false, error: 'ek domain likho, jaise "sharmaclinic.in" (http:// mat likho)' });
  const kws = String(u.query.kws || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 8);

  if (route === '/api/quick') {
    const hit = CACHE.get(site);
    let snap;
    if (hit && Date.now() - hit.at < TTL && !u.query.fresh) snap = hit.data;
    else { try { snap = await quick('https://' + site, { maxPages: +(u.query.pages || 12), depth: 1 }) }
           catch (e) { return send(res, 200, { ok: false, site, error: 'site se connect nahi ho paya: ' + e.message,
             hints: ['domain sahi hai?', 'site google bots ko block karti hai?', 'aapka internet chal raha hai?'] }) }
           CACHE.set(site, { at: Date.now(), data: snap }) }
    const serp = kws.length ? await serpSample('https://' + site, kws) : [];
    const verdict = !snap.reachable ? 'band' : snap.errors > 0 || snap.noindex > 0 ? 'turant dhyan do' : snap.thin > 2 || snap.dupTitles > 0 ? 'kuch kaam hai' : 'theek-thaak';
    return send(res, 200, { ok: true, verdict, serp, snap: { ...snap, pages: undefined, _data: undefined },
      issues: snap.pages.map(p => ({ path: p.path, title: p.title, words: p.words, status: p.status,
        altMissing: p.altMissing, noindex: /noindex/i.test(p.robots || ''), canonical: p.canonical }))
        .slice(0, +(u.query.rows || 12)),
      whatWeMissed: ['Google ke asli numbers (impressions/clicks/position) sirf site ke OWNER mil sakte hain — 2 minute ka Search Console export',
        'search volume aur competitor keywords — inke liye paid index chahiye; hum guess nahi karte'] });
  }

  if (route === '/api/audit') {
    const out = 'live-' + site + '.html';
    try {
      const data = await collect('https://' + site, { maxPages: +(u.query.pages || 180), depth: +(u.query.depth || 3), out: path.join(ROOT, 'out', site) });
      fs.mkdirSync(REPORTS, { recursive: true });
      const payloadFile = path.join(ROOT, 'out', site, 'site.json');
      fs.writeFileSync(payloadFile, JSON.stringify(data, null, 0));
      const py = fs.existsSync(path.join(ROOT, 'tools/bake.py'))
        ? cp.spawnSync(PY, [path.join(ROOT, 'tools/bake.py'), payloadFile, '--html', readIndex().file,
                            '--out', path.join(REPORTS, out)], { encoding: 'utf8' })
        : { status: 127, stderr: 'tools/bake.py not found' };
      if (py.status !== 0) throw new Error((py.stderr || 'bake failed').split('\n').filter(Boolean).slice(-2).join(' | '));
      try { cp.spawnSync('node', [path.join(ROOT, 'tools/report-md.js'), path.join(REPORTS, out), payloadFile,
             path.join(REPORTS, out.replace('.html', '-PLAN.md'))], { encoding: 'utf8' }); } catch (e) {}
      return send(res, 200, { ok: true, site, pages: data.pages.length, seconds: data._seconds,
        score: null, file: out, download: '/api/live/' + out,
        stats: data.stats, sitemaps: { declared: data.sitemaps.declaredCount, robots: data.sitemaps.robotsPresent },
        plan: out.replace('.html', '-PLAN.md') });
    } catch (e) { return send(res, 500, { ok: false, error: e.message }) }
  }

  return send(res, 404, { ok: false, error: 'unknown api route' });
}

/* ------------------------------------------------------------------ server */
const srv = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type' }); return res.end() }
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u);
    if (u.pathname === '/live-ui.js') return send(res, 200, UI, 'application/javascript; charset=utf-8');
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const { html } = readIndex();
      return send(res, 200, withUi(html), 'text/html; charset=utf-8');
    }
    if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end() }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404');
  } catch (e) { send(res, 500, { ok: false, error: e.message }) }
});

if (process.argv.includes('--install-ui')) {
  const { file, html } = readIndex();
  if (html.includes('/*live-ui*/')) { console.log('domain box already installed in ' + file); process.exit(0) }
  fs.writeFileSync(file + '.bak', html);
  fs.writeFileSync(file, withUi(html));
  console.log('✓ domain box installed into ' + path.basename(file) + '  (backup: ' + path.basename(file) + '.bak)');
  console.log('  ab ye file OFFLINE bhi box dikhaayegi; live results ke liye node tools/go.js chalu chahiye.');
  process.exit(0);
}

fs.mkdirSync(REPORTS, { recursive: true });
srv.listen(PORT, '0.0.0.0', () => {
  console.log(`
  Viralytics live lookup  →  http://localhost:${PORT}
  ${VERSION}

  dashboard khul jaayega; upar "🔎 Website daalo" box mein domain type karo.
  Ctrl-C se band karo. Kuch bhi store nahi hota, koi account nahi, ₹0.`);
});
srv.on('error', e => { if (e.code === 'EADDRINUSE') console.error('\n✗ port ' + PORT + ' already in use. Try:  PORT=8500 node tools/go.js\n'); process.exit(1) });
