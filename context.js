(function(){
  const KEY='dominance_account_v1';
  const esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function get(){try{return JSON.parse(localStorage.getItem(KEY)||'null')}catch(_){return null}}
  function set(v){localStorage.setItem(KEY,JSON.stringify(v));return v}
  function clear(){localStorage.removeItem(KEY)}
  function nameFromUrl(url){try{const h=new URL(url).hostname.replace(/^www\./,'');return h.split('.')[0].replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}catch(_){return 'Company'}}
  function requireAccount(){const a=get();if(!a){location.replace('/os.html?create=1');return null}return a}
  function industryLabel(a){return a?.industry_name||a?.analysis?.industry_name||a?.industry_key||'Business'}
  function accountBanner(a){
    const d=document.createElement('div');d.id='domAccountBanner';d.style.cssText='position:fixed;right:14px;bottom:14px;z-index:9999;background:#0b1820;border:1px solid #29414e;border-radius:10px;padding:9px 11px;color:#dce9ee;font:11px Arial;box-shadow:0 8px 24px #0008';
    d.innerHTML='<b>'+esc(a.company_name)+'</b><div style="color:#7f94a2;margin-top:3px">'+esc(industryLabel(a))+' · shared DOMINANCE account</div>';
    document.body.appendChild(d);
  }
  function adaptCompetitor(){
    const a=requireAccount();if(!a)return;accountBanner(a);
    const sub=document.querySelector('.sub');if(sub)sub.textContent='COMPETITOR INTELLIGENCE · '+a.company_name.toUpperCase();
    const hero=document.querySelector('.hero h1');if(hero)hero.textContent=a.company_name+' Competitor Intelligence';
    const industry=a.industry_key;
    if(industry==='marketing_technology'||industry==='professional_services'||industry==='saas'){
      const service=document.getElementById('service');if(service)service.innerHTML='<option>All Services</option><option>AI & Automation</option><option>Digital Marketing</option><option>Custom Software</option><option>SEO / AEO / GEO</option><option>Healthcare Technology</option>';
      const tbody=document.getElementById('rows');if(tbody)tbody.innerHTML=[['Accenture Song',84,88,54,'+9%','high'],['Deloitte Digital',78,91,48,'+4%','high'],['WebFX',76,82,66,'+12%','high'],['SmartSites',69,74,61,'+8%','med'],['Local Growth Agencies',58,55,47,'+14%','med'],['AI Automation Boutiques',52,49,39,'+21%','med']].map(x=>`<tr><td><b>${x[0]}</b></td><td><span class="score">${x[1]}</span><div class="bar"><i style="width:${x[1]}%"></i></div></td><td>${x[2]}/100</td><td>${x[3]}%</td><td>${x[4]}</td><td><span class="risk ${x[5]}">${x[5].toUpperCase()}</span></td></tr>`).join('');
      const kw=document.getElementById('keywords');if(kw){const seeds=(a.analysis?.seeds||[]).slice(0,6);kw.innerHTML=seeds.map((x,i)=>`<div class="kw"><span>${esc(x.phrase)}</span><b>${i%3===0?'#6':'—'}</b><b>${i%2===0?'#2':'#4'}</b><span>${'$'+(12+i*3.6).toFixed(2)}</span></div>`).join('')}
      const selected=document.querySelector('aside .card h2');if(selected)selected.textContent='Top Competitive Cluster';
    }
  }
  function adaptCampaign(){
    const a=requireAccount();if(!a)return;accountBanner(a);
    const sub=document.querySelector('.sub');if(sub)sub.textContent='CAMPAIGN MANAGEMENT · '+a.company_name.toUpperCase();
    const title=document.querySelector('.hero h1');if(title)title.textContent=a.company_name+' Campaign Portfolio';
    if(a.industry_key==='marketing_technology'||a.industry_key==='professional_services'||a.industry_key==='saas'){
      const body=document.getElementById('campaignRows');if(body)body.innerHTML=[['AI Automation Demand Capture','Google Ads','Southeast','$18,000','$214','84','live'],['Healthcare Technology ABM','LinkedIn','United States','$12,500','$438','31','learning'],['SEO / AEO / GEO Search','Google Ads','National','$15,000','$267','56','live'],['Custom Software Retargeting','Meta','National','$7,500','$329','23','live'],['New Business Formation Outreach','Microsoft','Priority Markets','$8,200','$241','34','learning']].map(x=>`<tr><td><b>${x[0]}</b></td><td class="platform">${x[1]}</td><td>${x[2]}</td><td>${x[3]}</td><td>${x[4]}</td><td>${x[5]}</td><td><span class="status ${x[6]}">${x[6].toUpperCase()}</span></td></tr>`).join('');
      const labels=document.querySelectorAll('.field label');labels.forEach(l=>{if(l.textContent==='SERVICE LINE')l.textContent='BUSINESS OFFER';if(l.textContent==='OBJECTIVE')l.textContent='QUALIFIED BUSINESS OUTCOME'});
    }
  }
  function adaptRadar(){
    const a=requireAccount();if(!a)return;accountBanner(a);
    const input=document.getElementById('website');if(input){const block=input.closest('.row')||input.parentElement;if(block)block.style.display='none'}
    const firstLabel=document.querySelector('.left .label');if(firstLabel&&firstLabel.textContent.includes('COMPANY'))firstLabel.textContent='ACTIVE COMPANY';
    const status=document.getElementById('siteStatus');if(status)status.innerHTML='<b>'+esc(a.company_name)+'</b> · '+esc(industryLabel(a))+'<br>'+esc(a.website);
    const industry=document.getElementById('industryName');if(industry)industry.textContent=industryLabel(a);
    if(window.renderIntent&&a.analysis)window.renderIntent(a.analysis);
    if(a.industry_key&&typeof window.profileKey!=='undefined')window.profileKey=a.industry_key;
  }
  window.DOMINANCE_CTX={get,set,clear,requireAccount,nameFromUrl,industryLabel,adaptCompetitor,adaptCampaign,adaptRadar};
})();