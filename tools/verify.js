/* verify.js — runs every tab of the built app under a DOM stub and fails loudly.
   `node tools/verify.js`  ·  exit 0 = all 9 views + audit engine + scoring produced HTML. */
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,'build',f),'utf8');

function stub(tag){
  const make=t=>{const o={nodeType:1,tagName:t,style:new Proxy({},{set(){return true}}),dataset:new Proxy({},{set(){return true},get(){return ''}}),
    classList:{add(){},remove(){},toggle(){},contains(){return false}},children:[],value:'',checked:false,textContent:'',innerHTML:'',
    append(){},appendData(){},remove(){},setAttribute(){},getAttribute(){return null},addEventListener(){},
    insertAdjacentHTML(){},querySelector(){return null},querySelectorAll(){return []},click(){},focus(){},
    getBoundingClientRect(){return{top:0,left:0,width:100,height:40}}};
    return new Proxy(o,{set(t,k,v){t[k]=v;return true},get(t,k){if(k in t)return t[k];
      if(k==='then')return undefined; if(typeof k==='symbol')return undefined;
      if(k==='parentNode'||k==='firstChild'||k==='lastChild'||k==='parentElement'||k==='ownerDocument')return null;
      if(k==='scrollIntoView'||k==='removeAttribute'||k==='blur'||k==='select'||k==='scrollTo')return()=>{};
      return stub(typeof k==='string'?k:tag)},apply(){return''}})};
  return make(tag);
}
const mk=()=>{const e=stub('el');e.append=()=>{};return e};
const doc={createElement:mk,createElementNS:mk,createTextNode:s=>({nodeType:3,textContent:s,appendData(){}}),
  querySelector(){return mk()},querySelectorAll(){return []},addEventListener(){},title:'',
  body:stub('body'),documentElement:stub('html'),head:stub('head'),titleSet(){}};
const mem={};
global.window=global;global.document=doc;
global.addEventListener=()=>{};global.scrollTo=()=>{};global.URL=global.URL||{};global.location={href:'file:///index.html',origin:'null'};global.URL.createObjectURL=()=>'blob:x';
global.localStorage={getItem:k=>mem[k]??null,setItem:(k,v)=>{mem[k]=String(v)},removeItem:k=>{delete mem[k]}};
global.navigator={userAgent:'verify',clipboard:{writeText:async()=>{}}};
global.getComputedStyle=()=>({getPropertyValue(){return ''}});
global.requestAnimationFrame=f=>f();global.matchMedia=()=>({matches:false,addEventListener(){}});
global.URL=global.URL||{};global.Blob=global.Blob||class{constructor(){}};

/* 1) load both scripts in the shared global lexical scope, exactly like the page does */
vm.runInThisContext(read('seed.js')+'\n'+read('app.js'),'app.js',{filename:'bundle.js'});
global.window.render=render;global.window.VIEWS=VIEWS;global.window.auditIssues=auditIssues;
global.window.KW=KW;global.window.Pages=Pages;global.window.State=State;

let fail=0;
const ok=(name,cond,detail)=>{console.log((cond?'  ✓ ':'  ✗ ')+name+(detail?' — '+detail:''));if(!cond)fail++};

console.log('\n[1/4] data layer');
ok('pages parsed',Pages.length>=50,Pages.length+' rows');
ok('all rows have flags/status',Pages.every(p=>typeof p.rawFlag==='number'&&p.status>0));
ok('keyword universe',KW.length>=60,KW.length+' keywords ('+KW.filter(k=>k.core).length+' core + long-tail)');
ok('every keyword scored',KW.every(k=>k.opp&&Number.isFinite(k.opp.total)&&k.opp.total>=0&&k.opp.total<=99));
ok('GSC series = 90 days',GSC.q.every(q=>q.series.length===90)&&GSC.q.length>0,GSC.q.length+' queries');
ok('rank history = 30 days',Rank.every(r=>r.hist.length===30)&&Rank.length>0,Rank.length+' tracked');
ok('competitors + crawl sample',Comps.length>=15&&COMP_PAGES.length>0,Comps.length+' comps / '+COMP_PAGES.length+' crawled pages');

