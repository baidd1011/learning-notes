import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { pi, ai } from './pi-runtime.mjs';
import { candidateOrders, reportFor, makeOrders } from './fixtures.mjs';
import { createDeepSeekStream, loadDeepSeekConfig, publicConfig, safeError } from './deepseek.mjs';
import { parseReport } from './report-parser.mjs';
import { checkExecution } from './benchmark-checks.mjs';

const cwd = dirname(fileURLToPath(import.meta.url));
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
import { COMMON_PROMPT, USER_TASK } from './prompts.mjs';
export { USER_TASK } from './prompts.mjs';
export const DISCOVERY_CODE = `const found = await searchTools("List orders payment status shipment status", { namespace: "orders", limit: 3 });
for (const tool of found) text(await describeTool(tool.name));`;
export const ORCHESTRATION_CODE = `function unpack(result) {
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
const { orders } = unpack(await tools.mcp__orders__list_orders({}));
const candidates = orders.filter(o =>
  o.paidHoursAgo > 72 && o.paymentStatus === "paid" && o.shipmentStatus === "pending"
);
// All nested calls and their raw results stay inside the runtime.
const checked = await Promise.all(candidates.map(async order => {
  const [payment, shipment] = await Promise.all([
    tools.mcp__orders__get_payment({ orderId: order.orderId }),
    tools.mcp__orders__get_shipment({ orderId: order.orderId })
  ]);
  return { order, payment: unpack(payment), shipment: unpack(shipment) };
}));
const matched = checked.filter(x => x.payment.status === "paid" && x.shipment.status === "pending");
text({
  matchedCount: matched.length,
  top3: matched.sort((a, b) => b.order.paidHoursAgo - a.order.paidHoursAgo).slice(0, 3).map(x => ({
    orderId: x.order.orderId,
    customer: x.order.customer,
    paidHoursAgo: x.order.paidHoursAgo,
    amount: x.order.amount,
    warehouse: x.shipment.warehouse,
    suggestion: "优先联系" + x.shipment.warehouse + "核实备货，确认发货时间后向客户反馈。"
  }))
});`;

function parseResult(message) {
  if (message.isError) throw new Error(JSON.stringify(message.content));
  // Codemode places its status/timing header before its separate output blocks.
  for (const block of message.content.filter(x => x.type === 'text')) {
    try { return JSON.parse(block.text); } catch {}
    const start = block.text.indexOf('{');
    const end = block.text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(block.text.slice(start, end + 1)); } catch {}
    }
  }
  throw new Error('Missing JSON tool output');
}

