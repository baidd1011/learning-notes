# From Tool Calls to Programmatic Orchestration: Pi Codemode, DeepSeek Harness PTC, and a Hybrid

[简体中文](README.md) | **English**

When a model handles a task, how does it receive tool interfaces, and which tool results return to its context? These two boundaries account for substantial input overhead and affect how often the model must make another decision.

Pi Codemode and DeepSeek Harness PTC (DSH PTC below) both let the model write programs that call tools. Programs can loop, run independent calls concurrently, filter, and aggregate, leaving already specified operations to the runtime. Their interface disclosure differs: in the configurations tested here, Pi discovers MCP tools on demand, while Harness supplies the registered tools' SDK up front. Putting discovery before PTC creates a third path.

We explain these implementations first, then use order reconciliation and cross-file coding tasks to examine their tradeoffs. The results do not identify a permanent winner: **catalog size affects interface-description overhead, while subsequent decisions and error recovery can change total input and task duration.**

## How one program invocation can execute many tool calls

With ordinary tool calling, the model emits a tool name and JSON arguments. The host executes the tool, adds its result to message history, and asks the model what to do next. A single response can request several independent tools for the host to run concurrently, so concurrency is also available without programmatic orchestration.

Programmatic orchestration changes what the model submits. An outer `codemode` or `run_code` call carries a program; its `tools.<name>(args)` expressions trigger actual tool executions. After an inner call returns, the program can process data and continue querying without requesting another model decision for each step.

| Layer | Responsibility | Necessarily creates a new LLM request? |
|---|---|---|
| Model request | Understand the task, generate a program, or choose the next action | Yes |
| Tool call inside a program | Execute the specified loops, branches, and calls | No |
| MCP request | Access the actual tool service through the protocol | No |

MCP is a protocol for accessing tool services; it does not perform reasoning for the model. Programmatic orchestration changes how the host organizes MCP calls and which results return to the model.

For example, a program can read a list, check candidates according to known rules, and return only statistics. The full list and check results still pass through the service, host, and runtime, but need not enter the next model request. Printing all of them removes that context-saving benefit.

## Pi Codemode: discovery and orchestration inside QuickJS

### The host retains tools whose declarations the model has not received

Pi's host maintains a catalog and binds tools as `tools.<name>()` inside scripts. We use Pi 1.0.0 with `codemode.mode: only` and MCP tool `exposure: codemode`. The model accesses these tools through Codemode; the first request does not preload full business-tool declarations.

This describes our tested configuration. Codemode can coexist with direct tool entry points, and declarations can be included in the entry-point description within an inline budget. On-demand discovery is not mandatory in every configuration.

The model can start with a discovery script:

```javascript
const hits = await searchTools("capabilities needed for this task", { limit: 3 });
for (const hit of hits) {
  text(await describeTool(hit.name));
}
```

`searchTools()` queries the host catalog at runtime using BM25 in this version. `describeTool()` returns interface documentation, including input and output declarations. These functions do not themselves make another LLM request. Only explicitly emitted discovery results return to the model, which can then write an execution program using those contracts.

Discovery has overhead: the model generates discovery code, its results enter history, and another model request is usually needed to write the actual program. Already available interface documentation or known tool names may avoid rediscovery. Request count depends on strategy and context.

### From JavaScript to a real MCP service

Codemode executes model-written source in QuickJS-WASM. The host injects discovery helpers and tool bindings. Inner calls go through Pi's `ctx.executeTool()` pipeline and reach the actual services, retaining call events, error results, and parent-call associations.

QuickJS has no Node APIs or direct filesystem, network, or timer access. Approved external capabilities are supplied through host tools. Calling a registered file-editing tool does not grant QuickJS arbitrary filesystem access.

The following generic interfaces illustrate the data boundary; names and fields are examples:

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

Our Pi MCP bindings return `CallToolResult` wrappers, which the script checks and unpacks. Raw data remains in local variables; the model receives explicit output and execution status. `text()`, top-level `return`, and `console.log()` can all produce output. The framework does not automatically decide which fields to omit.

Discovery and tool calls must correctly await their promises. Calls still running when the script ends are cancelled; completed external modifications are not automatically rolled back if a later expression fails. `store()/load()` can preserve small amounts of state across invocations, but should not be treated as unlimited raw-data storage.

