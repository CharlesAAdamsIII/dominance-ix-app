(function(){
  const KEY='dominance_creative_graph_v1';
  const seed=[
    {platform:'Google',angle:'Outcome-led',visual:'Data / map proof',cta:'Get a Growth Analysis',spend:12840,impressions:188400,clicks:7540,conversions:91,qualified:48,revenue:112000},
    {platform:'Google',angle:'Competitive gap',visual:'Competitor comparison',cta:'Find Market Gaps',spend:10420,impressions:161300,clicks:6130,conversions:74,qualified:41,revenue:97000},
    {platform:'Meta',angle:'Pattern break',visual:'Bold stat + map',cta:'See What Changed',spend:8340,impressions:492000,clicks:9820,conversions:67,qualified:29,revenue:68000},
    {platform:'Meta',angle:'Proof visual',visual:'Dashboard screenshot',cta:'Open the Radar',spend:7150,impressions:401000,clicks:7620,conversions:54,qualified:31,revenue:79000},
    {platform:'LinkedIn',angle:'Executive',visual:'Executive document',cta:'View the Intelligence',spend:9320,impressions:102000,clicks:2140,conversions:38,qualified:27,revenue:121000},
    {platform:'LinkedIn',angle:'Commercial',visual:'Market opportunity chart',cta:'Find Opportunity',spend:8810,impressions:96800,clicks:2010,conversions:35,qualified:24,revenue:106000},
    {platform:'TikTok',angle:'Hook',visual:'UGC + moving map',cta:'See the Signal',spend:5210,impressions:612000,clicks:12600,conversions:43,qualified:14,revenue:31000},
    {platform:'YouTube',angle:'Explainer',visual:'Motion data story',cta:'See DOMINANCE',spend:6880,impressions:278000,clicks:4230,conversions:46,qualified:22,revenue:59000},
    {platform:'Microsoft',angle:'Efficiency',visual:'Professional proof',cta:'Analyze Opportunity',spend:4720,impressions:74400,clicks:2940,conversions:39,qualified:23,revenue:61000}
  ];
  function rows(){try{const v=JSON.parse(localStorage.getItem(KEY)||'null');if(Array.isArray(v)&&v.length)return v}catch{}return seed}
  function save(v){localStorage.setItem(KEY,JSON.stringify(v))}
  function pct(a,b){return b?100*a/b:0}
  function money(n){return '$'+Math.round(n).toLocaleString()}
  function score(r){const q=pct(r.qualified,r.conversions),roas=r.spend?r.revenue/r.spend:0,cvr=pct(r.conversions,r.clicks);return Math.min(100,Math.round(roas*7+q*.55+cvr*1.5))}
  function aggregate(data,key){const m={};data.forEach(r=>{const k=r[key]||'Unknown';if(!m[k])m[k]={name:k,spend:0,impressions:0,clicks:0,conversions:0,qualified:0,revenue:0};Object.keys(m[k]).filter(x=>x!=='name').forEach(x=>m[k][x]+=Number(r[x]||0))});return Object.values(m).map(x=>({...x,score:score(x)})).sort((a,b)=>b.score-a.score)}
  function render(target,platform){const el=document.getElementById(target);if(!el)return;const data=rows(),filtered=platform?data.filter(x=>x.platform===platform):data,angles=aggregate(filtered,'angle'),visuals=aggregate(filtered,'visual'),ctas=aggregate(filtered,'cta'),all=aggregate(filtered,'platform');const best=(arr)=>arr[0]||{name:'Learning',score:0,qualified:0,revenue:0,spend:0};const bA=best(angles),bV=best(visuals),bC=best(ctas),bP=best(all);el.innerHTML=`<div class="graphKpis"><div class="graphKpi"><span>BEST MESSAGE ANGLE</span><b>${bA.name}</b><small>${bA.score}/100 outcome score</small></div><div class="graphKpi"><span>BEST VISUAL TYPE</span><b>${bV.name}</b><small>${bV.qualified} qualified outcomes</small></div><div class="graphKpi"><span>BEST CTA</span><b>${bC.name}</b><small>${money(bC.revenue)} attributed revenue</small></div><div class="graphKpi"><span>BEST PLATFORM</span><b>${bP.name}</b><small>${bP.spend?((bP.revenue/bP.spend).toFixed(1)+'x ROAS'):'learning'}</small></div></div><div class="graphTable"><div class="graphHead"><span>CREATIVE VARIABLE</span><span>SPEND</span><span>QUALIFIED</span><span>REVENUE</span><span>SCORE</span></div>${angles.slice(0,5).map(x=>`<div class="graphRow"><span><b>${x.name}</b><small>message angle</small></span><span>${money(x.spend)}</span><span>${x.qualified}</span><span>${money(x.revenue)}</span><span class="graphScore">${x.score}</span></div>`).join('')}</div><div class="graphExplain"><b>Learning rule:</b> DOMINANCE weights qualified outcomes and attributed revenue above clicks. As connected platform and CRM data replaces modeled observations, this graph becomes the evidence layer used to promote, retire and generate creative variants.</div>`}
  function approve(v){const data=rows();data.push({platform:v.platform,angle:v.angle||'New variant',visual:v.visual||'Generated concept',cta:v.cta||'Learn More',spend:0,impressions:0,clicks:0,conversions:0,qualified:0,revenue:0,status:'approved'});save(data)}
  window.DOMINANCE_CREATIVE_GRAPH={rows,aggregate,score,render,approve};
})();
