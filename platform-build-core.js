'use strict';

const crypto=require('crypto');

const PLATFORM_RULES={
  'Google Ads':{connector:'google_ads',supports_write:true,written_copy:{min_headlines:3,max_headlines:15,max_headline_chars:30,min_descriptions:2,max_descriptions:4,max_description_chars:90},image_aspects:['1.91:1','1:1','4:5'],video:{durations:[6,15,30],aspects:['16:9','9:16','1:1']}},
  'Microsoft Ads':{connector:'microsoft_ads',supports_write:false,written_copy:{min_headlines:3,max_headlines:15,max_headline_chars:30,min_descriptions:2,max_descriptions:4,max_description_chars:90},image_aspects:['1.91:1','1:1'],video:{durations:[15,30],aspects:['16:9','1:1']}},
  'Meta':{connector:'meta_ads',supports_write:false,written_copy:{max_primary_text_chars:125,max_headline_chars:40,max_description_chars:30},image_aspects:['1:1','4:5','9:16'],video:{durations:[15,30],aspects:['9:16','4:5','1:1']}},
  'LinkedIn':{connector:'linkedin_ads',supports_write:false,written_copy:{max_intro_chars:150,max_headline_chars:70,max_description_chars:100},image_aspects:['1.91:1','1:1'],video:{durations:[15,30],aspects:['16:9','1:1','9:16']}},
  'TikTok':{connector:'tiktok_ads',supports_write:false,written_copy:{max_caption_chars:100},image_aspects:['9:16'],video:{durations:[6,15,30],aspects:['9:16']}},
  'YouTube / DV360':{connector:'google_ads',supports_write:false,image_aspects:['16:9','1:1'],video:{durations:[6,15,30],aspects:['16:9','9:16']}}
};

const clean=v=>String(v??'').trim();
const n=v=>Number(v||0);
const hashObject=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

function normalizePlatform(v){
  const s=clean(v).toLowerCase();
  if(s==='google'||s==='google ads'||s==='gads')return'Google Ads';
  if(s==='meta'||s==='facebook'||s==='instagram'||s==='meta ads')return'Meta';
  if(s==='linkedin'||s==='linkedin ads')return'LinkedIn';
  if(s==='tiktok'||s==='tiktok ads')return'TikTok';
  if(s==='microsoft'||s==='bing'||s==='microsoft ads')return'Microsoft Ads';
  if(s==='youtube'||s==='dv360'||s==='youtube / dv360')return'YouTube / DV360';
  return clean(v);
}

function evidenceSummary(brief={}){
  const intel=brief.intelligence||{},market=intel.market_signals||[],search=intel.search_intent||[],competitors=intel.competitor_context||[],competitorEvents=intel.competitor_events||[],learning=intel.winning_patterns||[];
  const sourceList=brief.intelligence?.audience_market_context?.data_quality?.sources_available||[];
  return{supported:market.length+search.length+competitors.length+competitorEvents.length+learning.length>0,sources:[...new Set(sourceList.map(clean).filter(Boolean))],market_signals:market.slice(0,20),search_intent:search.slice(0,30),competitor_context:competitors.slice(0,20),competitor_events:competitorEvents.slice(0,20),measured_learning:learning.slice(0,20)};
}

function creativeProvenanceManifest({account,request,asset,brief}={}){
  const evidence=evidenceSummary(brief||{});
  const manifest={version:'1.0.0',account_id:account?.id||request?.dominance_account_id||null,account_key:account?.account_key||null,creative_request_id:request?.id||asset?.request_id||null,generated_asset_id:asset?.id||null,platform:normalizePlatform(request?.platform||brief?.destination?.platform||''),generated_at:asset?.created_at||brief?.generated_at||new Date().toISOString(),research_backed:evidence.supported,evidence,assignment:brief?.assignment||{},strategic_direction:brief?.strategic_direction||{},source_prompt:brief?.source_prompt||request?.prompt||null,platform_requirements:brief?.platform_requirements||[],constraints:brief?.constraints||request?.constraints||{}};
  return{...manifest,manifest_hash:hashObject(manifest)};
}

