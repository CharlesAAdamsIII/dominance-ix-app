'use strict';

const {Pool}=require('pg');
const gateway=require('./execution-gateway-core');
const google=require('./google-ads-write-adapter');
const cp=require('./control-plane-core');

const DATABASE_URL=process.env.DATABASE_URL||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
const INTERVAL_MS=Math.max(1,Number(process.env.PLATFORM_EXECUTION_INTERVAL_MINUTES||1))*60*1000;
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false}):null;
let timer=null,busy=false;

async function claim(){
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const r=await c.query(`SELECT * FROM dominance_ad_execution_queue
      WHERE status='queued' AND action->>'execution_gateway_version'='1.0.0' AND attempts<3
      ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`);
    const q=r.rows[0];
    if(!q){await c.query('COMMIT');return null}
    await c.query(`UPDATE dominance_ad_execution_queue SET status='executing',claimed_at=NOW(),attempts=attempts+1,last_error=NULL WHERE id=$1`,[q.id]);
    await c.query('COMMIT');
    return q;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
}

async function processOne(queue){
  const rr=await pool.query('SELECT * FROM dominance_ad_recommendations WHERE id=$1 AND dominance_account_id=$2',[queue.recommendation_id,queue.dominance_account_id]);
  const recommendation=rr.rows[0];if(!recommendation)throw Error('Recommendation no longer exists.');
  const ar=await pool.query('SELECT * FROM dominance_accounts WHERE id=$1',[queue.dominance_account_id]);
  const account=ar.rows[0];if(!account)throw Error('Customer account no longer exists.');
  const verification=await cp.verifyRecommendationForExecution(pool,recommendation,account);
  if(!verification.allowed)throw Error('Control Plane blocked execution: '+verification.violations.map(x=>x.message).join(' | '));
  const build=await gateway.prepareBuild(pool,recommendation,account);
  if(build.status!=='execution_ready')throw Error('Execution build is not ready: '+(build.validation?.errors||[]).join(' | ')+(build.status==='validated_no_connector'?' | write adapter unavailable':''));
  let result;
  if(build.platform==='Google Ads')result=await google.execute(pool,{account,spec:build.spec});
  else throw Error('No physical write adapter is enabled for '+build.platform+'.');
  if(build.operation==='launch_campaign'&&build.spec?.campaign_entity_id&&result?.campaign_resource){
    const externalId=String(result.campaign_resource).split('/').pop(),googleStatus=String(result.readback?.campaign?.status||build.spec.campaign?.status||'PAUSED').toUpperCase(),localStatus=googleStatus==='ENABLED'?'live':'paused';
    const adAccount=await pool.query(`SELECT id FROM dominance_ad_accounts WHERE dominance_account_id=$1 AND platform='Google Ads' AND external_account_id=$2 ORDER BY updated_at DESC LIMIT 1`,[account.id,String(result.customer_id)]).catch(()=>({rows:[]}));
    await pool.query(`UPDATE dominance_campaign_entities SET external_id=$2,status=$3,ad_account_id=COALESCE($4,ad_account_id),last_synced_at=NOW(),settings=settings||$5::jsonb,updated_at=NOW() WHERE id=$1 AND dominance_account_id=$6`,[build.spec.campaign_entity_id,externalId,localStatus,adAccount.rows[0]?.id||null,JSON.stringify({platform_resource_name:result.campaign_resource,last_execution_queue_id:queue.id,last_execution_at:new Date().toISOString(),google_status:googleStatus}),account.id]);
  }
  await gateway.recordReceipt(pool,{queue,recommendation,account,status:'completed',request:{build_id:build.id,spec:build.spec},response:result});
  await pool.query(`UPDATE dominance_ad_execution_queue SET status='completed',completed_at=NOW(),last_error=NULL WHERE id=$1`,[queue.id]);
  await pool.query(`UPDATE dominance_execution_builds SET status='executed',updated_at=NOW() WHERE recommendation_id=$1`,[recommendation.id]);
  await pool.query(`UPDATE dominance_ad_recommendations SET status='monitoring',executed_at=NOW(),updated_at=NOW() WHERE id=$1`,[recommendation.id]);
  await pool.query(`INSERT INTO dominance_activity(account_id,event_type,module,details) VALUES($1,'platform_execution_completed','platform_execution',$2::jsonb)`,[account.id,JSON.stringify({queue_id:queue.id,recommendation_id:recommendation.id,platform:build.platform,operation:build.operation})]).catch(()=>{});
  console.log('[PLATFORM EXECUTION] completed queue='+queue.id+' recommendation='+recommendation.id+' platform='+build.platform+' operation='+build.operation);
  return{ok:true,queue_id:queue.id,recommendation_id:recommendation.id,platform:build.platform,operation:build.operation};
}

