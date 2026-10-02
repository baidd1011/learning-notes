# 从工具调用到程序编排：Pi Codemode、DeepSeek Harness PTC 与融合实现

让模型处理一项任务时，工具接口怎样交给它，工具结果又怎样回到它的上下文？这两个边界决定了大量输入开销，也影响模型需要参与多少次决策。

Pi Codemode 和 DeepSeek Harness PTC（下文简称 DSH PTC）都允许模型写程序来调用工具。程序可以循环、并发、筛选和汇总，把许多已经明确的操作交给运行时。但它们准备接口说明的方式不同：本文配置下，Pi 按需发现 MCP 工具，Harness 则预先提供已注册工具的 SDK。把按需发现接到 PTC 前面，又能形成第三条路径。

我们先拆开这三种实现，再用订单核对和跨文件编码任务检验它们的取舍。结果没有给出一个永久赢家：**工具目录的大小影响接口说明成本，任务中的后续决策和错误恢复则可能改变整条路径的输入量与耗时。**

## 一次程序调用，为什么可以执行很多次工具调用

普通 Tool Calling 中，模型输出工具名和 JSON 参数，宿主执行工具，将结果加入消息历史，再请求模型决定下一步。模型也可以在一次响应里请求多个独立工具，宿主并行执行，所以并发并不是代码编排独有的能力。

代码编排改变的是模型每次提交的内容。模型通过外层 `codemode` 或 `run_code` 提交一段程序，程序里的 `tools.<name>(args)` 再触发实际工具调用。内部调用返回之后，程序可以立即处理数据、继续查询，不必为每一步都请求模型。

这里有三个不同的层次：

| 层次 | 负责什么 | 是否必然产生一次新的 LLM 请求 |
|---|---|---|
| 模型请求 | 理解任务，生成程序或决定下一步 | 是 |
| 程序里的工具调用 | 执行已经写进程序的循环、分支和调用 | 否 |
| MCP 请求 | 宿主通过协议访问实际工具服务 | 否 |

MCP 是访问工具服务的协议，不负责替模型推理。代码编排也没有替换 MCP；它改变了宿主调用 MCP 的组织方式，以及哪些结果会回到模型。

例如，程序先读取列表，再按已知规则核对候选，最后只返回统计。完整列表和核对结果仍经过服务、宿主和运行时，但可以不进入下一次模型请求。若程序把它们全部打印出来，这部分上下文收益就会消失。

## Pi Codemode：把发现和编排放进 QuickJS

### 模型看不到接口声明，宿主仍然拥有工具

Pi 的宿主维护工具目录，并把工具绑定为脚本中的 `tools.<name>()`。本文使用 Pi 1.0.0，配置 `codemode.mode: only`，MCP 工具使用 `exposure: codemode`。模型通过 Codemode 入口调用它们，首轮不预载完整业务工具声明。

这是所测配置的行为。Codemode 也可以与直接工具入口并存，一些工具声明还可以按 inline budget 放进入口描述，不能把按需发现当作所有配置的固定形式。

模型可以先写一个发现脚本：

```javascript
const hits = await searchTools("当前任务需要的能力", { limit: 3 });
for (const hit of hits) {
  text(await describeTool(hit.name));
}
```

`searchTools()` 在运行时检索宿主工具目录；本版本使用 BM25。`describeTool()` 返回接口说明，包含参数和输出声明。发现函数本身不需要再调用一次 LLM，只有脚本显式输出的内容才会回到模型。模型读到所需契约后，就能继续编写执行程序。

发现也有成本：模型要生成发现代码，发现结果要进入上下文，之后通常还需要一次模型请求来写实际程序。已有接口说明或已知工具名时，则可能不需要重新发现。轮数取决于策略与当前上下文。

### JavaScript 怎样走到真实 MCP 服务

Codemode 在 QuickJS-WASM 中运行模型生成的源码。宿主注入发现函数和工具绑定，内部工具调用经过 Pi 的 `ctx.executeTool()` 管线，再访问实际服务，仍有调用事件、错误结果和父调用关联。

QuickJS 没有 Node API，也没有直接文件系统、网络和计时器。获准的外部能力通过宿主工具提供。例如编码时，脚本可以调用一个宿主注册的文件编辑工具，但不能据此认为 QuickJS 自身获得了任意文件访问能力。

下面用通用接口展示数据边界，名称与字段仅作示意：

```javascript
function unpack(result) {
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent ??
    JSON.parse(result.content.find(b => b.type === "text").text);
}

const { items } = unpack(await tools.mcp__service__list({}));
const selected = items.filter(item => item.needsCheck);
const checked = await Promise.all(selected.map(async item =>
  unpack(await tools.mcp__service__inspect({ id: item.id }))
));
text({ checkedCount: checked.length });
```