function validateCreativeForPlatform(platform,creative={}){
  platform=normalizePlatform(platform);
  const rules=PLATFORM_RULES[platform],errors=[],warnings=[];
  if(!rules)return{valid:false,errors:['Unsupported platform: '+(platform||'unknown')],warnings,rules:null};
  const headlines=(creative.headlines||[]).map(clean).filter(Boolean),descriptions=(creative.descriptions||[]).map(clean).filter(Boolean);
  if(platform==='Google Ads'||platform==='Microsoft Ads'){
    if(headlines.length<rules.written_copy.min_headlines)errors.push(platform+' responsive search ads require at least '+rules.written_copy.min_headlines+' headlines.');
    if(headlines.length>rules.written_copy.max_headlines)errors.push(platform+' responsive search ads allow at most '+rules.written_copy.max_headlines+' headlines.');
    headlines.forEach((x,i)=>{if(x.length>rules.written_copy.max_headline_chars)errors.push('Headline '+(i+1)+' exceeds '+rules.written_copy.max_headline_chars+' characters.')});
    if(descriptions.length<rules.written_copy.min_descriptions)errors.push(platform+' responsive search ads require at least '+rules.written_copy.min_descriptions+' descriptions.');
    if(descriptions.length>rules.written_copy.max_descriptions)errors.push(platform+' responsive search ads allow at most '+rules.written_copy.max_descriptions+' descriptions.');
    descriptions.forEach((x,i)=>{if(x.length>rules.written_copy.max_description_chars)errors.push('Description '+(i+1)+' exceeds '+rules.written_copy.max_description_chars+' characters.')});
    if(!(creative.final_urls||[]).filter(Boolean).length)errors.push(platform+' responsive search ad requires at least one final URL.');
  }else if(platform==='Meta'){
    if(clean(creative.primary_text).length>rules.written_copy.max_primary_text_chars)errors.push('Meta primary text exceeds '+rules.written_copy.max_primary_text_chars+' characters.');
    if(clean(creative.headline).length>rules.written_copy.max_headline_chars)errors.push('Meta headline exceeds '+rules.written_copy.max_headline_chars+' characters.');
    if(clean(creative.description).length>rules.written_copy.max_description_chars)errors.push('Meta description exceeds '+rules.written_copy.max_description_chars+' characters.');
    if(!clean(creative.primary_text)||!clean(creative.headline))errors.push('Meta creative requires primary text and headline.');
  }else if(platform==='LinkedIn'){
    if(clean(creative.intro_text).length>rules.written_copy.max_intro_chars)errors.push('LinkedIn intro text exceeds '+rules.written_copy.max_intro_chars+' characters.');
    if(clean(creative.headline).length>rules.written_copy.max_headline_chars)errors.push('LinkedIn headline exceeds '+rules.written_copy.max_headline_chars+' characters.');
    if(clean(creative.description).length>rules.written_copy.max_description_chars)errors.push('LinkedIn description exceeds '+rules.written_copy.max_description_chars+' characters.');
    if(!clean(creative.intro_text)||!clean(creative.headline))errors.push('LinkedIn creative requires intro text and headline.');
  }else if(platform==='TikTok'){
    if(clean(creative.caption).length>rules.written_copy.max_caption_chars)errors.push('TikTok caption exceeds '+rules.written_copy.max_caption_chars+' characters.');
    if(!clean(creative.caption))errors.push('TikTok creative requires a caption.');
  }
  return{valid:errors.length===0,errors,warnings,rules};
}

