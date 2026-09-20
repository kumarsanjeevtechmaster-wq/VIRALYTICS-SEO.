#!/usr/bin/env python3
"""bake.py — turns the offline dashboard into a LIVE dashboard.

    python3 tools/bake.py <site.json> [--html index.html] [--out live-domain.html] [--keep-demo]

Three things happen, and only these three:
  1. the collected payload is injected as <script>window.DATA = {…}</script>
  2. the seeded demo set is neutralised (pages, keywords, GSC rows, competitors → empty)
     so a real client report can never contain a number that came from the demo
  3. app guards are applied (no-GSC sites must boot, live copy must not quote demo URLs)

Escaping: "</" inside the payload becomes "<\\/" — legal in a JS string, and it stops the
browser closing the script block early. The original index.html on disk is never modified.
"""
import argparse, json, pathlib, re, sys

ap = argparse.ArgumentParser()
ap.add_argument('data'); ap.add_argument('--html', default='index.html'); ap.add_argument('--out', default=None)
ap.add_argument('--keep-demo', action='store_true', help='comparison mode: keep seeded rows visible')
a = ap.parse_args()

src = pathlib.Path(a.html).read_text()
data = json.loads(pathlib.Path(a.data).read_text())
pages = data.get('pages') or []
if not pages:
    sys.exit('site.json has no pages — run tools/live.js first (it must crawl at least one URL)')
site = data.get('site') or {}
out = a.out or 'live-%s.html' % str(site.get('domain', 'site')).replace(':', '_')

