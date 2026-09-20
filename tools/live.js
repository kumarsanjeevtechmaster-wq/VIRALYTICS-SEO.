#!/usr/bin/env node
/* =============================================================================
   live.js — Node CLI wrapper around crawl-core.mjs (the shared engine).

     node tools/live.js https://example.com
     node tools/live.js https://example.com --pages 220 --depth 3 --out out/example
     PSI_KEY=AIza…  node tools/live.js https://example.com      # adds Core Web Vitals
     node tools/live.js https://example.com --gsc-csv queries.csv --gsc-csv pages.csv

   The engine now lives in tools/crawl-core.mjs so the Supabase cloud function
   runs the EXACT same code. This file keeps the old CLI 1:1 (progress to the
   terminal, site.json on disk, history read from out/<domain>/history.json).

   What it collects — unchanged:
     • own crawl : titles, metas, H1s, ALT, word counts, links in/out, status,
                   canonical, robots meta, hreflang, JSON-LD types, og:image,
                   http(s) mixed content, redirect hops, depth from homepage
     • robots.txt + every sitemap it can find (list-vs-crawl diff = index hygiene)
     • PageSpeed Insights + CrUX field data — only if you pass PSI_KEY
     • Google Search Console CSV exports, if you have them — the ONLY honest
       source of impressions / clicks / positions. We never model those.
   ============================================================================= */
'use strict';
const fs = require('fs'), path = require('path');

let _core;
const core = async () => _core || (_core = import('./crawl-core.mjs'));

function localDeps(outDir) {
  const root = path.join(__dirname, '..');
  return {
    onProgress: msg => process.stdout.write(msg),
    loadHistory: domain => {
      for (const dir of [path.join(root, 'out', domain), outDir]) {
        try {
          const f = path.join(dir, 'history.json');
          if (fs.existsSync(f)) { const h = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(h)) return h.slice(-24) }
        } catch (e) {}
      }
      return undefined;
    },
  };
}

async function collect(target, opts = {}) {
  const c = await core();
  const outDir = opts.out || 'out/live';
  const gsc = (opts.gscCsv || []).map(f => ({ file: path.basename(f), text: fs.readFileSync(f, 'utf8') }));
  const data = await c.collect(target, Object.assign({}, opts, { gsc }), localDeps(outDir));
  if (!opts.quiet) {
    fs.mkdirSync(outDir, { recursive: true });
    const f = path.join(outDir, 'site.json');
    fs.writeFileSync(f, JSON.stringify(data, null, 0));
    console.log(`   wrote ${f}  (${(fs.statSync(f).size / 1024).toFixed(1)} KB)`);
    console.log(`\n next: node tools/bake.js ${f} --html index.html --out live-<domain>.html`);
    console.log(`       node tools/report-md.js live-<domain>.html ${f} PLAN.md   # client-ready action plan\n`);
  }
  return data;
}

async function quick(target, o = {}) { const c = await core(); return c.quick(target, o, localDeps(o.out || 'out/live')) }
async function serpSample(target, keywords, o = {}) { const c = await core(); return c.serpSample(target, keywords, o) }

module.exports = { collect, quick, serpSample };

if (require.main === module) (async () => {
  const CLI = process.argv.slice(2);
  const opt = (k, d) => { const i = CLI.indexOf('--' + k); return i > -1 ? CLI[i + 1] : d };
  const listFiles = k => CLI.reduce((acc, a, i) => (a === '--' + k ? acc.concat(CLI[i + 1]) : acc), []);
  const target = CLI.find(a => /^https?:\/\//.test(a));
  if (!target) { console.error('usage: node tools/live.js https://site.com [--pages N] [--depth N] [--out DIR] [--gsc-csv f]...'); process.exit(2) }
  const kw = (opt('keywords', '') || '').split(',').filter(Boolean);
  let serp = [];
  if (kw.length) { console.log(' SERP sample (DuckDuckGo, polite throttle) — direction check only, NOT Google'); serp = await serpSample(target, kw) }
  const outDir = opt('out', 'out/live');
  await collect(target, { maxPages: +opt('pages', 180), depth: +opt('depth', 3), slow: +opt('delay', 250),
    out: outDir, gscCsv: listFiles('gsc-csv'), serp });
  if (serp.length) { console.log('\n SERP sample · DuckDuckGo position (NOT Google — a directional check):');
    serp.forEach(s => console.log('   ' + String(s.ddg ?? '—').padStart(4) + '  ' + s.q + (s.note ? '  (' + s.note + ')' : '')));
    fs.mkdirSync(outDir, { recursive: true });
    fs.appendFileSync(path.join(outDir, 'serp-sample.json'), JSON.stringify(serp, null, 1)); }
})().catch(e => { console.error('\nFAILED ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 3).join('\n')); process.exit(1) });