See the [Pi path](demo/engine.mjs), [coding path](demo/coding-pi.mjs), and [Pi 1.0.0 Codemode documentation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/codemode.md).

## DeepSeek Harness PTC: generate an interface SDK, then call the host from code

### The SDK is an interface contract in the prompt

PTC means Programmatic Tool Calling. We use the official ToolRuntime, SDK generator, AgentLoop, and Node PTC executor from DeepSeek Harness 0.2.0-rc.2.

The host registers tool names, descriptions, input/output schemas, execution functions, and scheduling policies. In `mode: ptc`, the model submits programs through `run_code`; registered tools generate a `tools:sdk` prompt section. For the Node executor, this includes TypeScript interfaces such as:

```typescript
// Illustrative structure; actual declarations come from registered schemas.
declare const tools: {
  mcp__service__read_file(args: { path: string }):
    Promise<{ path: string; text: string }>;
};
```

The SDK explains how to write `tools.<name>(args)`. It contains neither service implementation source nor an additional set of directly callable model tools. The request's JSON tools array may contain only `run_code`, while the system prompt still carries the SDK. **Fewer JSON tools do not necessarily mean fewer input tokens.**

Our full-SDK DSH PTC path registers every tool in the service catalog, so SDK size grows with tool count. Harness can register or expose selected tools instead; full preloading is a configuration choice for this baseline.

### How SDK bindings execute calls

The official Node PTC runtime executes programs in subprocesses, handles erasable TypeScript syntax, and establishes a host control channel. `tools.<name>()` sends the name and JSON arguments to the host, which resolves the registered tool, schedules execution, and returns a result to the program's promise.

Inner calls can appear in session events such as `tool/ptc-dispatch`, without all becoming independent raw tool messages for the model. Complete host logs and model-visible context are separate data channels.

Our MCP bridge checks and unpacks MCP results before passing canonical JSON to Harness. The equivalent PTC program can therefore access fields directly:

```javascript
const { items } = await tools.mcp__service__list({});
const selected = items.filter(item => item.needsCheck);
const checked = await Promise.all(selected.map(item =>
  tools.mcp__service__inspect({ id: item.id })
));
return { checkedCount: checked.length };
```

Both paths use the same MCP service. The adapter differs: the Pi script unpacks results, whereas our PTC bridge does so. SDK generation does not change the underlying business protocol.

`Promise.all()` expresses concurrency intent; actual execution depends on the host scheduler. Our PTC inner-call concurrency limit is 8, with pending-call capacity 64. Queue capacity and execution concurrency are distinct parameters. Node subprocess capabilities depend on the backend and policy; they have different boundaries from QuickJS. Our Windows backend reported partial filesystem sandbox enforcement.

See the [PTC implementation](demo/ptc.mjs), [coding PTC implementation](demo/coding-ptc.mjs), [Harness tool runtime](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/core/tools/README.md), and [Node PTC executor](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/ptc-runtime/ptc-runtime-node/README.md). We compose official core components rather than launch the complete Harness product or load personal configurations.

## Hybrid: discover tools, then generate a smaller SDK on demand

On-demand discovery can precede PTC execution. The first request exposes only Codemode; the model searches interfaces at runtime and returns tool names. The host retrieves their authoritative contracts, registers only those tools, and prepares the SDK with the official Harness generator. Subsequent requests use `run_code` and Node PTC.

The registry is a mapping:

```text
tool name → description, inputSchema, outputSchema, execute
```

Lookup, schema conversion, and runtime binding are deterministic host operations requiring **no additional LLM involvement**. The SDK consists of generated interface documentation and call bindings, rather than an npm package compiled on the spot. The model still performs discovery and subsequent programming and correction.

We preserve the actual user messages, model Codemode call, and discovery results in the subsequent Harness requests. This is an explicit handoff between Pi and Harness, with initialization costs on both sides; it is not a native unified Harness agent loop.

The hybrid reduces SDK size only when the selected set is smaller than the catalog. If all five available tools are needed, the SDK stays the same size, while discovery code and history add input. The handoff context may also change how the model organizes later programs; actual behavior must be examined.

