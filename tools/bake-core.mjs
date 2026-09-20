/* =============================================================================
   bake-core.mjs — turns the offline dashboard into a LIVE dashboard.
   Runtime-agnostic (Node + Deno): pure string work, zero fs/path/process.

     bake(srcHtml, data) → { html, out, applied, total, demoRemoved, locked, pages, kw }

   Three things happen, and only these three:
     1. the collected payload is injected as <script>window.DATA = {…}</script>
     2. the seeded demo set is neutralised (pages, keywords, GSC rows, competitors → empty)
        so a real client report can never contain a number that came from the demo
     3. app guards are applied (no-GSC sites must boot, live copy must not quote demo URLs)

   Ported 1:1 from tools/bake.py — the GUARDS list below is machine-extracted
   from bake.py's AST (ast.literal_eval → JSON.stringify), so both bakers apply
   byte-identical patches. Parity-tested: outputs must be byte-identical.
   Escaping: "</" inside the payload becomes "<\/" — legal in a JS string, and it
   stops the browser closing the script block early. The original index.html on
   disk is never modified.
   ============================================================================= */

const GUARDS = [
  [
    "  const gapPct=100*(gscClk-ga4Sess)/gscClk;",
    "  const gapPct=gscClk?100*(gscClk-ga4Sess)/gscClk:null;"
  ],
  [
    "<h3>GA4 \u2192 organic outcome <span class=\"sp\"></span><span class=\"tag ${gapPct>20?'crit':'imp'}\">click\u2192session gap ${gapPct.toFixed(1)}%</span></h3>",
    "<h3>GA4 \u2192 organic outcome <span class=\"sp\"></span><span class=\"tag ${gapPct==null?'':gapPct>20?'crit':'imp'}\">${gapPct==null?'GA4 not connected':'click\u2192session gap '+gapPct.toFixed(1)+'%'}</span></h3>"
  ],
  [
    "<b>Ops finding:</b> ${nf(gscClk)} GSC clicks (matching 30-day window) vs ${nf(ga4Sess)} GA4 organic sessions",
    "<b>Ops finding:</b> ${gapPct==null?'No GSC/GA4 rows connected, so this reconciliation is empty. Wire it up \u2014 a gap over 20% is the cheapest money you will find this month, and it is a tracking bug, not an SEO one.':`${nf(gscClk)} GSC clicks (matching 30-day window) vs ${nf(ga4Sess)} GA4 organic sessions`}"
  ],
  [
    "  const sitemapDirty=Pages.filter(p=>flag(p,1)||p.status>=300).map(p=>p.path);",
    "  const smp=OVER.sitemaps||{};const CFGdepth=(OVER.window&&OVER.window.depth)||3;\n  if(smp.declaredCount&&Pages.length&&smp.declaredCount>Pages.length*3&&smp.declaredCount>200){\n    const r=RULE_BY['sitemap_bloat'];\n    if(r)out.push({code:r.code,t:r.t,se:r.se,cat:r.cat,w:r.w,\n      pages:[{path:'sitemap ('+smp.declaredCount+' declared vs '+Pages.length+' crawlable in '+CFGdepth+' levels)'}],\n      impact:+(r.w*Math.min(1,smp.declaredCount/Pages.length/8)).toFixed(2),state:'open'});\n  }\n  const sitemapDirty=Pages.filter(p=>flag(p,1)||p.status>=300).map(p=>p.path);"
  ],
  [
    "    if(flag(p,4)) push('hreflang_missing',L);\n    if(flag(p,5)) push('lang_mismatch',L);",
    "    if(i18n){\n      if(flag(p,4)) push('hreflang_missing',L);\n      if(flag(p,5)) push('lang_mismatch',L);\n    }"
  ],
  [
    "function auditIssues(){\n  const out=[]; const byCode={};",
    "function auditIssues(){\n  const out=[]; const byCode={};\n  /* a site that serves one language needs no hreflang \u2014 flagging it would be a false finding */\n  const langs=new Set(Pages.map(p=>p.lang).filter(Boolean));\n  const i18n=OVER.pages?langs.size>1:true;"
  ],
  [
    "function sparkline(vals,w=120,h=30,color='#b7f24a'){\n  if(!vals||!vals.length)return '';",
    "function sparkline(vals,w=120,h=30,color='#b7f24a'){\n  if(!vals||vals.length<2||!vals.every(Number.isFinite))return '';"
  ],
  [
    "function lineChart(series,keys,h=190){\n  const w=720,pad={l:44,r:10,t:12,b:22};",
    "function lineChart(series,keys,h=190){\n  if(!series||series.length<2)return '<div class=\"empty\"><b>No daily series yet</b>This needs Search Console (or GA4) rows. A crawl cannot produce a clicks trend \u2014 an honest gap beats a drawn one.</div>';\n  const w=720,pad={l:44,r:10,t:12,b:22};"
  ],
  [
    "function scatter(points,onClick){\n  const w=700,h=300,pl=42,pr=14,pt=12,pb=30;",
    "function scatter(points,onClick){\n  const w=700,h=300,pl=42,pr=14,pt=12,pb=30;\n  if(!points||!points.length)return '<div class=\"empty\"><b>Nothing to plot yet</b>The gap view needs a keyword universe: connect Search Console (or import its CSV) and every query you already rank for lands here automatically.</div>';"
  ],
  [
    "'Median move (7d)',(rows.reduce((a,b)=>a+b.d7,0)/rows.length).toFixed(1)",
    "'Median move (7d)',rows.length?(rows.reduce((a,b)=>a+b.d7,0)/rows.length).toFixed(1):'\u2014'"
  ],
  [
    "height:${Math.max(6,v/Math.max(...buckets)*86)}px",
    "height:${Math.max(6,(v/((Math.max(...buckets)||1))*86)||6)}px"
  ],
  [
    "const nf=n=>n==null?'\u2014':Number(n).toLocaleString('en-IN',{maximumFractionDigits:2});",
    "const nf=n=>n==null||!Number.isFinite(Number(n))?'\u2014':Number(n).toLocaleString('en-IN',{maximumFractionDigits:2});"
  ],
  [
    "const pct=(n,d=1)=>n==null?'\u2014':Number(n).toFixed(d)+'%';",
    "const pct=(n,d=1)=>(n==null||!Number.isFinite(Number(n)))?'\u2014':Number(n).toFixed(d)+'%';"
  ],
  [
    "const organicSeries=GSC.q.map(x=>x.series).reduce((acc,s)=>s.map((r,i)=>({...r,imp:acc[i].imp+r.imp,clk:acc[i].clk+r.clk})),\n  GSC.q[0].series.map(r=>({...r,imp:0,clk:0})));\norganicSeries.forEach(r=>r.ctr=r.imp?100*r.clk/r.imp:0);",
    "const organicSeries=(GSC.q.length?GSC.q.map(x=>x.series).reduce((acc,s)=>s.map((r,i)=>({...r,imp:acc[i].imp+r.imp,clk:acc[i].clk+r.clk})),\n  GSC.q[0].series.map(r=>({...r,imp:0,clk:0}))):GSC.p.length?GSC.p[0].series.map(r=>({...r,imp:0,clk:0})):[]);\norganicSeries.forEach(r=>r.ctr=r.imp?100*r.clk/r.imp:0);\nconst measured=GSC.q.length>0&&organicSeries.length>0;"
  ],
  [
    "Organic.ctr=100*Organic.clicks/Organic.imp;Organic.pCtr=100*Organic.pClicks/Organic.pImp;\nOrganic.pos=+(GSC.q.reduce((a,b)=>a+b.pos28*b.tot28,0)/GSC.q.reduce((a,b)=>a+b.tot28,0)).toFixed(1);",
    "Organic.ctr=Organic.imp?100*Organic.clicks/Organic.imp:null;\nOrganic.pCtr=Organic.pImp?100*Organic.pClicks/Organic.pImp:null;\n(()=>{const w=GSC.q.reduce((a,b)=>a+b.tot28,0);Organic.pos=w?+(GSC.q.reduce((a,b)=>a+b.pos28*b.tot28,0)/w).toFixed(1):null})();"
  ],
  [
    "const GA4D=organicSeries.slice(-30).map(r=>",
    "const GA4D=(measured?organicSeries:[]).slice(-30).map(r=>"
  ],
  [
    "const Indexed=Object.assign({now:182,before:212},OVER.indexed||{});",
    "const Indexed=Object.assign(OVER.indexed||{now:null,before:null},\n  (OVER.indexed||{}).now?{}:{now:Pages.filter(p=>!(p.rawFlag&1)&&p.status===200).length,before:null});\nconst demoMode=!OVER.pages;"
  ],
  [
    "  if(Indexed.before>Indexed.now) out.push({rule:'index_drop',sev:'critical',q:'(site)',url:'/compare/*',\n    why:`indexed URLs fell ${Math.round(100*(Indexed.before-Indexed.now)/Indexed.before)}% (${Indexed.before} \u2192 ${Indexed.now}); 30 of them are /compare/* turned noindex on 12 Sep. A canonical cannot rescue a blocked page.`});",
    "  if(Indexed.before>Indexed.now) out.push({rule:'index_drop',sev:'critical',q:'(site)',url:'(multiple)',\n    why:`indexed URLs fell ${Math.round(100*(Indexed.before-Indexed.now)/Indexed.before)}% (${Indexed.before} \u2192 ${Indexed.now}). Pages self-declaring noindex: ${Pages.filter(p=>p.rawFlag&1).length}. A canonical cannot rescue a blocked page.`});"
  ],
  [
    "        <p class=\"sub\">Highest-leverage single move: a title/meta rewrite on <b>/features/reel-generator</b> \u2014 14,500 impressions at 2.21% CTR vs 3.30% expected. No new content required.</p>",
    "        <p class=\"sub\">${measured?'Highest-leverage single move: rewrite the title/meta of the query with the widest gap between impressions you get and the CTR its position should earn. No new content required.'\n          :'No Search Console data connected, so this summary is the crawl only. Every line below comes from real HTTP responses \u2014 demand (what people search) needs the property owner\u2019s access, and we do not invent it.'}</p>"
  ],
  [
    "      <div class=\"row\"><span class=\"tag pass\">connected</span><span class=\"sub mono\">properties/3000000001</span></div>",
    "      <div class=\"row\"><span class=\"tag ${measured?'pass':'imp'}\">${measured?'connected':'not connected'}</span><span class=\"sub mono\">${measured?(GA4.property||'ga4'):('\u2014')}</span></div>"
  ],
];;

