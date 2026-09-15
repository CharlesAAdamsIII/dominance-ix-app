const {startBusinessProfileWorker}=require('./business-profile-worker');
const {startAdIntelligenceWorker}=require('./ad-intelligence-worker');
const {startControlPlaneWorker}=require('./control-plane-worker');

const profiler=startBusinessProfileWorker();
const advertising=startAdIntelligenceWorker();
const controlPlane=startControlPlaneWorker();
require('./worker-monitor');

async function stopWorkers(){
  if(profiler?.stop)await profiler.stop();
  if(advertising?.stop)await advertising.stop();
  if(controlPlane?.stop)await controlPlane.stop();
}
process.on('SIGTERM',stopWorkers);
process.on('SIGINT',stopWorkers);
