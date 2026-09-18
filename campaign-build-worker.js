'use strict';

const {Pool}=require('pg');
const adCore=require('./ad-intelligence-core');
const cp=require('./control-plane-core');

const DATABASE_URL=process.env.DATABASE_URL||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
const INTERVAL_MS=Math.max(5,Number(process.env.CAMPAIGN_BUILD_INTERVAL_MINUTES||15))*60*1000;
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false}):null;
let timer=null,busy=false;

async function buildGoogleDraft(account,campaign){
  const dup=await pool.query(`SELECT 1 FROM dominance_ad_recommendations WHERE dominance_account_id=$1 AND recommendation_type='campaign_launch' AND action->>'campaign_entity_id'=$2 AND status IN('pending_approval','approved','executing','monitoring','completed') LIMIT 1`,[account.id,String(campaign.id)]);
  if(dup.rowCount)return{status:'already_recommended'};
  const conn=await pool.query(`SELECT 1 FROM dominance_connections WHERE account_id=$1 AND provider_key='GADS' AND status IN('connected','enabled') AND credential_ciphertext IS NOT NULL AND metadata->>'selected_resource' IS NOT NULL LIMIT 1`,[account.id]);
  if(!conn.rowCount)return{status:'waiting_for_google_ads_connection'};
  const kw=await pool.query(`SELECT phrase,dominant_intent,journey_stage,commerciality_score,priority FROM dominance_keyword_intelligence WHERE account_id=$1 AND active=TRUE ORDER BY commerciality_score DESC,priority DESC LIMIT 25`,[account.id]).catch(()=>({rows:[]}));
  const cr=await pool.query(`SELECT id,headline,body_copy,cta,metadata FROM dominance_creatives WHERE account_key=$1 AND platform='Google Ads' AND status='ready_to_launch' AND COALESCE((metadata->'platform_validation'->>'valid')::boolean,FALSE)=TRUE ORDER BY approved_at DESC NULLS LAST,created_at DESC LIMIT 6`,[account.account_key]).catch(()=>({rows:[]}));
  if(!kw.rows.length||!cr.rows.length)return{status:'waiting_for_research_or_platform_valid_creatives',keywords:kw.rowCount||0,creatives:cr.rowCount||0};
  const ads=[];
  for(const x of cr.rows){
    const p=x.metadata?.creative_payload||{};
    if(Array.isArray(p.headlines)&&Array.isArray(p.descriptions))ads.push({headlines:p.headlines,descriptions:p.descriptions,final_urls:[account.website],path1:p.path1||'',path2:p.path2||'',source_creative_id:x.id});
  }
  if(!ads.length)return{status:'waiting_for_structured_google_rsa_creatives'};
  const monthly=Number(campaign.budget||0);
  if(monthly<=0)return{status:'waiting_for_campaign_budget'};
  const daily=Math.floor(monthly/31*100)/100;
  if(daily<=0)return{status:'waiting_for_campaign_budget'};
  const keywords=kw.rows.map(x=>({text:x.phrase,match_type:x.dominant_intent==='transactional'||x.dominant_intent==='local'?'EXACT':'PHRASE',negative:false,intent:x.dominant_intent,stage:x.journey_stage})).filter(x=>x.text).slice(0,20);
  const creativeIds=[...new Set(ads.map(x=>x.source_creative_id))];
  const evidenceCoverage={connected_google_ads:true,platform_valid_creatives:creativeIds.length,qualified_search_intents:keywords.length,market:campaign.market||null};
  const confidence=Math.min(.95,.55+(creativeIds.length>=2?.1:.05)+(keywords.length>=10?.1:.05)+.1+.1);
  const action={
    operation:'launch_campaign',
    platform:'Google Ads',
    campaign_entity_id:String(campaign.id),
    creative_ids:creativeIds,
    evidence_coverage:evidenceCoverage,
    campaign:{
      name:campaign.name,
      status:'ENABLED',
      channel_type:'SEARCH',
      objective:campaign.objective||'qualified_outcomes',
      final_url:account.website,
      daily_budget:daily,
      bid_strategy:campaign.bid_strategy||'MAXIMIZE_CONVERSIONS',
      network_settings:{targetGoogleSearch:true,targetSearchNetwork:true,targetContentNetwork:false,targetPartnerSearchNetwork:false},
      geo_targets:Array.isArray(campaign.targeting?.google_geo_targets)?campaign.targeting.google_geo_targets:[],
      ad_groups:[{name:(campaign.name+' · High Intent').slice(0,120),keywords,ads:ads.slice(0,3)}]
    }
  };
  const recommendation=await adCore.createRecommendation(pool,account,{
    source_type:'dominance_campaign_build',
    source_platform:'Google Ads',
    recommendation_type:'campaign_launch',
    title:'Build and publish Google Search campaign: '+campaign.name,
    rationale:'DOMINANCE assembled this campaign from the approved monthly budget, connected Google Ads account, active search-intent intelligence, and research-backed Google Ads creatives. Approval authorizes the Control Plane to validate and publish this exact build live while remaining inside the account hard cap.',
    action,
    expected_outcome:{objective:campaign.objective||'qualified_outcomes',measurement:'downstream qualified outcome efficiency'},
    success_criteria:{must_remain_within_monthly_cap:true,platform_mutation_must_validate:true,tracking_and_readback_required:true,qualified_outcome_efficiency_must_not_regress:true},
    funding_plan:{net_new_spend:monthly,monthly_cap_source:'dominance_ad_policy',campaign_monthly_allocation:monthly},
    confidence
  });
  await pool.query(`UPDATE dominance_campaign_entities SET settings=settings||$2::jsonb,updated_at=NOW() WHERE id=$1`,[campaign.id,JSON.stringify({launch_recommendation_id:recommendation.id,build_generated_at:new Date().toISOString(),evidence_coverage:evidenceCoverage})]);
  return{status:'recommended',recommendation_id:recommendation.id,creative_ids:creativeIds,keywords:keywords.length,daily_budget:daily};
}

