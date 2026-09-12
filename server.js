const express=require('express');
const cheerio=require('cheerio');
const path=require('path');
const crypto=require('crypto');
const bcrypt=require('bcryptjs');
const session=require('express-session');
const pgSession=require('connect-pg-simple')(session);
const {Pool}=require('pg');
const {authenticator}=require('otplib');
const QRCode=require('qrcode');
const helmet=require('helmet');
const rateLimit=require('express-rate-limit');

const app=express();
app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'256kb'}));

const PORT=process.env.PORT||3000;
const MAX_PAGES=Number(process.env.MAX_CRAWL_PAGES||8);
const UA='DOMINANCE-Market-Radar/0.3 (+https://www.weblogixgroup.com)';
const DATABASE_URL=process.env.DATABASE_URL||'';
const SESSION_SECRET=process.env.SESSION_SECRET||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false}):null;

if(pool&&SESSION_SECRET){
 app.use(session({
   store:new pgSession({pool,createTableIfMissing:true,tableName:'dominance_sessions'}),
   secret:SESSION_SECRET,
   resave:false,
   saveUninitialized:false,
   rolling:true,
   cookie:{httpOnly:true,secure:IS_PROD,sameSite:'lax',maxAge:1000*60*60*12}
 }));
}else{
 app.use(session({secret:SESSION_SECRET||crypto.randomBytes(32).toString('hex'),resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:false,maxAge:1000*60*60}}));
 console.warn('DOMINANCE auth is running without persistent PostgreSQL/session configuration. Set DATABASE_URL and SESSION_SECRET before production use.');
}

const authLimiter=rateLimit({windowMs:15*60*1000,limit:20,standardHeaders:true,legacyHeaders:false,message:{ok:false,error:'Too many authentication attempts. Try again later.'}});
const setupLimiter=rateLimit({windowMs:60*60*1000,limit:10,standardHeaders:true,legacyHeaders:false});

async function ensureAuthSchema(){
 if(!pool)return;
 await pool.query(`CREATE TABLE IF NOT EXISTS dominance_users (
   id BIGSERIAL PRIMARY KEY,
   email TEXT UNIQUE NOT NULL,
   password_hash TEXT NOT NULL,
   role TEXT NOT NULL DEFAULT 'admin',
   totp_secret TEXT,
   totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
   recovery_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   last_login_at TIMESTAMPTZ
 )`);
}
ensureAuthSchema().catch(e=>console.error('Auth schema error',e));

function requireDb(req,res,next){if(!pool)return res.status(503).json({ok:false,error:'Authentication database is not configured. Add DATABASE_URL on Render.'});next()}
function requireAuth(req,res,next){if(req.session&&req.session.userId)return next();if(req.path.startsWith('/api/'))return res.status(401).json({ok:false,error:'Authentication required'});return res.redirect('/login.html')}
function normalizeEmail(v){return String(v||'').trim().toLowerCase()}
function goodPassword(v){return typeof v==='string'&&v.length>=12&&/[A-Z]/.test(v)&&/[a-z]/.test(v)&&/[0-9]/.test(v)}
function newRecoveryCodes(){return Array.from({length:10},()=>crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g).join('-'))}
async function hashRecovery(codes){return Promise.all(codes.map(c=>bcrypt.hash(c,10)))}
async function userCount(){const r=await pool.query('SELECT COUNT(*)::int AS n FROM dominance_users');return r.rows[0].n}

app.get('/api/health',async(_,res)=>{
 let db=false;try{if(pool){await pool.query('SELECT 1');db=true}}catch{}
 res.json({ok:true,service:'dominance-market-radar',website_analyzer:true,industry_detection:true,adaptive_layers:true,authentication:true,totp_2fa:true,database_connected:db});
});

app.get('/api/auth/status',requireDb,async(req,res)=>{
 await ensureAuthSchema();
 const n=await userCount();
 res.json({ok:true,setup_required:n===0,authenticated:!!req.session.userId});
});

