# 四路径订单核对 Demo

技术文章、实验方法和已测结果见[仓库首页](../README.md)。

本 Demo 使用合成数据；Pi 固定回放不会调用在线 API，在线模式会实际消耗所配置 DeepSeek 账号的 API 用量。

在此目录使用 Node 24.14.1：

```powershell
npm ci
node setup-ptc.mjs
node verify.mjs
node verify-ptc.mjs
node server.mjs
```

浏览器打开 <http://127.0.0.1:4317/>。首次启动载入仓库[公开运行记录](../results/online-2026-10-02.json)，新运行保存到本机 `output/`。

在线运行前，在本机把 `.env.example` 复制为 `.env.local` 并填写 `DEEPSEEK_API_KEY`，然后：

```powershell
node online.mjs --check
node online.mjs
```

`node run.mjs` 会重新执行三条 Pi 固定回放路径并更新本机 latest 记录，外部 LLM 请求为 0；不把回放 token 当作在线用量。PTC 无 Key 验证由 `node verify-ptc.mjs` 单独执行。

主要实现：

| 文件 | 职责 |
| --- | --- |
| `engine.mjs` | 三条 Pi 路径及四路径对照入口 |
| `ptc.mjs` | 官方 Harness AgentLoop / ToolRuntime / SDK / Node PTC，stdio MCP bridge |
| `deepseek.mjs` | 本地配置、真实 HTTP 适配及 usage 采集 |
| `prompts.mjs` | 共享业务规则 |
| `fixtures.mjs` / `mcp-server.mjs` | 合成数据与独立只读 MCP 进程 |
| `benchmark-checks.mjs` | 与最终答案独立的执行流程验收 |
| `verify.mjs` / `verify-ptc.mjs` | 本地回放、官方运行时及反例验证 |
| `ptc-dependencies.json` / `ptc-package-lock.json` | 固定版本的官方 Harness 组件 |

Windows PTC 需要在能创建受限令牌的环境运行。若 Harness 自身的沙箱启动失败，程序返回错误，不自动降级。Linux/macOS 未作同等实测。Pi 加载优先使用项目依赖，不读取个人 Pi 凭据或 MCP 配置。
