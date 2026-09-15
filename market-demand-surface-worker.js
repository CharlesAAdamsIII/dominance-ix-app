const mi=require('./market-intelligence-core');
const cp=require('./control-plane-core');
const {refreshNationalDemandSurface}=require('./market-demand-surface');
const pool=mi.makePool();
const INTERVAL_MS=Math.max(30,Number(process.env.DEMAND_SURFACE_INTERVAL_MINUTES||60))*60*1000;
let timer=null,busy=false;
async function ensureSnapshotSchema(){await pool.query(`CREATE TABLE IF NOT EXISTS dominance_market_snapshots(
 id BIGSERIAL PRIMARY KEY,
 account_id BIGINT NOT NULL REFERENCES dominance_accounts(id) ON DELETE CASCADE,
 geography_key TEXT NOT NULL,
 geography_name TEXT NOT NULL,
 geography_type TEXT NOT NULL DEFAULT 'city',
 region TEXT,
 country TEXT,
 source_key TEXT NOT NULL,
 observed_volume NUMERIC NOT NULL DEFAULT 0,
 search_volume NUMERIC,
 prior_volume NUMERIC,
 velocity_pct NUMERIC,
 acceleration_pct NUMERIC,
 opportunity_score NUMERIC NOT NULL DEFAULT 0,
 confidence NUMERIC NOT NULL DEFAULT 0,
 signal_state TEXT NOT NULL DEFAULT 'baseline',
 metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
 captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`);await pool.query(`CREATE INDEX IF NOT EXISTS idx_dom_market_account_geo_time ON dominance_market_snapshots(account_id,geography_key,captured_at DESC)`);await pool.query(`CREATE INDEX IF NOT EXISTS idx_dom_market_account_time ON dominance_market_snapshots(account_id,captured_at DESC)`)}
async function run(){if(!pool||busy)return{ok:false};busy=true;try{await mi.ensureSchema(pool);await ensureSnapshotSchema();const r=await pool.query(`SELECT id,account_key,company_name,website,industry_key,industry_name,analysis FROM dominance_accounts WHERE is_active=TRUE ORDER BY id`),results=[];for(const a of r.rows){const startedAt=new Date().toISOString();try{const result=await refreshNationalDemandSurface(pool,a);results.push({account_id:a.id,...result});await cp.recordWorkerAccountRun(pool,'market-demand-surface-worker',a.id,result.status==='synced'||result.status==='fresh'?'completed':result.status,{...result},startedAt).catch(()=>{})}catch(e){const result={account_id:a.id,status:'error',error:e.message};results.push(result);await cp.recordWorkerAccountRun(pool,'market-demand-surface-worker',a.id,'error',result,startedAt).catch(()=>{})}}await pool.query(`INSERT INTO dominance_worker_state(worker_key,last_heartbeat_at,last_run_at,status,details) VALUES('market-demand-surface-worker',NOW(),NOW(),'online',$1::jsonb) ON CONFLICT(worker_key) DO UPDATE SET last_heartbeat_at=NOW(),last_run_at=NOW(),status='online',details=EXCLUDED.details`,[JSON.stringify({accounts:r.rowCount,results})]).catch(()=>{});return{ok:true,results}}catch(e){console.error('[DEMAND SURFACE]',e);return{ok:false,error:e.message}}finally{busy=false}}
function startMarketDemandSurfaceWorker(){if(!pool){console.warn('[DEMAND SURFACE] DATABASE_URL unavailable');return null}setTimeout(run,7000);timer=setInterval(run,INTERVAL_MS);console.log(`[DEMAND SURFACE] online | interval=${INTERVAL_MS/60000}m`);return{run,stop:()=>{if(timer)clearInterval(timer);return pool.end().catch(()=>{})}}}
module.exports={startMarketDemandSurfaceWorker,runMarketDemandSurface:run};
