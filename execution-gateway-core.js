'use strict';

const build=require('./platform-build-core');

async function ensureSchema(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS dominance_creative_provenance(
    id BIGSERIAL PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES dominance_accounts(id) ON DELETE CASCADE,
    creative_id BIGINT REFERENCES dominance_creatives(id) ON DELETE CASCADE,
    generated_asset_id BIGINT,
    request_id BIGINT,
    platform TEXT,
    manifest_hash TEXT NOT NULL,
    research_backed BOOLEAN NOT NULL DEFAULT FALSE,
    manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(creative_id)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dom_creative_prov_account ON dominance_creative_provenance(account_id,platform,created_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dominance_execution_builds(
    id BIGSERIAL PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES dominance_accounts(id) ON DELETE CASCADE,
    recommendation_id BIGINT NOT NULL REFERENCES dominance_ad_recommendations(id) ON DELETE CASCADE,
    platform TEXT,
    operation TEXT,
    spec JSONB NOT NULL DEFAULT '{}'::jsonb,
    validation JSONB NOT NULL DEFAULT '{}'::jsonb,
    research_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(recommendation_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dominance_execution_receipts(
    id BIGSERIAL PRIMARY KEY,
    queue_id BIGINT REFERENCES dominance_ad_execution_queue(id) ON DELETE SET NULL,
    recommendation_id BIGINT REFERENCES dominance_ad_recommendations(id) ON DELETE SET NULL,
    account_id BIGINT REFERENCES dominance_accounts(id) ON DELETE CASCADE,
    platform TEXT,
    operation TEXT,
    status TEXT NOT NULL,
    request JSONB NOT NULL DEFAULT '{}'::jsonb,
    response JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dom_exec_receipts_queue ON dominance_execution_receipts(queue_id,created_at DESC)`);
}

async function saveCreativeManifest(pool,{account,request,asset,brief,creativeId}){
  await ensureSchema(pool);
  const manifest=build.creativeProvenanceManifest({account,request,asset,brief});
  const r=await pool.query(`INSERT INTO dominance_creative_provenance(account_id,creative_id,generated_asset_id,request_id,platform,manifest_hash,research_backed,manifest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    ON CONFLICT(creative_id) DO UPDATE SET generated_asset_id=EXCLUDED.generated_asset_id,request_id=EXCLUDED.request_id,platform=EXCLUDED.platform,manifest_hash=EXCLUDED.manifest_hash,research_backed=EXCLUDED.research_backed,manifest=EXCLUDED.manifest
    RETURNING *`,[account.id,creativeId,asset?.id||null,request?.id||asset?.request_id||null,manifest.platform,manifest.manifest_hash,manifest.research_backed,JSON.stringify(manifest)]);
  return r.rows[0];
}

async function researchManifestForRecommendation(pool,recommendation){
  const action=recommendation?.action||{};
  const creativeIds=(action.creative_ids||[]).map(Number).filter(Number.isFinite);
  const assetIds=(action.generated_asset_ids||[]).map(Number).filter(Number.isFinite);
  let rows=[];
  if(creativeIds.length){
    const r=await pool.query(`SELECT creative_id,generated_asset_id,manifest_hash,research_backed,manifest FROM dominance_creative_provenance WHERE account_id=$1 AND creative_id=ANY($2::bigint[]) ORDER BY created_at DESC`,[recommendation.dominance_account_id,creativeIds]);
    rows=r.rows;
  }else if(assetIds.length){
    const r=await pool.query(`SELECT creative_id,generated_asset_id,manifest_hash,research_backed,manifest FROM dominance_creative_provenance WHERE account_id=$1 AND generated_asset_id=ANY($2::bigint[]) ORDER BY created_at DESC`,[recommendation.dominance_account_id,assetIds]);
    rows=r.rows;
  }
  if(!rows.length)return null;
  return{
    research_backed:rows.every(x=>x.research_backed===true),
    manifest_hashes:rows.map(x=>x.manifest_hash),
    creative_ids:rows.map(x=>x.creative_id).filter(Boolean),
    generated_asset_ids:rows.map(x=>x.generated_asset_id).filter(Boolean),
    manifests:rows.map(x=>x.manifest)
  };
}

async function budgetSnapshot(pool,accountId){
  const p=await pool.query('SELECT monthly_budget_max,currency FROM dominance_ad_policy WHERE dominance_account_id=$1',[accountId]).catch(()=>({rows:[]}));
  const s=await pool.query(`SELECT COALESCE(SUM(spend),0)::numeric spend FROM dominance_ad_spend_ledger WHERE dominance_account_id=$1 AND occurred_at>=date_trunc('month',NOW())`,[accountId]).catch(()=>({rows:[{}]}));
  return{monthly_budget_max:Number(p.rows[0]?.monthly_budget_max||0),currency:p.rows[0]?.currency||'USD',spend_to_date:Number(s.rows[0]?.spend||0)};
}

async function prepareBuild(pool,recommendation,account){
  await ensureSchema(pool);
  const spec=build.buildSpecFromRecommendation(recommendation,account);
  const research=await researchManifestForRecommendation(pool,recommendation);
  const budget=await budgetSnapshot(pool,account.id);
  let validation=build.validateBuildSpec(spec,{research_manifest:spec.operation==='launch_campaign'?(research||{research_backed:false}):research,monthly_budget_max:budget.monthly_budget_max,spend_to_date:budget.spend_to_date});
  if(spec.operation==='launch_campaign'&&!research){
    validation={...validation,ready:false,errors:[...validation.errors,'Campaign launch must reference approved creative IDs or generated asset IDs with stored research provenance.']};
  }
  const status=validation.ready&&validation.write_adapter_available?'execution_ready':validation.ready?'validated_no_connector':'blocked';
  const r=await pool.query(`INSERT INTO dominance_execution_builds(account_id,recommendation_id,platform,operation,spec,validation,research_manifest,status,updated_at)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,NOW())
    ON CONFLICT(recommendation_id) DO UPDATE SET platform=EXCLUDED.platform,operation=EXCLUDED.operation,spec=EXCLUDED.spec,validation=EXCLUDED.validation,research_manifest=EXCLUDED.research_manifest,status=EXCLUDED.status,updated_at=NOW()
    RETURNING *`,[account.id,recommendation.id,spec.platform,spec.operation,JSON.stringify(spec),JSON.stringify(validation),JSON.stringify(research||{}),status]);
  return{...r.rows[0],budget};
}

async function buildForRecommendation(pool,recommendationId,accountId){
  await ensureSchema(pool);
  const r=await pool.query('SELECT * FROM dominance_execution_builds WHERE recommendation_id=$1 AND account_id=$2',[recommendationId,accountId]);
  return r.rows[0]||null;
}

async function recordReceipt(pool,{queue,recommendation,account,status,request={},response={},error=null}){
  await ensureSchema(pool);
  const r=await pool.query(`INSERT INTO dominance_execution_receipts(queue_id,recommendation_id,account_id,platform,operation,status,request,response,error)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) RETURNING *`,[queue?.id||null,recommendation?.id||queue?.recommendation_id||null,account?.id||queue?.dominance_account_id||null,queue?.platform||recommendation?.source_platform||null,queue?.action?.operation||recommendation?.action?.operation||null,status,JSON.stringify(request||{}),JSON.stringify(response||{}),error]);
  return r.rows[0];
}

module.exports={ensureSchema,saveCreativeManifest,researchManifestForRecommendation,budgetSnapshot,prepareBuild,buildForRecommendation,recordReceipt};
