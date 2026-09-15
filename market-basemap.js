(function(){
  'use strict';
  function replaceBasemap(){
    if(typeof map==='undefined'||typeof L==='undefined')return;
    const old=[];
    map.eachLayer(layer=>{if(layer instanceof L.TileLayer)old.push(layer)});
    old.forEach(layer=>{try{map.removeLayer(layer)}catch{}});
    const esri=L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',{
      attribution:'Tiles © Esri — Sources: Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS user community',
      maxZoom:16,
      crossOrigin:true
    });
    const labels=L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',{
      attribution:'',
      maxZoom:16,
      pane:'overlayPane',
      crossOrigin:true
    });
    const osm=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
      attribution:'© OpenStreetMap contributors',
      maxZoom:19,
      crossOrigin:true
    });
    let failures=0,fallback=false;
    esri.on('tileerror',()=>{failures++;if(failures>=4&&!fallback){fallback=true;try{map.removeLayer(esri);map.removeLayer(labels)}catch{}osm.addTo(map);console.warn('[MARKET BASEMAP] Esri tiles unavailable; using OpenStreetMap fallback.')}});
    esri.addTo(map);labels.addTo(map);
    setTimeout(()=>{try{map.invalidateSize()}catch{}},150);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(replaceBasemap,0),{once:true});else setTimeout(replaceBasemap,0);
})();
