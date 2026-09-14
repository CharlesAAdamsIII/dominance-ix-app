const {Pool}=require('pg');
const {build,VERSION}=require('./profile-engine');

const DATABASE_URL=process.env.DATABASE_URL||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
const INTERVAL_MS=Math.max(5,Number(process.env.PROFILE_WORKER_INTERVAL_MINUTES||15))*60*1000;
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false}):null;
let timer=null,busy=false;

async function profileAccounts(){
  if(!pool||busy)return{checked:0,updated:0};
  busy=true;
  let checked=0,updated=0;
  try{
    const r=await pool.query('SELECT id,company_name,website,industry_key,industry_name,analysis FROM dominance_accounts WHERE is_active=TRUE ORDER BY updated_at DESC');
    for(const a of r.rows){
      checked++;
      const analysis=a.analysis||{},existing=analysis.business_profile||{};
      if(existing.locked===true)continue;
      if(existing.version===VERSION&&analysis.recommended_connections&&analysis.market_signal_packs&&analysis.market_radar_config)continue;
      const adaptive=build(a);
      const nextAnalysis={...analysis,...adaptive};
      await pool.query('UPDATE dominance_accounts SET industry_key=$1,industry_name=$2,analysis=$3::jsonb,updated_at=NOW() WHERE id=$4',[adaptive.business_profile.industry_key||a.industry_key,adaptive.business_profile.industry_name||a.industry_name,JSON.stringify(nextAnalysis),a.id]);
      await pool.query("INSERT INTO dominance_activity(account_id,event_type,module,details) VALUES($1,'business_profile_updated','intelligence-worker',$2::jsonb)",[a.id,JSON.stringify({profile_version:VERSION,category:adaptive.business_profile.category,confidence:adaptive.business_profile.confidence,recommended_connections:adaptive.recommended_connections.map(x=>x.key),signal_packs:adaptive.market_signal_packs.map(x=>x.key)})]).catch(()=>{});
      updated++;
      console.log(`[BUSINESS PROFILE] ${a.company_name} -> ${adaptive.business_profile.label} | confidence=${adaptive.business_profile.confidence}`);
    }
    return{checked,updated};
  }catch(e){
    console.error('[BUSINESS PROFILE] cycle error:',e.message||e);
    return{checked,updated,error:String(e.message||e)};
  }finally{busy=false}
}

function startBusinessProfileWorker(){
  if(!pool){console.warn('[BUSINESS PROFILE] DATABASE_URL unavailable; profiler worker disabled');return null}
  setTimeout(profileAccounts,4000);
  timer=setInterval(profileAccounts,INTERVAL_MS);
  console.log(`[BUSINESS PROFILE] worker online | interval=${INTERVAL_MS/60000}m | version=${VERSION}`);
  return{stop:()=>{if(timer)clearInterval(timer);return pool.end().catch(()=>{})},run:profileAccounts};
}

module.exports={startBusinessProfileWorker,profileAccounts};
