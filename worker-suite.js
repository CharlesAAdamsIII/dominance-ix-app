const {startBusinessProfileWorker}=require('./business-profile-worker');

const profiler=startBusinessProfileWorker();
require('./worker-monitor');

async function stopProfiler(){
  if(profiler?.stop)await profiler.stop();
}
process.on('SIGTERM',stopProfiler);
process.on('SIGINT',stopProfiler);
