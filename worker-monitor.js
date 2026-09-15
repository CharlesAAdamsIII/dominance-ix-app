const {spawn}=require('child_process');
const {Pool}=require('pg');
const {processCreativeQueue}=require('./creative-queue');
const {processGenerationQueue}=require('./creative-generation');
const {syncPublicData}=require('./public-data');
const {runCreativeSmokeTest}=require('./creative-smoke-test');
const cp=require('./control-plane-core');

const DATABASE_URL=process.env.DATABASE_URL||'';
const CREATIVE_INTERVAL_MS=Math.max(1,Number(process.env.CREATIVE_QUEUE_INTERVAL_MINUTES||1))*60*1000;
const PUBLIC_DATA_INTERVAL_MS=Math.max(1,Number(process.env.PUBLIC_DATA_REFRESH_HOURS||24))*3600000;
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false}):null;
let lastRunId=null,creativeBusy=false,generationBusy=false,publicDataBusy=false,smokeBusy=false;

async function inspectLatest(){if(!pool)return;try{const r=await pool.query(`SELECT id,account_id,status,completed_at FROM dominance_scan_runs WHERE scan_type='intelligence-cycle' ORDER BY id DESC LIMIT 1`),row=r.rows[0];if(!row||row.id===lastRunId)return;lastRunId=row.id;console.log(`[SOURCE HEALTH] run=${row.id} customer=${row.account_id} status=${row.status} completed=${row.completed_at||''}`)}catch(e){console.error('[SOURCE HEALTH]',e.message||e)}}
async function runCreativeQueue(){if(!pool||creativeBusy)return;creativeBusy=true;const started=new Date();try{const x=await processCreativeQueue(pool,{maxJobs:5});await cp.recordWorkerAccountRun(pool,'creative-queue',null,'completed',x,started);if(x.processed||x.promoted)console.log(`[CREATIVE QUEUE] briefs=${x.processed} promoted=${x.promoted}`)}catch(e){await cp.recordWorkerAccountRun(pool,'creative-queue',null,'error',{error:e.message},started).catch(()=>{});console.error('[CREATIVE QUEUE]',e.message||e)}finally{creativeBusy=false}}
async function runGenerationQueue(){if(!pool||generationBusy)return;generationBusy=true;const started=new Date();try{const x=await processGenerationQueue(pool,{maxJobs:2});await cp.recordWorkerAccountRun(pool,'creative-generation',null,'completed',x,started);if(x.processed)console.log(`[CREATIVE GENERATION] requests=${x.processed}`)}catch(e){await cp.recordWorkerAccountRun(pool,'creative-generation',null,'error',{error:e.message},started).catch(()=>{});console.error('[CREATIVE GENERATION]',e.message||e)}finally{generationBusy=false}}
async function syncPublicSources(){if(!pool||publicDataBusy)return;publicDataBusy=true;try{const accounts=await pool.query('SELECT id,company_name,website,industry_key,industry_name,analysis FROM dominance_accounts WHERE is_active=TRUE ORDER BY id');for(const a of accounts.rows){const started=new Date();try{const results=await syncPublicData(pool,a);await pool.query(`INSERT INTO dominance_activity(account_id,event_type,module,details) VALUES($1,'public_intelligence_sync','market_intelligence',$2::jsonb)`,[a.id,JSON.stringify({synced_at:new Date().toISOString(),results})]);await cp.recordWorkerAccountRun(pool,'market-public-sweep',a.id,'completed',{results},started)}catch(e){await cp.recordWorkerAccountRun(pool,'market-public-sweep',a.id,'error',{error:e.message},started).catch(()=>{});console.error(`[PUBLIC DATA] customer=${a.id}`,e.message||e)}}console.log(`[PUBLIC DATA] swept ${accounts.rowCount} active customers`)}catch(e){console.error('[PUBLIC DATA]',e.message||e)}finally{publicDataBusy=false}}
async function runSmokeTest(){if(!pool||smokeBusy)return;smokeBusy=true;try{const x=await runCreativeSmokeTest(pool);if(x?.enabled)console.log(`[SMOKE TEST] status=${x.status||'unknown'}`)}catch(e){console.error('[SMOKE TEST]',e.message||e)}finally{smokeBusy=false}}

// The core intelligence worker already processes every active customer, including DataForSEO.
// Do not strip its credentials and do not run a duplicate LIMIT 1 DataForSEO path here.
const child=spawn(process.execPath,['worker.js'],{stdio:'inherit',env:{...process.env}});
child.on('exit',async(code,signal)=>{console.error(`DOMINANCE intelligence worker exited code=${code} signal=${signal||''}`);if(pool)await pool.end().catch(()=>{});process.exit(code??1)});
child.on('error',e=>console.error('Unable to start DOMINANCE intelligence worker:',e));
setTimeout(inspectLatest,8000);setTimeout(runCreativeQueue,10000);setTimeout(runGenerationQueue,11000);setTimeout(syncPublicSources,15000);setTimeout(runSmokeTest,20000);
const healthTimer=setInterval(inspectLatest,30000),creativeTimer=setInterval(runCreativeQueue,CREATIVE_INTERVAL_MS),generationTimer=setInterval(runGenerationQueue,CREATIVE_INTERVAL_MS),publicTimer=setInterval(syncPublicSources,PUBLIC_DATA_INTERVAL_MS),smokeTimer=setInterval(runSmokeTest,CREATIVE_INTERVAL_MS);
async function shutdown(signal){clearInterval(healthTimer);clearInterval(creativeTimer);clearInterval(generationTimer);clearInterval(publicTimer);clearInterval(smokeTimer);child.kill(signal);if(pool)await pool.end().catch(()=>{});setTimeout(()=>process.exit(0),500)}
process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));
