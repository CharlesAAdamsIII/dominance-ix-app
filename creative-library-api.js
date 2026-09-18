const {Pool}=require('pg');
const {ensureSchema:ensureGeneratedSchema}=require('./creative-generation');
const {runCreativeResearch}=require('./creative-research-worker');
const {runCreativeProduction}=require('./creative-production-worker');
const executionGateway=require('./execution-gateway-core');
const platformBuild=require('./platform-build-core');

const DATABASE_URL=process.env.DATABASE_URL||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false}):null;

function auth(req,res,next){if(req.session&&req.session.userId)return next();return res.status(401).json({ok:false,error:'Authentication required'})}
async function accountFor(req){const r=await pool.query(`SELECT * FROM dominance_accounts WHERE owner_user_id=$1 AND is_active=TRUE ORDER BY updated_at DESC LIMIT 1`,[req.session.userId]);return r.rows[0]||null}
function parseText(v){if(!v)return null;try{return JSON.parse(v)}catch{return null}}
function safeAsset(a){const ev=platformBuild.evidenceSummary(a.brief||{});return{id:a.id,request_id:a.request_id,platform:a.platform,asset_category:a.asset_category,asset_format:a.asset_format,placement:a.placement,objective:a.objective,market:a.market,message_angle:a.message_angle,request_status:a.request_status,provider:a.provider,model:a.model,asset_type:a.asset_type,mime_type:a.mime_type,text_content:a.text_content,external_job_id:a.external_job_id,status:a.status,metadata:a.metadata,created_at:a.created_at,updated_at:a.updated_at,has_binary:Boolean(a.has_binary),content_url:a.has_binary?`/api/creative-intelligence/assets/${a.id}/content`:null,brief:a.brief||null,research_backed:ev.supported,evidence_sources:ev.sources,evidence_counts:{market:ev.market_signals.length,search:ev.search_intent.length,competitors:ev.competitor_context.length,competitor_changes:ev.competitor_events.length,measured_learning:ev.measured_learning.length},platform_requirements:a.brief?.platform_requirements||[]}}

function pipelineSummary(requests,assets){
 const request_status={};for(const r of requests)request_status[r.status]=(request_status[r.status]||0)+1;
 const asset_status={};for(const a of assets)asset_status[a.status]=(asset_status[a.status]||0)+1;
 const recent_errors=requests.filter(r=>r.last_error).slice(0,5).map(r=>({id:r.id,platform:r.platform,asset_category:r.asset_category,status:r.status,error:r.last_error,created_at:r.created_at}));
 return{
  request_status,asset_status,recent_errors,
  provider:{openai_configured:!!String(process.env.OPENAI_API_KEY||'').trim(),text_model:process.env.OPENAI_TEXT_MODEL||'gpt-5.6-terra',image_model:process.env.OPENAI_IMAGE_MODEL||'gpt-image-2',video_model:process.env.OPENAI_VIDEO_MODEL||null},
  production_interval_minutes:Math.max(1,Number(process.env.CREATIVE_PRODUCTION_INTERVAL_MINUTES||1))
 };
}