async function processAccount(account){
  const drafts=await pool.query(`SELECT * FROM dominance_campaign_entities WHERE dominance_account_id=$1 AND entity_type='campaign' AND platform='Google Ads' AND status IN('draft','ready_to_build') ORDER BY updated_at ASC LIMIT 20`,[account.id]);
  const results=[];
  for(const c of drafts.rows)try{results.push({campaign_id:c.id,...await buildGoogleDraft(account,c)})}catch(e){results.push({campaign_id:c.id,status:'error',error:String(e.message||e)})}
  return results;
}

async function runCampaignBuild(){
  if(!pool||busy)return{ok:false,reason:!pool?'database_unavailable':'busy'};
  busy=true;const started=new Date();
  try{
    const accounts=await pool.query('SELECT * FROM dominance_accounts WHERE is_active=TRUE ORDER BY id'),results=[];
    for(const a of accounts.rows){const r=await processAccount(a);results.push({account_id:a.id,results:r});await cp.recordWorkerAccountRun(pool,'campaign-build-worker',a.id,'completed',{campaigns:r},started).catch(()=>{})}
    await pool.query(`INSERT INTO dominance_worker_state(worker_key,last_heartbeat_at,last_run_at,status,details) VALUES('campaign-build-worker',NOW(),NOW(),'online',$1::jsonb) ON CONFLICT(worker_key) DO UPDATE SET last_heartbeat_at=NOW(),last_run_at=NOW(),status='online',details=EXCLUDED.details`,[JSON.stringify({accounts:accounts.rowCount,results})]).catch(()=>{});
    return{ok:true,results};
  }catch(e){console.error('[CAMPAIGN BUILD]',e);return{ok:false,error:String(e.message||e)}}finally{busy=false}
}

function startCampaignBuildWorker(){
  if(!pool){console.warn('[CAMPAIGN BUILD] DATABASE_URL unavailable');return null}
  setTimeout(runCampaignBuild,45000);timer=setInterval(runCampaignBuild,INTERVAL_MS);
  console.log('[CAMPAIGN BUILD] online | interval='+(INTERVAL_MS/60000)+'m');
  return{run:runCampaignBuild,stop:async()=>{if(timer)clearInterval(timer);await pool.end().catch(()=>{})}};
}
module.exports={startCampaignBuildWorker,runCampaignBuild};
