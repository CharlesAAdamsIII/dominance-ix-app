async function ensureSmokeTable(pool){
 await pool.query(`CREATE TABLE IF NOT EXISTS dominance_smoke_tests(
   test_key TEXT PRIMARY KEY,
   status TEXT NOT NULL DEFAULT 'pending',
   details JSONB NOT NULL DEFAULT '{}'::jsonb,
   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`);
}

async function getActiveAccount(pool){
 const r=await pool.query(`SELECT id,company_name,account_key,industry_key,industry_name FROM dominance_accounts WHERE is_active=TRUE ORDER BY updated_at DESC LIMIT 1`);
 return r.rows[0]||null;
}

async function getTestState(pool,key){
 const r=await pool.query(`SELECT * FROM dominance_smoke_tests WHERE test_key=$1`,[key]);
 return r.rows[0]||null;
}

async function setTestState(pool,key,status,details={}){
 await pool.query(`INSERT INTO dominance_smoke_tests(test_key,status,details,updated_at) VALUES($1,$2,$3::jsonb,NOW()) ON CONFLICT(test_key) DO UPDATE SET status=EXCLUDED.status,details=EXCLUDED.details,updated_at=NOW()`,[key,status,JSON.stringify(details)]);
}

async function enqueueText(pool,account,key){
 const r=await pool.query(`INSERT INTO dominance_creative_requests(
   dominance_account_id,platform,asset_category,asset_format,quantity,placement,objective,audience,market,message_angle,prompt,constraints,source,priority,status,worker_notes
 ) VALUES($1,'Google Ads','written_copy','responsive_search_ad',1,'Search','Lead generation','Adults and decision-makers seeking behavioral health treatment resources','Philadelphia, Pennsylvania','Evidence-led local access and outcomes','Create a localized Google Search ad test for behavioral healthcare services in the Philadelphia market. Use only facts supported by DOMINANCE collected intelligence. Differentiate from competitor messaging and optimize for qualified inquiries, not vanity clicks.','{"smoke_test":true,"require_local_evidence":true,"no_unverified_claims":true}'::jsonb,'smoke_test',99,'queued',$2::jsonb) RETURNING id`,[account.id,JSON.stringify({smoke_test_key:key,stage:'text'})]);
 return r.rows[0].id;
}

async function enqueueImage(pool,account,key){
 const r=await pool.query(`INSERT INTO dominance_creative_requests(
   dominance_account_id,platform,asset_category,asset_format,quantity,placement,objective,audience,market,message_angle,prompt,constraints,source,priority,status,worker_notes
 ) VALUES($1,'Google Ads','images','1:1 square',1,'Display / Performance Max','Lead generation','Adults and decision-makers seeking behavioral health treatment resources','Philadelphia, Pennsylvania','Trust, accessibility and evidence-led care','Create one localized square visual concept for a Philadelphia behavioral healthcare campaign. Use the approved market context and avoid stereotypical or exploitative depictions of mental health or addiction. Do not include unsupported statistics or competitor branding.','{"smoke_test":true,"require_local_evidence":true,"no_unverified_claims":true,"avoid_sensitive_stereotypes":true}'::jsonb,'smoke_test',98,'queued',$2::jsonb) RETURNING id`,[account.id,JSON.stringify({smoke_test_key:key,stage:'image'})]);
 return r.rows[0].id;
}

async function requestStatus(pool,id){
 if(!id)return null;
 const r=await pool.query(`SELECT id,status,last_error,worker_notes,completed_at FROM dominance_creative_requests WHERE id=$1`,[id]);
 return r.rows[0]||null;
}

async function runCreativeSmokeTest(pool){
 if(String(process.env.DOMINANCE_RUN_SMOKE_TEST||'').toLowerCase()!=='true')return{enabled:false};
 await ensureSmokeTable(pool);
 const key='philadelphia-behavioral-health-v1';
 const account=await getActiveAccount(pool);
 if(!account)return{enabled:true,status:'waiting_for_account'};
 let state=await getTestState(pool,key);
 let d=state?.details||{};
 if(!state){
   const textId=await enqueueText(pool,account,key);
   d={account_id:account.id,text_request_id:textId,started_at:new Date().toISOString()};
   await setTestState(pool,key,'text_queued',d);
   console.log(`[SMOKE TEST] text request queued id=${textId} market=Philadelphia, Pennsylvania`);
   return{enabled:true,status:'text_queued',text_request_id:textId};
 }
 const textReq=await requestStatus(pool,d.text_request_id);
 if(state.status==='text_queued'||state.status==='text_running'){
   if(textReq?.status==='approval'){
     const imageId=d.image_request_id||await enqueueImage(pool,account,key);
     d={...d,text_status:'approval',image_request_id:imageId,text_completed_at:new Date().toISOString()};
     await setTestState(pool,key,'image_queued',d);
     console.log(`[SMOKE TEST] text passed; image request queued id=${imageId}`);
     return{enabled:true,status:'image_queued',image_request_id:imageId};
   }
   if(textReq?.status==='failed'){
     d={...d,text_status:'failed',text_error:textReq.last_error};await setTestState(pool,key,'failed',d);
     console.error(`[SMOKE TEST] text failed | ${textReq.last_error||'unknown error'}`);
     return{enabled:true,status:'failed',stage:'text'};
   }
   await setTestState(pool,key,'text_running',{...d,text_status:textReq?.status||'unknown'});
   return{enabled:true,status:'text_running',request_status:textReq?.status};
 }
 if(state.status==='image_queued'||state.status==='image_running'){
   const imageReq=await requestStatus(pool,d.image_request_id);
   if(imageReq?.status==='approval'){
     const assets=await pool.query(`SELECT id,asset_type,mime_type,status,model,provider,created_at FROM dominance_generated_assets WHERE request_id=$1 ORDER BY id`,[d.image_request_id]);
     const outputs=await pool.query(`SELECT id,status,output_type,created_at FROM dominance_creative_request_outputs WHERE request_id IN($1,$2) ORDER BY id`,[d.text_request_id,d.image_request_id]);
     d={...d,image_status:'approval',completed_at:new Date().toISOString(),generated_assets:assets.rows,outputs:outputs.rows};
     await setTestState(pool,key,'passed',d);
     console.log(`[SMOKE TEST] PASSED | text=${d.text_request_id} image=${d.image_request_id} assets=${assets.rowCount}`);
     return{enabled:true,status:'passed',details:d};
   }
   if(imageReq?.status==='failed'){
     d={...d,image_status:'failed',image_error:imageReq.last_error};await setTestState(pool,key,'failed',d);
     console.error(`[SMOKE TEST] image failed | ${imageReq.last_error||'unknown error'}`);
     return{enabled:true,status:'failed',stage:'image'};
   }
   await setTestState(pool,key,'image_running',{...d,image_status:imageReq?.status||'unknown'});
   return{enabled:true,status:'image_running',request_status:imageReq?.status};
 }
 return{enabled:true,status:state.status,details:d};
}

module.exports={runCreativeSmokeTest};