function aspectFromSize(size){
  const m=String(size||'').match(/^(\d+)x(\d+)$/);if(!m)return null;
  const ratio=Number(m[1])/Number(m[2]);
  const known=[['1:1',1],['4:5',0.8],['9:16',0.5625],['16:9',1.7778],['1.91:1',1.91]];
  known.sort((a,b)=>Math.abs(ratio-a[1])-Math.abs(ratio-b[1]));
  return Math.abs(ratio-known[0][1])<=0.08?known[0][0]:null;
}
function validateGeneratedAssetForPlatform(platform,category,metadata={}){
  platform=normalizePlatform(platform);
  const rules=PLATFORM_RULES[platform],errors=[],warnings=[];
  if(!rules)return{valid:false,errors:['Unsupported platform: '+platform],warnings};
  if(category==='images'){
    const aspect=aspectFromSize(metadata.size);
    if(!aspect)errors.push('Generated image dimensions '+(metadata.size||'unknown')+' do not map closely enough to an approved platform aspect ratio.');
    else if(!(rules.image_aspects||[]).includes(aspect))errors.push(platform+' does not accept the generated '+aspect+' image for this DOMINANCE placement contract.');
  }
  if(category==='video'){
    const aspect=aspectFromSize(metadata.size),seconds=Number(metadata.seconds||0);
    if(aspect&&!(rules.video?.aspects||[]).includes(aspect))errors.push(platform+' video aspect '+aspect+' is outside the approved platform contract.');
    if(seconds&&(rules.video?.durations||[]).length&&!rules.video.durations.includes(seconds))errors.push(platform+' generated video duration '+seconds+'s does not match an approved DOMINANCE platform duration.');
    if(!metadata.size)warnings.push('Video dimensions are not yet available for deterministic validation.');
    if(!metadata.seconds)warnings.push('Video duration is not yet available for deterministic validation.');
  }
  return{valid:errors.length===0,errors,warnings,detected_aspect:aspectFromSize(metadata.size)};
}

function buildSpecFromRecommendation(recommendation,account){
  const action=recommendation?.action||{},platform=normalizePlatform(recommendation?.source_platform||action.platform||''),operation=clean(action.operation||recommendation?.recommendation_type||'').toLowerCase();
  const base={version:'1.0.0',recommendation_id:recommendation?.id||null,dominance_account_id:account?.id||recommendation?.dominance_account_id||null,platform,operation,approval_required:true,generated_at:new Date().toISOString(),source_action:action};
  if(['launch_campaign','create_campaign','campaign_build','campaign_launch'].includes(operation)){
    const campaign=action.campaign||{};
    return{...base,operation:'launch_campaign',campaign_entity_id:clean(action.campaign_entity_id||''),creative_ids:(action.creative_ids||[]).map(Number).filter(Number.isFinite),campaign:{name:clean(campaign.name||action.name),status:clean(campaign.status||'PAUSED').toUpperCase(),channel_type:clean(campaign.channel_type||action.channel_type||'SEARCH').toUpperCase(),objective:clean(campaign.objective||action.objective||''),final_url:clean(campaign.final_url||action.final_url||account?.website||''),daily_budget:n(campaign.daily_budget||action.daily_budget),bid_strategy:clean(campaign.bid_strategy||action.bid_strategy||'MAXIMIZE_CONVERSIONS').toUpperCase(),network_settings:campaign.network_settings||action.network_settings||{targetGoogleSearch:true,targetSearchNetwork:true,targetContentNetwork:false,targetPartnerSearchNetwork:false},geo_targets:campaign.geo_targets||action.geo_targets||[],ad_groups:(campaign.ad_groups||action.ad_groups||[]).map(g=>({name:clean(g.name),cpc_bid:n(g.cpc_bid),keywords:(g.keywords||[]).map(k=>typeof k==='string'?{text:clean(k),match_type:'PHRASE'}:{text:clean(k.text),match_type:clean(k.match_type||'PHRASE').toUpperCase(),negative:k.negative===true}),ads:(g.ads||[]).map(ad=>({headlines:(ad.headlines||[]).map(clean).filter(Boolean),descriptions:(ad.descriptions||[]).map(clean).filter(Boolean),final_urls:(ad.final_urls||[campaign.final_url||action.final_url||account?.website||'']).map(clean).filter(Boolean),path1:clean(ad.path1),path2:clean(ad.path2)}))}))}};
  }
  if(operation==='reallocate_budget')return{...base,operation:'reallocate_budget',from_entity_id:clean(action.from_entity_id),to_entity_id:clean(action.to_entity_id),amount:n(action.amount),amount_basis:clean(action.amount_basis||'monthly').toLowerCase()};
  if(['update_campaign_budget','set_budget'].includes(operation))return{...base,operation:'update_campaign_budget',campaign_entity_id:clean(action.campaign_entity_id||action.entity_id),daily_budget:n(action.daily_budget||action.amount)};
  return base;
}

