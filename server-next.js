require('./google-ads-fetch-auth');
const fs=require('fs');
const path=require('path');
const expressPath=require.resolve('express');
const originalExpress=require(expressPath);
let intelligenceRescue=null;
function wrappedExpress(...args){
  const app=originalExpress(...args);
  const originalListen=app.listen.bind(app);
  app.listen=(...listenArgs)=>{
    try{
      const router=originalExpress.Router();
      const pageAuth=(req,res,next)=>req.session&&req.session.userId?next():res.redirect('/login.html');
      require('./ad-intelligence-api').attach(router);
      require('./control-plane-api').attach(router);
      require('./campaign-workspace-api').attach(router);
      require('./market-intelligence-api').attach(router);
      require('./market-live-intelligence-api').attach(router);
      require('./competitor-intelligence-api').attach(router);
      require('./creative-evidence-api').attach(router);
      require('./creative-library-api').attach(router);
      require('./source-health-api').attach(router);
      const marketRadarPage=(req,res,next)=>{try{
        const file=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
        const mapsKey=process.env.GOOGLE_MAPS_BROWSER_API_KEY||'';
        const mapId=process.env.GOOGLE_MAPS_MAP_ID||'';
        const missing=[!mapsKey?'GOOGLE_MAPS_BROWSER_API_KEY':null,!mapId?'GOOGLE_MAPS_MAP_ID':null].filter(Boolean);
        const googleEnabled=missing.length===0;
        const googleConfig=`<script>window.DOMINANCE_MAP_CONFIG=${JSON.stringify({enabled:googleEnabled,apiKey:mapsKey,mapId,missing})}</script>`;
        const configNotice=!googleEnabled?`<script>setTimeout(()=>{const e=document.getElementById('scanText');if(e)e.textContent='Google vector map is not enabled on this web service. Missing: ${missing.join(', ')}. DOMINANCE fallback map is active.'},0)</script>`:'';
        const leafletFallback='<script src="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js"></script><script src="/market-basemap.js?v=1"></script><script src="/market-map-layer-extension.js?v=2"></script><script src="/market-map-visuals.js?v=1"></script><script src="/market-map-layout.js?v=1"></script>';
        const googleSpatial=googleEnabled?'<script src="/google-maps-loader.js?v=2"></script><script src="https://unpkg.com/deck.gl@^9.0.0/dist.min.js"></script><script src="/google-market-map.js?v=3"></script>':'';
        const liveRadar='<script src="/market-live-radar.js?v=2"></script><script src="/market-integrity-gate.js?v=1"></script>';
        res.type('html').send(file.replace('</body>',googleConfig+leafletFallback+googleSpatial+liveRadar+configNotice+'</body>'));
      }catch(e){next(e)}};
      const injectPage=(fileName,scripts)=>(req,res,next)=>{try{const file=fs.readFileSync(path.join(__dirname,fileName),'utf8');res.type('html').send(file.replace('</body>',scripts+'</body>'))}catch(e){next(e)}};
      router.get('/',pageAuth,marketRadarPage);
      router.get('/index.html',pageAuth,marketRadarPage);
      router.get('/admin.html',pageAuth,injectPage('admin.html','<script src="/source-health-ui.js?v=1"></script>'));
      router.get('/competitor.html',pageAuth,injectPage('competitor.html','<script src="/competitor-integrity.js?v=1"></script>'));
      router.get('/creative.html',pageAuth,injectPage('creative.html','<script src="/creative-integrity.js?v=2"></script><script src="/creative-library.js?v=2"></script>'));
      router.get('/integrity.html',pageAuth,(req,res,next)=>{try{const file=fs.readFileSync(path.join(__dirname,'integrity.html'),'utf8');res.type('html').send(file.replace('</body>','<script src="/sidebar-collapse.js"></script></body>'))}catch(e){next(e)}});
      router.get('/advertising.html',pageAuth,(req,res,next)=>{try{const file=fs.readFileSync(path.join(__dirname,'advertising.html'),'utf8');res.type('html').send(file.replace('</body>','<script src="/context.js"></script></body>'))}catch(e){next(e)}});
      const stack=app._router?.stack||[];
      let insertAt=stack.findIndex(layer=>layer?.route?.path==='/'||layer?.route?.path==='/index.html');
      if(insertAt<0)insertAt=stack.findIndex(layer=>layer?.route?.path==='/campaign.html');
      if(insertAt<0)insertAt=stack.findIndex(layer=>layer?.name==='serveStatic');
      if(insertAt<0)insertAt=stack.findIndex(layer=>layer?.route?.path==='*');
      if(insertAt<0)insertAt=stack.length;
      stack.splice(insertAt,0,...router.stack);
      if(!intelligenceRescue)intelligenceRescue=require('./intelligence-rescue').startIntelligenceRescue();
      console.log(`[DOMINANCE] APIs attached; Market Radar preferred engine=${process.env.GOOGLE_MAPS_BROWSER_API_KEY&&process.env.GOOGLE_MAPS_MAP_ID?'google-vector-deckgl':'leaflet-fallback'} live-telemetry=enabled evidence-gates=enabled creative-cms=enabled source-health=enabled rescue=${intelligenceRescue?'armed':'unavailable'}`);
    }catch(e){console.error('[DOMINANCE] API attach failed',e)}
    return originalListen(...listenArgs);
  };
  return app;
}
Object.assign(wrappedExpress,originalExpress);
wrappedExpress.Router=originalExpress.Router;
wrappedExpress.static=originalExpress.static;
wrappedExpress.json=originalExpress.json;
wrappedExpress.urlencoded=originalExpress.urlencoded;
require.cache[expressPath].exports=wrappedExpress;
require('./server-production');
