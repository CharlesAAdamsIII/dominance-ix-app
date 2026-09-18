'use strict';

require('./google-ads-fetch-auth');
const crypto=require('crypto');

const API_VERSION=String(process.env.GOOGLE_ADS_API_VERSION||'v25').replace(/^v?/,'v');
const GOOGLE_CLIENT_ID=process.env.GOOGLE_CLIENT_ID||'';
const GOOGLE_CLIENT_SECRET=process.env.GOOGLE_CLIENT_SECRET||'';
const CREDENTIAL_ENCRYPTION_KEY=process.env.CREDENTIAL_ENCRYPTION_KEY||'';

function encryptionKey(){
  if(!CREDENTIAL_ENCRYPTION_KEY)throw Error('CREDENTIAL_ENCRYPTION_KEY is not configured on the execution worker.');
  return crypto.createHash('sha256').update(CREDENTIAL_ENCRYPTION_KEY).digest();
}
function decryptObject(text){
  const parts=String(text||'').split('.');
  if(parts.length!==3)throw Error('Encrypted Google credential payload is invalid.');
  const [iv,tag,data]=parts.map(x=>Buffer.from(x,'base64url'));
  const d=crypto.createDecipheriv('aes-256-gcm',encryptionKey(),iv);d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data),d.final()]).toString('utf8'));
}
function encryptObject(obj){
  const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',encryptionKey(),iv);
  const data=Buffer.concat([c.update(JSON.stringify(obj),'utf8'),c.final()]),tag=c.getAuthTag();
  return[iv,tag,data].map(x=>x.toString('base64url')).join('.');
}
async function accessToken(pool,connection){
  let t=decryptObject(connection.credential_ciphertext);
  if(t.access_token&&Number(t.expires_at||0)>Date.now()+60000)return t.access_token;
  if(!t.refresh_token)throw Error('Google Ads refresh token is missing; reconnect Google Ads.');
  if(!GOOGLE_CLIENT_ID||!GOOGLE_CLIENT_SECRET)throw Error('Google OAuth client credentials are unavailable on the execution worker.');
  const body=new URLSearchParams({client_id:GOOGLE_CLIENT_ID,client_secret:GOOGLE_CLIENT_SECRET,refresh_token:t.refresh_token,grant_type:'refresh_token'});
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  const fresh=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(fresh.error_description||fresh.error||'Unable to refresh Google access token.');
  t={...t,...fresh,refresh_token:t.refresh_token,expires_at:Date.now()+Number(fresh.expires_in||3600)*1000};
  await pool.query('UPDATE dominance_connections SET credential_ciphertext=$1,updated_at=NOW() WHERE id=$2',[encryptObject(t),connection.id]);
  return t.access_token;
}
function googleError(d,status){
  const root=d?.error||{};
  const details=root.details||[];
  const failures=[];
  for(const x of details){
    for(const e of x.errors||[])failures.push([e.message,e.errorCode?JSON.stringify(e.errorCode):null,e.location?JSON.stringify(e.location):null].filter(Boolean).join(' | '));
  }
  return failures.join(' || ')||root.message||('Google Ads API '+status);
}
async function googleJson(url,token,{method='POST',body=null}={}){
  const r=await fetch(url,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===null?undefined:JSON.stringify(body)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(googleError(d,r.status));
  return d;
}
async function connectionFor(pool,accountId){
  const r=await pool.query(`SELECT * FROM dominance_connections WHERE account_id=$1 AND provider_key='GADS' AND status IN('connected','enabled') AND credential_ciphertext IS NOT NULL LIMIT 1`,[accountId]);
  const c=r.rows[0];if(!c)throw Error('Google Ads is not connected for this DOMINANCE customer.');
  const selected=c.metadata?.selected_resource;
  if(!selected)throw Error('Google Ads connection has no selected advertiser resource.');
  return{connection:c,customerId:String(selected).replace(/^customers\//,'').replace(/\D/g,'')};
}
const micros=v=>String(Math.max(0,Math.round(Number(v||0)*1000000)));
function tempName(customerId,type,id){return'customers/'+customerId+'/'+type+'/'+id;}

function bidFields(strategy){
  const s=String(strategy||'MAXIMIZE_CONVERSIONS').toUpperCase();
  if(s==='MAXIMIZE_CLICKS')return{targetSpend:{}};
  if(s==='MANUAL_CPC')return{manualCpc:{enhancedCpcEnabled:true}};
  return{maximizeConversions:{}};
}
function rsaCreate(adGroupResource,ad,status){
  const rsa={headlines:(ad.headlines||[]).map(text=>({text})),descriptions:(ad.descriptions||[]).map(text=>({text}))};
  if(ad.path1)rsa.path1=ad.path1;if(ad.path2)rsa.path2=ad.path2;
  return{adGroup:adGroupResource,status:status||'PAUSED',ad:{responsiveSearchAd:rsa,finalUrls:ad.final_urls||[]}};
}

function launchOperations(spec,customerId){
  const c=spec.campaign||{},ops=[],budgetResource=tempName(customerId,'campaignBudgets',-1),campaignResource=tempName(customerId,'campaigns',-2);
  ops.push({campaignBudgetOperation:{create:{resourceName:budgetResource,name:c.name+' · DOMINANCE Budget',deliveryMethod:'STANDARD',amountMicros:micros(c.daily_budget),explicitlyShared:false}}});
  const campaign={resourceName:campaignResource,name:c.name,status:c.status||'PAUSED',advertisingChannelType:c.channel_type||'SEARCH',campaignBudget:budgetResource,networkSettings:c.network_settings||{targetGoogleSearch:true,targetSearchNetwork:true,targetContentNetwork:false,targetPartnerSearchNetwork:false},...bidFields(c.bid_strategy)};
  if(c.contains_eu_political_advertising)campaign.containsEuPoliticalAdvertising=c.contains_eu_political_advertising;
  ops.push({campaignOperation:{create:campaign}});
  let temp=-3;
  for(const g of c.ad_groups||[]){
    const adGroupResource=tempName(customerId,'adGroups',temp--);
    const adGroup={resourceName:adGroupResource,campaign:campaignResource,name:g.name,status:'ENABLED',type:'SEARCH_STANDARD'};
    if(Number(g.cpc_bid)>0)adGroup.cpcBidMicros=micros(g.cpc_bid);
    ops.push({adGroupOperation:{create:adGroup}});
    for(const k of g.keywords||[]){
      if(!k.text)continue;
      const criterion={resourceName:tempName(customerId,'adGroupCriteria',temp--),adGroup:adGroupResource,status:'ENABLED',negative:k.negative===true,keyword:{text:k.text,matchType:k.match_type||'PHRASE'}};
      ops.push({adGroupCriterionOperation:{create:criterion}});
    }
    for(const ad of g.ads||[]){
      ops.push({adGroupAdOperation:{create:{resourceName:tempName(customerId,'adGroupAds',temp--),...rsaCreate(adGroupResource,ad,c.status||'PAUSED')}}});
    }
  }
  for(const geo of c.geo_targets||[]){
    const criterionId=String(geo.criterion_id||geo.id||'').replace(/\D/g,'');
    if(!criterionId)throw Error('Google Ads geo target is missing a numeric geo target criterion ID.');
    ops.push({campaignCriterionOperation:{create:{resourceName:tempName(customerId,'campaignCriteria',temp--),campaign:campaignResource,negative:geo.negative===true,location:{geoTargetConstant:'geoTargetConstants/'+criterionId}}}});
  }
  return ops;
}

async function validateAndMutate(token,customerId,operations){
  const base='https://googleads.googleapis.com/'+API_VERSION+'/customers/'+customerId+'/googleAds:mutate';
  const body={mutateOperations:operations,partialFailure:false,responseContentType:'MUTABLE_RESOURCE'};
  const validation=await googleJson(base+'?validateOnly=true',token,{body});
  const response=await googleJson(base,token,{body});
  return{validation,response};
}

async function campaignBudgetState(token,customerId,campaignIds){
  const ids=campaignIds.map(x=>String(x).replace(/\D/g,'')).filter(Boolean);
  if(ids.length!==campaignIds.length)throw Error('Campaign external IDs are required for budget reallocation.');
  const query='SELECT campaign.id,campaign.name,campaign.campaign_budget,campaign_budget.amount_micros FROM campaign WHERE campaign.id IN ('+ids.join(',')+')';
  const d=await googleJson('https://googleads.googleapis.com/'+API_VERSION+'/customers/'+customerId+'/googleAds:search',token,{body:{query,pageSize:100}});
  const out={};
  for(const row of d.results||[])out[String(row.campaign?.id)]={name:row.campaign?.name,budget_resource:row.campaign?.campaignBudget,amount_micros:Number(row.campaignBudget?.amountMicros||0)};
  return out;
}
async function entityExternalId(pool,accountId,entityId){
  const r=await pool.query('SELECT external_id,name FROM dominance_campaign_entities WHERE dominance_account_id=$1 AND id=$2 AND platform=$3',[accountId,entityId,'Google Ads']);
  if(!r.rows[0]?.external_id)throw Error('Google Ads campaign entity '+entityId+' is missing an external campaign ID.');
  return r.rows[0];
}
async function executeReallocation(pool,token,customerId,accountId,spec){
  const from=await entityExternalId(pool,accountId,spec.from_entity_id),to=await entityExternalId(pool,accountId,spec.to_entity_id);
  const state=await campaignBudgetState(token,customerId,[from.external_id,to.external_id]);
  const a=state[String(from.external_id)],b=state[String(to.external_id)];
  if(!a?.budget_resource||!b?.budget_resource)throw Error('Unable to resolve one or both Google campaign budget resources.');
  const dailyDelta=spec.amount_basis==='daily'?Number(spec.amount):Number(spec.amount)/30.44,deltaMicros=Math.round(dailyDelta*1000000);
  const fromNew=a.amount_micros-deltaMicros,toNew=b.amount_micros+deltaMicros;
  if(fromNew<=0)throw Error('Budget reallocation would reduce the source campaign daily budget to zero or below.');
  const url='https://googleads.googleapis.com/'+API_VERSION+'/customers/'+customerId+'/campaignBudgets:mutate';
  const body={operations:[
    {update:{resourceName:a.budget_resource,amountMicros:String(fromNew)},updateMask:'amount_micros'},
    {update:{resourceName:b.budget_resource,amountMicros:String(toNew)},updateMask:'amount_micros'}
  ],partialFailure:false};
  await googleJson(url+'?validateOnly=true',token,{body});
  const response=await googleJson(url,token,{body});
  return{response,normalized_daily_delta:dailyDelta,from:{campaign:from.name,before_micros:a.amount_micros,after_micros:fromNew},to:{campaign:to.name,before_micros:b.amount_micros,after_micros:toNew}};
}
async function executeBudgetUpdate(pool,token,customerId,accountId,spec){
  const c=await entityExternalId(pool,accountId,spec.campaign_entity_id),state=await campaignBudgetState(token,customerId,[c.external_id]),s=state[String(c.external_id)];
  if(!s?.budget_resource)throw Error('Unable to resolve Google campaign budget resource.');
  const body={operations:[{update:{resourceName:s.budget_resource,amountMicros:micros(spec.daily_budget)},updateMask:'amount_micros'}],partialFailure:false};
  const url='https://googleads.googleapis.com/'+API_VERSION+'/customers/'+customerId+'/campaignBudgets:mutate';
  await googleJson(url+'?validateOnly=true',token,{body});
  return{response:await googleJson(url,token,{body}),campaign:c.name,before_micros:s.amount_micros,after_micros:Number(micros(spec.daily_budget))};
}

async function execute(pool,{account,spec}){
  const {connection,customerId}=await connectionFor(pool,account.id),token=await accessToken(pool,connection);
  if(spec.platform!=='Google Ads')throw Error('Google Ads adapter received a non-Google build.');
  if(spec.operation==='launch_campaign'){
    const operations=launchOperations(spec,customerId),result=await validateAndMutate(token,customerId,operations);
    return{ok:true,platform:'Google Ads',customer_id:customerId,operation:spec.operation,operations:operations.length,...result};
  }
  if(spec.operation==='reallocate_budget')return{ok:true,platform:'Google Ads',customer_id:customerId,operation:spec.operation,...await executeReallocation(pool,token,customerId,account.id,spec)};
  if(spec.operation==='update_campaign_budget')return{ok:true,platform:'Google Ads',customer_id:customerId,operation:spec.operation,...await executeBudgetUpdate(pool,token,customerId,account.id,spec)};
  throw Error('Google Ads execution operation is not implemented: '+spec.operation);
}

module.exports={execute,launchOperations};
