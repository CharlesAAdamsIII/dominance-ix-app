const cp=require('./control-plane-core');
const pool=cp.makePool();
const INTERVAL_MS=Math.max(1,Number(process.env.CONTROL_PLANE_INTERVAL_MINUTES||5))*60*1000;
let busy=false,timer=null;
async function runControlPlane(){if(!pool||busy)return{ok:false};busy=true;try{const result=await cp.runIntegrityCycle(pool);console.log(`[CONTROL PLANE] ${result.status.toUpperCase()} | integrity=${result.score} | customers=${result.summary.accounts_processed}/${result.summary.accounts_expected} | alerts=${result.summary.open_alerts}`);return{ok:true,...result}}catch(e){console.error('[CONTROL PLANE]',e);return{ok:false,error:e.message}}finally{busy=false}}
function startControlPlaneWorker(){if(!pool){console.warn('[CONTROL PLANE] DATABASE_URL unavailable');return null}setTimeout(runControlPlane,12000);timer=setInterval(runControlPlane,INTERVAL_MS);console.log(`[CONTROL PLANE] online | interval=${INTERVAL_MS/60000}m | version=${cp.CONTROL_PLANE_VERSION}`);return{run:runControlPlane,stop:()=>{if(timer)clearInterval(timer);return pool.end().catch(()=>{})}}}
module.exports={startControlPlaneWorker,runControlPlane};