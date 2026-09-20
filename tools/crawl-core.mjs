/* =============================================================================
   crawl-core.mjs — the runtime-agnostic crawl engine (Node + Deno edge).

   NO node:fs / node:path / process. Anything runtime-specific is injected:
     deps.loadHistory(domain)   → array of past snapshots (or undefined)
     deps.onProgress(msg)       → progress line (console in CLI, noop in cloud)
     deps.log(msg)              → info line (respects quiet)
   GSC CSV is passed as text:  opts.gsc = [{file:'queries.csv', text:'…'}]

   Ported 1:1 from live.js (v2) so the desktop app and the Supabase cloud run
   the exact same code. local = tools/live.js wrapper, cloud = supabase
   function. Change a rule here, it changes in both.
   ============================================================================= */
const DEFAULTS = {
  maxPages: 180, depth: 3, slow: 250, psiKey: '', gsc: [],
  ua: 'Mozilla/5.0 (compatible; ViralyticsAudit/1.0; +read-only SEO audit)',
};
let CFG = Object.assign({ base: null }, DEFAULTS);
let ORIGIN = null;                                  // re-seeded from the homepage's FINAL url (301 → www)

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sameOrigin = u => { try { return new URL(u).origin === ORIGIN } catch { return false } };
const rel = u => { const x = new URL(u); return (x.pathname + (x.search ? x.search.slice(0, 40) : '')).replace(/\/$/, '') || '/' };
const strip = h => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const configure = o => { CFG = Object.assign({ base: new URL(o.target) }, DEFAULTS, o); ORIGIN = CFG.base.origin; return CFG };

