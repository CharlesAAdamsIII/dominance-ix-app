async function ensureProvenanceTrigger(pool){
  await pool.query(`CREATE OR REPLACE FUNCTION dominance_freeze_recommendation_provenance() RETURNS trigger AS $$
  DECLARE p RECORD; a RECORD;
  BEGIN
    SELECT * INTO p FROM dominance_ad_policy WHERE dominance_account_id=NEW.dominance_account_id;
    SELECT * INTO a FROM dominance_accounts WHERE id=NEW.dominance_account_id;
    INSERT INTO dominance_decision_provenance(recommendation_id,account_id,decision_type,versions,input_snapshot,policy_snapshot,data_freshness)
    VALUES(
      NEW.id,NEW.dominance_account_id,NEW.recommendation_type,
      jsonb_build_object('control_plane','1.0.0','constitution','1.0.0','decision_schema','1.0.0','business_profile',COALESCE(a.analysis->'business_profile'->>'version','unknown')),
      jsonb_build_object('title',NEW.title,'rationale',NEW.rationale,'source_type',NEW.source_type,'source_platform',NEW.source_platform,'confidence',NEW.confidence,'action',NEW.action,'expected_outcome',NEW.expected_outcome,'success_criteria',NEW.success_criteria,'funding_plan',NEW.funding_plan),
      jsonb_build_object('monthly_budget_max',p.monthly_budget_max,'currency',p.currency,'target_outcome',p.target_outcome,'autonomy_state',p.autonomy_state,'require_approval',p.require_approval,'autonomy_eligible',p.autonomy_eligible,'settings',COALESCE(p.settings,'{}'::jsonb)),
      '{}'::jsonb
    ) ON CONFLICT(recommendation_id) DO NOTHING;
    RETURN NEW;
  END; $$ LANGUAGE plpgsql`);
  await pool.query(`DROP TRIGGER IF EXISTS trg_dominance_freeze_recommendation ON dominance_ad_recommendations`);
  await pool.query(`CREATE TRIGGER trg_dominance_freeze_recommendation AFTER INSERT ON dominance_ad_recommendations FOR EACH ROW EXECUTE FUNCTION dominance_freeze_recommendation_provenance()`);

  await pool.query(`CREATE OR REPLACE FUNCTION dominance_guard_execution_queue() RETURNS trigger AS $$
  DECLARE rec_account BIGINT; rec_approved TIMESTAMPTZ; rec_funding JSONB; max_budget NUMERIC; approval_required BOOLEAN; spent NUMERIC; net_new NUMERIC; ok BOOLEAN;
  BEGIN
    IF NEW.status <> 'queued' THEN RETURN NEW; END IF;
    SELECT dominance_account_id,approved_at,funding_plan INTO rec_account,rec_approved,rec_funding FROM dominance_ad_recommendations WHERE id=NEW.recommendation_id;
    IF rec_account IS NULL OR rec_account <> NEW.dominance_account_id THEN
      RAISE EXCEPTION 'DOMINANCE execution blocked: customer isolation verification failed';
    END IF;
    SELECT monthly_budget_max,require_approval INTO max_budget,approval_required FROM dominance_ad_policy WHERE dominance_account_id=NEW.dominance_account_id;
    IF max_budget IS NULL OR max_budget <= 0 THEN RAISE EXCEPTION 'DOMINANCE execution blocked: monthly advertising maximum is not configured'; END IF;
    IF approval_required AND rec_approved IS NULL THEN RAISE EXCEPTION 'DOMINANCE execution blocked: customer approval is required'; END IF;
    IF COALESCE((rec_funding->>'separate_test_budget')::BOOLEAN,FALSE) THEN RAISE EXCEPTION 'DOMINANCE execution blocked: testing must remain inside the account monthly maximum'; END IF;
    SELECT COALESCE(SUM(spend),0) INTO spent FROM dominance_ad_spend_ledger WHERE dominance_account_id=NEW.dominance_account_id AND occurred_at>=date_trunc('month',NOW());
    net_new:=COALESCE((rec_funding->>'net_new_spend')::NUMERIC,0);
    IF net_new > GREATEST(0,max_budget-spent) THEN RAISE EXCEPTION 'DOMINANCE execution blocked: action would exceed customer monthly advertising maximum'; END IF;
    SELECT EXISTS(SELECT 1 FROM dominance_execution_verifications WHERE recommendation_id=NEW.recommendation_id AND account_id=NEW.dominance_account_id AND status='allowed' AND verified_at>NOW()-INTERVAL '5 minutes') INTO ok;
    IF NOT ok THEN RAISE EXCEPTION 'DOMINANCE execution blocked: fresh Control Plane approval is required'; END IF;
    RETURN NEW;
  END; $$ LANGUAGE plpgsql`);
  await pool.query(`DROP TRIGGER IF EXISTS trg_dominance_guard_execution_queue ON dominance_ad_execution_queue`);
  await pool.query(`CREATE TRIGGER trg_dominance_guard_execution_queue BEFORE INSERT ON dominance_ad_execution_queue FOR EACH ROW EXECUTE FUNCTION dominance_guard_execution_queue()`);
}
module.exports={ensureProvenanceTrigger};
