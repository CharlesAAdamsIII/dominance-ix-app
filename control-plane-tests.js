const assert=require('assert');
const cp=require('./control-plane-core');
function check(name,ctx,expectedAllowed,rule){const r=cp.evaluateGuardrails(ctx);assert.strictEqual(r.allowed,expectedAllowed,`${name}: allowed mismatch`);if(rule)assert(r.violations.some(v=>v.rule_id===rule),`${name}: missing ${rule}`);console.log(`PASS ${name}`)}
const base={account_id:1,recommendation_account_id:1,monthly_budget_max:50000,spend_to_date:20000,net_new_spend:0,is_experiment:false,separate_test_budget:false,source_type:'dominance',require_approval:false,approved_at:new Date().toISOString(),autonomous:true,data_fresh:true,has_success_criteria:true,has_provenance:true};
check('healthy autonomous action',base,true);
check('customer isolation',{...base,recommendation_account_id:2},false,'CUSTOMER_ISOLATION');
check('hard account budget cap',{...base,spend_to_date:49000,net_new_spend:5000},false,'MONTHLY_HARD_CAP');
check('testing stays inside account budget',{...base,is_experiment:true,separate_test_budget:true},false,'TESTS_INSIDE_CAP');
check('raw platform directive cannot execute',{...base,source_type:'platform_native'},false,'PLATFORM_ADVISORY_ONLY');
check('customer approval required',{...base,autonomous:false,require_approval:true,approved_at:null},false,'ACCOUNT_AUTONOMY');
check('stale autonomous data fails closed',{...base,data_fresh:false},false,'FAIL_CLOSED');
check('missing provenance fails closed',{...base,has_provenance:false},false,'PROVENANCE');
console.log('DOMINANCE Control Plane golden scenarios passed.');
