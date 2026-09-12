const express = require('express');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3000;
const MAX_PAGES = Number(process.env.MAX_CRAWL_PAGES || 8);
const USER_AGENT = 'DOMINANCE-Market-Radar/0.1 (+https://www.weblogixgroup.com)';

const STOP = new Set(`the a an and or for to of in on with by from at as is are was were be been being this that these those your our their its we you they it can will may more less best get use using help helps into across about through over under not no yes who what where when why how company business services service solution solutions page home contact learn schedule today group digital web website`.split(/\s+/));

function cleanUrl(input) {
  let u = String(input || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const parsed = new URL(u);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) URLs are supported');
  parsed.hash = '';
  return parsed;
}

function normalizeText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .trim();
}

function visibleText($) {
  $('script,style,noscript,svg,canvas,form,nav,footer').remove();
  const parts = [];
  $('h1,h2,h3,h4,p,li,a,button').each((_, el) => {
    const t = normalizeText($(el).text());
    if (t.length >= 3 && t.length <= 500) parts.push(t);
  });
  return parts.join('\n');
}

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9+\-/ ]+/g, ' ').split(/\s+/).filter(Boolean);
}

function phraseCandidates(text) {
  const lines = text.split('\n').map(normalizeText).filter(Boolean);
  const scores = new Map();
  const bump = (phrase, weight) => {
    phrase = phrase.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!phrase || phrase.length < 4 || phrase.length > 80) return;
    const words = phrase.split(' ');
    if (words.every(w => STOP.has(w))) return;
    if (words.filter(w => !STOP.has(w)).length === 0) return;
    scores.set(phrase, (scores.get(phrase) || 0) + weight);
  };

  for (const line of lines) {
    const words = tokenize(line).filter(w => w.length > 1);
    if (words.length >= 2 && words.length <= 9) bump(words.join(' '), 5);
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i <= words.length - n; i++) {
        const gram = words.slice(i, i + n);
        if (gram.some(w => STOP.has(w)) && gram.filter(w => !STOP.has(w)).length < 2) continue;
        bump(gram.join(' '), n === 2 ? 1 : n === 3 ? 1.6 : 2);
      }
    }
  }

  return [...scores.entries()]
    .map(([phrase, score]) => ({ phrase, score: Math.round(score * 10) / 10 }))
    .sort((a, b) => b.score - a.score);
}

function dedupePhrases(items, limit = 40) {
  const out = [];
  for (const item of items) {
    const p = item.phrase;
    if (STOP.has(p)) continue;
    if (out.some(x => x.phrase.includes(p) || p.includes(x.phrase))) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function semanticExpand(seeds) {
  const suffixes = ['near me','services','company','consulting','platform','software','solutions','strategy','automation','analytics'];
  const expansions = [];
  for (const s of seeds.slice(0, 12)) {
    const words = s.phrase.split(' ');
    const core = words.slice(0, Math.min(3, words.length)).join(' ');
    for (const suffix of suffixes.slice(0, 4)) {
      const phrase = `${core} ${suffix}`.replace(/\s+/g, ' ').trim();
      if (phrase !== s.phrase) expansions.push({ phrase, source: 'semantic-expansion', confidence: 0.55 });
    }
  }
  const seen = new Set(seeds.map(x => x.phrase));
  return expansions.filter(x => !seen.has(x.phrase)).filter((x,i,a)=>a.findIndex(y=>y.phrase===x.phrase)===i).slice(0,30);
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': USER_AGENT, 'accept': 'text/html,application/xhtml+xml' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/html')) throw new Error('Not HTML');
    const html = await res.text();
    return { html, finalUrl: res.url };
  } finally { clearTimeout(timer); }
}

function internalLinks(html, pageUrl, rootHost) {
  const $ = cheerio.load(html);
  const links = [];
  $('a[href]').each((_, a) => {
    try {
      const u = new URL($(a).attr('href'), pageUrl);
      u.hash = '';
      if (u.hostname !== rootHost) return;
      if (!['http:','https:'].includes(u.protocol)) return;
      if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|docx?|xlsx?|pptx?)$/i.test(u.pathname)) return;
      links.push(u.toString());
    } catch (_) {}
  });
  return [...new Set(links)];
}