# ---------------------------------------------------------------- 1. guards
GUARDS = [
    ("""  const gapPct=100*(gscClk-ga4Sess)/gscClk;""",
     """  const gapPct=gscClk?100*(gscClk-ga4Sess)/gscClk:null;"""),
    ("""<h3>GA4 → organic outcome <span class="sp"></span><span class="tag ${gapPct>20?'crit':'imp'}">click→session gap ${gapPct.toFixed(1)}%</span></h3>""",
     """<h3>GA4 → organic outcome <span class="sp"></span><span class="tag ${gapPct==null?'':gapPct>20?'crit':'imp'}">${gapPct==null?'GA4 not connected':'click→session gap '+gapPct.toFixed(1)+'%'}</span></h3>"""),
    ("""<b>Ops finding:</b> ${nf(gscClk)} GSC clicks (matching 30-day window) vs ${nf(ga4Sess)} GA4 organic sessions""",
     """<b>Ops finding:</b> ${gapPct==null?'No GSC/GA4 rows connected, so this reconciliation is empty. Wire it up — a gap over 20% is the cheapest money you will find this month, and it is a tracking bug, not an SEO one.':`${nf(gscClk)} GSC clicks (matching 30-day window) vs ${nf(ga4Sess)} GA4 organic sessions`}"""),
    # a real crawl can measure sitemap bloat: declared URLs vs what we could actually reach
    ("""  const sitemapDirty=Pages.filter(p=>flag(p,1)||p.status>=300).map(p=>p.path);""",
     """  const smp=OVER.sitemaps||{};const CFGdepth=(OVER.window&&OVER.window.depth)||3;
  if(smp.declaredCount&&Pages.length&&smp.declaredCount>Pages.length*3&&smp.declaredCount>200){
    const r=RULE_BY['sitemap_bloat'];
    if(r)out.push({code:r.code,t:r.t,se:r.se,cat:r.cat,w:r.w,
      pages:[{path:'sitemap ('+smp.declaredCount+' declared vs '+Pages.length+' crawlable in '+CFGdepth+' levels)'}],
      impact:+(r.w*Math.min(1,smp.declaredCount/Pages.length/8)).toFixed(2),state:'open'});
  }
  const sitemapDirty=Pages.filter(p=>flag(p,1)||p.status>=300).map(p=>p.path);"""),
    # hreflang rules are noise on a single-language site — measure only what applies
    ("""    if(flag(p,4)) push('hreflang_missing',L);
    if(flag(p,5)) push('lang_mismatch',L);""",
     """    if(i18n){
      if(flag(p,4)) push('hreflang_missing',L);
      if(flag(p,5)) push('lang_mismatch',L);
    }"""),
    ("""function auditIssues(){
  const out=[]; const byCode={};""",
     """function auditIssues(){
  const out=[]; const byCode={};
  /* a site that serves one language needs no hreflang — flagging it would be a false finding */
  const langs=new Set(Pages.map(p=>p.lang).filter(Boolean));
  const i18n=OVER.pages?langs.size>1:true;"""),
    # chart widgets must not emit NaN when a real site has no demand/series data
    ("""function sparkline(vals,w=120,h=30,color='#b7f24a'){
  if(!vals||!vals.length)return '';""",
     """function sparkline(vals,w=120,h=30,color='#b7f24a'){
  if(!vals||vals.length<2||!vals.every(Number.isFinite))return '';"""),
    ("""function lineChart(series,keys,h=190){
  const w=720,pad={l:44,r:10,t:12,b:22};""",
     """function lineChart(series,keys,h=190){
  if(!series||series.length<2)return '<div class="empty"><b>No daily series yet</b>This needs Search Console (or GA4) rows. A crawl cannot produce a clicks trend — an honest gap beats a drawn one.</div>';
  const w=720,pad={l:44,r:10,t:12,b:22};"""),
    ("""function scatter(points,onClick){
  const w=700,h=300,pl=42,pr=14,pt=12,pb=30;""",
     """function scatter(points,onClick){
  const w=700,h=300,pl=42,pr=14,pt=12,pb=30;
  if(!points||!points.length)return '<div class="empty"><b>Nothing to plot yet</b>The gap view needs a keyword universe: connect Search Console (or import its CSV) and every query you already rank for lands here automatically.</div>';"""),
    ("""'Median move (7d)',(rows.reduce((a,b)=>a+b.d7,0)/rows.length).toFixed(1)""",
     """'Median move (7d)',rows.length?(rows.reduce((a,b)=>a+b.d7,0)/rows.length).toFixed(1):'—'"""),
    ("""height:${Math.max(6,v/Math.max(...buckets)*86)}px""",
     """height:${Math.max(6,(v/((Math.max(...buckets)||1))*86)||6)}px"""),
    ("""const nf=n=>n==null?'—':Number(n).toLocaleString('en-IN',{maximumFractionDigits:2});""",
     """const nf=n=>n==null||!Number.isFinite(Number(n))?'—':Number(n).toLocaleString('en-IN',{maximumFractionDigits:2});"""),
    ("""const pct=(n,d=1)=>n==null?'—':Number(n).toFixed(d)+'%';""",
     """const pct=(n,d=1)=>(n==null||!Number.isFinite(Number(n)))?'—':Number(n).toFixed(d)+'%';"""),
    # a site with no Search Console rows used to crash the whole boot: GSC.q[0] on []
    ("""const organicSeries=GSC.q.map(x=>x.series).reduce((acc,s)=>s.map((r,i)=>({...r,imp:acc[i].imp+r.imp,clk:acc[i].clk+r.clk})),
  GSC.q[0].series.map(r=>({...r,imp:0,clk:0})));
organicSeries.forEach(r=>r.ctr=r.imp?100*r.clk/r.imp:0);""",
     """const organicSeries=(GSC.q.length?GSC.q.map(x=>x.series).reduce((acc,s)=>s.map((r,i)=>({...r,imp:acc[i].imp+r.imp,clk:acc[i].clk+r.clk})),
  GSC.q[0].series.map(r=>({...r,imp:0,clk:0}))):GSC.p.length?GSC.p[0].series.map(r=>({...r,imp:0,clk:0})):[]);
organicSeries.forEach(r=>r.ctr=r.imp?100*r.clk/r.imp:0);
const measured=GSC.q.length>0&&organicSeries.length>0;"""),
    ("""Organic.ctr=100*Organic.clicks/Organic.imp;Organic.pCtr=100*Organic.pClicks/Organic.pImp;
Organic.pos=+(GSC.q.reduce((a,b)=>a+b.pos28*b.tot28,0)/GSC.q.reduce((a,b)=>a+b.tot28,0)).toFixed(1);""",
     """Organic.ctr=Organic.imp?100*Organic.clicks/Organic.imp:null;
Organic.pCtr=Organic.pImp?100*Organic.pClicks/Organic.pImp:null;
(()=>{const w=GSC.q.reduce((a,b)=>a+b.tot28,0);Organic.pos=w?+(GSC.q.reduce((a,b)=>a+b.pos28*b.tot28,0)/w).toFixed(1):null})();"""),
    # demo GA4 rollup must not masquerade as the client's analytics
    ("""const GA4D=organicSeries.slice(-30).map(r=>""",
     """const GA4D=(measured?organicSeries:[]).slice(-30).map(r=>"""),
    # fake demo index counts
    ("""const Indexed=Object.assign({now:182,before:212},OVER.indexed||{});""",
     """const Indexed=Object.assign(OVER.indexed||{now:null,before:null},
  (OVER.indexed||{}).now?{}:{now:Pages.filter(p=>!(p.rawFlag&1)&&p.status===200).length,before:null});
const demoMode=!OVER.pages;"""),
    # the "indexed pages fell" anomaly must quote the crawl, never the demo narrative
    ("""  if(Indexed.before>Indexed.now) out.push({rule:'index_drop',sev:'critical',q:'(site)',url:'/compare/*',
    why:`indexed URLs fell ${Math.round(100*(Indexed.before-Indexed.now)/Indexed.before)}% (${Indexed.before} → ${Indexed.now}); 30 of them are /compare/* turned noindex on 12 Sep. A canonical cannot rescue a blocked page.`});""",
     """  if(Indexed.before>Indexed.now) out.push({rule:'index_drop',sev:'critical',q:'(site)',url:'(multiple)',
    why:`indexed URLs fell ${Math.round(100*(Indexed.before-Indexed.now)/Indexed.before)}% (${Indexed.before} → ${Indexed.now}). Pages self-declaring noindex: ${Pages.filter(p=>p.rawFlag&1).length}. A canonical cannot rescue a blocked page.`});"""),
    # the AI-summary card hardcoded one demo recommendation
    ("""        <p class="sub">Highest-leverage single move: a title/meta rewrite on <b>/features/reel-generator</b> — 14,500 impressions at 2.21% CTR vs 3.30% expected. No new content required.</p>""",
     """        <p class="sub">${measured?'Highest-leverage single move: rewrite the title/meta of the query with the widest gap between impressions you get and the CTR its position should earn. No new content required.'
          :'No Search Console data connected, so this summary is the crawl only. Every line below comes from real HTTP responses — demand (what people search) needs the property owner’s access, and we do not invent it.'}</p>"""),
    # GA4 card needs a not-connected state
    ("""      <div class="row"><span class="tag pass">connected</span><span class="sub mono">properties/3000000001</span></div>""",
     """      <div class="row"><span class="tag ${measured?'pass':'imp'}">${measured?'connected':'not connected'}</span><span class="sub mono">${measured?(GA4.property||'ga4'):('—')}</span></div>"""),
]
patched = src
applied = 0
for old, new in GUARDS:
    if old in patched:
        patched = patched.replace(old, new, 1); applied += 1
    elif new.split('\n')[0][:60] not in patched:
        print('  ! guard not applicable (already patched or file changed): %s…' % old[:48])