本文 Pi 的 MCP 绑定返回 `CallToolResult` 包装，脚本检查错误后解包。原始数据保留在局部变量里，模型收到的是显式输出和执行状态。`text()`、顶层 `return`、`console.log()` 都可能形成输出，框架不会自动判定哪个字段可以省略。

所有发现与工具调用都要正确等待 Promise。脚本结束时仍在执行的调用会被取消；已经完成的外部修改也不会因为后续脚本报错而自动回滚。小型跨调用状态可以用 `store()/load()` 保存，不能把它当成无限原始数据缓存。

对应实现见 [Pi 路径](demo/engine.mjs)与[编码路径](demo/coding-pi.mjs)。框架接口可对照 [Pi 1.0.0 Codemode 文档](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/codemode.md)。

## DeepSeek Harness PTC：先生成接口 SDK，再让程序调用宿主

### SDK 是进入提示的接口契约

PTC 是 Programmatic Tool Calling。本文使用 DeepSeek Harness 0.2.0-rc.2 的官方 ToolRuntime、SDK 生成器、AgentLoop 和 Node PTC 执行器。

宿主注册工具的名称、描述、输入与输出 schema、执行函数及调度策略。在 `mode: ptc` 下，模型通过外层 `run_code` 提交程序，注册工具则生成 `tools:sdk` 提示段。对于 Node 执行器，这段说明包含 TypeScript 接口，例如：

```typescript
// 接口结构示意；实际声明由宿主注册的 schema 生成。
declare const tools: {
  mcp__service__read_file(args: { path: string }):
    Promise<{ path: string; text: string }>;
};
```

SDK 告诉模型如何写 `tools.<name>(args)`，不包含工具服务的实现源码，也不是新的一批模型直接调用入口。请求的 JSON tools 数组可以只有 `run_code`，系统提示却仍然携带 SDK。**JSON tools 少，不等于输入 token 少。**

本仓库的全量 DSH PTC 路径注册了服务目录中的全部工具，所以工具数增加时，SDK 随之增长。Harness 可以只注册或暴露选中的工具，全量预载是本文对照路径的配置选择。

### SDK 绑定怎样执行调用

官方 Node PTC 在子进程中执行程序，处理可擦除的 TypeScript 语法，并建立宿主控制通道。程序里的 `tools.<name>()` 将工具名和 JSON 参数送回宿主，宿主查找注册工具、调度执行，再把结果交还程序的 Promise。

内部调用可以出现在 `tool/ptc-dispatch` 等会话事件中，但不会全部作为独立的原始工具消息交给模型。宿主保存的完整日志与模型读取的上下文是不同的数据通道。

本文 MCP bridge 检查并解包 MCP 结果，再把 canonical JSON 交给 Harness，所以前面的程序在 PTC 中可以直接访问字段：

```javascript
const { items } = await tools.mcp__service__list({});
const selected = items.filter(item => item.needsCheck);
const checked = await Promise.all(selected.map(item =>
  tools.mcp__service__inspect({ id: item.id })
));
return { checkedCount: checked.length };
```

两边访问同一个 MCP 服务，差别来自适配层：Pi 脚本解包，本文 PTC bridge 解包。生成 SDK 也不改变底层业务协议。

`Promise.all()` 表达并发意图，实际执行数量还取决于宿主调度器。本文 PTC 子调用上限为 8，待处理容量为 64；排队容量与执行并发是两个参数。Node 子进程的能力则由后端和策略控制，不能与 QuickJS 的能力边界等同。本机 Windows 后端记录的文件沙箱 enforcement 为 partial。

具体组合见 [PTC 实现](demo/ptc.mjs)与[编码 PTC 实现](demo/coding-ptc.mjs)，框架说明见 [Harness 工具运行时](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/core/tools/README.md)及 [Node PTC 执行器](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/ptc-runtime/ptc-runtime-node/README.md)。这里比较的是官方核心组件的组合，没有启动完整 Harness 产品或加载个人配置。

## 融合：先发现工具，再现场生成小 SDK

按需发现与 PTC 执行可以组合。首轮只提供 Codemode 入口，模型在运行时检索接口并返回工具名。宿主据此取出权威契约，仅注册这些工具，使用 Harness 官方生成器准备 SDK；后续请求切换到 `run_code`，交由 Node PTC 执行。

工具注册表可以理解成下面的映射：

```text
工具名 → description、inputSchema、outputSchema、execute
```

