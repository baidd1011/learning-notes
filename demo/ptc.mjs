import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { COMMON_PROMPT, USER_TASK } from './prompts.mjs';
import { candidateOrders, makeOrders, reportFor } from './fixtures.mjs';
import { loadDeepSeekConfig, safeError } from './deepseek.mjs';
import { parseReport } from './report-parser.mjs';
import { checkExecution } from './benchmark-checks.mjs';

const bytes = x => Buffer.byteLength(typeof x === 'string' ? x : JSON.stringify(x));
const copy = x => JSON.parse(JSON.stringify(x));
const base = new URL('./.runtime/dsh-deps/node_modules/@deepseek-ai/', import.meta.url);
const pkg = name => import(new URL(`${name}/lib/index.js`, base));
const workspace = fileURLToPath(new URL('./.runtime/ptc-workspace/', import.meta.url));
export const PTC_VERSION = '0.2.0-rc.2';
function dshSchema(schema) {
  if (Array.isArray(schema)) return schema.map(dshSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const result = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, dshSchema(value)]));
  // Harness accepts oneOf but not JSON Schema type arrays; preserve nullability.
  if (Array.isArray(result.type)) { result.oneOf = result.type.map(type => ({ type })); delete result.type; }
  return result;
}

// This client talks to the same separate stdio MCP process as the Pi paths.
// Its catalog and results come from JSON-RPC, never from in-process fixtures.
async function connectMcp(options) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url)), String(options.count ?? 12), String(options.toolCount ?? 18), String(options.delayMs ?? 25)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
  const pending = new Map(); let id = 0, closed = false;
  const lines = createInterface({ input: child.stdout });
  const failAll = error => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  child.on('error', failAll);
  child.on('exit', () => { closed = true; failAll(new Error('MCP process exited')); });
  child.stderr.resume();
  lines.on('line', line => {
    try { const response = JSON.parse(line), p = pending.get(response.id); if (!p) return; pending.delete(response.id); response.error ? p.reject(new Error(response.error.message)) : p.resolve(response.result); }
    catch (error) { failAll(error); }
  });
  const rpc = (method, params, signal) => new Promise((resolve, reject) => {
    const callId = ++id;
    const timer = setTimeout(() => { pending.delete(callId); reject(new Error(`MCP timeout: ${method}`)); }, 30000);
    const aborted = () => { pending.delete(callId); cleanup(); reject(signal.reason ?? new Error('MCP aborted')); };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); };
    pending.set(callId, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
    if (signal?.aborted) return aborted();
    signal?.addEventListener('abort', aborted, { once: true });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: callId, method, params }) + '\n');
  });
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-ptc-demo', version: '1.0.0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const { tools } = await rpc('tools/list', {});
    return { tools, call: (name, args, signal) => rpc('tools/call', { name, arguments: args }, signal), close: async () => { if (!closed) { const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended; } lines.close(); } };
  } catch (error) { child.kill(); lines.close(); throw error; }
}

function toWire(config, options) {
  const text = blocks => blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const messages = options.system ? [{ role: 'system', content: options.system }] : [];
  for (const m of options.messages) {
    if (m.role === 'assistant') {
      const tool_calls = m.content.filter(b => b.type === 'tool-call').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }));
      messages.push({ role: 'assistant', content: text(m.content) || null, ...(tool_calls.length ? { tool_calls } : {}) });
    } else if (m.role === 'tool') messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: text(m.content) });
    else messages.push({ role: m.role === 'developer' ? 'system' : m.role, content: text(m.content) });
  }
  const tools = (options.tools ?? []).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  return { model: config.model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}), stream: false, thinking: { type: 'disabled' }, temperature: 0, max_tokens: 6000 };
}
function normalize(m) {
  return { ...m, role: m.role === 'tool' ? 'toolResult' : m.role, toolName: m.role === 'tool' ? 'run_code' : undefined,
    content: m.content.map(b => b.type === 'tool-call' ? { type: 'toolCall', id: b.id, name: b.name, arguments: JSON.parse(b.arguments) } : b) };
}

