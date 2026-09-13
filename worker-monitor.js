const {spawn}=require('child_process');
const {Pool}=require('pg');

const DATABASE_URL=process.env.DATABASE_URL||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false}):null;
let lastRunId=null;

function printResult(x){
 const provider=x?.provider||'UNKNOWN';
 const status=String(x?.status||'unknown').toUpperCase();
 const markets=Number(x?.market_radar?.markets||0);
 const suffix=markets?` | market signals: ${markets}`:'';
 if(x?.error) console.error(`[SOURCE] ${provider} ${status}${suffix} | ${x.error}`);
 else console.log(`[SOURCE] ${provider} ${status}${suffix}`);
}

async function inspectLatest(){
 if(!pool)return;
 try{
   const r=await pool.query(`SELECT id,account_id,status,summary,completed_at FROM dominance_scan_runs WHERE scan_type='intelligence-cycle' ORDER BY id DESC LIMIT 1`);
   const row=r.rows[0];
   if(!row||row.id===lastRunId)return;
   lastRunId=row.id;
   const summary=row.summary||{};
   console.log(`\n[DOMINANCE SOURCE HEALTH] run=${row.id} status=${row.status} company=${summary.company||'unknown'} completed=${row.completed_at||''}`);
   for(const result of summary.results||[])printResult(result);
   console.log(`[DOMINANCE SOURCE HEALTH] synced=${summary.synced??0} awaiting=${summary.awaiting_resource_selection??0} errors=${summary.errors??0}\n`);
 }catch(e){console.error('[DOMINANCE SOURCE HEALTH] monitor error:',e.message||e)}
}

const child=spawn(process.execPath,['worker.js'],{stdio:'inherit',env:process.env});
child.on('exit',async(code,signal)=>{console.error(`DOMINANCE worker exited code=${code} signal=${signal||''}`);if(pool)await pool.end().catch(()=>{});process.exit(code??1)});
child.on('error',e=>console.error('Unable to start DOMINANCE worker:',e));

setTimeout(inspectLatest,8000);
const timer=setInterval(inspectLatest,30000);

async function shutdown(signal){clearInterval(timer);child.kill(signal);if(pool)await pool.end().catch(()=>{});setTimeout(()=>process.exit(0),500)}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
