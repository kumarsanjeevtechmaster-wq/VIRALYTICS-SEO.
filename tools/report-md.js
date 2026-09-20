#!/usr/bin/env node
/* =============================================================================
   report-md.js — Node CLI around report-core.mjs.
   Turns a live-baked dashboard + its payload into a client-ready markdown
   action plan.

     node tools/report-md.js live-site.com.html [out/site.json] [PLAN.md]
   ============================================================================= */
'use strict';
const fs = require('fs'), path = require('path');
const FILE = process.argv[2], PAYLOAD = process.argv[3] || '', OUT = process.argv[4] || 'live-audit.md';

(async () => {
  if (!FILE) { console.error('usage: node tools/report-md.js <live-<domain>.html> [site.json] [PLAN.md]'); process.exit(2) }
  const html = fs.readFileSync(FILE, 'utf8');
  const data = (PAYLOAD && fs.existsSync(PAYLOAD)) ? JSON.parse(fs.readFileSync(PAYLOAD, 'utf8')) : null;
  const { makePlan } = await import('./report-core.mjs');
  const r = makePlan(html, data, { fileLabel: path.basename(FILE) });
  fs.writeFileSync(OUT, r.md);
  console.log('wrote ' + OUT + ' · ' + r.md.split('\n').length + ' lines · ' + r.pages + ' pages · score ' + r.score + '/100 · ' + r.issues.length + ' groups · ' + r.priorityFixes + ' priority fixes');
})().catch(e => { console.error('\nFAILED ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')); process.exit(1) });