function validateBuildSpec(spec,{research_manifest=null,monthly_budget_max=0,spend_to_date=0,committed_monthly_budget=0}={}){
  const errors=[],warnings=[],platform=normalizePlatform(spec?.platform||''),rules=PLATFORM_RULES[platform];
  if(!rules)errors.push('No platform specification exists for '+(platform||'unknown platform')+'.');
  if(research_manifest&&!research_manifest.research_backed)errors.push('Research provenance is missing or contains no supporting market/search/competitor/performance evidence.');
  if(spec?.operation==='launch_campaign'){
    const c=spec.campaign||{};
    if(!c.name)errors.push('Campaign name is required.');
    if(n(c.daily_budget)<=0)errors.push('Daily campaign budget must be greater than zero.');
    if(!c.final_url)errors.push('Campaign final URL is required.');
    if(!Array.isArray(c.ad_groups)||!c.ad_groups.length)errors.push('At least one ad group is required.');
    for(const [i,g] of (c.ad_groups||[]).entries()){
      if(!g.name)errors.push('Ad group '+(i+1)+' is missing a name.');
      if(!g.keywords?.length&&platform==='Google Ads')warnings.push('Ad group '+(i+1)+' has no keywords.');
      if(!g.ads?.length)errors.push('Ad group '+(i+1)+' has no ads.');
      for(const [j,ad] of (g.ads||[]).entries()){const r=validateCreativeForPlatform(platform,ad);for(const e of r.errors)errors.push('Ad group '+(i+1)+', ad '+(j+1)+': '+e);}
    }
    if(monthly_budget_max>0){const planned=committed_monthly_budget+n(c.daily_budget)*31,exposure=Math.max(spend_to_date,planned);if(exposure>monthly_budget_max)errors.push('Campaign launch would exceed the account monthly advertising maximum after existing campaign allocations are included.');}
  }else if(spec?.operation==='reallocate_budget'){
    if(!spec.from_entity_id||!spec.to_entity_id)errors.push('Budget reallocation requires source and destination campaign entities.');
    if(n(spec.amount)<=0)errors.push('Budget reallocation amount must be greater than zero.');
  }else if(spec?.operation==='update_campaign_budget'){
    if(!spec.campaign_entity_id)errors.push('Campaign entity is required for budget update.');
    if(n(spec.daily_budget)<=0)errors.push('Daily budget must be greater than zero.');
    if(monthly_budget_max>0){const planned=committed_monthly_budget+n(spec.daily_budget)*31,exposure=Math.max(spend_to_date,planned);if(exposure>monthly_budget_max)errors.push('Campaign budget update would exceed the account monthly advertising maximum after existing campaign allocations are included.');}
  }else errors.push('Execution operation '+(spec?.operation||'unknown')+' is not supported by the execution gateway.');
  if(rules&&!rules.supports_write)warnings.push(platform+' build validation is available, but the physical write adapter is not connected yet.');
  return{ready:errors.length===0,platform,connector:rules?.connector||null,write_adapter_available:!!rules?.supports_write,errors,warnings};
}

module.exports={PLATFORM_RULES,normalizePlatform,evidenceSummary,creativeProvenanceManifest,validateCreativeForPlatform,validateGeneratedAssetForPlatform,buildSpecFromRecommendation,validateBuildSpec,hashObject};