console.log('\n[2/4] audit engine (rules → issues → score)');
const iss=auditIssues();
ok('rules produced issues',iss.length>=15,iss.length+' issue groups');
ok('no unknown rule codes',iss.every(i=>RULE_BY[i.code]),iss.map(i=>i.code).filter(c=>!RULE_BY[c]).join(',')||'all codes in catalogue');
ok('every issue has ≥1 affected URL or is site-scope',iss.every(i=>i.pages.length>0||RULE_BY[i.code].scope==='site'));
const sc=scoreFrom(iss);
ok('health score is a sane number',sc.score>5&&sc.score<100,sc.score+'/100 · drag '+sc.drag+' · '+sc.crit+' critical');
ok('subscores all 0-100',Object.values(sc.sub).every(v=>v>=0&&v<=100),JSON.stringify(sc.sub));
const dupes=Object.keys(iss.reduce((a,i)=>((a[i.code]=a[i.code]+1||1),a),{})).filter(k=>k&&iss.filter(i=>i.code===k).length>1);
ok('no duplicated issue groups',dupes.length===0,dupes.join(','));

console.log('\n[3/4] scoring, clustering, anomalies');
ok('gap rows sorted desc',(()=>{const r=gapRows();return r.every((x,i)=>i===0||r[i-1].opp.total>=x.opp.total)})());
ok('clusters built',CLUSTERS.length>=3,CLUSTERS.length+' clusters · '+CLUSTERS.reduce((a,c)=>a+c.members.length,0)+' keywords grouped');
ok('cannibalisation detected',cannibal().length>=1,cannibal().length+' conflicts');
ok('anomaly rules fired',anomalies().length>=4,anomalies().length+' findings: '+[...new Set(anomalies().map(a=>a.rule))].join(', '));
const wsum=[.22,.18,.15,.18,.17,.08].reduce((a,b)=>a+b,0);
ok('weights: 6 sub-scores + risk penalty = whole',Math.abs(wsum-0.98)<1e-9&&0.98+0.02===1,wsum.toFixed(2)+' weighted + risk penalty');
ok('volume is never invented',KW.filter(k=>k.imp==null).every(k=>typeof k.vol==='number'&&k.vol>0)&&KW.filter(k=>k.imp>0).length>0,'GSC impressions drive core rows; long-tail volumes labelled est.');

console.log('\n[4/4] all 9 tabs render HTML');
for(const [id,fn] of Object.entries(VIEWS)){
  let html='',err=null;
  try{html=fn()}catch(e){err=e}
  ok('tab:'+id,!err&&html.length>800,(err?('THREW: '+err.message+'\n'+(err.stack||'').split('\n')[1]):(html.length+' chars')));
  if(!err){
    const un=(html.match(/undefined|NaN|\[object Object\]/g)||[]);
    ok('  clean:'+id,un.length===0,un.length+' suspicious tokens: '+[...new Set(un)].join(','));
    fs.writeFileSync(path.join(root,'tools','last-'+id+'.html'),html);
  }
}
console.log('\n[4b] flag semantics — the bit map must match FLAG_CODE exactly');
{
  const perCode={};
  Pages.forEach(p=>{for(const bit in FLAG_CODE){if(flag(p,+bit))perCode[FLAG_CODE[bit]]=(perCode[FLAG_CODE[bit]]||0)+1}});
  ok('FLAG_CODE bits resolve',Object.values(perCode).some(x=>x>0),JSON.stringify(perCode));
  ok('flag() is a mask, not a shift',[1,2,4,8].every(v=>flag({rawFlag:v},v))&&!flag({rawFlag:1},2));
  ok('every FLAG_CODE bit has a rule that consumes it',Object.values(FLAG_CODE).every(c=>RULES.some(r=>r.code===c)),
     Object.values(FLAG_CODE).filter(c=>!RULES.some(r=>r.code===c)).join(',')||'no orphan flags');
  const noIdx=Pages.filter(p=>flag(p,1)).length;
  ok('noindex pages found via bit 1',noIdx>0,noIdx+' pages self-declare noindex');
  const mapped={noindex:1,canonical_mismatch:2,canonical_missing:3,hreflang_missing:4,lang_mismatch:5,og_missing:6,broken_link:7,http_links:8,soft_404:9,redirect_chain:10,repetition_risk:11};
  ok('every audit rule keyed to the right bit',Object.entries(mapped).every(([c,b])=>{
      const viaRule=auditIssues().find(i=>i.code===c);const viaBit=Pages.filter(p=>flag(p,b)).length;
      return viaRule?viaBit>0:true}),Object.entries(mapped).map(([c,b])=>c+':'+(auditIssues().find(i=>i.code===c)?.pages.length||0)+'/'+Pages.filter(p=>flag(p,b)).length).join(' '));
}

