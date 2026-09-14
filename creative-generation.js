const crypto=require('crypto');

const OPENAI_API_KEY=process.env.OPENAI_API_KEY||'';
const TEXT_MODEL=process.env.OPENAI_TEXT_MODEL||'gpt-5.6-terra';
const IMAGE_MODEL=process.env.OPENAI_IMAGE_MODEL||'gpt-image-2.5-flare';
const VIDEO_MODEL=process.env.OPENAI_VIDEO_MODEL||'';

async function ensureSchema(pool){
 await pool.query(`CREATE TABLE IF NOT EXISTS dominance_generated_assets(
   id BIGSERIAL PRIMARY KEY,
   dominance_account_id BIGINT REFERENCES dominance_accounts(id) ON DELETE CASCADE,
   request_id BIGINT REFERENCES dominance_creative_requests(id) ON DELETE CASCADE,
   output_id BIGINT REFERENCES dominance_creative_request_outputs(id) ON DELETE SET NULL,
   provider TEXT NOT NULL,
   model TEXT,
   asset_type TEXT NOT NULL,
   mime_type TEXT,
   text_content TEXT,
   binary_content BYTEA,
   external_job_id TEXT,
   checksum TEXT,
   status TEXT NOT NULL DEFAULT 'draft',
   metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`);
 await pool.query(`CREATE INDEX IF NOT EXISTS idx_dom_generated_assets_request ON dominance_generated_assets(request_id,status,created_at)`);
}