# ---------------------------------------------------------------- 2. kill the demo set
demo_removed = []
if not a.keep_demo:
    for pat, rep in [(r'const PAGES_RAW=`[^`]*`;', 'const PAGES_RAW=``;'),
                     (r'const K=\[[\s\S]*?\n\];', 'const K=[];'),
                     (r'const GSCQ=\[[\s\S]*?\n\];', 'const GSCQ=[];'),
                     (r'const GSCP=\[[\s\S]*?\n\];', 'const GSCP=[];'),
                     (r'const COMPS=\[[\s\S]*?\n\];', 'const COMPS=[];'),
                     (r'const COMP_PAGES=\[[\s\S]*?\n\];', 'const COMP_PAGES=[];')]:
        patched, n = re.subn(pat, rep, patched, count=1)
        if n: demo_removed.append(pat.split('=')[0].replace('const ', ''))

if site.get('domain'):
    patched = re.sub(r"SITE=\{domain:'[^']*'", "SITE={domain:'%s'" % site['domain'], patched, count=1)
    patched = re.sub(r"SITE=\{([^}]*?)brand:'[^']*'",
                     lambda m: "SITE={%sbrand:'%s'" % (m.group(1), (site.get('brand') or site['domain']).replace("'", '')),
                     patched, count=1)

