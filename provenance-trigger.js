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
}
module.exports={ensureProvenanceTrigger};
