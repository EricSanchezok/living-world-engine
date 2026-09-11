# 引擎运行时参考

## 状态边界

`SimulationState` v15 是闭环仿真的持久状态：canonical world、全部 Agent 私有状态、准入提交、ResolutionPlan、ResolutionReceipt、TemporalPlan、模型执行审计与语义历史。Canonical world 持有世界时钟、带持久交互足迹的 Activity、Entity 共享资源池与 WorldTimer；`WorldInstanceDocument` v23 在其外层固定完整递归算法 Composition 与不可变实验归属或排除原因，并保存 Participant、持久 Arrival、Participant intent、PolicyBinding、判别式 ActionWindow、Preparation v5 artifact、调度配置和 WorldRun。

真人与自主主体使用同一个 `AgentState`。策略表必须精确覆盖全部 Agent：

```ts
type PolicyBinding =
  | { kind: "model"; agentId: AgentId; profiles: AgentModelProfiles; resumeFromRevision?: number }
  | { kind: "external"; agentId: AgentId; participantId: ParticipantId }
  | { kind: "idle"; agentId: AgentId; reason: "timeout" | "released" | "explicit" }
  | { kind: "replay"; agentId: AgentId; sourceExecutionId: string };
```

外部行动也是开放自然语言企图。它只能指定 raw text、goal、means 与已知目标；action ID、actor、base revision 和提交归属由引擎绑定。idle、超时和正在执行 Activity 的 Agent 不产生行动，也不调用模型伪造 noop。replay coordinator 从 `sourceExecutionId` 投影已记录行动，并通过同一请求槽位交给算法重新物化；缺少记录行动时步骤失败，不能调用模型补写。

## 世界推进

唯一入口接收当前 revision、触发类型、可选边界数和外部行动。`manual` 推进一个时间边界，`batch` 推进指定边界数，`realtime` 只按现实时间唤醒，`participant_action` 让一个根意图自动跨边界执行；调用方不能提交模拟秒数。

## 时间计划、活动与边界

每个新行动在裁决前获得一个 `TemporalPlan`，其形态为 fixed、rate、staged、conditional、goal 或 ongoing。时间数值只来自玩家原文中可独立验证的明确数量、世界剧本的命名 Temporal Profile，或版本化 Rule Package 的确定性结果；`temporal-planner` 只能选择 Profile 并引用依据，不能填写任意 clock delta、`elapsedSeconds`、最终进度或完成效果。

A goal Activity retains the complete source action and remains active across authored checkpoints until a supported outcome completes, blocks or fails it. Its plan has no predetermined completion time; optional continuation prerequisites use the existing onset and boundary checks. Semantic completion is adjudicated from state and effects, not checkpoint time. See [goal-directed temporal activities](../decisions/0116-goal-directed-temporal-activities.md).

Post-boundary audience interruption uses current action, due Timer and due Condition dependencies. Retained Activity footprints remain complete conflict and continuation context; their audience membership alone does not create a new interruption. A due or resource-adjudicated Activity contributes through its current action node. Onset reactions and continuation failures retain their existing rules. [Boundary triggers and Activity context](../decisions/0178-separate-boundary-triggers-from-activity-context.md) owns this distinction.

The temporal evidence extractor excludes recognized upper-bound expressions such as “三十日内” and “within 30 days” from exact-duration authority. Original action text remains available for semantic adjudication; numeric-span eligibility alone does not prove that a span describes the acting subject’s work. The [deadline regression](../postmortems/0058-deadline-authorized-exact-action-duration.md) links the extraction and canonical-boundary guardrails.

