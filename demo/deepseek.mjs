import { readFile } from 'node:fs/promises';
import { ai } from './pi-runtime.mjs';

export async function loadDeepSeekConfig() {
  let local = {};
  try {
    const source = await readFile(new URL('./.env.local', import.meta.url), 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const match = line.trim().match(/^(DEEPSEEK_API_KEY|DEEPSEEK_MODEL)\s*=\s*(.*)$/);
      if (match) local[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || local.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || local.DEEPSEEK_MODEL || 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com',
  };
}
export function publicConfig(config) {
  return { configured: Boolean(config.apiKey), provider: 'DeepSeek official API', baseUrl: config.baseUrl, model: config.model, thinking: 'disabled' };
}
export function safeError(error, config) {
  let message = error?.message || String(error);
  if (config?.apiKey) message = message.split(config.apiKey).join('[redacted]');
  return message.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 600);
}
export function toChatPayload(model, context) {
  const messages = [];
  const prompt = ai.getCurrentSystemPrompt(context.messages);
  if (prompt) messages.push({ role: 'system', content: prompt });
  for (const m of context.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: ai.contentText(m.content) });
    if (m.role === 'assistant') {
      const text = ai.contentText(m.content);
      const toolCalls = m.content.filter(c => c.type === 'toolCall').map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
      messages.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    }
    if (m.role === 'toolResult') messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: ai.contentText(m.content) });
  }
  const tools = ai.getCurrentTools(context.messages).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  return { model: model.id, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}), stream: false, thinking: { type: 'disabled' }, temperature: 0, max_tokens: 6000 };
}
function boundedCode(code) {
  let body = code;
  let options = {};
  if (body.startsWith('// @options:')) {
    const end = body.indexOf('\n');
    if (end < 0) throw new Error('Codemode options line must be followed by code');
    options = JSON.parse(body.slice('// @options:'.length, end));
    body = body.slice(end + 1);
  }
  options.timeout_ms = 30000;
  options.max_output_tokens = 4000;
  return `// @options: ${JSON.stringify(options)}\n${body}`;
}
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

// Only the request body is recorded. The Authorization header stays in this closure.
export function createDeepSeekStream({ config, requests, responses, fetchImpl = fetch, onProgress, maxRequests = 64, deadlineMs = 600000 }) {
  const runStart = performance.now();
  return (model, context, streamOptions = {}) => {
    const stream = ai.createAssistantMessageEventStream();
    const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: 'pending', timestamp: Date.now() };
    queueMicrotask(async () => {
      let request;
      try {
        if (!config.apiKey) throw new Error('请先在 .env.local 填写 DEEPSEEK_API_KEY。');
        if (requests.length >= maxRequests) throw new Error('已达到单条路径 64 次模型请求上限。');
        const remaining = deadlineMs - (performance.now() - runStart);
        if (remaining <= 0) throw new Error('在线路径超过 10 分钟执行期限。');
        const wirePayload = toChatPayload(model, context);
        request = { round: requests.length + 1, context: JSON.parse(JSON.stringify(context)), bytes: Buffer.byteLength(JSON.stringify(context)), wirePayload, wireBytes: Buffer.byteLength(JSON.stringify(wirePayload)), startedAt: new Date().toISOString() };
        requests.push(request);
        stream.push({ type: 'start', partial: message });
        const timeout = AbortSignal.timeout(Math.min(90000, Math.ceil(remaining)));
        const signal = streamOptions.signal ? AbortSignal.any([streamOptions.signal, timeout]) : timeout;
        const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(wirePayload), signal,
        });
        const reply = await response.json();
        request.completedAt = new Date().toISOString();
        request.modelWallMs = Date.parse(request.completedAt) - Date.parse(request.startedAt);
        request.httpStatus = response.status;
        if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}: ${reply.error?.message || '请求失败'}`);
        const choice = reply.choices?.[0];
        if (!choice?.message) throw new Error('DeepSeek response has no message');
        if (choice.message.content) message.content.push({ type: 'text', text: choice.message.content });
        for (const t of choice.message.tool_calls ?? []) {
          const args = JSON.parse(t.function.arguments || '{}');
          if (t.function.name === 'codemode') {
            if (typeof args.code !== 'string') throw new Error('Codemode requires a code string');
            args.code = boundedCode(args.code);
          }
          message.content.push({ type: 'toolCall', id: t.id, name: t.function.name, arguments: args });
        }
        request.responseModel = reply.model ?? config.model;
        request.responseId = reply.id;
        request.apiUsage = reply.usage ?? null;
        const u = reply.usage;
        if (u) {
          const hit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
          message.usage = { ...emptyUsage(), input: (u.prompt_tokens ?? 0) - hit, output: u.completion_tokens ?? 0, cacheRead: hit, totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) };
        }
        message.stopReason = choice.finish_reason === 'length' ? 'length' : message.content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop';
        responses.push(JSON.parse(JSON.stringify(message)));
        onProgress?.({ round: request.round, status: message.stopReason, durationMs: request.modelWallMs, inputTokens: u?.prompt_tokens ?? null, outputTokens: u?.completion_tokens ?? null, tools: message.content.filter(c => c.type === 'toolCall').map(c => c.name) });
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message);
      } catch (error) {
        message.stopReason = 'error'; message.errorMessage = safeError(error, config);
        if (request) { request.error = message.errorMessage; request.completedAt ??= new Date().toISOString(); request.modelWallMs ??= Date.parse(request.completedAt) - Date.parse(request.startedAt); }
        responses.push(JSON.parse(JSON.stringify(message)));
        stream.push({ type: 'error', reason: 'error', error: message }); stream.end(message);
      }
    });
    return stream;
  };
}
