const {Pool}=require('pg');
const DATABASE_URL=process.env.DATABASE_URL||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false}):null;
function auth(req,res,next){if(req.session&&req.session.userId)return next();return res.status(401).json({ok:false,error:'Authentication required'})}
async function accountFor(req){const r=await pool.query(`SELECT id,account_key,company_name,website FROM dominance_accounts WHERE owner_user_id=$1 AND is_active=TRUE ORDER BY updated_at DESC LIMIT 1`,[req.session.userId]);return r.rows[0]||null}
function rowCount(provider,data){if(!data||typeof data!=='object')return 0;if(provider==='GADS')return Array.isArray(data.results)?data.results.length:0;return Array.isArray(data.rows)?data.rows.length:0}
function stateFor(c,s){const resources=Array.isArray(c.metadata?.resources)?c.metadata.resources:[],selected=c.metadata?.selected_resource||null,selectionWarning=/^Authorized; select one of /i.test(String(c.last_error||''));if(c.status!=='connected')return'not_connected';if(!selected&&resources.length>1)return'resource_selection_required';if(c.last_error&&!selectionWarning)return'error';if(s?.collected_at)return'synced';if(selected)return'awaiting_first_sync';return resources.length===1?'awaiting_first_sync':'discovering'}
function attach(router){
 router.get('/api/source-health/google',auth,async(req,res)=>{try{
  if(!pool)return res.status(503).json({ok:false,error:'Database unavailable'});const a=await accountFor(req);if(!a)return res.json({ok:true,account:null,sources:[]});
  const [connections,snapshots,counts,market,scan]=await Promise.all([
   pool.query(`SELECT provider_key,provider_name,status,metadata,last_sync_at,last_error,updated_at FROM dominance_connections WHERE account_id=$1 AND provider_key IN('GA4','GSC','GADS') ORDER BY provider_key`,[a.id]),
   pool.query(`SELECT DISTINCT ON(provider_key) provider_key,resource_key,snapshot_type,data,collected_at FROM dominance_data_snapshots WHERE account_id=$1 AND provider_key IN('GA4','GSC','GADS') ORDER BY provider_key,collected_at DESC`,[a.id]).catch(()=>({rows:[]})),
   pool.query(`SELECT provider_key,COUNT(*)::int snapshots_24h,MAX(collected_at) last_collected_at FROM dominance_data_snapshots WHERE account_id=$1 AND provider_key IN('GA4','GSC','GADS') AND collected_at>NOW()-INTERVAL '24 hours' GROUP BY provider_key`,[a.id]).catch(()=>({rows:[]})),
   pool.query(`SELECT COUNT(*)::int n,MAX(captured_at) last_at FROM dominance_market_snapshots WHERE account_id=$1 AND source_key='GA4_REALTIME' AND captured_at>NOW()-INTERVAL '24 hours'`,[a.id]).catch(()=>({rows:[{n:0,last_at:null}]})),
   pool.query(`SELECT status,summary,completed_at FROM dominance_scan_runs WHERE account_id=$1 AND scan_type='intelligence-cycle' ORDER BY id DESC LIMIT 1`,[a.id]).catch(()=>({rows:[]}))
  ]);
  const snapMap=new Map(snapshots.rows.map(x=>[x.provider_key,x])),countMap=new Map(counts.rows.map(x=>[x.provider_key,x]));
  const sources=connections.rows.map(c=>{const s=snapMap.get(c.provider_key),n=countMap.get(c.provider_key),resources=Array.isArray(c.metadata?.resources)?c.metadata.resources:[];return{provider:c.provider_key,name:c.provider_name,status:c.status,ingestion_state:stateFor(c,s),discovered_resources:resources.length,selected_resource:c.metadata?.selected_resource||null,last_resource_discovery_at:c.metadata?.last_resource_discovery_at||null,last_sync_at:c.last_sync_at||null,last_error:c.last_error||null,latest_snapshot:s?{resource_key:s.resource_key,snapshot_type:s.snapshot_type,collected_at:s.collected_at,rows:rowCount(c.provider_key,s.data)}:null,snapshots_24h:Number(n?.snapshots_24h||0),last_collected_at:n?.last_collected_at||null}});
  res.json({ok:true,account:a,sources,google_ads_auth:{developer_token_configured:!!String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN||'').trim(),login_customer_id_configured:/^\d+$/.test(String(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID||'').replace(/\D/g,''))},ga4_realtime:{observations_24h:Number(market.rows[0]?.n||0),last_observation_at:market.rows[0]?.last_at||null},latest_worker_scan:scan.rows[0]||null});
 }catch(e){res.status(500).json({ok:false,error:e.message})}})
}
module.exports={attach};