| Dimension | Our Codemode path | Our full-SDK DSH PTC path | Our hybrid |
|---|---|---|---|
| Model entry point | `codemode` | `run_code` | `codemode` first, then `run_code` |
| Interface documentation | Discovered at runtime | Registered catalog's SDK preloaded | Discover selected interfaces, then generate SDK |
| Executor | QuickJS-WASM | Official Node PTC | QuickJS discovery, Node PTC execution |
| Model-visible results | Explicit discovery results, program output, status | Program output and status | Discovery history, program output, status |
| Further decisions | Additional Codemode calls | Additional PTC calls | Additional PTC calls |

See the [order hybrid](demo/hybrid.mjs) and [coding hybrid](demo/coding-hybrid.mjs). Actual request bodies are preserved as `wirePayload` in the evidence attachments. The host does not select missing interfaces on the model's behalf.

## Saving input requires the program to know how to process the data

Programs can take over loops, joins, sorting, and aggregation when subsequent operations follow explicit rules. Reading a list, filtering by fields, and checking candidate statuses can be specified in advance; the model needs only the final report.

Coding tasks often require further decisions. Search results are a starting point: the model must read contracts, understand call sites, choose edits, and respond to compiler and test diagnostics. A program can batch known reads or edits, but cannot guarantee that every later decision is known up front. Necessary source and diagnostics should still reach the model; excessive compression can encourage incorrect assumptions.

Total input includes interface documentation, generated-code history, tool output, and recovery. The same executor can incur very different overhead when generating a correct batch program versus repeatedly printing source or retrying invalid replacements. Output tokens and cache hits also affect billing, so we record them separately and **do not equate input reductions with monetary savings**.

## Order tasks: interface catalogs and intermediate-data overhead

The task identifies orders paid more than 72 hours ago but not shipped, checks payment and shipping for every candidate, and reports the three longest-waiting orders. All data and audit fields are synthetic. Every path uses the same read-only stdio MCP service.

The first experiment compares sequential tool calling, batched tool calling, Codemode, and full-SDK DSH PTC. It uses 1/12/48 orders and 3/18/60 tools, with three repetitions per cell: 108 complete tasks, all passing factual and call-process checks. Extra tools are irrelevant interfaces; the task always needs the same three business tools.

For 12 orders, median input changes with catalog size as follows. Input includes cache-hit tokens:

| Tools | Batched tool calling input | Codemode input | Full-SDK DSH PTC input |
|---|---:|---:|---:|
| 3 | 10,871 | 5,655 | 4,671 |
| 18 | 17,091 | 7,582 | 7,855 |
| 60 | 34,414 | 6,093 | 16,778 |

At three tools, Codemode's discovery overhead does not offset SDK preloading. At 60 tools, Codemode uses 63.7%–64.4% less input than full-SDK DSH PTC. This supports an input advantage for on-demand interfaces when catalogs are large and usage is sparse, rather than universal savings at every tool count.

Intermediate-data size also matters. With 18 tools and 48 orders, each path performs 53 business calls: batched tool calling uses 53,689 input tokens, Codemode 6,066, and PTC 7,858. In-program filtering and aggregation reduce input by 88.7% and 85.4%, respectively. Batching alone still returns raw results to the model.

Full-SDK DSH PTC has lower median wall time in all nine cells, by 8.9%–36.5%. However, our prompt requires Codemode discovery before orchestration, while PTC uses preloaded SDK documentation, usually producing three versus two model requests. Pi can submit 52 checks concurrently in the largest case, while PTC execution is capped at 8. **The time comparison includes prompt strategy, cache, initialization, and concurrency differences; it does not isolate executor performance.** The one-order case has no candidates and represents an edge case.

A separate experiment compares Codemode, full-SDK DSH PTC, and the hybrid: 81 tasks, all passed. At 60 tools, the following input and time figures are medians of three successful tasks per cell:

| Orders / 60 tools | Input tokens: Codemode / PTC / hybrid | Time (ms): Codemode / PTC / hybrid |
|---|---:|---:|
| 1 | 5,904 / 16,542 / 5,794 | 4,712 / 3,334 / 3,803 |
| 12 | 6,093 / 16,765 / 6,027 | 4,615 / 4,199 / 4,244 |
| 48 | 7,584 / 16,770 / 6,298 | 4,637 / 3,714 / 5,093 |

