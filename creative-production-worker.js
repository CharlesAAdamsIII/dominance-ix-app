const {Pool}=require('pg');
const cp=require('./control-plane-core');
const {processCreativeQueue}=require('./creative-queue');
const {processGenerationQueue}=require('./creative-generation');

const DATABASE_URL=process.env.DATABASE_URL||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
const INTERVAL_MS=Math.max(1,Number(process.env.CREATIVE_PRODUCTION_INTERVAL_MINUTES||1))*60*1000;
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false}):null;
let timer=null,busy=false;

async function accountPipelineState(accountId){
 const [requests,assets]=await Promise.all([
  pool.query(`SELECT status,COUNT(*)::int n,MAX(updated_at) last_at FROM dominance_creative_requests WHERE dominance_account_id=$1 GROUP BY status`,[accountId]).catch(()=>({rows:[]})),
  pool.query(`SELECT status,COUNT(*)::int n,MAX(updated_at) last_at FROM dominance_generated_assets WHERE dominance_account_id=$1 GROUP BY status`,[accountId]).catch(()=>({rows:[]}))
 ]);
 const req={};for(const r of requests.rows)req[r.status]=Number(r.n||0);
 const ast={};for(const r of assets.rows)ast[r.status]=Number(r.n||0);
 const err=await pool.query(`SELECT id,asset_category,platform,status,last_error,updated_at FROM dominance_creative_requests WHERE dominance_account_id=$1 AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 3`,[accountId]).catch(()=>({rows:[]}));
 return{requests:req,assets:ast,recent_errors:err.rows};
}

async function recordAccountRuns(startedAt){
 const accounts=await pool.query(`SELECT id FROM dominance_accounts WHERE is_active=TRUE ORDER BY id`);
 for(const a of accounts.rows){
  const details=await accountPipelineState(a.id);
  const hasFailures=Number(details.requests.failed||0)>0;
  await cp.recordWorkerAccountRun(pool,'creative-queue',a.id,'completed',details,startedAt).catch(()=>{});
  await cp.recordWorkerAccountRun(pool,'creative-generation',a.id,hasFailures?'partial_error':'completed',details,startedAt).catch(()=>{});
 }
 return accounts.rowCount;
}

async function run(){
 if(!pool||busy)return{ok:false,reason:!pool?'database_unavailable':'busy'};
 busy=true;const startedAt=new Date();
 try{
  const queue=await processCreativeQueue(pool,{maxJobs:12});
  const generation=await processGenerationQueue(pool,{maxJobs:6});
  const accounts=await recordAccountRuns(startedAt);
  const result={ok:true,queue,generation,accounts,finished_at:new Date().toISOString()};
  console.log(`[CREATIVE PRODUCTION] briefs=${queue.processed||0} promoted=${queue.promoted||0} generated=${generation.processed||0} accounts=${accounts}`);
  return result;
 }catch(e){
  console.error('[CREATIVE PRODUCTION]',e);
  return{ok:false,error:String(e.message||e)};
 }finally{busy=false}
}

function startCreativeProductionWorker(){
 if(!pool){console.warn('[CREATIVE PRODUCTION] DATABASE_URL unavailable');return null}
 setTimeout(run,20000);
 timer=setInterval(run,INTERVAL_MS);
 console.log(`[CREATIVE PRODUCTION] online | interval=${INTERVAL_MS/60000}m`);
 return{run,stop:async()=>{if(timer)clearInterval(timer);await pool.end().catch(()=>{})}};
}

module.exports={startCreativeProductionWorker,runCreativeProduction:run};
