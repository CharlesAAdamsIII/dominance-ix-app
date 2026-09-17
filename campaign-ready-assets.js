(function(){
 'use strict';
 async function load(){
  try{
   const r=await fetch('/api/campaign/workspace',{headers:{Accept:'application/json'}});if(!r.ok)return;const d=await r.json();const rows=(d.creatives||[]).filter(x=>x.status==='ready_to_launch');
   const host=document.getElementById('creativeAssets');if(!host)return;
   if(rows.length){
    const block=document.createElement('div');block.style.gridColumn='1/-1';block.style.border='1px solid #2b4a3f';block.style.background='#0d211a';block.style.borderRadius='9px';block.style.padding='10px';block.innerHTML=`<div style="font-size:9px;letter-spacing:.1em;color:#6f8d82;font-weight:800">READY-TO-LAUNCH CREATIVE INVENTORY</div><div style="font-size:20px;font-weight:900;color:#73e6a2;margin-top:4px">${rows.length}</div><div style="font-size:10px;color:#91a9a0;margin-top:3px">Approved in Creative Intelligence and available for campaign assignment. Physical publishing still requires a write-capable ad-platform connector and Control Plane approval.</div>`;
    host.prepend(block);
   }
  }catch(e){console.warn('[CAMPAIGN READY ASSETS]',e)}
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(load,700),{once:true});else setTimeout(load,700);
})();
