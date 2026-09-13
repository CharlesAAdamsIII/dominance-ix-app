const {Pool}=require('pg');
const crypto=require('crypto');

const DATABASE_URL=process.env.DATABASE_URL||'';
const GOOGLE_CLIENT_ID=process.env.GOOGLE_CLIENT_ID||'';
const GOOGLE_CLIENT_SECRET=process.env.GOOGLE_CLIENT_SECRET||'';
const GOOGLE_ADS_DEVELOPER_TOKEN=process.env.GOOGLE_ADS_DEVELOPER_TOKEN||'';
const CREDENTIAL_ENCRYPTION_KEY=process.env.CREDENTIAL_ENCRYPTION_KEY||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
const INTERVAL_MS=Math.max(5,Number(process.env.WORKER_INTERVAL_MINUTES||15))*60*1000;

if(!DATABASE_URL){console.error('DOMINANCE worker requires DATABASE_URL');process.exit(1)}
const pool=new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false});

async function ensure(){
 await pool.query(`CREATE TABLE IF NOT EXISTS dominance_worker_state(worker_key TEXT PRIMARY KEY,last_heartbeat_at TIMESTAMPTZ,last_run_at TIMESTAMPTZ,status TEXT,details JSONB NOT NULL DEFAULT '{}'::jsonb)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS dominance_scan_runs(id BIGSERIAL PRIMARY KEY,account_id BIGINT NOT NULL REFERENCES dominance_accounts(id) ON DELETE CASCADE,scan_type TEXT NOT NULL,source_key TEXT,status TEXT NOT NULL,summary JSONB NOT NULL DEFAULT '{}'::jsonb,started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS dominance_data_snapshots(
   id BIGSERIAL PRIMARY KEY,
   account_id BIGINT NOT NULL REFERENCES dominance_accounts(id) ON DELETE CASCADE,
   provider_key TEXT NOT NULL,
   resource_key TEXT,
   snapshot_type TEXT NOT NULL,
   period_start DATE,
   period_end DATE,
   data JSONB NOT NULL DEFAULT '{}'::jsonb,
   collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`);
 await pool.query(`CREATE INDEX IF NOT EXISTS idx_dom_snapshots_account_provider ON dominance_data_snapshots(account_id,provider_key,collected_at DESC)`);
}

async function heartbeat(status='idle',details={}){
 await pool.query(`INSERT INTO dominance_worker_state(worker_key,last_heartbeat_at,last_run_at,status,details) VALUES('intelligence-worker',NOW(),NOW(),$1,$2::jsonb) ON CONFLICT(worker_key) DO UPDATE SET last_heartbeat_at=NOW(),last_run_at=NOW(),status=EXCLUDED.status,details=EXCLUDED.details`,[status,JSON.stringify(details)])
}

function encryptionKey(){if(!CREDENTIAL_ENCRYPTION_KEY)throw Error('CREDENTIAL_ENCRYPTION_KEY missing on worker');return crypto.createHash('sha256').update(CREDENTIAL_ENCRYPTION_KEY).digest()}
function decryptObject(text){const parts=String(text||'').split('.');if(parts.length!==3)throw Error('Encrypted credential payload is invalid');const [iv,tag,data]=parts.map(x=>Buffer.from(x,'base64url'));const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey(),iv);decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8'))}
function encryptObject(obj){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey(),iv),data=Buffer.concat([cipher.update(JSON.stringify(obj),'utf8'),cipher.final()]),tag=cipher.getAuthTag();return [iv,tag,data].map(x=>x.toString('base64url')).join('.')}

async function accessToken(connection){
 let t=decryptObject(connection.credential_ciphertext);
 if(t.access_token&&Number(t.expires_at||0)>Date.now()+60000)return t.access_token;
 if(!t.refresh_token)throw Error('Google refresh token missing; reconnect this source');
 if(!GOOGLE_CLIENT_ID||!GOOGLE_CLIENT_SECRET)throw Error('Google OAuth client credentials missing on worker');
 const body=new URLSearchParams({client_id:GOOGLE_CLIENT_ID,client_secret:GOOGLE_CLIENT_SECRET,refresh_token:t.refresh_token,grant_type:'refresh_token'});
 const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
 const fresh=await r.json();
 if(!r.ok)throw Error(fresh.error_description||fresh.error||'Unable to refresh Google token');
 t={...t,...fresh,refresh_token:t.refresh_token,expires_at:Date.now()+Number(fresh.expires_in||3600)*1000};
 await pool.query('UPDATE dominance_connections SET credential_ciphertext=$1,updated_at=NOW() WHERE id=$2',[encryptObject(t),connection.id]);
 return t.access_token;
}