async function libraryState(account){
 await ensureGeneratedSchema(pool).catch(()=>{});
 const [requests,assets,keywords,marketEvents,compAssets,compEvents,learning,runs]=await Promise.all([
  pool.query(`SELECT id,platform,asset_category,asset_format,quantity,placement,objective,audience,market,message_angle,source,priority,status,worker_notes,last_error,created_at,completed_at FROM dominance_creative_requests WHERE dominance_account_id=$1 ORDER BY created_at DESC LIMIT 120`,[account.id]).catch(()=>({rows:[]})),
  pool.query(`SELECT g.id,g.request_id,g.provider,g.model,g.asset_type,g.mime_type,g.text_content,g.external_job_id,g.status,g.metadata,g.created_at,g.updated_at,(g.binary_content IS NOT NULL) has_binary,q.platform,q.asset_category,q.asset_format,q.placement,q.objective,q.market,q.message_angle,q.status request_status,o.content brief FROM dominance_generated_assets g JOIN dominance_creative_requests q ON q.id=g.request_id LEFT JOIN LATERAL(SELECT content FROM dominance_creative_request_outputs WHERE request_id=q.id AND output_type='production_brief' ORDER BY id DESC LIMIT 1)o ON TRUE WHERE g.dominance_account_id=$1 ORDER BY g.created_at DESC LIMIT 120`,[account.id]).catch(()=>({rows:[]})),
  pool.query(`SELECT phrase,dominant_intent,journey_stage,commerciality_score,priority,regional_momentum,last_researched_at FROM dominance_keyword_intelligence WHERE account_id=$1 AND active=TRUE ORDER BY commerciality_score DESC,priority DESC LIMIT 30`,[account.id]).catch(()=>({rows:[]})),
  pool.query(`SELECT event_type,geography_name,keyword,title,summary,score,confidence,intent_profile,last_detected_at FROM dominance_market_demand_events WHERE account_id=$1 AND status='active' ORDER BY score DESC,last_detected_at DESC LIMIT 20`,[account.id]).catch(()=>({rows:[]})),
  pool.query(`SELECT competitor_name,platform,asset_type,headline,body_copy,cta,message_angle,offer_type,media_url,last_seen_at,metadata FROM dominance_competitor_assets WHERE dominance_account_id=$1 AND active=TRUE ORDER BY last_seen_at DESC LIMIT 30`,[account.id]).catch(()=>({rows:[]})),
  pool.query(`SELECT event_type,severity,keyword,geography,title,summary,evidence,detected_at FROM dominance_competitor_events WHERE dominance_account_id=$1 ORDER BY detected_at DESC LIMIT 25`,[account.id]).catch(()=>({rows:[]})),
  pool.query(`SELECT platform,dimension,value,score,sample_size,impressions,clicks,spend,conversions,qualified_outcomes,revenue,updated_at FROM dominance_creative_learning WHERE account_key=$1 ORDER BY score DESC NULLS LAST,sample_size DESC LIMIT 25`,[account.account_key]).catch(()=>({rows:[]})),
  pool.query(`SELECT DISTINCT ON(worker_key) worker_key,status,details,finished_at FROM dominance_worker_account_runs WHERE account_id=$1 AND worker_key IN('creative-research-worker','creative-queue','creative-generation','creative-production-worker','market-intelligence-worker','competitor-intelligence-worker') ORDER BY worker_key,finished_at DESC`,[account.id]).catch(()=>({rows:[]}))
 ]);
 const safeAssets=assets.rows.map(safeAsset);
 return{
  ok:true,
  account:{id:account.id,account_key:account.account_key,company_name:account.company_name,website:account.website,industry_name:account.industry_name,industry_key:account.industry_key},
  research:{keywords:keywords.rows,market_events:marketEvents.rows,competitor_assets:compAssets.rows,competitor_events:compEvents.rows,performance:learning.rows},
  portfolio:{requests:requests.rows,assets:safeAssets},
  pipeline:pipelineSummary(requests.rows,safeAssets),
  workers:runs.rows
 };
}

async function promoteAsset(account,assetId){
 await executionGateway.ensureSchema(pool);
 const r=await pool.query(`SELECT g.*,q.platform,q.asset_category,q.asset_format,q.placement,q.objective,q.audience,q.market,q.message_angle,q.campaign_entity_id,q.prompt,q.constraints,o.content brief FROM dominance_generated_assets g JOIN dominance_creative_requests q ON q.id=g.request_id LEFT JOIN LATERAL(SELECT content FROM dominance_creative_request_outputs WHERE request_id=q.id AND output_type='production_brief' ORDER BY id DESC LIMIT 1)o ON TRUE WHERE g.id=$1 AND g.dominance_account_id=$2 LIMIT 1`,[assetId,account.id]);
 const a=r.rows[0];if(!a)throw Error('Creative asset not found.');
 const request={id:a.request_id,dominance_account_id:account.id,platform:a.platform,asset_category:a.asset_category,asset_format:a.asset_format,placement:a.placement,objective:a.objective,audience:a.audience,market:a.market,message_angle:a.message_angle,prompt:a.prompt,constraints:a.constraints};
 const manifest=platformBuild.creativeProvenanceManifest({account,request,asset:a,brief:a.brief||{}});
 if(!manifest.research_backed)throw Error('Creative cannot be approved for launch because no market, search, competitor, or measured performance evidence is attached to its production brief.');
 const parsed=parseText(a.text_content),variants=Array.isArray(parsed?.variants)&&parsed.variants.length?parsed.variants:[null];
 const campaign=a.campaign_entity_id?await pool.query(`SELECT name FROM dominance_campaign_entities WHERE id=$1 AND dominance_account_id=$2`,[a.campaign_entity_id,account.id]).catch(()=>({rows:[]})):null;
 const campaignName=campaign?.rows?.[0]?.name||'Creative Intelligence Portfolio',ids=[];
 for(const v of variants){
  let validation={valid:true,errors:[],warnings:[],rules:platformBuild.PLATFORM_RULES[platformBuild.normalizePlatform(a.platform)]||null};
  if(a.asset_category==='written_copy'){
    validation=platformBuild.validateCreativeForPlatform(a.platform,{...(v||{}),final_urls:v?.final_urls||[account.website]});
  }else if(a.asset_category==='images'||a.asset_category==='video'){
    validation=platformBuild.validateGeneratedAssetForPlatform(a.platform,a.asset_category,a.metadata||{});
  }
  if(!validation.valid)throw Error('Creative is research-backed but not platform-valid: '+validation.errors.join(' | '));
  const headline=Array.isArray(v?.headlines)?v.headlines[0]:(v?.headline||null);
  const body=v?.primary_text||v?.intro_text||(Array.isArray(v?.descriptions)?v.descriptions[0]:null)||v?.body_copy||(!a.binary_content?a.text_content:null);
  const cta=v?.cta||null,hook=v?.hook||null,angle=v?.message_angle||a.message_angle||null;
  const visual=a.asset_category==='images'?('Generated image · '+a.asset_format):a.asset_category==='video'?('Generated video · '+a.asset_format):null,assetUrl=a.binary_content?('/api/creative-intelligence/assets/'+a.id+'/content'):null;
  const metadata={creative_payload:v||{},generated_asset_id:a.id,request_id:a.request_id,research_manifest_hash:manifest.manifest_hash,platform_validation:{valid:validation.valid,errors:validation.errors,warnings:validation.warnings},platform_requirements:a.brief?.platform_requirements||[]};
  const ins=await pool.query(`INSERT INTO dominance_creatives(account_key,company_name,industry_key,platform,campaign_name,market,audience,message_angle,headline,body_copy,cta,creative_type,visual_style,hook,asset_url,status,source,approved_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'ready_to_launch','creative_intelligence',NOW(),$16::jsonb) RETURNING id`,[account.account_key,account.company_name,account.industry_key,a.platform,campaignName,a.market,a.audience,angle,headline,body,cta,a.asset_category,visual,hook,assetUrl,JSON.stringify(metadata)]);
  ids.push(ins.rows[0].id);
  await executionGateway.saveCreativeManifest(pool,{account,request,asset:a,brief:a.brief||{},creativeId:ins.rows[0].id});
 }
 await pool.query(`UPDATE dominance_generated_assets SET status='approved',updated_at=NOW() WHERE id=$1`,[a.id]);
 await pool.query(`UPDATE dominance_creative_requests SET status='approved',completed_at=COALESCE(completed_at,NOW()) WHERE id=$1`,[a.request_id]);
 await pool.query(`INSERT INTO dominance_activity(account_id,user_id,event_type,module,details) VALUES($1,NULL,'creative_asset_approved','creative_intelligence',$2::jsonb)`,[account.id,JSON.stringify({generated_asset_id:a.id,creative_ids:ids,campaign_name:campaignName,ready_to_launch:true,research_manifest_hash:manifest.manifest_hash})]).catch(()=>{});
 return{asset_id:a.id,creative_ids:ids,campaign_name:campaignName,status:'ready_to_launch',research_backed:true,research_manifest_hash:manifest.manifest_hash};
}

