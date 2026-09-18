'use strict';

const {Pool}=require('pg');
const adCore=require('./ad-intelligence-core');
const cp=require('./control-plane-core');
const googleAds=require('./google-ads-write-adapter');

const DATABASE_URL=process.env.DATABASE_URL||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
const INTERVAL_MS=Math.max(5,Number(process.env.CAMPAIGN_BUILD_INTERVAL_MINUTES||15))*60*1000;
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false}):null;
let timer=null,busy=false;

async function googleTargeting(account,campaign){
  const targeting=campaign.targeting||{};
  let candidates=[];
  if(Array.isArray(targeting.google_geo_targets)&&targeting.google_geo_targets.length)candidates=targeting.google_geo_targets;
  else if(Array.isArray(targeting.google_location_names)&&targeting.google_location_names.length)candidates=targeting.google_location_names.map(name=>({name,source:'campaign_targeting'}));
  else{
    const generic=new Set(['priority markets','priority market','national','regional','selected markets','market radar','automatic','auto']);
    const market=String(campaign.market||'').trim();
    if(market&&!generic.has(market.toLowerCase()))candidates=[{name:market,geography_type:'market',source:'campaign_market'}];
    else{
      const t=await pool.query(`SELECT name,geography_type,latitude,longitude,radius_miles,source,priority,metadata FROM dominance_target_areas WHERE account_id=$1 AND enabled=TRUE ORDER BY priority DESC,updated_at DESC LIMIT 6`,[account.id]).catch(()=>({rows:[]}));
      candidates=t.rows.map(x=>({name:x.name,geography_type:x.geography_type,latitude:x.latitude,longitude:x.longitude,radius_miles:x.radius_miles,source:x.source||'market_radar',country_code:x.metadata?.country_code||null,priority:Number(x.priority||0)}));
    }
  }
  if(!candidates.length)return{status:'waiting_for_market_targeting',geo_targets:[],language_ids:[]};
  const countryCode=String(targeting.google_country_code||'').trim().toUpperCase()||null;
  const geoTargets=await googleAds.resolveGeoTargets(pool,account.id,candidates,{countryCode,locale:String(targeting.google_locale||'en')});
  const unresolved=geoTargets.filter(x=>x.type==='unresolved');
  const usable=geoTargets.filter(x=>x.type==='location'||x.type==='proximity');
  if(!usable.length||unresolved.length)return{status:'waiting_for_google_geo_resolution',geo_targets:usable,unresolved:unresolved.map(x=>x.name),language_ids:[]};
  let languageIds=(targeting.google_language_criterion_ids||[]).map(x=>String(x).replace(/\D/g,'')).filter(Boolean);
  let languageSource='campaign_targeting';
  if(!languageIds.length){
    const countries=[...new Set(usable.map(x=>String(x.country_code||countryCode||'').toUpperCase()).filter(Boolean))];
    if(!countries.length||countries.every(x=>x==='US')){languageIds=['1000'];languageSource='default_english_for_us_or_unspecified_country'}
    else return{status:'waiting_for_google_language_targeting',geo_targets:usable,language_ids:[]};
  }
  return{status:'ready',geo_targets:usable,language_ids:languageIds,language_source:languageSource,candidates:candidates.map(x=>x.name||x.criterion_id||'proximity')};
}

async function buildGoogleDraft(account,campaign){
  const dup=await pool.query(`SELECT 1 FROM dominance_ad_recommendations WHERE dominance_account_id=$1 AND recommendation_type='campaign_launch' AND action->>'campaign_entity_id'=$2 AND status IN('pending_approval','approved','executing','monitoring','completed') LIMIT 1`,[account.id,String(campaign.id)]);
  if(dup.rowCount)return{status:'already_recommended'};
  const conn=await pool.query(`SELECT 1 FROM dominance_connections WHERE account_id=$1 AND provider_key='GADS' AND status IN('connected','enabled') AND credential_ciphertext IS NOT NULL AND metadata->>'selected_resource' IS NOT NULL LIMIT 1`,[account.id]);
  if(!conn.rowCount)return{status:'waiting_for_google_ads_connection'};
  const targeting=await googleTargeting(account,campaign);
  if(targeting.status!=='ready')return targeting;
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
  const now=new Date(),daysInMonth=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,0)).getUTCDate(),daysRemaining=Math.max(1,daysInMonth-now.getUTCDate()+1),remainingMonthSpend=Math.min(monthly,Math.round(daily*daysRemaining*100)/100);
  const keywords=kw.rows.map(x=>({text:x.phrase,match_type:x.dominant_intent==='transactional'||x.dominant_intent==='local'?'EXACT':'PHRASE',negative:false,intent:x.dominant_intent,stage:x.journey_stage})).filter(x=>x.text).slice(0,20);
  const creativeIds=[...new Set(ads.map(x=>x.source_creative_id))];
  const evidenceCoverage={connected_google_ads:true,platform_valid_creatives:creativeIds.length,qualified_search_intents:keywords.length,market:campaign.market||null,google_geo_targets:targeting.geo_targets.length,google_language_targets:targeting.language_ids.length,geo_target_source:targeting.candidates||[],language_source:targeting.language_source};
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
      geo_targets:targeting.geo_targets,
      language_criterion_ids:targeting.language_ids,
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
    funding_plan:{net_new_spend:remainingMonthSpend,monthly_cap_source:'dominance_ad_policy',campaign_monthly_allocation:monthly,remaining_month_days:daysRemaining},
    confidence
  });
  await pool.query(`UPDATE dominance_campaign_entities SET settings=settings||$2::jsonb,updated_at=NOW() WHERE id=$1`,[campaign.id,JSON.stringify({launch_recommendation_id:recommendation.id,build_generated_at:new Date().toISOString(),evidence_coverage:evidenceCoverage})]);
  return{status:'recommended',recommendation_id:recommendation.id,creative_ids:creativeIds,keywords:keywords.length,daily_budget:daily,geo_targets:targeting.geo_targets.length,language_targets:targeting.language_ids.length};
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
