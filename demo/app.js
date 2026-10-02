let data;
let tab = 'initial';
const round = { before: 1, after: 1, ptc: 1 };
const $ = selector => document.querySelector(selector);
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pretty = value => JSON.stringify(value, null, 2);
const size = n => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`;
const code = (value, dark = false) => `<pre class="codebox${dark ? ' dark' : ''}">${esc(typeof value === 'string' ? value : pretty(value))}</pre>`;
const raw = value => `<div class="raw"><details><summary>查看完整 SDK 请求内容</summary>${code(value)}</details></div>`;
const online = () => data?.inference === 'online';
const valueText = value => value === null || value === undefined ? '接口未返回' : String(value);
function parseJsonText(text) {
  try { return JSON.parse(text); } catch { return text; }
}
async function updateConfig() {
  const response = await fetch('/api/config');
  const config = await response.json();
  $('#api-config').textContent = config.configured ? `Key 已配置 · ${config.model} · ${config.baseUrl}` : 'Key 尚未配置；请在本机 .env.local 填写 DEEPSEEK_API_KEY。';
  return config;
}

function stats(key) {
  const m = data[key].metrics;
  const definitions = [
    ['首轮 MCP Schema', size(m.initialMcpSchemaBytes), `${m.initialMcpTools} 个 MCP 工具定义`],
    [online() ? '真实模型请求次数' : '模型接口回放次数', `${m.modelRequests}<small>轮</small>`, online() ? `${valueText(m.inputTokens)} 输入 / ${valueText(m.outputTokens)} 输出 token` : key === 'after' ? '含发现接口与最终总结' : '含最终总结'],
    ['新工具结果进入模型', size(m.surfacedResultBytes), key === 'after' ? online() && !data.after.validation?.execution?.compactOutput ? '本次脚本输出 + 接口说明' : '接口说明 + 精简订单摘要' : '订单列表 + 状态原始数据'],
  ];
  $(`#${key}-stats`).innerHTML = definitions.map(([label, value, detail]) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-detail">${detail}</div></div>`).join('');
}
function initialPane(key) {
  const run = data[key];
  const context = run.requests[0].context;
  const sys = context.messages.filter(m => m.role === 'system');
  const tools = sys.flatMap(m => m.toolsAdded ?? []);
  const after = key === 'after';
  const title = after ? 'Pi / 先给执行入口' : '传统路径 / 先给完整工具库';
  const summary = after
    ? `<div class="api-list"><small>实际首轮声明的工具</small>${tools.map(t => esc(t.name)).join('<br>')}<br><br><small>实际 MCP 服务器摘要</small>${esc(sys.map(m => m.sections?.mcp_servers ?? '').filter(Boolean).join('\n'))}</div><p class="callout"><b>0 B 指的是 MCP 工具 Schema 的预注入。</b><br>Codemode 的入口说明仍占 ${size(run.metrics.initialToolDeclarationBytes)}，系统提示仍存在。具体参数随后通过 describeTool() 按需获取。</p>`
    : `<div class="api-list"><small>实际首轮声明了 ${tools.length} 个 MCP 工具</small>${tools.slice(0, 6).map(t => esc(t.name)).join('<br>')}${tools.length > 6 ? `<br>… 另有 ${tools.length - 6} 个接口` : ''}</div><p class="callout">名称、描述和参数定义一起进入模型接口。此次任务只使用 3 类工具，其余 ${Math.max(0, tools.length - 3)} 个定义也已经加载。</p>`;
  return `<div class="inspect-pane"><div class="pane-title">${title}<span>${size(run.requests[0].bytes)} / 首轮完整请求</span></div>${summary}${raw(context)}</div>`;
}
function roundPane(key) {
  const run = data[key];
  const index = round[key] - 1;
  const req = run.requests[index];
  const oldIds = new Set(index ? run.requests[index - 1].context.messages.filter(m => m.role === 'toolResult').map(m => m.toolCallId) : []);
  const incoming = req.context.messages.filter(m => m.role === 'toolResult' && !oldIds.has(m.toolCallId));
  const response = run.responses[index];
  const action = response.content.find(c => c.type === 'toolCall');
  let caption = incoming.length ? `本轮新收到 ${incoming.length} 条工具结果；已有历史继续保留在请求中。` : '首轮：用户任务、系统提示和初始工具声明。';
  if (!online() && key === 'after' && index === 1) caption += ' 这里只收到检索命中的 3 个接口说明。';
  if (!online() && key === 'after' && index === 2) caption += ' 原始订单、支付与物流数据未出现在此处。';
  const incomingText = incoming.length ? incoming.map(m => ({ tool: m.toolName, content: m.content })) : { user: data.task, toolsAdded: req.context.messages.filter(m => m.role === 'system').flatMap(m => m.toolsAdded ?? []).map(t => t.name) };
  const responseView = action?.name === 'codemode' ? action.arguments.code : action ? response.content.map(c => c.type === 'toolCall' ? { tool: c.name, arguments: c.arguments } : c) : parseJsonText(response.content.find(c => c.type === 'text')?.text ?? response.errorMessage ?? '无文本响应');
  const actualWire = req.wirePayload ? `<div class="raw"><details><summary>查看实际 DeepSeek 请求体与 token 用量</summary>${code(req.wirePayload)}${code(req.apiUsage)}</details></div>` : '';
  return `<div class="inspect-pane"><div class="pane-title">${key === 'before' ? '传统 Tool Calling' : 'Pi Codemode'}<span>${size(req.bytes)} / 此轮完整请求</span></div><div class="round-picker">查看第 <select data-round="${key}" aria-label="${key === 'before' ? '传统路径轮次' : 'Codemode 路径轮次'}">${run.requests.map((r, i) => `<option value="${i + 1}" ${index === i ? 'selected' : ''}>${i + 1} / ${run.requests.length}</option>`).join('')}</select> 轮<button data-next="${key}" ${index === run.requests.length - 1 ? 'disabled' : ''}>下一轮 →</button></div><p class="round-caption">${caption}</p>${code(incomingText)}<div class="round-response"><div class="pane-title">${online() ? 'DeepSeek 实际响应' : '固定回放的模型响应'}<span>${action ? '发出工具调用' : '输出最终答案'}</span></div>${code(responseView)}</div>${raw(req.context)}${actualWire}</div>`;
}
function timelinePane(key) {
  const run = data[key];
  const min = run.calls.length ? Math.min(...run.calls.map(c => c.startMs)) : 0;
  const max = run.calls.length ? Math.max(...run.calls.map(c => c.endMs)) - min || 1 : 1;
  return `<div class="inspect-pane"><div class="pane-title">${key === 'before' ? '逐步调用 / 模型驱动' : key === 'ptc' ? 'PTC / 代码驱动' : 'Codemode / 代码驱动'}<span>共 ${run.calls.length} 次 MCP 调用</span></div><div class="timeline-meta">实际峰值并发 ${run.metrics.peakMcpConcurrency} · MCP 调用窗口 ${max} ms</div><div class="timeline">${run.calls.map(c => `<div class="timeline-row"><span>${esc(c.name.replace('mcp__orders__', ''))}${c.arguments.orderId ? '<br>' + esc(c.arguments.orderId) : ''}</span><div class="timeline-track" title="${esc(`${c.startMs}–${c.endMs} ms`)}"><div class="timeline-bar ${key !== 'before' ? 'after-bar' : ''}" style="left:${(c.startMs - min) / max * 100}%;width:${(c.endMs - c.startMs) / max * 100}%"></div></div></div>`).join('')}</div><div class="timeline-caption">0 ms ${'─'.repeat(25)} ${max} ms（各自从首个 MCP 调用起算）</div><p class="callout">${key !== 'before' ? '每次嵌套调用都有 parentToolCallId，归属对应的编排脚本。模型可能重复查询；实际调用次数和并发以本次记录为准。' : '当前是逐步基线；下方另有并行 Tool Calling 的实际记录。'}</p></div>`;
}
function inspect() {
  if (!data) return;
  if (tab === 'ptc') {
    if (!data.ptc) { $('#inspect-content').innerHTML = '<div class="inspect-pane"><p>当前记录没有 PTC。选择 DeepSeek 在线模式并重新运行，可获得四条路径的真实对照。PTC 不包含在原来的 Pi 固定回放中。</p></div>'; return; }
    const run = data.ptc, index = round.ptc - 1, req = run.requests[index];
    const scripts = run.responses.flatMap(m => m.content).filter(c => c.type === 'toolCall' && c.name === 'run_code');
    const validationText = run.validation.passed ? `✓ 相同 ${run.validation.execution.expectedMcpCalls} 次业务调用、无重复、无工具错误、只返回摘要，通过核验。` : '本次未通过执行核验，请查看完整记录。';
    $('#inspect-content').innerHTML = `<div class="inspect-pane"><div class="pane-title">DeepSeek Harness / 官方 Node PTC<span>${esc(run.runtime)}</span></div><p class="callout">首轮加载全部 ${data.options.toolCount} 个业务工具的 SDK：<b>${size(run.metrics.initialSdkDeclarationBytes)}</b>，另有 run_code 入口声明 ${size(run.metrics.initialToolDeclarationBytes)}。SDK 文本属于系统提示，已计入 API 输入 token。此路径使用官方工具注册表、Agent Loop、SDK 生成器及 Node 进程执行器。</p><div class="stats">${[['真实模型请求', `${run.metrics.modelRequests} 轮`], ['API 输入 token', run.metrics.inputTokens], ['工具结果进入模型', size(run.metrics.surfacedResultBytes)]].map(([label,value])=>`<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${esc(value)}</div></div>`).join('')}</div><p>${validationText} MCP 原始结果 ${size(run.metrics.rawMcpResultBytes)}，峰值并发 ${run.metrics.peakMcpConcurrency}。</p><div class="round-picker">查看第 <select data-round="ptc" aria-label="PTC 路径轮次">${run.requests.map((r,i)=>`<option value="${i+1}" ${i===index?'selected':''}>${i+1} / ${run.requests.length}</option>`).join('')}</select> 轮<button data-next="ptc" ${index===run.requests.length-1?'disabled':''}>下一轮 →</button></div><div class="raw"><details><summary>首轮实际 SDK 声明</summary>${code(run.sdkSections.map(s=>s.text).join('\n'))}</details><details><summary>本轮完整 Harness 请求上下文</summary>${code(req.context)}</details><details><summary>本轮实际 DeepSeek 请求体与 usage</summary>${code(req.wirePayload)}${code(req.apiUsage)}</details><details><summary>本轮 DeepSeek 响应</summary>${code(run.responses[index])}</details><details><summary>完整 Harness 事件日志（含内部调用，未发送给模型）</summary>${code(run.sessionEvents)}</details></div><h3>模型实际生成的 PTC 程序</h3>${scripts.map(c=>code(c.arguments.code,true)).join('')}${timelinePane('ptc')}</div>`;
  }
  if (tab === 'initial') $('#inspect-content').innerHTML = `<div class="inspect-two">${initialPane('before')}${initialPane('after')}</div>`;
  if (tab === 'rounds') $('#inspect-content').innerHTML = `<div class="inspect-two">${roundPane('before')}${roundPane('after')}</div>`;
  if (tab === 'timeline') $('#inspect-content').innerHTML = `<div class="inspect-two">${timelinePane('before')}${timelinePane('after')}</div>`;
  if (tab === 'code') {
    const calls = data.after.responses.flatMap(m => m.content).filter(c => c.type === 'toolCall');
    $('#inspect-content').innerHTML = `<div class="code-layout"><div><h3>本次实际 Codemode 脚本</h3><ol><li>检索相关工具，读参数声明</li><li>取订单列表，筛选候选订单</li><li>并发核对支付与物流</li><li>排序，保留前三条摘要</li></ol><p>${online() ? '右侧代码由 DeepSeek 在本次在线推理中实际生成，并在 QuickJS-WASM 中执行。脚本数量取决于模型决策。' : '右侧是本次真实执行的源代码。模型决策是固定回放；脚本在 Pi 自带的 QuickJS-WASM 中实际运行。'}</p><p>text() 或 return 的输出进入模型上下文。实际是否精简数据，可在逐轮传输页检查。</p></div><div>${calls.length ? calls.map((c, i) => `<div class="pane-title" style="margin-top:${i ? 18 : 0}px">第 ${i + 1} 段 / 本次实际脚本</div>${code(c.arguments.code, true)}`).join('') : '<p>本次未产生编排代码。</p>'}</div></div>`;
  }
}
function render() {
  stats('before'); stats('after'); inspect();
  const keys = ['before', 'batch', 'after', ...(data.ptc ? ['ptc'] : [])];
  const verified = data.verified ?? true;
  const healthyCode = data.after.validation?.execution?.passed;
  $('.after .mode-desc').textContent = online() ? healthyCode ? '按需发现接口，在一段业务脚本中筛选、并发核对，只输出最终报告。' : '按需发现接口，执行模型生成的脚本；输出量和重复调用取决于实际代码。' : '先发现相关接口，再并发调用、过滤，只返回摘要。';
  $('.after .flow span:last-child').textContent = online() && !healthyCode ? '脚本输出' : '精简结果';
  $('#scope-text').textContent = online() ? `真实 DeepSeek 在线推理 · ${data.model} · 使用合成订单。模型实际选择工具、生成代码与总结；各路径轮次和调用量按运行记录显示。` : '合成订单 + 固定模型决策回放；外部 LLM 请求为 0。左侧是传统 MCP 基线，右侧使用本机 Pi 的内置 Codemode。';
  $('#match-badge').textContent = verified ? `✓ ${data.ptc ? '四' : '三'}条路径${data.benchmarkRevision ? '业务结果与执行流程' : '业务事实与工具核对'}通过核验 · ${data.after.report.matchedCount} 条待跟进` : '部分路径未通过核验，不能作为有效对照';
  $('#match-badge').classList.toggle('error', !verified);
  const rows = Array.isArray(data.after.report?.top3) ? data.after.report.top3 : [];
  $('#order-results').innerHTML = `<div class="order-grid">${rows.map((o, i) => `<article class="order-card"><div class="order-top">${esc(o.orderId)}<span>优先级 0${i + 1}</span></div><div class="order-hours">${esc(o.paidHoursAgo)}<small>小时未发货</small></div><div class="order-detail">${esc(o.customer)} · ¥${esc(o.amount)} · ${esc(o.warehouse)}</div><p class="order-suggestion">${esc(o.suggestion)}</p></article>`).join('')}</div>${!verified ? `<div class="raw"><details open><summary>结果诊断与各路径输出</summary>${code(Object.fromEntries(keys.map(k => [k, { error: data[k].error, validation: data[k].validation, report: data[k].report, finalText: data[k].finalText }])))}</details></div>` : data.benchmarkRevision ? `<div class="raw"><details><summary>查看有效对照的验收依据：相同业务调用、无重复、无错误、原始数据隔离</summary>${code(Object.fromEntries(keys.map(k => [k, data[k].validation])))}</details></div>` : ''}`;
  const fields = [
    [online() ? '真实模型请求次数' : '模型接口回放次数', 'modelRequests', v => `${v} 轮`],
    ...(online() ? [['API 输入 token（含缓存）', 'inputTokens', valueText], ['API 输出 token', 'outputTokens', valueText], ['API 缓存命中 token', 'cacheHitTokens', valueText], ['模型请求累计耗时', 'modelWallMs', v => `${v} ms`], ['实际 API 请求体累计', 'wireRequestBytes', v => v == null ? '未记录' : size(v)]] : []),
    ['首轮 MCP Schema', 'initialMcpSchemaBytes', size],
    ['首轮调用入口声明（SDK 口径）', 'initialToolDeclarationBytes', size],
    ...(data.ptc ? [['首轮 PTC SDK 文本（系统提示内）', 'initialSdkDeclarationBytes', v => v == null ? '—' : size(v)], ['首轮系统提示（实际 API 文本）', 'wireSystemBytes', size]] : []),
    ['新工具结果进入模型', 'surfacedResultBytes', size],
    ['各轮完整请求累计', 'accumulatedRequestBytes', size],
    ['业务 MCP 调用', 'mcpCalls', v => `${v} 次`],
    ['MCP 原始结果量', 'rawMcpResultBytes', size],
    ['实际峰值并发', 'peakMcpConcurrency', String],
    [online() ? '端到端运行耗时' : '本地运行耗时', 'localWallMs', v => `${v} ms`],
  ];
  $('#baseline-head').innerHTML = ['本次实际记录', '逐步 Tool Calling', '并行 Tool Calling', 'Pi Codemode', ...(data.ptc ? ['Harness PTC'] : [])].map(s=>`<th>${s}</th>`).join('');
  $('#baseline-table').innerHTML = fields.map(([label, field, format]) => `<tr><td>${label}</td>${keys.map(k => `<td>${format(field === 'wireSystemBytes' ? new TextEncoder().encode(data[k].requests[0].wirePayload.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n')).length : data[k].metrics[field])}</td>`).join('')}</tr>`).join('');
  $('#metric-note').textContent = online() ? 'token 来自 DeepSeek API usage，包含缓存命中部分。PTC SDK 文本已计入系统提示与输入 token，不额外重复加算。各轮完整请求累计使用各自 SDK 格式；跨框架比较请以实际 API 请求体累计和 token 为准。各路径依次执行；单次耗时含推理、网络、运行时与工具执行，不能代表稳定性能。Harness 为最小官方组件组合，未加载完整产品的其他工具与提示。' : '字节数是 Pi SDK 模型接口处序列化的 UTF-8 长度，不是 token 计费。新工具结果每条计一次。回放次数包含最终总结；耗时仅含本地执行。';
  $('#status').textContent = `${verified ? '核验通过' : '执行完成，存在核验失败'} · ${online() ? '在线推理' : '固定回放'} · ${data.options.count} 个订单 / ${data.options.toolCount} 个工具 · ${new Date(data.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`;
  $('#status').classList.remove('error');
}
$('.tabs').addEventListener('click', e => {
  const button = e.target.closest('[data-tab]'); if (!button) return;
  tab = button.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b === button)));
  inspect();
});
$('#inspect-content').addEventListener('change', e => { if (e.target.dataset.round) { round[e.target.dataset.round] = Number(e.target.value); inspect(); } });
$('#inspect-content').addEventListener('click', e => { const b = e.target.closest('[data-next]'); if (b && round[b.dataset.next] < data[b.dataset.next].requests.length) { round[b.dataset.next]++; inspect(); } });
$('#run').addEventListener('click', async () => {
  $('#run').disabled = true; $('#run').textContent = '正在实际执行…';
  $('#status').textContent = $('#inference').value === 'online' ? '正在运行三条 Pi 路径和官方 Harness PTC 路径…' : '正在运行三条 Pi 固定回放路径…';
  try {
    const response = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: Number($('#count').value), toolCount: Number($('#toolCount').value), inference: $('#inference').value }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    data = result; round.before = 1; round.after = 1; round.ptc = 1; render();
  } catch (error) { $('#status').textContent = `运行失败：${error.message}`; $('#status').classList.add('error'); }
  finally { $('#run').disabled = false; $('#run').textContent = '↻ 重新运行对照'; }
});
try {
  const response = await fetch('/api/latest'); if (!response.ok) throw new Error('无法载入运行记录');
  data = await response.json(); $('#count').value = data.options.count; $('#toolCount').value = data.options.toolCount; $('#inference').value = data.inference ?? 'replay'; render(); await updateConfig();
} catch (error) { $('#status').textContent = error.message; $('#status').classList.add('error'); }