/* ------------------------------------------------------------------ fetch */
async function get(url, { text = true } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': CFG.ua, accept: 'text/html,*/*' } });
    const body = text ? await r.text() : null;
    return { ok: r.ok, status: r.status, finalUrl: r.url, body, hops: r.url !== url ? 1 : 0, type: r.headers.get('content-type') || '', ms: Date.now() - t0 };
  } catch (e) { return { ok: false, status: 0, error: e.message, ms: Date.now() - t0 } }
}

/* ------------------------------------------------------------------ parser
   No DOM library: these are 6 well-anchored regexes, deliberately readable. */
export function parseHtml(html, url) {
  const m = (re, i = 1) => { const x = html.match(re); return x ? (x[i] || '') : '' };
  const all = re => { const o = []; let x; while ((x = re.exec(html))) o.push(x); return o };
  const title = m(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const meta = (name) => m(new RegExp('<meta[^>]+(?:name|property)=["\']' + name + '["\'][^>]*?content=["\']([^"\']*)["\']', 'i'))
    || m(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*?(?:name|property)=["\']' + name + '["\']', 'i'));
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
                   .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const words = strip(body).split(' ').filter(w => /[a-z\u0900-\u097F0-9]/i.test(w)).length;
  const imgs = all(/<img\b[^>]*>/gi);
  const altMissing = imgs.filter(t => !/\balt=["'][^"']+["']/i.test(t)).length;
  const anchors = all(/<a\b[^>]*\bhref=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  const links = anchors.map(a => { try { return new URL(a[1], url).href } catch { return null } }).filter(Boolean);
  const internal = [...new Set(links.filter(sameOrigin))];
  const external = [...new Set(links.filter(l => !sameOrigin(l)))];
  const schema = [...new Set(all(/"@type"\s*:\s*"([A-Za-z]+)"/g).map(x => x[1]))];
  const canonical = m(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  const hreflang = all(/<link[^>]+rel=["']alternate["\'][^"\']*["'][^>]*>/gi).filter(x => /hreflang=/i.test(x[0]))
    .map(x => { const h = x[0].match(/hreflang=["']([^"']+)["']/i); const r = x[0].match(/href=["']([^"']+)["']/i); return h && r ? { lang: h[1], href: r[1] } : null }).filter(Boolean);
  const noindex = /noindex/i.test(meta('robots'));
  const h1s = all(/<h1[^>]*>([\s\S]*?)<\/h1>/gi).map(x => strip(x[1])).filter(Boolean);
  const h2s = all(/<h2[^>]*>([\s\S]*?)<\/h2>/gi).map(x => strip(x[1])).filter(Boolean).slice(0, 14);
  const httpMixed = /(?:src|href|srcset)=["']http:\/\//i.test(html);
  return {
    title: strip(title), titleLen: strip(title).length, meta: meta('description'), metaLen: meta('description').length,
    ogTitle: meta('og:title'), ogImage: meta('og:image'), twitter: meta('twitter:card'),
    h1: h1s[0] || '', h1Count: h1s.length, h2s, words, imgs: imgs.length, altMissing,
    linksOut: internal.length, extLinks: external.length, outHrefs: internal,
    canonical: canonical ? rel(canonical) : '', canonicalAbs: canonical, robots: meta('robots'),
    noindex, hreflang, schema, httpMixed, lang: m(/<html[^>]*\blang=["']([^"']+)["']/i),
    viewport: /name=["']viewport["']/i.test(html), charset: /charset=/i.test(html),
    bodyBytes: html.length, tcf: /<link[^>]+rel=["'](?:preload|modulepreload)["']/i.test(html),
    // everything below feeds the audit's bit flags
    flag: (noindex ? 1 : 0)
        | (canonical && rel(canonical) !== rel(url) ? 2 : 0)
        | (!canonical ? 4 : 0)
        | (!meta('og:image') ? 32 : 0)
        | (httpMixed ? 128 : 0)
        | (words < 90 ? 512 : 0),
  };
}

/* ------------------------------------------------------------------ crawl */
async function crawl(deps, log) {
  const seen = new Map();
  const q = [{ url: CFG.base.href, depth: 0 }];
  let n = 0, t0 = Date.now();
  while (q.length && n < CFG.maxPages) {
    const { url, depth } = q.shift();
    if (seen.has(url)) continue;
    const r = await get(url);
    n++;
    const e = { url, path: rel(url), depth, status: r.status || 0, finalUrl: r.finalUrl || url };
    if (!r.ok && !r.body) { e.error = r.error; seen.set(url, e); continue }
    if (!/text\/html/i.test(r.type)) { e.skip = 'not html (' + r.type.split(';')[0] + ')'; seen.set(url, e); continue }
    const p = parseHtml(r.body, e.finalUrl);
    Object.assign(e, p, { redirectHops: r.hops, ms: r.ms });
    seen.set(url, e);
    if (depth < CFG.depth) for (const nx of p.outHrefs) if (!seen.has(nx)) q.push({ url: nx, depth: depth + 1 });
    if (n % 25 === 0) deps.onProgress(`\r  crawled ${n}/${CFG.maxPages}  (queue ${q.length}, ${(n * 1)}/${Math.max(1, ((Date.now() - t0) / 1000)).toFixed(0)}s)  `);
    const w = CFG.slow - r.ms; if (w > 0) await sleep(w);
  }
  if (n >= 25) deps.onProgress('\r');
  /* links-in graph: nothing pointing at a page = orphan (real ranking problem) */
  const inCount = {};
  [...seen.values()].forEach(p => (p.outHrefs || []).forEach(h => { const k = rel(h); inCount[k] = (inCount[k] || 0) + 1 }));
  const pages = [...seen.values()].filter(p => !p.skip && p.status)
    .map(p => ({
      path: p.path, url: p.url, status: p.status, words: p.words, title: p.title, meta: p.meta, h1: p.h1,
      h1Count: p.h1Count, imgs: p.imgs, altMissing: p.altMissing, linksOut: p.linksOut, linksIn: inCount[p.path] || 0,
      depth: p.depth, robots: p.robots, canonical: p.canonical, schema: p.schema, lcp: p.lcp || 0, cls: p.cls || 0,
      flag: p.flag, rawFlag: p.flag, httpMixed: p.httpMixed, ogImage: p.ogImage, lang: p.lang, hreflang: p.hreflang.length,
      ms: p.ms, type: (/\/(blog|articles?|posts?|news)\//i.test(p.path) ? 'blog' : /^\/(pricing|plans)/i.test(p.path) ? 'pricing'
        : /^\/(compare|vs)\//i.test(p.path) ? 'comparison' : /^\/(features?|product|solutions?)\//i.test(p.path) ? 'feature'
        : /^\/(faq|help|docs|guides?)\//i.test(p.path) ? 'faq' : p.path === '/' ? 'homepage' : 'other'),
    }));
  return { pages, crawled: n, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
}

/* ------------------------------------------------------- robots + sitemaps */
async function robotsAndSitemaps() {
  const rb = await get(ORIGIN + '/robots.txt');
  const robots = rb.ok ? String(rb.body || '') : '';
  const declared = [...robots.matchAll(/sitemap:\s*(\S+)/gi)].map(m => m[1]);
  const disallow = [...robots.matchAll(/disallow:\s*(\/\S*)/gi)].map(m => m[1]).filter(x => x !== '/');
  let declaredUrls = [], found = [];
  const sm2 = (declared.length ? declared : [ORIGIN + '/sitemap.xml']);
  for (const sm of sm2) {
    const r = await get(sm);
    if (!r.ok || !r.body) continue;
    const locs = [...String(r.body).matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1]);
    const isIdx = /<sitemapindex/i.test(r.body);
    found.push({ url: sm, kind: isIdx ? 'index' : 'urlset', urls: isIdx ? 0 : locs.length });
    if (isIdx) { for (const child of locs.slice(0, 12)) { const c = await get(child); if (c.body) declaredUrls.push(...[...String(c.body).matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1])) } }
    else declaredUrls.push(...locs);
  }
  return { found, declaredCount: declaredUrls.length, declaredSample: declaredUrls.slice(0, 400).map(u => ({ url: u, path: sameOrigin(u) ? rel(u) : u })), robotsPresent: !!robots, disallow };
}

/* ------------------------------------------------- PageSpeed + CrUX (key) */
async function psi(pages, deps, log) {
  if (!CFG.psiKey) return { skipped: 'PSI_KEY not set — lab/field CWV left blank rather than invented' };
  const out = {};
  const pick = pages.filter(p => p.status === 200).slice(0, 12);
  for (const p of pick) {
    const u = encodeURIComponent(p.url || (ORIGIN + p.path));
    const r = await get(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${u}&strategy=mobile&category=performance&category=seo&key=${CFG.psiKey}`, { text: true });
    if (!r.ok) { out[p.path] = { error: 'HTTP ' + r.status }; continue }
    try {
      const j = JSON.parse(r.body), a = (j.lighthouseResult || {}).audits || {}, cr = ((j.loadingExperience || {}).metrics) || {};
      out[p.path] = {
        lcp: a['largest-contentful-paint'] && Math.round(a['largest-contentful-paint'].numericValue),
        cls: a['cumulative-layout-shift'] && +a['cumulative-layout-shift'].numericValue.toFixed(3),
        inp: a['interaction-to-next-paint'] && Math.round(a['interaction-to-next-paint'].numericValue),
        fieldLcp: cr.LARGEST_CONTENTFUL_PAINT_MS && Math.round(cr.LARGEST_CONTENTFUL_PAINT_MS.percentile),
        fieldCls: cr.CUMULATIVE_LAYOUT_SHIFT_SCORE && cr.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile,
        fieldOrigin: ((j.loadingExperience || {}).origin) || 'unknown',
      };
      if (out[p.path].lcp) { p.lcp = out[p.path].fieldLcp || out[p.path].lcp; p.cls = (out[p.path].fieldCls || out[p.path].cls || 0) }
    } catch (e) { out[p.path] = { error: e.message } }
    await sleep(900);
    deps.onProgress(`\r  PageSpeed ${Object.keys(out).length}/${pick.length}   `);
  }
  deps.onProgress('\r');
  return out;
}

/* ------------------------------------------------- GSC CSV (the only real numbers) */
export function parseGscCsvText(txt) {
  const text = String(txt || '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = (lines[0] || '').split(',').map(s => s.trim().toLowerCase());
  function idx(){const names=[].slice.call(arguments);return head.findIndex(h=>names.some(n=>h.indexOf(n)>-1))}
  const qi = idx('top queries', 'query'), pi = idx('page', 'landing'), ii = idx('impressions'), ci = idx('clicks'),
        cri = idx('ctr'), ppi = idx('position');
  const rows = lines.slice(1).map(l => l.split(',')).filter(c => c.length > 1).map(c => ({
    q: qi > -1 ? String(c[qi]).replace(/^"|"$/g, '') : (pi > -1 ? String(c[pi]).replace(/^"|"$/g, '') : ''),
    imp: ii > -1 ? +String(c[ii]).replace(/[^\d.]/g, '') || 0 : 0,
    clicks: ci > -1 ? +String(c[ci]).replace(/[^\d.]/g, '') || 0 : 0,
    ctr: cri > -1 ? (parseFloat(c[cri]) > 1 ? parseFloat(c[cri]) / 100 : parseFloat(c[cri]) || 0) : 0,
    pos: ppi > -1 ? +parseFloat(c[ppi]).toFixed(1) : null,
    page: /http|^\//.test(String(c[pi] || '')) ? rel(String(c[pi]).replace(/^"|"$/g, '')) : null,
  })).filter(r => r.q);
  return rows;
}

/* ------------------------------------------------------------------ main */
export async function collect(target, opts, deps = {}) {
  const quiet = !!(opts && opts.quiet);
  const log = quiet ? () => {} : ((deps.log || console.log).bind(console));
  configure(Object.assign({ target }, opts || {}));
  const t0 = Date.now();
  const onProgress = deps.onProgress || (() => {});
  if (!ORIGIN) ORIGIN = CFG.base.origin;
  log(`\nLIVE AUDIT · ${CFG.base.origin} · up to ${CFG.maxPages} pages · depth ${CFG.depth} · ${CFG.slow}ms delay`);
  const home = await get(CFG.base.href); ORIGIN = CFG.base.origin;
  if (!home.ok) { const m = 'site unreachable: HTTP ' + home.status + ' ' + (home.error || ''); if (!quiet) console.error('\n✗ ' + m); throw new Error(m) }
  if (home.finalUrl) { try { const fo = new URL(home.finalUrl); if (fo.origin !== ORIGIN) { ORIGIN = fo.origin; log('  following redirect → ' + ORIGIN) } } catch (e) {} }
  const brand = home.body ? strip((home.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').split(/[|–—-]/)[0].trim() : CFG.base.hostname;

  log(' robots.txt + sitemaps …'); const sm = await robotsAndSitemaps();
  log(' crawling …'); const { pages, crawled, seconds } = await crawl(deps, log);
  log(' PageSpeed / CrUX …'); const perf = await psi(pages, deps, log);
  const okPages = pages.filter(p => p.status === 200);
  const dup = (key) => { const c = {}; pages.forEach(p => { if (p[key]) c[p[key]] = (c[p[key]] || 0) + 1 }); return Object.entries(c).filter(([, n]) => n > 1).length };
  let keywords = [];
  for (const g of (CFG.gsc || [])) { log(` GSC csv ${g.file} …`); try { keywords.push(...parseGscCsvText(g.text)) } catch (e) { log('  csv skipped: ' + e.message) } }
  keywords = keywords.slice(0, 1000).map(k => ({ q: k.q, imp: k.imp, clicks: k.clicks, pos: k.pos, page: k.page, intent: 'informational', fit: 'blog' }));

  const data = {
    generatedAt: new Date().toISOString(), live: true, demo: false, engine: 'crawl-core v2',
    serp: (opts && opts.serp) ? opts.serp.map(k => ({ q: k.q, ddg: k.ddg, note: 'DuckDuckGo result position — a sample, not Google’s ranking' })) : undefined,
    site: { domain: new URL(ORIGIN).hostname, brand: brand || CFG.base.hostname, scheme: CFG.base.protocol.replace(':', '') },
    window: { crawled, seconds, depth: CFG.depth, maxPages: CFG.maxPages, robotsRespected: true,
              delay: CFG.slow + 'ms between requests', origin: CFG.base.href },
    pages, indexed: { now: okPages.length, before: null },
    perf, sitemaps: sm,
    stats: {
      ok: okPages.length, errors: pages.filter(p => p.status >= 400).length, redirects: pages.filter(p => p.status >= 300 && p.status < 400).length,
      noindex: pages.filter(p => /noindex/i.test(p.robots || '')).length,
      thin: pages.filter(p => p.words < 300).length, orphans: pages.filter(p => (p.linksIn || 0) === 0 && p.depth > 0).length,
      deadEnds: pages.filter(p => (p.linksOut || 0) <= 1 && p.words > 120).length,
      deep: pages.filter(p => p.depth >= CFG.depth).length,
      missingTitle: pages.filter(p => !p.title).length, dupTitles: dup('title'), dupMetas: dup('meta'),
      altMissing: pages.filter(p => p.altMissing > 0).length, noCanonical: pages.filter(p => !p.canonical).length,
      withSchema: pages.filter(p => p.schema && p.schema.length).length,
    },
    gsc: keywords.length ? { source: 'Search Console CSV export (owner-supplied)', rows: keywords.length } :
      { source: 'not supplied', note: 'Google only releases impressions/clicks/positions to a verified owner. No owner access = we leave the demand side empty instead of inventing it.' },
    keywords,
    history: (deps.loadHistory ? await Promise.resolve(deps.loadHistory(new URL(ORIGIN).hostname)) : undefined),
    competitors: [],
    sources: ['own crawler', 'robots.txt', 'sitemap.xml'].concat(keywords.length ? ['Google Search Console CSV'] : [])
      .concat(perf.skipped ? [] : ['PageSpeed Insights + CrUX']),
    locked: keywords.length ? [] : [
      'search volume', 'backlink index', 'competitor keyword lists', 'everywhere rank grid',
      '— all need either your Search Console/GA4 access or a paid index; nothing here is guessed',
    ],
  };
  const s = data.stats;
  if (!quiet) {
  log(`\n ✓ ${crawled} URLs in ${seconds}s · HTTP200 ${s.ok} · errors ${s.errors} · noindex ${s.noindex} · thin ${s.thin} · orphans ${s.orphans} · dead-ends ${s.deadEnds} · dup titles ${s.dupTitles} · missing ALT ${s.altMissing} · schema on ${s.withSchema}`);
  log(`   sitemap: ${sm.found.map(x => x.url.split('/').pop() + '(' + x.urls + ')').join(', ') || 'none found'} · declared ${sm.declaredCount} URLs`);
  log(`   CWV: ${perf.skipped ? perf.skipped : 'measured on ' + Object.keys(perf).length + ' pages'}`);
  log(`\n next: bake (bake-core) + report (report-core)`);
  log(` total ${(Date.now() - t0) / 1000}s`);
  }
  data._seconds = +((Date.now() - t0) / 1000).toFixed(1);
  return data;
}

/* quick pass for the in-app domain box: a handful of pages, no PSI, no files written */
export async function quick(target, { maxPages = 12, depth = 1 } = {}, deps = {}) {
  const d = await collect(target, { maxPages, depth, quiet: true, slow: 120 }, deps);
  const bad = d.pages.filter(p => p.status >= 400).length;
  return { domain: d.site.domain, brand: d.site.brand, origin: ORIGIN, reachable: true,
    checked: d.pages.length, seconds: d._seconds, generatedAt: d.generatedAt,
    home: d.pages.find(p => p.path === '/') || d.pages[0],
    robots: d.sitemaps.robotsPresent, disallow: (d.sitemaps.disallow || []).length,
    sitemapDeclared: d.sitemaps.declaredCount || 0, sitemapFiles: d.sitemaps.found.map(f => f.url),
    errors: bad, noindex: d.stats.noindex, thin: d.stats.thin, dupTitles: d.stats.dupTitles,
    missingTitle: d.stats.missingTitle, altMissing: d.stats.altMissing, orphans: d.stats.orphans,
    withSchema: d.stats.withSchema, avgWords: Math.round(d.pages.reduce((a, b) => a + (b.words || 0), 0) / Math.max(1, d.pages.length)),
    pages: d.pages.slice(0, 40), _data: d };
}

export async function serpSample(target, keywords, { throttleMs = 1400 } = {}) {
  const host = new URL(/:\/\//.test(target) ? target : 'https://' + target).hostname.replace(/^www\./, '');
  const out = [];
  for (const q of (keywords || []).slice(0, 8)) {
    let item = { q, ddg: null, checked: null, note: '' };
    try {
      const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q + ' ' + host),
        { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' } });
      const html = await r.text();
      const hrefs = [...html.matchAll(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
      item.checked = hrefs.length;
      const i = hrefs.findIndex(m => decodeURIComponent(m[1]).indexOf(host) > -1 || m[2].indexOf(host) > -1);
      item.ddg = i > -1 ? i + 1 : (hrefs.length ? 'not in top ' + hrefs.length : null);
      if (!hrefs.length) item.note = 'search page returned no parsable results (rate-limited or changed)';
    } catch (e) { item.note = 'lookup failed: ' + e.message; }
    out.push(item);
    await sleep(throttleMs);
  }
  return out;
}
