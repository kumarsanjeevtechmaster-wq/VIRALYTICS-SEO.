/* =============================================================================
   report-core.mjs — turns a live-baked dashboard + its payload into a
   client-ready markdown action plan. Runtime-agnostic (Node + Deno edge).

     makePlan(html, data) → { md, score, sub, issues, pages }

   How it works: the audit engine (RULE_BY, auditIssues, scoreFrom, Pages) lives
   inside the baked HTML's own scripts — we run those scripts here against a
   minimal fake DOM and read the results back. `new Function` + a return-tail is
   used instead of node:vm so the same file runs on Supabase Edge Functions.

   Ported 1:1 from tools/report-md.js (parity-tested: PLAN.md output identical).
   ============================================================================= */

function mk(t) {
  const o = { nodeType: 1, tagName: 'D', _kids: [], children: [], style: new Proxy({}, { set: () => true }), dataset: new Proxy({}, { set: () => true, get: () => '' }), value: '', checked: false, textContent: '', innerHTML: '', title: '', classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, append() {}, remove() {}, setAttribute() {}, getAttribute: () => null, addEventListener() {}, insertAdjacentHTML() {}, contains: () => false, insertBefore: () => {}, querySelector: () => mk('q'), querySelectorAll: () => [], click() {}, focus() {}, getBoundingClientRect: () => ({ top: 0, left: 0, width: 1, height: 1 }) };
  return new Proxy(o, { set(x, k, v) { x[k] = v; return true }, get(x, k) { if (k in x) return x[k]; if (typeof k === 'symbol' || k === 'then') return undefined; if (['parentNode', 'firstChild', 'lastChild', 'ownerDocument'].includes(k)) return null; return mk(k) } });
}

const CAPTURE = '\n;return { __ok: true, auditIssues, scoreFrom, Pages, RULE_BY, OVER, GSC };';

export function runBakedScripts(html, data) {
  const g = globalThis;
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(b => b.trim().length > 50);
  const mem = {};
  /* the injected UI registers timers + a localhost ping — neutralise both */
  const saved = {};
  const set = (k, v) => { saved[k] = g[k]; g[k] = v };
  set('document', { createElement: mk, createElementNS: mk, createTextNode: t => ({ nodeType: 3, textContent: t }), querySelector() { const e = mk('q'); e.append = () => {}; return e }, querySelectorAll: () => [], addEventListener() {}, title: '', body: mk('b'), documentElement: mk('h'), head: mk('h2'), getElementById: () => mk('id') });
  set('localStorage', { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v) }, removeItem: () => { } });
  set('navigator', { userAgent: 'report-core', clipboard: {} });
  set('setInterval', () => 0); set('setTimeout', () => 0);
  set('location', { protocol: 'file:', href: 'f', origin: 'n', host: '', search: '', pathname: '/' });
  set('fetch', async () => { throw 0 });
  set('addEventListener', () => {}); set('removeEventListener', () => {}); set('dispatchEvent', () => true);
  // runtime-specific: stub only what the runtime lacks (Node lacks all of these,
  // Deno edge may have some) — but fetch must ALWAYS be neutered (the injected
  // live-ui pings localhost, and the edge runtime would really try to call it).
  if (typeof g.scrollTo !== 'function') set('scrollTo', () => {});
  if (typeof g.prompt !== 'function') set('prompt', () => '');
  if (typeof g.getComputedStyle !== 'function') set('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  if (typeof g.requestAnimationFrame !== 'function') set('requestAnimationFrame', f => f());
  if (typeof g.matchMedia !== 'function') set('matchMedia', () => ({ matches: false }));
  if (typeof g.Blob === 'undefined') set('Blob', class {});
  if (typeof g.URL === 'undefined') set('URL', class { static createObjectURL() { return 'x' } static revokeObjectURL() {} });
  else {
    if (!g.URL.createObjectURL) { set('URL', Object.assign(g.URL, { createObjectURL: () => 'x', revokeObjectURL: () => {} })); }
  }
  g.window = g; g.self = g;
  if (data) g.DATA = data;
  try {
    // ALL blocks must run in ONE scope: the seed block's top-level consts
    // (PAGES_RAW, K, GSCQ…) are read by the app block, exactly as they are in
    // a real browser. (node:vm's runInThisContext gave the same cross-block
    // visibility; new Function + one concat does the same without the vm module.)
    const src2 = blocks.filter(b => b.trim()).join('\n;\n') + CAPTURE;
    const fn = new Function(src2);
    const r = fn.call(g);
    if (r && r.__ok) return r;
    throw new Error('report-core: capture tail did not return the engine');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v }
    delete g.window; delete g.self;
  }
  throw new Error('report-core: could not recover audit engine from the baked file (auditIssues/scoreFrom missing)');
}