引擎把 TemporalPlan 物化为 canonical Activity。Scheduled Activity 保存来源行动、参与 Agent、阶段、开始与更新时间、进度、下一个绝对检查点、完成时刻、可中断性、每 Agent 资源声明、共享资源 claims、`continuationAssertions` 与持久 `interactionFootprint`；`queued` 保存同一行动证据和已验证的 plan draft，`ready` 再增加原子预留时刻。每步使用从 canonical Activities 重建的临时倒排索引，不持久化派生索引。默认前台容量由剧本声明为一，同一 Agent 的额外并发能力也只能由剧本资源容量授权。WorldTimer 保存未来到期时刻、唤醒对象、causes 与 assertions，不保存未经验证的未来 state delta。世界脚本可用 `world_timers` 物化初始绝对触发；到期且没有同一 Agent 的到期 Activity 时，内核注入确定性的 Timer trigger action，同刻交给 Truth，CanonicalCommitter 会重新构造并核对该 action。

每次提交选择所有 active Activity 检查点、Timer、Condition 到期和 `max_autonomous_span_seconds` 中最早的绝对时刻。同刻到期项联合裁决，提交只含一个由内核注入的正整数 `advance_time`。无关的更早边界可以更新可见进度，但不能把未到期 Activity 的绝对检查点改成“当前时间加间隔”。完成效果只能在完成或对应阶段边界产生；控制面暂停不形成零时间世界提交。

## 共享物理资源

`shared_activity_resources` 定义名称、单位、默认 claim 数量、是否允许行动原文显式数量、`reject | queue | adjudicate` 争用策略和暂停时 `retain | release`。具体 canonical Entity 声明 pool capacity；pool ID 由 world hash、定义 ID 和 Entity ID 确定性派生。普通 Fact 不能建立硬容量，模型也不能自报 claim 数量；数量只能来自定义默认值、可核验的行动原文或受信任 mechanic。

Grounding 在同一次调用中生成 footprint 和 claims。分配器把 active holder、retain 型 pause 和 `ready` reservation 计入占用；一个 Activity 的多个 claims 全部满足才可获得。容量不足时，`reject` 确定性 block，`queue` 按 `(enqueuedAtSeconds, activityId)` 等待，`adjudicate` 把竞争行动和 holder 放入同一 Truth 分量；混合策略只按 `adjudicate > queue > reject` 选择路线，任何路线都不能绕过容量。

终止 disposition 释放全部 claims，pause 按定义保留或释放。每次正时间提交先应用 disposition，再按相互连接的 pool 划分 FIFO 分量；每个分量遇到第一个无法完整满足的队首就停止，其他不相连分量仍可推进。满足者转为 `ready` 并持有原子 reservation，在下一次普通正时间步骤重新验证 assertions 后从当前 canonical 时间物化新 TemporalPlan；排队时间不回填进度。Entity retirement 或 capacity decrease 只有在同一 Candidate 释放足够 holder 时才合法。

`eager-reference@16` 是 `world-execution` 根 Algorithm；它组合认知、行动编译、候选选择、符号修复、交互 grounding、反应、Truth、Observation、批处理、调度和恢复等子 Role。完整替换边界、命名与开发流程见[算法系统](algorithm-system.md)。其阶段如下：

Truth Engine 的独立 interaction components 在 resolution、plan verification、transition、causal verification 与 observation 阶段使用固定 `truthBatchMaxSlots`（默认 12）slot batch。共享上下文完整发送一次，slot 仍独立校验、repair、审计和 replay；真实 global 或无法证明独立的分量保持原有全局路径。完整 batch 超过模型输入上限直接返回 `ContextLimitExceeded`，不缩小或裁剪上下文。

