// Validate execution independently of the model's final business answer.
export function checkExecution({ mode, candidates, calls, messages }) {
  const expected = new Set(['mcp__orders__list_orders:{}']);
  for (const order of candidates) for (const tool of ['get_payment', 'get_shipment']) expected.add(`mcp__orders__${tool}:${JSON.stringify({ orderId: order.orderId })}`);
  const actual = calls.map(c => `${c.name}:${JSON.stringify(c.arguments)}`);
  const noDuplicateOrUnneededCalls = actual.length === expected.size && new Set(actual).size === expected.size && actual.every(key => expected.has(key));
  const results = messages.filter(m => m.role === 'toolResult');
  const noToolErrors = calls.every(c => !c.isError && Number.isFinite(c.endMs)) && results.every(r => !r.isError);
  const parentIds = new Set(calls.map(c => c.parentToolCallId));
  const programmatic = ['codemode', 'ptc'].includes(mode);
  const oneBusinessScript = !programmatic || parentIds.size === 1 && !parentIds.has(null) && !parentIds.has(undefined);
  const modelVisible = results.map(r => JSON.stringify(r.content)).join('\n');
  const compactOutput = !programmatic || !['DEMO-TXN-', '模拟支付网关审计记录', '模拟仓库扫描记录', '仓库同步成功；支付流水已归档'].some(marker => modelVisible.includes(marker)) && !/\\?"orders\\?"\s*:/.test(modelVisible);
  const discoveryComplete = mode !== 'codemode' || ['list_orders', 'get_payment', 'get_shipment'].every(name => modelVisible.includes(`mcp__orders__${name}`)) && modelVisible.includes('paidHoursAgo');
  return { passed: noDuplicateOrUnneededCalls && noToolErrors && oneBusinessScript && compactOutput && discoveryComplete, noDuplicateOrUnneededCalls, noToolErrors, oneBusinessScript, compactOutput, discoveryComplete, expectedMcpCalls: expected.size, actualMcpCalls: calls.length };
}