function authHeaders(){return{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'}}
async function openaiJson(path,body){
 const r=await fetch('https://api.openai.com/v1'+path,{method:'POST',headers:authHeaders(),body:JSON.stringify(body)});
 const d=await r.json().catch(()=>({}));
 if(!r.ok)throw Error(d.error?.message||`OpenAI API ${r.status}`);
 return d;
}
function outputText(d){
 if(typeof d.output_text==='string')return d.output_text;
 const chunks=[];
 for(const item of d.output||[])for(const c of item.content||[])if(c.type==='output_text'&&c.text)chunks.push(c.text);
 return chunks.join('\n').trim();
}
function assetPrompt(brief){
 const a=brief.assignment||{},c=brief.company||{},dest=brief.destination||{},intel=brief.intelligence||{};
 return `Create production-ready ${a.asset_category} for ${c.name||'the company'} (${c.industry||'business'}).\nPlatform: ${dest.platform||''}\nFormat: ${a.asset_format||''}\nPlacement: ${a.placement||''}\nObjective: ${a.objective||''}\nAudience: ${a.audience||''}\nMarket: ${a.market||''}\nMessage angle: ${a.message_angle||''}\nOriginal brief: ${brief.source_prompt||''}\nPlatform requirements: ${(brief.platform_requirements||[]).join('; ')}\nStrategic direction: ${JSON.stringify(brief.strategic_direction||{})}\nMarket signals: ${JSON.stringify((intel.market_signals||[]).slice(0,4))}\nWinning patterns: ${JSON.stringify((intel.winning_patterns||[]).slice(0,4))}\nCompetitor context: ${JSON.stringify((intel.competitor_context||[]).slice(0,4))}\nImportant: differentiate from competitors; do not copy competitor wording or visuals.`;
}
function imageSize(brief){
 const p=String(brief.assignment?.placement||'').toLowerCase(),f=String(brief.assignment?.asset_format||'').toLowerCase();
 if(/story|reel|vertical|9:16|portrait/.test(p+' '+f))return'1024x1536';
 if(/landscape|1.91|16:9|banner/.test(p+' '+f))return'1536x1024';
 return'1024x1024';
}
async function generateText(brief){
 const prompt=assetPrompt(brief)+`\nReturn valid JSON only with keys: variants (array). Each variant should include headline, body_copy, cta, hook, message_angle, rationale, platform_notes. Produce ${Math.max(1,Number(brief.assignment?.quantity||1))} distinct variants.`;
 const d=await openaiJson('/responses',{model:TEXT_MODEL,input:prompt,store:false});
 const text=outputText(d);
 let parsed=null;try{parsed=JSON.parse(text)}catch{}
 return{provider:'openai',model:TEXT_MODEL,mime_type:'application/json',text_content:text,metadata:{parsed:parsed||null,response_id:d.id||null}};
}
async function generateImage(brief){
 const d=await openaiJson('/images/generations',{model:IMAGE_MODEL,prompt:assetPrompt(brief),size:imageSize(brief),quality:'medium',n:Math.max(1,Math.min(4,Number(brief.assignment?.quantity||1)))});
 const images=[];
 for(const x of d.data||[]){if(x.b64_json)images.push(Buffer.from(x.b64_json,'base64'))}
 if(!images.length)throw Error('Image provider returned no image bytes');
 return images.map((buf,i)=>({provider:'openai',model:IMAGE_MODEL,mime_type:'image/png',binary_content:buf,checksum:crypto.createHash('sha256').update(buf).digest('hex'),metadata:{index:i,size:imageSize(brief),quality:'medium'}}));
}
async function generateVideo(brief){
 if(!VIDEO_MODEL)return[{provider:'unconfigured',model:null,mime_type:'application/json',text_content:JSON.stringify({status:'awaiting_video_provider',brief}),metadata:{reason:'OPENAI_VIDEO_MODEL is not configured'}}];
 const vertical=/story|reel|vertical|9:16|tiktok/i.test(String(brief.assignment?.placement||'')+' '+String(brief.assignment?.asset_format||''));
 const d=await openaiJson('/videos',{model:VIDEO_MODEL,prompt:assetPrompt(brief),seconds:'8',size:vertical?'720x1280':'1280x720'});
 return[{provider:'openai',model:VIDEO_MODEL,mime_type:'video/mp4',external_job_id:d.id,status:d.status||'queued',metadata:{progress:d.progress||0,size:d.size,seconds:d.seconds}}];
}
async function createAssetRows(pool,req,output,assets){
 const ids=[];
 for(const a of assets){
   const r=await pool.query(`INSERT INTO dominance_generated_assets(dominance_account_id,request_id,output_id,provider,model,asset_type,mime_type,text_content,binary_content,external_job_id,checksum,status,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING id`,[req.dominance_account_id,req.id,output.id,a.provider,a.model,req.asset_category,a.mime_type||null,a.text_content||null,a.binary_content||null,a.external_job_id||null,a.checksum||null,a.status||'review',JSON.stringify(a.metadata||{})]);
   ids.push(r.rows[0].id);
 }
 return ids;
}
async function claimReview(pool){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const r=await c.query(`SELECT q.*,o.id AS output_id,o.content AS brief FROM dominance_creative_requests q JOIN LATERAL(SELECT id,content FROM dominance_creative_request_outputs WHERE request_id=q.id AND output_type='production_brief' ORDER BY id DESC LIMIT 1)o ON TRUE WHERE q.status='review' AND NOT EXISTS(SELECT 1 FROM dominance_generated_assets g WHERE g.request_id=q.id) ORDER BY q.priority DESC,q.created_at ASC FOR UPDATE OF q SKIP LOCKED LIMIT 1`);
  const row=r.rows[0];if(!row){await c.query('COMMIT');return null}
  await c.query(`UPDATE dominance_creative_requests SET status='generating' WHERE id=$1`,[row.id]);
  await c.query('COMMIT');return row;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
}
async function processOne(pool){
 if(!OPENAI_API_KEY)return{processed:0,reason:'OPENAI_API_KEY not configured'};
 const req=await claimReview(pool);if(!req)return{processed:0};
 try{
   const brief=req.brief||{};let assets;
   if(req.asset_category==='images')assets=await generateImage(brief);
   else if(req.asset_category==='video')assets=await generateVideo(brief);
   else assets=[await generateText(brief)];
   const ids=await createAssetRows(pool,req,{id:req.output_id},assets);
   const hasAsync=assets.some(x=>x.external_job_id&&x.status!=='completed');
   await pool.query(`UPDATE dominance_creative_requests SET status=$2,completed_at=CASE WHEN $2='approval' THEN NOW() ELSE completed_at END,worker_notes=worker_notes||$3::jsonb WHERE id=$1`,[req.id,hasAsync?'generating':'approval',JSON.stringify({generation_engine:true,generated_asset_ids:ids,generated_at:new Date().toISOString()})]);
   await pool.query(`UPDATE dominance_creative_request_outputs SET status=$2,content=content||$3::jsonb WHERE id=$1`,[req.output_id,hasAsync?'generating':'approval',JSON.stringify({generated_asset_ids:ids})]);
   await pool.query(`INSERT INTO dominance_activity(account_id,event_type,module,details) VALUES($1,'creative_assets_generated','creative_intelligence',$2::jsonb)`,[req.dominance_account_id,JSON.stringify({request_id:req.id,asset_ids:ids,category:req.asset_category,platform:req.platform})]);
   console.log(`[CREATIVE GENERATION] request=${req.id} category=${req.asset_category} assets=${ids.length} status=${hasAsync?'generating':'approval'}`);
   return{processed:1,request_id:req.id,asset_ids:ids};
 }catch(e){
   await pool.query(`UPDATE dominance_creative_requests SET status='review',last_error=$2,retry_count=retry_count+1 WHERE id=$1`,[req.id,String(e.message||e).slice(0,2000)]).catch(()=>{});
   console.error(`[CREATIVE GENERATION] request=${req.id} error=${e.message||e}`);return{processed:0,error:String(e.message||e)};
 }
}
async function pollVideos(pool){
 if(!OPENAI_API_KEY||!VIDEO_MODEL)return 0;
 const r=await pool.query(`SELECT * FROM dominance_generated_assets WHERE asset_type='video' AND provider='openai' AND external_job_id IS NOT NULL AND status IN('queued','in_progress','generating') ORDER BY updated_at ASC LIMIT 5`);
 let changed=0;
 for(const a of r.rows){
  try{
   const resp=await fetch(`https://api.openai.com/v1/videos/${encodeURIComponent(a.external_job_id)}`,{headers:{Authorization:`Bearer ${OPENAI_API_KEY}`}});const d=await resp.json();if(!resp.ok)throw Error(d.error?.message||`Video status ${resp.status}`);
   if(d.status==='completed'){
    const cr=await fetch(`https://api.openai.com/v1/videos/${encodeURIComponent(a.external_job_id)}/content`,{headers:{Authorization:`Bearer ${OPENAI_API_KEY}`}});if(!cr.ok)throw Error(`Video download ${cr.status}`);const buf=Buffer.from(await cr.arrayBuffer());
    await pool.query(`UPDATE dominance_generated_assets SET binary_content=$2,checksum=$3,status='review',metadata=metadata||$4::jsonb,updated_at=NOW() WHERE id=$1`,[a.id,buf,crypto.createHash('sha256').update(buf).digest('hex'),JSON.stringify({progress:100})]);
    await pool.query(`UPDATE dominance_creative_requests SET status='approval',completed_at=NOW() WHERE id=$1`,[a.request_id]);changed++;
   }else if(d.status==='failed')await pool.query(`UPDATE dominance_generated_assets SET status='failed',metadata=metadata||$2::jsonb,updated_at=NOW() WHERE id=$1`,[a.id,JSON.stringify({error:d.error||null})]);
   else await pool.query(`UPDATE dominance_generated_assets SET status=$2,metadata=metadata||$3::jsonb,updated_at=NOW() WHERE id=$1`,[a.id,d.status||'in_progress',JSON.stringify({progress:d.progress||0})]);
  }catch(e){console.error('[CREATIVE GENERATION] video poll error',a.id,e.message||e)}
 }
 return changed;
}
async function processGenerationQueue(pool,{maxJobs=2}={}){await ensureSchema(pool);await pollVideos(pool);let processed=0;for(let i=0;i<maxJobs;i++){const r=await processOne(pool);processed+=r.processed||0;if(!r.processed)break}return{processed}}
module.exports={processGenerationQueue,ensureSchema};
