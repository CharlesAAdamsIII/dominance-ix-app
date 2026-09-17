const {fork}=require('child_process');
const path=require('path');
let child=null,stopping=false,restartTimer=null;
function startCoreSourceSyncWorker(){
 if(child&&!child.killed)return{stop};
 stopping=false;
 const launch=()=>{
  if(stopping)return;
  child=fork(path.join(__dirname,'worker-auth-entry.js'),[],{env:{...process.env,DOMINANCE_SUPERVISED_CORE_SOURCE:'1'},stdio:'inherit'});
  console.log('[CORE SOURCE SYNC] supervised worker started',child.pid);
  child.on('exit',(code,signal)=>{
   console.log('[CORE SOURCE SYNC] worker exited',{code,signal,stopping});
   child=null;
   if(!stopping)restartTimer=setTimeout(launch,5000);
  });
  child.on('error',e=>console.error('[CORE SOURCE SYNC] child error',e));
 };
 launch();
 return{stop};
}
async function stop(){
 stopping=true;
 if(restartTimer){clearTimeout(restartTimer);restartTimer=null}
 if(!child)return;
 const p=child;
 await new Promise(resolve=>{
  const t=setTimeout(()=>{try{p.kill('SIGKILL')}catch{}resolve()},8000);
  p.once('exit',()=>{clearTimeout(t);resolve()});
  try{p.kill('SIGTERM')}catch{clearTimeout(t);resolve()}
 });
 child=null;
}
module.exports={startCoreSourceSyncWorker};
