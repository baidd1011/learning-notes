import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runPtc } from './ptc.mjs';
import { checkExecution } from './benchmark-checks.mjs';
import { makeOrders, candidateOrders } from './fixtures.mjs';
for (const options of [{ count: 12, toolCount: 18, delayMs: 25 }, { count: 1, toolCount: 3, delayMs: 0 }]) {
  const run = await runPtc(options);
  assert.ok(run.validation.passed, JSON.stringify(run.validation));
  assert.equal(run.metrics.externalLlmRequests, 0);
  assert.equal(run.metrics.modelRequests, 2);
  assert.equal(run.requests[0].context.tools.length, 1);
  assert.equal(run.requests[0].context.tools[0].name, 'run_code');
  assert.ok(run.metrics.initialSdkDeclarationBytes > 0);
  assert.equal(run.sessionEvents.filter(e => e.type === 'tool/ptc-dispatch').length, run.calls.length);
  if (options.count === 12) {
    assert.equal(run.metrics.peakMcpConcurrency, 8);
    assert.equal(run.metrics.rawMcpResultBytes, 33403);
    const base = { mode: 'ptc', candidates: candidateOrders(makeOrders()), calls: run.calls, messages: run.messages };
    assert.equal(checkExecution({ ...base, calls: [...run.calls, run.calls[0]] }).passed, false);
    assert.equal(checkExecution({ ...base, messages: [...run.messages, { role: 'toolResult', content: [{ type: 'text', text: '模拟支付网关审计记录' }] }] }).passed, false);
  }
  console.log(`PTC official runtime smoke passed: ${options.count} orders / ${run.calls.length} calls (no online API)`);
}
let latest;
try { latest = JSON.parse(await readFile(new URL('./output/latest-run.json', import.meta.url))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (latest?.ptc && latest.options.count === 12) {
  assert.ok(latest.verified);
  for (const key of ['before', 'batch', 'after', 'ptc']) {
    assert.ok(latest[key].validation.passed);
    assert.equal(latest[key].metrics.mcpCalls, 9);
    assert.equal(latest[key].metrics.rawMcpResultBytes, 33403);
    assert.ok(latest[key].requests.every(r => r.apiUsage && r.responseId));
  }
  assert.equal(latest.ptc.metrics.modelRequests, 2);
  assert.equal(latest.ptc.metrics.initialSdkDeclarationBytes, Buffer.byteLength(latest.ptc.sdkSections.map(s => s.text).join('\n')));
  console.log('Saved four-path online trace passed audit');
}
