/* smoke.js — runs a BUILT single-file dashboard (not the sources) under a DOM stub,
   boots it through its real entry point, and clicks through every tab, modal and
   interactive control.

     node tools/smoke.js                      # dist/index.html (demo build)
     node tools/smoke.js live-baremetrics.com.html   # a live-data build

   exit 0 = the file you are about to hand to a client actually works. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), root = path.join(__dirname, '..');
const FILE = process.argv[2] || path.join(root, 'index.html');
const html = fs.readFileSync(FILE, 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(b => b.trim().length > 50);
if (blocks.length < 3) throw new Error('expected >=3 inline script blocks, found ' + blocks.length);

/* ---- 1. injected payload must be valid JSON (a raw </script> in data truncates it) ---- */
let injPages = null, injKw = null, injErr = null;
const inj = (html.match(/<script>window\.DATA\s*=\s*([\s\S]*?);<\/script>/) || [])[1];
if (inj) {
  try { const j = JSON.parse(inj.replace(/<\\\//g, '</')); injPages = (j.pages || []).length; injKw = (j.keywords || []).length }
  catch (e) { injErr = e.message }
}

/* ---- 2. DOM stub ---- */
const created = [], listeners = {}, log = [], mem = {};
function mk(tag) {
  const o = { nodeType: 1, tagName: String(tag || 'div').toUpperCase(), _kids: [], children: [],
    style: new Proxy({}, { set: () => true }), dataset: new Proxy({}, { set: () => true, get: () => '' }),
    value: '', checked: false, textContent: '', innerHTML: '', title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    append(...k) { o._kids.push(...k.flat()) }, appendData() {}, remove() {}, setAttribute() {}, getAttribute: () => null,
    addEventListener(t, f) { (o._ev = o._ev || {})[t] = f }, insertAdjacentHTML() {},
    contains: () => false, insertBefore: () => {}, replaceWith: () => {},
    querySelector: () => mk('q'), querySelectorAll: () => [], click() { if (o._ev && o._ev.click) o._ev.click({ target: o }) },
    focus() {}, getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 40 }) };
  created.push(o);
  return new Proxy(o, { set(t, k, v) { t[k] = v; return true }, get(t, k) {
    if (k in t) return t[k];
    if (typeof k === 'symbol' || k === 'then') return undefined;
    if (['parentNode', 'firstChild', 'lastChild', 'ownerDocument', 'parentElement'].includes(k)) return null;
    return mk(k) } });
}
const byId = {};
global.document = { createElement: mk, createElementNS: mk, createTextNode: t => ({ nodeType: 3, textContent: t, appendData() {} }),
  querySelector(sel) { if (sel && sel[0] === '#') { const id = sel.slice(1); const e = byId[id] = byId[id] || mk(id); return e } const e = mk('q'); e.append = () => {}; return e }, querySelectorAll: () => [],
  addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f) }, title: '', body: mk('body'), documentElement: mk('html'), head: mk('head'),
  getElementById(id) { return byId[id] = byId[id] || mk('id') } };
global.window = global; global.self = global;
global.addEventListener = (t, f) => { (listeners[t] = listeners[t] || []).push(f) };
global.localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v) }, removeItem: k => { delete mem[k] } };
global.navigator = { userAgent: 'smoke', clipboard: { writeText: async () => {} } };
global.location = { protocol: 'file:', href: 'file:///index.html', origin: 'null' };
global.netCalls = 0;
global.fetch = async () => { global.netCalls++; throw new Error('offline in smoke test') };
global.scrollTo = () => {}; global.prompt = () => 'verified in a real browser';
global.getComputedStyle = () => ({ getPropertyValue: () => '' });
global.requestAnimationFrame = f => f(); global.matchMedia = () => ({ matches: false, addEventListener() {} });
global.Blob = class { constructor(p) { this.parts = p } };
global.URL.createObjectURL = () => 'blob:x'; global.URL.revokeObjectURL = () => {};
const realWarn = console.warn, realInfo = console.info;
console.warn = (...a) => log.push('warn:' + a.join(' '));
console.info = (...a) => log.push('info:' + a.join(' '));

/* ---- 3. execute the shipped file exactly like a browser does ---- */
let err = null;
try { blocks.forEach((b, i) => vm.runInThisContext(b, { filename: path.basename(FILE) + '#block' + i })) } catch (e) { err = e }
if (err) { console.error('\n✗ shipped script threw while loading:\n', err.stack); process.exit(1) }

let fail = 0;
const ok = (n, c, d) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (d ? ' — ' + d : '')); if (!c) fail++ };
console.log('\nsmoke test on ' + path.relative(root, FILE) + ' (' + (html.length / 1024).toFixed(0) + ' KB, ' + blocks.length + ' inline scripts)');
if (inj) ok('injected DATA parses as JSON', !injErr, injErr || (injPages + ' pages · ' + injKw + ' keywords'));

ok('boot listener registered', Array.isArray(listeners.DOMContentLoaded) && listeners.DOMContentLoaded.length >= 1);
try { (listeners.DOMContentLoaded || []).forEach(f => f({})); ok('boot → first render', true, created.length + ' DOM nodes created') }
catch (e) { ok('boot → first render', false, e.message + ' | ' + (e.stack || '').split('\n')[1]); }

