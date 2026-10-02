import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {checkExecution} from '../demo/benchmark-checks.mjs';
import {makeOrders,candidateOrders,reportFor} from '../demo/fixtures.mjs';
const base=new URL('../results/hybrid/',import.meta.url);
const m=JSON.parse(await readFile(new URL('manifest.json',base),'utf8'));
assert.equal(m.runs.length,81);assert.equal(new Set(m.runs.map(r=>r.id)).size,81);
for(const o of m.orders)for(const t of m.tools)for(const mode of m.paths){
 const rows=m.runs.filter(r=>r.count===o&&r.toolCount===t&&r.mode===mode);
 assert.deepEqual(rows.map(r=>r.repeat).sort(),[1,2,3]);
}
for(const entry of [...m.runs,...m.priorAttempts]){
 const raw=await readFile(new URL(entry.file,base));
 assert.equal(createHash('sha256').update(raw).digest('hex'),entry.sha256);
 const record=JSON.parse(gunzipSync(raw));const r=record.result;
 assert.equal(record.id,entry.id);assert.deepEqual(r.metrics,entry.metrics);
 assert.equal(r.validation.passed,entry.passed);
 if(!entry.passed)continue;
 const execution=r.mode==='hybrid'?r.execution:r;
 const candidates=candidateOrders(makeOrders(entry.count));
 const expected=reportFor(candidates.map(order=>({order,payment:{status:order.paymentStatus},shipment:{status:order.shipmentStatus,warehouse:order.warehouse}})));
 assert.equal(r.report.matchedCount,expected.matchedCount);
 assert.equal(r.report.top3.length,expected.top3.length);
 r.report.top3.forEach((row,i)=>{for(const f of ['orderId','customer','paidHoursAgo','amount','warehouse'])assert.equal(row[f],expected.top3[i][f]);});
 assert.deepEqual(checkExecution({...execution,candidates}),execution.validation.execution);
 assert.ok(execution.validation.execution.passed);
 assert.equal(r.metrics.modelRequests,r.requests.length);
 for(const [f,k]of [['inputTokens','prompt_tokens'],['outputTokens','completion_tokens'],['cacheHitTokens','prompt_cache_hit_tokens']])assert.equal(r.metrics[f],r.requests.reduce((s,q)=>s+(q.apiUsage[k]??0),0));
 assert.equal(r.metrics.wireRequestBytes,r.requests.reduce((s,q)=>s+q.wireBytes,0));
 assert.equal(r.metrics.rawMcpResultBytes,r.calls.reduce((s,c)=>s+c.rawResultBytes,0));
 if(r.mode==='hybrid'){
  assert.equal(r.discovery.requests.length,1);assert.equal(r.discovery.calls.length,0);
  assert.deepEqual([...r.selectedTools].sort(),['mcp__orders__get_payment','mcp__orders__get_shipment','mcp__orders__list_orders']);
  assert.deepEqual(r.requests[0].wirePayload.tools.map(t=>t.function.name),['codemode']);
  assert.equal(r.execution.metrics.initialSdkDeclarationBytes,3504);
  for(const q of r.requests.slice(1)){
   assert.deepEqual(q.wirePayload.tools.map(t=>t.function.name),['run_code']);
   for(const msg of r.handoffMessages)assert.ok(q.wirePayload.messages.some(actual=>JSON.stringify(actual)===JSON.stringify(msg)));
  }
  assert.equal(r.execution.sessionEvents.filter(e=>e.type==='tool/ptc-dispatch').length,r.calls.length);
  assert.ok(r.metrics.peakMcpConcurrency<=8);
 }
}
assert.ok(m.runs.every(r=>r.passed));
assert.equal(new Set([...m.runs,...m.priorAttempts].map(r=>r.file)).size,81+m.priorAttempts.length);
const paused=JSON.parse(await readFile(new URL('manifest-paused-v1.json',base),'utf8'));
const retained=paused.runs.filter(r=>r.passed);
assert.equal(retained.length,38);
for(const old of retained){
 const current=m.runs.find(r=>r.id===old.id);
 assert.equal(current.file,old.file);assert.deepEqual(current.metrics,old.metrics);
 assert.deepEqual(current.validation,old.validation);
}
const summary=JSON.parse(await readFile(new URL('summary.json',base),'utf8'));
for(const g of summary.groups){
 const rows=m.runs.filter(r=>r.count===g.count&&r.toolCount===g.toolCount&&r.mode===g.mode);
 for(const [field,value]of Object.entries(g.medians))assert.equal(value,rows.map(r=>r.metrics[field]).sort((a,b)=>a-b)[1]);
}
const csv=(await readFile(new URL('metrics.csv',base),'utf8')).trim().split('\n');
const columns=csv.shift().split(',').slice(6);assert.equal(csv.length,81);
for(const line of csv){const values=line.split(','),r=m.runs.find(r=>r.id===values[0]);assert.ok(r);columns.forEach((field,i)=>assert.equal(values[6+i],String(r.metrics[field]??'')));}
console.log(JSON.stringify({tasks:m.runs.length,passed:81,retainedPriorAttempts:m.priorAttempts.length,validation:'facts, calls, compact output, actual wire handoff, selected SDK, API usage and SHA256 passed'}));
