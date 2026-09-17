const {startBusinessProfileWorker}=require('./business-profile-worker');
const {startAdIntelligenceWorker}=require('./ad-intelligence-worker');
const {startControlPlaneWorker}=require('./control-plane-worker');
const {startMarketIntelligenceWorker}=require('./market-intelligence-worker');
const {startMarketDemandSurfaceWorker}=require('./market-demand-surface-worker');
const {startMarketRegionalSnapshotWorker}=require('./market-regional-snapshot-worker');
const {startMarketDemandEventWorker}=require('./market-demand-event-worker');
const {startMarketNewsSignalWorker}=require('./market-news-signal-worker');
const {startCompetitorIntelligenceWorker}=require('./competitor-intelligence-worker');
const {startCreativeResearchWorker}=require('./creative-research-worker');
const {ensureProvenanceTrigger}=require('./provenance-trigger');
const releases=require('./intelligence-release-gate');
const adCore=require('./ad-intelligence-core');
const marketCore=require('./market-intelligence-core');
const competitorCore=require('./competitor-intelligence-core');
const cp=require('./control-plane-core');

cp.WORKER_CONTRACTS['market-intelligence-worker']={version:'1.0.0',scope:'every_active_customer',interval_minutes:30,max_staleness_minutes:75,critical:true,outputs:['keyword_intelligence','dynamic_target_areas','market_placement_decisions','advertising_handoff']};
cp.WORKER_CONTRACTS['market-demand-surface-worker']={version:'1.0.0',scope:'every_active_customer',interval_minutes:60,max_staleness_minutes:150,critical:false,outputs:['national_30d_demand_concentration','state_market_surface']};
cp.WORKER_CONTRACTS['market-regional-snapshot-worker']={version:'1.0.0',scope:'every_active_customer',interval_minutes:15,max_staleness_minutes:45,critical:false,outputs:['regional_4h_demand_snapshots','hotspot_velocity_surface']};
cp.WORKER_CONTRACTS['market-demand-event-worker']={version:'1.0.0',scope:'every_active_customer',interval_minutes:15,max_staleness_minutes:45,critical:false,outputs:['keyword_intent_taxonomy','demand_events','persistence','keyword_migration','intent_maturation','signal_convergence']};
cp.WORKER_CONTRACTS['market-news-signal-worker']={version:'1.0.0',scope:'every_active_customer',interval_minutes:60,max_staleness_minutes:150,critical:false,outputs:['localized_news_attention','external_event_demand_signal']};
cp.WORKER_CONTRACTS['competitor-intelligence-worker']={version:'1.0.0',scope:'every_active_customer',interval_minutes:30,max_staleness_minutes:90,critical:false,outputs:['competitor_discovery','google_bing_rank_change','competitor_site_change','google_ads_transparency','local_pack_visibility','seo_recommendations','advertising_competitor_signals','creative_differentiation']};
cp.WORKER_CONTRACTS['creative-research-worker']={version:'1.0.0',scope:'every_active_customer',interval_minutes:30,max_staleness_minutes:90,critical:false,outputs:['search_intent_research','competitor_creative_research','market_signal_research','creative_portfolio_requests']};

let profiler=null,advertising=null,controlPlane=null,marketIntelligence=null,demandSurface=null,regionalSnapshots=null,demandEvents=null,newsSignals=null,competitorIntelligence=null,creativeResearch=null;
async function start(){
  const bootstrap=adCore.makePool();
  if(bootstrap){
    await adCore.ensureAdSchema(bootstrap);
    await marketCore.ensureSchema(bootstrap);
    await competitorCore.ensureSchema(bootstrap);
    await cp.ensureControlPlaneSchema(bootstrap);
    await releases.ensureReleaseSchema(bootstrap);
    await ensureProvenanceTrigger(bootstrap);
    await bootstrap.end().catch(()=>{});
  }
  profiler=startBusinessProfileWorker();
  advertising=startAdIntelligenceWorker();
  marketIntelligence=startMarketIntelligenceWorker();
  demandSurface=startMarketDemandSurfaceWorker();
  regionalSnapshots=startMarketRegionalSnapshotWorker();
  demandEvents=startMarketDemandEventWorker();
  newsSignals=startMarketNewsSignalWorker();
  competitorIntelligence=startCompetitorIntelligenceWorker();
  creativeResearch=startCreativeResearchWorker();
  controlPlane=startControlPlaneWorker();
  require('./worker-monitor');
}
async function stopWorkers(){
  if(profiler?.stop)await profiler.stop();
  if(advertising?.stop)await advertising.stop();
  if(marketIntelligence?.stop)await marketIntelligence.stop();
  if(demandSurface?.stop)await demandSurface.stop();
  if(regionalSnapshots?.stop)await regionalSnapshots.stop();
  if(demandEvents?.stop)await demandEvents.stop();
  if(newsSignals?.stop)await newsSignals.stop();
  if(competitorIntelligence?.stop)await competitorIntelligence.stop();
  if(creativeResearch?.stop)await creativeResearch.stop();
  if(controlPlane?.stop)await controlPlane.stop();
}
start().catch(e=>{console.error('[WORKER SUITE] bootstrap failed',e);process.exit(1)});
process.on('SIGTERM',stopWorkers);
process.on('SIGINT',stopWorkers);