Action Compilation 与 AgentMind 在算法内部使用独立上限的槽位批处理，默认分别为十二和八；Reaction worker 与 Action Grounding worker 上限默认分别为八和十六，合法范围均为一至六十四。Action Compilation 每批发送一份完整 handle namespace，并只为当前 action、合法 Temporal Profile、世界时间、位置邻域与引用闭包保留详细 evidence；候选身份、语义、允许用途和 slot scope 始终完整，未选择的 details 显式为 `null`。AgentMind 按 `bootstrap | resume | mind` 和 Agent model profile 分组，每批共享 execution、revision 与 trust boundary；每个 `slots[i]` 自包含 `agentState`、`task`、`referenceCatalog`、`allowedTargetHandles` 和 `repair`，不再通过 `state.slots`、`task.slots` 与 `referenceCatalogs` 的平行索引关联私有上下文。每个批次的 `userPrompt` 先于标记为 data 的 Context，字节预算与 Gateway 实际请求通过同一序列化函数计算；输入字节上限可继续缩小实际批次。Gateway 严格解析 JSON，必要时只对顶层响应执行有限语法恢复，恢复结果继续经过 schema、reference 和语义校验；局部语义失败只修复失败 slot，结构失败修复整批三次后稳定二分，terminal provider 错误不拆批。一个物理请求对应一份 audit，批结果不把 invocation ID 复制给各 Agent。四项上限随算法 manifest 固定，重启与 replay 使用同一配置。

1. 只为当前决策点的 model/external Agent 收集新行动；被 active Activity 占用的 Agent 不运行普通 AgentMind。
2. 每个新行动独立规划 TemporalPlan，并用一次 grounding 生成 read/write/audience footprint 和共享资源 claims，在当前时刻物化带 continuation assertions 的 Activity。普通新行动替换本人可中断、queued 或 ready Activity 时，同一投影先取消旧 Activity。
3. 临时 `ActivityFootprintIndex` 通过 footprint、participant、audience 和 resource-pool key 查询新行动影响的 live Activities。只有 dependency 相交、共享位置、连接双方的可访问关系 Fact 或成功感知检定提供依据，且 Activity 可中断时，才冻结一轮 onset reaction 请求；正持续时间保证此刻的替换仍先于未来结算。
4. model、external、replay 与 profile fallback 分别产生 `ReactionDecision`。`keep` 可继续、暂停或取消当前 Activity；`replace` 从当前世界时间重新规划并 grounding。请求集合冻结，replacement 扩大依赖只触发全局重裁决，不递归请求反应。
5. 分配器原子处理新 claims。reject/queue 不调用 Truth 争抢容量；adjudicate 把相关 holder 的持久 source action 加入同一 Truth 分量，不重新 grounding，也不增加 AgentMind 调用。
6. 所有 keep、replacement、已准入新行动、既有 Activity、ready start、Timer、Condition expiry、assertion boundary 和安全上限共同进入一次确定性最早边界选择。
7. 到期行动与 `Action | Activity | Timer | Condition` 通用 interaction dependencies 形成冲突分量；受影响 Activity 沿持久 footprint 扩展到固定点闭包。纯 context node 不伪造 ActionOutcome；实际 operation 超出声明 footprint、replacement 改变依赖图，或分量实际读写交叉时，全体行动以 global dependency 重新裁决。
8. transition 只能提交语义操作和规则调用。引擎用 `core-resolution@2.0.0` 结算可信收据并注入唯一正时间 `advance_time`。每个到期或受影响 Activity 必须有 `continue | pause | complete | block | fail | cancel` disposition；continuation assertions 在创建和受影响 transition 前后验证，失效且无更具体语义时确定性 block。释放后的队列推进与最终状态属于同一原子候选。
9. Observation Renderer 根据 transition 后状态、事件和 interaction audience 生成固定槽位 observation；reject、入队、预留、开始和争用结果不维护第二套叙事事实。onset `keep` 可以让 Activity 在接收本次刺激后继续；没有预警的相关结果则可在同一提交中暂停 Activity。只有已解除 active 占用的真正决策点才允许运行 AgentMind。
10. CanonicalCommitter 重新应用 Candidate v5，并独立重建 source hash、最早边界、四类 interaction nodes、affected Activity 集、claims、holder 释放、admissions、FIFO promotion、dispositions、assertion evidence、统一 Observation 和全部 canonical 不变量，随后构造 `CommittedStep` 与下一状态。

