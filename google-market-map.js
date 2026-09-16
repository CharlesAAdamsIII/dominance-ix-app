(function(){
  'use strict';
  const cfg=window.DOMINANCE_MAP_CONFIG||{};
  if(!cfg.enabled||!cfg.apiKey||!cfg.mapId)return;
  const GEO_CACHE_KEY='dominance_google_geo_cache_v1';
  const cache=(()=>{try{return JSON.parse(localStorage.getItem(GEO_CACHE_KEY)||'{}')}catch{return{}}})();
  const saveCache=()=>{try{localStorage.setItem(GEO_CACHE_KEY,JSON.stringify(cache))}catch{}};
  const finite=v=>Number.isFinite(Number(v));
  const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number(v||0)));
  const norm=s=>String(s||'').trim().toLowerCase().replace(/\s+/g,' ');
  const rgb=v=>v>=85?[255,217,90]:v>=75?[243,184,79]:v>=65?[102,224,189]:v>=55?[56,183,178]:v>=40?[77,125,140]:[52,73,83];
  let gmap=null,overlay=null,geocoder=null,ready=false,geocodeBusy=false,pulsePhase=0,pulseTimer=null;

  function marketCoordGoogle(m){
    if(finite(m?.latitude)&&finite(m?.longitude))return{lat:Number(m.latitude),lng:Number(m.longitude)};
    try{const c=marketCoord(m);if(c&&finite(c[0])&&finite(c[1]))return{lat:Number(c[0]),lng:Number(c[1])}}catch{}
    const mn=norm(m?.name),rn=norm(m?.region);
    for(const t of(state?.targets||[])){
      if(!t?.enabled||!finite(t.latitude)||!finite(t.longitude))continue;
      const tn=norm(t.name);
      if(tn===mn||tn.includes(mn)||mn.includes(tn)||(rn&&(tn.includes(rn)||rn.includes(tn))))return{lat:Number(t.latitude),lng:Number(t.longitude)};
    }
    for(const k of[mn,rn]){const c=cache[k];if(c&&finite(c.lat)&&finite(c.lng))return{lat:Number(c.lat),lng:Number(c.lng)}}
    return null;
  }
  function metric(m){const key=typeof activeLayer==='string'?activeLayer:'score';return clamp(m?.[key]);}
  function radiusMeters(m,v){const type=String(m?.type||'').toLowerCase();const base=type==='city'?22000:type==='state'?90000:55000;return base+(v/100)*(type==='state'?140000:75000)}
  function selectedName(){try{return selected?.name||''}catch{return''}}
  function setDiagnostics(mapped,total){
    let el=document.getElementById('domSpatialStatus');
    if(!el){el=document.createElement('div');el.id='domSpatialStatus';el.style.cssText='position:absolute;z-index:650;right:14px;bottom:16px;background:#071017e8;border:1px solid #5c4820;border-radius:8px;padding:8px 10px;font:9px Arial;color:#a9bdc7;line-height:1.45;pointer-events:none;max-width:260px';document.querySelector('.mapwrap')?.appendChild(el)}
    const layerName=(typeof layers!=='undefined'&&layers.find(x=>x[0]===activeLayer)?.[1])||activeLayer||'Opportunity';
    el.innerHTML='<b style="color:#f3ce62">GOOGLE VECTOR · DECK.GL</b><br>'+mapped+'/'+total+' markets mapped<br>Layer: '+layerName+(mapped<total?'<br><span style="color:#ffd36d">Resolving '+(total-mapped)+' unmapped location'+(total-mapped===1?'':'s')+'…</span>':'');
  }
  function updateLegend(){const legend=document.getElementById('legend');if(!legend)return;const title=(typeof layers!=='undefined'&&layers.find(x=>x[0]===activeLayer)?.[1])||activeLayer||'Opportunity';legend.innerHTML='<b>'+title+'</b><div style="margin-top:5px;width:150px;height:7px;border-radius:8px;background:linear-gradient(90deg,#16394b,#1d777f,#36b9a7,#84d99a,#f3b84f,#ffd95a)"></div><div style="display:flex;justify-content:space-between;color:#8398a5;font-size:8px;margin-top:3px"><span>LOW</span><span>CONCENTRATED</span><span>HIGH</span></div><div style="margin-top:5px;color:#91a6b2;font-size:8px">Heat = concentration · halo = opportunity · gold pulse = accelerating demand</div>'}
  function renderGoogle(){
    if(!ready||!overlay||typeof deck==='undefined')return;
    const markets=(state?.markets||[]).slice(0,80),mapped=[];
    for(const m of markets){const c=marketCoordGoogle(m);if(c)mapped.push({m,c,v:metric(m)})}
    const heatData=mapped.filter(x=>x.v>5).map(x=>({position:[x.c.lng,x.c.lat],weight:Math.max(.05,x.v/100),market:x.m}));
    const points=mapped.map(x=>({position:[x.c.lng,x.c.lat],value:x.v,market:x.m}));
    const targets=(state?.targets||[]).filter(t=>t.enabled&&finite(t.latitude)&&finite(t.longitude)).map(t=>({position:[Number(t.longitude),Number(t.latitude)],radius:Number(t.radius_miles||25)*1609.344,target:t}));
    const highVelocity=points.filter(x=>Number(x.market?.velocity||0)>=65);
    const labels=(gmap?.getZoom?.()||4)>=5?points.filter(x=>x.value>=65):[];
    const deckLayers=[
      new deck.HeatmapLayer({id:'dom-demand-heat',data:heatData,getPosition:d=>d.position,getWeight:d=>d.weight,radiusPixels:(gmap?.getZoom?.()||4)<=4?48:34,intensity:1.25,threshold:.03,colorRange:[[22,57,75],[29,119,127],[54,185,167],[132,217,154],[243,184,79],[255,217,90]]}),
      new deck.ScatterplotLayer({id:'dom-market-halos',data:points,getPosition:d=>d.position,getRadius:d=>radiusMeters(d.market,d.value),radiusUnits:'meters',filled:true,stroked:true,getFillColor:d=>[...rgb(d.value),28],getLineColor:d=>[...rgb(d.value),d.value>=72?210:120],lineWidthMinPixels:1,getLineWidth:d=>d.value>=72?2:1,pickable:true,onClick:info=>{if(info.object)selectMarket(info.object.market,true)}}),
      new deck.ScatterplotLayer({id:'dom-market-points',data:points,getPosition:d=>d.position,getRadius:d=>d.market?.name===selectedName()?9000:6000,radiusUnits:'meters',radiusMinPixels:5,radiusMaxPixels:14,filled:true,stroked:true,getFillColor:d=>[...rgb(d.value),230],getLineColor:d=>d.market?.name===selectedName()?[255,255,255,255]:[12,24,31,220],lineWidthMinPixels:2,pickable:true,onClick:info=>{if(info.object)selectMarket(info.object.market,true)}}),
      new deck.ScatterplotLayer({id:'dom-target-radii',data:targets,getPosition:d=>d.position,getRadius:d=>d.radius,radiusUnits:'meters',filled:true,stroked:true,getFillColor:d=>d.target.source==='user'?[243,206,98,20]:[93,224,194,16],getLineColor:d=>d.target.source==='user'?[243,206,98,230]:[93,224,194,200],lineWidthMinPixels:2,pickable:false}),
      new deck.ScatterplotLayer({id:'dom-velocity-pulse',data:highVelocity,getPosition:d=>d.position,getRadius:d=>(28000+Number(d.market.velocity||0)*600)*(1+pulsePhase*.35),radiusUnits:'meters',filled:false,stroked:true,getLineColor:[243,206,98,Math.round(150*(1-pulsePhase*.55))],lineWidthMinPixels:2,pickable:false}),
      new deck.TextLayer({id:'dom-market-labels',data:labels,getPosition:d=>d.position,getText:d=>String(d.market.name)+' · '+Math.round(d.value),getSize:11,sizeUnits:'pixels',getColor:[236,247,251,230],getTextAnchor:'middle',getAlignmentBaseline:'bottom',background:true,getBackgroundColor:[7,16,23,210],backgroundPadding:[4,2],pickable:false})
    ];
    overlay.setProps({layers:deckLayers,getTooltip:({object})=>object?.market?`${object.market.name}\n${Math.round(object.value||metric(object.market))}/100 · ${object.market.decision||''}`:null});
    setDiagnostics(mapped.length,markets.length);updateLegend();queueMarketGeocodes(markets.filter(m=>!marketCoordGoogle(m)).slice(0,8));
  }
  async function geocodeMarket(m){
    const key=norm(m?.name);if(!key||cache[key]||!geocoder)return false;
    try{const response=await geocoder.geocode({address:String(m.name)+(m.region&&norm(m.region)!==key?', '+m.region:''),componentRestrictions:{country:'US'}});const r=response.results?.[0];if(r){cache[key]={lat:r.geometry.location.lat(),lng:r.geometry.location.lng(),name:r.formatted_address,at:Date.now()};saveCache();return true}}catch(e){console.warn('[GOOGLE MAP] market geocode failed',m?.name,e.message)}cache[key]={failed:true,at:Date.now()};saveCache();return false;
  }
  async function queueMarketGeocodes(list){if(geocodeBusy||!list.length)return;geocodeBusy=true;let changed=false;for(const m of list){const c=cache[norm(m.name)];if(c?.failed&&Date.now()-Number(c.at||0)<86400000)continue;if(await geocodeMarket(m))changed=true;await new Promise(r=>setTimeout(r,180))}geocodeBusy=false;if(changed)renderGoogle()}
  async function googleSearchLocation(){
    const q=$('locationSearch').value.trim();if(!q||!geocoder)return;$('locationResults').innerHTML='<div class="empty">Searching Google…</div>';
    try{const response=await geocoder.geocode({address:q,componentRestrictions:{country:'US'}});const results=(response.results||[]).slice(0,5).map(r=>({name:r.formatted_address,latitude:r.geometry.location.lat(),longitude:r.geometry.location.lng(),type:r.types?.[0]||'location',category:'google_geocoding'}));window._geo=results;$('locationResults').innerHTML=results.map((x,i)=>`<div class="result" onclick="chooseLocation(${i})">${esc(x.name)}</div>`).join('')||'<div class="empty">No U.S. location found.</div>'}catch(e){$('locationResults').innerHTML='<div class="empty">'+esc(e.message||'Google location lookup failed.')+'</div>'}
  }
  function patchUi(){
    try{drawMap=renderGoogle}catch{}
    try{selectMarket=function(m,fly){selected=m;renderSelected();renderGoogle();const c=marketCoordGoogle(m);if(fly&&c&&gmap){gmap.panTo(c);gmap.setZoom(String(m?.type||'').toLowerCase()==='city'?7:5)}}}catch{}
    try{searchLocation=googleSearchLocation}catch{}
    try{const b=document.getElementById('profileBadge');if(b)b.title='Google Maps vector renderer with deck.gl intelligence overlays'}catch{}
  }
  async function init(){
    try{
      if(!window.google?.maps?.importLibrary)throw Error('Google Maps loader did not initialize.');
      if(typeof deck==='undefined'||!deck.GoogleMapsOverlay)throw Error('deck.gl Google Maps bundle did not initialize.');
      const {Map}=await google.maps.importLibrary('maps');const {Geocoder}=await google.maps.importLibrary('geocoding');
      geocoder=new Geocoder();
      try{if(typeof map!=='undefined'&&map&&typeof map.remove==='function')map.remove()}catch{}
      const el=document.getElementById('map');if(!el)throw Error('Market map container missing.');el.innerHTML='';el.className='map';
      gmap=new Map(el,{center:{lat:38.5,lng:-96},zoom:4,mapId:cfg.mapId,tilt:0,heading:0,gestureHandling:'greedy',mapTypeControl:false,streetViewControl:false,fullscreenControl:true,zoomControl:true,clickableIcons:false});
      overlay=new deck.GoogleMapsOverlay({interleaved:true,layers:[]});overlay.setMap(gmap);ready=true;patchUi();
      gmap.addListener('zoom_changed',()=>setTimeout(renderGoogle,40));gmap.addListener('heading_changed',()=>setTimeout(renderGoogle,40));gmap.addListener('tilt_changed',()=>setTimeout(renderGoogle,40));
      pulseTimer=setInterval(()=>{pulsePhase=(pulsePhase+.18)%1;renderGoogle()},1400);
      setTimeout(renderGoogle,0);
      const scan=document.getElementById('scanText');if(scan)scan.textContent=(scan.textContent||'DOMINANCE Market Radar')+' · Google vector map active';
      console.log('[DOMINANCE] Google Maps vector + deck.gl renderer active');
    }catch(e){console.error('[DOMINANCE] Google Maps migration failed; Leaflet fallback remains available.',e);const scan=document.getElementById('scanText');if(scan)scan.textContent='Google map unavailable; using DOMINANCE fallback map. '+(e.message||'')}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(init,0),{once:true});else setTimeout(init,0);
})();
