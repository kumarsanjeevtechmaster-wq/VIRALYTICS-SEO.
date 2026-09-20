#!/usr/bin/env node
/* =============================================================================
   bake.js — Node CLI around bake-core.mjs. Python is no longer required.

     node tools/bake.js <site.json> [--html index.html] [--out live-domain.html] [--keep-demo]

   Same behaviour as the old tools/bake.py (parity-tested byte-for-byte):
     1. payload injected as window.DATA   2. demo set neutralised
     3. 17 app guards applied   —   the original index.html is never modified.
   ============================================================================= */
'use strict';
const fs = require('fs');
const CLI = process.argv.slice(2);
const opt = (k, d) => { const i = CLI.indexOf('--' + k); return i > -1 ? CLI[i + 1] : d };

(async () => {
  const dataFile = CLI.find(a => !a.startsWith('--'));
  if (!dataFile) { console.error('usage: node tools/bake.js <site.json> [--html index.html] [--out live-domain.html] [--keep-demo]'); process.exit(2) }
  const htmlFile = opt('html', 'index.html');
  const keepDemo = CLI.includes('--keep-demo');
  const { bake } = await import('./bake-core.mjs');
  let src, data;
  try {
    src = fs.readFileSync(htmlFile, 'utf8');
    data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch (e) { console.error('✗ ' + e.message); process.exit(1) }
  const r = bake(src, data, { keepDemo });
  const outPath = opt('out') || r.out;
  fs.writeFileSync(outPath, r.html);
  console.log('\n live dashboard → ' + outPath + '  (' + Math.round(r.html.length / 1024) + ' KB)');
  console.log('   ' + r.pages + ' real URLs · ' + r.kw + ' GSC keyword rows · guards applied ' + r.applied + '/' + r.total);
  console.log('   demo set neutralised: ' + (r.demoRemoved.join(', ') || 'NOT — comparison mode'));
  if (r.locked.length) {
    console.log('   empty by design (needs owner’s Google access): ' + r.locked.filter(x => !x.startsWith('—')).join(', '));
  }
  console.log('   verify: node tools/smoke.js ' + outPath + '\n');
})().catch(e => { console.error('✗ ' + e.message); process.exit(1) });
