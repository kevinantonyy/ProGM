// Offline A-vs-B comparison through the PRODUCTION buildDraftBoard (rankingModel A and B).
// Usage: node docs/evaluations/ranking-model-compare.mjs <pool.json> [priorSeason]
// pool.json is produced by ranking-validation-prep.py (derived data; not committed).
import fs from 'node:fs';
import { buildPool, runValidation } from '../../server/src/services/fantasy/rankingValidationRun.js';
import { buildDraftBoard } from '../../server/src/services/fantasy/draftHelper.js';
import { evaluateVariants, poolSensitivity, orderingCorrelation } from '../../server/src/services/fantasy/rankingValidation.js';
const rows = JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const prior = Number(process.argv[3]||2024);
const { players, projectionProvider, realized, primary } = buildPool(rows, prior);
const SETTINGS = { teamCount: 12, rosterSlots: [['PG',1],['SG',1],['G',1],['SF',1],['PF',1],['F',1],['C',2],['UTIL',2]].map(([position,count])=>({position,count,isStarting:true})).concat([{position:'BN',count:3,isStarting:false}]) };
const DEPTH={G:36,F:36,C:24};
const mk=(m)=>buildDraftBoard({ players, settings: SETTINGS, projectionProvider, currentSeason: prior+1, limit: 1e5, rankingModel: m }).board;
const A=mk('A'), B=mk('B');
const orderA=A.map(r=>r.playerKey), orderB=B.map(r=>r.playerKey);
const ranking={rows:A.map(r=>({playerKey:r.playerKey,positions:r.eligiblePositions,perGame:r.perGame,seasonPoints:r.seasonPoints})),A:orderA,B:orderB,C:orderB};
const out={prior,n:players.length};
for (const topN of [24,50]) { const e=evaluateVariants({ranking,realized,settings:SETTINGS,topN,primaryOf:(r)=>primary.get(r.playerKey),depthOf:(p)=>DEPTH[p]??24}); out['top'+topN]={A:e.variants.A,B:e.variants.B}; }
const ra=new Map(orderA.map((k,i)=>[k,i+1])), rb=new Map(orderB.map((k,i)=>[k,i+1]));
const d=[...ra.keys()].map(k=>rb.get(k)-ra.get(k));
out.movement={moved:d.filter(x=>x).length,abs5plus:d.filter(x=>Math.abs(x)>=5).length,maxAbs:Math.max(...d.map(Math.abs)),top24Overlap:orderA.slice(0,24).filter(k=>orderB.slice(0,24).includes(k)).length,top50Overlap:orderA.slice(0,50).filter(k=>orderB.slice(0,50).includes(k)).length,spearmanAB:orderingCorrelation(orderA,orderB)};
const byPos={};for(const r of A){const p=primary.get(r.playerKey);(byPos[p]??=[]).push(rb.get(r.playerKey)-ra.get(r.playerKey));}
out.meanRankChangeByPrimary=Object.fromEntries(Object.entries(byPos).map(([k,v])=>[k,Number((v.reduce((s,x)=>s+x,0)/v.length).toFixed(2))]));
const nm=(n)=>{const p=players.find(q=>q.name===n);return p&&{A:ra.get(p.playerKey),B:rb.get(p.playerKey)}};
out.names=Object.fromEntries(['Cade Cunningham','Bam Adebayo','Alperen Sengun','Nikola Jokic','Victor Wembanyama'].map(n=>[n,nm(n)]));
// stability: pool dropout, production models
function stab(m){let s=7;const rnd=()=>(s=(s*1103515245+12345)%2147483648)/2147483648;const base=new Map(mk(m).map((r,i)=>[r.playerKey,i+1]));let tot=0,cnt=0;
 for(let t=0;t<5;t++){const sub=players.filter(()=>rnd()>0.2);const bb=buildDraftBoard({players:sub,settings:SETTINGS,projectionProvider,currentSeason:prior+1,limit:1e5,rankingModel:m}).board;
  const keep=new Set(sub.map(p=>p.playerKey));const baseSub=[...base.entries()].filter(([k])=>keep.has(k)).sort((a,b)=>a[1]-b[1]).map(([k])=>k);const br=new Map(baseSub.map((k,i)=>[k,i+1]));
  for(const [i,r] of bb.entries()){tot+=Math.abs((i+1)-br.get(r.playerKey));cnt++;}}
 return Number((tot/cnt).toFixed(3));}
out.meanAbsRankChangeWhen20pctPoolRemoved={A:stab('A'),B:stab('B')};
console.log(JSON.stringify(out,null,1));
