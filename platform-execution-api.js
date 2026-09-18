'use strict';

const core=require('./execution-gateway-core');
const build=require('./platform-build-core');
const adCore=require('./ad-intelligence-core');
const pool=adCore.makePool();

function auth(req,res,next){if(req.session&&req.session.userId)return next();return res.status(401).json({ok:false,error:'Authentication required'})}
async function accountFor(req){const r=await pool.query('SELECT * FROM dominance_accounts WHERE owner_user_id=$1 AND is_active=TRUE ORDER BY updated_at DESC LIMIT 1',[req.session.userId]);return r.rows[0]||null}

function attach(router){
  router.get('/api/execution/status',auth,async(req,res)=>{
    try{
      const a=await accountFor(req);if(!a)return res.status(400).json({ok:false,error:'Create a customer account first.'});
      await core.ensureSchema(pool);
      const [builds,receipts,connections]=await Promise.all([
        pool.query('SELECT * FROM dominance_execution_builds WHERE account_id=$1 ORDER BY updated_at DESC LIMIT 100',[a.id]),
        pool.query('SELECT * FROM dominance_execution_receipts WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100',[a.id]),
        pool.query(`SELECT provider_key,provider_name,status,metadata,last_sync_at,last_error FROM dominance_connections WHERE account_id=$1 ORDER BY provider_key`,[a.id])
      ]);
      const platforms=Object.entries(build.PLATFORM_RULES).map(([platform,rules])=>({platform,connector:rules.connector,write_adapter_available:rules.supports_write,connection_required:true}));
      res.json({ok:true,account:{id:a.id,company_name:a.company_name},platforms,connections:connections.rows,builds:builds.rows,receipts:receipts.rows});
    }catch(e){res.status(500).json({ok:false,error:e.message})}
  });
  router.get('/api/execution/recommendations/:id/preview',auth,async(req,res)=>{
    try{
      const a=await accountFor(req);if(!a)return res.status(400).json({ok:false,error:'No active customer.'});
      const r=await pool.query('SELECT * FROM dominance_ad_recommendations WHERE id=$1 AND dominance_account_id=$2',[req.params.id,a.id]);
      if(!r.rows[0])return res.status(404).json({ok:false,error:'Recommendation not found.'});
      res.json({ok:true,build:await core.prepareBuild(pool,r.rows[0],a)});
    }catch(e){res.status(400).json({ok:false,error:e.message})}
  });
  router.get('/api/creative-intelligence/provenance/:creativeId',auth,async(req,res)=>{
    try{
      const a=await accountFor(req);if(!a)return res.status(400).json({ok:false,error:'No active customer.'});
      await core.ensureSchema(pool);
      const r=await pool.query('SELECT creative_id,generated_asset_id,request_id,platform,manifest_hash,research_backed,manifest,created_at FROM dominance_creative_provenance WHERE account_id=$1 AND creative_id=$2',[a.id,req.params.creativeId]);
      if(!r.rows[0])return res.status(404).json({ok:false,error:'Research provenance is not available for this creative.'});
      res.json({ok:true,provenance:r.rows[0]});
    }catch(e){res.status(500).json({ok:false,error:e.message})}
  });

}
module.exports={attach};
