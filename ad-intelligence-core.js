const {Pool}=require('pg');

const DATABASE_URL=process.env.DATABASE_URL||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
function makePool(){return DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false}):null}
const money=v=>Math.max(0,Number(v||0));
const json=v=>{if(v&&typeof v==='object')return v;try{return JSON.parse(v||'{}')}catch{return{}}};

async function ensureAdSchema(pool){
  if(!pool)return;
  await pool.query(`CREATE TABLE IF NOT EXISTS dominance_ad_policy(
    dominance_account_id BIGINT PRIMARY KEY REFERENCES dominance_accounts(id) ON DELETE CASCADE,
    monthly_budget_max NUMERIC(16,2) NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    target_outcome TEXT NOT NULL DEFAULT 'qualified_outcomes',
    autonomy_state TEXT NOT NULL DEFAULT 'validation',
    require_approval BOOLEAN NOT NULL DEFAULT TRUE,
    validation_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    autonomous_since TIMESTAMPTZ,
    autonomy_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dominance_platform_recommendations(
    id BIGSERIAL PRIMARY KEY,
    dominance_account_id BIGINT NOT NULL REFERENCES dominance_accounts(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    external_recommendation_id TEXT,
    directive_type TEXT,
    directive JSONB NOT NULL DEFAULT '{}'::jsonb,
    platform_confidence NUMERIC(6,5),
    status TEXT NOT NULL DEFAULT 'new',
    adjudication TEXT,
    adjudication_reason TEXT,
    dominance_confidence NUMERIC(6,5),
    linked_recommendation_id BIGINT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    adjudicated_at TIMESTAMPTZ,
    UNIQUE(dominance_account_id,platform,external_recommendation_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dominance_ad_recommendations(
    id BIGSERIAL PRIMARY KEY,
    dominance_account_id BIGINT NOT NULL REFERENCES dominance_accounts(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL DEFAULT 'dominance',
    source_platform TEXT,
    source_platform_recommendation_id BIGINT REFERENCES dominance_platform_recommendations(id) ON DELETE SET NULL,
    recommendation_type TEXT NOT NULL,
    title TEXT NOT NULL,
    rationale TEXT NOT NULL,
    action JSONB NOT NULL DEFAULT '{}'::jsonb,
    expected_outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
    success_criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
    funding_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
    confidence NUMERIC(6,5) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending_approval',
    approved_at TIMESTAMPTZ,
    executed_at TIMESTAMPTZ,
    evaluation_due_at TIMESTAMPTZ,
    actual_outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
    success BOOLEAN,
    evaluated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dominance_ad_spend_ledger(
    id BIGSERIAL PRIMARY KEY,
    dominance_account_id BIGINT NOT NULL REFERENCES dominance_accounts(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    campaign_external_id TEXT,
    ad_external_id TEXT,
    spend NUMERIC(16,2) NOT NULL DEFAULT 0,
    qualified_outcomes NUMERIC(16,4) NOT NULL DEFAULT 0,
    revenue NUMERIC(18,2) NOT NULL DEFAULT 0,
    occurred_at TIMESTAMPTZ NOT NULL,
    source TEXT NOT NULL DEFAULT 'platform_sync',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dominance_ad_experiments(
    id BIGSERIAL PRIMARY KEY,
    dominance_account_id BIGINT NOT NULL REFERENCES dominance_accounts(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    experiment_type TEXT NOT NULL,
    name TEXT NOT NULL,
    control JSONB NOT NULL DEFAULT '{}'::jsonb,
    challenger JSONB NOT NULL DEFAULT '{}'::jsonb,
    hypothesis TEXT,
    success_criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
    allocation JSONB NOT NULL DEFAULT '{"control":0.9,"challenger":0.1}'::jsonb,
    max_evaluation_spend NUMERIC(16,2),
    status TEXT NOT NULL DEFAULT 'planned',
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dominance_ad_execution_queue(
    id BIGSERIAL PRIMARY KEY,
    dominance_account_id BIGINT NOT NULL REFERENCES dominance_accounts(id) ON DELETE CASCADE,
    recommendation_id BIGINT REFERENCES dominance_ad_recommendations(id) ON DELETE CASCADE,
    platform TEXT,
    action JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dom_ad_reco_account ON dominance_ad_recommendations(dominance_account_id,status,created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dom_ad_spend_month ON dominance_ad_spend_ledger(dominance_account_id,occurred_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dom_ad_exec_queue ON dominance_ad_execution_queue(status,created_at)`);
}

