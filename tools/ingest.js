#!/usr/bin/env node
/* =============================================================================
   tools/ingest.js — replaces the seeded demo data with YOUR OWN real numbers,
   from free sources only. No Semrush, no Ahrefs, no DataForSEO, no card.

   What it pulls
     1. Google Search Console  searchanalytics.queryStats + urlStats + sitemaps
     2. Google Analytics 4     analyticsdata.runReport (daily rollups only)
     3. Your own crawler       titles/meta/H1/ALT/links/status/schema/wordcount
     4. PageSpeed Insights     lab + CrUX field data (LCP / CLS / INP)

   Auth: a service account you create in your own GCP project (free), or an OAuth
   access token you paste in. Nothing is uploaded anywhere except Google.

   Output: dist/data/site.json, keywords.json, competitors.json  → window.DATA
   Run:  node tools/ingest.js --dry          (works with no credentials, proves the pipeline)
         node tools/ingest.js --site viralytics.com --days 90
   ============================================================================= */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const argv = process.argv.slice(2);
const flagOf = (k, d) => { const i = argv.indexOf('--' + k); return i > -1 ? argv[i + 1] : d; };
const has = k => argv.includes('--' + k);

const CFG = {
  site:        flagOf('site', process.env.GSC_SITE || ''),            // e.g. sc-domain:example.com
  property:    flagOf('property', process.env.GA4_PROPERTY || ''),    // e.g. properties/1234567890
  saJson:      flagOf('creds', process.env.GOOGLE_APPLICATION_CREDENTIALS || ''),
  token:       flagOf('token', process.env.GOOGLE_ACCESS_TOKEN || ''),
  tokenFile:   flagOf('token-file', ''),        // written by tools/gsc-token.js (owner-granted, read-only)
  days:        +flagOf('days', 28),
  baseUrl:     flagOf('base', process.env.SITE_BASE || ''),
  maxPages:    +flagOf('max-pages', 2000),                             // plan limit, and your own bandwidth
  concurrency: 1, slowMs: 2000,                                        // 1 request / 2s — always
  out:         flagOf('out', path.join(__dirname, '..', 'out', 'ingest')),
};
const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly',
                'https://www.googleapis.com/auth/analytics.readonly'].join(' ');

/* ------------------------------------------------------------------ auth */
function fromTokenFile() {
  if (!CFG.tokenFile) return null;
  if (!fs.existsSync(CFG.tokenFile)) throw new Error('token file not found: ' + CFG.tokenFile);
  const j = JSON.parse(fs.readFileSync(CFG.tokenFile, 'utf8'));
  const fresh = j.obtainedAt && (Date.now() - Date.parse(j.obtainedAt)) < 3300 * 1000;   // Google tokens last 3600s
  if (fresh && j.access_token) return Promise.resolve(j.access_token);
  if (!j.refresh_token) throw new Error('token expired and no refresh_token in ' + CFG.tokenFile + ' — re-run tools/gsc-token.js');
  return fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: j.refresh_token,
                                client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET }),
  }).then(async r => { const t = await r.json(); if (!r.ok) throw new Error('refresh failed: ' + (t.error_description || r.status)
                                  + ' — needs GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET, or re-run tools/gsc-token.js');
    j.access_token = t.access_token; j.obtainedAt = new Date().toISOString();
    fs.writeFileSync(CFG.tokenFile, JSON.stringify(j)); return t.access_token });
}
async function accessToken() {
  if (CFG.token) return CFG.token;
  if (CFG.tokenFile) return fromTokenFile();
  if (!CFG.saJson || !fs.existsSync(CFG.saJson)) throw new Error(
    'no credentials. Pass --creds path/to/service-account.json or GOOGLE_ACCESS_TOKEN. ' +
    'The service account needs: Search Console API + GA4 API enabled, and must be added as an owner/user on the GSC property.');
  const sa = JSON.parse(fs.readFileSync(CFG.saJson, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(o).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claims = b64({ iss: sa.client_email, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token',
                       exp: now + 3600, iat: now });
  const signing = head + '.' + claims;
  const sig = crypto.createSign('RSA-SHA256').update(signing).sign(sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                                assertion: signing + '.' + sig }) });
  if (!r.ok) throw new Error('token exchange failed: ' + (await r.text()).slice(0, 300));
  return (await r.json()).access_token;
}
async function api(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { authorization: 'Bearer ' + TOK, ...(init.headers || {}) } });
  if (r.status === 429 || r.status === 403) {
    const body = await r.text();
    throw new Error('QUOTA/AUTH ' + r.status + ' on ' + url.split('?')[0] +
      ' — ' + body.slice(0, 200) + '\nBack off. GSC: 1,200 qpm/site, 50k rows/day/site. GA4: ~14k tokens/project/hour.');
  }
  if (!r.ok) throw new Error(r.status + ' ' + url + ' → ' + (await r.text()).slice(0, 240));
  return r.json();
}