发现之后，查表、schema 转换和运行时绑定都是确定性的宿主操作，**不需要额外 LLM 参与**。SDK 是生成的接口说明与调用绑定，不是现场编译一个 npm 包。模型仍负责前面的工具发现，以及后面的编程和修正。

本实现保留实际的用户消息、模型 Codemode 调用和发现结果，将它们接入 Harness 后续请求。它是 Pi 与 Harness 之间的显式宿主交接，两边各有初始化成本；不能把它描述成 Harness 原生的一条统一 Agent loop。

融合只在选中的工具比原目录少时裁剪 SDK。如果目录只有五个工具，任务也需要全部五个，SDK 不会变小，发现代码和历史消息却仍会增加输入。另一方面，交接后的初始上下文也可能改变模型如何组织后续程序，这需要用实际行为验证。

| 维度 | 本文 Codemode | 本文全量 DSH PTC | 本文融合 |
|---|---|---|---|
| 模型入口 | `codemode` | `run_code` | 首轮 `codemode`，后续 `run_code` |
| 接口说明 | 运行时按需发现 | 注册目录的 SDK 预载 | 发现选中接口，再生成 SDK |
| 执行器 | QuickJS-WASM | 官方 Node PTC | QuickJS 发现，Node PTC 执行 |
| 模型读取的结果 | 显式发现、程序输出和状态 | 程序输出和状态 | 发现历史、程序输出和状态 |
| 后续决策 | 可继续调用 Codemode | 可继续调用 PTC | 可继续调用 PTC |

实现入口是[订单融合](demo/hybrid.mjs)与[编码融合](demo/coding-hybrid.mjs)。可审计的真实请求体保存在附件中的 `wirePayload`，不通过宿主替模型补选接口。

## 节省输入的前提：程序已经知道该怎样处理数据

当后续操作有明确规则时，程序适合接管循环、关联、排序和汇总。例如读完列表，根据字段筛出候选，再核对状态；模型可以提前写出这条依赖链，只读取最后的报告。

编码任务不同。搜索结果往往只是起点，模型还要读函数契约、理解调用点、选择修改方式，再根据编译和测试诊断修正。程序可以批量读取或编辑已经确定的文件，但不能保证提前知道所有后续决策。此时，必要源码和诊断仍应进入模型，过度压缩可能让模型按错误的规律修改。

总输入还包含接口说明、生成程序的历史、工具输出和恢复过程。同样的执行器，生成一段正确的批量程序与反复输出源码、重试错误替换，会有很不同的成本。输出 token 与缓存命中也会影响账单，因此本文分别记录它们，**不把输入减少比例直接写成费用减少比例**。

## 订单任务：观察接口目录与中间数据的开销

订单任务筛出支付超过 72 小时仍未发货的订单，核对全部候选的支付和物流，再输出等待最久的前三条。所有数据及审计字段均为合成数据，服务是同一个只读 stdio MCP 进程。

第一组比较逐步 Tool Calling、并行 Tool Calling、Codemode 和全量 DSH PTC。订单数为 1、12、48，工具数为 3、18、60，每个组合重复三次，共 108 个完整任务，全部通过事实与调用过程核验。工具增加只加入无关接口，实际需要的业务接口始终是三个。

固定 12 条订单，只增加工具目录，得到以下输入中位数；input token 包含缓存命中：

| 工具数 | 并行 Tool Calling 输入 | Codemode 输入 | 全量 DSH PTC 输入 |
|---|---:|---:|---:|
| 3 | 10,871 | 5,655 | 4,671 |
| 18 | 17,091 | 7,582 | 7,855 |
| 60 | 34,414 | 6,093 | 16,778 |

三个工具时，Codemode 的发现开销还没有抵消 SDK 预载成本。60 个工具时，Codemode 相比全量 DSH PTC 少输入 63.7%–64.4%。这支持的是“工具多、实际使用稀疏时，按需说明有输入优势”，不支持 Codemode 在任何工具数量下都更省。

中间数据规模也会改变收益。固定 18 个工具、48 条订单，三条路径均完成 53 次业务调用：并行 Tool Calling 输入 53,689 token，Codemode 输入 6,066，PTC 输入 7,858。代码内筛选与汇总分别减少 88.7% 和 85.4% 的输入；并行本身仍会把原始结果带回模型。

在这组配置下，全量 DSH PTC 在九个组合的耗时中位数都低于 Codemode，降幅为 8.9%–36.5%。但提示要求 Codemode 先发现再编排，PTC 则用预载 SDK 写一段程序，因此通常是三轮和两轮；大数据组 Pi 可达 52 路核对，PTC 上限为 8。**这里的时间比较包含提示策略、缓存、启动和并发差异，不是执行器的纯性能比较。** 1 条订单没有候选，也只代表边界情况。

