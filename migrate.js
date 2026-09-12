const {Pool}=require('pg');

const DATABASE_URL=process.env.DATABASE_URL||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;

async function main(){
  if(!DATABASE_URL){
    console.warn('Migration skipped: DATABASE_URL is not configured.');
    return;
  }
  const pool=new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false});
  try{
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_creatives (
      id BIGSERIAL PRIMARY KEY,
      account_key TEXT NOT NULL,
      company_name TEXT,
      industry_key TEXT,
      platform TEXT NOT NULL,
      campaign_name TEXT,
      market TEXT,
      audience TEXT,
      message_angle TEXT,
      headline TEXT,
      body_copy TEXT,
      cta TEXT,
      creative_type TEXT,
      visual_style TEXT,
      hook TEXT,
      asset_url TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      source TEXT NOT NULL DEFAULT 'dominance',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMPTZ
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_creative_performance (
      id BIGSERIAL PRIMARY KEY,
      creative_id BIGINT NOT NULL REFERENCES dominance_creatives(id) ON DELETE CASCADE,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      impressions BIGINT NOT NULL DEFAULT 0,
      clicks BIGINT NOT NULL DEFAULT 0,
      spend NUMERIC(14,2) NOT NULL DEFAULT 0,
      conversions NUMERIC(14,2) NOT NULL DEFAULT 0,
      qualified_outcomes NUMERIC(14,2) NOT NULL DEFAULT 0,
      revenue NUMERIC(16,2) NOT NULL DEFAULT 0,
      video_views BIGINT NOT NULL DEFAULT 0,
      video_completions BIGINT NOT NULL DEFAULT 0,
      source_platform TEXT,
      external_campaign_id TEXT,
      external_ad_id TEXT,
      raw_metrics JSONB NOT NULL DEFAULT '{}'::jsonb
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_creative_features (
      id BIGSERIAL PRIMARY KEY,
      creative_id BIGINT NOT NULL REFERENCES dominance_creatives(id) ON DELETE CASCADE,
      feature_type TEXT NOT NULL,
      feature_value TEXT NOT NULL,
      confidence NUMERIC(5,4),
      source TEXT NOT NULL DEFAULT 'dominance',
      UNIQUE(creative_id,feature_type,feature_value)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dominance_creative_learning (
      id BIGSERIAL PRIMARY KEY,
      account_key TEXT NOT NULL,
      platform TEXT,
      dimension TEXT NOT NULL,
      value TEXT NOT NULL,
      impressions BIGINT NOT NULL DEFAULT 0,
      clicks BIGINT NOT NULL DEFAULT 0,
      spend NUMERIC(14,2) NOT NULL DEFAULT 0,
      conversions NUMERIC(14,2) NOT NULL DEFAULT 0,
      qualified_outcomes NUMERIC(14,2) NOT NULL DEFAULT 0,
      revenue NUMERIC(16,2) NOT NULL DEFAULT 0,
      score NUMERIC(8,4),
      sample_size BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(account_key,platform,dimension,value)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dominance_creatives_account ON dominance_creatives(account_key,platform,status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dominance_perf_creative ON dominance_creative_performance(creative_id,observed_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dominance_learning_account ON dominance_creative_learning(account_key,platform,dimension,score DESC)`);
    console.log('DOMINANCE Creative Performance Graph schema ready.');
  } finally {
    await pool.end();
  }
}

main().catch(err=>{console.error('Creative Performance Graph migration failed:',err);process.exit(1)});
