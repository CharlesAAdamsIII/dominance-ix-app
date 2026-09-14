function text(v){return String(v??'').trim()}
function lower(v){return text(v).toLowerCase()}
function num(v){const n=Number(v);return Number.isFinite(n)?n:null}
function uniq(a){return [...new Set(a.filter(Boolean))]}

const PROVIDER_DIMENSIONS={
  CENSUS:['population','age','income','household','education','employment','housing','demographic','economic'],
  CDC:['health prevalence','population health','risk','condition prevalence','mortality','behavioral health'],
  CMS:['payer','medicare','medicaid','utilization','provider','claims','healthcare economics'],
  GSC:['search intent','organic demand','query language','landing-page relevance'],
  GA4:['first-party audience','engagement','conversion behavior','geographic response'],
  GADS:['paid search','campaign economics','conversion value','keyword performance'],
  DATAFORSEO:['search demand','trend velocity','geographic interest'],
  RDAP:['business formation','domain activity','market activity']
};

function inferCampaignClass(req,account){
 const s=lower([req.objective,req.audience,req.message_angle,req.prompt,account.industry_name,account.industry_key].join(' '));
 if(/health|patient|medicaid|medicare|treatment|clinic|hospital|therapy|addiction|mental/.test(s))return'healthcare';
 if(/b2b|enterprise|software|saas|technology|consult|business/.test(s))return'b2b';
 if(/retail|ecommerce|consumer|shop|product/.test(s))return'consumer';
 return'general';
}
function dimensionWeights(kind){
 if(kind==='healthcare')return{demand:1,economics:.9,demographics:.8,health:.95,payer:1,competition:1,first_party:.9,business:.3};
 if(kind==='b2b')return{demand:1,economics:.9,demographics:.35,health:.05,payer:.05,competition:1,first_party:.9,business:1};
 if(kind==='consumer')return{demand:1,economics:1,demographics:1,health:.15,payer:.05,competition:1,first_party:.9,business:.2};
 return{demand:1,economics:.7,demographics:.65,health:.25,payer:.2,competition:1,first_party:.8,business:.5};
}
function providerWeight(provider,weights){
 const p=upper(provider);
 if(p==='CENSUS')return Math.max(weights.economics,weights.demographics);
 if(p==='CDC')return weights.health;
 if(p==='CMS')return Math.max(weights.payer,weights.health);
 if(p==='GSC'||p==='DATAFORSEO')return weights.demand;
 if(p==='GA4'||p==='GADS')return weights.first_party;
 if(p==='RDAP')return weights.business;
 return .4;
}
function upper(v){return text(v).toUpperCase()}
function geoMatchScore(target,row){
 const t=lower(target);if(!t)return .5;
 const vals=[row.geography_name,row.region,row.country,row.resource_key,row.snapshot_type,JSON.stringify(row.data||{})].map(lower);
 if(vals.some(v=>v&&v===t))return 1;
 if(vals.some(v=>v&&v.includes(t)))return .9;
 const tokens=t.split(/[^a-z0-9]+/).filter(x=>x.length>2);
 const hits=tokens.filter(tok=>vals.some(v=>v.includes(tok))).length;
 return tokens.length?Math.min(.8,hits/tokens.length):.4;
}
function compactData(data,depth=0){
 if(depth>2)return undefined;
 if(Array.isArray(data))return data.slice(0,8).map(x=>compactData(x,depth+1));
 if(data&&typeof data==='object'){
   const out={};for(const [k,v] of Object.entries(data).slice(0,24)){const cv=compactData(v,depth+1);if(cv!==undefined)out[k]=cv}return out;
 }
 if(typeof data==='string')return data.length>220?data.slice(0,220)+'…':data;
 return data;
}
function deriveMarketFacts(rows,target){
 return rows.slice(0,10).map(r=>({
  geography:r.geography_name||r.region||target||null,
  type:r.geography_type||null,
  source:r.source_key,
  opportunity:num(r.opportunity_score),
  velocity_pct:num(r.velocity_pct),
  acceleration_pct:num(r.acceleration_pct),
  confidence:num(r.confidence),
  state:r.signal_state,
  metrics:compactData(r.metrics||{})
 }));
}
function snapshotFacts(rows,weights,target){
 return rows.map(r=>{
  const p=upper(r.provider_key),pw=providerWeight(p,weights),gm=geoMatchScore(target,r),ageH=Math.max(0,(Date.now()-new Date(r.collected_at).getTime())/3600000),fresh=Math.max(.2,1-Math.min(ageH,720)/900),score=pw*gm*fresh;
  return{provider:p,relevance:Number(score.toFixed(3)),dimensions:PROVIDER_DIMENSIONS[p]||[],snapshot_type:r.snapshot_type,resource_key:r.resource_key,collected_at:r.collected_at,data:compactData(r.data||{})};
 }).sort((a,b)=>b.relevance-a.relevance).slice(0,14);
}
function explain(kind,weights,available){
 const ranked=Object.entries(weights).sort((a,b)=>b[1]-a[1]).map(([dimension,weight])=>({dimension,weight}));
 return{campaign_class:kind,priority_dimensions:ranked,available_sources:uniq(available),rule:'Use high-relevance local evidence first. Missing sources must not be inferred as facts.'};
}