function startProductionSoon(){setImmediate(()=>runCreativeProduction().catch(e=>console.error('[CREATIVE LIBRARY] production trigger',e.message||e)))}

function attach(router){
 router.get('/api/creative-intelligence/library',auth,async(req,res)=>{try{const a=await accountFor(req);if(!a)return res.status(400).json({ok:false,error:'Create a customer account first.'});res.json(await libraryState(a))}catch(e){res.status(500).json({ok:false,error:e.message})}});
 router.post('/api/creative-intelligence/research',auth,async(req,res)=>{try{const a=await accountFor(req);if(!a)return res.status(400).json({ok:false,error:'Create a customer account first.'});const result=await runCreativeResearch();startProductionSoon();res.json({ok:true,result,production_started:true,state:await libraryState(a)})}catch(e){res.status(500).json({ok:false,error:e.message})}});
 router.post('/api/creative-intelligence/produce',auth,async(req,res)=>{try{const a=await accountFor(req);if(!a)return res.status(400).json({ok:false,error:'Create a customer account first.'});startProductionSoon();res.json({ok:true,status:'production_started'})}catch(e){res.status(500).json({ok:false,error:e.message})}});
 router.get('/api/creative-intelligence/assets/:id/content',auth,async(req,res)=>{try{const a=await accountFor(req);if(!a)return res.status(404).end();const r=await pool.query(`SELECT mime_type,binary_content FROM dominance_generated_assets WHERE id=$1 AND dominance_account_id=$2 LIMIT 1`,[Number(req.params.id),a.id]);if(!r.rowCount||!r.rows[0].binary_content)return res.status(404).end();res.type(r.rows[0].mime_type||'application/octet-stream').send(r.rows[0].binary_content)}catch(e){res.status(500).end()}});
 router.post('/api/creative-intelligence/assets/:id/approve',auth,async(req,res)=>{try{const a=await accountFor(req);if(!a)return res.status(400).json({ok:false,error:'Create a customer account first.'});res.json({ok:true,...await promoteAsset(a,Number(req.params.id))})}catch(e){res.status(400).json({ok:false,error:e.message})}});
 router.post('/api/creative-intelligence/assets/:id/reject',auth,async(req,res)=>{try{const a=await accountFor(req);if(!a)return res.status(400).json({ok:false,error:'Create a customer account first.'});const r=await pool.query(`UPDATE dominance_generated_assets SET status='rejected',updated_at=NOW() WHERE id=$1 AND dominance_account_id=$2 RETURNING id`,[Number(req.params.id),a.id]);res.json({ok:Boolean(r.rowCount),id:r.rows[0]?.id||null})}catch(e){res.status(400).json({ok:false,error:e.message})}})
}

module.exports={attach};