export async function runMode(mode = 'direct', options = {}) {
  if (!['direct', 'direct-batch', 'codemode'].includes(mode)) throw new Error('Unknown mode');
  const count = options.count ?? 12;
  const toolCount = options.toolCount ?? 18;
  const delayMs = options.delayMs ?? 25;
  const online = options.inference === 'online';
  const onlineConfig = online ? options.testConfig ?? await loadDeepSeekConfig() : undefined;
  if (online && !onlineConfig.apiKey) throw new Error('请先在 .env.local 填写 DEEPSEEK_API_KEY。');
  if (!Number.isInteger(count) || count < 1 || count > 48) throw new Error('count must be 1..48');
  if (!Number.isInteger(toolCount) || toolCount < 3 || toolCount > 60) throw new Error('toolCount must be 3..60');
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 200) throw new Error('delayMs must be 0..200');
  const agentDir = join(cwd, '.runtime', mode);
  await mkdir(agentDir, { recursive: true });
  const requests = [], responses = [], calls = [];
  const pending = new Map();
  let active = 0, peak = 0;
  const start = performance.now();
  const settingsManager = pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, defaultTools: mode === 'codemode' ? ['codemode'] : [], cacheWarming: { enabled: false } });
  const streamReplay = (model, context) => {
    const stream = ai.createAssistantMessageEventStream();
    const snapshot = copy(context);
    requests.push({ round: requests.length + 1, context: snapshot, bytes: bytes(snapshot) });
    queueMicrotask(() => {
      try {
        if (requests.length > 105) throw new Error('Replay exceeded round limit');
        const results = context.messages.filter(m => m.role === 'toolResult');
        let content, report;
        const toolCall = (name, args) => ({ type: 'toolCall', id: `replay-${mode}-${requests.length}-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args });
        if (mode === 'codemode') {
          if (!results.length) content = [toolCall('codemode', { code: DISCOVERY_CODE })];
          else if (results.length === 1) {
            if (results[0].isError) throw new Error('Discovery failed');
            const text = JSON.stringify(results[0].content);
            for (const name of ['list_orders', 'get_payment', 'get_shipment']) if (!text.includes(`mcp__orders__${name}`)) throw new Error(`Tool discovery did not find ${name}`);
            content = [toolCall('codemode', { code: ORCHESTRATION_CODE })];
          } else { report = parseResult(results.at(-1)); }
        } else {
          const listing = results.find(r => r.toolName === 'mcp__orders__list_orders');
          if (!listing) content = [toolCall('mcp__orders__list_orders', {})];
          else {
            const candidates = candidateOrders(parseResult(listing).orders);
            const checked = [];
            const remaining = [];
            for (const order of candidates) {
              const p = results.find(r => r.toolName === 'mcp__orders__get_payment' && parseResult(r).orderId === order.orderId);
              const s = results.find(r => r.toolName === 'mcp__orders__get_shipment' && parseResult(r).orderId === order.orderId);
              if (!p) remaining.push(toolCall('mcp__orders__get_payment', { orderId: order.orderId }));
              if (!s) remaining.push(toolCall('mcp__orders__get_shipment', { orderId: order.orderId }));
              if (p && s) checked.push({ order, payment: parseResult(p), shipment: parseResult(s) });
            }
            if (remaining.length) content = mode === 'direct-batch' ? remaining : [remaining[0]];
            else report = reportFor(checked);
          }
        }
        if (report) content = [{ type: 'text', text: JSON.stringify(report) }];
        const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: report ? 'stop' : 'toolUse', timestamp: Date.now() };
        responses.push(copy(message));
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end(message);
      } catch (error) {
        const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'error', errorMessage: error.message, timestamp: Date.now() };
        stream.push({ type: 'error', reason: 'error', error: message }); stream.end(message);
      }
    });
    return stream;
  };
  // Isolated runtime: never loads ~/.pi credentials or personal MCP servers.
  const modelRuntime = await pi.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: join(agentDir, 'models-cache.json'), refreshOnCreate: false });
  const providerId = online ? 'demo-deepseek' : 'demo-replay';
  const modelId = online ? onlineConfig.model : 'fixed-decisions';
  modelRuntime.registerProvider(providerId, { name: online ? 'DeepSeek online' : 'Deterministic replay (no external LLM)', api: 'openai-completions', baseUrl: online ? onlineConfig.baseUrl : 'http://127.0.0.1:1/unused', apiKey: 'local-transport-placeholder',
    streamSimple: online ? createDeepSeekStream({ config: onlineConfig, requests, responses, fetchImpl: options.testFetch, onProgress: p => options.onProgress?.({ mode, ...p }) }) : streamReplay,
    models: [{ id: modelId, name: modelId, api: 'openai-completions', input: ['text'], reasoning: false, contextWindow: 1000000, maxTokens: 6000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const commonPrompt = COMMON_PROMPT;
  const modePrompt = options.discoveryOnly ? ` This is ONLY the interface discovery stage. Use exactly ONE codemode call. Inside it await ONE searchTools() call with a combined query describing all three required capabilities (list orders, payment status, shipment status), limit:3 and namespace:"orders". This catalog has three relevant interfaces. Return all three distinct names from that combined search result with text({selectedTools: names}); do not select just the first search hit and do not perform three separate searches. You may await describeTool() privately if needed. Print ONLY the selectedTools JSON object, no raw declarations or diagnostic details. Do NOT execute any business tool. The host will look up authoritative schemas, generate a PTC SDK deterministically and hand off execution. searchTools(query,{limit,namespace}) resolves to an array of {name,description}; await every discovery function. Generate your own code from this protocol and do not guess tool identifiers.`
    : mode === 'direct' ? ' Call exactly ONE tool per assistant turn; wait for the result before requesting another. Use direct tool calls only.'
    : mode === 'direct-batch' ? ' First get the order list; then request all independent payment and shipment checks in ONE assistant turn using multiple tool calls so the host can execute them in parallel.'
    : ` Use codemode in two stages. Stage 1 is discovery only: search for the three relevant tools, await their declarations, and print those declarations. Stage 2 is ONE business script: read the list once, filter using ALL THREE conditions, verify each candidate's two states in parallel with Promise.all, sort, and text() ONLY the compact final report. Once that report is returned, finish with the report; do not call tools again.
Runtime API contract: searchTools(), describeTool(), describeNamespace(), and tools.<name>() ALL return Promises. ALWAYS await them before accessing properties or printing; unawaited calls are cancelled when the script ends. text(), store(), load() are synchronous. searchTools resolves to an array of {name,description}; describeTool resolves to a string with input/output TypeScript declarations. For example, discovery syntax is: const hits = await searchTools("relevant topic", {limit: 3}); for (const hit of hits) text(await describeTool(hit.name)); Use a topic relevant to this task, not the literal example. Do not print ALL_TOOLS or describe an entire namespace.
MCP tools return CallToolResult<T>, NOT T. Check result.isError, then unwrap result.structuredContent ?? JSON.parse(result.content.find(block => block.type === "text").text). The list payload has .orders; the payment and shipment payloads have .status. Do not confuse those with fields on the wrapper. Read fields from the discovered output declarations. Generate your own business JavaScript. Do not print raw orders, status payloads, auditTrail, scanHistory, or debugging diagnostics. Keep them in local variables. Use a // @options: header with timeout_ms 30000.`;
  const exposure = mode === 'codemode' ? 'codemode' : 'direct';
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: online ? commonPrompt + modePrompt : 'You are an order follow-up assistant. Use only the synthetic order service. Return the checked order summary as JSON.',
    extensionFactories: [
      pi.createCodemodeExtension({ mode: 'only', models: false }),
      pi.createMcpExtension({ loadConfig: () => ({ servers: [{ name: 'orders', scope: 'extension', source: 'demo', config: { command: process.execPath, args: [join(cwd, 'mcp-server.mjs'), String(count), String(toolCount), String(delayMs)], exposure, description: 'Read-only demo orders, payments and shipments.' } }], errors: [] }), logPath: join(agentDir, 'mcp.log') }),
      api => {
        api.on('tool_call', event => {
          if (options.discoveryOnly && event.toolName.startsWith('mcp__orders__')) return { block:true, reason:'Discovery stage cannot execute business tools.' };
          if (online && event.toolName.startsWith('mcp__orders__') && calls.length >= 130) return { block: true, reason: '单条路径超过 130 次业务工具调用上限。' };
          if (!event.toolName.startsWith('mcp__orders__')) return;
          active++; peak = Math.max(peak, active);
          const call = { id: event.toolCallId, name: event.toolName, arguments: copy(event.input), parentToolCallId: event.parentToolCallId ?? null, startMs: Math.round(performance.now() - start) };
          calls.push(call); pending.set(event.toolCallId, call);
        });
        api.on('tool_result', event => {
          const call = pending.get(event.toolCallId);
          if (!call) return;
          active--; pending.delete(event.toolCallId);
          call.endMs = Math.round(performance.now() - start);
          call.result = copy(event.content); call.rawResultBytes = bytes(event.content); call.isError = event.isError ?? false;
        });
      },
    ] });
  await resourceLoader.reload();
  const errors = resourceLoader.getExtensions().errors;
  if (errors.length) throw new Error(JSON.stringify(errors));
  const { session } = await pi.createAgentSession({ cwd, agentDir, modelRuntime, model: modelRuntime.getModel(providerId, modelId), thinkingLevel: 'off', settingsManager, resourceLoader, noTools: 'builtin', sessionManager: pi.SessionManager.inMemory(cwd) });
  try {
    await session.bindExtensions({});
    // Batch baseline intentionally enables the agent's parallel tool executor.
    session.agent.toolExecution = mode === 'direct' || options.discoveryOnly ? 'sequential' : 'parallel';
    if (options.discoveryOnly) session.agent.subscribe(event => {
      if (event.type === 'tool_execution_end' && event.toolName === 'codemode') session.agent.abort();
    });
    await session.prompt(USER_TASK);
    if (options.discoveryOnly) {
      const messages=copy(session.messages);
      const results=messages.filter(m=>m.role==='toolResult');
      let rawSelectedTools=[];
      try { rawSelectedTools=parseResult(results.find(m=>m.toolName==='codemode')).selectedTools ?? []; } catch {}
      const selectedTools=Array.isArray(rawSelectedTools)?[...new Set(rawSelectedTools)]:[];
      const passed=requests.length===1 && calls.length===0 && results.length===1 && !results[0].isError && selectedTools.length===3 && selectedTools.every(n=>typeof n==='string');
      const usage=f=>requests.every(r=>r.apiUsage)?requests.reduce((s,r)=>s+(r.apiUsage[f]??0),0):null;
      return {mode:'discovery',rawSelectedTools,selectedTools,normalization:'deduplicate exact identifiers only; no tool added or removed by relevance',validation:{passed},requests,responses,messages,calls,metrics:{modelRequests:requests.length,inputTokens:usage('prompt_tokens'),outputTokens:usage('completion_tokens'),cacheHitTokens:usage('prompt_cache_hit_tokens'),localWallMs:Math.round(performance.now()-start),surfacedResultBytes:results.reduce((s,r)=>s+bytes(r.content),0)}};
    }
    const final = session.getLastAssistantText();
    let report = null, error = null;
    try {
      if (!final) throw new Error(session.messages.at(-1)?.errorMessage || '模型没有给出最终答案');
      report = parseReport(final);
    } catch (err) { if (!online) throw err; error = safeError(err, onlineConfig); }
    const expected = reportFor(candidateOrders(makeOrders(count)).map(order => ({ order, payment: { status: order.paymentStatus }, shipment: { status: order.shipmentStatus, warehouse: order.warehouse } })));
    const factFields = ['orderId', 'customer', 'paidHoursAgo', 'amount', 'warehouse'];
    const factsCorrect = report?.matchedCount === expected.matchedCount && Array.isArray(report.top3) && report.top3.length === expected.top3.length && report.top3.every((o, i) => factFields.every(field => o[field] === expected.top3[i][field]));
    const candidates = candidateOrders(makeOrders(count));
    const coverage = calls.some(c => c.name === 'mcp__orders__list_orders' && !c.isError) && candidates.every(o => ['get_payment', 'get_shipment'].every(t => calls.some(c => c.name === `mcp__orders__${t}` && c.arguments.orderId === o.orderId && !c.isError)));
    const execution = checkExecution({ mode, candidates, calls, messages: session.messages });
    const validation = { passed: factsCorrect && coverage && execution.passed, factsCorrect, toolCoverage: coverage, execution, expectedMatchedCount: expected.matchedCount, expectedTopOrderIds: expected.top3.map(o => o.orderId) };
    if (!online && JSON.stringify(report) !== JSON.stringify(expected)) throw new Error('Report differs from fixture truth');
    const messages = copy(session.messages);
    const toolResults = messages.filter(m => m.role === 'toolResult');
    const initialSystem = requests[0].context.messages.filter(m => m.role === 'system');
    const initialTools = initialSystem.flatMap(m => m.toolsAdded ?? []);
    const exposedMcp = initialTools.filter(t => t.name.startsWith('mcp__'));
    return {
      mode, inference: online ? 'online' : 'replay', report, finalText: final ?? '', error, validation, requests, responses, calls, messages,
      metrics: {
        modelRequests: requests.length, externalLlmRequests: online ? requests.length : 0,
        inputTokens: online ? requests.every(r => r.apiUsage) ? requests.reduce((sum, r) => sum + r.apiUsage.prompt_tokens, 0) : null : 0,
        outputTokens: online ? requests.every(r => r.apiUsage) ? requests.reduce((sum, r) => sum + r.apiUsage.completion_tokens, 0) : null : 0,
        cacheHitTokens: online ? requests.every(r => r.apiUsage) ? requests.reduce((sum, r) => sum + (r.apiUsage.prompt_cache_hit_tokens ?? r.apiUsage.prompt_tokens_details?.cached_tokens ?? 0), 0) : null : 0,
        modelWallMs: requests.reduce((sum, r) => sum + (r.modelWallMs ?? 0), 0),
        wireRequestBytes: online ? requests.reduce((sum, r) => sum + (r.wireBytes ?? 0), 0) : null,
        initialMcpTools: exposedMcp.length, initialMcpSchemaBytes: exposedMcp.length ? bytes(exposedMcp) : 0,
        initialToolDeclarationBytes: bytes(initialTools), initialSystemPromptBytes: bytes(initialSystem.map(m => ({ content: m.content, sections: m.sections }))),
        surfacedResultBytes: toolResults.reduce((sum, m) => sum + bytes(m.content), 0),
        accumulatedRequestBytes: requests.reduce((sum, r) => sum + r.bytes, 0),
        mcpCalls: calls.length, rawMcpResultBytes: calls.reduce((sum, c) => sum + (c.rawResultBytes ?? 0), 0),
        peakMcpConcurrency: peak, localWallMs: Math.round(performance.now() - start),
      },
    };
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
    session.dispose();
  }
}

export async function runComparison(options = {}) {
  // Sequential runs avoid cross-run interference and make each trace easy to inspect.
  const before = await runMode('direct', options);
  const after = await runMode('codemode', options);
  const batch = await runMode('direct-batch', options);
  const ptc = options.inference === 'online' ? await (await import('./ptc.mjs')).runPtc(options) : null;
  if (options.inference !== 'online' && (JSON.stringify(before.report) !== JSON.stringify(after.report) || JSON.stringify(before.report) !== JSON.stringify(batch.report))) throw new Error('Modes produced different reports');
  const config = options.inference === 'online' ? publicConfig(options.testConfig ?? await loadDeepSeekConfig()) : null;
  return { generatedAt: new Date().toISOString(), benchmarkRevision: ptc ? 'official-harness-ptc-four-paths-v3' : 'documented-api-and-equal-calls-v2', runtime: ptc ? 'Pi SDK 1.0.0 / QuickJS-WASM + DeepSeek Harness 0.2.0-rc.2 / Node PTC' : 'Pi SDK 1.0.0 / built-in MCP / QuickJS-WASM', inference: options.inference === 'online' ? 'online' : 'replay', model: config?.model ?? 'deterministic replay; no external LLM', provider: config, verified: [before, after, batch, ...(ptc ? [ptc] : [])].every(r => r.validation.passed), options: { count: options.count ?? 12, toolCount: options.toolCount ?? 18, delayMs: options.delayMs ?? 25 }, task: USER_TASK, before, after, batch, ...(ptc ? { ptc } : {}) };
}
