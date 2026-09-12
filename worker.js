const {Pool}=require('pg');
const DATABASE_URL=process.env.DATABASE_URL||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
const INTERVAL_MS=Math.max(5,Number(process.env.WORKER_INTERVAL_MINUTES||15))*60*1000;
if(!DATABASE_URL){console.error('DOMINANCE worker requires DATABASE_URL');process.exit(1)}
const pool=new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false});

async function ensure(){
 await pool.query(`CREATE TABLE IF NOT EXISTS dominance_worker_state(worker_key TEXT PRIMARY KEY,last_heartbeat_at TIMESTAMPTZ,last_run_at TIMESTAMPTZ,status TEXT,details JSONB NOT NULL DEFAULT '{}'::jsonb)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS dominance_scan_runs(id BIGSERIAL PRIMARY KEY,account_id BIGINT NOT NULL REFERENCES dominance_accounts(id) ON DELETE CASCADE,scan_type TEXT NOT NULL,source_key TEXT,status TEXT NOT NULL,summary JSONB NOT NULL DEFAULT '{}'::jsonb,started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ)`);
}
async function heartbeat(status='idle',details={}){await pool.query(`INSERT INTO dominance_worker_state(worker_key,last_heartbeat_at,last_run_at,status,details) VALUES('intelligence-worker',NOW(),NOW(),$1,$2::jsonb) ON CONFLICT(worker_key) DO UPDATE SET last_heartbeat_at=NOW(),last_run_at=NOW(),status=EXCLUDED.status,details=EXCLUDED.details`,[status,JSON.stringify(details)])}
async function runAccount(a){
 const c=await pool.query("SELECT provider_key,provider_name,status FROM dominance_connections WHERE account_id=$1 AND status IN ('connected','enabled')",[a.id]);
 const connected=c.rows;
 const summary={company:a.company_name,connected_sources:connected.map(x=>x.provider_key),message:''};
 if(!connected.length){summary.message='No live credentialed data sources are connected yet; worker preserved account state but did not fabricate a scan.';await pool.query("INSERT INTO dominance_scan_runs(account_id,scan_type,status,summary,completed_at) VALUES($1,'intelligence-cycle','waiting_for_sources',$2::jsonb,NOW())",[a.id,JSON.stringify(summary)]);return 'waiting'}
 summary.message='Connected sources detected. Connector-specific sync handlers will execute as credentials are activated.';
 await pool.query("INSERT INTO dominance_scan_runs(account_id,scan_type,status,summary,completed_at) VALUES($1,'intelligence-cycle','ready',$2::jsonb,NOW())",[a.id,JSON.stringify(summary)]);
 return 'ready';
}
async function cycle(){
 try{await heartbeat('running',{started_at:new Date().toISOString()});const r=await pool.query('SELECT id,company_name,website,industry_key FROM dominance_accounts ORDER BY updated_at DESC');let ready=0,waiting=0;for(const a of r.rows){const s=await runAccount(a);if(s==='ready')ready++;else waiting++}await heartbeat('idle',{accounts_checked:r.rows.length,accounts_ready:ready,waiting_for_sources:waiting,next_cycle_minutes:INTERVAL_MS/60000});console.log('DOMINANCE worker cycle complete',{accounts:r.rows.length,ready,waiting})}catch(e){console.error('DOMINANCE worker cycle failed',e);await heartbeat('error',{error:String(e.message||e)}).catch(()=>{})}}
(async()=>{await ensure();await cycle();setInterval(cycle,INTERVAL_MS);console.log('DOMINANCE Intelligence Worker online. Interval minutes:',INTERVAL_MS/60000)})().catch(e=>{console.error(e);process.exit(1)});
process.on('SIGTERM',async()=>{await pool.end().catch(()=>{});process.exit(0)});
