function safe(v,fallback=''){return v===null||v===undefined?fallback:v}
function arr(v){return Array.isArray(v)?v:[]}

const PLATFORM_RULES={
  'Google Ads':{
    written_copy:['15 headlines <=30 chars','4 descriptions <=90 chars','2 CTA variants','keyword-to-message alignment'],
    images:['1.91:1 landscape','1:1 square','4:5 portrait','minimal embedded text','brand-safe contrast'],
    video:['6s bumper concept','15s cut','30s cut','first 3s hook','clear end-card CTA'],
    landing_page:['message match to ad group','single primary CTA','proof above fold','fast mobile layout']
  },
  'Microsoft Ads':{
    written_copy:['RSA headlines/descriptions','B2B efficiency angle','keyword-to-message alignment'],
    images:['audience-network native image','1.91:1 landscape','1:1 square'],
    video:['short proof-led explainer'],
    landing_page:['search-message continuity','desktop + mobile proof hierarchy']
  },
  'Meta':{
    written_copy:['3 primary-text variants','5 headline variants','2 description variants','CTA options'],
    images:['1:1 feed','4:5 feed','9:16 story/reel','pattern-break visual'],
    video:['9:16 vertical','hook in first 2 seconds','15-30 second cut','caption-safe framing'],
    landing_page:['mobile-first','ad-to-page visual continuity','short conversion path']
  },
  'LinkedIn':{
    written_copy:['executive hook','proof/stat variant','document-ad intro','CTA variant'],
    images:['1.91:1 sponsored content','1:1 stat graphic','document cover'],
    video:['15-30 second executive explainer','subtitles','business outcome first'],
    landing_page:['executive value proposition','proof/case evidence','lead-form alignment']
  },
  'TikTok':{
    written_copy:['UGC hook','caption copy','CTA line'],
    images:['9:16 cover frame'],
    video:['9:16 native vertical','hook <2 seconds','creator-style delivery','motion/data overlay'],
    landing_page:['fast mobile load','single CTA','message continuity']
  },
  'YouTube / DV360':{
    written_copy:['video title/description','CTA line','companion-banner copy'],
    images:['16:9 companion','1:1 display adaptation'],
    video:['6s bumper','15s non-skippable concept','30s skippable concept','brand + problem in first 5s'],
    landing_page:['video-message continuity','proof-led hero','single next step']
  }
};

function ruleSet(platform,category){
  const rules=PLATFORM_RULES[platform]||PLATFORM_RULES['Google Ads'];
  return rules[category]||rules.written_copy||[];
}

