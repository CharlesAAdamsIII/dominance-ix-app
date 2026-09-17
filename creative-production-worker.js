const {Pool}=require('pg');
const cp=require('./control-plane-core');
const {processCreativeQueue}=require('./creative-queue');
const {processGenerationQueue}=require('./creative-generation');

const DATABASE_URL=process.env.DATABASE_URL||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
const INTERVAL_MS=Math.max(1,Number(process.env.CREATIVE_PRODUCTION_INTERVAL_MINUTES||1))*60*1000;
const OPENAI_CONFIGURED=!!String(process.env.OPENAI_API_KEY||'').trim();
const TEXT_MODEL=process.env.OPENAI_TEXT_MODEL||'gpt-5.6-terra';
const IMAGE_MODEL=process.env.OPENAI_IMAGE_MODEL||'gpt-image-2';
const VIDEO_MODEL=process.env.OPENAI_VIDEO_MODEL||'';
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false}):null;
let timer=null,busy=false;

async function accountPipelineState(accountId){
 const [requests,assets]=await Promise.all([
  pool.query(`SELECT status,COUNT(*)::int n,MAX(COALESCE(completed_at,claimed_at,created_at)) last_at FROM dominance_creative_requests WHERE dominance_account_id=$1 GROUP BY status`,[accountId]).catch(()=>({rows:[]})),
  pool.query(`SELECT status,COUNT(*)::int n,MAX(updated_at) last_at FROM dominance_generated_assets WHERE dominance_account_id=$1 GROUP BY status`,[accountId]).catch(()=>({rows:[]}))
 ]);
 const req={};for(const r of requests.rows)req[r.status]=Number(r.n||0);
 const ast={};for(const r of assets.rows)ast[r.status]=Number(r.n||0);
 const err=await pool.query(`SELECT id,asset_category,platform,status,last_error,COALESCE(completed_at,claimed_at,created_at) last_at FROM dominance_creative_requests WHERE dominance_account_id=$1 AND last_error IS NOT NULL ORDER BY COALESCE(completed_at,claimed_at,created_at) DESC LIMIT 3`,[accountId]).catch(()=>({rows:[]}));
 return{requests:req,assets:ast,recent_errors:err.rows,provider:{openai_configured:OPENAI_CONFIGURED,text_model:TEXT_MODEL,image_model:IMAGE_MODEL,video_model:VIDEO_MODEL||null}};
}

async function recordAccountRuns(startedAt,generation){
 const accounts=await pool.query(`SELECT id FROM dominance_accounts WHERE is_active=TRUE ORDER BY id`);
 for(const a of accounts.rows){
  const details=await accountPipelineState(a.id);
  details.generation_cycle=generation;
  const hasFailures=Number(details.requests.failed||0)>0||details.recent_errors.length>0;
  const status=!OPENAI_CONFIGURED?'waiting_for_credentials':hasFailures?'partial_error':'completed';
  await cp.recordWorkerAccountRun(pool,'creative-queue',a.id,'completed',details,startedAt).catch(()=>{});
  await cp.recordWorkerAccountRun(pool,'creative-generation',a.id,status,details,startedAt).catch(()=>{});
  await cp.recordWorkerAccountRun(pool,'creative-production-worker',a.id,status,details,startedAt).catch(()=>{});
 }
 return accounts.rowCount;
}

async function run(){
 if(!pool||busy)return{ok:false,reason:!pool?'database_unavailable':'busy'};
 busy=true;const startedAt=new Date();
 try{
  const queue=await processCreativeQueue(pool,{maxJobs:12});
  const generation=await processGenerationQueue(pool,{maxJobs:6});
  const accounts=await recordAccountRuns(startedAt,generation);
  const result={ok:true,queue,generation,accounts,finished_at:new Date().toISOString()};
  const block=generation.blocked_reason?` block=${generation.blocked_reason}`:'';
  const errs=generation.errors?.length?` errors=${generation.errors.length}`:'';
  console.log(`[CREATIVE PRODUCTION] briefs=${queue.processed||0} promoted=${queue.promoted||0} generated=${generation.processed||0} attempted=${generation.attempted||0} recovered=${generation.recovered||0} accounts=${accounts}${block}${errs}`);
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
 console.log(`[CREATIVE PRODUCTION] online | interval=${INTERVAL_MS/60000}m | openai=${OPENAI_CONFIGURED?'configured':'MISSING'} | text=${TEXT_MODEL} | image=${IMAGE_MODEL} | video=${VIDEO_MODEL||'unconfigured'}`);
 return{run,stop:async()=>{if(timer)clearInterval(timer);await pool.end().catch(()=>{})}};
}

module.exports={startCreativeProductionWorker,runCreativeProduction:run};
