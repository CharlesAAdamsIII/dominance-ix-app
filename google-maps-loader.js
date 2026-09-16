(function(){
  'use strict';
  const cfg=window.DOMINANCE_MAP_CONFIG||{};
  if(!cfg.enabled||!cfg.apiKey)return;
  window.gm_authFailure=function(){
    const msg='Google Maps authorization failed for '+window.location.origin+'. Check the browser-key website restriction, Maps JavaScript API enablement, billing, and Map ID.';
    console.error('[DOMINANCE]',msg);
    const scan=document.getElementById('scanText');
    if(scan)scan.textContent=msg+' DOMINANCE fallback map remains active.';
    let el=document.getElementById('domGoogleMapError');
    if(!el){el=document.createElement('div');el.id='domGoogleMapError';el.style.cssText='position:absolute;z-index:900;left:50%;top:100px;transform:translateX(-50%);max-width:680px;background:#271515ee;border:1px solid #7c3a3a;color:#ffd5d5;padding:10px 14px;border-radius:9px;font:10px Arial;line-height:1.45;text-align:center';document.querySelector('.mapwrap')?.appendChild(el)}
    el.textContent=msg;
  };
  if(window.google?.maps?.importLibrary)return;
  (g=>{var h,a,k,p='The Google Maps JavaScript API',c='google',l='importLibrary',q='__ib__',m=document,b=window;b=b[c]||(b[c]={});var d=b.maps||(b.maps={}),r=new Set,e=new URLSearchParams,u=()=>h||(h=new Promise(async(f,n)=>{await(a=m.createElement('script'));e.set('libraries',[...r]+'');for(k in g)e.set(k.replace(/[A-Z]/g,t=>'_'+t[0].toLowerCase()),g[k]);e.set('callback',c+'.maps.'+q);a.src='https://maps.'+c+'apis.com/maps/api/js?'+e;d[q]=f;a.onerror=()=>h=n(Error(p+' could not load.'));a.nonce=m.querySelector('script[nonce]')?.nonce||'';m.head.append(a)}));d[l]?console.warn(p+' only loads once. Ignoring:',g):d[l]=(f,...n)=>r.add(f)&&u().then(()=>d[l](f,...n))})({key:cfg.apiKey,v:'weekly'});
})();
