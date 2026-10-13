# Jev 引擎三臂验收协议与证据

本文是验收记录。实现细节见 [程序运行时](../game-design/world-program-runtime.md)，已有开发探针见 [真实入口证据](2026-10-13-jev-runtime-entry-evidence.md)。正式协议由 [qualification protocol](../../scripts/experiments/jev-qualification-protocol.ts) 固定，执行入口为 [qualification runner](../../scripts/experiments/jev-qualification.ts)。

## 协议

A 使用独立冻结的旧引擎 checkout；B 使用新架构及 DeepSeek 决策；C 使用新架构及 Jev 决策。B、C 的创作和上下文超限回退都使用关闭 thinking 的 DeepSeek。每个 worker 从对应 checkout 加载 loader、模型网关、提示词、WorldHost 和重放器；A 的提示词搜索工作目录固定在 A 的 checkout。所有调用共用一个累计预算账本，包含先前的规划和开发调用。

三个 canary 分别使用原 E3 的问询、观察、交易任务，首臂依次轮换为 A、B、C。确认集保留六类任务、每类五个独立种子、每个任务三次原始自然语言输入。每个样本保留全部 48 个自主角色及一个玩家。相同的有限工作与短检查点世界配方在各生产者中独立执行；模型能力字段、契约版本、核心规则包生产者版本和显式条件周期之外的剧本内容必须具有相同哈希。条件周期另行固定在 manifest；新契约中的 burning 周期为 60 秒，旧引擎没有对应字段。这是被比较架构的时间语义差异；涉及该条件的样本需单独审查，不能声称时间语义完全相同。

各臂独立完成初始化、初始程序生成及玩家到达，不交换 bootstrap、程序或推理结果。冷启动、首次输入和后续输入分别记录墙钟时间和账本差额。每次输入最多允许六次提交及 600 秒新增调用时间；已发出的调用继续收集用量。修复、拒绝结果和回退调用都计入费用及调用数量。

输入经过真实 WorldHost 提交，保留 SQLite、完整初始和最终文档、每次输入的响应及观察、运行终止状态和累计用量。认知提交只增加 revision；物理事件要求 step 加一且世界时间严格增加。逐次检查连续提交和重放一致性，最终重放不得调用模型。

## 结果解释

运行终止、程序结束和长期任务成功分别处理。有来源的非空观察仅标记为候选反馈；只有独立核对持久化事实、实际传播和任务禁止项后，才可以标记为有用反馈。未执行、失败、超时和预算删失样本保留在原始样本集合中；未完成的 A 样本不产生成功任务费用比或虚构提速比例。

首批冻结于 `b21729ed` 的三个 canary 组共九臂均在模型注册表预检阶段终止：未参与实验的 Kimi provider 元数据缺失导致整个全量目录不能捕获。没有新增付费 HTTP 请求，九臂的 27 次输入均未执行；这些是基础设施失败，不能作为任务完成率或模型质量证据。驱动将实际所需的原始 profile 和 account 原样投影到独立目录，以排除无关 provider 的可用性影响；修复后使用新证据批次。目标完成率、Jev 占比、费用和反馈等待时间的目标保持未验证。

## 运行方式

先提交已经检查的实现，然后执行 `npx tsx scripts/experiments/jev-qualification.ts --mode prepare --root <new-evidence-directory> --baseline-root <frozen-checkout> --budget-root <existing-cumulative-budget-directory> --cache-root <existing-local-retrieval-cache>`。该步骤不调用付费模型，固定生产者提交、模型目录、世界内容及协议。随后对同一证据目录分别执行 `--mode canary --root <evidence-directory>` 和 `--mode confirmation --root <evidence-directory>`。任何生产者或协议修改都要求新的证据目录；已有的部分样本不允许静默重抽。
