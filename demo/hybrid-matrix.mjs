import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {runHybrid} from './hybrid.mjs';
import {runMode} from './engine.mjs';
import {runPtc} from './ptc.mjs';
import {loadDeepSeekConfig,publicConfig,safeError} from './deepseek.mjs';
const config=await loadDeepSeekConfig();
if(!config.apiKey) throw new Error('Missing local API key');
const root=fileURLToPath(new URL('./',import.meta.url)).replace(/[\\/]$/,'');
const output=new URL('./output/hybrid-matrix/',import.meta.url);
await mkdir(output,{recursive:true});
const file=new URL('manifest.json',output);
let manifest;
try {manifest=JSON.parse(await readFile(file,'utf8'));} catch(e){if(e.code!=='ENOENT')throw e;}
manifest??={revision:'hybrid-v1',startedAt:new Date().toISOString(),provider:publicConfig(config),orders:[1,12,48],tools:[3,18,60],repetitions:3,delayMs:25,paths:['codemode','ptc','hybrid'],runtime:{pi:'1.0.0',harness:'0.2.0-rc.2',node:process.version,ptcPendingLimit:64,ptcConcurrency:8},orderPolicy:'fresh paired runs; sequential rotating paths; reverse cells on second repetition',runs:[]};
function sanitize(value){
 if(typeof value==='string'){if(value.includes(config.apiKey))throw new Error('Credential in captured output');for(const p of [root,root.replaceAll('\\','/'),root.replaceAll('/','\\')])value=value.split(p).join('<demo-root>');return value;}
 if(Array.isArray(value))return value.map(sanitize);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v)]));
 return value;
}
const sourceHashes=Object.fromEntries(await Promise.all(['engine.mjs','ptc.mjs','hybrid.mjs','hybrid-matrix.mjs'].map(async name=>[name,createHash('sha256').update(await readFile(new URL(name,import.meta.url))).digest('hex')])));
manifest.priorAttempts??=[];
const cells=manifest.orders.flatMap(count=>manifest.tools.map(toolCount=>({count,toolCount})));
for(let repeat=0;repeat<3;repeat++)for(const cell of repeat%2?[...cells].reverse():cells){
 const offset=(cells.findIndex(c=>c.count===cell.count&&c.toolCount===cell.toolCount)+repeat)%3;
 for(let i=0;i<3;i++){
  const mode=manifest.paths[(offset+i)%3],id=`o${cell.count}-t${cell.toolCount}-r${repeat+1}-${mode}`;
  const previous=manifest.runs.find(r=>r.id===id);
  if(previous?.passed)continue;
  console.log(JSON.stringify({event:'start',id,completed:manifest.runs.length,total:81}));
  let result;const start=performance.now();
  try{const opts={...cell,delayMs:25,inference:'online',testConfig:config};result=mode==='hybrid'?await runHybrid(opts):mode==='ptc'?await runPtc(opts):await runMode('codemode',opts);}
  catch(e){result={mode,error:safeError(e,config),validation:{passed:false},metrics:{localWallMs:Math.round(performance.now()-start)},calls:[],requests:[]};}
  const attempt=1+manifest.priorAttempts.filter(r=>r.id===id).length+(previous?1:0);
  const trace=`${id}${attempt>1?"-a"+attempt:""}.json.gz`;
  await writeFile(new URL(trace,output),gzipSync(JSON.stringify(sanitize({id,options:cell,repeat:repeat+1,capturedAt:new Date().toISOString(),revision:'hybrid-discovery-v3',sourceHashes,publication:{pathRedacted:true,bytes:'original capture'},result}))));
  if(previous){manifest.priorAttempts.push(previous);manifest.runs=manifest.runs.filter(r=>r.id!==id);}
  manifest.runs.push({revision:'hybrid-discovery-v3',sourceHashes,id,...cell,repeat:repeat+1,mode,file:trace,passed:result.validation.passed,error:result.error,validation:result.validation,metrics:result.metrics});
  manifest.updatedAt=new Date().toISOString();await writeFile(file,JSON.stringify(manifest,null,2));
  console.log(JSON.stringify({event:'done',id,passed:result.validation.passed,input:result.metrics.inputTokens,requests:result.metrics.modelRequests,wallMs:result.metrics.localWallMs}));
 }
}
manifest.completedAt=new Date().toISOString();await writeFile(file,JSON.stringify(manifest,null,2));
console.log(JSON.stringify({event:'complete',total:manifest.runs.length,passed:manifest.runs.filter(r=>r.passed).length}));
