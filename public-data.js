const CENSUS_API_KEY=process.env.CENSUS_API_KEY||'';
const CMS_DATA_API_URL=process.env.CMS_DATA_API_URL||'';
const PUBLIC_DATA_REFRESH_HOURS=Math.max(1,Number(process.env.PUBLIC_DATA_REFRESH_HOURS||24));

function now(){return new Date()}
function domainFromWebsite(v){try{return new URL(/^https?:\/\//i.test(String(v||''))?v:'https://'+v).hostname.replace(/^www\./,'')}catch{return String(v||'').replace(/^https?:\/\//,'').split('/')[0].replace(/^www\./,'')}}
async function json(url,options={}){const r=await fetch(url,options);const d=await r.json().catch(()=>null);if(!r.ok)throw Error((d&&JSON.stringify(d).slice(0,500))||`HTTP ${r.status}`);return d}
async function saveSnapshot(pool,a,provider,resource,type,data){await pool.query(`INSERT INTO dominance_data_snapshots(account_id,provider_key,resource_key,snapshot_type,data,collected_at) VALUES($1,$2,$3,$4,$5::jsonb,NOW())`,[a.id,provider,resource||null,type,JSON.stringify(data||{})])}
async function lastSnapshot(pool,a,provider){const r=await pool.query(`SELECT collected_at FROM dominance_data_snapshots WHERE account_id=$1 AND provider_key=$2 ORDER BY collected_at DESC LIMIT 1`,[a.id,provider]);return r.rows[0]?.collected_at||null}
function freshEnough(ts){if(!ts)return false;return Date.now()-new Date(ts).getTime()<PUBLIC_DATA_REFRESH_HOURS*3600000}
async function updateConnection(pool,a,provider,status,error=null,meta={}){await pool.query(`UPDATE dominance_connections SET status=$3,last_sync_at=CASE WHEN $3='synced' THEN NOW() ELSE last_sync_at END,last_error=$4,metadata=COALESCE(metadata,'{}'::jsonb)||$5::jsonb,updated_at=NOW() WHERE account_id=$1 AND provider_key=$2`,[a.id,provider,status,error,JSON.stringify(meta)])}

async function syncCensus(pool,a){
 const provider='CENSUS',last=await lastSnapshot(pool,a,provider);if(freshEnough(last))return{provider,status:'cached',last_sync:last};
 if(!CENSUS_API_KEY){await updateConnection(pool,a,provider,'needs_configuration','CENSUS_API_KEY is required by the current Census API');return{provider,status:'needs_configuration',error:'CENSUS_API_KEY missing'}}
 const vars=['NAME','DP05_0001E','DP05_0018E','DP05_0019E','DP03_0062E','DP03_0128PE','DP02_0068PE','DP04_0001E'];
 const url=`https://api.census.gov/data/2024/acs/acs5/profile?get=${vars.join(',')}&for=state:*&key=${encodeURIComponent(CENSUS_API_KEY)}`;
 const d=await json(url),headers=d[0]||[],rows=(d.slice(1)||[]).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]])));
 const data={vintage:2024,dataset:'ACS 5-year Data Profiles',geography:'state',definitions:{DP05_0001E:'Total population',DP05_0018E:'Male population',DP05_0019E:'Female population',DP03_0062E:'Median household income',DP03_0128PE:'Population below poverty level percent',DP02_0068PE:'Bachelor degree or higher percent',DP04_0001E:'Housing units'},rows};
 await saveSnapshot(pool,a,provider,'US_STATES','acs5-demographic-economic-profile',data);await updateConnection(pool,a,provider,'synced',null,{handler:'acs5-profile',vintage:2024,rows:rows.length});return{provider,status:'synced',rows:rows.length}
}