async function fail(queue,error){
  const msg=String(error?.message||error).slice(0,3000);
  const r=await pool.query(`UPDATE dominance_ad_execution_queue SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,last_error=$2 WHERE id=$1 RETURNING status,attempts`,[queue.id,msg]);
  const recommendation=(await pool.query('SELECT * FROM dominance_ad_recommendations WHERE id=$1',[queue.recommendation_id]).catch(()=>({rows:[]}))).rows[0];
  const account=(await pool.query('SELECT * FROM dominance_accounts WHERE id=$1',[queue.dominance_account_id]).catch(()=>({rows:[]}))).rows[0];
  await gateway.recordReceipt(pool,{queue,recommendation,account,status:r.rows[0]?.status||'failed',request:{action:queue.action},error:msg}).catch(()=>{});
  if(r.rows[0]?.status==='failed')await pool.query(`UPDATE dominance_ad_recommendations SET status='execution_failed',updated_at=NOW(),actual_outcome=actual_outcome||$2::jsonb WHERE id=$1`,[queue.recommendation_id,JSON.stringify({execution_error:msg})]).catch(()=>{});
  console.error('[PLATFORM EXECUTION] queue='+queue.id+' error='+msg+' status='+(r.rows[0]?.status||'unknown'));
  return{ok:false,queue_id:queue.id,error:msg,status:r.rows[0]?.status||'failed'};
}

async function runPlatformExecution(){
  if(!pool||busy)return{ok:false,reason:!pool?'database_unavailable':'busy'};
  busy=true;const started=new Date(),results=[];
  try{
    await gateway.ensureSchema(pool);
    for(let i=0;i<5;i++){
      const q=await claim();if(!q)break;
      try{results.push(await processOne(q))}catch(e){results.push(await fail(q,e))}
    }
    const accounts=await pool.query('SELECT id FROM dominance_accounts WHERE is_active=TRUE ORDER BY id');
    for(const a of accounts.rows)await cp.recordWorkerAccountRun(pool,'platform-execution-worker',a.id,'completed',{processed:results.length,results},started).catch(()=>{});
    await pool.query(`INSERT INTO dominance_worker_state(worker_key,last_heartbeat_at,last_run_at,status,details)
      VALUES('platform-execution-worker',NOW(),NOW(),'online',$1::jsonb)
      ON CONFLICT(worker_key) DO UPDATE SET last_heartbeat_at=NOW(),last_run_at=NOW(),status='online',details=EXCLUDED.details`,[JSON.stringify({processed:results.length,results})]).catch(()=>{});
    return{ok:true,processed:results.length,results};
  }catch(e){console.error('[PLATFORM EXECUTION]',e);return{ok:false,error:String(e.message||e)}}finally{busy=false}
}

function startPlatformExecutionWorker(){
  if(!pool){console.warn('[PLATFORM EXECUTION] DATABASE_URL unavailable');return null}
  setTimeout(runPlatformExecution,30000);timer=setInterval(runPlatformExecution,INTERVAL_MS);
  console.log('[PLATFORM EXECUTION] online | interval='+(INTERVAL_MS/60000)+'m | legacy queues protected');
  return{run:runPlatformExecution,stop:async()=>{if(timer)clearInterval(timer);await pool.end().catch(()=>{})}};
}

module.exports={startPlatformExecutionWorker,runPlatformExecution};
