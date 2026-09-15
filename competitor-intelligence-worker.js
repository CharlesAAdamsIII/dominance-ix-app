const core=require('./competitor-intelligence-core');
const {discoverLiveCompetitors}=require('./competitor-discovery');
const {monitorCompetitorRanks}=require('./competitor-rank-monitor');
const {processPaidAndLocalChanges}=require('./competitor-response-engine');
const {monitorGoogleBusinessProfiles}=require('./competitor-listing-monitor');
const {monitorGoogleAdsTransparency}=require('./competitor-google-ads-monitor');
const {processCompetitorSeoEvents}=require('./competitor-seo-event-engine');
const {reconcileCompetitorLifecycle}=require('./competitor-lifecycle');
const refreshQueue=require('./competitor-refresh-queue');
const cp=require('./control-plane-core');
const pool=core.makePool();
const INTERVAL_MS=Math.max(15,Number(process.env.COMPETITOR_INTELLIGENCE_INTERVAL_MINUTES||30))*60*1000;
const REFRESH_QUEUE_MS=Math.max(1,Number(process.env.COMPETITOR_REFRESH_QUEUE_MINUTES||1))*60*1000;
let timer=null,queueTimer=null,busy=false;

async function processAccount(account,{force=false}={}){const started=new Date();const result={};try{
 result.discovery=await discoverLiveCompetitors(pool,account,{force});
 result.ranks=await monitorCompetitorRanks(pool,account,{force});
 result.competitive_responses=await processPaidAndLocalChanges(pool,account);
 result.sites=await core.crawlSites(pool,account,force);
 result.google_business_profiles=await monitorGoogleBusinessProfiles(pool,account,{force});
 result.seo_events=await processCompetitorSeoEvents(pool,account);
 result.google_ads=await monitorGoogleAdsTransparency(pool,account,{force});
 result.recommendations=await core.generateEventRecommendations(pool,account);
 result.lifecycle=await reconcileCompetitorLifecycle(pool,account);
 await cp.recordWorkerAccountRun(pool,'competitor-intelligence-worker',account.id,'completed',result,started).catch(()=>{});
 return result;
}catch(e){await cp.recordWorkerAccountRun(pool,'competitor-intelligence-worker',account.id,'error',{error:e.message,...result},started).catch(()=>{});throw e}}

async function runCompetitorIntelligence({accountId=null,force=false}={}){if(!pool||busy)return{ok:false,busy};busy=true;try{await core.ensureSchema(pool);await refreshQueue.ensureRefreshQueue(pool);await cp.ensureControlPlaneSchema(pool);const params=[],where=accountId?'WHERE id=$1 AND is_active=TRUE':'WHERE is_active=TRUE';if(accountId)params.push(accountId);const r=await pool.query(`SELECT id,account_key,company_name,website,industry_key,industry_name,analysis FROM dominance_accounts ${where} ORDER BY updated_at DESC`,params),results=[];for(const a of r.rows){try{results.push({account_id:a.id,...await processAccount(a,{force})})}catch(e){results.push({account_id:a.id,error:e.message})}}await pool.query(`INSERT INTO dominance_worker_state(worker_key,last_heartbeat_at,last_run_at,status,details) VALUES('competitor-intelligence-worker',NOW(),NOW(),'online',$1::jsonb) ON CONFLICT(worker_key) DO UPDATE SET last_heartbeat_at=NOW(),last_run_at=NOW(),status='online',details=EXCLUDED.details`,[JSON.stringify({accounts_expected:r.rowCount,accounts_processed:results.length,results})]).catch(()=>{});return{ok:true,results}}catch(e){console.error('[COMPETITOR INTELLIGENCE]',e);return{ok:false,error:e.message}}finally{busy=false}}
async function runQueuedRefresh(){if(!pool||busy)return{ok:false,busy};await refreshQueue.ensureRefreshQueue(pool);const job=await refreshQueue.claimRefresh(pool);if(!job)return{ok:true,queued:false};busy=true;try{await core.ensureSchema(pool);const r=await pool.query(`SELECT id,account_key,company_name,website,industry_key,industry_name,analysis FROM dominance_accounts WHERE id=$1 AND is_active=TRUE LIMIT 1`,[job.dominance_account_id]),account=r.rows[0];if(!account)throw Error('Requested competitor refresh account is not active.');const result=await processAccount(account,{force:true});await refreshQueue.completeRefresh(pool,account.id,result);await pool.query(`INSERT INTO dominance_worker_state(worker_key,last_heartbeat_at,last_run_at,status,details) VALUES('competitor-intelligence-worker',NOW(),NOW(),'online',$1::jsonb) ON CONFLICT(worker_key) DO UPDATE SET last_heartbeat_at=NOW(),last_run_at=NOW(),status='online',details=EXCLUDED.details`,[JSON.stringify({manual_refresh_account_id:account.id,manual_refresh_completed_at:new Date().toISOString()})]).catch(()=>{});return{ok:true,queued:true,account_id:account.id}}catch(e){await refreshQueue.failRefresh(pool,job.dominance_account_id,e).catch(()=>{});console.error('[COMPETITOR REFRESH QUEUE]',e);return{ok:false,error:e.message}}finally{busy=false}}
function startCompetitorIntelligenceWorker(){if(!pool){console.warn('[COMPETITOR INTELLIGENCE] DATABASE_URL unavailable');return null}refreshQueue.ensureRefreshQueue(pool).catch(()=>{});setTimeout(()=>runCompetitorIntelligence(),16000);setTimeout(()=>runQueuedRefresh(),30000);timer=setInterval(()=>runCompetitorIntelligence(),INTERVAL_MS);queueTimer=setInterval(()=>runQueuedRefresh(),REFRESH_QUEUE_MS);console.log(`[COMPETITOR INTELLIGENCE] online | interval=${INTERVAL_MS/60000}m | refresh_queue=${REFRESH_QUEUE_MS/60000}m`);return{run:runCompetitorIntelligence,runQueuedRefresh,stop:()=>{if(timer)clearInterval(timer);if(queueTimer)clearInterval(queueTimer);return pool.end().catch(()=>{})}}}
module.exports={startCompetitorIntelligenceWorker,runCompetitorIntelligence,runQueuedRefresh};
