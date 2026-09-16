const mi=require('./market-intelligence-core');
const cp=require('./control-plane-core');
const pool=mi.makePool();
const INTERVAL_MS=Math.max(10,Number(process.env.MARKET_REGIONAL_SNAPSHOT_INTERVAL_MINUTES||15))*60*1000;
let timer=null,busy=false;
const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number(v||0)));
function pct(cur,prev){if(prev<=0)return 0;return Math.max(-1000,Math.min(1000,((cur-prev)/prev)*100))}
async function ensureSnapshotSchema(){await pool.query(`CREATE TABLE IF NOT EXISTS dominance_market_snapshots(
 id BIGSERIAL PRIMARY KEY,
 account_id BIGINT NOT NULL REFERENCES dominance_accounts(id) ON DELETE CASCADE,
 geography_key TEXT NOT NULL,
 geography_name TEXT NOT NULL,
 geography_type TEXT NOT NULL DEFAULT 'state',
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
)`)}
async function materializeAccount(account){
 const kr=await pool.query(`SELECT phrase,priority,intent_score,evidence,last_researched_at FROM dominance_keyword_intelligence WHERE account_id=$1 AND active=TRUE AND evidence ? 'regional_scores' ORDER BY user_locked DESC,priority DESC,intent_score DESC LIMIT 5`,[account.id]);
 if(!kr.rowCount)return{status:'no_regional_keyword_evidence',markets:0};
 const freshRows=kr.rows.filter(k=>{const t=k.evidence?.regional_researched_at||k.last_researched_at;return t&&Date.now()-new Date(t).getTime()<=6*3600000});
 if(!freshRows.length)return{status:'regional_keyword_evidence_stale',markets:0};
 const newest=Math.max(...freshRows.map(k=>new Date(k.evidence?.regional_researched_at||k.last_researched_at).getTime()));
 const last=await pool.query(`SELECT MAX(captured_at) last_at FROM dominance_market_snapshots WHERE account_id=$1 AND source_key='DATAFORSEO_TRENDS_4H'`,[account.id]).catch(()=>({rows:[{}]}));
 if(last.rows[0]?.last_at&&new Date(last.rows[0].last_at).getTime()>=newest)return{status:'fresh',markets:0};
 const byRegion=new Map();
 for(const k of freshRows){const scores=k.evidence?.regional_scores||{},weight=Math.max(.2,(Number(k.priority||50)*.6+Number(k.intent_score||50)*.4)/100);for(const [name,valRaw] of Object.entries(scores)){const value=Number(valRaw||0);if(!name||!Number.isFinite(value))continue;const r=byRegion.get(name)||{name,weighted:0,weight:0,peak:0,values:{},count:0};r.weighted+=value*weight;r.weight+=weight;r.peak=Math.max(r.peak,value);r.values[k.phrase]=value;r.count++;byRegion.set(name,r)}}
 let inserted=0;
 for(const r of byRegion.values()){
  const avg=r.weight?r.weighted/r.weight:0,current=clamp(avg*.68+r.peak*.32),key=String(r.name).toLowerCase();
  const prev=await pool.query(`SELECT observed_volume,velocity_pct FROM dominance_market_snapshots WHERE account_id=$1 AND geography_key=$2 AND source_key='DATAFORSEO_TRENDS_4H' ORDER BY captured_at DESC LIMIT 1`,[account.id,key]).catch(()=>({rows:[],rowCount:0}));
  const prior=Number(prev.rows[0]?.observed_volume||0),velocity=prev.rowCount?pct(current,prior):0,oldVelocity=Number(prev.rows[0]?.velocity_pct||0),acceleration=prev.rowCount?velocity-oldVelocity:0,coverage=r.count/Math.max(1,freshRows.length),confidence=clamp(54+coverage*28+(r.count>1?10:0)+(prev.rowCount?8:0)),opportunity=clamp(current*.82+confidence*.18),signal=opportunity>=80?'surging':opportunity>=65?'rising':opportunity>=40?'active':'baseline';
  const metrics={keywords:freshRows.map(x=>x.phrase),keyword_values:r.values,keyword_coverage:coverage,time_range:'past_4_hours',regional_evidence_at:new Date(newest).toISOString(),source_note:'DataForSEO Trends relative keyword popularity across U.S. subregions; values are relative demand concentration, not absolute search counts.'};
  await pool.query(`INSERT INTO dominance_market_snapshots(account_id,geography_key,geography_name,geography_type,region,country,source_key,observed_volume,prior_volume,velocity_pct,acceleration_pct,opportunity_score,confidence,signal_state,metrics) VALUES($1,$2,$3,'state',$3,'United States','DATAFORSEO_TRENDS_4H',$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,[account.id,key,r.name,current,prior,velocity,acceleration,opportunity,confidence,signal,JSON.stringify(metrics)]);inserted++;
 }
 return{status:inserted?'synced':'no_regional_values',markets:inserted,evidence_at:new Date(newest).toISOString()};
}
async function run(){if(!pool||busy)return{ok:false};busy=true;try{await mi.ensureSchema(pool);await ensureSnapshotSchema();const accounts=await pool.query(`SELECT id,company_name FROM dominance_accounts WHERE is_active=TRUE ORDER BY id`),results=[];for(const a of accounts.rows){const startedAt=new Date().toISOString();try{const result=await materializeAccount(a);results.push({account_id:a.id,...result});await cp.recordWorkerAccountRun(pool,'market-regional-snapshot-worker',a.id,['synced','fresh'].includes(result.status)?'completed':result.status,result,startedAt).catch(()=>{})}catch(e){const result={account_id:a.id,status:'error',error:e.message};results.push(result);await cp.recordWorkerAccountRun(pool,'market-regional-snapshot-worker',a.id,'error',result,startedAt).catch(()=>{})}}return{ok:true,results}}catch(e){console.error('[REGIONAL SNAPSHOTS]',e);return{ok:false,error:e.message}}finally{busy=false}}
function startMarketRegionalSnapshotWorker(){if(!pool){console.warn('[REGIONAL SNAPSHOTS] DATABASE_URL unavailable');return null}setTimeout(run,18000);timer=setInterval(run,INTERVAL_MS);console.log(`[REGIONAL SNAPSHOTS] online | interval=${INTERVAL_MS/60000}m`);return{run,stop:()=>{if(timer)clearInterval(timer);return pool.end().catch(()=>{})}}}
module.exports={startMarketRegionalSnapshotWorker,runMarketRegionalSnapshots:run,materializeAccount};
