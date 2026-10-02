import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createCodingFixture,snapshot,digestFiles,evaluateCoding} from './coding-fixture.mjs';
import {runCodingPi} from './coding-pi.mjs';
import {runCodingPtc} from './coding-ptc.mjs';
import {runCodingHybrid} from './coding-hybrid.mjs';
import {loadDeepSeekConfig,publicConfig,safeError} from './deepseek.mjs';
const config=await loadDeepSeekConfig();if(!config.apiKey)throw Error('Missing API key');
const root=fileURLToPath(new URL('./',import.meta.url)).replace(/[\\/]$/,'');
const output=new URL('./output/coding-v1/',import.meta.url);await mkdir(output,{recursive:true});
const manifestUrl=new URL('manifest.json',output);let m;
try{m=JSON.parse(await readFile(manifestUrl,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
m??={revision:'coding-v1',startedAt:new Date().toISOString(),provider:publicConfig(config),moduleCounts:[3,8,16],paths:['codemode','ptc','hybrid'],repetitions:3,toolCount:5,maxConcurrency:8,maxModelRequests:24,maxToolCalls:300,runtime:{pi:'1.0.0',harness:'0.2.0-rc.2',typescript:'5.9.3',node:process.version},policy:'No prescribed model rounds or fixed generated code. Fresh fixture per task. Rotate path order, reverse workload order on repetition 2. Retain failures without automatic rerun.',runs:[]};
m.priorAttempts??=[];
const files=['coding-fixture.mjs','coding-mcp-server.mjs','coding-pi.mjs','coding-ptc.mjs','coding-hybrid.mjs','coding-matrix.mjs'];
const hashes=Object.fromEntries(await Promise.all(files.map(async p=>[p,createHash('sha256').update(await readFile(new URL(p,import.meta.url))).digest('hex')])));
function sanitize(value){if(typeof value==='string'){if(value.includes(config.apiKey))throw Error('Credential in output');for(const p of [root,root.replaceAll('\\','/')])value=value.split(p).join('<demo-root>');return value;}if(Array.isArray(value))return value.map(sanitize);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v)]));return value;}
for(let repeat=1;repeat<=3;repeat++)for(const count of repeat===2?[...m.moduleCounts].reverse():m.moduleCounts){
 const offset=(m.moduleCounts.indexOf(count)+repeat-1)%3;
 for(let j=0;j<3;j++){
  const mode=m.paths[(offset+j)%3],id=`modules${count}-r${repeat}-${mode}`;const previous=m.runs.find(r=>r.id===id);if(previous && (previous.passed || previous.error!=='Invalid discovery selection'))continue;
  console.log(JSON.stringify({event:'start',id,completed:m.runs.length,total:27}));
  const projectRoot=fileURLToPath(new URL(`./.runtime/coding-workspaces/${id}-${randomUUID()}/`,import.meta.url));
  const before=await createCodingFixture(projectRoot,count);const opts={count,toolCount:5,inference:'online',projectRoot,testConfig:config};
  let result;const start=performance.now();
  try{result=mode==='codemode'?await runCodingPi(opts):mode==='ptc'?await runCodingPtc(opts):await runCodingHybrid(opts);}catch(e){result={mode,error:safeError(e,config),validation:{passed:false},requests:[],calls:[],metrics:{localWallMs:Math.round(performance.now()-start)}};}
  const after=await snapshot(projectRoot),independent=await evaluateCoding(projectRoot,count);
  const protectedIntact=['src/client.ts','README.md','package.json','tsconfig.json'].every(p=>before[p]===after[p]);
  const hasObservedPass=result.calls.some(c=>c.name==='mcp__coding__run_tests'&&!c.isError&&c.result?.some(b=>{try{return JSON.parse(b.text).passed===true;}catch{return false;}}));
  result.validation={...result.validation,independent,protectedIntact,hasObservedPass,passed:result.validation.passed&&independent.passed&&protectedIntact&&hasObservedPass};
  const record={id,count,repeat,mode,revision:'coding-v3-host-normalization',sourceHashes:hashes,capturedAt:new Date().toISOString(),initialDigest:digestFiles(before),finalDigest:digestFiles(after),before,after,result,publication:{pathRedacted:true,bytes:'original capture'}};
  const attempt=1+m.priorAttempts.filter(r=>r.id===id).length+(previous?1:0);
  const file=`${id}${attempt>1?'-a'+attempt:''}.json.gz`,compressed=gzipSync(JSON.stringify(sanitize(record)));await writeFile(new URL(file,output),compressed);
  if(previous){m.priorAttempts.push(previous);m.runs=m.runs.filter(r=>r.id!==id);}
  m.runs.push({revision:'coding-v3-host-normalization',id,count,repeat,mode,file,sha256:createHash('sha256').update(compressed).digest('hex'),passed:result.validation.passed,metrics:result.metrics,initialDigest:record.initialDigest,finalDigest:record.finalDigest,sourceHashes:hashes,error:result.error,validation:result.validation});
  m.updatedAt=new Date().toISOString();await writeFile(manifestUrl,JSON.stringify(m,null,2));
  console.log(JSON.stringify({event:'done',id,passed:result.validation.passed,requests:result.metrics.modelRequests,input:result.metrics.inputTokens,wallMs:result.metrics.localWallMs,error:result.error}));
 }
}
m.completedAt=new Date().toISOString();await writeFile(manifestUrl,JSON.stringify(m,null,2));console.log(JSON.stringify({event:'complete',tasks:m.runs.length,passed:m.runs.filter(r=>r.passed).length}));