export function bake(src, data, { keepDemo = false } = {}) {
  const pages = data.pages || [];
  if (!pages.length) throw new Error('site.json has no pages — run the crawler first (it must crawl at least one URL)');
  const site = data.site || {};
  const out = 'live-' + String(site.domain || 'site').replace(':', '_') + '.html';

  /* ------------------------------------------------------- 1. guards */
  let patched = src;
  let applied = 0;
  const notApplicable = [];
  for (const [oldS, newS] of GUARDS) {
    if (patched.includes(oldS)) {
      patched = patched.replace(oldS, newS);
      applied++;
    } else if (!patched.includes(newS.split('\n')[0].slice(0, 60))) {
      notApplicable.push(oldS.slice(0, 48));
    }
  }

  /* ------------------------------------------------------- 2. kill the demo set */
  const demoRemoved = [];
  const subOnce = (re, rep, name) => {
    if (re.test(patched)) { patched = patched.replace(re, rep); demoRemoved.push(name); }
  };
  if (!keepDemo) {
    subOnce(/const PAGES_RAW=`[^`]*`;/, 'const PAGES_RAW=``;', 'PAGES_RAW');
    subOnce(/const K=\[[\s\S]*?\n\];/, 'const K=[];', 'K');
    subOnce(/const GSCQ=\[[\s\S]*?\n\];/, 'const GSCQ=[];', 'GSCQ');
    subOnce(/const GSCP=\[[\s\S]*?\n\];/, 'const GSCP=[];', 'GSCP');
    subOnce(/const COMPS=\[[\s\S]*?\n\];/, 'const COMPS=[];', 'COMPS');
    subOnce(/const COMP_PAGES=\[[\s\S]*?\n\];/, 'const COMP_PAGES=[];', 'COMP_PAGES');
  }

  if (site.domain) {
    patched = patched.replace(/SITE=\{domain:'[^']*'/, `SITE={domain:'${site.domain}'`);
    patched = patched.replace(/SITE=\{([^}]*?)brand:'[^']*'/,
      (m, g1) => `SITE={${g1}brand:'${(site.brand || site.domain).replace(/'/g, '')}'`);
  }

  /* ------------------------------------------------------- 3. payload + header chip */
  // ONLY "</" is escaped (a backslash between < and /) — same as bake.py; a bare
  // "<" in text values must stay untouched or the data mutates.
  const blob = JSON.stringify(data).replace(/<\//g, '<\\/');
  const firstLocked = (data.locked && data.locked[0]) || 'demand data (Google Search Console)';
  const nLocked = (data.locked && data.locked.length) ? firstLocked.replace('— ', '') + ' not available without owner access' : '';
  const badge = ('<script>document.addEventListener("DOMContentLoaded",function(){setTimeout(function(){' +
    'var t=document.getElementById("top");if(!t)return;var c=document.createElement("span");' +
    'c.className="chip";c.style.cssText="border-color:#b7f24a;color:#b7f24a;font-weight:700";' +
    'c.title=' + JSON.stringify('generated ' + String(data.generatedAt).slice(0, 16).replace('T', ' ') + ' · sources: ' + (data.sources || []).join(', ')) +
    ';c.textContent="LIVE · ' + pages.length + ' URLs crawled"+"";var x=t.querySelector(".chip.free");' +
    'if(x)x.replaceWith(c);else t.append(c);' +
    'var n=' + JSON.stringify(nLocked) + ';if(n){var b=document.createElement("span");b.className="chip";b.style.borderColor="#f59e0b";b.textContent=n;t.append(b)}' +
    '},80);});</script>');
  // ORDER MATTERS: the payload must sit BEFORE the seed/app scripts — they read
  // window.DATA at parse time, so injecting after them silently yields an empty site.
  const payload = '<script>window.DATA = ' + blob + ';</script>\n';
  if (patched.includes(badge)) throw new Error('refusing to write: file already carries a baked badge (re-bake from a clean index.html)');
  let first;
  const seedIdx = patched.indexOf('SEED DATA');
  first = (seedIdx > -1) ? patched.indexOf('<script>', seedIdx - 4000) : patched.indexOf('<script>');
  const loaderIdx = patched.indexOf('<script>/* optional runtime loader');
  if (loaderIdx > -1) first = patched.indexOf('<script>', loaderIdx + 10);   // right after the loader
  patched = patched.slice(0, first) + payload + badge + '\n' + patched.slice(first);

  /* ------------------------------------------------------- 4. safety */
  if (blob.includes('</script>')) throw new Error('refusing to write: unescaped </script> survived in the payload');
  const opens = (patched.match(/<script>/g) || []).length, closes = (patched.match(/<\/script>/g) || []).length;
  if (opens !== closes) throw new Error(`refusing to write: unbalanced <script> tags (${opens}/${closes})`);
  if (!patched.includes('window.DATA = ' + blob.slice(0, 40))) throw new Error('refusing to write: payload did not land in the document');
  for (const ph of ['__CSS__', '__SEED__', '__APP__']) {
    if (patched.includes(ph)) throw new Error('refusing to write: placeholder ' + ph + ' still present — is this a built file?');
  }
  return { html: patched, out, applied, total: GUARDS.length, demoRemoved, locked: data.locked || [], pages: pages.length, kw: (data.keywords || []).length };
}