The hybrid generates an SDK for three business tools, totaling 3504 bytes, versus 26458 bytes for full-SDK DSH PTC at 60 tools. It uses 62.4%–65.0% less input, but full-SDK DSH PTC still has lower median time in all nine cells. Discovery, execution, and final reporting usually require three requests. SDK generation adds no LLM request, but does not automatically collapse those three requests into two.

The two experiments are aggregated separately. The hybrid collection retains successful runs from before a pause and includes calibrated discovery prompt versions; it is not a fresh matrix collected under one final prompt. Failed and calibration records are retained separately and excluded from these successful-task medians, which do not represent production cost including retries. See the [order evidence](docs/matrix-evidence.md) and [hybrid collection notes](docs/hybrid-article.md).

## Coding tasks: editing strategy changes input and duration

To test whether the order findings transfer, we added a TypeScript API migration: replace every `client.request(url, options)` with `client.send({url, ...options})`. The new client contract is supplied. Each module has two call sites using inline arguments or reused options, with request behavior, timeouts, response transforms, and exception propagation preserved.

Projects contain 3/8/16 modules. All paths share five tools: list files, search, read, replace, and test. Each starts from the same source snapshot. The model chooses the read/edit/test sequence without a fixed migration program or enforced coding request count. The hybrid retains its one-request discovery handoff.

Validation compiles with TypeScript 5.9.3 and runs four behavioral checks per module. Project tools cannot modify the client, configuration, or tests. An external grader independently recompiles and tests the final source, with reconstruction from actual patch calls. Success also requires the model to have observed passing test results. This synthetic project involves real source edits, type checking, and runtime validation, but lacks the complexity of a large real repository.

Of 27 tasks, 24 pass: Codemode 9/9, full-SDK DSH PTC 6/9, and hybrid 9/9. The medians below include genuine failures in the primary collection, rather than successful runs only:

| Modules | Path | Passed | Model requests | Input tokens | Time (s) |
|---|---|---:|---:|---:|---:|
| 3 | Codemode | 3/3 | 12 | 37,392 | 15.44 |
| 3 | Full-SDK DSH PTC | 1/3 | 24 | 150,886 | 26.56 |
| 3 | Hybrid | 3/3 | 9 | 32,260 | 14.32 |
| 8 | Codemode | 3/3 | 12 | 52,055 | 15.96 |
| 8 | Full-SDK DSH PTC | 3/3 | 8 | 31,809 | 13.59 |
| 8 | Hybrid | 3/3 | 6 | 24,076 | 11.79 |
| 16 | Codemode | 3/3 | 16 | 109,564 | 20.89 |
| 16 | Full-SDK DSH PTC | 2/3 | 22 | 286,101 | 37.59 |
| 16 | Hybrid | 3/3 | 8 | 46,860 | 14.01 |

**The hybrid has the lowest median input and time at all three coding sizes; the order experiment's two-request, consistently faster PTC result does not carry over.** Actual request counts range from 6–24. Reading source, editing, and responding to diagnostics can require repeated model decisions.

The three PTC failures show why correctness must precede cost comparisons. In two three-module runs, source and search results returned normally, but the model repeatedly searched without editing. In one 16-module run, it assumed an incorrect module pattern and repeatedly attempted replacements whose old text did not exist, leaving eight modules unmigrated. These runs exhausted the 24-request budget and remain failures; they were not rerun until success and overwritten.

The hybrid selects all five tools here. Its SDK matches full-SDK DSH PTC at 3111 bytes. **Its performance cannot be attributed to catalog pruning.** Initial prompts, discovery history, and executors can affect orchestration. The hybrid generated strategies with fewer model round trips, but this experiment does not establish which factor caused that behavior.

Project-tool concurrency is capped at 8, with edits to the same file serialized. Each coding execution phase permits 24 requests, and the hybrid allows one additional discovery request; the hybrid actually uses at most 10 requests and does not reach its limit. A host compatibility issue in discovery-result formatting was corrected after calibration by extracting only existing tool names from objects. Original failed attachments remain, and business prompts were unchanged. Windows PTC's partial filesystem sandbox messages also reached model context and may have influenced behavior. See the [coding collection and validation notes](docs/coding-article.md).

## What these results suggest for implementation choices

