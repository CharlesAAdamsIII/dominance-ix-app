const {Pool}=require('pg');

const DATABASE_URL=process.env.DATABASE_URL||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;

async function main(){
  if(!DATABASE_URL){console.warn('Migration skipped: DATABASE_URL is not configured.');return}
  const pool=new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false});
  try{
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_creatives (
      id BIGSERIAL PRIMARY KEY, account_key TEXT NOT NULL, company_name TEXT, industry_key TEXT,
      platform TEXT NOT NULL, campaign_name TEXT, market TEXT, audience TEXT, message_angle TEXT,
      headline TEXT, body_copy TEXT, cta TEXT, creative_type TEXT, visual_style TEXT, hook TEXT,
      asset_url TEXT, status TEXT NOT NULL DEFAULT 'draft', source TEXT NOT NULL DEFAULT 'dominance',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), approved_at TIMESTAMPTZ
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_creative_performance (
      id BIGSERIAL PRIMARY KEY, creative_id BIGINT NOT NULL REFERENCES dominance_creatives(id) ON DELETE CASCADE,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), impressions BIGINT NOT NULL DEFAULT 0,
      clicks BIGINT NOT NULL DEFAULT 0, spend NUMERIC(14,2) NOT NULL DEFAULT 0,
      conversions NUMERIC(14,2) NOT NULL DEFAULT 0, qualified_outcomes NUMERIC(14,2) NOT NULL DEFAULT 0,
      revenue NUMERIC(16,2) NOT NULL DEFAULT 0, video_views BIGINT NOT NULL DEFAULT 0,
      video_completions BIGINT NOT NULL DEFAULT 0, source_platform TEXT, external_campaign_id TEXT,
      external_ad_id TEXT, raw_metrics JSONB NOT NULL DEFAULT '{}'::jsonb
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_creative_features (
      id BIGSERIAL PRIMARY KEY, creative_id BIGINT NOT NULL REFERENCES dominance_creatives(id) ON DELETE CASCADE,
      feature_type TEXT NOT NULL, feature_value TEXT NOT NULL, confidence NUMERIC(5,4),
      source TEXT NOT NULL DEFAULT 'dominance', UNIQUE(creative_id,feature_type,feature_value)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_creative_learning (
      id BIGSERIAL PRIMARY KEY, account_key TEXT NOT NULL, platform TEXT, dimension TEXT NOT NULL,
      value TEXT NOT NULL, impressions BIGINT NOT NULL DEFAULT 0, clicks BIGINT NOT NULL DEFAULT 0,
      spend NUMERIC(14,2) NOT NULL DEFAULT 0, conversions NUMERIC(14,2) NOT NULL DEFAULT 0,
      qualified_outcomes NUMERIC(14,2) NOT NULL DEFAULT 0, revenue NUMERIC(16,2) NOT NULL DEFAULT 0,
      score NUMERIC(8,4), sample_size BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(account_key,platform,dimension,value)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_ad_accounts (
      id BIGSERIAL PRIMARY KEY, dominance_account_id BIGINT REFERENCES dominance_accounts(id) ON DELETE CASCADE,
      platform TEXT NOT NULL, external_account_id TEXT, account_name TEXT, currency TEXT, timezone TEXT,
      status TEXT NOT NULL DEFAULT 'connected', metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_synced_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(dominance_account_id,platform,external_account_id)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_campaign_entities (
      id BIGSERIAL PRIMARY KEY, dominance_account_id BIGINT REFERENCES dominance_accounts(id) ON DELETE CASCADE,
      ad_account_id BIGINT REFERENCES dominance_ad_accounts(id) ON DELETE CASCADE, platform TEXT NOT NULL,
      entity_type TEXT NOT NULL, parent_entity_id BIGINT REFERENCES dominance_campaign_entities(id) ON DELETE CASCADE,
      external_id TEXT, name TEXT NOT NULL, status TEXT, objective TEXT, budget NUMERIC(14,2), bid_strategy TEXT,
      market TEXT, targeting JSONB NOT NULL DEFAULT '{}'::jsonb, settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      performance JSONB NOT NULL DEFAULT '{}'::jsonb, last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_creative_requests (
      id BIGSERIAL PRIMARY KEY, dominance_account_id BIGINT REFERENCES dominance_accounts(id) ON DELETE CASCADE,
      ad_account_id BIGINT REFERENCES dominance_ad_accounts(id) ON DELETE SET NULL,
      campaign_entity_id BIGINT REFERENCES dominance_campaign_entities(id) ON DELETE SET NULL,
      platform TEXT NOT NULL, asset_category TEXT NOT NULL, asset_format TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1,
      placement TEXT, objective TEXT, audience TEXT, market TEXT, message_angle TEXT, prompt TEXT NOT NULL,
      constraints JSONB NOT NULL DEFAULT '{}'::jsonb, source TEXT NOT NULL DEFAULT 'campaign_manager', priority INTEGER NOT NULL DEFAULT 50,
      status TEXT NOT NULL DEFAULT 'queued', worker_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
      retry_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), claimed_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
    )`);
    await pool.query(`ALTER TABLE dominance_creative_requests ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE dominance_creative_requests ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3`);
    await pool.query(`ALTER TABLE dominance_creative_requests ADD COLUMN IF NOT EXISTS last_error TEXT`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_creative_request_outputs (
      id BIGSERIAL PRIMARY KEY, request_id BIGINT NOT NULL REFERENCES dominance_creative_requests(id) ON DELETE CASCADE,
      creative_id BIGINT REFERENCES dominance_creatives(id) ON DELETE SET NULL, output_type TEXT NOT NULL,
      content JSONB NOT NULL DEFAULT '{}'::jsonb, status TEXT NOT NULL DEFAULT 'draft', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_competitor_assets (
      id BIGSERIAL PRIMARY KEY, dominance_account_id BIGINT REFERENCES dominance_accounts(id) ON DELETE CASCADE,
      competitor_name TEXT NOT NULL, competitor_domain TEXT, platform TEXT NOT NULL, external_asset_id TEXT,
      asset_type TEXT NOT NULL, placement TEXT, headline TEXT, body_copy TEXT, cta TEXT, destination_url TEXT,
      media_url TEXT, visual_fingerprint TEXT, message_angle TEXT, offer_type TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      active BOOLEAN NOT NULL DEFAULT TRUE, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE(dominance_account_id,platform,competitor_name,external_asset_id)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_competitor_asset_observations (
      id BIGSERIAL PRIMARY KEY, competitor_asset_id BIGINT NOT NULL REFERENCES dominance_competitor_assets(id) ON DELETE CASCADE,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), impression_signal NUMERIC, engagement_signal NUMERIC,
      longevity_hours NUMERIC, spend_signal NUMERIC, rank_signal NUMERIC, placement_count INTEGER,
      raw_metrics JSONB NOT NULL DEFAULT '{}'::jsonb
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_asset_intelligence (
      id BIGSERIAL PRIMARY KEY, dominance_account_id BIGINT REFERENCES dominance_accounts(id) ON DELETE CASCADE,
      asset_scope TEXT NOT NULL, creative_id BIGINT REFERENCES dominance_creatives(id) ON DELETE CASCADE,
      competitor_asset_id BIGINT REFERENCES dominance_competitor_assets(id) ON DELETE CASCADE, platform TEXT,
      signal_type TEXT NOT NULL, signal_state TEXT NOT NULL, score NUMERIC(8,4), confidence NUMERIC(5,4),
      baseline JSONB NOT NULL DEFAULT '{}'::jsonb, current_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb, observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_asset_recommendations (
      id BIGSERIAL PRIMARY KEY, dominance_account_id BIGINT REFERENCES dominance_accounts(id) ON DELETE CASCADE,
      platform TEXT, campaign_entity_id BIGINT REFERENCES dominance_campaign_entities(id) ON DELETE SET NULL,
      creative_id BIGINT REFERENCES dominance_creatives(id) ON DELETE SET NULL,
      competitor_asset_id BIGINT REFERENCES dominance_competitor_assets(id) ON DELETE SET NULL,
      recommendation_type TEXT NOT NULL, title TEXT NOT NULL, rationale TEXT NOT NULL,
      recommended_action JSONB NOT NULL DEFAULT '{}'::jsonb, expected_impact TEXT, confidence NUMERIC(5,4),
      priority INTEGER NOT NULL DEFAULT 50, status TEXT NOT NULL DEFAULT 'open', auto_action_eligible BOOLEAN NOT NULL DEFAULT FALSE,
      source_signal_ids JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dominance_creatives_account ON dominance_creatives(account_key,platform,status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dominance_perf_creative ON dominance_creative_performance(creative_id,observed_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dominance_learning_account ON dominance_creative_learning(account_key,platform,dimension,score DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dom_campaign_entities_tree ON dominance_campaign_entities(dominance_account_id,platform,parent_entity_id,entity_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dom_creative_requests_queue ON dominance_creative_requests(status,priority DESC,created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dom_comp_assets_account ON dominance_competitor_assets(dominance_account_id,platform,competitor_name,last_seen_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dom_asset_intel_account ON dominance_asset_intelligence(dominance_account_id,platform,signal_type,observed_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dom_asset_recos_queue ON dominance_asset_recommendations(dominance_account_id,status,priority DESC,created_at)`);
    console.log('DOMINANCE campaign hierarchy + autonomous Asset Intelligence + creative queue schema ready.');
  } finally {await pool.end()}
}

main().catch(err=>{console.error('DOMINANCE migration failed:',err);process.exit(1)});