async function buildMarketContext(pool,req,account){
 const target=req.market||'';
 const [marketR,snapR,compR]=await Promise.all([
  pool.query(`SELECT geography_name,geography_type,region,country,source_key,observed_volume,search_volume,velocity_pct,acceleration_pct,opportunity_score,confidence,signal_state,metrics,captured_at FROM dominance_market_snapshots WHERE account_id=$1 ORDER BY captured_at DESC,opportunity_score DESC LIMIT 80`,[req.dominance_account_id]),
  pool.query(`SELECT provider_key,resource_key,snapshot_type,data,collected_at FROM dominance_data_snapshots WHERE account_id=$1 ORDER BY collected_at DESC LIMIT 80`,[req.dominance_account_id]),
  pool.query(`SELECT competitor_name,platform,asset_type,headline,body_copy,cta,message_angle,offer_type,last_seen_at,metadata FROM dominance_competitor_assets WHERE dominance_account_id=$1 AND active=TRUE ORDER BY last_seen_at DESC LIMIT 30`,[req.dominance_account_id])
 ]);
 const kind=inferCampaignClass(req,account),weights=dimensionWeights(kind);
 const localMarkets=marketR.rows.map(r=>({...r,_geo:geoMatchScore(target,r)})).sort((a,b)=>(b._geo*2+Number(b.opportunity_score||0)/100)-(a._geo*2+Number(a.opportunity_score||0)/100));
 const snapshots=snapshotFacts(snapR.rows,weights,target);
 const competitors=compR.rows.filter(r=>!target||geoMatchScore(target,{data:r.metadata||{},snapshot_type:r.message_angle||'',resource_key:r.offer_type||''})>.35).slice(0,12).map(r=>({competitor:r.competitor_name,platform:r.platform,asset_type:r.asset_type,headline:r.headline,cta:r.cta,message_angle:r.message_angle,offer_type:r.offer_type,last_seen_at:r.last_seen_at,metadata:compactData(r.metadata||{})}));
 const sources=uniq([...localMarkets.map(x=>x.source_key),...snapshots.map(x=>x.provider)]);
 return{
   target_geography:target||null,
   campaign_class:kind,
   relevance_model:explain(kind,weights,sources),
   geographic_demand:deriveMarketFacts(localMarkets,target),
   demographic_economic_health_context:snapshots,
   competitor_context:competitors,
   data_quality:{sources_available:sources,has_census:sources.includes('CENSUS'),has_cdc:sources.includes('CDC'),has_cms:sources.includes('CMS'),has_search:sources.includes('GSC')||sources.includes('DATAFORSEO'),has_first_party:sources.includes('GA4')||sources.includes('GADS'),warning:'Only use fields actually present in collected sources. Do not fabricate missing demographic, economic, payer or health facts.'}
 };
}
module.exports={buildMarketContext};
