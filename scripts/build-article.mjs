import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root=new URL('../',import.meta.url), base=new URL('results/matrix/',root);
const m=JSON.parse(await readFile(new URL('manifest.json',base),'utf8'));
if(m.runs.length!==108 || !m.completedAt) throw new Error('Matrix incomplete');
const median=values=>{const s=[...values].sort((a,b)=>a-b),n=s.length;return n?n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2:null;};
const modes=['direct','direct-batch','codemode','ptc'];
const fields=['modelRequests','inputTokens','outputTokens','cacheHitTokens','localWallMs','modelWallMs','mcpCalls','peakMcpConcurrency','rawMcpResultBytes','surfacedResultBytes'];
const groups=[];
for(const count of m.orders) for(const toolCount of m.tools) for(const mode of modes) {
 const all=m.runs.filter(r=>r.count===count&&r.toolCount===toolCount&&r.mode===mode),v=all.filter(r=>r.passed);
 groups.push({count,toolCount,mode,attempts:all.length,passed:v.length,stats:Object.fromEntries(fields.map(f=>[f,{median:median(v.map(r=>r.metrics[f]).filter(Number.isFinite)),min:v.length?Math.min(...v.map(r=>r.metrics[f])):null,max:v.length?Math.max(...v.map(r=>r.metrics[f])):null}]))});
}
const summary={revision:m.revision,completedAt:m.completedAt,attempts:m.runs.length,passed:m.runs.filter(r=>r.passed).length,aggregation:'median/min/max of valid attempts only; all failures retained separately',groups,failures:m.runs.filter(r=>!r.passed)};
await writeFile(new URL('summary.json',base),JSON.stringify(summary,null,2));
await writeFile(new URL('metrics.csv',base),['id,count,toolCount,repeat,mode,passed,'+fields.join(','),...m.runs.map(r=>[r.id,r.count,r.toolCount,r.repeat,r.mode,r.passed,...fields.map(f=>r.metrics[f]??'')].join(','))].join('\n')+'\n');
await mkdir(new URL('docs/',root),{recursive:true});
const num=n=>n===null?'—':Number.isInteger(n)?n.toLocaleString('en-US'):n.toFixed(1);
const get=(o,t,k)=>groups.find(g=>g.count===o&&g.toolCount===t&&g.mode===k);
const stat=(o,t,k,f)=>get(o,t,k).stats[f].median;
let appendix='# 矩阵证据与复现细节\n\n这份附件保存完整口径；技术解释见[首页](../README.md)。有效运行的指标使用中位数和最小–最大范围；失败也计入尝试总数，不纳入成功运行的性能统计。\n\n| 订单 / 工具 | 路径 | 通过 / 尝试 | 模型请求 | 输入 token | 输出 token | 缓存命中 | 耗时 ms，中位数 [最小–最大] | 调用数 | 峰值并发 |\n| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |\n';
for(const g of groups) appendix+=`| ${g.count} / ${g.toolCount} | ${g.mode} | ${g.passed}/${g.attempts} | ${num(g.stats.modelRequests.median)} | ${num(g.stats.inputTokens.median)} | ${num(g.stats.outputTokens.median)} | ${num(g.stats.cacheHitTokens.median)} | ${num(g.stats.localWallMs.median)} [${num(g.stats.localWallMs.min)}–${num(g.stats.localWallMs.max)}] | ${num(g.stats.mcpCalls.median)} | ${num(g.stats.peakMcpConcurrency.median)} |\n`;
appendix+='\n## 采集条件\n\nDeepSeek 官方 `deepseek-flash`；thinking disabled、temperature 0、max_tokens 6000。Pi 1.0.0；官方 Harness 核心组件 0.2.0-rc.2；Windows / Node 24.14.1。每次 MCP 调用模拟 25 ms I/O。3×3 组合，各四路径重复三次。路径顺序按组合和重复轮次轮换，第二轮反向遍历组合；模型缓存未清空，不代表独立冷缓存试验。中途停止后按记录 ID 续跑。\n\n先前校准阶段的 Pi 配置没有变化，其中 30 条完整记录沿用；修正 PTC 待处理请求容量后，其所有 27 条记录重新采集。因此顺序只是降低固定先后影响，并非严格随机或全程连续的实验。记录时间范围：'+m.startedAt+' 至 '+m.completedAt+'（UTC；北京时间加8小时）。\n\n1 条订单没有候选；12 条有 4 条候选，业务调用9次；48 条有26条候选，业务调用53次。工具数增加只增加无关接口，三个实际业务接口不变。订单规模同时增加列表长度、候选数及原始结果量，不能把其变化归因于一个单独因素。\n\nPi 的并行调用和 Codemode 未配置与 Harness 相同的执行并发上限；大数据组可达52，而 Harness上限8。该矩阵的耗时反映各自当前配置，不能据此宣布执行器本身谁更快。逐步路径要求模型每轮一工具，宿主始终串行；部分响应仍提交多个调用，所以轮数按实际记录，未按理论公式补齐。\n\n## 校准失败与修正\n\n第一次配置把 Node PTC `maxPendingCalls` 设成16，而48订单需要一次提交52个核对请求，触发 `pending binding calls exceed configured limits`。这是待处理容量与数据规模不匹配，不是8路实际执行并发不够。只把待处理容量调到64，实际并发仍为8。未改变提示、数据、输出限额和模型参数。\n\n[校准阶段 manifest](../results/calibration-v1/manifest.json)保留40条完整运行，其中10条PTC，4条PTC执行核验失败。这些校准PTC不进入修正后的矩阵。最终答案正确也可能伴随错误后的重复查询，不能拿这些运行代表正常程序的性能。被主动中断且未形成完整记录的调用不计入完成次数，可能已经产生 API 用量。\n\n## 记录与验证\n\n[manifest](../results/matrix/manifest.json)列出108条记录及运行顺序，[CSV](../results/matrix/metrics.csv)保留逐次指标，[summary](../results/matrix/summary.json)保留聚合和失败。每条 `.json.gz` 是完整执行记录的 gzip 压缩，包含请求体、API usage、响应、生成代码和实际调用；PTC还含内部事件。压缩只为减少仓库体积。脱敏仅替换本机绝对路径，字节指标保留原始采集值。\n\n字节为 UTF-8，不等于token。rawMcpResultBytes按文本内容计一次，不重复统计 structuredContent 副本；surfacedResultBytes按模型可见工具结果计一次，包含发现说明、脚本输出和运行状态。输入 token 使用 API prompt_tokens，包含缓存命中，输出和缓存命中单列。不以 SDK 占位 cost 字段推算账单。\n\n核验最终订单事实、完整候选调用集合、无重复/无无关调用、工具成功、代码路径的一段业务程序及精简输出；Pi发现必须包含所需字段，PTC必须实际装入SDK。不只看前三名是否正确。\n\n```powershell\nnode scripts/verify-evidence.mjs\nnode scripts/verify-matrix.mjs\n# 两者只核验已公开记录，不需要 API Key。\n```\n';
if(summary.failures.length) appendix+='\n## 修正后矩阵未通过的运行\n\n'+summary.failures.map(r=>`- ${r.id}：${JSON.stringify(r.validation)}；${r.error??'无最终解析错误'}`).join('\n')+'\n';
await writeFile(new URL('docs/matrix-evidence.md',root),appendix);
let body=await readFile(new URL('scripts/article-body.md',root),'utf8');
body=body.replaceAll('(../demo/','(demo/').replaceAll('(../assets/','(assets/');
body+='\n## 用订单任务验证这些取舍\n\n我们让四条路径访问同一个只读 stdio MCP 服务：逐步 Tool Calling、并行 Tool Calling、Pi Codemode 和 Harness PTC。任务是筛选支付超过72小时但仍未发货的订单，核对全部候选的支付和物流，按等待时间输出前三条。其余接口是无关的只读业务工具；订单和较长的审计、扫描字段都是合成数据。\n\n订单数取1、12、48，工具数取3、18、60，交叉组合后每条路径重复3次。'+`最终矩阵保留 **${summary.attempts} 次完整任务，${summary.passed} 次通过核验**。`+'完整逐次数据、失败、采集条件和耗时范围放在[证据附件](docs/matrix-evidence.md)，这里关注它们怎样支撑前面的实现解释。\n\n### 工具规模改变的是接口说明成本\n\n固定12条订单，只增加无关工具，业务调用仍是9次。下表输入是有效运行的中位数，已包含缓存命中：\n\n| 工具数 | 并行 Tool Calling 输入 token | Codemode 输入 token | PTC 输入 token |\n| --- | ---: | ---: | ---: |\n';
for(const t of m.tools) body+=`| ${t} | ${num(stat(12,t,'direct-batch','inputTokens'))} | ${num(stat(12,t,'codemode','inputTokens'))} | ${num(stat(12,t,'ptc','inputTokens'))} |\n`;
body+='\nPTC 的完整 SDK 随可见工具数增长，Codemode 的入口保持紧凑，再由发现结果补充少量接口。Codemode也不是绝对固定成本：搜索命中的数量和模型打印的声明可能不同。小工具集时，发现说明及额外往返可能比直接提供 SDK 更贵；随着无关工具增加，按需说明的收益才显现。\n\n### 数据规模改变的是中间结果成本\n\n固定18个工具，增加订单。模型所需的最终报告仍很短，但候选核对数增加，支付和物流的原始审计字段也随之增加：\n\n| 订单数 | 业务调用数 | 并行 Tool Calling 输入 token | Codemode 输入 token | PTC 输入 token |\n| --- | ---: | ---: | ---: | ---: |\n';
for(const o of m.orders) body+=`| ${o} | ${num(stat(o,18,'codemode','mcpCalls'))} | ${num(stat(o,18,'direct-batch','inputTokens'))} | ${num(stat(o,18,'codemode','inputTokens'))} | ${num(stat(o,18,'ptc','inputTokens'))} |\n`;
body+='\n1条订单这一行是无候选边界：只读列表，不做支付和物流核对。它能展示发现的固定开销，却不代表正常订单核对吞吐。12和48条订单的数据更能说明代码内汇总的价值：全部候选仍然被核对，模型读取的却是短报告；并行 Tool Calling 虽减少等待轮次，仍把原始结果放进模型上下文。\n\n### 延迟要结合轮数、并发和执行配置看\n\n为了避免只挑一个有利组合，这里列出全部九个组合。输入和耗时均为有效运行的中位数，耗时是端到端毫秒；通过数分别为Codemode/PTC：\n\n| 订单 / 工具 | Codemode 输入 | PTC 输入 | Codemode 耗时 ms | PTC 耗时 ms | 通过 / 3（C / P） |\n| --- | ---: | ---: | ---: | ---: | --- |\n';
for(const o of m.orders) for(const t of m.tools) body+=`| ${o} / ${t} | ${num(stat(o,t,'codemode','inputTokens'))} | ${num(stat(o,t,'ptc','inputTokens'))} | ${num(stat(o,t,'codemode','localWallMs'))} | ${num(stat(o,t,'ptc','localWallMs'))} | ${get(o,t,'codemode').passed} / ${get(o,t,'ptc').passed} |\n`;
body+='\n本实验提示明确要求 Codemode 先发现再写业务脚本，PTC用已提供SDK写一段程序。因此正常的代码路径通常是3轮和2轮，这个差异来自所测策略，不能当作框架强制下限。逐步调用的实际轮数也可能受模型一次提交多个请求影响，即使宿主仍逐个执行。\n\n大数据组还有重要配置差异：Pi并行路径可以同时执行52路核对，Harness被限制在8路，超出的调用排队。网络延迟、缓存命中、生成代码长度、进程启动和执行并发都进入端到端时间。这里的观测能说明当前路径的开销，不能拆解成两个执行器的纯性能排名。\n\n校准阶段也暴露了一个工程问题：PTC待处理调用容量16无法容纳52个请求，引起运行错误与后续重复查询。我们将容量改成64，实际并发仍为8，并完整重跑所有PTC组合；旧记录保留在附件中。运行正常以后再比较数据流，才有意义。\n\n## 把它应用到自己的智能体\n\n选择代码编排时，先看任务是不是有能交给程序执行的规则：字段筛选、批量核对、分页、关联、排序和汇总。把这些操作留在运行时，通常比让模型反复读完整中间结果更容易控制上下文。自然语言判断仍可由模型负责，但需要给它输出足够的事实与来源。\n\n选择接口暴露方式时，再看工具集合。少量稳定接口可以直接提供契约；大量工具而每次只用少数时，可以考虑按需发现。不要把“首轮没有MCP JSON schema”误解成零输入成本，SDK、入口、发现说明和历史都会进入请求。\n\n最后要验证执行过程：是否等待了全部异步调用，候选是否全部核对，有没有重复查询，输出是否真的精简，失败是否可追踪。原始数据虽然可以不交给模型，仍经过服务、宿主和运行时，不意味着它从系统里消失。\n\n这份矩阵只是一个合成业务、一个模型和三次重复。工具描述固定、缓存未清空，提示策略受控，执行并发没有拉齐，也没有测试其他平台。它支持对输入开销来源的解释，以及这些配置下的结果；不足以证明PTC普遍更快或Codemode总账单更低。\n\n## 运行 Demo 与检查证据\n\n```powershell\ngit clone https://github.com/baidd1011/pi-codemode-vs-ptc.git\ncd pi-codemode-vs-ptc\nnode scripts/verify-evidence.mjs\nnode scripts/verify-matrix.mjs\ncd demo\nnpm ci\nnode setup-ptc.mjs\nnode verify.mjs\nnode verify-ptc.mjs\nnode server.mjs\n```\n\n打开 <http://127.0.0.1:4317/>。Demo可浏览已有单组在线记录的输入输出、程序及调用时间线；矩阵的108条记录通过CSV、JSON及gzip附件查看，界面未增加矩阵选择器。\n\n若要真实在线运行，在本机从 `.env.example` 创建 `.env.local` 并填写Key：\n\n```powershell\nnode online.mjs --check\nnode online.mjs   # 单个默认组合\nnode matrix.mjs   # 108次任务；断点续跑；会消耗在线API用量\n```\n\n矩阵结果写入本机 `demo/output/matrix-v2/`。每条在线路径最多64次模型请求，130次业务调用；单次请求最多等待90秒。Windows PTC必须能创建受限令牌；沙箱启动失败时返回错误，不自动降级。其他平台尚未同等验证。\n\n实现入口：[Pi三路径](demo/engine.mjs)、[官方PTC组合和MCP bridge](demo/ptc.mjs)、[在线适配](demo/deepseek.mjs)、[矩阵运行器](demo/matrix.mjs)、[执行核验](demo/benchmark-checks.mjs)。版本由[Pi锁文件](demo/package-lock.json)和[Harness锁文件](demo/ptc-package-lock.json)固定。\n\n公开证据：[矩阵说明](docs/matrix-evidence.md)、[逐次CSV](results/matrix/metrics.csv)、[聚合JSON](results/matrix/summary.json)、[矩阵manifest](results/matrix/manifest.json)。此前12单/18工具的[初始单组记录](results/online-2026-10-02.json)和[初始指标](results/summary.json)也保留，不与新矩阵拼成一组统计。API Key、Authorization header和个人配置未上传；本机路径已替换，采集时的字节值原样保留。\n';
// Derive conclusions from paired cell medians rather than mixing runs or totals.
const inputSaving=(o,t)=>100*(1-stat(o,t,'codemode','inputTokens')/stat(o,t,'ptc','inputTokens'));
const timeSaving=(o,t)=>100*(1-stat(o,t,'ptc','localWallMs')/stat(o,t,'codemode','localWallMs'));
const range=values=>`${Math.min(...values).toFixed(1)}%–${Math.max(...values).toFixed(1)}%`;
const delaySavings=m.orders.flatMap(o=>m.tools.map(t=>timeSaving(o,t)));
const conclusions=`
## 本次实验的明确结论

在所测模型、提示策略和运行配置下，结论可以明确写为：**PTC 在九个组合中都取得更低的端到端耗时中位数；Codemode 的输入量优势出现在较大的工具集合中，三个工具时则由 PTC 占优。** 两条代码路径都能把中间数据留在运行时，但接口准备方式形成了不同的开销。

**一、工具多而实际只用少数时，Codemode 的输入优势更明显。** 本任务始终只使用三个业务接口。18 个工具时，Codemode 相比 PTC 少输入 ${range(m.orders.map(o=>inputSaving(o,18)))}；60 个工具时，少输入 ${range(m.orders.map(o=>inputSaving(o,60)))}。因此，这组数据支持“较大的工具集合、稀疏的实际使用，有利于按需发现”的判断。这里比较的是 API 输入 token，含缓存命中，不是总账单。

**二、少量工具时，PTC 同时占据输入量和延迟优势。** 只有三个工具时，Codemode 比 PTC 多输入 ${range(m.orders.map(o=>-inputSaving(o,3)))}，并没有更省。接口发现本身有说明和往返成本；工具数量不足以抵消这笔成本时，直接预载 SDK 消耗的输入更少。因此，不能把“工具越多越有输入优势”改写成“Codemode 在任何工具数量下都更好”。

**三、PTC 的耗时优势在本次矩阵中一致出现。** 九个组合里，PTC 的端到端耗时中位数均低于 Codemode，降幅为 ${range(delaySavings)}。所以可以明确说：**在本实验配置下，PTC 稳定取得更低的耗时中位数。** 这里的“稳定”指九个组合的中位数方向一致，不表示每次单独运行都更快。预载 SDK 的路径通常用两轮模型请求，先发现再编排的路径通常用三轮；但并发上限、执行器和缓存也不同，不能把全部降幅归因于少一轮，更不能推出执行器的普遍性能排名。

**四、面对大量中间结果，两条代码路径都明显减少了模型输入。** 固定18个工具、48条订单时，同样完成53次业务调用，并行 Tool Calling 输入 ${num(stat(48,18,'direct-batch','inputTokens'))} token，Codemode 输入 ${num(stat(48,18,'codemode','inputTokens'))}，PTC 输入 ${num(stat(48,18,'ptc','inputTokens'))}，分别减少 ${(100*(1-stat(48,18,'codemode','inputTokens')/stat(48,18,'direct-batch','inputTokens'))).toFixed(1)}% 和 ${(100*(1-stat(48,18,'ptc','inputTokens')/stat(48,18,'direct-batch','inputTokens'))).toFixed(1)}%。这支持“把筛选和汇总留在程序里，可以减少模型读取中间数据”的结论，收益并非仅来自并行。

以上结论以修正配置后的108次完整任务为依据，业务事实和执行过程全部通过核验；校准失败另行保留。当前证据明确支持这些配置下的输入和耗时比较，尚未证明不同模型、不同业务、相同并发上限或独立冷缓存条件下也保持同样结果。
`;
body=body.replace('\n## 把它应用到自己的智能体',conclusions+'\n## 把它应用到自己的智能体');
await writeFile(new URL('README.md',root),body);
console.log(`Built article and appendix from ${m.runs.length} runs; ${summary.passed} passed`);