| Task characteristic | Judgment supported by current evidence |
|---|---|
| Large catalog, few interfaces used per task | On-demand discovery reduces interface-description input in both order experiments |
| Explicit rules, long raw results, short final report | In-program processing reduces intermediate data read by the model; benefits extend beyond concurrency |
| Few tools, known contracts, a dependency chain specified in advance | Preloaded-SDK PTC has input or time advantages in our order configuration |
| Source understanding, editing, and decisions based on diagnostics | Strategy and recovery matter; do not assume two requests or a fixed speed ranking |
| Discovery before PTC | Feasible; benefits depend on catalog pruning, handoff overhead, and subsequent model behavior |

“PTC is faster; Codemode is cheaper” does not describe all these results. First decide whether interfaces warrant on-demand loading, then which operations can be specified in a program, and finally validate both correctness and resource use on the target task.

**Cache hits affect billing and time, but do not change our cumulative-input accounting.** Input includes both cache hits and misses. Full-SDK PTC has a larger fixed prefix that may be reused on subsequent requests. On-demand disclosure reduces initial documentation, but rewriting earlier tool declarations or SDK text may affect prefix reuse. A higher hit rate therefore does not imply less input or a lower bill, and an input reduction cannot be directly converted to a cost reduction. Billing should separately price cache-hit input, cache-miss input, and output. Cache mainly affects input processing and time to first token; total task duration also includes generation, tool execution, and request count.

We neither clear caches nor run independent cold/warm-cache controls, so observed speed differences cannot be attributed solely to executors or cache. **On-demand disclosure reduces cumulative input in our large-catalog, sparse-use order tasks; monetary benefits and the cache contribution to latency require per-request usage and separate controlled validation.** DeepSeek reuses matching persisted prefix units on a best-effort basis; see the [official cache guide](https://api-docs.deepseek.com/guides/kv_cache/).

All online tasks use official DeepSeek `deepseek-flash`, thinking disabled, temperature 0, max_tokens 6000; Pi 1.0.0, Harness 0.2.0-rc.2, Windows / Node 24.14.1. Each cell has only three repetitions. Caches were not cleared, and prompts, result wrappers, and executors are not a single-variable comparison. The order hybrid collection mixes prompt versions; coding uses one synthetic project. **The evidence supports comparisons under these implementations and configurations, rather than general framework rankings, cross-model success rates, or proportional total-bill reductions.**

## Code, evidence, and reproduction

The [article generator](scripts/build-article.mjs) renders tables and percentages from frozen results. The three collections remain separate rather than being combined into one score:

| Collection | Per-run metrics | Aggregates | Complete-record index |
|---|---|---|---|
| Four-path orders | [CSV](results/matrix/metrics.csv) | [summary](results/matrix/summary.json) | [manifest](results/matrix/manifest.json) |
| Order hybrid | [CSV](results/hybrid/metrics.csv) | [summary](results/hybrid/summary.json) | [manifest](results/hybrid/manifest.json) |
| Coding migration | [CSV](results/coding/metrics.csv) | [summary](results/coding/summary.json) | [manifest](results/coding/manifest.json) |

Manifest-indexed gzip attachments contain actual request bodies, API usage, responses, generated code, and executed calls; coding records also include initial and final source. Compression reduces repository size only. Public records replace local absolute paths; byte metrics retain their originally collected values. Bytes are not tokens. API keys, Authorization headers, and personal configurations are not uploaded.

Verify existing evidence without an online API key:

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

Coding verification creates local temporary projects, replays patches, and compiles and tests final source. To run new online experiments, install locked dependencies and create a local `.env.local` from `.env.example` with your key:

```powershell
cd demo
npm ci
node setup-ptc.mjs
node setup-coding.mjs
node online.mjs --check
node matrix.mjs        # Four-path orders
node hybrid-matrix.mjs # Order hybrid
node coding-matrix.mjs # Coding migration
```

Online runs consume API usage and write to local `demo/output/`. Runners resume by task ID; calibration and failure rules are documented per collection. Interrupted runs without complete records are excluded from completed-task statistics but may have incurred usage. Published input and time statistics do not amortize every calibration retry into primary tasks.

The original order demo opens at <http://127.0.0.1:4317/> using `node server.mjs` and displays existing single-case records. Matrix and coding results are available through the linked attachments; the UI has no corresponding selectors. See [Demo instructions (Chinese)](demo/README.md) for other entry points. Detailed methodology appendices remain in Chinese; this file is the complete English version of the main article.
