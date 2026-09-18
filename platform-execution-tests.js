'use strict';

const assert=require('assert');
const build=require('./platform-build-core');
const google=require('./google-ads-write-adapter');

function run(){
  const brief={
    destination:{platform:'Google Ads'},
    assignment:{asset_category:'written_copy',market:'Philadelphia'},
    intelligence:{
      audience_market_context:{data_quality:{sources_available:['GA4_30D','GSC']}},
      market_signals:[{market:'Philadelphia'}],
      search_intent:[{phrase:'healthcare marketing',dominant_intent:'commercial'}],
      competitor_context:[{competitor:'Example'}],
      competitor_events:[],
      winning_patterns:[]
    },
    strategic_direction:{primary_goal:'qualified lead'},
    platform_requirements:['15 headlines <=30 chars','4 descriptions <=90 chars','keyword-to-message alignment']
  };
  const manifest=build.creativeProvenanceManifest({account:{id:4,account_key:'test'},request:{id:1,platform:'Google Ads'},asset:{id:2},brief});
  assert.equal(manifest.research_backed,true);
  assert.deepEqual(manifest.evidence.sources,['GA4_30D','GSC']);

  const ad={
    headlines:['Healthcare Growth AI','Find More Qualified Leads','Market Intelligence Now'],
    descriptions:['Use market and search intelligence to focus growth.','See competitor demand and act on qualified opportunities.'],
    final_urls:['https://example.com']
  };
  assert.equal(build.validateCreativeForPlatform('Google Ads',ad).valid,true);
  assert.equal(build.validateCreativeForPlatform('Google Ads',{...ad,headlines:['X'.repeat(31),'B','C']}).valid,false);

  const recommendation={id:10,dominance_account_id:4,source_platform:'Google Ads',recommendation_type:'campaign_launch',action:{operation:'launch_campaign',campaign_entity_id:'77',creative_ids:[9],campaign:{name:'DOMINANCE Search',status:'ENABLED',channel_type:'SEARCH',daily_budget:100,final_url:'https://example.com',geo_targets:[{criterion_id:'2840'}],language_criterion_ids:['1000'],ad_groups:[{name:'High Intent',keywords:[{text:'healthcare marketing',match_type:'PHRASE'}],ads:[ad]}]}}};
  const spec=build.buildSpecFromRecommendation(recommendation,{id:4,website:'https://example.com'});
  const validation=build.validateBuildSpec(spec,{research_manifest:{research_backed:true},monthly_budget_max:5000,spend_to_date:0});
  assert.equal(validation.ready,true);
  const capBlocked=build.validateBuildSpec(spec,{research_manifest:{research_backed:true},monthly_budget_max:5000,spend_to_date:0,committed_monthly_budget:3000});
  assert.equal(capBlocked.ready,false);
  assert(capBlocked.errors.some(x=>x.includes('monthly advertising maximum')));
  assert.equal(spec.campaign_entity_id,'77');

  const ops=google.launchOperations(spec,'1234567890');
  assert(ops.some(x=>x.campaignBudgetOperation));
  assert(ops.some(x=>x.campaignOperation));
  assert(ops.some(x=>x.adGroupOperation));
  assert(ops.some(x=>x.adGroupCriterionOperation));
  assert(ops.some(x=>x.adGroupAdOperation));
  assert(ops.filter(x=>x.campaignCriterionOperation).length>=2);
  const composite=ops.filter(x=>x.adGroupCriterionOperation||x.adGroupAdOperation||x.campaignCriterionOperation);
  for(const x of composite){
    const create=x.adGroupCriterionOperation?.create||x.adGroupAdOperation?.create||x.campaignCriterionOperation?.create;
    assert(!create.resourceName,'Composite child resources should let Google allocate the resource name.');
  }

  assert.equal(build.validateCreativeForPlatform('Meta',{primary_text:'Research-led growth',headline:'Qualified growth',description:'See the evidence'}).valid,true);
  assert.equal(build.PLATFORM_RULES.Meta.supports_write,false);
  console.log('platform-execution-tests: PASS');
}
run();