const DEFAULT_POLICY_SETTINGS={google_ads_eu_political_advertising:'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'};
function withPolicyDefaults(settings){return{...DEFAULT_POLICY_SETTINGS,...(settings||{})}}

async function getOrCreatePolicy(pool,accountId){
  await ensureAdSchema(pool);
  await pool.query(`INSERT INTO dominance_ad_policy(dominance_account_id,settings) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING`,[accountId,JSON.stringify(DEFAULT_POLICY_SETTINGS)]);
  await pool.query(`UPDATE dominance_ad_policy SET settings=$2::jsonb,updated_at=CASE WHEN settings ? 'google_ads_eu_political_advertising' THEN updated_at ELSE NOW() END WHERE dominance_account_id=$1 AND NOT (settings ? 'google_ads_eu_political_advertising')`,[accountId,JSON.stringify(withPolicyDefaults({}))]);
  const r=await pool.query('SELECT * FROM dominance_ad_policy WHERE dominance_account_id=$1',[accountId]);
  if(r.rows[0])r.rows[0].settings=withPolicyDefaults(r.rows[0].settings);
  return r.rows[0];
}

async function updatePolicy(pool,accountId,input={}){
  const current=await getOrCreatePolicy(pool,accountId);
  const max=input.monthly_budget_max===undefined?Number(current.monthly_budget_max):money(input.monthly_budget_max);
  const currency=String(input.currency||current.currency||'USD').slice(0,8).toUpperCase();
  const target=String(input.target_outcome||current.target_outcome||'qualified_outcomes').slice(0,80);
  const settings=withPolicyDefaults({...(current.settings||{}),...(input.settings||{})});
  const r=await pool.query(`UPDATE dominance_ad_policy SET monthly_budget_max=$1,currency=$2,target_outcome=$3,settings=$4::jsonb,updated_at=NOW() WHERE dominance_account_id=$5 RETURNING *`,[max,currency,target,JSON.stringify(settings),accountId]);
  return r.rows[0];
}

async function getBudgetStatus(pool,account){
  const policy=await getOrCreatePolicy(pool,account.id);
  const start=new Date();start.setUTCDate(1);start.setUTCHours(0,0,0,0);
  let spend=0,qualified=0,revenue=0;
  const ledger=await pool.query(`SELECT COALESCE(SUM(spend),0)::numeric spend,COALESCE(SUM(qualified_outcomes),0)::numeric qualified,COALESCE(SUM(revenue),0)::numeric revenue FROM dominance_ad_spend_ledger WHERE dominance_account_id=$1 AND occurred_at >= $2`,[account.id,start.toISOString()]);
  spend=money(ledger.rows[0]?.spend);qualified=money(ledger.rows[0]?.qualified);revenue=money(ledger.rows[0]?.revenue);
  if(spend===0){
    const fallback=await pool.query(`SELECT COALESCE(SUM(p.spend),0)::numeric spend,COALESCE(SUM(p.qualified_outcomes),0)::numeric qualified,COALESCE(SUM(p.revenue),0)::numeric revenue FROM dominance_creative_performance p JOIN dominance_creatives c ON c.id=p.creative_id WHERE c.account_key=$1 AND p.observed_at >= $2`,[account.account_key,start.toISOString()]).catch(()=>({rows:[{}]}));
    spend=money(fallback.rows[0]?.spend);qualified=money(fallback.rows[0]?.qualified);revenue=money(fallback.rows[0]?.revenue);
  }
  const max=money(policy.monthly_budget_max),remaining=Math.max(0,max-spend);
  const now=new Date(),daysInMonth=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,0)).getUTCDate(),day=Math.max(1,now.getUTCDate()),daysRemaining=Math.max(1,daysInMonth-day+1);
  const projected=day>0?spend/day*daysInMonth:spend;
  return{monthly_budget_max:max,spend_to_date:spend,remaining,qualified_outcomes:qualified,revenue,projected_month_end:projected,days_remaining:daysRemaining,safe_daily_remaining:remaining/daysRemaining,hard_cap_enforced:true,currency:policy.currency};
}

