const fs=require('fs');
const path=require('path');
const expressPath=require.resolve('express');
const originalExpress=require(expressPath);
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
      require('./competitor-intelligence-api').attach(router);
      const marketRadarPage=(req,res,next)=>{try{
        const file=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
        const mapsKey=process.env.GOOGLE_MAPS_BROWSER_API_KEY||'';
        const mapId=process.env.GOOGLE_MAPS_MAP_ID||'';
        const googleEnabled=!!(mapsKey&&mapId);
        const googleConfig=`<script>window.DOMINANCE_MAP_CONFIG=${JSON.stringify({enabled:googleEnabled,apiKey:mapsKey,mapId})}</script>`;
        const googleSpatial=googleEnabled?'<script src="https://unpkg.com/deck.gl@^9.0.0/dist.min.js"></script><script src="/market-map-layer-extension.js?v=2"></script><script src="/google-market-map.js?v=1"></script>':'';
        const leafletFallback=!googleEnabled?'<script src="https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js"></script><script src="/market-basemap.js?v=1"></script><script src="/market-map-layer-extension.js?v=2"></script><script src="/market-map-visuals.js?v=1"></script><script src="/market-map-layout.js?v=1"></script>':'';
        res.type('html').send(file.replace('</body>',googleConfig+googleSpatial+leafletFallback+'</body>'));
      }catch(e){next(e)}};
      router.get('/',pageAuth,marketRadarPage);
      router.get('/index.html',pageAuth,marketRadarPage);
      router.get('/integrity.html',pageAuth,(req,res,next)=>{try{const file=fs.readFileSync(path.join(__dirname,'integrity.html'),'utf8');res.type('html').send(file.replace('</body>','<script src="/sidebar-collapse.js"></script></body>'))}catch(e){next(e)}});
      router.get('/advertising.html',pageAuth,(req,res,next)=>{try{const file=fs.readFileSync(path.join(__dirname,'advertising.html'),'utf8');res.type('html').send(file.replace('</body>','<script src="/context.js"></script></body>'))}catch(e){next(e)}});
      const stack=app._router?.stack||[];
      let insertAt=stack.findIndex(layer=>layer?.route?.path==='/'||layer?.route?.path==='/index.html');
      if(insertAt<0)insertAt=stack.findIndex(layer=>layer?.route?.path==='/campaign.html');
      if(insertAt<0)insertAt=stack.findIndex(layer=>layer?.name==='serveStatic');
      if(insertAt<0)insertAt=stack.findIndex(layer=>layer?.route?.path==='*');
      if(insertAt<0)insertAt=stack.length;
      stack.splice(insertAt,0,...router.stack);
      console.log(`[DOMINANCE] APIs attached; Market Radar map engine=${process.env.GOOGLE_MAPS_BROWSER_API_KEY&&process.env.GOOGLE_MAPS_MAP_ID?'google-vector-deckgl':'leaflet-fallback'}`);
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
