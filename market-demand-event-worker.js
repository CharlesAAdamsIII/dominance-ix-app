const crypto=require('crypto');
const mi=require('./market-intelligence-core');
const cp=require('./control-plane-core');
const pool=mi.makePool();
const INTERVAL_MS=Math.max(10,Number(process.env.DEMAND_EVENT_INTERVAL_MINUTES||15))*60*1000;
let timer=null,busy=false;
const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number(v||0)));
const norm=s=>String(s||'').trim().toLowerCase().replace(/\s+/g,' ');
const hash=s=>crypto.createHash('sha1').update(String(s||'')).digest('hex').slice(0,18);
const CATS=['informational','problem_need','commercial','transactional','local','navigational','comparison','price','qualification','urgency'];
const RULES={
 informational:[/\bwhat\b/,/\bhow\b/,/\bwhy\b/,/\bwhen\b/,/\bwhere\b/,/\bguide\b/,/\bmeaning\b/,/\bdefinition\b/,/\bsymptoms?\b/,/\bcauses?\b/,/\bdoes\b/,/\bcan\b/],
 problem_need:[/\bhelp\b/,/\btreatment\b/,/\btherapy\b/,/\bcare\b/,/\brelief\b/,/\bproblem\b/,/\bpain\b/,/\brecovery\b/,/\bfix\b/,/\bsupport\b/],
 commercial:[/\bbest\b/,/\btop\b/,/\breviews?\b/,/\bprovider\b/,/\bclinic\b/,/\bcenter\b/,/\bdoctor\b/,/\bcompany\b/,/\bagency\b/,/\bsoftware\b/,/\bplatform\b/,/\bsolution\b/,/\bservice\b/],
 transactional:[/\bbuy\b/,/\bbook\b/,/\bschedule\b/,/\bappointment\b/,/\bquote\b/,/\bdemo\b/,/\btrial\b/,/\border\b/,/\benroll\b/,/\bapply\b/,/\badmissions?\b/,/\breserve\b/,/\bhire\b/,/\bget started\b/,/\bcontact\b/],
 local:[/\bnear me\b/,/\bnearby\b/,/\bclosest\b/,/\blocal\b/,/\bin my area\b/,/\bopen near\b/],
 navigational:[/\blogin\b/,/\bsign in\b/,/\bofficial\b/,/\bwebsite\b/,/\bphone\b/,/\baddress\b/,/\bdirections\b/],
 comparison:[/\bvs\.?\b/,/\bversus\b/,/\bcompare\b/,/\bcomparison\b/,/\balternatives?\b/,/\breviews?\b/],
 price:[/\bcost\b/,/\bprice\b/,/\bpricing\b/,/\brates?\b/,/\binsurance\b/,/\bcovered\b/,/\bcoverage\b/,/\baffordable\b/,/\bquote\b/],
 qualification:[/\bqualif(y|ies|ication)\b/,/\beligib(le|ility)\b/,/\baccepted\b/,/\brequirements?\b/,/\bcovered\b/,/\binsurance accepted\b/],
 urgency:[/\bnow\b/,/\btoday\b/,/\bsame day\b/,/\bemergency\b/,/\burgent\b/,/\bimmediate(ly)?\b/,/\bopen now\b/,/\b24\/?7\b/]
};
function classifyIntent(phrase,brand=''){
 const p=norm(phrase),scores=Object.fromEntries(CATS.map(k=>[k,0]));
 for(const [cat,rules] of Object.entries(RULES))for(const rx of rules)if(rx.test(p))scores[cat]+=cat==='transactional'||cat==='urgency'?28:22;
 const b=norm(brand);if(b&&b.length>2&&p.includes(b))scores.navigational+=65;
 if(!Object.values(scores).some(v=>v>0))scores.informational=28;
 if(scores.transactional>0)scores.commercial+=18;
 if(scores.local>0)scores.commercial+=12;
 if(scores.price>0||scores.comparison>0)scores.commercial+=14;
 for(const k of CATS)scores[k]=clamp(scores[k]);
 const dominant=CATS.slice().sort((a,b)=>scores[b]-scores[a])[0];
 const commerciality=clamp(scores.transactional*.30+scores.commercial*.22+scores.local*.12+scores.price*.11+scores.qualification*.10+scores.urgency*.15);
 const stage=scores.transactional>=50||scores.urgency>=50?'action':Math.max(scores.commercial,scores.comparison,scores.price,scores.qualification,scores.local)>=45?'evaluation':scores.problem_need>=45?'consideration':'awareness';
 return{...scores,dominant,journey_stage:stage,commerciality_score:Math.round(commerciality)};
}
async function ensureSchema(){
 await mi.ensureSchema(pool);
 await pool.query(`ALTER TABLE dominance_keyword_intelligence ADD COLUMN IF NOT EXISTS intent_profile JSONB NOT NULL DEFAULT '{}'::jsonb`);
 await pool.query(`ALTER TABLE dominance_keyword_intelligence ADD COLUMN IF NOT EXISTS dominant_intent TEXT`);
 await pool.query(`ALTER TABLE dominance_keyword_intelligence ADD COLUMN IF NOT EXISTS journey_stage TEXT`);
 await pool.query(`ALTER TABLE dominance_keyword_intelligence ADD COLUMN IF NOT EXISTS commerciality_score NUMERIC NOT NULL DEFAULT 0`);
 await pool.query(`CREATE TABLE IF NOT EXISTS dominance_market_demand_events(
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES dominance_accounts(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  geography_key TEXT NOT NULL,
  geography_name TEXT NOT NULL,
  geography_type TEXT NOT NULL DEFAULT 'market',
  keyword TEXT,
  service_cluster TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  intent_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  score NUMERIC NOT NULL DEFAULT 0,
  confidence NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  source_resolution JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id,event_key)
 )`);
 await pool.query(`CREATE INDEX IF NOT EXISTS idx_dom_demand_events_account ON dominance_market_demand_events(account_id,status,score DESC,last_detected_at DESC)`);
}
async function classifyKeywords(account){
 const r=await pool.query(`SELECT id,phrase FROM dominance_keyword_intelligence WHERE account_id=$1 AND active=TRUE`,[account.id]);
 const byPhrase=new Map();for(const k of r.rows){const profile=classifyIntent(k.phrase,account.company_name);byPhrase.set(norm(k.phrase),profile);await pool.query(`UPDATE dominance_keyword_intelligence SET intent_profile=$1::jsonb,dominant_intent=$2,journey_stage=$3,commerciality_score=$4,updated_at=NOW() WHERE id=$5`,[JSON.stringify(profile),profile.dominant,profile.journey_stage,profile.commerciality_score,k.id])}
 return byPhrase;
}
function intentMix(values={},profiles=new Map()){
 const totals=Object.fromEntries(CATS.map(k=>[k,0]));let weight=0,commerciality=0,topKeyword=null,topValue=-1;
 for(const [phrase,raw] of Object.entries(values||{})){const v=Math.max(0,Number(raw||0));if(v<=0)continue;const p=profiles.get(norm(phrase))||classifyIntent(phrase);weight+=v;commerciality+=v*Number(p.commerciality_score||0);for(const k of CATS)totals[k]+=v*Number(p[k]||0);if(v>topValue){topValue=v;topKeyword=phrase}}
 if(weight<=0)return{dominant:'unknown',journey_stage:'unknown',commerciality_score:0,top_keyword:topKeyword,categories:Object.fromEntries(CATS.map(k=>[k,0]))};
 const cats=Object.fromEntries(CATS.map(k=>[k,Math.round(totals[k]/weight)])),dominant=CATS.slice().sort((a,b)=>cats[b]-cats[a])[0],c=Math.round(commerciality/weight),stage=c>=55?'action_or_evaluation':c>=32?'consideration':'awareness';return{dominant,journey_stage:stage,commerciality_score:c,top_keyword:topKeyword,categories:cats};
}
function eventKey(type,geo,keyword=''){return`${type}:${norm(geo)}:${hash(norm(keyword||''))}`}
async function upsertEvent(account,input){
 const key=eventKey(input.event_type,input.geography_key||input.geography_name,input.keyword||input.service_cluster||'');
 const r=await pool.query(`INSERT INTO dominance_market_demand_events(account_id,event_key,event_type,geography_key,geography_name,geography_type,keyword,service_cluster,title,summary,intent_profile,signals,score,confidence,status,source_resolution,evidence)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,'active',$15::jsonb,$16::jsonb)
 ON CONFLICT(account_id,event_key) DO UPDATE SET geography_name=EXCLUDED.geography_name,geography_type=EXCLUDED.geography_type,title=EXCLUDED.title,summary=EXCLUDED.summary,intent_profile=EXCLUDED.intent_profile,signals=EXCLUDED.signals,score=EXCLUDED.score,confidence=EXCLUDED.confidence,status='active',source_resolution=EXCLUDED.source_resolution,evidence=EXCLUDED.evidence,last_detected_at=NOW() RETURNING id`,[account.id,key,input.event_type,input.geography_key||norm(input.geography_name),input.geography_name,input.geography_type||'market',input.keyword||null,input.service_cluster||null,input.title,input.summary,JSON.stringify(input.intent_profile||{}),JSON.stringify(input.signals||[]),clamp(input.score),clamp(input.confidence),JSON.stringify(input.source_resolution||{}),JSON.stringify(input.evidence||{})]);return r.rows[0]?.id||null;
}
function sourceResolution(row){const m=row?.metrics||{};return{source:row?.source_key||null,geography_type:row?.geography_type||null,radius_miles:Number(m.radius_miles??m.resolution_miles??0)||null,time_range:m.time_range||null,actual_query_counts:Boolean(m.query_count!=null||m.actual_search_count!=null)};}
async function detectForAccount(account,profiles){
 let created=0;const recent=await pool.query(`SELECT * FROM dominance_market_snapshots WHERE account_id=$1 AND captured_at>NOW()-INTERVAL '8 days' ORDER BY captured_at DESC`,[account.id]);
 const byGeoSource=new Map();for(const row of recent.rows){const key=`${row.geography_key}|${row.source_key}`,arr=byGeoSource.get(key)||[];arr.push(row);byGeoSource.set(key,arr)}
 const latest4=[...byGeoSource.entries()].filter(([k])=>k.endsWith('|DATAFORSEO_TRENDS_4H')).map(([,arr])=>arr[0]);
 for(const cur of latest4){const arr=byGeoSource.get(`${cur.geography_key}|DATAFORSEO_TRENDS_4H`)||[],prev=arr[1]||null,curValues=cur.metrics?.keyword_values||{},prevValues=prev?.metrics?.keyword_values||{},mix=intentMix(curValues,profiles),prevMix=intentMix(prevValues,profiles),geo=cur.geography_name;
  if(Number(cur.opportunity_score)>=60&&Number(cur.velocity_pct)>=20){await upsertEvent(account,{event_type:'demand_acceleration',geography_key:cur.geography_key,geography_name:geo,geography_type:cur.geography_type,service_cluster:mix.top_keyword,title:`Demand accelerating in ${geo}`,summary:`Market Radar detected rising relative demand with ${Math.round(Number(cur.velocity_pct||0))}% velocity and ${Math.round(Number(cur.opportunity_score||0))}/100 opportunity.`,intent_profile:mix,signals:['regional_search','velocity','keyword_density'],score:Math.min(96,65+Number(cur.velocity_pct||0)*.3),confidence:cur.confidence,source_resolution:sourceResolution(cur),evidence:{current:cur.observed_volume,prior:cur.prior_volume,velocity_pct:cur.velocity_pct,acceleration_pct:cur.acceleration_pct,keyword_values:curValues}});created++}
  if(prev){for(const [phrase,raw] of Object.entries(curValues)){const now=Number(raw||0),before=Number(prevValues[phrase]||0),delta=now-before,ratio=before>0?now/before:null;if(now>=15&&(delta>=15||(ratio&&ratio>=1.5))){const p=profiles.get(norm(phrase))||classifyIntent(phrase,account.company_name);await upsertEvent(account,{event_type:'keyword_migration',geography_key:cur.geography_key,geography_name:geo,geography_type:cur.geography_type,keyword:phrase,service_cluster:phrase,title:`“${phrase}” is gaining regional share in ${geo}`,summary:`Relative popularity moved ${before.toFixed(0)} → ${now.toFixed(0)} for this phrase in the monitored region.`,intent_profile:p,signals:['keyword_migration','regional_search'],score:clamp(55+Math.max(0,delta)*.9+p.commerciality_score*.18),confidence:Math.min(94,Number(cur.confidence||0)+5),source_resolution:sourceResolution(cur),evidence:{previous_relative_interest:before,current_relative_interest:now,delta,ratio,time_range:cur.metrics?.time_range}});created++}}
   const maturity=Number(mix.commerciality_score||0)-Number(prevMix.commerciality_score||0);if(maturity>=12&&Number(cur.opportunity_score)>=50){await upsertEvent(account,{event_type:'intent_maturation',geography_key:cur.geography_key,geography_name:geo,geography_type:cur.geography_type,service_cluster:mix.top_keyword,title:`Search intent is moving closer to action in ${geo}`,summary:`Commercial/transactional intent increased by ${Math.round(maturity)} points while regional demand remained material.`,intent_profile:mix,signals:['intent_maturation','regional_search'],score:clamp(58+maturity*1.4+Number(cur.opportunity_score||0)*.12),confidence:cur.confidence,source_resolution:sourceResolution(cur),evidence:{previous_intent:prevMix,current_intent:mix,opportunity_score:cur.opportunity_score}});created++}}
  const m=cur.metrics||{},q=Number(m.query_count??m.actual_search_count??0),radius=Number(m.radius_miles??m.resolution_miles??0),window=Number(m.window_minutes??0);if(q>=3&&radius>0&&radius<=10&&window>0&&window<=60){await upsertEvent(account,{event_type:'local_microburst',geography_key:cur.geography_key,geography_name:geo,geography_type:'radius',service_cluster:mix.top_keyword,title:`High-resolution demand burst detected in ${geo}`,summary:`A source reporting actual query counts observed ${q} related searches inside ${radius} miles within ${window} minutes.`,intent_profile:mix,signals:['actual_query_count','micro_geography','short_window'],score:clamp(70+Math.min(20,q*3)+mix.commerciality_score*.1),confidence:Math.max(75,Number(cur.confidence||0)),source_resolution:{...sourceResolution(cur),radius_miles:radius,window_minutes:window,actual_query_counts:true},evidence:{query_count:q,radius_miles:radius,window_minutes:window}});created++}}
 const persistent=await pool.query(`SELECT geography_key,MAX(geography_name) geography_name,MAX(geography_type) geography_type,COUNT(DISTINCT DATE(captured_at))::int active_days,ROUND(AVG(opportunity_score))::int avg_opportunity,ROUND(MAX(confidence))::int confidence FROM dominance_market_snapshots WHERE account_id=$1 AND captured_at>NOW()-INTERVAL '7 days' AND source_key IN('DATAFORSEO_TRENDS_4H','DATAFORSEO_TRENDS_30D') AND opportunity_score>=60 GROUP BY geography_key HAVING COUNT(DISTINCT DATE(captured_at))>=5`,[account.id]).catch(()=>({rows:[]}));
 for(const x of persistent.rows){await upsertEvent(account,{event_type:'persistent_demand',geography_key:x.geography_key,geography_name:x.geography_name,geography_type:x.geography_type,title:`Demand is persisting in ${x.geography_name}`,summary:`Material search demand has been observed on ${x.active_days} of the last 7 days with an average opportunity score of ${x.avg_opportunity}.`,signals:['persistence','regional_search'],score:clamp(60+Number(x.active_days)*4+Number(x.avg_opportunity)*.12),confidence:x.confidence,source_resolution:{time_range:'7_days',geography_type:x.geography_type},evidence:x});created++}
 const recent36=recent.rows.filter(x=>Date.now()-new Date(x.captured_at).getTime()<=36*3600000),geoGroups=new Map();for(const x of recent36){const arr=geoGroups.get(x.geography_key)||[];arr.push(x);geoGroups.set(x.geography_key,arr)}
 for(const [gk,rows] of geoGroups){const geo=rows[0]?.geography_name||gk,types=new Set(),max={search:0,first:0,competitor:0,news:0,supply:0,confidence:0};for(const x of rows){const s=String(x.source_key||'').toUpperCase();if(s.includes('DATAFORSEO')||s.includes('GSC')){types.add('search');max.search=Math.max(max.search,Number(x.opportunity_score||0))}if(s.includes('GA4')){types.add('first_party');max.first=Math.max(max.first,Number(x.opportunity_score||0))}if(s.includes('COMPETITOR')){types.add('competitor');max.competitor=Math.max(max.competitor,Number(x.opportunity_score||0))}if(s.includes('NEWS')){types.add('news');max.news=Math.max(max.news,Number(x.opportunity_score||0))}if(s.includes('CMS')||s.includes('SUPPLY')){types.add('supply');max.supply=Math.max(max.supply,Number(x.metrics?.supply_gap_score||0))}max.confidence=Math.max(max.confidence,Number(x.confidence||0))}
  if(types.size>=3&&max.search>=50){await upsertEvent(account,{event_type:'multi_signal_convergence',geography_key:gk,geography_name:geo,geography_type:rows[0]?.geography_type,title:`Multiple demand signals are converging in ${geo}`,summary:`Market Radar sees ${[...types].join(', ')} evidence in the same market, reducing the chance that one noisy source is driving the conclusion.`,signals:[...types],score:clamp(62+types.size*7+max.search*.15),confidence:clamp(Math.max(70,max.confidence)+types.size*3),source_resolution:{sources:[...new Set(rows.map(x=>x.source_key))]},evidence:max});created++}
  if(max.search>=55&&max.first>=45){await upsertEvent(account,{event_type:'first_party_confirmation',geography_key:gk,geography_name:geo,geography_type:rows[0]?.geography_type,title:`First-party engagement confirms external demand in ${geo}`,summary:`External search demand and the customer's own engagement are both elevated in this market.`,signals:['regional_search','first_party_engagement'],score:clamp((max.search*.55)+(max.first*.45)),confidence:clamp(Math.max(75,max.confidence)),source_resolution:{sources:[...new Set(rows.filter(x=>/DATAFORSEO|GSC|GA4/i.test(x.source_key)).map(x=>x.source_key))]},evidence:{search:max.search,first_party:max.first}});created++}
  if(max.search>=55&&max.competitor>=45){await upsertEvent(account,{event_type:'competitive_validation',geography_key:gk,geography_name:geo,geography_type:rows[0]?.geography_type,title:`Competitors are active where demand is rising in ${geo}`,summary:`Search demand and competitor SERP pressure are both material. Market Radar treats competition here as evidence to analyze—not automatically as a reason to avoid the market.`,signals:['regional_search','competitor_pressure'],score:clamp(max.search*.65+max.competitor*.35),confidence:clamp(Math.max(72,max.confidence)),source_resolution:{sources:[...new Set(rows.filter(x=>/DATAFORSEO|COMPETITOR/i.test(x.source_key)).map(x=>x.source_key))]},evidence:{search:max.search,competitor_pressure:max.competitor}});created++}
  if(max.news>=55&&max.search>=40){await upsertEvent(account,{event_type:'external_event_demand',geography_key:gk,geography_name:geo,geography_type:rows[0]?.geography_type,title:`External events may be influencing demand in ${geo}`,summary:`A localized news/event signal and relevant search demand are present in the same market.`,signals:['news_event','regional_search'],score:clamp(max.news*.45+max.search*.55),confidence:clamp(Math.max(65,max.confidence)),source_resolution:{sources:[...new Set(rows.filter(x=>/NEWS|DATAFORSEO|GSC/i.test(x.source_key)).map(x=>x.source_key))]},evidence:{news:max.news,search:max.search}});created++}
  if(max.supply>=60&&max.search>=50){await upsertEvent(account,{event_type:'demand_supply_gap',geography_key:gk,geography_name:geo,geography_type:rows[0]?.geography_type,title:`Demand-to-supply gap detected in ${geo}`,summary:`Relevant demand is elevated while connected supply/capacity data indicates insufficient local supply.`,signals:['regional_search','supply_gap'],score:clamp(max.search*.6+max.supply*.4),confidence:clamp(Math.max(70,max.confidence)),source_resolution:{sources:[...new Set(rows.map(x=>x.source_key))]},evidence:{search:max.search,supply_gap:max.supply}});created++}}
 const compEvents=await pool.query(`SELECT event_type,geography,keyword,title,summary,evidence,detected_at FROM dominance_competitor_events WHERE dominance_account_id=$1 AND geography IS NOT NULL AND detected_at>NOW()-INTERVAL '36 hours' AND event_type IN('keyword_rank_change','google_business_profile_change','new_paid_ad','competitor_paid_rank_change','competitor_paid_entry') ORDER BY detected_at DESC LIMIT 30`,[account.id]).catch(()=>({rows:[]}));
 for(const e of compEvents.rows){const p=e.keyword?(profiles.get(norm(e.keyword))||classifyIntent(e.keyword,account.company_name)):{};await upsertEvent(account,{event_type:'competitor_movement',geography_key:norm(e.geography),geography_name:e.geography,keyword:e.keyword||null,service_cluster:e.keyword||null,title:`Competitor movement detected in ${e.geography}`,summary:e.summary||e.title,intent_profile:p,signals:['competitor_change',e.event_type],score:68,confidence:76,source_resolution:{source:'competitor_intelligence',geography:e.geography},evidence:e});created++}
 await pool.query(`UPDATE dominance_market_demand_events SET status='resolved' WHERE account_id=$1 AND status='active' AND last_detected_at<NOW()-INTERVAL '72 hours' AND event_type NOT IN('persistent_demand')`,[account.id]);
 return{events_evaluated:created};
}
async function run(){if(!pool||busy)return{ok:false,busy};busy=true;try{await ensureSchema();const accounts=await pool.query(`SELECT id,company_name,industry_name FROM dominance_accounts WHERE is_active=TRUE ORDER BY id`),results=[];for(const a of accounts.rows){const startedAt=new Date().toISOString();try{const profiles=await classifyKeywords(a),result=await detectForAccount(a,profiles),active=await pool.query(`SELECT COUNT(*)::int n FROM dominance_market_demand_events WHERE account_id=$1 AND status='active'`,[a.id]),out={account_id:a.id,status:'completed',classified_keywords:profiles.size,active_events:Number(active.rows[0]?.n||0),...result};results.push(out);await cp.recordWorkerAccountRun(pool,'market-demand-event-worker',a.id,'completed',out,startedAt).catch(()=>{})}catch(e){const out={account_id:a.id,status:'error',error:e.message};results.push(out);await cp.recordWorkerAccountRun(pool,'market-demand-event-worker',a.id,'error',out,startedAt).catch(()=>{})}}await pool.query(`INSERT INTO dominance_worker_state(worker_key,last_heartbeat_at,last_run_at,status,details) VALUES('market-demand-event-worker',NOW(),NOW(),'online',$1::jsonb) ON CONFLICT(worker_key) DO UPDATE SET last_heartbeat_at=NOW(),last_run_at=NOW(),status='online',details=EXCLUDED.details`,[JSON.stringify({accounts:accounts.rowCount,results})]).catch(()=>{});return{ok:true,results}}catch(e){console.error('[MARKET RADAR DEMAND EVENTS]',e);return{ok:false,error:e.message}}finally{busy=false}}
function startMarketDemandEventWorker(){if(!pool){console.warn('[MARKET RADAR DEMAND EVENTS] DATABASE_URL unavailable');return null}setTimeout(run,24000);timer=setInterval(run,INTERVAL_MS);console.log(`[MARKET RADAR DEMAND EVENTS] online | interval=${INTERVAL_MS/60000}m`);return{run,stop:()=>{if(timer)clearInterval(timer);return pool.end().catch(()=>{})}}}
module.exports={startMarketDemandEventWorker,runMarketDemandEvents:run,classifyIntent,intentMix};
