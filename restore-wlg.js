const {Pool}=require('pg');

const DATABASE_URL=process.env.DATABASE_URL||'';
const IS_PROD=process.env.NODE_ENV==='production'||!!process.env.RENDER;
const MIGRATION_KEY='restore_weblogix_group_2026_09_14_v1';

if(!DATABASE_URL){console.warn('[WLG RESTORE] DATABASE_URL unavailable; skipping');process.exit(0)}
const pool=new Pool({connectionString:DATABASE_URL,ssl:IS_PROD?{rejectUnauthorized:false}:false});

function normalizeWebsite(url){try{const u=new URL(/^https?:\/\//i.test(String(url||''))?url:'https://'+url);return(u.hostname.replace(/^www\./,'')+u.pathname.replace(/\/+$/,'')).toLowerCase()}catch{return String(url||'').trim().toLowerCase()}}
function stableAccountKey(url){const s=normalizeWebsite(url);let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return'site_'+(h>>>0).toString(36)}
function connectionRank(x){const status=String(x.status||'').toLowerCase();let n=0;if(x.credential_ciphertext)n+=10000;if(status==='connected')n+=5000;else if(status==='synced')n+=4000;else if(status==='enabled')n+=3000;else if(status==='configured')n+=2000;else if(status==='needs_configuration')n+=500;const t=new Date(x.last_sync_at||x.updated_at||x.created_at||0).getTime();return n+(Number.isFinite(t)?t/1e13:0)}
async function tableExists(name){const r=await pool.query('SELECT to_regclass($1) AS x',['public.'+name]);return!!r.rows[0]?.x}
async function countRef(table,column,id){try{const r=await pool.query(`SELECT COUNT(*)::int n FROM ${table} WHERE ${column}=$1`,[id]);return r.rows[0]?.n||0}catch{return 0}}
async function accountRefs(){const r=await pool.query(`
 SELECT DISTINCT ns.nspname AS schema_name,t.relname AS table_name,a.attname AS column_name
 FROM pg_constraint c
 JOIN pg_class t ON t.oid=c.conrelid
 JOIN pg_namespace ns ON ns.oid=t.relnamespace
 JOIN pg_class rt ON rt.oid=c.confrelid
 JOIN unnest(c.conkey) WITH ORDINALITY cols(attnum,ord) ON TRUE
 JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=cols.attnum
 WHERE c.contype='f' AND rt.relname='dominance_accounts' AND ns.nspname='public'
 ORDER BY t.relname,a.attname`);return r.rows}
async function scoreAccount(a,refs){let score=0;for(const ref of refs){const n=await countRef(`"${ref.table_name}"`,`"${ref.column_name}"`,a.id);score+=n;if(ref.table_name==='dominance_connections')score+=n*1000;if(ref.table_name==='dominance_data_snapshots')score+=n*100;if(ref.table_name==='dominance_market_snapshots')score+=n*75;if(ref.table_name==='dominance_activity')score+=n*10;if(ref.table_name==='dominance_scan_runs')score+=n*10}try{const r=await pool.query(`SELECT COUNT(*)::int n FROM dominance_connections WHERE account_id=$1 AND credential_ciphertext IS NOT NULL`,[a.id]);score+=(r.rows[0]?.n||0)*10000}catch{}return score}
async function mergeConnections(canonicalId,candidateIds){if(!await tableExists('dominance_connections'))return{providers:0};const r=await pool.query(`SELECT * FROM dominance_connections WHERE account_id=ANY($1::bigint[]) ORDER BY provider_key`,[candidateIds]);const best=new Map();for(const row of r.rows){const cur=best.get(row.provider_key);if(!cur||connectionRank(row)>connectionRank(cur))best.set(row.provider_key,row)}for(const row of best.values())await pool.query(`
 INSERT INTO dominance_connections(account_id,provider_key,provider_name,connection_type,status,metadata,credential_ciphertext,last_sync_at,last_error,created_at,updated_at)
 VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,COALESCE($10,NOW()),COALESCE($11,NOW()))
 ON CONFLICT(account_id,provider_key) DO UPDATE SET
 provider_name=EXCLUDED.provider_name,connection_type=EXCLUDED.connection_type,status=EXCLUDED.status,
 metadata=COALESCE(dominance_connections.metadata,'{}'::jsonb)||COALESCE(EXCLUDED.metadata,'{}'::jsonb),
 credential_ciphertext=COALESCE(EXCLUDED.credential_ciphertext,dominance_connections.credential_ciphertext),
 last_sync_at=GREATEST(dominance_connections.last_sync_at,EXCLUDED.last_sync_at),
 last_error=EXCLUDED.last_error,updated_at=NOW()`,[canonicalId,row.provider_key,row.provider_name,row.connection_type,row.status,JSON.stringify(row.metadata||{}),row.credential_ciphertext,row.last_sync_at,row.last_error,row.created_at,row.updated_at]);return{providers:best.size}}
async function moveForeignKeyRows(canonicalId,losers,refs){const moved=[];for(const ref of refs){if(ref.table_name==='dominance_connections')continue;for(const loser of losers){const sp='sp_'+String(ref.table_name+'_'+ref.column_name+'_'+loser.id).replace(/[^a-zA-Z0-9_]/g,'_').slice(0,50);try{await pool.query(`SAVEPOINT ${sp}`);const q=`UPDATE "${ref.table_name}" SET "${ref.column_name}"=$1 WHERE "${ref.column_name}"=$2`;const r=await pool.query(q,[canonicalId,loser.id]);await pool.query(`RELEASE SAVEPOINT ${sp}`);if(r.rowCount)moved.push({table:ref.table_name,column:ref.column_name,rows:r.rowCount})}catch(e){await pool.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(()=>{});await pool.query(`RELEASE SAVEPOINT ${sp}`).catch(()=>{});console.warn(`[WLG RESTORE] kept ${ref.table_name}.${ref.column_name} rows on duplicate account ${loser.id}: ${e.code||''} ${e.message||e}`)}}}return moved}
async function mergeAccountKeyData(canonicalKey,losers){const out=[];const loserKeys=losers.map(x=>x.account_key).filter(Boolean);if(!loserKeys.length)return out;if(await tableExists('dominance_creative_learning')){for(const key of loserKeys){try{await pool.query(`
 INSERT INTO dominance_creative_learning(account_key,platform,dimension,value,impressions,clicks,spend,conversions,qualified_outcomes,revenue,score,sample_size,updated_at)
 SELECT $1,platform,dimension,value,impressions,clicks,spend,conversions,qualified_outcomes,revenue,score,sample_size,updated_at FROM dominance_creative_learning WHERE account_key=$2
 ON CONFLICT(account_key,platform,dimension,value) DO UPDATE SET
 impressions=dominance_creative_learning.impressions+EXCLUDED.impressions,
 clicks=dominance_creative_learning.clicks+EXCLUDED.clicks,
 spend=dominance_creative_learning.spend+EXCLUDED.spend,
 conversions=dominance_creative_learning.conversions+EXCLUDED.conversions,
 qualified_outcomes=dominance_creative_learning.qualified_outcomes+EXCLUDED.qualified_outcomes,
 revenue=dominance_creative_learning.revenue+EXCLUDED.revenue,
 score=GREATEST(dominance_creative_learning.score,EXCLUDED.score),
 sample_size=dominance_creative_learning.sample_size+EXCLUDED.sample_size,
 updated_at=GREATEST(dominance_creative_learning.updated_at,EXCLUDED.updated_at)`,[canonicalKey,key]);const d=await pool.query('DELETE FROM dominance_creative_learning WHERE account_key=$1',[key]);if(d.rowCount)out.push({table:'dominance_creative_learning',rows:d.rowCount})}catch(e){console.warn('[WLG RESTORE] creative learning merge skipped:',e.message||e)}}}
 if(await tableExists('dominance_creatives'))for(const key of loserKeys){try{const r=await pool.query('UPDATE dominance_creatives SET account_key=$1 WHERE account_key=$2',[canonicalKey,key]);if(r.rowCount)out.push({table:'dominance_creatives',rows:r.rowCount})}catch(e){console.warn('[WLG RESTORE] creatives account key merge skipped:',e.message||e)}}return out}
async function restoreOwner(ownerId,candidates,refs){const canonicalKey=stableAccountKey('https://www.weblogixgroup.com');for(const a of candidates)a._score=await scoreAccount(a,refs);const stable=candidates.find(x=>x.account_key===canonicalKey);const richest=[...candidates].sort((a,b)=>b._score-a._score||new Date(b.updated_at)-new Date(a.updated_at))[0];const canonical=stable||richest;if(!canonical)return null;const losers=candidates.filter(x=>x.id!==canonical.id),latest=[...candidates].sort((a,b)=>new Date(b.updated_at)-new Date(a.updated_at))[0];if(canonical.account_key!==canonicalKey&&!candidates.some(x=>x.account_key===canonicalKey)){await pool.query('UPDATE dominance_accounts SET account_key=$1 WHERE id=$2',[canonicalKey,canonical.id]);canonical.account_key=canonicalKey}
 const mergedAnalysis={...(canonical.analysis||{}),...(latest?.analysis||{}),restoration:{restored_at:new Date().toISOString(),source_account_ids:candidates.map(x=>x.id),canonical_account_id:canonical.id,canonical_account_key:canonical.account_key}};
 await pool.query('UPDATE dominance_accounts SET company_name=$1,website=$2,industry_key=COALESCE($3,industry_key),industry_name=COALESCE($4,industry_name),analysis=$5::jsonb,updated_at=NOW() WHERE id=$6',['Web Logix Group LLC','https://www.weblogixgroup.com',latest?.industry_key||canonical.industry_key,latest?.industry_name||canonical.industry_name,JSON.stringify(mergedAnalysis),canonical.id]);
 const conns=await mergeConnections(canonical.id,candidates.map(x=>x.id));
 const moved=await moveForeignKeyRows(canonical.id,losers,refs);
 const keyed=await mergeAccountKeyData(canonical.account_key,losers);
 await pool.query('UPDATE dominance_accounts SET is_active=FALSE,analysis=COALESCE(analysis,\'{}\'::jsonb)||jsonb_build_object(\'merged_into_account_id\',$1,\'merged_at\',NOW()) WHERE owner_user_id=$2 AND id<>$1 AND (LOWER(website) LIKE \'%weblogixgroup.com%\' OR LOWER(company_name) LIKE \'%web logix%\')',[canonical.id,ownerId]);
 await pool.query('UPDATE dominance_accounts SET is_active=FALSE WHERE owner_user_id=$1',[ownerId]);
 await pool.query('UPDATE dominance_accounts SET is_active=TRUE,updated_at=NOW() WHERE id=$1',[canonical.id]);
 return{owner_user_id:ownerId,canonical_account_id:canonical.id,canonical_account_key:canonical.account_key,candidates:candidates.map(x=>({id:x.id,key:x.account_key,score:x._score})),connections_restored:conns.providers,moved_foreign_key_rows:moved,keyed_rows:keyed};}

async function main(){await pool.query(`CREATE TABLE IF NOT EXISTS dominance_maintenance_log(migration_key TEXT PRIMARY KEY,status TEXT NOT NULL,details JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ)`);await pool.query('SELECT pg_advisory_lock(hashtext($1))',[MIGRATION_KEY]);try{const done=await pool.query('SELECT status,details FROM dominance_maintenance_log WHERE migration_key=$1',[MIGRATION_KEY]);if(done.rows[0]?.status==='completed'){console.log('[WLG RESTORE] already completed');return}const r=await pool.query(`SELECT * FROM dominance_accounts WHERE LOWER(website) LIKE '%weblogixgroup.com%' OR LOWER(company_name) LIKE '%web logix%' ORDER BY owner_user_id,updated_at DESC`);if(!r.rows.length){console.warn('[WLG RESTORE] no Web Logix Group account records found; migration left pending');return}const refs=await accountRefs(),byOwner=new Map();for(const a of r.rows){const arr=byOwner.get(a.owner_user_id)||[];arr.push(a);byOwner.set(a.owner_user_id,arr)}const results=[];await pool.query('BEGIN');try{for(const[ownerId,candidates]of byOwner)results.push(await restoreOwner(ownerId,candidates,refs));await pool.query(`INSERT INTO dominance_maintenance_log(migration_key,status,details,completed_at) VALUES($1,'completed',$2::jsonb,NOW()) ON CONFLICT(migration_key) DO UPDATE SET status='completed',details=EXCLUDED.details,completed_at=NOW()`,[MIGRATION_KEY,JSON.stringify({restored_at:new Date().toISOString(),results})]);await pool.query('COMMIT')}catch(e){await pool.query('ROLLBACK');throw e}console.log('[WLG RESTORE] completed '+JSON.stringify(results))}finally{await pool.query('SELECT pg_advisory_unlock(hashtext($1))',[MIGRATION_KEY]).catch(()=>{});await pool.end()}}

main().catch(e=>{console.error('[WLG RESTORE] failed',e);process.exit(1)});
