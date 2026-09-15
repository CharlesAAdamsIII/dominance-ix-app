const core=require('./ad-intelligence-core');
const pool=core.makePool();
const INTERVAL_MS=Math.max(1,Number(process.env.AD_INTELLIGENCE_INTERVAL_MINUTES||5))*60*1000;
let timer=null,busy=false;

function perf(x){x=x||{};return{spend:Number(x.spend||0),qualified:Number(x.qualified_outcomes||x.qualified_conversions||0),cpa:Number(x.qualified_cpa||x.cpa||0)}}

async function generatePerformanceRecommendations(account){
  const entities=await pool.query(`SELECT id,platform,entity_type,name,status,budget,performance FROM dominance_campaign_entities WHERE dominance_account_id=$1 AND status IS DISTINCT FROM 'removed' ORDER BY updated_at DESC LIMIT 500`,[account.id]).catch(()=>({rows:[]}));
  const qualified=entities.rows.map(r=>({...r,p:perf(r.performance)})).filter(r=>r.p.spend>0&&r.p.qualified>0&&r.p.cpa>0).sort((a,b)=>a.p.cpa-b.p.cpa);
  if(qualified.length<2)return 0;
  const best=qualified[0],worst=qualified[qualified.length-1];
  if(worst.p.cpa<=best.p.cpa*1.25)return 0;
  const shift=Math.min(Number(worst.budget||0)*.2,Number(best.budget||0)*.25,Math.max(25,worst.p.spend*.1));
  if(shift<=0)return 0;
  const dup=await pool.query(`SELECT 1 FROM dominance_ad_recommendations WHERE dominance_account_id=$1 AND recommendation_type='budget_reallocation' AND status IN('pending_approval','approved','executing','monitoring') AND action->>'from_entity_id'=$2 LIMIT 1`,[account.id,String(worst.id)]);
  if(dup.rowCount)return 0;
  await core.createRecommendation(pool,account,{recommendation_type:'budget_reallocation',title:`Reallocate $${shift.toFixed(0)} from ${worst.name} to ${best.name}`,rationale:`DOMINANCE found materially better qualified acquisition economics in ${best.name}. This moves existing dollars rather than increasing the account budget.`,action:{platform:best.platform,from_entity_id:String(worst.id),to_entity_id:String(best.id),amount:shift,operation:'reallocate_budget'},expected_outcome:{qualified_cpa_direction:'down',qualified_outcomes_direction:'up'},success_criteria:{qualified_cpa_must_not_worsen:true,minimum_relative_improvement:.05},funding_plan:{net_new_spend:0,from_campaign:worst.name,to_campaign:best.name,amount:shift},confidence:.86});
  return 1;
}

async function processAccount(account){
  await core.getOrCreatePolicy(pool,account.id);
  const incoming=await pool.query(`SELECT * FROM dominance_platform_recommendations WHERE dominance_account_id=$1 AND status='new' ORDER BY received_at ASC LIMIT 50`,[account.id]);
  for(const r of incoming.rows)await core.adjudicatePlatformRecommendation(pool,account,r);
  await generatePerformanceRecommendations(account);
  const autonomy=await core.evaluateAutonomy(pool,account.id);
  if(!autonomy.require_approval){
    const ready=await pool.query(`SELECT * FROM dominance_ad_recommendations WHERE dominance_account_id=$1 AND status='approved' ORDER BY confidence DESC,created_at ASC LIMIT 25`,[account.id]);
    for(const r of ready.rows)await core.enqueueRecommendation(pool,r);
  }
  const failed=await pool.query(`SELECT id FROM dominance_ad_recommendations WHERE dominance_account_id=$1 AND success=FALSE AND evaluated_at > NOW()-INTERVAL '24 hours' LIMIT 1`,[account.id]);
  if(!autonomy.require_approval&&failed.rowCount)await core.suspendAutonomy(pool,account.id,'An autonomous action failed its predeclared success criteria; approval mode restored automatically.');
  return{platform_adjudicated:incoming.rowCount,autonomy};
}

async function runAdIntelligence(){
  if(!pool||busy)return{ok:false};busy=true;
  try{
    await core.ensureAdSchema(pool);
    const accounts=await pool.query('SELECT id,account_key,company_name,website,industry_key,industry_name,analysis FROM dominance_accounts WHERE is_active=TRUE ORDER BY updated_at DESC');
    const results=[];for(const a of accounts.rows){try{results.push({account_id:a.id,...await processAccount(a)})}catch(e){results.push({account_id:a.id,error:e.message})}}
    await pool.query(`INSERT INTO dominance_worker_state(worker_key,last_heartbeat_at,last_run_at,status,details) VALUES('ad-intelligence-worker',NOW(),NOW(),'online',$1::jsonb) ON CONFLICT(worker_key) DO UPDATE SET last_heartbeat_at=NOW(),last_run_at=NOW(),status='online',details=EXCLUDED.details`,[JSON.stringify({accounts:results.length,results})]).catch(()=>{});
    return{ok:true,results};
  }catch(e){console.error('[AD INTELLIGENCE]',e);return{ok:false,error:e.message}}finally{busy=false}
}

function startAdIntelligenceWorker(){if(!pool){console.warn('[AD INTELLIGENCE] DATABASE_URL unavailable');return null}setTimeout(runAdIntelligence,7000);timer=setInterval(runAdIntelligence,INTERVAL_MS);console.log(`[AD INTELLIGENCE] online | interval=${INTERVAL_MS/60000}m`);return{run:runAdIntelligence,stop:()=>{if(timer)clearInterval(timer);return pool.end().catch(()=>{})}}}
module.exports={startAdIntelligenceWorker,runAdIntelligence};
