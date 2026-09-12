(function(){
 const KEY='dominance_account_v1';
 const esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function get(){try{return JSON.parse(localStorage.getItem(KEY)||'null')}catch(_){return null}}
 function set(v){localStorage.setItem(KEY,JSON.stringify(v));return v}
 function clear(){localStorage.removeItem(KEY)}
 function nameFromUrl(url){try{const h=new URL(url).hostname.replace(/^www\./,'');return h.split('.')[0].replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}catch(_){return 'Company'}}
 function requireAccount(){const a=get();if(!a){location.replace('/os.html?create=1');return null}return a}
 function industryLabel(a){return a?.industry_name||a?.analysis?.industry_name||a?.industry_key||'Business'}
 function installBrand(){
   if(document.getElementById('domGlobalBrand'))return;
   const style=document.createElement('style');style.textContent='.dom-global-brand{display:flex!important;align-items:center!important;gap:10px!important;text-decoration:none!important;color:#e9c45a!important;min-width:max-content}.dom-crown-d{position:relative;width:42px;height:50px;display:grid;place-items:center;font-family:Georgia,serif;font-size:42px;font-weight:700;line-height:1;color:#e8bd48;text-shadow:0 0 12px #d9a82f33}.dom-crown-d:before{content:"♛";position:absolute;top:-8px;left:8px;font-size:22px;line-height:1;color:#f0c94e;transform:scaleX(1.12)}.dom-word{font-family:Georgia,serif;font-size:20px;font-weight:700;letter-spacing:.13em;color:#e7c05a}.dom-global-brand:hover .dom-crown-d,.dom-global-brand:hover .dom-word{filter:brightness(1.18)}@media(max-width:650px){.dom-word{font-size:15px}.dom-crown-d{width:34px;font-size:34px}}';document.head.appendChild(style);
   const brand=document.createElement('a');brand.id='domGlobalBrand';brand.className='dom-global-brand';brand.href='/os.html';brand.setAttribute('aria-label','DOMINANCE OS');brand.innerHTML='<span class="dom-crown-d">D</span><span class="dom-word">DOMINANCE</span>';
   const old=document.querySelector('header .brand')||document.querySelector('header > div:first-child');if(old){old.replaceWith(brand)}else{brand.style.cssText+='position:fixed;top:8px;left:16px;z-index:10000';document.body.appendChild(brand)}
 }
 function accountBanner(a){const d=document.createElement('div');d.id='domAccountBanner';d.style.cssText='position:fixed;right:14px;bottom:14px;z-index:9999;background:#0b1820;border:1px solid #29414e;border-radius:10px;padding:9px 11px;color:#dce9ee;font:11px Arial;box-shadow:0 8px 24px #0008';d.innerHTML='<b>'+esc(a.company_name)+'</b><div style="color:#7f94a2;margin-top:3px">'+esc(industryLabel(a))+' · shared DOMINANCE account</div>';document.body.appendChild(d)}
 function adaptCompetitor(){const a=requireAccount();if(!a)return;accountBanner(a);const sub=document.querySelector('.sub');if(sub)sub.textContent='COMPETITOR INTELLIGENCE · '+a.company_name.toUpperCase();const hero=document.querySelector('.hero h1');if(hero)hero.textContent=a.company_name+' Competitor Intelligence'}
 function adaptCampaign(){const a=requireAccount();if(!a)return;accountBanner(a);const sub=document.querySelector('.sub');if(sub)sub.textContent='CAMPAIGN MANAGEMENT · '+a.company_name.toUpperCase();const title=document.querySelector('.hero h1');if(title)title.textContent=a.company_name+' Campaign Portfolio'}
 function adaptRadar(){const a=requireAccount();if(!a)return;accountBanner(a)}
 function ready(){installBrand()}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready);else ready();
 window.DOMINANCE_CTX={get,set,clear,requireAccount,nameFromUrl,industryLabel,adaptCompetitor,adaptCampaign,adaptRadar,installBrand};
})();