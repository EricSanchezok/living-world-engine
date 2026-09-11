# Execution Ledger

Execution Ledger 是正常演化、失败诊断、Inspector、实验和重放的唯一执行证据。它与世界版本和 World Instance 共用 `livingworld.sqlite`，不使用 NDJSON、日志轮转或独立实验数据库。

## 存储

`executions` 保存 execution kind、父 execution、instance/run/step、实际 producer manifest、world/code/model/seed/runtime 配置、状态、semantic hash、state hash 和 commit revision。producer 明确区分 `algorithm` 与 `engine-operation`；Arrival 等非算法操作不能借用 eager 身份。

`execution_events` 使用全局递增 sequence，保存 `traceId`、`spanId`、`parentSpanId`、links、阶段、correlation、耗时、标量属性、计数、测量、hash 与 artifact 引用。

`execution_artifacts` 以 canonical JSON 的 SHA-256 寻址，以 gzip BLOB 保存完整模型请求、响应、世界定义、候选结果、验证问题和错误。凭证在进入 Ledger 前脱敏。模型请求在 transport 前、响应在返回算法前、候选在提交内核消费前必须落盘；关键写入失败会终止 execution，revision 不前进。

writer 使用有界缓冲和 SQLite 批量事务。Ledger 自身的 artifact 字节、压缩字节与写入耗时直接附加到当前事件，不通过事件系统递归观测自身。进程中断遗留的 running execution 在数据库再次打开时标记为 failed。

execution kind 只有 `interactive | diagnostic | benchmark | replay`。Benchmark 是父 execution 与 trial 子 execution，不拥有另一套事件或结果格式。

## 执行边界

Execution Contract v6 的 `WorldExecutionAlgorithm` 生成 `BootstrapCandidate`，并用 `prepareStep` / `completeStep` 生成 Preparation v5 与 Candidate v5。每个 World Instance 固定一棵完整递归算法 Composition；生产与 replay 都经校验 registry 解析每个 Role、实现版本、contract version、显式配置、子节点与 manifest hash。`CanonicalCommitter` 独立验证四类 interaction dependency、共享资源 claims/admissions/holder release/FIFO promotion、最早边界、ActivityDisposition、assertion evidence、引用、受众、单份 model audits 与 mind commits，并从 resolution 统一派生 Observation。`eager-reference@16` 在边界选择前完成有限 onset reaction 和资源准入，再以固定 Truth slot batches 进行正时间原子提交；新实例的默认候选选择节点是 `relational-rrf@2`，它固定 Encoder fingerprint、20% 比例预算及必需引用下限、typed-channel RRF 排序、coverage-aware 联合分配和严格 slot membership。`full-catalog@1` 只作为显式 reference/relabeling 算法保留，不是隐式 fallback。算法 Composition 的规范见[算法系统](algorithm-system.md)。

WorldHost 为 bootstrap、每个 WorldRun 时间边界和 Arrival 建立 execution。成功世界推进时，World Instance CAS、WorldRun revision 列表与 execution terminal record 在同一 SQLite 事务内完成；失败、取消、暂停、repair 耗尽、迟到结果或关键记录失败均不推进 revision。World Instance document schema 为 v23，旧实例不迁移；实例创建时固定实验 manifest、variant、bucket、assignment hash 与对应完整 Composition，修改 host 默认算法、实验比例或默认调优参数不会改变已存在实例。

原子事务在 terminal event 固定后生成 `{executionId, terminalEventSequence, traceHash}`。`traceHash` 覆盖事件身份、DAG、属性、计数、correlation、错误与 artifact 引用；运行时长和资源测量不进入该 hash。bootstrap 保存 `bootstrapExecutionRef`，每个 `CommittedStep` 保存自己的 `executionRef`；`contentHash` 覆盖引用，`semanticHash` 排除引用，从而分别验证证据链和算法语义。

## 事件与指标

Runtime event schema v4 的稳定语义归引擎所有。算法只能通过窄型 instrumentation 上报已声明的 phase 与 degradation diagnostics，未知事件、畸形字段和算法伪报的引擎事件会失败。引擎根据调用所有者自动附加 `{path, role, id, version, manifestHash}`，算法输入不能伪造节点身份。引擎在 Candidate 通过提交验证后，从输入和候选生成 activation、eligibility、产物、temporal boundary reason、Activity transition、outcome status 与 operation kind 事件。稳定的 trace/span/parent/link 仍表达执行 DAG；在没有区间 span 证据时，导出器只报告真实根执行墙钟时间、span 数和最大深度，不声称关键路径或把父子 duration 重复相加为总 work。

`MetricDefinitionRegistry` 是名称、单位、`sum | count | last | max` 聚合和允许维度的唯一登记处。Agent、Participant、Instance、Advance、Event、Component 和 invocation ID 只存在于 trace，不进入聚合指标维度；受控的 model role 可以进入指标。指标只从 Ledger 原始事件派生，不另存实验结果真相。

