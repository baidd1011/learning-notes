import assert from 'node:assert/strict';
import { runComparison } from './engine.mjs';
import { checkExecution } from './benchmark-checks.mjs';
import { candidateOrders, makeOrders } from './fixtures.mjs';
const initialDeclarations = run => run.requests[0].context.messages.filter(m => m.role === 'system').flatMap(m => m.toolsAdded ?? []);
for (const options of [{ count: 12, toolCount: 18, delayMs: 0 }, { count: 1, toolCount: 3, delayMs: 0 }, { count: 48, toolCount: 60, delayMs: 0 }]) {
  const r = await runComparison(options);
  assert.ok(r.verified, JSON.stringify([r.before.validation, r.after.validation, r.batch.validation]));
  assert.deepEqual(r.before.report, r.after.report);
  assert.deepEqual(r.before.report, r.batch.report);
  assert.equal(initialDeclarations(r.before).filter(t => t.name.startsWith('mcp__')).length, options.toolCount);
  assert.deepEqual(initialDeclarations(r.after).map(t => t.name), ['codemode']);
  assert.equal(r.after.metrics.initialMcpSchemaBytes, 0);
  assert.ok(r.after.metrics.initialToolDeclarationBytes > 0);
  assert.equal(r.before.metrics.mcpCalls, r.after.metrics.mcpCalls);
  assert.equal(r.before.metrics.mcpCalls, r.batch.metrics.mcpCalls);
  for (const run of [r.before, r.after, r.batch]) {
    assert.equal(run.metrics.externalLlmRequests, 0);
    assert.ok(run.calls.every(c => !c.isError && Number.isFinite(c.endMs)));
  }
  assert.ok(r.after.calls.every(c => c.parentToolCallId));
  assert.ok(r.before.calls.every(c => !c.parentToolCallId));
  const finalModelContext = JSON.stringify(r.after.requests.at(-1).context);
  assert.ok(!finalModelContext.includes('DEMO-TXN-'));
  assert.ok(!finalModelContext.includes('模拟仓库扫描记录'));
  if (options.count > 1) {
    assert.ok(JSON.stringify(r.before.requests.at(-1).context).includes('DEMO-TXN-'));
    assert.ok(r.after.metrics.surfacedResultBytes < r.before.metrics.surfacedResultBytes);
    assert.ok(r.batch.metrics.peakMcpConcurrency > 1);
    assert.ok(r.after.metrics.peakMcpConcurrency > 1);
  }
  if (options.count === 12) {
    const candidates = candidateOrders(makeOrders(options.count));
    const valid = { ...r.after, candidates };
    assert.equal(checkExecution(valid).passed, true);
    assert.equal(checkExecution({ ...valid, calls: [...valid.calls, valid.calls[0]] }).noDuplicateOrUnneededCalls, false);
    assert.equal(checkExecution({ ...valid, calls: valid.calls.map((c, i) => i ? c : { ...c, isError: true }) }).noToolErrors, false);
    assert.equal(checkExecution({ ...valid, messages: [...valid.messages, { role: 'toolResult', content: [{ type: 'text', text: '模拟支付网关审计记录。DEMO-TXN-ORD-011' }] }] }).compactOutput, false);
    assert.equal(checkExecution({ ...valid, messages: [...valid.messages, { role: 'toolResult', content: [{ type: 'text', text: JSON.stringify({ orders: [{ orderId: 'ORD-011' }] }) }] }] }).compactOutput, false);
    assert.equal(checkExecution({ ...valid, messages: valid.messages.filter(m => m.role !== 'toolResult') }).discoveryComplete, false);
    console.log('PASS: execution validation rejects repeated calls, tool failures, raw status/order output, and missing discovery.');
  }
  console.log(`PASS: ${options.count} orders / ${options.toolCount} tools — reports agree, actual declarations and data boundary verified.`);
}
