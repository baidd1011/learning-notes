import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { checkExecution } from '../demo/benchmark-checks.mjs';
import { makeOrders, candidateOrders, reportFor } from '../demo/fixtures.mjs';
const base = new URL('../results/matrix/', import.meta.url);
export const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
assert.equal(manifest.runs.length,108);
assert.equal(new Set(manifest.runs.map(r=>r.id)).size,108);
assert.ok(manifest.completedAt);
const modes = ['direct','direct-batch','codemode','ptc'];
export const median = values => { const sorted=[...values].sort((a,b)=>a-b),n=sorted.length; return n ? n%2 ? sorted[(n-1)/2] : (sorted[n/2-1]+sorted[n/2])/2 : null; };
export const groups=[];
for(const count of manifest.orders) for(const toolCount of manifest.tools) for(const mode of modes) {
  const runs=manifest.runs.filter(r=>r.count===count && r.toolCount===toolCount && r.mode===mode);
  assert.equal(runs.length,3);
  assert.deepEqual(runs.map(r=>r.repeat).sort(),[1,2,3]);
  const valid=runs.filter(r=>r.passed);
  const fields=['modelRequests','inputTokens','outputTokens','cacheHitTokens','localWallMs','modelWallMs','mcpCalls','peakMcpConcurrency','rawMcpResultBytes','surfacedResultBytes'];
  const stats=Object.fromEntries(fields.map(f=>[f,{median:median(valid.map(r=>r.metrics[f]).filter(Number.isFinite)),min:valid.length?Math.min(...valid.map(r=>r.metrics[f])):null,max:valid.length?Math.max(...valid.map(r=>r.metrics[f])):null}]));
  groups.push({count,toolCount,mode,attempts:3,passed:valid.length,stats});
}
for(const entry of manifest.runs) {
  const compressed=await readFile(new URL(entry.file,base));
  assert.equal(createHash('sha256').update(compressed).digest('hex'),entry.sha256);
  const source=gunzipSync(compressed).toString('utf8');
  assert.ok(!/sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|[CD]:[\\/]+Users[\\/]/i.test(source));
  const record=JSON.parse(source),run=record.result;
  assert.equal(record.id,entry.id);
  assert.deepEqual(record.options,{count:entry.count,toolCount:entry.toolCount});
  assert.deepEqual(run.metrics,entry.metrics);
  assert.deepEqual(run.validation,entry.validation);
  if(!run.messages) { assert.equal(entry.passed,false); continue; }
  const orders=makeOrders(entry.count),candidates=candidateOrders(orders);
  const expected=reportFor(candidates.map(order=>({order,payment:{status:order.paymentStatus},shipment:{status:order.shipmentStatus,warehouse:order.warehouse}})));
  const fields=['orderId','customer','paidHoursAgo','amount','warehouse'];
  const facts=run.report?.matchedCount===expected.matchedCount && run.report?.top3?.length===expected.top3.length && run.report.top3.every((r,i)=>fields.every(f=>r[f]===expected.top3[i][f]));
  assert.equal(run.validation.factsCorrect,facts);
  const execution=checkExecution({...run,candidates});
  assert.deepEqual(run.validation.execution,execution);
  assert.equal(entry.passed,facts && execution.passed && (entry.mode!=='ptc'||run.validation.sdkLoaded));
  assert.equal(run.metrics.modelRequests,run.requests.length);
  for(const [metric,field] of [['inputTokens','prompt_tokens'],['outputTokens','completion_tokens'],['cacheHitTokens','prompt_cache_hit_tokens']]) {
    if(run.requests.every(r=>r.apiUsage)) assert.equal(run.metrics[metric],run.requests.reduce((s,r)=>s+(r.apiUsage[field]??0),0));
  }
  assert.equal(run.metrics.wireRequestBytes,run.requests.reduce((s,r)=>s+r.wireBytes,0));
  assert.equal(run.metrics.rawMcpResultBytes,run.calls.reduce((s,r)=>s+(r.rawResultBytes??0),0));
  if(entry.passed) {
    assert.equal(run.calls.length,1+2*candidates.length);
    assert.equal(run.metrics.initialMcpTools,['direct','direct-batch'].includes(entry.mode)?entry.toolCount:0);
    if(entry.mode==='direct') assert.equal(run.metrics.peakMcpConcurrency,1);
    if(entry.mode==='ptc') {
      assert.ok(run.metrics.peakMcpConcurrency<=8);
      assert.equal(run.requests[0].context.tools.length,1);
      assert.equal(run.requests[0].context.tools[0].name,'run_code');
      assert.equal(run.sessionEvents.filter(e=>e.type==='tool/ptc-dispatch').length,run.calls.length);
      assert.equal(run.metrics.initialSdkDeclarationBytes,Buffer.byteLength(run.sdkSections.map(s=>s.text).join('\n')));
    }
  }
}
const stored=JSON.parse(await readFile(new URL('summary.json',base),'utf8'));
assert.deepEqual(stored.groups,groups);
assert.equal(stored.passed,manifest.runs.filter(r=>r.passed).length);
const csv=await readFile(new URL('metrics.csv',base),'utf8');
const [header,...rows]=csv.trim().split('\n'),columns=header.split(',').slice(6);
assert.equal(rows.length,108);
for(const line of rows) {
  const values=line.split(','),entry=manifest.runs.find(r=>r.id===values[0]);
  assert.ok(entry);
  assert.equal(values[5],String(entry.passed));
  columns.forEach((f,i)=>assert.equal(values[i+6],String(entry.metrics[f]??'')));
}
const calibration=new URL('../results/calibration-v1/',import.meta.url);
const prior=JSON.parse(await readFile(new URL('manifest.json',calibration),'utf8'));
assert.equal(prior.runs.length,40);
assert.equal(prior.runs.filter(r=>!r.passed).length,4);
for(const entry of prior.runs) {
  const compressed=await readFile(new URL(entry.file,calibration));
  assert.equal(createHash('sha256').update(compressed).digest('hex'),entry.sha256);
  const source=gunzipSync(compressed).toString('utf8');
  assert.ok(!/sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|[CD]:[\\/]+Users[\\/]/i.test(source));
  const record=JSON.parse(source);
  assert.equal(record.id,entry.id);
  assert.deepEqual(record.result.metrics,entry.metrics);
  assert.deepEqual(record.result.validation,entry.validation);
  const execution=checkExecution({...record.result,candidates:candidateOrders(makeOrders(entry.count))});
  assert.deepEqual(execution,entry.validation.execution);
}
console.log(`PASS matrix: ${manifest.runs.length} preserved attempts, ${stored.passed} valid; raw usage, calls, facts, errors, group statistics and secret checks`);
console.log('PASS CSV and 40 calibration records, including 4 configuration failures');
