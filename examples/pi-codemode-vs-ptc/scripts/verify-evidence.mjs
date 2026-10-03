import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { checkExecution } from '../demo/benchmark-checks.mjs';
import { makeOrders, candidateOrders, reportFor } from '../demo/fixtures.mjs';
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('results/online-2026-10-02.json', root), 'utf8');
const record = JSON.parse(source);
const summary = JSON.parse(await readFile(new URL('results/summary.json', root), 'utf8'));
const candidates = candidateOrders(makeOrders(record.options.count));
const expected = reportFor(candidates.map(order => ({ order, payment: { status: order.paymentStatus }, shipment: { status: order.shipmentStatus, warehouse: order.warehouse } })));
const keys = ['before', 'batch', 'after', 'ptc'];
assert.equal(record.verified, true);
assert.equal(record.inference, 'online');
assert.equal(record.model, 'deepseek-flash');
assert.deepEqual(record.options, { count: 12, toolCount: 18, delayMs: 25 });
for (const key of keys) {
  const run = record[key], metrics = run.metrics;
  assert.equal(run.validation.passed, true);
  assert.equal(checkExecution({ ...run, candidates }).passed, true);
  assert.equal(metrics.mcpCalls, 9);
  assert.equal(metrics.rawMcpResultBytes, 33403);
  assert.equal(metrics.inputTokens, run.requests.reduce((sum, r) => sum + r.apiUsage.prompt_tokens, 0));
  assert.equal(metrics.outputTokens, run.requests.reduce((sum, r) => sum + r.apiUsage.completion_tokens, 0));
  assert.equal(metrics.cacheHitTokens, run.requests.reduce((sum, r) => sum + r.apiUsage.prompt_cache_hit_tokens, 0));
  assert.equal(metrics.wireRequestBytes, run.requests.reduce((sum, r) => sum + r.wireBytes, 0));
  assert.equal(metrics.rawMcpResultBytes, run.calls.reduce((sum, c) => sum + c.rawResultBytes, 0));
  assert.equal(metrics.modelRequests, run.requests.length);
  assert.ok(run.requests.every(r => r.responseId && r.responseModel));
  assert.equal(run.report.matchedCount, expected.matchedCount);
  for (const [index, row] of run.report.top3.entries()) for (const field of ['orderId', 'customer', 'paidHoursAgo', 'amount', 'warehouse']) assert.equal(row[field], expected.top3[index][field]);
  assert.deepEqual(summary.paths[key].metrics, metrics);
  assert.deepEqual(summary.paths[key].validation, run.validation);
  assert.deepEqual(summary.paths[key].report, run.report);
  console.log(`PASS ${key}: usage totals, exact 9 calls, fixture facts, execution and summary`);
}
assert.equal(record.ptc.metrics.initialSdkDeclarationBytes, Buffer.byteLength(record.ptc.sdkSections.map(s => s.text).join('\n')));
assert.equal(record.ptc.requests[0].context.tools.length, 1);
assert.equal(record.ptc.requests[0].context.tools[0].name, 'run_code');
assert.equal(record.ptc.sessionEvents.filter(e => e.type === 'tool/ptc-dispatch').length, 9);
const csv = await readFile(new URL('results/metrics.csv', root), 'utf8');
const [header, ...lines] = csv.trim().split('\n');
const fields = header.split(',').slice(1);
assert.equal(lines.length, 4);
for (const line of lines) { const [key, ...values] = line.split(','); fields.forEach((f, i) => assert.equal(values[i], String(record[key].metrics[f] ?? ''))); }
const markdown = await readFile(new URL('README.md', root), 'utf8');
assert.ok(markdown.includes('QuickJS') && markdown.includes('run_code') && markdown.includes('results/matrix/'));
assert.ok(!/C:[\\/]+Users[\\/]/i.test(source));
assert.ok(!/sk-[A-Za-z0-9_-]{16,}/.test(source));
assert.ok(!/gh[pousr]_[A-Za-z0-9]{20,}/.test(source));
for (const folder of ['', 'demo/', 'results/', 'assets/', 'scripts/']) {
  const names = await readdir(new URL(folder, root));
  assert.ok(!names.includes('.env.local'));
}
console.log('PASS public SDK, Harness nested events, CSV, article values and credential/path checks');
console.log('Captured byte metrics remain original; published request text replaces local absolute paths.');