第二组单独比较 Codemode、全量 DSH PTC 和融合，共 81 个任务，全部通过。固定 60 个工具的结果如下，输入和耗时均为各组三次成功任务的中位数：

| 订单数 / 60工具 | 输入 token：Codemode / PTC / 融合 | 耗时 ms：Codemode / PTC / 融合 |
|---|---:|---:|
| 1 | 5,904 / 16,542 / 5,794 | 4,712 / 3,334 / 3,803 |
| 12 | 6,093 / 16,765 / 6,027 | 4,615 / 4,199 / 4,244 |
| 48 | 7,584 / 16,770 / 6,298 | 4,637 / 3,714 / 5,093 |

融合只生成三个业务工具的 SDK，大小为 3504 字节；全量 DSH PTC 在 60 工具时为 26458 字节。融合少输入 62.4%–65.0%，但九个组合中，全量 DSH PTC 的耗时中位数仍都更低。发现、编排、总结通常需要三轮，SDK 生成没有额外 LLM 请求，也不会把这三轮自动合并成两轮。

两组数据独立统计。融合组沿用了暂停前的成功记录，发现提示经过校准，成功记录包含不同提示版本；它不是统一最终提示下重新跑出的矩阵。失败与校准记录单独保留，不进入上述成功任务中位数，也不代表包含重试的生产成本。完整条件见[订单证据说明](docs/matrix-evidence.md)和[融合采集说明](docs/hybrid-article.md)。

## 编码任务：输入与耗时开始取决于模型的修改策略

为了检查订单结论能否迁移，我们补了一个 TypeScript API 迁移任务：把全部 `client.request(url, options)` 改为 `client.send({url, ...options})`。新版客户端契约已提供，每个模块有两个调用点，包含内联参数和复用 options 的形式，要求保留请求、超时、响应变换及异常传播。

项目规模为 3、8、16 个模块。三条路径共享五个编码工具：列文件、搜索、读取、替换和测试，每次从相同源码快照开始。模型自主决定读取、修改和测试的顺序，没有固定修改程序，也不强制编码阶段的轮数。融合保留一次发现调用的交接协议。

验收先用 TypeScript 5.9.3 编译，再执行每模块四项行为检查。客户端、配置和测试不允许通过项目工具修改；最终源码还由外部验收重新编译和测试，并根据实际补丁调用重放。成功要求模型观察过通过的测试结果。这是有真实代码改动、类型检查和运行时验收的合成小项目，仍不具备大型真实仓库的复杂度。

共 27 个任务，24 个通过：Codemode 9/9，全量 DSH PTC 6/9，融合 9/9。下表中位数包含正式任务中的真实失败，而不是只挑成功运行：

| 模块数 | 路径 | 验收通过 | 模型轮数 | 输入 token | 耗时秒 |
|---|---|---:|---:|---:|---:|
| 3 | Codemode | 3/3 | 12 | 37,392 | 15.44 |
| 3 | 全量 DSH PTC | 1/3 | 24 | 150,886 | 26.56 |
| 3 | 融合 | 3/3 | 9 | 32,260 | 14.32 |
| 8 | Codemode | 3/3 | 12 | 52,055 | 15.96 |
| 8 | 全量 DSH PTC | 3/3 | 8 | 31,809 | 13.59 |
| 8 | 融合 | 3/3 | 6 | 24,076 | 11.79 |
| 16 | Codemode | 3/3 | 16 | 109,564 | 20.89 |
| 16 | 全量 DSH PTC | 2/3 | 22 | 286,101 | 37.59 |
| 16 | 融合 | 3/3 | 8 | 46,860 | 14.01 |

**这组编码任务中，融合在三个规模下都取得最低的输入量和耗时中位数；PTC“两轮、稳定更快”的订单结果没有延续。** 实际请求数为 6–24 轮，读源码、编辑和基于诊断修正都可能需要模型再次决策。

三次 PTC 失败也说明了为什么要先验收再比较成本。两次 3 模块任务里，源码和搜索结果正常返回，模型反复搜索却没有执行编辑；一次 16 模块任务按错误的模块规律构造替换文本，反复收到旧文本不存在的错误，最终留下 8 个模块的旧调用。它们用满 24 轮预算，作为失败保留，没有重跑到成功后覆盖。

这里的五个工具全部被融合选中，融合与全量 DSH PTC 的 SDK 相同，均为 3111 字节。**融合的表现不能归因于目录裁剪。** 初始提示、发现历史和执行器会影响模型如何组织操作；本次融合产生了更少往返的编排策略，但还没有证明是哪项因素导致。