function textDirective(d){return JSON.stringify(d||{}).toLowerCase()}
async function adjudicatePlatformRecommendation(pool,account,platformReco){
  const policy=await getOrCreatePolicy(pool,account.id),budget=await getBudgetStatus(pool,account),analysis=account.analysis||{},profile=analysis.business_profile||{};
  const directive=json(platformReco.directive),txt=textDirective(directive),platform=String(platformReco.platform||'').toUpperCase();
  let decision='modify',confidence=.72,reason='DOMINANCE evaluates platform suggestions against account economics, market intelligence, downstream quality, historical results and the account budget ceiling.';
  const action={...directive,platform};
  const funding={net_new_spend:0,monthly_cap:Number(policy.monthly_budget_max),remaining:budget.remaining,rule:'reallocate_within_account_cap'};
  if(txt.includes('broad match')||txt.includes('broad_match')){
    const healthcare=/health|behavioral|treatment|medical|clinic/i.test(`${profile.category||''} ${profile.label||''} ${account.industry_name||''}`);
    const qualitySignal=money(analysis?.advertising?.offline_conversion_quality||0);
    if(healthcare&&qualitySignal<.7){decision='reject';confidence=.9;reason='Broad-match expansion is rejected because DOMINANCE prioritizes qualified downstream outcomes over raw platform conversions. This account does not yet show strong enough qualified/offline conversion feedback to safely expand match breadth.'}
    else{decision='modify';confidence=.82;reason='Broad match may be tested only as a controlled challenger with strict query-quality, negative-keyword and qualified-outcome gates inside the existing monthly cap.';action.experiment={allocation:{control:.9,challenger:.1},kill_on_quality_decline:true}}
  }else if(txt.includes('increase budget')||money(directive.incremental_budget)>0||money(directive.budget_increase)>0){
    decision='modify';confidence=.94;reason='DOMINANCE does not accept additive platform budget directives. Any increase to this platform must be funded by reducing lower-value spend elsewhere so the account never exceeds its monthly maximum.';action.incremental_budget=0;action.reallocate_only=true;
  }else if(budget.monthly_budget_max<=0){decision='modify';confidence=.99;reason='No account monthly advertising maximum is configured. DOMINANCE will analyze and recommend, but cannot authorize spend until the hard account ceiling is set.'}
  const title=`${decision==='reject'?'Reject':decision==='modify'?'Modify':'Accept'} ${platform} platform recommendation`;
  const rr=await pool.query(`INSERT INTO dominance_ad_recommendations(dominance_account_id,source_type,source_platform,source_platform_recommendation_id,recommendation_type,title,rationale,action,expected_outcome,success_criteria,funding_plan,confidence,status) VALUES($1,'platform_adjudicated',$2,$3,'platform_adjudication',$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11) RETURNING *`,[account.id,platform,platformReco.id,title,reason,JSON.stringify(action),JSON.stringify({objective:policy.target_outcome}),JSON.stringify({must_not_reduce_qualified_outcome_efficiency:true,must_remain_within_monthly_cap:true}),JSON.stringify(funding),confidence,policy.require_approval?'pending_approval':'approved']);
  await pool.query(`UPDATE dominance_platform_recommendations SET status='adjudicated',adjudication=$1,adjudication_reason=$2,dominance_confidence=$3,linked_recommendation_id=$4,adjudicated_at=NOW() WHERE id=$5`,[decision,reason,confidence,rr.rows[0].id,platformReco.id]);
  return rr.rows[0];
}

