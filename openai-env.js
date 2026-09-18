const fs=require('fs');

function exactRaw(){
 return Object.prototype.hasOwnProperty.call(process.env,'OPENAI_API_KEY')?String(process.env.OPENAI_API_KEY??''):null;
}

function readOpenAIKey(){
 const direct=exactRaw();
 if(direct!==null&&direct.trim())return direct.trim();
 const file=String(process.env.OPENAI_API_KEY_FILE||'').trim();
 if(file){
  try{
   const v=fs.readFileSync(file,'utf8').trim();
   if(v)return v;
  }catch{}
 }
 return '';
}

function diagnostic(){
 const raw=exactRaw();
 const related=Object.keys(process.env).filter(k=>/OPENAI|OPEN_AI/i.test(k)).sort();
 const key=readOpenAIKey();
 return{
  configured:!!key,
  exact_name_present:raw!==null,
  exact_name_nonempty:raw!==null&&!!raw.trim(),
  exact_value_chars:raw===null?0:raw.length,
  file_var_present:!!String(process.env.OPENAI_API_KEY_FILE||'').trim(),
  related_names:related,
  service:process.env.RENDER_SERVICE_NAME||process.env.RENDER_SERVICE_ID||'unknown'
 };
}

module.exports={readOpenAIKey,diagnostic};