// Only used by the explicitly labeled keyless smoke test; online uses no fixed code.
const smokeCode = `const {orders} = await tools.mcp__orders__list_orders({});
const rows = await Promise.all(orders.filter(o => o.paidHoursAgo > 72 && o.paymentStatus === 'paid' && o.shipmentStatus === 'pending').map(async order => {
 const [payment,shipment] = await Promise.all([tools.mcp__orders__get_payment({orderId:order.orderId}),tools.mcp__orders__get_shipment({orderId:order.orderId})]); return {order,payment,shipment};
}));
const matched=rows.filter(x=>x.payment.status==='paid'&&x.shipment.status==='pending');
return {matchedCount:matched.length,top3:matched.sort((a,b)=>b.order.paidHoursAgo-a.order.paidHoursAgo).slice(0,3).map(x=>({orderId:x.order.orderId,customer:x.order.customer,paidHoursAgo:x.order.paidHoursAgo,amount:x.order.amount,warehouse:x.shipment.warehouse,suggestion:'联系仓库核实发货时间。'}))};`;

export async function runPtc(options = {}) {
  for (const [name, defaultValue, min, max] of [['count', 12, 1, 48], ['toolCount', 18, 3, 60], ['delayMs', 25, 0, 200]]) {
    const value = options[name] ?? defaultValue;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid PTC ${name}`);
  }
  const online = options.inference === 'online';
  const config = online ? options.testConfig ?? await loadDeepSeekConfig() : { model: 'fixed-ptc-smoke', baseUrl: '', apiKey: '' };
  if (online && !config.apiKey) throw new Error('请先配置 DeepSeek API Key。');
  await mkdir(workspace, { recursive: true });
  const [{ Context }, llm, session, projection, prompt, tool, agentRegistry, loop, fs, subprocess, sandbox, policy, runtime] = await Promise.all(['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-fs-local', 'dsh-subprocess-local', 'dsh-sandbox-local', 'dsh-sandbox-policy', 'dsh-ptc-runtime-node'].map(pkg));
  const ctx = new Context(), requests = [], responses = [], calls = [], sessionEvents = [], assemblies = [];
  let active = 0, peak = 0, error = null, finalText = '', report = null;
  const start = performance.now();
  const mcp = await connectMcp(options);
  try {
    // Mount only the official services needed for PTC; no personal config or shell tools.
    for (const [plugin, settings] of [
      [llm.default], [session.default], [projection.default],
      [prompt.default, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: COMMON_PROMPT + '\nUse ONE run_code business program. The complete SDK is already in the system prompt. All tools return canonical JSON values directly (no MCP wrapper); await every call. Filter with all three conditions, verify all candidates with Promise.all, and return ONLY the compact final report. Do not print raw data. Use only tools bindings, no imports, files, environment, or network. After the report returns, give the JSON final answer without further tool calls.' }],
      [fs.default, { cwd: workspace }], [subprocess.LocalSubprocessRuntime], [sandbox.default, {}], [policy.default, { mode: 'read-only', workspaceRoot: workspace }],
      [runtime.default, { timeoutMs: 30000, maxTimeoutMs: 30000, maxOutputBytes: 16000, maxOldGenerationSizeMb: 128, maxMessageBytes: 1000000, maxPendingCalls: 64, graceMs: 1000 }],
      [tool.default, { mode: 'ptc', maxParallelSubCalls: 8 }], [agentRegistry.default], [loop.default, { agents: [], maxParallelToolCalls: 8 }],
    ]) { await ctx.plugin(plugin, settings).await(); }
    ctx.on('session/event', (_subject, event) => { sessionEvents.push(copy(event)); });
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => { const assembled = await next(); assemblies.push(copy(assembled)); return assembled; });
    const selectedNames=options.selectedTools;
    if(selectedNames && (!selectedNames.length || selectedNames.some(n=>!mcp.tools.some(t=>`mcp__orders__${t.name}`===n)))) throw new Error('Handoff contains unknown or empty tool selection');
    for (const t of mcp.tools.filter(t=>!selectedNames||selectedNames.includes(`mcp__orders__${t.name}`))) ctx.tools.register({ name: `mcp__orders__${t.name}`, description: t.description, parameters: t.inputSchema,
      output: { schema: dshSchema(t.outputSchema ?? { type: 'object', additionalProperties: true }), render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (calls.length >= 130) throw new Error('PTC exceeded 130 business calls');
        active++; peak = Math.max(peak, active);
        const call = { id: exec.callId, name: `mcp__orders__${t.name}`, arguments: copy(args), parentToolCallId: exec.rootCallId ?? null, startMs: Math.round(performance.now() - start) }; calls.push(call);
        try { const result = await mcp.call(t.name, args, exec.signal); call.result = copy(result.content); call.rawResultBytes = bytes(result.content); call.isError = result.isError ?? false; if (call.isError) throw new Error(JSON.stringify(result.content)); return result.structuredContent ?? JSON.parse(result.content[0].text); }
        catch (err) { call.isError = true; call.error = safeError(err, config); throw err; }
        finally { active--; call.endMs = Math.round(performance.now() - start); }
      },
    });
    class Adapter extends llm.LlmAdapter {
      providerRetryPolicy() { return llm.resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }); }
      async resolveModel(provider, model) { return { provider, id: model, name: model, defaultMaxTokens: 6000 }; }
      async *stream(inputs) {
        if (requests.length >= 64 || performance.now() - start > 600000) throw new Error('PTC online limit exceeded');
        const context = copy({ messages: inputs.messages, tools: inputs.tools ?? [], ...(inputs.system ? { system: inputs.system } : {}) });
        const wirePayload = toWire(config, inputs);
        if(options.handoffMessages) {
          const system=wirePayload.messages.filter(m=>m.role==='system');
          const following=wirePayload.messages.filter(m=>m.role!=='system');
          if(following[0]?.role==='user' && following[0].content===USER_TASK) following.shift();
          wirePayload.messages=[...system,...copy(options.handoffMessages),...following];
        }
        const request = { round: requests.length + 1, context, bytes: bytes(context), wirePayload, wireBytes: bytes(wirePayload), startedAt: new Date().toISOString() }; requests.push(request);
        let reply;
        if (online) {
          const signal = AbortSignal.any([inputs.signal, AbortSignal.timeout(90000)].filter(Boolean));
          const response = await (options.testFetch ?? fetch)(`${config.baseUrl}/chat/completions`, { method: 'POST', headers: { ...llm.attributionHeaders(), 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(wirePayload), signal });
          reply = await response.json(); request.httpStatus = response.status;
          if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}: ${reply.error?.message ?? '请求失败'}`);
        } else if (requests.length === 1) reply = { choices: [{ message: { tool_calls: [{ id: 'ptc-smoke-call', function: { name: 'run_code', arguments: JSON.stringify({ code: smokeCode, description: 'Check overdue orders and return compact summary' }) } }] } }] };
        else { const output = inputs.messages.filter(m => m.role === 'tool').at(-1); if (output?.isError) throw new Error(JSON.stringify(output.content)); reply = { choices: [{ message: { content: JSON.stringify(parseReport(output.content.filter(b => b.type === 'text').map(b => b.text).join('\n'))) } }] }; }
        request.completedAt = new Date().toISOString(); request.modelWallMs = Date.parse(request.completedAt) - Date.parse(request.startedAt); request.responseModel = reply.model ?? config.model; request.responseId = reply.id ?? null; request.apiUsage = reply.usage ?? null;
        const message = reply.choices?.[0]?.message; if (!message) throw new Error('DeepSeek response has no message');
        const blocks = [];
        if (message.content) blocks.push({ type: 'text', text: message.content });
        for (const c of message.tool_calls ?? []) blocks.push({ type: 'tool-call', id: llm.ToolCallId(c.id), name: c.function.name, arguments: c.function.arguments });
        responses.push(normalize({ role: 'assistant', content: blocks }));
        for (const [index, block] of blocks.entries()) {
          yield { type: 'block-start', index, blockType: block.type };
          yield block.type === 'text' ? { type: 'text-delta', index, text: block.text } : { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
          yield { type: 'block-end', index, block };
        }
        const u = reply.usage; if (u) { const hit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0; yield { type: 'usage', usage: { inputTokens: u.prompt_tokens - hit, outputTokens: u.completion_tokens, cacheReadTokens: hit, totalTokens: u.total_tokens } }; }
        const kind = reply.choices[0].finish_reason === 'length' ? 'max-tokens' : blocks.some(b => b.type === 'tool-call') ? 'tool-calls' : 'stop';
        options.onProgress?.({ mode: 'ptc', round: request.round, status: kind, durationMs: request.modelWallMs, inputTokens: u?.prompt_tokens ?? null, outputTokens: u?.completion_tokens ?? null, tools: blocks.filter(b => b.type === 'tool-call').map(b => b.name) });
        yield { type: 'finish', reason: { kind } };
      }
    }
    ctx.llm.registerAdapter(['demo-deepseek'], new Adapter());
    const agent = await ctx.agentLoop.create(session.SessionId(`ptc-${randomUUID()}`), { provider: 'demo-deepseek', model: config.model, maxTokens: 6000 }, { cwd: workspace });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { agent.cancel(); reject(new Error('PTC agent exceeded ten minutes')); }, 600000);
      const dispose = ctx.on('agent/status', ({ agent: source, status }) => { if (source === agent && status === 'idle') { clearTimeout(timer); dispose(); resolve(); } });
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: USER_TASK }], source: { kind: 'user' } }));
    });
    const rawMessages = agent.session.deriveMessages();
    const messages = copy(rawMessages.map(normalize));
    finalText = rawMessages.filter(m => m.role === 'assistant').at(-1)?.content.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? '';
    try { report = parseReport(finalText); } catch (err) { error = safeError(err, config); }
    const expected = reportFor(candidateOrders(makeOrders(options.count ?? 12)).map(order => ({ order, payment: { status: order.paymentStatus }, shipment: { status: order.shipmentStatus, warehouse: order.warehouse } })));
    const fields = ['orderId', 'customer', 'paidHoursAgo', 'amount', 'warehouse'];
    const factsCorrect = report?.matchedCount === expected.matchedCount && report?.top3?.length === expected.top3.length && report.top3.every((o, i) => fields.every(f => o[f] === expected.top3[i][f]));
    const execution = checkExecution({ mode: 'ptc', candidates: candidateOrders(makeOrders(options.count ?? 12)), calls, messages });
    const system = requests[0]?.context.messages.filter(m => m.role === 'system') ?? [];
    // Pull the actual generated SDK section from the durable prompt assembly.
    const promptHeaders = sessionEvents.filter(e => e.type === 'request/header');
    const header = promptHeaders[0]?.data.header;
    const sdkSections = assemblies[0]?.sections.filter(s => s.name === 'tools:sdk') ?? [];
    const systemText = system.flatMap(m => m.content).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const sdkLoaded = ['list_orders', 'get_payment', 'get_shipment'].every(n => systemText.includes(`mcp__orders__${n}`));
    const validation = { passed: factsCorrect && execution.passed && sdkLoaded, factsCorrect, toolCoverage: execution.noDuplicateOrUnneededCalls, execution, sdkLoaded, expectedMatchedCount: expected.matchedCount, expectedTopOrderIds: expected.top3.map(o => o.orderId) };
    const sum = field => online && requests.every(r => r.apiUsage) ? requests.reduce((s, r) => s + (r.apiUsage[field] ?? 0), 0) : online ? null : 0;
    return { mode: 'ptc', inference: online ? 'online' : 'replay', runtime: `DeepSeek Harness ${PTC_VERSION} / official Node PTC process`, report, finalText, error, validation, requests, responses, calls, messages, sessionEvents, promptHeader: header ?? null, sdkSections,
      metrics: { modelRequests: requests.length, externalLlmRequests: online ? requests.length : 0, inputTokens: sum('prompt_tokens'), outputTokens: sum('completion_tokens'), cacheHitTokens: sum('prompt_cache_hit_tokens'), modelWallMs: requests.reduce((s, r) => s + r.modelWallMs, 0), wireRequestBytes: online ? requests.reduce((s, r) => s + r.wireBytes, 0) : null, initialMcpTools: 0, initialMcpSchemaBytes: 0, initialToolDeclarationBytes: bytes(requests[0]?.context.tools ?? []), initialSdkDeclarationBytes: sdkSections.length ? bytes(sdkSections.map(s => s.text).join('\n')) : null, initialSystemPromptBytes: bytes(systemText), surfacedResultBytes: messages.filter(m => m.role === 'toolResult').reduce((s, m) => s + bytes(m.content), 0), accumulatedRequestBytes: requests.reduce((s, r) => s + r.bytes, 0), mcpCalls: calls.length, rawMcpResultBytes: calls.reduce((s, c) => s + (c.rawResultBytes ?? 0), 0), peakMcpConcurrency: peak, localWallMs: Math.round(performance.now() - start) } };
  } catch (err) { throw new Error(`PTC: ${safeError(err, config)}`, { cause: err }); }
  finally { try { await ctx.fiber.dispose(); } finally { await mcp.close(); } }
}
