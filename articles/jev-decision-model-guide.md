# Jev 决策模型入门：基本原理与输入输出示例

> 发布日期：2026-10-03 · 最近核对：2026-10-03 · 迁移日期：2026-10-03 · [原文源提交 `27ba612`](https://github.com/baidd1011/tech-notes/commit/27ba61294c2a7c89e6413dcfa01dc68b3adb51a4)

当程序需要判断“用户想做什么”“应该检索哪个知识库”“是否满足某个条件”时，我们经常让一个小参数 LLM 输出分类标签或 JSON。Jev 为这类任务提供了另一种接口：输入上下文和问题定义，直接得到决策及其概率。

本文只介绍 Jev 的基本工作方式，并用一条客户反馈串起完整的输入、输出与结果读取。示例依据 TypeSafe 官方 API 文档构造，**其中的概率和分数是演示数值，不是实际调用结果，也不代表准确率评测**。

## 1. Jev 做什么：从上下文到有类型的决策

Jev 是 TypeSafe AI 推出的 System One 模型。它理解自然语言输入，针对事先定义的问题返回选项、评分或命题成立的概率。这里的 System One 强调快速、聚焦的判断，适合放在程序的路由、分类和条件判断环节。[官方概念说明](https://docs.typesafe.ai/concepts/system-one)

可以把它的功能抽象为：

$$
P(\text{答案}\mid\text{上下文、问题、答案定义})
$$

例如，给它一条客户反馈，再定义“账务、技术、其他”三个部门及各自的职责，它就返回选择哪个部门，以及三个部门分别有多大概率符合这条反馈。这个公式只描述输入输出关系，不代表已经公开的内部网络结构。

### 与生成式 LLM 的区别

通常使用生成式 LLM 做分类时，模型读取输入，再逐 token 生成标签或 JSON，程序随后解析生成内容。Jev 则直接提供有类型的决策结果。

```text
生成式 LLM：上下文 + 提示词 → 逐 token 生成回答 → 解析标签或 JSON
Jev：      上下文 + 问题定义 → 决策概率 → 有类型的答案
```

官方介绍了面向决策的模型架构和并行采样机制：多个问题可以在同一个请求里一起求值，输出所有需要的决策，避免逐个生成答案的开销。这也是它可能更快的重要原因。不过，实际延迟仍受输入长度、部署方式和网络影响；与只输出一个标签的小型 LLM 相比，加速幅度需要实测。[官方发布说明](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

HTTP 响应依然会以 JSON 传输，客户端仍需解码 JSON；“不生成文本”指的是模型不通过自回归写作来拼出一段决策答案，并不表示网络接口没有 JSON。

Jev 是闭源服务。现有公开说明不足以完整复现其网络结构、参数规模和训练算法，因此本文不把它具体描述成某种已知骨干网络加分类头。

## 2. RLCD：同时关注答案和概率校准

官方将其训练方法称为 **RLCD（Reinforcement Learning for Calibrated Decisions，面向校准决策的强化学习）**。它的目标包含输出决策和校准后的概率，使模型能够表达不确定性。

“校准”可以这样理解：对于一组得到 80% 概率的预测，相关事件应当约有 80% 实际成立。这是大量预测上的统计性质，不能保证某一条预测正确，也不能保证换到新的业务数据后仍保持同样的校准程度。[官方训练目标说明](https://docs.typesafe.ai/introduction/machine-learning-primer)

因此，接入系统后仍要用业务数据验证概率和判断阈值。输出结构有效、模型很有信心，都不能替代对答案正确性的验证。

## 3. 三种基础题型

| 题型 | 需要定义什么 | 返回什么 | 示例用途 |
| --- | --- | --- | --- |
| `choice` | 候选项及各自的含义 | 选中的候选项、各项概率、置信度 | 选部门、知识库或工具 |
| `noul` | 一个明确的判断命题 | 命题为真的概率，范围为 0～1 | 是否要求退款 |
| `score` | 从低到高排列的等级描述 | 加权评分、各等级概率、等级说明、置信度 | 紧急程度或相关性评分 |

一次请求可以混合三种题型。每个问题针对同一份上下文独立评估：它不会自动把前一个问题的输出当成后一个问题的条件。依赖关系和最终操作由程序组织。[官方接口说明](https://docs.typesafe.ai/introduction)

## 4. 完整例子：一条反馈，三个判断

客户反馈如下：

> 这个月重复扣了我两次费用，请退回多扣的钱，今天要交账，麻烦尽快处理。

我们希望知道：应该转给哪个部门，客户是否要求退款，以及处理的紧急程度。

### 4.1 输入：上下文与问题定义

下面是发送到 `POST https://api.typesafe.ai/v1/systemone` 的请求体。实际调用需要按官方要求提供身份认证。

```json
{
  "model": "jev-latest",
  "state": "这个月重复扣了我两次费用，请退回多扣的钱，今天要交账，麻烦尽快处理。",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "应该由哪个部门处理这条客户反馈？",
      "criteria": {
        "billing": "扣费、账单、付款、发票、退款等账务问题",
        "technical": "程序故障、无法登录、系统错误等技术问题",
        "other": "不属于账务或技术问题的其他反馈"
      }
    },
    "refund_requested": {
      "type": "noul",
      "instructions": "客户是否明确要求退还费用？仅咨询退款政策、明确否认退款或转述他人的退款要求，不算客户本人要求退款。"
    },
    "urgency": {
      "type": "score",
      "instructions": "客户要求处理这件事的紧急程度如何？",
      "criteria": [
        "没有明确处理期限，可以正常排队",
        "希望尽快处理，但没有当天截止要求",
        "明确要求当天处理，有当天截止事项"
      ]
    }
  }
}
```

三个顶层字段分别是：

- `model`：选择模型。这里使用官方别名 `jev-latest`，它对应的具体版本可能变化。
- `state`：待判断的上下文。本例是一段文本，也可以按官方格式提供文本组成的对象或数组。
- `questions`：需要模型回答的问题，以自定义问题 ID 为键。响应会使用相同的 ID 返回结果。

`instructions` 说明要判断什么，`criteria` 说明允许的答案及其含义。`choice` 的候选项使用对象；`score` 的等级使用有序数组，位置从 0 开始编号。本例紧急程度的范围是 0～2。`noul` 在本例中通过问题描述定义判断命题，不需要列出多个选项。[Choice 输入格式](https://docs.typesafe.ai/primitives/choice)、[Score 输入格式](https://docs.typesafe.ai/primitives/score)、[Noul 输入格式](https://docs.typesafe.ai/primitives/noul)

### 4.2 输出：答案与概率

下面展示对应的**示意响应**，省略了 `usage` 等统计字段；具体模型版本也仅用于展示响应格式。

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "department": {
      "type": "choice",
      "choice": "billing",
      "probabilities": {
        "billing": 0.94,
        "technical": 0.04,
        "other": 0.02
      },
      "confidence": 0.91
    },
    "refund_requested": {
      "type": "noul",
      "noul": 0.98
    },
    "urgency": {
      "type": "score",
      "score": 1.8,
      "legend": {
        "0": "没有明确处理期限，可以正常排队",
        "1": "希望尽快处理，但没有当天截止要求",
        "2": "明确要求当天处理，有当天截止事项"
      },
      "probabilities": {
        "0": 0.0,
        "1": 0.2,
        "2": 0.8
      },
      "confidence": 0.7
    }
  }
}
```

### 4.3 如何读懂 `choice`

`choice: "billing"` 表示选中了账务部门。`probabilities` 给出每个候选项的概率，本例为账务 94%、技术 4%、其他 2%，总和为 1。`choice` 是概率最高的候选项。[官方输出说明](https://docs.typesafe.ai/primitives/choice)

`confidence` 是根据概率分布计算出的统计量，不是模型额外验证了一遍答案。对于有 `n` 个选项的 Choice，官方计算方式为：

$$
\text{confidence} = \frac{p_{\max}-1/n}{1-1/n}
$$

本例有 3 个选项，最高概率为 0.94，因此：

```text
(0.94 - 1/3) / (1 - 1/3) = 0.91
```

概率集中在一个选项时，这个值更高；接近均匀分布时更低。它不是独立测出的业务准确率。[官方置信度说明](https://docs.typesafe.ai/confidence)

### 4.4 如何读懂 `noul`

`noul: 0.98` 表示模型估计“客户明确要求退款”这个命题成立的概率为 98%。

如果值为 0.03，模型倾向于命题不成立；如果接近 0.5，则表示不确定。官方 Jev 的 Noul 响应没有单独的 `confidence` 字段。具体把多大的概率视为“成立”，由应用根据验证数据确定。[官方输出说明](https://docs.typesafe.ai/primitives/noul)

### 4.5 如何读懂 `score`

`legend` 将等级编号映射回输入中的描述。`probabilities` 表示每个等级的概率，`score` 是等级编号的概率加权平均：

$$
\text{score} = \sum_i i\,p_i
$$

本例的计算为：

```text
0 × 0.0 + 1 × 0.2 + 2 × 0.8 = 1.8
```

因此，1.8 表示接近等级 2，倾向于“当天处理”。它不是 180% 的概率，也不是默认十分制。Score 的 `confidence` 还会考虑概率分布在有序等级上的距离，不能直接套用 Choice 的公式。[官方评分说明](https://docs.typesafe.ai/primitives/score)

## 5. 程序怎样使用这些结果

HTTP 客户端把响应 JSON 解码为 Python 字典后，就可以直接取字段：

```python
# result 是已经解码的响应对象
answers = result["answers"]

department = answers["department"]["choice"]
refund_probability = answers["refund_requested"]["noul"]
urgency_score = answers["urgency"]["score"]

print(department)          # billing
print(refund_probability) # 0.98
print(urgency_score)       # 1.8
```

模型负责判断，程序负责如何使用判断。例如，部门结果可以用于路由，退款判断用于提示客服检查诉求，紧急程度用于排序。这里的退款判断只识别请求，不能据此直接认定用户符合退款政策。

在 RAG 中，同样可以用 `choice` 选择候选知识库，用 `noul` 判断是否需要澄清，用 `score` 评价文档与问题的相关程度。问题改写和最终答案生成仍可以交给生成式 LLM。输入里的定义与上下文决定模型在判断什么，输出里的概率帮助程序决定如何处理不确定性。

---

文档核对日期：2026-10-03。本文是依据官方公开资料撰写的中文技术介绍，不是 TypeSafe 官方文档；接口字段和模型别名请以当前官方说明为准。
