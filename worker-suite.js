const {startBusinessProfileWorker}=require('./business-profile-worker');
const {startAdIntelligenceWorker}=require('./ad-intelligence-worker');
const {startControlPlaneWorker}=require('./control-plane-worker');
const {startMarketIntelligenceWorker}=require('./market-intelligence-worker');
const {ensureProvenanceTrigger}=require('./provenance-trigger');
const releases=require('./intelligence-release-gate');
const adCore=require('./ad-intelligence-core');
const marketCore=require('./market-intelligence-core');
const cp=require('./control-plane-core');

let profiler=null,advertising=null,controlPlane=null,marketIntelligence=null;
async function start(){
  const bootstrap=adCore.makePool();
  if(bootstrap){
    await adCore.ensureAdSchema(bootstrap);
    await marketCore.ensureSchema(bootstrap);
    await cp.ensureControlPlaneSchema(bootstrap);
    await releases.ensureReleaseSchema(bootstrap);
    await ensureProvenanceTrigger(bootstrap);
    await bootstrap.end().catch(()=>{});
  }
  profiler=startBusinessProfileWorker();
  advertising=startAdIntelligenceWorker();
  marketIntelligence=startMarketIntelligenceWorker();
  controlPlane=startControlPlaneWorker();
  require('./worker-monitor');
}
async function stopWorkers(){
  if(profiler?.stop)await profiler.stop();
  if(advertising?.stop)await advertising.stop();
  if(marketIntelligence?.stop)await marketIntelligence.stop();
  if(controlPlane?.stop)await controlPlane.stop();
}
start().catch(e=>{console.error('[WORKER SUITE] bootstrap failed',e);process.exit(1)});
process.on('SIGTERM',stopWorkers);
process.on('SIGINT',stopWorkers);
