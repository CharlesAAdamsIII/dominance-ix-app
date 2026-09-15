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
      require('./ad-intelligence-api').attach(router);
      require('./control-plane-api').attach(router);
      require('./campaign-workspace-api').attach(router);
      require('./market-intelligence-api').attach(router);
      router.get('/integrity.html',(req,res,next)=>{try{const file=fs.readFileSync(path.join(__dirname,'integrity.html'),'utf8');res.type('html').send(file.replace('</body>','<script src="/sidebar-collapse.js"></script></body>'))}catch(e){next(e)}});
      router.get('/advertising.html',(req,res,next)=>{try{const file=fs.readFileSync(path.join(__dirname,'advertising.html'),'utf8');res.type('html').send(file.replace('</body>','<script src="/context.js"></script></body>'))}catch(e){next(e)}});
      const stack=app._router?.stack||[];
      let insertAt=stack.findIndex(layer=>layer?.route?.path==='/campaign.html');
      if(insertAt<0)insertAt=stack.findIndex(layer=>layer?.name==='serveStatic');
      if(insertAt<0)insertAt=stack.findIndex(layer=>layer?.route?.path==='*');
      if(insertAt<0)insertAt=stack.length;
      stack.splice(insertAt,0,...router.stack);
      console.log('[DOMINANCE] Advertising + Control Plane + Campaign + Market Intelligence APIs attached');
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
