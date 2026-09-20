/*live-ui*/
/* =============================================================================
   live-ui.js — the "type a website name" box that gets injected into index.html.
   Self-contained: no imports, no CDN, no framework. Works offline (shows the
   command to run) and online (talks to tools/go.js on localhost).
   ============================================================================= */
(function () {
  'use strict';
  var API = location.protocol.indexOf('http') === 0 ? '' : 'http://localhost:8420';
  var alive = null, busy = false;

  var css = '' +
    '#lvPanel{position:fixed;inset:0;background:rgba(6,7,9,.86);z-index:120;display:none;padding:26px 14px;overflow:auto}' +
    '#lvPanel.on{display:block}' +
    '.lv{max-width:820px;margin:0 auto;background:#111317;border:1px solid #2b323b;border-radius:14px;padding:18px 20px;color:#e6e8ea;' +
      'font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans Devanagari",sans-serif}' +
    '.lv h2{font-size:16px;margin:0 0 4px}.lv p.hint{color:#9aa4b0;font-size:12px;margin:0 0 14px}' +
    '.lv .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}' +
    '.lv input,.lv textarea,.lv select{font:inherit;background:#0c0e11;border:1px solid #2b323b;border-radius:9px;padding:8px 10px;color:#e6e8ea;min-width:0}' +
    '.lv input:focus,.lv textarea:focus{outline:2px solid #b7f24a;border-color:transparent}' +
    '.lv input#lvSite{flex:1;min-width:200px;font-size:15px;padding:11px 13px}' +
    '.lv textarea{width:100%;resize:vertical;min-height:54px}' +
    '.lv button{font:inherit;border:0;border-radius:9px;padding:9px 14px;cursor:pointer;background:#1b1f25;color:#e6e8ea;font-weight:600}' +
    '.lv button.go{background:#b7f24a;color:#0a0b0d;font-weight:800}.lv button:disabled{opacity:.45;cursor:wait}' +
    '.lv button.gh{background:transparent;border:1px solid #2b323b;color:#9aa4b0}' +
    '.lv .x{position:absolute;top:12px;right:16px;background:none!important;color:#6a7480;font-size:18px;padding:4px 8px}'
    + '.lv{position:relative}' +
    '.lv .stat{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}' +
    '.lv .b{background:#0c0e11;border:1px solid #21262d;border-radius:10px;padding:8px 11px;min-width:88px}' +
    '.lv .b b{display:block;font-size:19px;letter-spacing:-.5px}.lv .b span{color:#6a7480;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px}' +
    '.lv .ok{color:#22c55e}.lv .warn{color:#f59e0b}.lv .bad{color:#ef4444}' +
    '.lv table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12px}' +
    '.lv th{text-align:left;color:#6a7480;font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;padding:6px;border-bottom:1px solid #21262d}' +
    '.lv td{padding:6px;border-bottom:1px solid #191c21;vertical-align:top}' +
    '.lv .path{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.lv .note{background:#15181d;border:1px solid #21262d;border-left:3px solid #3b82f6;border-radius:8px;padding:9px 11px;color:#9aa4b0;font-size:12px;margin-top:10px}' +
    '.lv .note.amber{border-left-color:#f59e0b}.lv .note.green{border-left-color:#22c55e}' +
    '.lv code{background:#0c0e11;border:1px solid #21262d;border-radius:5px;padding:1px 5px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:#b7f24a}' +
    '.lv .bar{height:3px;background:#1b1f25;border-radius:3px;overflow:hidden;margin:10px -20px 0}' +
    '.lv .bar i{display:block;height:100%;width:0;background:#b7f24a;transition:width .35s}' +
    '#lvBtn{display:inline-flex;gap:6px;align-items:center;background:rgba(183,242,74,.1);border:1px solid rgba(183,242,74,.4);' +
      'color:#b7f24a;border-radius:20px;padding:4px 11px;font-size:11.5px;cursor:pointer;font-weight:700}' +
    '#lvBtn .dot{width:6px;height:6px;border-radius:50%;background:#6a7480}' +
    '#lvBtn.on .dot{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18)}';

  function el(t, at) { var e = document.createElement(t); for (var k in (at || {})) { if (k === 'html') e.innerHTML = at[k]; else if (k === 'text') e.textContent = at[k]; else e.setAttribute(k, at[k]) } return e }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }
  function num(n, cls, label) { return '<div class="b"><b class="' + (cls || '') + '">' + (n == null ? '—' : n) + '</b><span>' + (label || '') + '</span></div>' }
  function fmt(n) { return (n == null ? '—' : Number(n).toLocaleString('en-IN')) }

  var st = document.createElement('style'); st.id = 'live-ui-css'; st.textContent = css; document.head.append(st);

  var panel = el('div', { id: 'lvPanel' });
  panel.innerHTML =
    '<div class="lv"><button class="x gh" id="lvX">✕</button>' +
    '<h2>🔎 Kisi bhi website ka haal-puchha</h2>' +
    '<p class="hint">Domain likho — 3 second mein pata chal jaayega site theek hai ya usme kaam hai. Baat cheet ke dauran hi dikha sakte ho.</p>' +
    '<div class="row"><input id="lvSite" placeholder="jaise: sharmaclinic.in" autocomplete="off" spellcheck="false">' +
    '<select id="lvMode"><option value="quick">Jaldi (12 pages)</option><option value="audit">Poori jaanch (180 pages, ~3-4 min)</option></select>' +
    '<button class="go" id="lvGo">Dekho</button></div>' +
    '<div class="row"><input id="lvKws" style="flex:1" placeholder="keywords, comma se: dental clinic noida, best dentist noida — optional"></div>' +
    '<div class="bar"><i id="lvBar"></i></div>' +
    '<div id="lvOut"></div></div>';
  document.body.append(panel);

  var btn = el('button', { id: 'lvBtn', html: '<span class="dot"></span>Website daalo' });
  btn.onclick = open;
  function mount() {
    var h = document.getElementById('top'); if (!h) return;
    if (h.contains(btn)) return;
    var sp = h.querySelector('.hspace'); if (sp) h.insertBefore(btn, sp.nextSibling); else h.append(btn);
  }
  /* the app rebuilds #top on every render (innerHTML='') — re-insert ourselves whenever that happens */
  function keepMounted() {
    mount();
    var h = document.getElementById('top'); if (!h) { setTimeout(keepMounted, 200); return }
    if (window.MutationObserver) new MutationObserver(function () { mount() }).observe(h, { childList: true });
    setInterval(function () { mount() }, 700);
  }

  function ping() {
    if (navigator.userAgent === 'smoke') { alive = false; return Promise.resolve(false) }
    if (location.protocol.indexOf('http') === 0 && API === '') { alive = true; btn.classList.add('on'); btn.innerHTML = '<span class="dot"></span>Website daalo'; return Promise.resolve(true) }
    return fetch(API + '/api/health', { cache: 'no-store' }).then(function (r) { return r.json() })
      .then(function (j) { alive = !!(j && j.ok); btn.classList.toggle('on', alive);
        btn.innerHTML = '<span class="dot"></span>' + (alive ? 'Website daalo' : 'Website daalo (server band)'); return alive })
      .catch(function () { alive = false; btn.classList.remove('on'); btn.innerHTML = '<span class="dot"></span>Website daalo'; return false });
  }

  function open() { panel.classList.add('on'); setTimeout(function () { document.getElementById('lvSite').focus() }, 40); if (alive === null) ping() }
  function close() { panel.classList.remove('on') }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close() });

  function prog(p, msg) { var b = document.getElementById('lvBar'); if (b) b.style.width = p + '%'; var o = document.getElementById('lvOut'); if (msg && o) o.innerHTML = '<div class="note' + (p < 100 ? '' : ' green') + '">' + esc(msg) + '</div>' }
  function out(html) { document.getElementById('lvOut').innerHTML = html }

  function verdict(j) {
    if (!j.ok) {
      return '<div class="note" style="border-left-color:#ef4444"><b>Site se connect nahi ho paya.</b><br>' + esc(j.error || '') +
        (j.hints ? '<br>' + j.hints.map(function (x) { return '• ' + esc(x) }).join('<br>') : '') + '</div>';
    }
    var s = j.snap || {}, bad = (s.errors || 0) + (s.noindex || 0), meh = (s.thin || 0) + (s.dupTitles || 0) + (s.missingTitle || 0);
    var tone = bad > 0 ? 'bad' : meh > 0 ? 'warn' : 'ok';
    var line = bad > 0 ? 'Isme kaam hai — ' + bad + ' page(s) me dikkat (404/500 ya noindex). Yahi pehle theek karna hai.'
      : meh > 0 ? 'Dhani dene layak: ' + meh + ' page(s) par title/word-count ki gadbadi. Bada kaam nahi, 1-2 din me theek ho jaayega.'
        : 'Upar se theek lag raha hai — par "theek" ka matlab "Google par upar" nahi hota. Demand (log kya khoj rahe) bhi dekhna padega.';
    var h = '<div class="stat">' + (s.reachable === false ? num('band', 'bad', 'site') : num(s.checked, 'ok', 'pages dekhe')) +
      num(s.errors, s.errors ? 'bad' : 'ok', '404/500') + num(s.noindex, s.noindex ? 'bad' : '', 'noindex') +
      num(s.thin, s.thin ? 'warn' : '', 'khaali page') + num(s.dupTitles, s.dupTitles ? 'warn' : '', 'duplicate title') +
      num(s.missingTitle, s.missingTitle ? 'warn' : '', 'title nahi') + num(s.altMissing, s.altMissing ? 'warn' : '', 'ALT missing') +
      num(s.sitemapDeclared, s.sitemapDeclared ? '' : 'warn', 'sitemap URLs') +
      num(s.avgWords, s.avgWords < 300 ? 'warn' : '', 'avg words') + '</div>' +
      '<div class="note ' + (tone === 'ok' ? 'green' : tone === 'warn' ? 'amber' : '') + '"><b>Faisla:</b> ' + line +
      '<br><span style="color:#6a7480">Home page ka title: </span><code>' + esc((s.home && s.home.title || '(no title)')) + '</code>' +
      (s.home && s.home.meta ? '' : ' <span style="color:#ef4444">(meta description nahi hai)</span>') + '</div>';
    if (j.serp && j.serp.length) {
      h += '<h2 style="font-size:13.5px;margin:14px 0 0">Public search result mein site kahan hai</h2>' +
        '<div style="color:#6a7480;font-size:11.5px;margin-bottom:2px">DuckDuckGo ka sample — <b>Google ki ranking nahi</b>. Direction check karne ke liye hai, client ko report mein ye number mat becho.</div>' +
        '<table><tr><th>Keyword</th><th>Position</th><th>Note</th></tr>' + j.serp.map(function (x) {
          var cls = typeof x.ddg === 'number' ? (x.ddg <= 10 ? 'ok' : x.ddg <= 30 ? 'warn' : 'bad') : 'bad';
          return '<tr><td>' + esc(x.q) + '</td><td class="' + cls + '"><b>' + esc(x.ddg == null ? '—' : x.ddg) + '</b></td>' +
          '<td style="color:#6a7480">' + esc(x.note || (typeof x.ddg === 'number' ? (x.ddg <= 10 ? 'top 10 mein ho ✓' : x.ddg <= 30 ? 'page 2 ke aas-paas' : 'neeche hai — kaam baaki') : 'is list mein nahi mila')) + '</td></tr>'
        }).join('') + '</table>';
    }
    if (j.issues && j.issues.length) {
      h += '<h2 style="font-size:13.5px;margin:14px 0 0">Kaunse pages par dikkat hai</h2><table><tr><th>Page</th><th>Words</th><th>Status</th><th>ALT</th><th>Robots</th></tr>' +
        j.issues.map(function (p) {
          return '<tr><td class="path" title="' + esc(p.path) + '">' + esc(p.path) + '</td><td class="' + (p.words < 90 ? 'bad' : p.words < 300 ? 'warn' : '') + '">' + fmt(p.words) + '</td><td>' + p.status + '</td><td>' + (p.altMissing || '') + '</td><td>' + (p.noindex ? '<span class="bad">noindex</span>' : '') + '</td></tr>'
        }).join('') + '</table>';
    }
    h += '<div class="note"><b>Ye abhi 12 pages ka snapshot hai.</b> Poori jaanch (180 pages + save-able report) ke liye neeche wala button dabao — 3-4 minute lagenge, tab tak aap client se baat karte rahiye.' +
      (j.whatWeMissed ? '<br>' + j.whatWeMissed.map(function (x) { return '• ' + esc(x) }).join('<br>') : '') + '</div>';
    h += '<div class="row" style="margin-top:12px"><button class="go" id="lvFull">Poori jaanch chalu karo → report file</button>' +
      '<span style="color:#6a7480;font-size:11.5px">report folder mein save hogi, download link yahi milega</span></div>';
    return h;
  }

  function runAudit() {
    var site = normv(); prog(6, 'Poori jaanch chalu — ' + site + ' ke ~180 pages padh rahe hain. 3-4 minute...');
    fetch(API + '/api/audit?site=' + encodeURIComponent(site)).then(function (r) { return r.json() }).then(function (j) {
      if (!j.ok) { prog(0, ''); return out('<div class="note" style="border-left-color:#ef4444"><b>Ruk gaya:</b> ' + esc(j.error) + '</div>') }
      prog(100, '');
      out('<div class="note green"><b>Ho gaya.</b> ' + j.pages + ' pages · ' + j.seconds + 's · sitemap ' + (j.sitemaps.declared || 0) + ' URLs batata hai · robots.txt ' + (j.sitemaps.robots ? ' mila' : ' NAHI mila') + '.<br>' +
        'Do file ban gayi: <b>live-' + esc(site) + '.html</b> (client ko bhejne layak dashboard, ek file, offline chalti hai) aur <b>' + esc(j.plan || '') + '</b> (kya karna hai, list mein).' +
        '</div><div class="row" style="margin-top:10px"><a href="' + j.download + '" download><button class="go">live-' + esc(site) + '.html download karo</button></a>' +
        (j.plan ? '<a href="/api/live/' + encodeURIComponent(j.plan) + '" download><button class="gh">Action plan (.md)</button></a>' : '') + '</div>')
    }).catch(function (e) { prog(0, ''); out('<div class="note" style="border-left-color:#ef4444">' + esc(e.message) + '</div>') })
  }
  function normv() { return (document.getElementById('lvSite').value || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '') }

  function run() {
    if (busy) return; var site = normv();
    if (!site || site.indexOf('.') < 0) { out('<div class="note" style="border-left-color:#f59e0b">Poora domain likho — jaise <code>sharmaclinic.in</code> (http:// ki zaroorat nahi)</div>'); return }
    busy = true; document.getElementById('lvGo').disabled = true;
    var kws = (document.getElementById('lvKws').value || '').trim();
    prog(8, 'Server se pooch rahe hain…');
    fetch(API + '/api/quick?site=' + encodeURIComponent(site) + (kws ? '&kws=' + encodeURIComponent(kws) : ''))
      .then(function (r) { return r.json() })
      .then(function (j) { prog(100, ''); out(verdict(j)); var f = document.getElementById('lvFull'); if (f) f.onclick = runAudit })
      .catch(function (e) { prog(0, ''); noServer(site, kws) })
      .then(function () { busy = false; document.getElementById('lvGo').disabled = false; setTimeout(function () { prog(0, '') }, 400) });
  }

  function noServer(site, kws) {
    out('<div class="note amber"><b>Live box abhi band hai</b> (ya file:// se khola hai). Terminal mein ek line chalao, phir ye box kaam karega:</div>' +
      '<div style="margin:9px 0"><code>node tools/go.js</code>&nbsp;&nbsp;<button class="gh" id="lvCopy" style="padding:4px 9px;font-size:11.5px">copy</button></div>' +
      '<div style="color:#6a7480;font-size:12px">Ya bina server, seedha 3 command — har client ke liye ek report file:<br>' +
      '<code>node tools/live.js https://' + esc(site || 'client-site.com') + (kws ? ' --keywords "' + esc(kws) + '"' : '') + '</code><br>' +
      '<code>python3 tools/bake.py out/live/site.json --html index.html --out live-report.html</code><br>' +
      '<code>node tools/report-md.js live-report.html out/live/site.json PLAN.md</code></div>');
    var c = document.getElementById('lvCopy'); if (c) c.onclick = function () { navigator.clipboard && navigator.clipboard.writeText('node tools/go.js'); c.textContent = 'copied ✓' };
  }

  document.getElementById('lvGo').onclick = run;
  document.getElementById('lvSite').addEventListener('keydown', function (e) { if (e.key === 'Enter') run() });
  document.getElementById('lvX').onclick = close;
  panel.addEventListener('click', function (e) { if (e.target === panel) close() });

  keepMounted(); ping(); setInterval(function () { if (alive === false) ping() }, 20000);
})();