当前指标覆盖 Agent 数量与策略来源、ActionWindow 等待、TemporalPlan、动态 Δt、active Activity、转换、到期 Activity/Timer/Condition、boundary reason 与决策点、ResolutionPlan、已结算/延期 Receipt、outcome status、operation kind、可信 mechanic、依赖图与冲突分量、global dependency 与实际 global readjudication、模型调用/repair/token/cache/字节/work、候选目录压缩、passage/query cache、shortlist 越界、eager-reference 配置上限、logical/submitted slot、物理调用、局部失败、递归拆批与 fallback、阶段 DAG、CPU/RSS/heap/event-loop/SQLite、rollback 与废弃工作，以及算法/实验/代码/世界/seed/model/runtime 的复现身份。共享资源 benchmark 另按场景 artifact 记录 none/sparse/dense 争用、分配器执行时间、队列长度与 artifact 字节；不把非固定硬件墙钟设为 CI 阈值。模型 invocation、token 和 transport execution 在调用过程中累计，因此 Candidate 生成中途失败也保留非零 discarded-work 证据。

墙钟耗时用于描述运行条件。跨机器的主要算法工作量是调用、token、字节、模型 execution work、阶段 span 和语义产物基数。

## Inspector

Inspector 服务端按 World Instance 查询 Ledger，并由可重建的 SQLite 查询投影支持精确检索；窗口和摘要不内联大型 payload。已提交图谱从 canonical history 重放派生，attempt、失败、模型调用与原始材料来自同一 Ledger。Inspector API v13 的实例窗口公开受信任的递归 Composition 树、稳定路径、严格配置和节点 hash；每个 step detail 公开 TemporalPlan、Activity/Timer snapshot、边界来源、动态 Δt、同刻到期集合、Activity 转换、决策点、完整 pool capacity、holder、claim、queue 和 admission evidence。未提交 attempt 明确保持 canonical clock、Activity progress 和资源分配不变。

Inspector API v13 还提供 `GET /api/instances/:id/inspector/model-invocations` 与单条调用详情路由，以及本地 `GET /api/debug`、`/api/debug/invocations/:id`、`/api/debug/artifacts/:hash` 和 `/api/debug/doctor`。调用投影区分 logical invocation、transport attempt、semantic rejection、repair 和 retry，并公开单次 token、request/context/response 字节数、queue/transport/parse 时间、slot/Agent 映射、候选 shortlist、缓存命中、validation code、runtime event ID、Algorithm 节点与 artifact hash。实例窗口显示可信实验归属或排除原因；调用清单和 Debug CLI 支持服务端精确查询、稳定分页、诊断码、request/trace/span、artifact 与完整 lineage；完整 payload 仅在显式请求时读取，不进入摘要。

Inspector 是本地受信任调试表面。公开产品 DTO 和 Participant 视角不读取 Inspector 投影，也不能获得 canonical binding 或其他主体私有认知。

HTTP Route Handler 为每个请求生成 `requestId`，通过 `x-lwe-request-id` 返回，并在同一异步上下文中继承到 WorldHost、模型与 Ledger 事件。由独立后台任务或进程重启后恢复的执行不会伪造 HTTP 关联。

## 研究命令

```sh
npm run experiment:run -- --agents=48 --steps=1 --action-compilation-slots=1,4,8,12 --agent-mind-slots=1,2,4,8 --database <sqlite>
npm run execution:replay -- <execution-id> --database <sqlite>
npm run execution:replay -- <execution-id> --database <sqlite> --probe-report <report.json> --trial 1
npm run execution:compare -- <left-id> <right-id> --database <sqlite>
npm run execution:export -- <execution-id> --database <sqlite> [--output <json>]
```

本地故障优先使用 `npm run debug -- find --invocation <public-id>`、`inspect`、`lineage`、`events`、`artifact`、`explain` 和 `doctor`。完整命令、稳定退出码和索引重建流程见 [Local Debugging Reference](../debugging.md)。

`experiment:run` 使用生产 Gateway 与确定性 transport boundary，不访问网络，并交叉运行两个独立槽位矩阵。每个 trial 固定带配置的 eager-reference manifest，记录配置上限、实际平均槽位、按角色物理调用与 scheduler 波次、input/output/reasoning/cache token、局部失败、repair、split、fallback、墙钟和成功率，并保存完整模型输入输出与候选材料。`execution:replay` 从原 execution 的 producer manifest 还原带相同配置的 `AlgorithmRef`，经 registry 创建算法并逐次消费已记录模型输出，不访问网络，同时验证 semantic hash 与 state hash。它也接受显式 `--probe-report <report.json> --trial <n>`，进入 `probe-overlay` counterfactual mode：只替换一个 request-exact invocation，仍执行完整 schema、semantic、repair 与 commit 路径；报告 artifact 和 `debug.probe.overlay.applied` 事件记录证据及 probe/replay 网络边界。默认无参数语义保持 immutable Ledger replay。`execution:compare` 分别比较 resolution（计划、收据、随机、mechanic、因果验证）、temporal（计划、边界、snapshot、转换、决策点）、transition、observation 和 mind。`execution:export` 输出 producer manifest、事件、artifact 索引、按注册语义聚合的指标与 execution wall/span 摘要。

随机实验以独立 world/seed 为重复单位；算法比较使用稳定随机键与配对运行，不能把同一世界中的多个 Agent 当成独立样本。

决策依据见 [0059](../decisions/0059-unified-execution-kernel-and-ledger.md)、[0063](../decisions/0063-eager-reference-execution.md)、[0064](../decisions/0064-conversation-core-and-agent-perspective-observer.md)、[0071](../decisions/0071-pin-algorithms-and-own-telemetry-in-the-engine.md)、[0074](../decisions/0074-enforce-script-owned-shared-resource-pools.md)与 [0075](../decisions/0075-pin-configured-execution-algorithms.md)。
