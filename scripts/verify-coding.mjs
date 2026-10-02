import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createCodingFixture,snapshot,digestFiles,evaluateCoding,codingCatalog} from '../demo/coding-fixture.mjs';
const base=new URL('../results/coding/',import.meta.url);
const m=JSON.parse(await readFile(new URL('manifest.json',base),'utf8'));
assert.equal(m.runs.length,27);assert.equal(new Set(m.runs.map(r=>r.id)).size,27);
for(const count of m.moduleCounts)for(const mode of m.paths)assert.deepEqual(m.runs.filter(r=>r.count===count&&r.mode===mode).map(r=>r.repeat).sort(),[1,2,3]);
const tmp=fileURLToPath(new URL('../demo/.runtime/coding-evidence-check/',import.meta.url));await mkdir(tmp,{recursive:true});
const initial=new Map();
for(const count of m.moduleCounts){const root=await mkdtemp(join(tmp,'initial-'));await createCodingFixture(root,count);initial.set(count,await snapshot(root));}
let valid=0;
for(const entry of [...m.runs,...m.priorAttempts]){
 const compressed=await readFile(new URL(entry.file,base));assert.equal(createHash('sha256').update(compressed).digest('hex'),entry.sha256);
 const record=JSON.parse(gunzipSync(compressed)),r=record.result;
 assert.equal(record.id,entry.id);assert.deepEqual(r.metrics,entry.metrics);assert.deepEqual(r.validation,entry.validation);
 assert.deepEqual(record.before,initial.get(entry.count));assert.equal(digestFiles(record.before),entry.initialDigest);assert.equal(digestFiles(record.after),entry.finalDigest);
 const replay=structuredClone(record.before);
 for(const c of r.calls??[]){
  assert.ok(c.name.startsWith('mcp__coding__'));assert.ok(codingCatalog.some(t=>'mcp__coding__'+t.name===c.name));
  if(c.name==='mcp__coding__replace_text'&&!c.isError){const {path,oldText,newText}=c.arguments;assert.match(path,/^src\/modules\/module\d+\.ts$/);assert.ok(oldText);assert.ok(replay[path].includes(oldText));replay[path]=replay[path].split(oldText).join(newText);}
 }
 assert.deepEqual(replay,record.after);
 const protectedIntact=['src/client.ts','README.md','package.json','tsconfig.json'].every(p=>record.before[p]===record.after[p]);assert.equal(protectedIntact,r.validation.protectedIntact);
 const observed=r.calls?.some(c=>c.name==='mcp__coding__run_tests'&&!c.isError&&c.result?.some(b=>{try{return JSON.parse(b.text).passed===true;}catch{return false;}}))??false;
 assert.equal(observed,r.validation.hasObservedPass);
 assert.equal(r.metrics.modelRequests,r.requests.length);
 if(r.requests.every(q=>q.apiUsage))for(const [field,key]of [['inputTokens','prompt_tokens'],['outputTokens','completion_tokens'],['cacheHitTokens','prompt_cache_hit_tokens']])assert.equal(r.metrics[field],r.requests.reduce((s,q)=>s+(q.apiUsage[key]??0),0));
 if(r.metrics.wireRequestBytes!==undefined)assert.equal(r.metrics.wireRequestBytes,r.requests.reduce((s,q)=>s+(q.wireBytes??0),0));
 if(r.execution){
  assert.equal(r.discovery.requests.length,1);assert.equal(r.discovery.calls.length,0);
  assert.deepEqual([...r.selectedTools].sort(),codingCatalog.map(t=>'mcp__coding__'+t.name).sort());
  assert.deepEqual(r.requests[0].wirePayload.tools.map(t=>t.function.name),['codemode']);
  for(const q of r.requests.slice(1)){assert.deepEqual(q.wirePayload.tools.map(t=>t.function.name),['run_code']);for(const msg of r.handoffMessages)assert.ok(q.wirePayload.messages.some(m=>JSON.stringify(m)===JSON.stringify(msg)));}
 }
 if(m.priorAttempts.some(p=>p.file===entry.file)){assert.equal(entry.passed,false);continue;}
 const root=await mkdtemp(join(tmp,'final-'));await createCodingFixture(root,entry.count);
 for(const [p,s]of Object.entries(record.after))await writeFile(join(root,p),s);
 const judged=await evaluateCoding(root,entry.count);
 assert.equal(judged.passed,r.validation.independent.passed);assert.deepEqual(judged.oldApiPaths,r.validation.independent.oldApiPaths);
 assert.equal(judged.behavior.passedTests,r.validation.independent.behavior.passedTests);
 assert.equal(entry.passed,judged.passed&&protectedIntact&&observed&&r.requests.length>0&&r.requests.every(q=>q.apiUsage));
 if(entry.passed)valid++;
}
const median=a=>{const s=a.filter(Number.isFinite).sort((a,b)=>a-b),n=s.length;return n?n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2:null;};
const summary=JSON.parse(await readFile(new URL('summary.json',base),'utf8'));
assert.equal(summary.passed,valid);
for(const g of summary.groups){const rows=m.runs.filter(r=>r.count===g.count&&r.mode===g.mode);assert.equal(g.passed,rows.filter(r=>r.passed).length);for(const [f,v]of Object.entries(g.medians))assert.equal(v,median(rows.map(r=>r.metrics[f])));}
const csv=(await readFile(new URL('metrics.csv',base),'utf8')).trim().split('\n'),columns=csv.shift().split(',').slice(5);assert.equal(csv.length,27);
for(const line of csv){const v=line.split(','),r=m.runs.find(r=>r.id===v[0]);assert.ok(r);assert.equal(v[4],String(r.passed));columns.forEach((f,i)=>assert.equal(v[i+5],String(r.metrics[f]??'')));}
console.log(JSON.stringify({tasks:27,passed:valid,retainedCalibration:m.priorAttempts.length,validation:'source patch replay, fresh TypeScript builds and behavior tests, protected files, equal initial snapshots, API usage, SDK handoff, medians and SHA256 passed'}));