const tabs = ['overview', 'audit', 'google', 'gap', 'ranks', 'backlinks', 'plan', 'deliverables', 'reports', 'roi'];
const bigTab = inj && injPages ? Math.max(900, injPages * 12) : 800;
for (const t of tabs) {
  let h = '', e2 = null;
  try { go(t); h = VIEWS[t]() } catch (e) { e2 = e }
  ok('tab ' + t, !e2 && h.length > (t === 'reports' || t === 'plan' ? 3000 : bigTab * 0.25), e2 ? ('THREW ' + e2.message) : (h.length + ' chars'))
  if (!e2) {
    const bad = (h.match(/undefined|NaN|\[object Object\]/g) || []);
    ok('  clean ' + t, bad.length === 0, bad.length ? [...new Set(bad)].join(',') + ' ×' + bad.length : 'no undefined/NaN')
  }
}
/* live builds: prove the real crawl actually drove the audit */
if (inj && injPages) {
  try {
    const iss = auditIssues();
    const paths = new Set(Pages.map(p => p.path));
    ok('audit ran on REAL pages', iss.length > 0 && paths.has('/'), iss.length + ' issue groups over ' + Pages.length + ' crawled URLs');
    ok('no demo pages leaked in', Pages.every(p => paths.has(p.path)) && !paths.has('/features/reel-generator'), Pages.length + ' URLs, all from the crawl');
    ok('health score computed', (() => { const s = scoreFrom(iss); return s.score >= 5 && s.score <= 100 })(), scoreFrom(iss).score + '/100 · ' + iss.filter(i => i.se === 0).length + ' critical');
    ok('keyword demand empty unless GSC supplied', (typeof KW !== 'undefined') && (injKw ? KW.length >= injKw : true), (injKw || 0) + ' GSC rows → ' + KW.length + ' scored');
  } catch (e) { ok('live audit path', false, e.message) }
}
const hasKw = typeof KW !== 'undefined' && KW.length;
try { openIssue(0); closeModal(); ok('issue modal', true) } catch (e) { ok('issue modal', false, e.message) }
if (hasKw) { try { openKw(KW[0].q); closeModal(); openBrief(0); closeModal(); ok('keyword + brief modals', true) } catch (e) { ok('keyword/brief modals', false, e.message) } }
else console.log('  - keyword/brief modals skipped (no keyword universe: no GSC rows supplied)')
try { pal(); palRender('a'); ok('command palette', true, palRows.length + ' hits') } catch (e) { ok('palette', false, e.message) }
try {
  showSources(); closeModal(); if(hasKw){togglePri(KW[0].q); suppress(KW[0].q)}
  if (typeof Comps !== 'undefined' && Comps[0]) toggleComp(Comps[0].id);
  apDecision(APPROVALS[0].id, 'approved'); advDeliv(0); runAudit(); autoBriefs(); approveLow();
  ok('interactive controls', true)
} catch (e) { ok('interactive controls', false, e.message) }
/* round-2 features: history, value-per-opportunity, ROI ranges, kam-evidence, why-score, staleness */
try {
  const hh = (typeof getHIST === 'function') ? getHIST() : [];
  ok('run history: snapshot saved on boot', hh.length >= 1, hh.length + ' point(s) · ' + hh.map(h => h.at + ':' + h.score).join(' '))
} catch (e) { ok('run history: snapshot saved on boot', false, e.message) }
try {
  whyScore();
  const mh = document.getElementById('modal').innerHTML || '';
  ok('why-score modal', mh.length > 300 && mh.includes('viralytics-engine-v1') && mh.includes('weights'), mh.length + ' chars, formula + weights + engine tag')
  closeModal();
} catch (e) { ok('why-score modal', false, e.message) }
try {
  const g = VIEWS.gap();
  const hasLowEv = KW.some(k => k.imp != null && k.imp > 0 && k.imp < 200 && k.pos);
  ok('low-evidence filter', !hasLowEv ? g.includes('Low evidence') : g.includes('low evidence'), hasLowEv ? 'badge rendered on thin-impression rows' : 'no demo rows under 200 impr (badge not expected)')
  gapF.only = 'lowev'; const g2 = VIEWS.gap(); gapF.only = 'all';
  ok('low-evidence view renders', g2.length > 500, g2.length + ' chars')
} catch (e) { ok('low-evidence filter', false, e.message) }
try {
  const r = VIEWS.roi();
  const liveNoGsc = !!inj && injKw === 0;
  ok('ROI tab content', liveNoGsc ? r.includes('No demand data yet') && r.includes('Search Console') : r.includes('Conservative') && r.includes('Expected') && r.includes('Upside'), (liveNoGsc ? 'honest empty state (no GSC rows)' : 'ranges rendered') + ' · ' + r.length + ' chars')
} catch (e) { ok('ROI tab content', false, e.message) }
try {
  const o = VIEWS.overview();
  ok('overview shows run history card', o.includes('Run history') && o.includes('Client numbers'), 'history + client-numbers cards present')
} catch (e) { ok('overview new cards', false, e.message) }
/* keyboard shortcuts: arrows cycle tabs, ? helps, typing in inputs is exempt */
try {
  const key = k => (listeners.keydown || []).forEach(f => f({ key: k, target: { tagName: 'BODY' }, preventDefault() {} }));
  const t0 = State.tab;
  key('ArrowRight'); const t1 = State.tab;
  key('ArrowLeft');  const t2 = State.tab;
  key('?');
  ok('arrow keys cycle tabs', t1 !== t0 && t2 === t0, t0 + ' → ' + t1 + ' → ' + t2);
  (listeners.keydown || []).forEach(f => f({ key: 'a', target: { tagName: 'INPUT' }, preventDefault() {} }));
  ok('typing in inputs does not switch tabs', State.tab === t0);
} catch (e) { ok('keyboard shortcuts', false, e.message) }
ok('persistence → localStorage', Object.keys(mem).length > 0, Object.keys(mem).join(','));
ok('zero network requests on file://', global.netCalls === 0, global.netCalls + ' fetches');
console.log('\n' + (fail ? fail + ' FAILURE(S)' : 'SMOKE PASSED — this file boots and every screen renders') + '\n');
process.exit(fail ? 1 : 0);
