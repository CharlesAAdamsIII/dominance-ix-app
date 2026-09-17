require('./google-ads-fetch-auth');
const {startCoreSourceSyncWorker}=require('./core-source-sync-supervisor');
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
const {startGoogleIngestionPromotionWorker}=require('./google-ingestion-promotion-worker');
const {startGa4Market30dWorker}=require('./ga4-market-30d-worker');
const {startWorkerMonitorSupport}=require('./worker-monitor');
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
cp.WORKER_CONTRACTS['google-ingestion-promotion-worker']={version:'1.0.0',scope:'every_active_customer',interval_minutes:5,max_staleness_minutes:20,critical:false,outputs:['google_ads_account_import','google_ads_campaign_import','campaign_performance_visibility']};
cp.WORKER_CONTRACTS['ga4-market-30d-worker']={version:'1.0.0',scope:'every_active_customer',interval_minutes:60,max_staleness_minutes:150,critical:false,outputs:['ga4_30d_geographic_activity','first_party_market_concentration','30d_vs_prior_30d_velocity']};

let coreSourceSync=null,profiler=null,advertising=null,controlPlane=null,marketIntelligence=null,demandSurface=null,regionalSnapshots=null,demandEvents=null,newsSignals=null,competitorIntelligence=null,creativeResearch=null,googlePromotion=null,ga4Market30d=null,monitorSupport=null;
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
  coreSourceSync=startCoreSourceSyncWorker();
  profiler=startBusinessProfileWorker();
  advertising=startAdIntelligenceWorker();
  marketIntelligence=startMarketIntelligenceWorker();
  demandSurface=startMarketDemandSurfaceWorker();
  regionalSnapshots=startMarketRegionalSnapshotWorker();
  demandEvents=startMarketDemandEventWorker();
  newsSignals=startMarketNewsSignalWorker();
  competitorIntelligence=startCompetitorIntelligenceWorker();
  creativeResearch=startCreativeResearchWorker();
  googlePromotion=startGoogleIngestionPromotionWorker();
  ga4Market30d=startGa4Market30dWorker();
  controlPlane=startControlPlaneWorker();
  monitorSupport=startWorkerMonitorSupport();
  console.log('[WORKER SUITE] full DOMINANCE intelligence suite online');
}
async function stopWorkers(signal='SIGTERM'){
  if(coreSourceSync?.stop)await coreSourceSync.stop();
  if(profiler?.stop)await profiler.stop();
  if(advertising?.stop)await advertising.stop();
  if(marketIntelligence?.stop)await marketIntelligence.stop();
  if(demandSurface?.stop)await demandSurface.stop();
  if(regionalSnapshots?.stop)await regionalSnapshots.stop();
  if(demandEvents?.stop)await demandEvents.stop();
  if(newsSignals?.stop)await newsSignals.stop();
  if(competitorIntelligence?.stop)await competitorIntelligence.stop();
  if(creativeResearch?.stop)await creativeResearch.stop();
  if(googlePromotion?.stop)await googlePromotion.stop();
  if(ga4Market30d?.stop)await ga4Market30d.stop();
  if(controlPlane?.stop)await controlPlane.stop();
  if(monitorSupport?.stop)await monitorSupport.stop(signal);
}
start().catch(e=>{console.error('[WORKER SUITE] bootstrap failed',e);process.exit(1)});
process.on('SIGTERM',()=>stopWorkers('SIGTERM'));
process.on('SIGINT',()=>stopWorkers('SIGINT'));
