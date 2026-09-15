const {startBusinessProfileWorker}=require('./business-profile-worker');
const {startAdIntelligenceWorker}=require('./ad-intelligence-worker');

const profiler=startBusinessProfileWorker();
const advertising=startAdIntelligenceWorker();
require('./worker-monitor');

async function stopWorkers(){
  if(profiler?.stop)await profiler.stop();
  if(advertising?.stop)await advertising.stop();
}
process.on('SIGTERM',stopWorkers);
process.on('SIGINT',stopWorkers);