app.post('/api/analyze-site', async (req, res) => {
  try {
    const start = cleanUrl(req.body && req.body.url);
    const host = start.hostname;
    const queue = [start.toString()];
    const visited = new Set();
    const pages = [];
    const allText = [];

    while (queue.length && visited.size < MAX_PAGES) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);
      try {
        const { html, finalUrl } = await fetchPage(url);
        const $ = cheerio.load(html);
        const title = normalizeText($('title').first().text());
        const text = visibleText($);
        pages.push({ url: finalUrl, title, chars: text.length });
        allText.push(text);
        for (const link of internalLinks(html, finalUrl, host)) {
          if (!visited.has(link) && queue.length < 50) queue.push(link);
        }
      } catch (err) {
        pages.push({ url, error: err.message });
      }
    }

    const combined = allText.join('\n');
    const candidates = dedupePhrases(phraseCandidates(combined), 50);
    const seeds = candidates.slice(0, 20).map((x, i) => ({
      phrase: x.phrase,
      relevance: Math.max(55, Math.round(96 - i * 1.7)),
      source: 'website'
    }));
    const expansions = semanticExpand(seeds);

    res.json({
      ok: true,
      site: start.origin,
      pages_scanned: pages.length,
      pages,
      seeds,
      related: expansions,
      note: 'Website-derived intent only. Search volume, geographic concentration, CPC, trend velocity and competitor validation require external search-data providers.'
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'Unable to analyze site' });
  }
});

app.get('/api/health', (_, res) => res.json({ ok: true, service: 'dominance-market-radar', website_analyzer: true }));

const clientOverride = `
<script>
(function(){
  const esc = s => String(s || '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
  function setText(id, value){ const el=document.getElementById(id); if(el) el.textContent=value; }
  function renderLiveIntent(data){
    const wrap=document.getElementById('intents');
    if(!wrap) return;
    const seeds=(data.seeds||[]).slice(0,8);
    const related=(data.related||[]).slice(0,8);
    wrap.innerHTML = seeds.map(x=>'<span class="chip seed">'+esc(x.phrase)+'</span>').join('') + related.map(x=>'<span class="chip related">'+esc(x.phrase)+'</span>').join('');
    setText('seedN', (data.seeds||[]).length);
    setText('relN', (data.related||[]).length);
    setText('riseN', '—');
    setText('s1', (data.seeds||[]).length);
    setText('s2', (data.related||[]).length);
    setText('s3', '—');
  }
  window.analyze = async function(){
    const input=document.getElementById('website');
    const status=document.getElementById('siteStatus');
    const scan=document.getElementById('scantext');
    const url=input && input.value ? input.value.trim() : '';
    if(!url){ if(status) status.textContent='Enter a company website first.'; return; }
    if(status) status.textContent='Crawling website and building business intent graph…';
    if(scan) scan.textContent='Analyzing '+url+'…';
    try{
      const r=await fetch('/api/analyze-site',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
      const data=await r.json();
      if(!r.ok || !data.ok) throw new Error(data.error||'Website analysis failed');
      renderLiveIntent(data);
      if(status) status.textContent='Live analysis complete: '+data.pages_scanned+' pages scanned from '+data.site+'.';
      if(scan) scan.textContent='Live intent graph loaded for '+data.site+' • '+(data.seeds||[]).length+' seed phrases • '+(data.related||[]).length+' related phrases';
      window.__DOMINANCE_SITE_ANALYSIS__=data;
    }catch(err){
      if(status) status.textContent='Analysis failed: '+err.message;
      if(scan) scan.textContent='Website analysis failed — existing demo intent remains active.';
    }
  };
})();
</script>`;

function serveRadar(req, res) {
  try {
    const file = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.type('html').send(file.replace('</body>', clientOverride + '</body>'));
  } catch (err) {
    res.status(500).send('Unable to load Market Radar');
  }
}

app.get('/', serveRadar);
app.get('/index.html', serveRadar);
app.use(express.static(__dirname));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`DOMINANCE listening on ${PORT}`));