async function googleJson(url,token,options={}){
 const r=await fetch(url,{...options,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(options.headers||{})}});
 const d=await r.json().catch(()=>({}));
 if(!r.ok)throw Error(d.error?.message||d.error?.status||d.error||`Google API ${r.status}`);
 return d;
}

function dates(days=30){const end=new Date(),start=new Date(Date.now()-(days-1)*86400000);const f=d=>d.toISOString().slice(0,10);return{start:f(start),end:f(end)}}

async function discoverGA4(connection,token){
 const d=await googleJson('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200',token),resources=[];
 for(const acct of d.accountSummaries||[])for(const p of acct.propertySummaries||[])resources.push({id:String(p.property||'').replace('properties/',''),name:p.displayName||p.property,parent:acct.displayName||acct.account,resource:p.property});
 return resources;
}
async function discoverGSC(connection,token){const d=await googleJson('https://www.googleapis.com/webmasters/v3/sites',token);return(d.siteEntry||[]).map(x=>({id:x.siteUrl,name:x.siteUrl,parent:x.permissionLevel||'',resource:x.siteUrl}))}
async function discoverGADS(connection,token){
 if(!GOOGLE_ADS_DEVELOPER_TOKEN)throw Error('GOOGLE_ADS_DEVELOPER_TOKEN missing on worker');
 const d=await googleJson('https://googleads.googleapis.com/v25/customers:listAccessibleCustomers',token,{headers:{'developer-token':GOOGLE_ADS_DEVELOPER_TOKEN}});
 return(d.resourceNames||[]).map(x=>({id:String(x).replace('customers/',''),name:String(x).replace('customers/',''),resource:x}))
}

