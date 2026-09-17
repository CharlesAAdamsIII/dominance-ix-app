'use strict';

const nativeFetch=global.fetch;
const developerToken=String(process.env.GOOGLE_ADS_DEVELOPER_TOKEN||'').trim();
const loginCustomerId=String(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID||'').replace(/\D/g,'');

function isGoogleAdsUrl(input){
  try{
    const u=new URL(typeof input==='string'?input:input?.url||'');
    return u.hostname==='googleads.googleapis.com';
  }catch{return false}
}
function isListAccessible(input){
  try{
    const u=new URL(typeof input==='string'?input:input?.url||'');
    return /\/customers:listAccessibleCustomers$/.test(u.pathname);
  }catch{return false}
}

if(nativeFetch&&!global.__DOMINANCE_GOOGLE_ADS_FETCH_PATCHED){
  global.__DOMINANCE_GOOGLE_ADS_FETCH_PATCHED=true;
  global.fetch=async function dominanceGoogleAdsFetch(input,init={}){
    if(!isGoogleAdsUrl(input))return nativeFetch(input,init);
    const sourceHeaders=init.headers||(typeof Request!=='undefined'&&input instanceof Request?input.headers:undefined);
    const headers=new Headers(sourceHeaders||{});
    if(developerToken&&!headers.has('developer-token'))headers.set('developer-token',developerToken);
    if(loginCustomerId&&!isListAccessible(input)&&!headers.has('login-customer-id'))headers.set('login-customer-id',loginCustomerId);
    return nativeFetch(input,{...init,headers});
  };
}

module.exports={
  developerTokenConfigured:!!developerToken,
  loginCustomerIdConfigured:!!loginCustomerId,
  loginCustomerIdLength:loginCustomerId.length
};
