const core=require('./competitor-intelligence-core');
const cp=require('./control-plane-core');
const pool=core.makePool();
const INTERVAL_MS=Math.max(15,Number(process.env.COMPETITOR_INTELLIGENCE_INTERVAL_MINUTES||30))*60*1000;
let timer=null,busy=false;

async function processAccount(account,{force=false}={}){const started=new Date();const result={};try{
 result.discovery=await core.discoverCompetitors(pool,account,force);
 result.ranks=await core.trackRanks(pool,account,force);
 result.sites=await core.crawlSites(pool,account,force);
 result.google_ads=await core.trackGoogleAdsTransparency(pool,account,force);
 result.recommendations=await core.generateEventRecommendations(pool,account);
 await cp.recordWorkerAccountRun(pool,'competitor-intelligence-worker',account.id,'completed',result,started).catch(()=>{});
 return result;
}catch(e){await cp.recordWorkerAccountRun(pool,'competitor-intelligence-worker',account.id,'error',{error:e.message,...result},started).catch(()=>{});throw e}}

async function runCompetitorIntelligence({accountId=null,force=false}={}){if(!pool||busy)return{ok:false,busy};busy=true;try{await core.ensureSchema(pool);await cp.ensureControlPlaneSchema(pool);const params=[],where=accountId?'WHERE id=$1 AND is_active=TRUE':'WHERE is_active=TRUE';if(accountId)params.push(accountId);const r=await pool.query(`SELECT id,account_key,company_name,website,industry_key,industry_name,analysis FROM dominance_accounts ${where} ORDER BY updated_at DESC`,params),results=[];for(const a of r.rows){try{results.push({account_id:a.id,...await processAccount(a,{force})})}catch(e){results.push({account_id:a.id,error:e.message})}}await pool.query(`INSERT INTO dominance_worker_state(worker_key,last_heartbeat_at,last_run_at,status,details) VALUES('competitor-intelligence-worker',NOW(),NOW(),'online',$1::jsonb) ON CONFLICT(worker_key) DO UPDATE SET last_heartbeat_at=NOW(),last_run_at=NOW(),status='online',details=EXCLUDED.details`,[JSON.stringify({accounts_expected:r.rowCount,accounts_processed:results.length,results})]).catch(()=>{});return{ok:true,results}}catch(e){console.error('[COMPETITOR INTELLIGENCE]',e);return{ok:false,error:e.message}}finally{busy=false}}
function startCompetitorIntelligenceWorker(){if(!pool){console.warn('[COMPETITOR INTELLIGENCE] DATABASE_URL unavailable');return null}setTimeout(()=>runCompetitorIntelligence(),16000);timer=setInterval(()=>runCompetitorIntelligence(),INTERVAL_MS);console.log(`[COMPETITOR INTELLIGENCE] online | interval=${INTERVAL_MS/60000}m`);return{run:runCompetitorIntelligence,stop:()=>{if(timer)clearInterval(timer);return pool.end().catch(()=>{})}}}
module.exports={startCompetitorIntelligenceWorker,runCompetitorIntelligence};
