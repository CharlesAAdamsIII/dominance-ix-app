const expressPath=require.resolve('express');
const originalExpress=require(expressPath);
function wrappedExpress(...args){
  const app=originalExpress(...args);
  const originalListen=app.listen.bind(app);
  app.listen=(...listenArgs)=>{
    try{
      const router=originalExpress.Router();
      require('./ad-intelligence-api').attach(router);
      const stack=app._router?.stack||[];
      let insertAt=stack.findIndex(layer=>layer?.name==='serveStatic');
      if(insertAt<0)insertAt=stack.findIndex(layer=>layer?.route?.path==='*');
      if(insertAt<0)insertAt=stack.length;
      stack.splice(insertAt,0,...router.stack);
      console.log('[AD INTELLIGENCE] API routes attached');
    }catch(e){console.error('[AD INTELLIGENCE] API attach failed',e)}
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
