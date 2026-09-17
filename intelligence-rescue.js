const {Pool}=require('pg');
const {runMarketIntelligence}=require('./market-intelligence-worker');
const {runMarketDemandSurface}=require('./market-demand-surface-worker');
const {runMarketRegionalSnapshots}=require('./market-regional-snapshot-worker');
const demandEventModule=require('./market-demand-event-worker');
const {runMarketNewsSignals}=require('./market-news-signal-worker');
const {runCompetitorIntelligence}=require('./competitor-intelligence-worker');
const {processCreativeQueue}=require('./creative-queue');
const {processGenerationQueue}=require('./creative-generation');

const DATABASE_URL=process.env.DATABASE_URL||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
const CHECK_MS=Math.max(2,Number(process.env.INTELLIGENCE_RESCUE_CHECK_MINUTES||5))*60*1000;
const STALE_MS=Math.max(5,Number(process.env.INTELLIGENCE_RESCUE_STALE_MINUTES||10))*60*1000;
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false}):null;
let timer=null,busy=false,started=false;

function eventRunner(){
 const entries=Object.entries(demandEventModule||{}).filter(([k,v])=>/^run/i.test(k)&&typeof v==='function');
 return entries[0]?.[1]||null;
}
async function dedicatedHealthy(){
 try{
  const r=await pool.query(`SELECT MAX(last_heartbeat_at) last_heartbeat FROM dominance_worker_state WHERE worker_key IN('market-intelligence-worker','market-demand-surface-worker','competitor-intelligence-worker')`);
  const t=r.rows[0]?.last_heartbeat;if(!t)return false;
  return Date.now()-new Date(t).getTime()<STALE_MS;
 }catch{return false}
}
async function withLease(fn){
 const c=await pool.connect();
 try{
  const lock=await c.query(`SELECT pg_try_advisory_lock(77104261) locked`);
  if(!lock.rows[0]?.locked)return{ok:false,reason:'another_rescue_instance_running'};
  try{return await fn()}finally{await c.query(`SELECT pg_advisory_unlock(77104261)`).catch(()=>{})}
 }finally{c.release()}
}
async function runRescue(){
 if(!pool||busy)return{ok:false,reason:!pool?'database_unavailable':'busy'};
 busy=true;
 try{
  if(await dedicatedHealthy())return{ok:true,status:'dedicated_worker_healthy'};
  return await withLease(async()=>{
   if(await dedicatedHealthy())return{ok:true,status:'dedicated_worker_recovered'};
   console.warn('[INTELLIGENCE RESCUE] dedicated worker heartbeat is missing/stale; running collection on web service');
   const result={status:'rescue_run',started_at:new Date().toISOString()};
   const run=async(name,fn)=>{try{result[name]=await fn()}catch(e){result[name]={ok:false,error:String(e.message||e)};console.error(`[INTELLIGENCE RESCUE] ${name}`,e.message||e)}};
   await run('market',()=>runMarketIntelligence());
   await run('demand_surface',()=>runMarketDemandSurface());
   await run('regional_snapshots',()=>runMarketRegionalSnapshots());
   const demandRun=eventRunner();if(demandRun)await run('demand_events',()=>demandRun());
   await run('news',()=>runMarketNewsSignals());
   await run('competitors',()=>runCompetitorIntelligence({force:false}));
   await run('creative_queue',()=>processCreativeQueue(pool,{maxJobs:8}));
   await run('creative_generation',()=>processGenerationQueue(pool,{maxJobs:4}));
   result.finished_at=new Date().toISOString();
   await pool.query(`INSERT INTO dominance_worker_state(worker_key,last_heartbeat_at,last_run_at,status,details) VALUES('web-intelligence-rescue',NOW(),NOW(),'online',$1::jsonb) ON CONFLICT(worker_key) DO UPDATE SET last_heartbeat_at=NOW(),last_run_at=NOW(),status='online',details=EXCLUDED.details`,[JSON.stringify(result)]).catch(()=>{});
   return{ok:true,...result};
  });
 }finally{busy=false}
}
function startIntelligenceRescue(){
 if(started||!pool)return null;started=true;
 setTimeout(runRescue,20000);timer=setInterval(runRescue,CHECK_MS);
 console.log(`[INTELLIGENCE RESCUE] armed | check=${CHECK_MS/60000}m | stale=${STALE_MS/60000}m`);
 return{run:runRescue,stop:async()=>{if(timer)clearInterval(timer);await pool.end().catch(()=>{})}};
}
module.exports={startIntelligenceRescue,runIntelligenceRescue:runRescue};