app.post('/api/auth/setup/start',setupLimiter,requireDb,async(req,res)=>{
 try{
   await ensureAuthSchema();
   const email=normalizeEmail(req.body.email),password=String(req.body.password||'');
   if(await userCount()>0)return res.status(409).json({ok:false,error:'Initial administrator already exists.'});
   if(!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({ok:false,error:'Enter a valid email address.'});
   if(!goodPassword(password))return res.status(400).json({ok:false,error:'Password must be at least 12 characters and contain upper-case, lower-case and a number.'});
   const passwordHash=await bcrypt.hash(password,12);
   const secret=authenticator.generateSecret();
   const recovery=newRecoveryCodes();
   const recoveryHashes=await hashRecovery(recovery);
   await pool.query('INSERT INTO dominance_users(email,password_hash,role,totp_secret,totp_enabled,recovery_hashes) VALUES($1,$2,$3,$4,FALSE,$5::jsonb)',[email,passwordHash,'admin',secret,JSON.stringify(recoveryHashes)]);
   const otpauth=authenticator.keyuri(email,'DOMINANCE',secret);
   const qr=await QRCode.toDataURL(otpauth,{margin:1,width:240});
   req.session.pendingSetupEmail=email;
   res.json({ok:true,email,qr,manual_secret:secret,recovery_codes:recovery});
 }catch(e){console.error(e);res.status(500).json({ok:false,error:'Unable to initialize administrator.'})}
});

app.post('/api/auth/setup/verify',setupLimiter,requireDb,async(req,res)=>{
 try{
   const email=normalizeEmail(req.session.pendingSetupEmail||req.body.email),code=String(req.body.code||'').replace(/\s+/g,'');
   const r=await pool.query('SELECT * FROM dominance_users WHERE email=$1',[email]);
   const u=r.rows[0];if(!u)return res.status(404).json({ok:false,error:'Setup user not found.'});
   if(!authenticator.check(code,u.totp_secret))return res.status(400).json({ok:false,error:'Invalid authenticator code.'});
   await pool.query('UPDATE dominance_users SET totp_enabled=TRUE,last_login_at=NOW() WHERE id=$1',[u.id]);
   req.session.userId=u.id;req.session.role=u.role;delete req.session.pendingSetupEmail;
   res.json({ok:true});
 }catch(e){res.status(500).json({ok:false,error:'Unable to verify 2FA.'})}
});

app.post('/api/auth/login/password',authLimiter,requireDb,async(req,res)=>{
 try{
   const email=normalizeEmail(req.body.email),password=String(req.body.password||'');
   const r=await pool.query('SELECT * FROM dominance_users WHERE email=$1',[email]);
   const u=r.rows[0];
   if(!u||!await bcrypt.compare(password,u.password_hash))return res.status(401).json({ok:false,error:'Invalid email or password.'});
   if(!u.totp_enabled)return res.status(403).json({ok:false,error:'2FA setup is incomplete.'});
   req.session.pending2fa=u.id;
   res.json({ok:true,requires_2fa:true});
 }catch(e){res.status(500).json({ok:false,error:'Login unavailable.'})}
});

app.post('/api/auth/login/2fa',authLimiter,requireDb,async(req,res)=>{
 try{
   const id=req.session.pending2fa,code=String(req.body.code||'').replace(/\s+/g,'');
   if(!id)return res.status(401).json({ok:false,error:'Password verification expired. Start again.'});
   const r=await pool.query('SELECT * FROM dominance_users WHERE id=$1',[id]);const u=r.rows[0];
   if(!u||!authenticator.check(code,u.totp_secret))return res.status(401).json({ok:false,error:'Invalid 2FA code.'});
   req.session.userId=u.id;req.session.role=u.role;delete req.session.pending2fa;
   await pool.query('UPDATE dominance_users SET last_login_at=NOW() WHERE id=$1',[u.id]);
   res.json({ok:true});
 }catch(e){res.status(500).json({ok:false,error:'2FA verification unavailable.'})}
});

app.post('/api/auth/login/recovery',authLimiter,requireDb,async(req,res)=>{
 try{
   const id=req.session.pending2fa,code=String(req.body.code||'').trim().toUpperCase();
   if(!id)return res.status(401).json({ok:false,error:'Password verification expired.'});
   const r=await pool.query('SELECT * FROM dominance_users WHERE id=$1',[id]);const u=r.rows[0];if(!u)return res.status(401).json({ok:false,error:'Invalid session.'});
   const hashes=Array.isArray(u.recovery_hashes)?u.recovery_hashes:[];let matched=-1;
   for(let i=0;i<hashes.length;i++){if(await bcrypt.compare(code,hashes[i])){matched=i;break}}
   if(matched<0)return res.status(401).json({ok:false,error:'Invalid recovery code.'});
   hashes.splice(matched,1);await pool.query('UPDATE dominance_users SET recovery_hashes=$1::jsonb,last_login_at=NOW() WHERE id=$2',[JSON.stringify(hashes),u.id]);
   req.session.userId=u.id;req.session.role=u.role;delete req.session.pending2fa;res.json({ok:true});
 }catch(e){res.status(500).json({ok:false,error:'Recovery login unavailable.'})}
});

app.get('/api/auth/me',requireAuth,requireDb,async(req,res)=>{const r=await pool.query('SELECT id,email,role,totp_enabled,last_login_at FROM dominance_users WHERE id=$1',[req.session.userId]);res.json({ok:true,user:r.rows[0]||null})});
app.post('/api/auth/logout',(req,res)=>req.session.destroy(()=>{res.clearCookie('connect.sid');res.json({ok:true})}));

const STOP=new Set(`the a an and or for to of in on with by from at as is are was were be been being this that these those your our their its we you they it can will may more less best get use using help helps into across about through over under not no yes who what where when why how company business services service solution solutions page home contact learn schedule today group digital web website`.split(/\s+/));
function cleanUrl(input){let u=String(input||'').trim();if(!/^https?:\/\//i.test(u))u='https://'+u;const p=new URL(u);if(!['http:','https:'].includes(p.protocol))throw Error('Only http(s) URLs are supported');p.hash='';return p}
function norm(s){return String(s||'').replace(/\s+/g,' ').trim()}
function textOf($){$('script,style,noscript,svg,canvas,form,nav,footer').remove();const a=[];$('title,h1,h2,h3,h4,p,li,a,button').each((_,e)=>{const t=norm($(e).text());if(t.length>=3&&t.length<=500)a.push(t)});return a.join('\n')}
function tokens(t){return t.toLowerCase().replace(/[^a-z0-9+\-/ ]+/g,' ').split(/\s+/).filter(Boolean)}
function phrases(text){const scores=new Map(),bump=(p,w)=>{p=p.toLowerCase().replace(/\s+/g,' ').trim();if(!p||p.length<4||p.length>80)return;const ws=p.split(' ');if(ws.filter(x=>!STOP.has(x)).length<1)return;scores.set(p,(scores.get(p)||0)+w)};for(const line of text.split('\n').map(norm).filter(Boolean)){const w=tokens(line).filter(x=>x.length>1);if(w.length>=2&&w.length<=9)bump(w.join(' '),5);for(let n=2;n<=4;n++)for(let i=0;i<=w.length-n;i++){const g=w.slice(i,i+n);if(g.filter(x=>!STOP.has(x)).length>=2)bump(g.join(' '),n===2?1:n===3?1.6:2)}}return[...scores.entries()].map(([phrase,score])=>({phrase,score})).sort((a,b)=>b.score-a.score)}
function dedupe(items,limit=40){const o=[];for(const x of items){if(o.some(y=>y.phrase.includes(x.phrase)||x.phrase.includes(y.phrase)))continue;o.push(x);if(o.length>=limit)break}return o}
function expand(seeds){const suff=['near me','services','company','consulting','platform','software','solutions','strategy','automation','analytics'],o=[];for(const s of seeds.slice(0,12)){const core=s.phrase.split(' ').slice(0,3).join(' ');for(const z of suff.slice(0,4))o.push({phrase:`${core} ${z}`,source:'semantic-expansion',confidence:.55})}const seen=new Set(seeds.map(x=>x.phrase));return o.filter(x=>!seen.has(x.phrase)).filter((x,i,a)=>a.findIndex(y=>y.phrase===x.phrase)===i).slice(0,30)}
const INDUSTRIES={marketing_technology:{name:'Marketing & Technology Services',terms:['marketing','seo','advertising','paid media','web development','software development','app development','ai automation','digital agency','technology consulting','cybersecurity','analytics','crm','api integration'],layers:['New Business Formation','New Domains','New Websites','Tech Adoption','Hiring / Growth','Search Demand','Paid Media Adoption','AI / Automation Adoption','Agency Competition']},healthcare:{name:'Healthcare',terms:['patient','hospital','clinic','healthcare','medical','physician','treatment','ehr','emr','urgent care','behavioral health'],layers:['Search Demand','Payer Fit','Age Fit','Income Fit','Health Need','Provider Density','Competitive Pressure']},saas:{name:'Software / SaaS',terms:['saas','software platform','subscription software','cloud platform','software as a service'],layers:['New Companies','Funding / Capital','Hiring Growth','Technology Adoption','Search Demand','New Domains','Competitor Pressure']},ecommerce:{name:'Retail / Ecommerce',terms:['ecommerce','shopify','online store','retail','consumer products','shopping'],layers:['Consumer Demand','Income','Population Growth','Ecommerce Tech Adoption','New Stores / Sites','Paid Media Adoption','Competitive Density']},real_estate:{name:'Real Estate / Development',terms:['real estate','property','realtor','construction','developer','housing'],layers:['Permits / Construction','Population Growth','Income','Migration','Inventory','Search Demand','Competitive Density']},professional_services:{name:'Professional Services',terms:['consulting','law firm','legal services','accounting','advisory','professional services'],layers:['New Businesses','New Domains','New Websites','Hiring / Growth','Search Demand','Paid Adoption','Competitive Pressure']}};
function classify(text,host){const t=text.toLowerCase(),scores={};for(const[k,p]of Object.entries(INDUSTRIES)){scores[k]=0;for(const term of p.terms){let i=0;while((i=t.indexOf(term,i))!==-1){scores[k]++;i+=term.length}}}if(host.includes('weblogixgroup'))scores.marketing_technology+=20;const sorted=Object.entries(scores).sort((a,b)=>b[1]-a[1]),key=sorted[0][1]>0?sorted[0][0]:'professional_services';return{industry_key:key,industry_name:INDUSTRIES[key].name,industry_confidence:Math.min(.98,.55+sorted[0][1]/Math.max(20,sorted.reduce((s,x)=>s+x[1],0))),industry_reason:`Detected from recurring website concepts associated with ${INDUSTRIES[key].name}.`,recommended_layers:INDUSTRIES[key].layers,scores}}
async function fetchPage(url){const c=new AbortController(),tm=setTimeout(()=>c.abort(),12000);try{const r=await fetch(url,{redirect:'follow',signal:c.signal,headers:{'user-agent':UA,accept:'text/html,application/xhtml+xml'}});if(!r.ok)throw Error(`HTTP ${r.status}`);if(!(r.headers.get('content-type')||'').includes('text/html'))throw Error('Not HTML');return{html:await r.text(),finalUrl:r.url}}finally{clearTimeout(tm)}}
function links(html,page,host){const $=cheerio.load(html),a=[];$('a[href]').each((_,e)=>{try{const u=new URL($(e).attr('href'),page);u.hash='';if(u.hostname===host&&['http:','https:'].includes(u.protocol)&&!/\.(pdf|jpg|jpeg|png|gif|svg|zip|docx?|xlsx?|pptx?)$/i.test(u.pathname))a.push(u.toString())}catch{}});return[...new Set(a)]}

app.post('/api/analyze-site',requireAuth,async(req,res)=>{try{const start=cleanUrl(req.body&&req.body.url),host=start.hostname,q=[start.toString()],seen=new Set(),pages=[],texts=[];while(q.length&&seen.size<MAX_PAGES){const url=q.shift();if(seen.has(url))continue;seen.add(url);try{const{html,finalUrl}=await fetchPage(url),$=cheerio.load(html),text=textOf($);pages.push({url:finalUrl,title:norm($('title').first().text()),chars:text.length});texts.push(text);for(const l of links(html,finalUrl,host))if(!seen.has(l)&&q.length<50)q.push(l)}catch(e){pages.push({url,error:e.message})}}const combined=texts.join('\n'),candidates=dedupe(phrases(combined),50),seeds=candidates.slice(0,20).map((x,i)=>({phrase:x.phrase,relevance:Math.max(55,Math.round(96-i*1.7)),source:'website'})),related=expand(seeds),industry=classify(combined,host);res.json({ok:true,site:start.origin,pages_scanned:pages.length,pages,seeds,related,...industry,note:'Industry and website intent are live-derived. Geographic market values remain modeled until external data feeds are connected.'})}catch(e){res.status(400).json({ok:false,error:e.message||'Unable to analyze site'})}});

app.get('/login.html',(_,res)=>res.sendFile(path.join(__dirname,'login.html')));
app.get('/context.js',requireAuth,(_,res)=>res.sendFile(path.join(__dirname,'context.js')));
const protectedPages=['/','/index.html','/os.html','/competitor.html','/campaign.html','/admin.html'];
for(const p of protectedPages)app.get(p,requireAuth,(req,res)=>res.sendFile(path.join(__dirname,p==='/'?'os.html':p.slice(1))));
app.use(requireAuth,express.static(__dirname));
app.get('*',requireAuth,(_,res)=>res.sendFile(path.join(__dirname,'os.html')));

app.listen(PORT,()=>console.log(`DOMINANCE listening on ${PORT}`));