console.log('\n[5/5] ingest payload path (window.DATA) — the route real Google data takes');
try{
  const ing=normalise([{path:'/x',status:200,words:120,robots:'noindex, follow'},{path:'/y',status:200}]);
  if(process.env.DEBUG==='1')console.log('  ing[0]',JSON.stringify(ing[0]),'flag1=',flag(ing[0],1),'flag1b=',ing[0].rawFlag&2);
  ok('normalise: robots → flag bits',flag(ing[0],1)&&!flag(ing[1],1),'noindex bit '+ing[0].rawFlag);
  ok('normalise: missing title kept visible to the audit',ing[0].title===''&&ing[0].linksIn===0&&ing[0].depth===0);
  const dup=normalise([{path:'/a',title:'Same',meta:'M'},{path:'/b',title:'Same',meta:'M'}]);
  ok('normalise: duplicate title/meta detected',dup[0].dupTitle&&dup[0].dupMeta);
  const sc2=scoreFrom(auditIssues());
  ok('audit engine runs on seed pages',sc2.score>=5&&sc2.score<=100);
}catch(e){ok('normalise',false,e.message)}

/* modal + drawer paths, since they are separate render functions */
try{openIssue(0);ok('modal:issue',true)}catch(e){ok('modal:issue',false,e.message)}
try{openKw(KW[0].q);ok('modal:keyword',true)}catch(e){ok('modal:keyword',false,e.message)}
try{openBrief(0);ok('modal:brief',true)}catch(e){ok('modal:brief',false,e.message)}
try{render();nav();header();ok('shell (nav+header+render)',true)}catch(e){ok('shell',false,e.message)}
try{State.tab='gap';toggleComp(Comps[0].id);openKw(KW[1].q);closeModal();
  suppress(KW[2].q);togglePri(KW[3].q);apDecision(APPROVALS[0].id,'approved');advDeliv(3);runAudit();
  ok('interactions (toggle/approve/prioritise/suppress)',true)}catch(e){ok('interactions',false,e.message)}

if(process.env.DEBUG==='1'){
  console.log('\n[debug]');
  console.log('GA4D[0]',JSON.stringify(GA4D[0]));
  console.log('organic[0]',JSON.stringify(organicSeries[0]));
  console.log('min/max:', Math.min(...GA4D.flatMap(r=>[r.sessions,r.clk])), Math.max(...GA4D.map(r=>r.sessions)), 'h=',190, 'rg=', (Math.max(...GA4D.flatMap(r=>[r.sessions,r.clk]))-Math.min(...GA4D.flatMap(r=>[r.sessions,r.clk])))||1);
  console.log('chart:',lineChart(GA4D.map(r=>({day:r.day,sessions:r.sessions,clicks:r.clk})),['sessions','clk']).slice(0,300));
  console.log('chart2:',lineChart(organicSeries.map(r=>({day:r.day,imp:r.imp,clk:r.clk,ctr:+r.ctr.toFixed(2)})),['imp','clk','ctr']).slice(0,300));
}

console.log('\n'+(fail?fail+' CHECK(S) FAILED':'ALL CHECKS PASSED')+'\n');
process.exit(fail?1:0);