async function syncCDC(pool,a){
 const provider='CDC',last=await lastSnapshot(pool,a,provider);if(freshEnough(last))return{provider,status:'cached',last_sync:last};
 const q=new URLSearchParams({
  '$select':'statedesc,measure,avg(data_value) as avg_prevalence,min(low_confidence_limit) as low_ci,max(high_confidence_limit) as high_ci',
  '$where':"data_value_type='Crude prevalence' AND data_value IS NOT NULL",
  '$group':'statedesc,measure',
  '$order':'statedesc,measure',
  '$limit':'5000'
 });
 const url='https://data.cdc.gov/resource/fu4u-a9bh.json?'+q.toString();const rows=await json(url);
 const data={dataset:'CDC PLACES County Data 2024 release',dataset_id:'fu4u-a9bh',aggregation:'state average of county crude prevalence',important_note:'PLACES values are model-based estimates; aggregated state averages here are context signals, not official state prevalence estimates.',rows};
 await saveSnapshot(pool,a,provider,'PLACES_2024','places-health-context',data);await updateConnection(pool,a,provider,'synced',null,{handler:'cdc-places',dataset_id:'fu4u-a9bh',rows:rows.length});return{provider,status:'synced',rows:rows.length}
}

async function syncCMS(pool,a){
 const provider='CMS',last=await lastSnapshot(pool,a,provider);if(freshEnough(last))return{provider,status:'cached',last_sync:last};
 if(!CMS_DATA_API_URL){await updateConnection(pool,a,provider,'needs_configuration','CMS_DATA_API_URL is not configured',{handler:'cms-open-data'});return{provider,status:'needs_configuration',error:'CMS_DATA_API_URL missing'}}
 const join=CMS_DATA_API_URL.includes('?')?'&':'?';const url=CMS_DATA_API_URL+join+'size=5000';const d=await json(url);const rows=Array.isArray(d)?d:(d.data||d.results||[]);
 const data={source_url:CMS_DATA_API_URL,dataset_note:'CMS public open-data feed configured for this DOMINANCE account.',rows:rows.slice(0,5000),response_meta:!Array.isArray(d)?{total:d.total||d.count||null}:null};
 await saveSnapshot(pool,a,provider,'CMS_CONFIGURED_DATASET','cms-utilization-payer-provider-context',data);await updateConnection(pool,a,provider,'synced',null,{handler:'cms-open-data',rows:rows.length});return{provider,status:'synced',rows:rows.length}
}

async function syncRDAP(pool,a){
 const provider='RDAP',last=await lastSnapshot(pool,a,provider);if(freshEnough(last))return{provider,status:'cached',last_sync:last};
 const domain=domainFromWebsite(a.website);if(!domain)return{provider,status:'no_domain'};
 const d=await json(`https://rdap.org/domain/${encodeURIComponent(domain)}`);const compact={ldhName:d.ldhName||domain,status:d.status||[],events:(d.events||[]).map(x=>({eventAction:x.eventAction,eventDate:x.eventDate})),nameservers:(d.nameservers||[]).map(x=>x.ldhName).filter(Boolean),secureDNS:d.secureDNS||null,entities:(d.entities||[]).slice(0,10).map(e=>({roles:e.roles||[],handle:e.handle||null}))};
 await saveSnapshot(pool,a,provider,domain,'domain-rdap-context',compact);await updateConnection(pool,a,provider,'synced',null,{handler:'rdap',domain});return{provider,status:'synced',rows:1}
}

async function syncPublicData(pool,a){
 const handlers=[syncCensus,syncCDC,syncCMS,syncRDAP],results=[];
 for(const h of handlers){try{const r=await h(pool,a);results.push(r);console.log(`[PUBLIC DATA] ${r.provider} ${String(r.status).toUpperCase()}${r.rows!=null?` rows=${r.rows}`:''}${r.error?` | ${r.error}`:''}`)}catch(e){const provider=h.name.replace(/^sync/,'').toUpperCase();const msg=String(e.message||e).slice(0,1000);await updateConnection(pool,a,provider,'error',msg,{handler:h.name}).catch(()=>{});results.push({provider,status:'error',error:msg});console.error(`[PUBLIC DATA] ${provider} ERROR | ${msg}`)}}
 return results;
}
module.exports={syncPublicData};