算法不持有状态写入能力，也不能定义稳定事件或指标语义。Execution Contract v6 将一步拆为可 JSON 持久化的 Preparation v5 `prepareStep` 与 `completeStep`；`sourceStateHash`、request、递归 manifest、policy roster 或候选与当前 source 不一致时完成或提交失败。Runtime event schema v4 的 lifecycle、temporal 与 resolution 事件由引擎从验证后的输入和候选派生，并自动带上对应 Composition 节点的 path、Role、id、version 与 manifest hash。

## Truth 与随机承诺

Truth actor context preserves each issued local reference and its canonical entity references together in `localEntityBindings`. Empty and multiple bindings remain explicit; the separate local and canonical inventories do not encode a positional correspondence. The mapping belongs to adjudication context and does not enter AgentMind or ordinary client projections. Binding identity alone does not authorize an effect.

perception 只能请求 perception checks 或结束；reaction routing 只能选择有结构化感知依据的 Agent；resolution 在任何 resolution 随机前提交一次完整计划，之后只能请求离散随机或结束；transition 只提出语义效果与可信规则调用。阶段单向前进，已提交计划不能根据骰点改写。

每份 ResolutionPlan 固定 actor、targets、goal、canonical grounded means、命名难度或对抗、至多一个 actor 自有 Rating、因素唯一角色、风险、基础效果、一个 primary effect、可选的较弱 secondary effect 与失败威胁。普通环境难度 `trivial/easy/challenging/hard/extreme` 映射到 DC 5/10/15/20/25，对抗 DC 为 10 加目标 Rating；semantic edge/hindrance 相抵后只决定 advantage、normal 或 disadvantage。

The indexed planner can opt into [source-bound relation choices](../specs/0114-bind-planning-relation-choices.md). Their reversible representation retains the same canonical plan and validation boundary.

Its [compact record representation](../specs/0115-compact-planning-records.md) places mode and action identity before dependent columns while retaining all original plan values and validation responsibilities.

The optional [balanced initial planning policy](../specs/0117-balance-initial-planning-work.md) distributes complete conflict components by assigned-action workload across concurrent physical requests. It preserves each logical context and commit boundary while trading extra requests and duplicated input for a measured latency opportunity.

d20 余量产生 `exceptional/full/mixed/miss`，保留骰 20 升一档、1 降一档。`ResolutionReceipt` 固定派生 DC、修正、骰点、余量、结果档、最终效果和可信操作；exceptional 升 primary 一档，mixed 将 intended effects 降一档并应用风险后果，miss 只应用风险后果。离散随机只能引用 `WorldRuntimeContract` 内的分布定义；所有随机结果必须被最终机制、operation、event 或 outcome 消费。

Meter 变化只接受 impact profile 的五档映射并在边界内 clamp；Condition 使用自由语义名称、五档强度、duration profile、可见性和 causal provenance。相同 Condition ID 或声明式 stacking key 才合并：更强替换、同档升档、较弱刷新持续时间。`uses` 状态在被计划作为证据使用时消耗，`elapsed` 状态由引擎拥有的时间规则到期，声明 recurring impact 的 profile 在时间推进前结算。Quantity 数额只来自行动中的明确金额、既有状态、已承诺随机结果或可信规则结果；number Fact 不自动成为修正值。

每个 operation、机制调用、event 与 outcome 都包含 causal refs 和至少一个机器可求值 assertion。代码先验证引用、断言、守恒和规则包；`causal-verifier` 再检查开放语义是否相关、效果是否匹配以及事件影响级别是否夸大。

## Observation 与认知隔离

indexed reviewed Truth 的实验配置 `outcomeSummary` 可选择[事件来源摘要协议](../specs/0083-event-sourced-outcome-summaries.md)：模型把实际提出的发生事项放入现有事件或状态操作，结果摘要由显式status及直接引用本行动的事件描述生成。事件本身仍需时序、因果和语义检查；只生成记录不等于证明发生，默认配置不启用此候选。