项目工具的并发上限为 8，同一文件编辑串行。每个编码执行阶段允许最多 24 轮，融合额外允许一个发现请求；融合实际最多 10 轮，没有触及该上限。宿主发现结果的格式兼容问题在校准后修正，只提取对象中已有的工具名，原失败附件保留，业务提示没有改变。Windows PTC 的部分文件沙箱提示也原样进入了模型上下文，可能影响其行为。完整记录与重建方式见[编码采集与验收说明](docs/coding-article.md)。

## 这些结果怎样指导实现选择

现在可以把结论写得更具体：

| 任务特征 | 当前证据支持的判断 |
|---|---|
| 大工具目录，每次只用少量接口 | 按需发现可以减少接口说明输入，订单两组数据支持这一点 |
| 操作规则明确，原始结果长，最终报告短 | 程序内处理可以减少模型读取中间数据，收益不只来自并行 |
| 工具少、契约已知、依赖链能提前写出 | 本次订单配置下，预载 SDK 的 PTC 输入或耗时更有优势 |
| 需要理解源码、修改并根据诊断继续决策 | 编排策略与恢复过程更重要，不能预设两轮完成或固定速度排名 |
| 把发现接到 PTC 前面 | 机制可行；是否有收益取决于目录裁剪、交接成本和模型后续行为 |

因此，不能再用“PTC 更快，Codemode 更省”概括全部结果。更可用的选择方式是先判断接口说明是否值得按需加载，再判断哪些操作能交给程序完成，最后在目标任务上同时验收正确性与资源开销。

本文所有在线任务使用 DeepSeek 官方 `deepseek-flash`，关闭 thinking，temperature 为 0，max_tokens 为 6000；Pi 1.0.0、Harness 0.2.0-rc.2、Windows / Node 24.14.1。每格只有三次重复，缓存未清空，提示、返回包装与执行器并非单变量对照。订单融合组还有提示版本混合，编码任务则是一个合成项目。**这些证据支持当前实现与配置下的比较，不支持通用框架排名、跨模型成功率，或总账单同比下降。**

## 代码、数据与复现

文章中的表格和比例由[生成脚本](scripts/build-article.mjs)读取已冻结结果生成。三组结果分别存放，未合并成一个总体分数：

| 数据组 | 逐次指标 | 聚合数据 | 完整记录索引 |
|---|---|---|---|
| 四路径订单 | [CSV](results/matrix/metrics.csv) | [summary](results/matrix/summary.json) | [manifest](results/matrix/manifest.json) |
| 订单融合 | [CSV](results/hybrid/metrics.csv) | [summary](results/hybrid/summary.json) | [manifest](results/hybrid/manifest.json) |
| 编码迁移 | [CSV](results/coding/metrics.csv) | [summary](results/coding/summary.json) | [manifest](results/coding/manifest.json) |

manifest 索引的 gzip 附件包含真实请求体、API usage、响应、生成代码和实际调用，编码附件还包含初始与最终源码。压缩只为减少仓库体积。公开记录替换了本机绝对路径，采集时的字节指标保留原值；字节不等于 token。API Key、Authorization header 和个人配置未上传。

先核验已有证据，不需要在线 API Key：

```powershell
git clone https://github.com/baidd1011/pi-codemode-vs-ptc.git
cd pi-codemode-vs-ptc
node scripts/verify-evidence.mjs
node scripts/verify-matrix.mjs
node scripts/verify-hybrid.mjs
cd demo
node setup-coding.mjs
cd ..
node scripts/verify-coding.mjs
```

编码核验会在本地新建临时项目，重放补丁、编译并测试最终源码。若要重新在线运行，先安装锁定依赖，并在本机从 `.env.example` 创建 `.env.local` 填写 Key：

```powershell
cd demo
npm ci
node setup-ptc.mjs
node setup-coding.mjs
node online.mjs --check
node matrix.mjs        # 四路径订单
node hybrid-matrix.mjs # 订单融合
node coding-matrix.mjs # 编码迁移
```

在线运行会消耗 API 用量，结果写入本机 `demo/output/`。运行器按任务 ID 续跑；校准与失败的处理规则以各组说明为准。未形成完整记录的中断运行不计入完成任务统计，但可能已产生用量。本文输入与耗时统计也没有把所有校准重试成本摊入正式任务。

原订单 Demo 可用 `node server.mjs` 打开 <http://127.0.0.1:4317/>，展示已有单组记录；矩阵和编码结果通过本文链接的附件查看，界面没有增加对应选择器。更多运行入口见 [Demo 说明](demo/README.md)。