async function claimNext(pool){
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const r=await c.query(`
      SELECT * FROM dominance_creative_requests
      WHERE status='queued' AND retry_count < max_attempts
      ORDER BY priority DESC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    const row=r.rows[0];
    if(!row){await c.query('COMMIT');return null}
    await c.query(`UPDATE dominance_creative_requests SET status='claimed',claimed_at=NOW(),last_error=NULL WHERE id=$1`,[row.id]);
    await c.query('COMMIT');
    return row;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
}

async function hierarchy(pool,entityId){
  if(!entityId)return[];
  const r=await pool.query(`
    WITH RECURSIVE tree AS (
      SELECT id,parent_entity_id,entity_type,name,platform,objective,market,targeting,settings,performance,0 AS depth
      FROM dominance_campaign_entities WHERE id=$1
      UNION ALL
      SELECT p.id,p.parent_entity_id,p.entity_type,p.name,p.platform,p.objective,p.market,p.targeting,p.settings,p.performance,t.depth+1
      FROM dominance_campaign_entities p JOIN tree t ON t.parent_entity_id=p.id
    ) SELECT * FROM tree ORDER BY depth DESC
  `,[entityId]);
  return r.rows;
}

async function enrich(pool,req){
  const [accountR,adR,tree,marketR,learningR,competitorR,recoR]=await Promise.all([
    pool.query('SELECT id,company_name,website,industry_key,industry_name,analysis FROM dominance_accounts WHERE id=$1',[req.dominance_account_id]),
    req.ad_account_id?pool.query('SELECT * FROM dominance_ad_accounts WHERE id=$1',[req.ad_account_id]):Promise.resolve({rows:[]}),
    hierarchy(pool,req.campaign_entity_id),
    pool.query(`SELECT geography_name,geography_type,source_key,observed_volume,velocity_pct,acceleration_pct,opportunity_score,confidence,signal_state,metrics,captured_at FROM dominance_market_snapshots WHERE account_id=$1 ORDER BY captured_at DESC,opportunity_score DESC LIMIT 12`,[req.dominance_account_id]),
    pool.query(`SELECT platform,dimension,value,score,sample_size,updated_at FROM dominance_creative_learning WHERE account_key=(SELECT account_key FROM dominance_accounts WHERE id=$1) ORDER BY score DESC NULLS LAST,updated_at DESC LIMIT 12`,[req.dominance_account_id]),
    pool.query(`SELECT competitor_name,platform,asset_type,headline,body_copy,cta,message_angle,offer_type,last_seen_at,metadata FROM dominance_competitor_assets WHERE dominance_account_id=$1 AND active=TRUE ORDER BY last_seen_at DESC LIMIT 12`,[req.dominance_account_id]),
    pool.query(`SELECT recommendation_type,title,rationale,recommended_action,expected_impact,confidence,priority FROM dominance_asset_recommendations WHERE dominance_account_id=$1 AND status='open' ORDER BY priority DESC,confidence DESC NULLS LAST LIMIT 8`,[req.dominance_account_id])
  ]);
  return{account:accountR.rows[0]||{},ad_account:adR.rows[0]||null,hierarchy:tree,market_signals:marketR.rows,creative_learning:learningR.rows,competitor_assets:competitorR.rows,recommendations:recoR.rows};
}

function summarizeHierarchy(tree){return tree.map(x=>`${x.entity_type}: ${x.name}`).join(' > ')}
function topSignals(rows){return rows.slice(0,5).map(x=>({market:x.geography_name,state:x.signal_state,opportunity:Number(x.opportunity_score||0),velocity:Number(x.velocity_pct||0),confidence:Number(x.confidence||0),source:x.source_key}))}
function topLearning(rows){return rows.slice(0,5).map(x=>({dimension:x.dimension,value:x.value,score:Number(x.score||0),sample_size:Number(x.sample_size||0),platform:x.platform}))}
function topCompetitors(rows){return rows.slice(0,5).map(x=>({competitor:x.competitor_name,platform:x.platform,type:x.asset_type,headline:x.headline,message_angle:x.message_angle,offer_type:x.offer_type,last_seen_at:x.last_seen_at}))}

function buildBrief(req,ctx){
  const account=ctx.account||{};
  const category=req.asset_category;
  const platform=req.platform;
  const rules=ruleSet(platform,category);
  const hierarchyPath=summarizeHierarchy(ctx.hierarchy);
  const campaignLeaf=ctx.hierarchy[ctx.hierarchy.length-1]||{};
  const brief={
    brief_version:'1.0',
    generated_by:'DOMINANCE Intelligence Worker',
    generated_at:new Date().toISOString(),
    request_id:req.id,
    company:{name:account.company_name,website:account.website,industry:account.industry_name||account.industry_key},
    destination:{platform,ad_account:ctx.ad_account?{id:ctx.ad_account.external_account_id,name:ctx.ad_account.account_name}:null,campaign_path:hierarchyPath||null,campaign_entity_id:req.campaign_entity_id||null},
    assignment:{asset_category:category,asset_format:req.asset_format,quantity:req.quantity,placement:req.placement,objective:req.objective||campaignLeaf.objective||null,audience:req.audience||null,market:req.market||campaignLeaf.market||null,message_angle:req.message_angle||null,priority:req.priority},
    source_prompt:req.prompt,
    platform_requirements:rules,
    constraints:req.constraints||{},
    intelligence:{market_signals:topSignals(ctx.market_signals),winning_patterns:topLearning(ctx.creative_learning),competitor_context:topCompetitors(ctx.competitor_assets),open_recommendations:ctx.recommendations.slice(0,5)},
    strategic_direction:{
      primary_goal:req.objective||campaignLeaf.objective||'qualified business outcome',
      differentiation_instruction:'Use competitor intelligence to identify saturated claims and produce a differentiated response; do not imitate competitor creative.',
      proof_instruction:'Prefer measurable proof, specific outcomes and message-to-market relevance over generic capability claims.',
      learning_instruction:'Preserve the asset variables needed for later attribution: hook, message angle, CTA, visual treatment, offer, audience, market and placement.'
    },
    deliverables:Array.from({length:Math.max(1,Number(req.quantity||1))},(_,i)=>({variant:i+1,format:req.asset_format,category,platform,placement:req.placement||'platform default',status:'to_produce'})),
    test_plan:{control:'Current best-performing eligible asset when available',variables:['hook','message_angle','cta','visual_treatment','offer'],success_metric:'qualified outcome efficiency',minimum_rule:'Do not declare a winner from low-volume vanity metrics alone.'},
    routing:{destination_module:'Creative Intelligence',campaign_manager_linked:true,approval_required:true,next_status:'review'}
  };
  return brief;
}

async function complete(pool,req,brief){
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    await c.query(`INSERT INTO dominance_creative_request_outputs(request_id,output_type,content,status) VALUES($1,'production_brief',$2::jsonb,'draft')`,[req.id,JSON.stringify(brief)]);
    await c.query(`UPDATE dominance_creative_requests SET status='review',completed_at=NOW(),worker_notes=$2::jsonb,last_error=NULL WHERE id=$1`,[req.id,JSON.stringify({production_brief_generated:true,generated_at:brief.generated_at,destination:'Creative Intelligence'})]);
    await c.query(`INSERT INTO dominance_activity(account_id,event_type,module,details) VALUES($1,'creative_brief_generated','creative_intelligence',$2::jsonb)`,[req.dominance_account_id,JSON.stringify({request_id:req.id,platform:req.platform,asset_category:req.asset_category,asset_format:req.asset_format,campaign_entity_id:req.campaign_entity_id})]);
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
}

async function fail(pool,req,error){
  const message=String(error?.message||error).slice(0,2000);
  await pool.query(`UPDATE dominance_creative_requests SET retry_count=retry_count+1,status=CASE WHEN retry_count+1>=max_attempts THEN 'failed' ELSE 'queued' END,last_error=$2,worker_notes=worker_notes||$3::jsonb WHERE id=$1`,[req.id,message,JSON.stringify({last_failed_at:new Date().toISOString()})]);
}

async function promoteRecommendations(pool){
  const r=await pool.query(`
    SELECT r.* FROM dominance_asset_recommendations r
    WHERE r.status='open' AND r.auto_action_eligible=TRUE AND COALESCE(r.confidence,0)>=0.80
      AND NOT EXISTS (
        SELECT 1 FROM dominance_creative_requests q
        WHERE q.source='asset_intelligence' AND (q.worker_notes->>'recommendation_id')::bigint=r.id
      )
    ORDER BY r.priority DESC,r.confidence DESC NULLS LAST LIMIT 10
  `);
  let n=0;
  for(const rec of r.rows){
    const action=rec.recommended_action||{};
    const category=action.asset_category||'written_copy';
    const format=action.asset_format||'platform_native';
    const prompt=action.prompt||`${rec.title}. ${rec.rationale}`;
    await pool.query(`INSERT INTO dominance_creative_requests(dominance_account_id,campaign_entity_id,platform,asset_category,asset_format,quantity,placement,objective,audience,market,message_angle,prompt,constraints,source,priority,status,worker_notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'asset_intelligence',$14,'queued',$15::jsonb)`,[rec.dominance_account_id,rec.campaign_entity_id,rec.platform||'Google Ads',category,format,Number(action.quantity||1),action.placement||null,action.objective||null,action.audience||null,action.market||null,action.message_angle||null,prompt,JSON.stringify(action.constraints||{}),rec.priority,JSON.stringify({recommendation_id:rec.id,auto_generated:true})]);
    await pool.query(`UPDATE dominance_asset_recommendations SET status='queued' WHERE id=$1`,[rec.id]);
    n++;
  }
  return n;
}

async function processCreativeQueue(pool,{maxJobs=5}={}){
  if(!pool)return{processed:0,promoted:0};
  const promoted=await promoteRecommendations(pool).catch(e=>{console.error('[CREATIVE QUEUE] recommendation promotion error:',e.message||e);return 0});
  let processed=0;
  for(let i=0;i<maxJobs;i++){
    const req=await claimNext(pool);
    if(!req)break;
    try{
      console.log(`[CREATIVE QUEUE] claimed request=${req.id} platform=${req.platform} category=${req.asset_category} format=${req.asset_format}`);
      const ctx=await enrich(pool,req);
      const brief=buildBrief(req,ctx);
      await complete(pool,req,brief);
      processed++;
      console.log(`[CREATIVE QUEUE] brief ready request=${req.id} route=Creative Intelligence`);
    }catch(e){
      console.error(`[CREATIVE QUEUE] request=${req.id} error=${e.message||e}`);
      await fail(pool,req,e).catch(()=>{});
    }
  }
  return{processed,promoted};
}

module.exports={processCreativeQueue};