实验候选 `source-bound-observation-rendering@1` 可以在世界没有事件或事实变化、本人活动仍在下个节点之前时，从绑定的源行动和活动状态直接投影有限的进度观察，其他情况仍使用模型。它不生成新的表象 claim，也不把行动意图改写为已完成事实；默认 Composition 不启用。具体准入与验证见[协议 0082](../specs/0082-source-bound-pending-observations.md)。

Observation 使用观察者局部实体 ID。新对象必须在同一 packet 的 introductions 中建立局部实体；服务端私有 `canonicalEntityId` 只用于 binding，普通 API 和 AgentMind 都看不到该映射。apparent claim 只能引用该观察者已有或本包新引入的局部实体。

Observation Renderer 是受信任的模型角色，可以依据候选世界变化决定可见表象，但输出必须通过固定槽位、事件引用、局部身份、权限和完整覆盖校验。Truth transition 不生成 observation，因此全局裁决不会同时承担全体自然语言观察输出。

AgentMind、reaction、grounding、Observation Renderer 与 Arrival Generator 都通过 `projectAgentPerspective` 读取同一个去 canonical identity 视角。该视角同时包含精确自身 Meter、Quantity、Rating、可见 Condition、随身 containment、授权 Fact、character、belief、evidence 和完整 subjective history；精确关系与主观 claim 冲突时并存。历史中的 `full` ResolutionReceipt 显示可访问的计划因素和骰点但移除 canonical ID 与隐藏证据，`result_only` 只显示结果和效果，`hidden` 不出现。CharacterPatch 只能使用本步 eligible observation 作为证据；没有合格来源时必须为空。

成功或部分成功的本人行动若创建 Entity、把 Entity 移入自身 containment，或创建涉及自身且授权自身读取的 Entity-valued Fact，Observation 必须为尚无合法 binding 的关联 Entity 提供 introduction。提交内核拒绝“状态已经成功但主体无法识别后果”的候选。

## ActionWindow

同一 revision 最多一个 ActionWindow。决策窗口收集新行动，反应窗口只收集冻结准备中的 `keep` 或自然语言 `replace`：

```ts
type ActionWindow = {
  kind: "decision";
  id: string;
  generation: number;
  baseRevision: number;
  requiredAgentIds: AgentId[];
  submissions: Record<AgentId, ExternalActionInput>;
  deadlineAt: string | null;
  status: "open" | "resolving" | "committed" | "cancelled";
} | {
  kind: "reaction";
  id: string;
  generation: number;
  baseRevision: number;
  preparedStepId: string;
  preparationArtifactHash: string;
  preparationExecutionId: string;
  sourceStateHash: string;
  algorithmManifestHash: string;
  policyRosterHash: string;
  policyRoster: Record<AgentId, PolicyBinding>;
  advanceRequest: WorldAdvanceRequest;
  requiredAgentIds: AgentId[];
  requests: Record<AgentId, ReactionRequest>;
  submissions: Record<AgentId, ExternalReactionInput>;
  deadlineAt: string | null;
  status: "open" | "resolving" | "committed" | "cancelled";
};
```

required Agent 的提交以 `submissionId` 幂等。相同 ID 与相同内容重试返回既有状态；同一 Agent 的不同提交冲突。决策超时把缺失槽位变为 timeout idle；反应超时保留其他回答，并按原 Activity 的 `reaction_fallback` 确定性处理。反应窗口的 generation 在独立参与者提交期间保持稳定，只在窗口结构改变时提高；window ID、prepared step ID、generation 与 base revision 共同拒绝陈旧窗口。

普通 API 只向控制目标 Agent 的 Participant 投影其反应 stimulus，不投影 basis、其他 Agent 请求、canonical binding 或完整准备 artifact。active Activity 的玩家不在每个检查点重新输入；只有可感知且仍可改变未来的 onset interaction 才打开反应窗口。batch 在 external 决策或反应处停止，realtime 严格串行且只安排现实唤醒；scheduler generation 使暂停、重新启用和重启前的 timer 失效，重启不补算离线时间。