async function createRecommendation(pool,account,input){
  const policy=await getOrCreatePolicy(pool,account.id),budget=await getBudgetStatus(pool,account);
  const funding={net_new_spend:0,monthly_cap:Number(policy.monthly_budget_max),remaining:budget.remaining,...(input.funding_plan||{})};
  if(money(funding.net_new_spend)>budget.remaining)throw Error('Recommendation would exceed the account monthly budget maximum.');
  const status=policy.require_approval?'pending_approval':'approved';
  const r=await pool.query(`INSERT INTO dominance_ad_recommendations(dominance_account_id,source_type,source_platform,recommendation_type,title,rationale,action,expected_outcome,success_criteria,funding_plan,confidence,status) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12) RETURNING *`,[account.id,input.source_type||'dominance',input.source_platform||null,input.recommendation_type||'optimization',input.title,input.rationale,JSON.stringify(input.action||{}),JSON.stringify(input.expected_outcome||{}),JSON.stringify(input.success_criteria||{}),JSON.stringify(funding),Number(input.confidence||.7),status]);
  return r.rows[0];
}

async function enqueueRecommendation(pool,recommendation){
  const action=recommendation.action||{};
  const platform=recommendation.source_platform||action.platform||null;
  await pool.query(`INSERT INTO dominance_ad_execution_queue(dominance_account_id,recommendation_id,platform,action,status) SELECT $1,$2,$3,$4::jsonb,'queued' WHERE NOT EXISTS(SELECT 1 FROM dominance_ad_execution_queue WHERE recommendation_id=$2 AND status IN('queued','executing','completed'))`,[recommendation.dominance_account_id,recommendation.id,platform,JSON.stringify(action)]);
}

async function evaluateAutonomy(pool,accountId){
  const policy=await getOrCreatePolicy(pool,accountId);
  const start=new Date(policy.validation_started_at||Date.now());
  const ageDays=(Date.now()-start.getTime())/86400000;
  const stats=await pool.query(`SELECT COUNT(*) FILTER(WHERE approved_at IS NOT NULL)::int approved,COUNT(*) FILTER(WHERE success=TRUE)::int successful,COUNT(*) FILTER(WHERE success=FALSE)::int failed,COUNT(*) FILTER(WHERE evaluated_at IS NULL AND executed_at IS NOT NULL)::int pending FROM dominance_ad_recommendations WHERE dominance_account_id=$1 AND created_at >= $2`,[accountId,start.toISOString()]);
  const s=stats.rows[0]||{approved:0,successful:0,failed:0,pending:0};
  const eligible=ageDays>=30&&s.approved>0&&s.failed===0&&s.pending===0&&s.successful===s.approved;
  await pool.query('UPDATE dominance_ad_policy SET autonomy_eligible=$1,updated_at=NOW() WHERE dominance_account_id=$2',[eligible,accountId]);
  return{eligible,validation_days:Math.max(0,Math.floor(ageDays)),approved:s.approved,successful:s.successful,failed:s.failed,pending:s.pending,state:policy.autonomy_state,require_approval:policy.require_approval};
}

async function activateAutonomy(pool,accountId){
  const state=await evaluateAutonomy(pool,accountId);
  if(!state.eligible)throw Error('Account has not yet completed 30 consecutive days with 100% validated approved recommendations.');
  const r=await pool.query(`UPDATE dominance_ad_policy SET autonomy_state='autonomous',require_approval=FALSE,autonomous_since=COALESCE(autonomous_since,NOW()),updated_at=NOW() WHERE dominance_account_id=$1 RETURNING *`,[accountId]);
  return r.rows[0];
}

async function suspendAutonomy(pool,accountId,reason){
  await pool.query(`UPDATE dominance_ad_policy SET autonomy_state='validation',require_approval=TRUE,autonomy_eligible=FALSE,validation_started_at=NOW(),autonomous_since=NULL,settings=jsonb_set(settings,'{last_suspension_reason}',to_jsonb($2::text),true),updated_at=NOW() WHERE dominance_account_id=$1`,[accountId,String(reason||'Performance fell outside validated success criteria.')]);
}

module.exports={makePool,ensureAdSchema,getOrCreatePolicy,updatePolicy,getBudgetStatus,adjudicatePlatformRecommendation,createRecommendation,enqueueRecommendation,evaluateAutonomy,activateAutonomy,suspendAutonomy};