async function syncGA4(a,connection,token,resource){
 const property=String(resource).replace(/^properties\//,'');const p=dates(30);
 const body={dateRanges:[{startDate:p.start,endDate:p.end}],dimensions:[{name:'date'},{name:'sessionDefaultChannelGroup'}],metrics:[{name:'sessions'},{name:'totalUsers'},{name:'conversions'}],limit:'10000'};
 const d=await googleJson(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(property)}:runReport`,token,{method:'POST',body:JSON.stringify(body)});
 await pool.query('INSERT INTO dominance_data_snapshots(account_id,provider_key,resource_key,snapshot_type,period_start,period_end,data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[a.id,'GA4',property,'traffic-acquisition-30d',p.start,p.end,JSON.stringify(d)]);
 return{rows:(d.rows||[]).length,period:p}
}

async function syncGSC(a,connection,token,resource){
 const p=dates(30),site=String(resource);const body={startDate:p.start,endDate:p.end,dimensions:['query','page','country','device'],rowLimit:25000};
 const d=await googleJson(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,token,{method:'POST',body:JSON.stringify(body)});
 await pool.query('INSERT INTO dominance_data_snapshots(account_id,provider_key,resource_key,snapshot_type,period_start,period_end,data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[a.id,'GSC',site,'search-performance-30d',p.start,p.end,JSON.stringify(d)]);
 return{rows:(d.rows||[]).length,period:p}
}

async function syncGADS(a,connection,token,resource){
 if(!GOOGLE_ADS_DEVELOPER_TOKEN)throw Error('GOOGLE_ADS_DEVELOPER_TOKEN missing on worker');
 const customer=String(resource).replace(/^customers\//,'').replace(/-/g,''),p=dates(30);
 const query=`SELECT campaign.id,campaign.name,campaign.status,metrics.impressions,metrics.clicks,metrics.cost_micros,metrics.conversions,metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${p.start}' AND '${p.end}'`;
 const d=await googleJson(`https://googleads.googleapis.com/v25/customers/${customer}/googleAds:search`,token,{method:'POST',headers:{'developer-token':GOOGLE_ADS_DEVELOPER_TOKEN},body:JSON.stringify({query,pageSize:10000})});
 await pool.query('INSERT INTO dominance_data_snapshots(account_id,provider_key,resource_key,snapshot_type,period_start,period_end,data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[a.id,'GADS',customer,'campaign-performance-30d',p.start,p.end,JSON.stringify(d)]);
 return{rows:(d.results||[]).length,period:p}
}

async function runGoogle(a,connection){
 const token=await accessToken(connection),provider=connection.provider_key;let resources=[];
 if(provider==='GA4')resources=await discoverGA4(connection,token);
 else if(provider==='GSC')resources=await discoverGSC(connection,token);
 else if(provider==='GADS')resources=await discoverGADS(connection,token);
 else return{status:'skipped',reason:'unsupported-google-provider'};
 let metadata={...(connection.metadata||{}),resources,last_resource_discovery_at:new Date().toISOString()};
 let selected=metadata.selected_resource;
 if(!selected&&resources.length===1){selected=resources[0].resource||resources[0].id;metadata.selected_resource=selected;metadata.auto_selected=true}
 await pool.query('UPDATE dominance_connections SET metadata=$1::jsonb,updated_at=NOW() WHERE id=$2',[JSON.stringify(metadata),connection.id]);
 if(!selected){await pool.query("UPDATE dominance_connections SET last_error=$1,updated_at=NOW() WHERE id=$2",[`Authorized; select one of ${resources.length} available resources in Data Connections.`,connection.id]);return{status:'awaiting_resource_selection',resources:resources.length}}
 let result;if(provider==='GA4')result=await syncGA4(a,connection,token,selected);else if(provider==='GSC')result=await syncGSC(a,connection,token,selected);else result=await syncGADS(a,connection,token,selected);
 await pool.query('UPDATE dominance_connections SET last_sync_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1',[connection.id]);
 return{status:'synced',selected_resource:selected,...result}
}

async function runAccount(a){
 const c=await pool.query("SELECT id,provider_key,provider_name,status,metadata,credential_ciphertext FROM dominance_connections WHERE account_id=$1 AND status IN ('connected','enabled')",[a.id]);
 const connected=c.rows,results=[];
 if(!connected.length){const summary={company:a.company_name,connected_sources:[],message:'No live sources connected.'};await pool.query("INSERT INTO dominance_scan_runs(account_id,scan_type,status,summary,completed_at) VALUES($1,'intelligence-cycle','waiting_for_sources',$2::jsonb,NOW())",[a.id,JSON.stringify(summary)]);return{state:'waiting',results}}
 for(const conn of connected){
   try{
     if(['GA4','GSC','GADS'].includes(conn.provider_key)&&conn.credential_ciphertext)results.push({provider:conn.provider_key,...await runGoogle(a,conn)});
     else results.push({provider:conn.provider_key,status:'connected_no_sync_handler'});
   }catch(e){const err=String(e.message||e);await pool.query('UPDATE dominance_connections SET last_error=$1,updated_at=NOW() WHERE id=$2',[err,conn.id]).catch(()=>{});results.push({provider:conn.provider_key,status:'error',error:err})}
 }
 const synced=results.filter(x=>x.status==='synced').length,awaiting=results.filter(x=>x.status==='awaiting_resource_selection').length,errors=results.filter(x=>x.status==='error').length;
 const summary={company:a.company_name,connected_sources:connected.map(x=>x.provider_key),synced,awaiting_resource_selection:awaiting,errors,results};
 await pool.query("INSERT INTO dominance_scan_runs(account_id,scan_type,status,summary,completed_at) VALUES($1,'intelligence-cycle',$2,$3::jsonb,NOW())",[a.id,errors?'partial_error':synced?'completed':'ready',JSON.stringify(summary)]);
 return{state:errors?'partial_error':synced?'synced':'ready',results}
}

async function cycle(){
 try{
   await heartbeat('running',{started_at:new Date().toISOString(),google_worker_ready:!!(GOOGLE_CLIENT_ID&&GOOGLE_CLIENT_SECRET&&CREDENTIAL_ENCRYPTION_KEY)});
   const r=await pool.query('SELECT id,company_name,website,industry_key FROM dominance_accounts ORDER BY updated_at DESC');
   const states={synced:0,ready:0,waiting:0,partial_error:0};let sourcesSynced=0,awaitingSelection=0,errors=0;
   for(const a of r.rows){const out=await runAccount(a);states[out.state]=(states[out.state]||0)+1;sourcesSynced+=out.results.filter(x=>x.status==='synced').length;awaitingSelection+=out.results.filter(x=>x.status==='awaiting_resource_selection').length;errors+=out.results.filter(x=>x.status==='error').length}
   await heartbeat(errors?'degraded':'idle',{accounts_checked:r.rows.length,states,sources_synced:sourcesSynced,awaiting_resource_selection:awaitingSelection,source_errors:errors,next_cycle_minutes:INTERVAL_MS/60000,google_worker_ready:!!(GOOGLE_CLIENT_ID&&GOOGLE_CLIENT_SECRET&&CREDENTIAL_ENCRYPTION_KEY)});
   console.log('DOMINANCE worker cycle complete',{accounts:r.rows.length,sourcesSynced,awaitingSelection,errors});
 }catch(e){console.error('DOMINANCE worker cycle failed',e);await heartbeat('error',{error:String(e.message||e)}).catch(()=>{})}
}

(async()=>{await ensure();await cycle();setInterval(cycle,INTERVAL_MS);console.log('DOMINANCE Intelligence Worker online. Interval minutes:',INTERVAL_MS/60000)})().catch(e=>{console.error(e);process.exit(1)});
process.on('SIGTERM',async()=>{await pool.end().catch(()=>{});process.exit(0)});