## WorldRun 与暂停恢复

一个 Participant intent 对应一个持久 WorldRun，能够连续提交多个 TemporalBoundary。状态为 `queued | running | pausing | paused | awaiting-decision | awaiting-reaction | preparation-invalidated | completed | failed | budget-paused`；记录 generation、根行动、Activity、execution、已提交 revisions、停止原因和当前 lease。

每个自动 lease 默认最多 100 次提交或 15 分钟真实执行时间，任一预算耗尽只进入 `budget-paused`。需要真人反应时，预演执行将完整 `WorldStepPreparation` 写入内容寻址 Ledger artifact，并与 frozen request/roster hashes 和窗口原子持久化；预演执行以 succeeded 结束但没有 commit revision。回答后的短执行以预演为 parent，验证全部 hash 后完成正时间提交。artifact、manifest、roster 或 source 不匹配时 canonical state 保持不变并进入 `preparation-invalidated`；进程启动不重跑模型，只有用户显式恢复才重新预演。

## Participant 准入与控制转移

Participant 以 principal 身份控制一个 external Agent。普通新游戏只能通过 Origin 创建新 Agent；Observer 可以在 revision 边界接管任意存活且未被 external 策略控制的 Agent。当时的 prepared action 作为历史承诺保留并记录 `suppressedActionId`，external 策略绝不收集或执行它。真人和 AgentMind 读取同一 `AgentPerspectiveView`，但不会获得 bindings、其他 Agent 认知或 canonical truth。

Origin 准入引用一个 Entity Mechanics Profile，确定性创建 Entity、Agent、placement、完整 Meter/Quantity/Rating 状态和自由动机 goal，并形成独立 admission revision。运行时同一步创建并绑定的新 Agent 也必须通过 `instantiate-entity-profile` 可信规则引用模板，transition 不能直接填写数值。显示名称、外观和动机不能改变剧本的数值、出生点或资源。Arrival Generator 在准入提交后运行，只读该角色视角并返回标题、第一人称场景和三条建议；失败使用剧本回退文本，不能回滚准入。

控制转移以一个 revision CAS 同时释放当前角色并选择 Observer 或另一 Agent。释放角色恢复 model 策略，并以 `resumeFromRevision` 标记需要消化的控制期 observations；被接管角色生成新的持久 Arrival。Participant 的自然语言提交由服务端持久化为根 intent，并创建或继续 `participant_action` WorldRun。一个 intent 可以投影多条 committed Observation；暂停后玩家可恢复同一 Activity，也可提交普通“停止/改变活动”行动进入下一次语义裁决。

## 提交与重放

提交内核校验：状态 schema、revision、TemporalBoundary、TemporalPlan 权威来源、Activity/Timer snapshot、共享资源 pool/claim provenance/capacity/holder/queue/promotion、行动、ResolutionPlan、ResolutionReceipt 与 outcome 一一覆盖、计划和 d20 的确定性派生、收据与可信操作绑定、唯一 Condition/time settlement、随机顺序、causal refs、断言、世界引用、守恒、范围、placement、observation 权限、决策资格、mind commit 覆盖、RNG 连续性、semantic hash 与历史 replay。

成功步骤的实例 CAS、WorldRun 更新与 execution terminal record 在一个 SQLite 事务中完成。失败、暂停、超时和迟到结果只更新运行或 execution 诊断，不改变 canonical revision。canonical history replay 从每个 CommittedStep 恢复完整 temporal snapshot，验证持久计划、收据、随机承诺和可信操作，且不调用模型或重新裁决语义；recorded execution replay 从 Execution Ledger 的 producer manifest 恢复完整递归 Composition，经同一 registry 解析每个节点，再消费原始结构化响应并运行固定提交内核。

相关边界见[系统架构](../architecture.md)、[剧本格式](script-format.md)、[Execution Ledger](runtime-observability.md)和[表现层](presentation.md)。