export function makePlan(html, data, { fileLabel } = {}) {
  const { auditIssues, scoreFrom, Pages, RULE_BY, OVER } = runBakedScripts(html, data);
  const d = data || OVER || {};
  const st = d.stats || {};
  const sm = d.sitemaps || {};
  const iss = auditIssues(), sc = scoreFrom(iss);
  const pages = Pages;
  const dupG = {}; pages.forEach(p => { if (p.title) (dupG[p.title] = dupG[p.title] || []).push(p.path) });
  const dups = Object.entries(dupG).filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length);
  const thin = pages.filter(p => (p.words || 0) < 90);
  const alt = pages.filter(p => p.altMissing > 0);
  const ms = pages.map(p => p.ms || 0).filter(Boolean).sort((a, b) => a - b);
  const med = ms.length ? ms[Math.floor(ms.length / 2)] : null;
  const by = {}; iss.forEach(i => by[i.code] = i);
  const kw = (d.keywords || []).length;
  const L = [];
  const p = s => L.push(s);

  p('# Live SEO audit — ' + (d.site ? d.site.domain : fileLabel || 'site'));
  p('');
  p('**Kaise banaya:** apna crawler · ' + pages.length + ' real URLs · depth ' + ((d.window || {}).depth || '—') +
    ' · ' + ((d.window || {}).delay || '—') + ' · robots.txt respected · median response ' + (med == null ? '—' : med + ' ms') +
    ' · **koi third-party index nahi, koi API key nahi, ₹0**.');
  p('');
  p('| | |'); p('|---|---|');
  p('| **Health score** | **' + sc.score + '/100** |');
  Object.entries(sc.sub).forEach(([k, v]) => p('| ' + k + ' | ' + v + '/100 |'));
  p('| URLs dekhe / sitemap declared | ' + pages.length + ' / ' + (sm.declaredCount || 0) + ' |');
  p('| robots.txt | ' + (sm.robotsPresent ? 'present · ' + ((sm.disallow || []).length) + ' disallow rules' : 'not found') + ' |');
  p('| Search Console rows | ' + (kw ? kw + ' (imported)' : 'not supplied → demand side intentionally empty') + ' |');
  p('| Core Web Vitals | ' + (d.perf && d.perf.skipped ? 'not measured (' + d.perf.skipped + ')' : 'measured') + ' |');
  p('');
  p('## Read this first');
  p('');
  p('Score **' + sc.score + '/100** ka matlab "site buri hai" nahi hota. Iska matlab hai: *crawl-dekhbhaali se itne fix bache hain*. ' +
    'Sub-scores dekho — ' + Object.entries(sc.sub).filter(([, v]) => v >= 90).map(([k]) => k).join(', ') +
    (Object.values(sc.sub).some(v => v >= 90) ? ' already 90+ par hain, yaani structure theek hai. ' : '. ') +
    'Asli nuqsan un ' + iss.filter(i => i.se === 0).length + ' critical groups mein baitha hai, design mein nahi.');
  p('');
  p('## Pehle ye ' + Math.min(6, iss.length) + ' (order = signal per hour of work)');
  p('');
  const plan = [
    ['title_duplicate', 'Template-level fix, ek baar',
     'Site ka title template ek hi string produce kar raha hai, isliye ' + (by.title_duplicate ? by.title_duplicate.pages.length : 0) + ' URLs par same title. Google ko decide nahi karne diya ja raha ki kaunsa page kis query ka jawab hai — ye pages aapas mein position exchange karte rehte hain aur koi bhi strong nahi hota.',
     'Template ko page-specific banao. Duplicate title groups jo mile: ' + dups.length + '. Fix karte waqt brand end mein rakho, topic aage.'],
    ['soft_404', 'Kuch likhna nahi — hataana hai',
     thin.length + ' pages 90 words se kam ke par status 200 de rahe hain. Ye crawl budget khaate hain aur host ke quality signal ko niche kheenchte hain. Sample: ' + thin.slice(0, 3).map(x => x.path).join(', ') + '.',
     'Ya toh real 404/410 return karo, ya jin par content aa sakta hai unhe 400+ words tak le jao aur kisi hub se link karo. "200 + khaali" sabse mehnga pattern hai — 404 se behtar kabhi nahi hota.'],
    ['robots_blocked', 'Robots.txt ka ek line',
     'Kam se kam ek URL sitemap mein declared hai par robots.txt se blocked. Blocked page par canonical bhi kaam nahi karta, sitemap entry bhi — Google use re-consider nahi karta.',
     'Block ko directory-level rakho, wildcard se bacho. Unblock → sitemap regenerate → resubmit (free).'],
    ['alt_missing', 'Bulk media fix',
     alt.length + ' pages par image ALT missing (sample: ' + alt.slice(0, 2).map(x => x.path + ' (' + x.altMissing + ')').join(', ') + '). Ye sirf accessibility nahi: screen reader ke liye zaroori, image search ka free traffic, aur Google ki apni published guidance ka hissa.',
     'Template par ek sensible default + top 10 pages ke liye hand-written description. ALT ko keyword slot mat banao — wahi tab spam policy ban jaata hai.'],
    ['title_missing', '10 minute ka kaam',
     (by.title_missing ? by.title_missing.pages.length : 0) + ' page par koi <title> hi nahi. Google URL se naam ghadi legi, aur wo aapka brand nahi rahega.',
     '30–60 char: topic + ek qualifier, brand aakhir mein.'],
    ['noindex', 'Galti se laga hua, process bug',
     (by.noindex ? by.noindex.pages.length : 0) + ' page par noindex hai. Ye technical problem se zyada process ka hai: template change ke waqt laga aur wapas nahi gaya. Jab tak ye hai, is page ko jaane waale saare links signal dena chhod dete hain.',
     'Remove karo → robots meta verify → URL inspect. (Google URL Inspection 2,000/day cap ke saath, isliye poori site nahi, priority watchlist inspect karte hain.)'],
    ['hreflang_missing', 'Sirf multilingual site par',
     (by.hreflang_missing ? by.hreflang_missing.pages.length : 0) + ' pages. Ye finding tabhi valid hai jab site ek se zyada bhaasha serve kare — single-language site par hreflang ka koi matlab nahi, isliye audit use flag nahi karta.',
     'Reciprocal hreflang + x-default. Aadhi site par akela hreflang = dono ignore.'],
  ];
  let n = 0;
  for (const [code, head, why, fix] of plan) {
    const g = by[code]; if (!g) continue; n++;
    p('### ' + n + '. ' + g.t + ' — ' + g.pages.length + ' URL' + (g.pages.length > 1 ? 's' : '') + ' · impact ' + g.impact);
    p('**' + head + '**'); p(''); p(why); p(''); p('**Fix:** ' + fix); p('');
    if (code === 'title_duplicate' && dups.length) {
      p('```'); dups.slice(0, 5).forEach(([t, v]) => p('×' + v.length + '  ' + t.slice(0, 68) + '\n        → ' + v.slice(0, 5).join('  '))); p('```'); p('');
    }
  }
  p('## Poori queue (severity → impact se sorted)');
  p(''); p('| # | issue | URLs | impact | kya karna hai |'); p('|---|---|---|---|---|');
  iss.forEach((g, i) => p('| ' + (i + 1) + ' | ' + (g.se === 0 ? '🔴 ' : g.se === 1 ? '' : '⚪ ') + RULE_BY[g.code].t + ' | ' + g.pages.length + ' | ' + g.impact + ' | ' + String(RULE_BY[g.code].fix).replace(/\|/g, '/') + ' |'));
  p('');
  p('## Ye jaan-boojh ke khali chhoda gaya hai (guessed numbers nahi)');
  p('');
  p('- **Search volume, keyword difficulty, competitor keyword lists, backlink index** — inke liye ya toh property owner ka Google access chahiye, ya paid index licence. Dono ke bina ye fields **empty** hain, bhare nahi gaye.');
  p('- **Positions** bhi nahi hain: SERP positions ke liye ya GSC chahiye ya apne manual checks. Google ko scrape karke "position" bharana ToS breach hai aur data galat bhi hota hai (personalised + geo-locked).');
  p('- **LCP/CLS/INP** ' + (d.perf && d.perf.skipped ? 'isi liye nahi hain ki PSI endpoint anonymous calls rate-limit karta hai — `PSI_KEY` env var do aur wo column bhar jaayega. Ab "0" nahi dikhaya, jo galat hota.' : 'measure kiye gaye.') );
  p('- ' + (kw ? kw + ' Search Console rows imported hain → demand side real hai.' : 'Abhi demand side (kaun kya search kar raha hai) bilkul nahi hai — site ka owner GSC se 2 CSV export karke de de, toh wahi `live.js --gsc-csv` command se poora gap tab bhar jaata hai.'));
  p('');
  p('---'); p('');
  p('# Apni site pe aisa hi: 3 commands');
  p(''); p('```bash');
  p('node tools/live.js https://APNI-SITE.com --pages 300 --depth 3');
  p('node tools/bake.js out/live/site.json --html index.html --out live.html');
  p('node tools/report-md.js live.html "" PLAN.md     # ye file, client ke liye');
  p('open live.html');
  p('```');
  p('');
  p('**Level 2 — owner access mil jaaye (₹0, koi key nahi):** GSC → Performance → Export (Queries *aur* Pages, last 28 days), phir `node tools/live.js https://site --gsc-csv queries.csv --gsc-csv pages.csv`. Iske baad keyword universe, positions, CTR-vs-expected, opportunity score — sab asli ho jaate hain.');
  p('');
  p('**Level 3 — nightly automation:** `node tools/ingest.js --site sc-domain:site --property properties/…` with a service account in your own GCP project (free), or `node tools/gsc-token.js` to let the site owner grant read-only access in a browser. Cron se chala do, roz subah 06:30 report ready.');
  p('');
  p('*Data freshness: ye crawl ' + String(d.generatedAt).slice(0, 16).replace('T', ' ') + ' ka hai. Client ko report bhejte waqt dobara chalao — 24 ghante mein bhi pages badal jaate hain.*');
  return { md: L.join('\n'), score: sc.score, sub: sc.sub, issues: iss, pages: pages.length, priorityFixes: n };
}
