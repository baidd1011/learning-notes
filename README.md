# 个人学习记录

记录个人在模型、RAG、Agent 与软件工程方面的学习、实践和思考，包括原理笔记、技术文章与实验复现。内容按首次发布日期倒序排列，最新记录在前；正文、配图和复现材料统一保存在本仓库。

| 发布日期 | 文章 | 内容简介 |
| --- | --- | --- |
| 2026-10-04 | [编码 Agent 如何压缩上下文：Claude Code、DSH 与 Pi 的源码设计](articles/agent-context-compaction.md) | 分析三者的压缩阈值、工具输出清理、摘要与原文保留、状态恢复和提交边界。 |
| 2026-10-03 | [Jev 决策模型入门：基本原理与输入输出示例](articles/jev-decision-model-guide.md) | 解释决策模型、RLCD 与三种基础题型，用完整 JSON 展示输入、输出及概率、评分的读取方式。 |
| 2026-10-02 | [从工具调用到程序编排：Pi Codemode、DeepSeek Harness PTC 与融合实现](articles/pi-codemode-vs-ptc.md) | 结合真实 MCP 调用和合成业务任务，分析按需发现、SDK 预载、程序编排的机制与实验边界。 |

Pi 文章的代码、演示和原始实验结果见 [复现材料](examples/pi-codemode-vs-ptc/)。两个原仓库的 Git 历史已并入本仓库，文章中注明的源提交可以继续查看。

新的学习笔记和文章放入 `articles/`，并按日期加入上面的时间列表。维护规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。