# ---------------------------------------------------------------- 3. payload + header chip
blob = json.dumps(data).replace('</', '<\\/')
badge = ('<script>document.addEventListener("DOMContentLoaded",function(){setTimeout(function(){'
         'var t=document.getElementById("top");if(!t)return;var c=document.createElement("span");'
         'c.className="chip";c.style.cssText="border-color:#b7f24a;color:#b7f24a;font-weight:700";'
         'c.title=%s;c.textContent="LIVE · %d URLs crawled"+"";var x=t.querySelector(".chip.free");'
         'if(x)x.replaceWith(c);else t.append(c);'
         'var n=%s;if(n){var b=document.createElement("span");b.className="chip";b.style.borderColor="#f59e0b";b.textContent=n;t.append(b)}'
         '},80);});</script>') % (
    json.dumps('generated %s · sources: %s' % (str(data.get('generatedAt'))[:16].replace('T', ' '), ', '.join(data.get('sources') or []))),
    len(pages),
    json.dumps((data.get('locked') or ['demand data (Google Search Console) not connected'])[0].replace('— ', '')
               + ' not available without owner access' if (data.get('locked') or []) else ''))
# ORDER MATTERS: the payload must sit BEFORE the seed/app scripts — they read
# window.DATA at parse time, so injecting after them silently yields an empty site.
payload = '<script>window.DATA = %s;</script>\n' % blob
if badge in patched:
    sys.exit('refusing to write: file already carries a baked badge (re-bake from a clean index.html)')
first = patched.index('<script>', patched.index('SEED DATA') - 4000) if 'SEED DATA' in patched else patched.index('<script>')
if '<script>/* optional runtime loader' in patched:
    first = patched.index('<script>', patched.index('optional runtime loader') + 10)   # right after the loader
patched = patched[:first] + payload + badge + '\n' + patched[first:]

# ---------------------------------------------------------------- 4. safety
if '</script>' in blob:
    sys.exit('refusing to write: unescaped </script> survived in the payload')
if patched.count('<script>') != patched.count('</script>'):
    sys.exit('refusing to write: unbalanced <script> tags (%d/%d)' % (patched.count('<script>'), patched.count('</script>')))
if 'window.DATA = %s' % blob[:40] not in patched:
    sys.exit('refusing to write: payload did not land in the document')
for ph in ('__CSS__', '__SEED__', '__APP__'):
    if ph in patched:
        sys.exit('refusing to write: placeholder %s still present — is this a built file?' % ph)

pathlib.Path(out).write_text(patched)
print('\n live dashboard → %s  (%.0f KB)' % (out, len(patched) / 1024))
print('   %d real URLs · %d GSC keyword rows · guards applied %d/%d' % (len(pages), len(data.get('keywords') or []), applied, len(GUARDS)))
print('   demo set neutralised: %s' % (', '.join(demo_removed) or 'NOT — comparison mode'))
if data.get('locked'):
    print('   empty by design (needs owner’s Google access): %s' % ', '.join(x for x in data['locked'] if not x.startswith('—')))
print('   verify: node tools/smoke.js %s\n' % out)