/* ------------------------------------------------------------------ GSC */
async function gsc(tok) {
  const site = encodeURIComponent(CFG.site);
  const end = new Date(), start = new Date(end - CFG.days * 864e5);
  const d = x => x.toISOString().slice(0, 10);
  /* 25,000 rows per request is Google's hard cap — page through, do not hope. */
  const pull = async dims => {
    const rows = []; let startRow = 0;
    for (;;) {
      const j = await api(`https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startDate: d(start), endDate: d(end), dimensions: dims,
                               rowLimit: 25000, startRow, dimensionFilterGroup: null }) });
      rows.push(...(j.rows || []));
      if ((j.rows || []).length < 25000) break;
      startRow += 25000;
      if (startRow >= 50000) { console.warn('  GSC daily row cap (50k) reached — truncating; use BigQuery export for more'); break; }
    }
    return rows;
  };
  const queries = await pull(['query']);
  const pages   = await pull(['page']);
  const both    = await pull(['page', 'query']);
  let sitemaps = [];
  try { sitemaps = Object.keys(((await api(`https://www.googleapis.com/webmasters/v3/sites/${site}/sitemaps`)).sitemapFiles) || {}); }
  catch (e) { console.warn('  sitemaps: ' + e.message); }
  /* URL Inspection is capped at 2,000 checks/day — so we inspect a priority watchlist only. */
  const watch = pages.slice(0, Math.min(200, CFG.maxPages)).map(r => r.keys[0]);
  const inspection = [];
  if (!has('no-inspect')) {
    for (const url of watch) {
      try {
        const j = await api('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ inspectionUrl: url, siteUrl: CFG.site, languageCode: 'en' }) });
        const ir = (j.inspectionResult || {}).indexingState || {};
        inspection.push({ url, coverage: ir.coverageState || 'unknown', verdict: ir.verdict || '',
                          lastCrawl: ir.lastCrawlTime || '', canonical: ir.serverCanonical || '' });
      } catch (e) { console.warn('  inspect ' + url + ': ' + e.message); break; }
    }
  }
  return { queries, pages, both, sitemaps, inspection, window: { start: d(start), end: d(end) },
           note: 'Google data lags 2-3 days; retention from Google is 16 months — store everything you pull.' };
}

/* ------------------------------------------------------------------ GA4 */
async function ga4(tok) {
  /* One runReport per dimension set per day. Quota is TOKEN-based and shared across every
     property in the same project+property pair: ~14k tokens/hour. Batch, do not loop. */
  const end = new Date(), start = new Date(end - CFG.days * 864e5);
  const d = x => x.toISOString().slice(0, 10);
  const sets = [
    { name: 'daily',        dims: ['date'],                            mets: ['activeUsers', 'sessions', 'keyEvents', 'engagedSessions'] },
    { name: 'landing',      dims: ['landingPagePath'],                 mets: ['activeUsers', 'sessions', 'keyEvents', 'averageEngagementTimeSeconds'] },
    { name: 'source_page',  dims: ['sessionDefaultChannelGroup', 'landingPagePath'], mets: ['sessions', 'keyEvents'] },
    { name: 'country_dev', dims: ['country', 'deviceCategory'],        mets: ['activeUsers', 'sessions', 'keyEvents'] },
  ];
  const out = { property: CFG.property, window: { start: d(start), end: d(end) }, sets: {} };
  for (const s of sets) {
    let offset = 0, rows = [];
    for (;;) {
      const j = await api(`https://analyticsdata.googleapis.com/v1beta/${CFG.property}:runReport`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dateRanges: [{ startDate: d(start), endDate: d(end) }],
          dimensions: s.dims.map(x => ({ name: x })), metrics: s.mets.map(x => ({ name: x })),
          limit: 1000, offset, keepZeroRows: false, orderBys: [{ metric: { metricName: s.mets[0] }, desc: true }] }) });
      rows = rows.concat((j.rows || []).map(r => Object.fromEntries(
        [...r.dimensionValues, ...r.metricValues].map((v, i) => [(i < s.dims.length ? s.dims : s.mets)[i - (i < s.dims.length ? 0 : s.dims.length)], v.stringValue]))));
      if (!j.rowCount || rows.length >= j.rowCount) break;
      offset += 1000;
      if (offset > 20000) break;
    }
    out.sets[s.name] = rows;
    console.log(`  GA4 ${s.name}: ${rows.length} rows`);
  }
  return out;
}

/* ------------------------------------------------------------------ own crawl
   This is where a free build beats a paid one: the crawl is on YOUR site, so you
   can check every indexed URL instead of what an index happened to last see. */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function crawl(baseUrl) {
  const seen = new Map(), q = [{ url: new URL(baseUrl, '/').href, depth: 0 }];
  let done = 0;
  while (q.length && done < CFG.maxPages) {
    const { url, depth } = q.shift();
    const u = new URL(url);
    if (u.origin !== new URL(baseUrl).origin) continue;
    if (seen.has(u.href)) continue;
    const t0 = Date.now();
    let entry = { url: u.href, path: u.pathname, status: 0, words: 0, title: '', meta: '', h1: '',
                  imgs: 0, altMissing: 0, linksOut: 0, linksIn: 0, depth, canonical: '', robots: '',
                  schema: [], lcp: null, cls: null };
    try {
      const r = await fetch(u.href, { redirect: 'follow', headers: { 'user-agent': 'ViralyticsBot/1.0 (+your site admin email)' } });
      entry.status = r.status; entry.finalUrl = r.url;
      const html = await r.text();
      const g = (re, i = 1) => (html.match(re) || [])[i] || '';
      entry.title = g(/<title[^>]*>([\s\S]*?)<\/title>/i, 1).replace(/\s+/g, ' ').trim();
      entry.meta = g(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
      entry.robots = g(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i);
      entry.canonical = g(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i);
      entry.h1 = g(/<h1[^>]*>([\s\S]*?)<\/h1>/i, 1).replace(/<[^>]+>/g, '').trim();
      entry.imgs = (html.match(/<img\b/gi) || []).length;
      entry.altMissing = (html.match(/<img\b(?![^>]*\balt=)[^>]*>/gi) || []).length
                       + (html.match(/<img\b[^>]*\balt=["']\s*["'][^>]*>/gi) || []).length;
      entry.words = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
                       .replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
      entry.schema = [...html.matchAll(/"@type"\s*:\s*"([A-Za-z]+)"/g)].map(m => m[1]);
      const links = [...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)].map(m => m[1])
        .map(h => { try { return new URL(h, u.href).href } catch { return null } })
        .filter(h => h && h.startsWith(u.origin));
      entry.linksOut = links.length;
      entry.outLinks = links.map(l => l.replace(/^https?:\/\/[^/]+/, ''));
      if (depth < 4) links.forEach(l => { if (!seen.has(l)) q.push({ url: l, depth: depth + 1 }) });
    } catch (e) { entry.error = e.message; }
    seen.set(u.href, entry); done++;
    const wait = CFG.slowMs - (Date.now() - t0);
    if (wait > 0) await sleep(wait);                       // never faster than 1 req / 2s
    if (done % 100 === 0) console.log(`  crawled ${done}/${CFG.maxPages} (queue ${q.length})`);
  }
  const rows = [...seen.values()];
  /* links-in from the crawl graph: an orphan page is one nothing else points at */
  const inCount = {};
  rows.forEach(r => (r.outLinks || []).forEach(l => { const k = l.replace(/^https?:\/\/[^/]+/, ''); inCount[k] = (inCount[k] || 0) + 1 }));
  rows.forEach(r => r.linksIn = inCount[r.path] || 0);
  return rows;
}

/* ---------------------------------------------------- PageSpeed / CrUX (free) */
async function psi(baseUrl) {
  if (!process.env.PSI_KEY && has('no-psi')) return {};
  const urls = (await fetchList(baseUrl)).slice(0, +flagOf('psi-pages', 25));
  const out = {};
  for (const u of urls) {
    try {
      const j = await api(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(u)}` +
        `&strategy=mobile&category=performance&category=seo` + (process.env.PSI_KEY ? `&key=${process.env.PSI_KEY}` : ''));
      const a = (j.lighthouseResult || {}).audits || {}, cr = (j.loadingExperience || {}).metrics || {};
      out[u] = { lcp: a['largest-contentful-paint'] && Math.round(a['largest-contentful-paint'].numericValue),
                 cls: a['cumulative-layout-shift'] && a['cumulative-layout-shift'].numericValue,
                 inp: a['interaction-to-next-paint'] && a['interaction-to-next-paint'].numericValue,
                 fieldLcp: cr.LARGEST_CONTENTFUL_PAINT_MS && (cr.LARGEST_CONTENTFUL_PAINT_MS.percentile / 1000),
                 fieldCls: cr.CUMULATIVE_LAYOUT_SHIFT_SCORE && cr.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile,
                 fieldSample: (j.loadingExperience || {}).metrics ? (cr.LARGEST_CONTENTFUL_PAINT_MS||{}).percentile : null };
      await sleep(1200);
    } catch (e) { console.warn('  PSI ' + u + ': ' + e.message); }
  }
  return out;
}
async function fetchList(baseUrl) {
  try {
    const xml = await (await fetch(new URL('/sitemap.xml', baseUrl).href)).text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    return locs.length ? locs : [baseUrl];
  } catch { return [baseUrl] }
}

/* ------------------------------------------------------------------ main */
let TOK = '';
async function main() {
  const dry = has('dry') || !CFG.site && !CFG.property;
  console.log(`\ningest · site=${CFG.site || '—'} · ga4=${CFG.property || '—'} · window=${CFG.days}d · ${dry ? 'DRY RUN' : 'live'}\n`);
  fs.mkdirSync(CFG.out, { recursive: true });
  const site = { generatedAt: new Date().toISOString(), demo: dry, sources: [] };
  let keywords, competitors = { note: 'no index licence → competitor rows come from your own SERP checks and crawl; label everything est.' };

  if (!dry) {
    TOK = await accessToken();
    if (CFG.site) { console.log('Search Console…'); site.gsc = await gsc(TOK); site.sources.push('GSC API (free)'); }
    if (CFG.property) { console.log('GA4…'); site.ga4 = await ga4(TOK); site.sources.push('GA4 Data API (free)'); }
    if (CFG.baseUrl) {
      console.log('own crawl of ' + CFG.baseUrl + ' …');
      const rows = await crawl(CFG.baseUrl);
      console.log(`crawl: ${rows.length} URLs, ${rows.filter(r => r.status >= 400).length} errors, ` +
                  `${rows.filter(r => /noindex/.test(r.robots)).length} noindex`);
      site.pages = rows.map(r => ({ path: r.path, status: r.status, words: r.words, title: r.title, meta: r.meta,
        h1: r.h1, imgs: r.imgs, altMissing: r.altMissing, linksOut: r.linksOut, depth: r.depth,
        robots: r.robots, canonical: r.canonical, schema: r.schema.join(';'), rawFlag: /noindex/.test(r.robots) ? 1 : 0 }));
      site.sources.push('own crawler (free)');
      site.psi = await psi(CFG.baseUrl); site.sources.push('PageSpeed Insights (free)');
    }
    const q = (site.gsc || { queries: [] }).queries || [];
    const pp = (site.gsc || { pages: [] }).pages || [];
    /* normalise to the shape build/app.js reads — see adapt() there */
    keywords = { rows: q.map(r => ({ q: r.keys[0], imp: r.impressions || 0, clicks: r.clicks || 0,
      pos: r.position ? Math.round(r.position * 10) / 10 : null, ctr: r.ctr,
      device: r.keys[1] || null, country: r.keys[1] || null })) };
    site.pages = (site.pages || []).map(r => Object.assign(r, {
      type: /^(\/compare\/)/.test(r.path) ? 'comparison' : /^\/blog/.test(r.path) ? 'blog' :
            /^\/features/.test(r.path) ? 'feature' : /^\/pricing/.test(r.path) ? 'pricing' :
            /^\/faq/.test(r.path) ? 'faq' : r.path === '/' ? 'homepage' : 'other',
      schemas: (r.schema || []).join(';'), flag: r.rawFlag | 0, imgs: r.imgs | 0,
      lcp: (site.psi && site.psi[r.url] && site.psi[r.url].lcp) || null,
      cls: (site.psi && site.psi[r.url] && site.psi[r.url].cls) || null }));
    site.pagesByQuery = pp.map(r => ({ page: r.keys[0], imp: r.impressions || 0, pos: r.position }));
    const idx = ((site.gsc || {}).inspection || []).filter(i => /Submitted and indexed/i.test(i.coverage || '')).length;
    if (idx) site.indexed = { now: idx, before: null };
  } else {
    console.log('DRY RUN — writing the same files the live run would, with the demo shape.');
    keywords = { rows: [] };
    site.pages = []; site.note = 'dry run — no pages/keywords written; the app keeps its seeded demo set when it sees empty arrays';
  }

  const write = (name, obj) => {
    const p = path.join(CFG.out, name);
    fs.writeFileSync(p, JSON.stringify(obj).replace(/</g, '\\u003c'));
    console.log(`  wrote ${path.relative(process.cwd(), p)}  (${(fs.statSync(p).size / 1024).toFixed(1)} KB)`);
  };
  write('site.json', site);
  write('keywords.json', keywords);
  write('competitors.json', competitors);
  console.log(`\nnext: python3 tools/bake.py out/ingest/site.json --html index.html --out live-<domain>.html\n`);
}
if (require.main === module) main().catch(e => { console.error('\nFAILED: ' + e.message + '\n'); process.exit(1) });
module.exports = { CFG, crawl, ga4, gsc, psi, main };
