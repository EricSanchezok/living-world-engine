# 世界剧本格式 v13

世界包定义初始世界、法则、机制和可选的参与方式。它不定义玩家动作，不携带可执行代码，也不能提供自定义客户端 UI。

## 目录

```text
world-id/
├── script.yaml
├── laws.yaml
├── mechanics.yaml
├── participation.yaml       # 可选
├── entities/
│   └── *.yaml
└── assets/                  # 可选
    └── **/*.{png,webp,avif}
```

根目录只允许以上文件和目录；`entities/` 只允许普通 YAML 文件，`assets/` 只允许普通文件，任何符号链接、额外文件和额外目录都拒绝。至少需要一个 Entity。所有 YAML 对象使用 strict schema，未知字段拒绝。

语义 ID 必须是 NFC，不能带首尾空白或控制字符，规范 UTF-8 最多 128 字节，并在所属命名空间单义。`__proto__`、`prototype`、`constructor` 与 `rt:` 前缀保留给运行时；`player` 没有系统特权，可以作为普通 Agent 的语义 ID。运行时发生记录使用 `rt:<kind>:<sha256>` 身份。

## `script.yaml`

```yaml
schema_version: 14
id: immortal-realms
name: 万域修途
version: 1.0.0
description: 横跨多个大陆与宗门的修行世界。
runtime_defaults:
  max_autonomous_span_seconds: 300
  realtime_interval_ms: 30000
  action_window_ms: 60000
model_profiles:
  perception: truth-fast
  reaction_routing: truth-fast
  resolution: truth-strong
  transition: truth-strong
  causal_verifier: verifier-strong
  grounding: truth-fast
  observation: truth-fast
  arrival: truth-fast
  dynamic_agent:
    bootstrap: agent-strong
    mind: agent-fast
    reaction: agent-fast
```

`id` 匹配 `[a-z0-9][a-z0-9-]*`；目录名不承担世界身份。`max_autonomous_span_seconds` 是没有更早活动检查点、定时器、Condition 到期或其他语义边界时的一次模拟推进上限，不是动作时长。`realtime_interval_ms` 只规定现实世界唤醒间隔，`action_window_ms` 规定外部行动窗口。三个值都是正整数并受 schema 上限约束。

Profile 分别绑定 perception、reaction routing、resolution、transition、causal verifier、action grounding、observation renderer、arrival generator 和动态 Agent 的 bootstrap/mind/reaction 角色。所有字段必填并由模型目录验证；Truth 不能从模型输出中改写供应商、模型或 Profile。

## `laws.yaml`

```yaml
disclosure:
  default_check_visibility: full
laws:
  - id: time-passes
    text: 每个世界步骤都推进正数时间。
    severity: hard
```

至少定义一条法则。`severity` 为 `hard` 或 `soft`；它表达裁决优先级，不是行动枚举。`default_check_visibility` 为 `full`、`result_only` 或 `hidden`。

## `mechanics.yaml`

```yaml
rule_packages:
  - id: core-resolution
    version: 2.0.0
    config: {}
meters:
  - id: health
    name: 生命
    min: 0
    max: 20
    thresholds:
      - id: death-at-zero
        when: { operator: lte, value: 0 }
        effects:
          - { kind: set_lifecycle, lifecycle: retired }
quantities:
  - id: spirit-stone
    name: 灵石
    unit: 枚
    production_law_ids: []
    consumption_law_ids: [spirit-stone-conservation]
ratings:
  - id: resolve
    name: 决心
    min: -5
    max: 10
impact_profiles:
  - id: harm
    name: 伤害
    meter_definition_id: health
    direction: decrease
    amounts: { none: 0, minor: 2, standard: 5, major: 10, decisive: 20 }
duration_profiles:
  - { id: brief, name: 短暂, kind: uses, uses: 1 }
  - { id: ongoing, name: 持续, kind: until_cleared }
activity_resources:
  - { id: foreground, name: 前台行动, capacity: 1 }
shared_activity_resources:
  - id: workbench-use
    name: 工作台
    unit: 席
    default_claim_amount: 1
    allow_explicit_amount: false
    contention: queue
    paused_retention: release
temporal_profiles:
  - id: brief-action
    name: 一秒短动作
    kind: fixed
    duration_seconds: 1
    checkpoint_seconds: 1
    selection:
      semantic_tags: [instantaneous, short]
      evidence_requirement: none
    interruptible: true
    reaction_fallback: continue_if_valid
    resource_claims: [{ resource_id: foreground, amount: 1 }]
  - id: measured-travel
    name: 可量化移动
    kind: rate
    unit: km
    unit_aliases: [公里, kilometer, kilometers]
    units_per_period: 5
    period_seconds: 3600
    checkpoint_units: 1
    selection:
      semantic_tags: [travel]
      evidence_requirement: explicit_profile_quantity
    interruptible: true
    reaction_fallback: continue_if_valid
    resource_claims: [{ resource_id: foreground, amount: 1 }]
temporal_profile_coverage:
  required_semantic_tags: [instantaneous, short, travel]
temporal_calibrations:
  - id: ordinary-strike-time
    situation: 完成一次挥击、格挡或闪避。
    profile_id: brief-action
    explanation: 单次短动作在一秒边界结算。
world_timers:
  - id: gate-watch-deadline
    description: 石门值守进入绝对截止，守门人必须根据届时事实重新判断。
    due_at_seconds: 3600
    wake_agent_ids: [gatekeeper]
    law_id: watch-deadline
condition_profiles:
  - id: obscured-vision
    name: 视线受阻
    stacking_key: obscured-vision
    default_duration_profile_id: brief
    recurring_impact_profile_id: null
    recovery: 清理眼睛或等待干扰散去。
    thresholds: []
entity_mechanics_profiles:
  - id: wanderer
    name: 旅人
    meters: [{ definition_id: health, current: 20 }]
    quantities: [{ definition_id: spirit-stone, amount: 1 }]
    ratings: [{ definition_id: resolve, value: 1 }]
adjudication_calibrations:
  - id: improvised-sand
    situation: 从脚下沙地抓沙撒向近处敌人的眼睛。
    difficulty: opposed
    risk: risky
    effect: standard
    explanation: 沙土是有环境依据的一次性手段，成功产生视线受阻。
random_distributions: []
```

`rule_packages` 必须包含 `core-resolution@2.0.0`，并可追加服务端注册的精确版本；世界不能提供规则代码。Meter 阈值可以设置 lifecycle 或 Fact。Quantity 的生产与消耗分别由法则授权，转移保持守恒。Rating 是通用 aptitude 或对抗强度；一次检定最多使用一个归属于 actor 的 Rating，number Fact 不会自动成为 modifier。

所有剧本共享 `none | minor | standard | major | decisive` 效果档。`impact_profiles` 将档位映射为 Meter 的确定性增减并在边界 clamp；`duration_profiles` 只定义 Condition 的使用次数、模拟秒数或持续至解除；`condition_profiles` 可为重要自由语义状态声明 stacking key、持续影响、恢复说明和阈值。没有 profile 的状态仍可存在并参与后续语义裁决。`entity_mechanics_profiles` 是出生角色的 Meter、Quantity、Rating 模板，`adjudication_calibrations` 同时约束 planner、verifier 与测试，不是动作白名单。

`activity_resources` 声明每名 Agent 可被活动占用的通用容量；引擎不内置手、移动、战斗或治疗槽位。`shared_activity_resources` 声明多个 Agent 可竞争的 typed pool 种类：正数默认 claim、单位、是否允许行动原文明示数量、`reject | queue | adjudicate` 争用策略，以及 pause 时 `retain | release`。它不在这里声明总容量；每个 Entity 实例化自己的 pool。混合 claims 按 `adjudicate > queue > reject` 选择路线，但最终必须全部满足，模型不能借此修改容量或 claim 数量。

`temporal_profiles` 定义活动的 fixed、rate、staged、conditional、goal 或 ongoing 时间形态、检查点、是否可中断、反应超时策略和每 Agent 资源占用。每个 Profile 的 `selection.semantic_tags` 描述它覆盖的行动语义；`selection.evidence_requirement` 明确选择它所需的确定性证据：`none`、行动原文中的 `explicit_duration`，或与该 rate Profile 单位匹配的 `explicit_profile_quantity`。rate Profile 必须要求 `explicit_profile_quantity`；只有 fixed Profile 可以要求 `explicit_duration`；其他时间形态必须使用 `none`。`temporal_profile_coverage.required_semantic_tags` 是世界作者声明的最低语义覆盖，加载器会在启动前拒绝存在缺口的世界。调用模型前，引擎先从行动原文抽取带精确字符范围的证据，并仅暴露合格 Profile；若一个也没有则在模型边界之前确定性失败。`reaction_fallback` 可为 `continue_if_valid | pause | cancel`，缺省为 `continue_if_valid`；不可中断 Profile 只能使用该缺省值，且客观 continuation assertion 失效始终优先于 fallback。conditional Profile 还必须提交至少一个可持久化的 continuation assertion。goal Profile 表示有明确目标但没有可验证时长或数量的有限工作，使用 `check_every_seconds` 进行进展检查，不预设完成时间；持续条件可以为空，但显式提供的条件仍须成立，不能补造条件。`temporal_calibrations` 帮助语义 planner 在合格 Profile 中选择；模型不能提交原始世界时钟增量、最终进度或完成效果。`world_timers` 声明从 `elapsedSeconds = 0` 计算的绝对语义触发，只保存描述、到期时刻、唤醒 Agent 和授权 law；它不能携带未来 state delta。到期时内核把 Timer trigger 与同刻 Activity 联合交给 Truth 裁决。

离散随机分布由有序 step 组成。每个 step 声明等概率 outcome 槽位、抽取次数、`first | sum | values` 聚合和可选的前序条件；重复槽位表达权重。运行时在抽取前固定请求，并用 seeded RNG 执行。完整预算和提交语义见[Truth 与随机承诺](engine-runtime.md#truth-与随机承诺)。

## `entities/*.yaml`

```yaml
id: gatekeeper
kind: person
name: 守门人
description: 谨慎的石门守卫。
placement: courtyard
facts:
  - id: keeper-duty
    predicate: duty
    value: { kind: text, value: guard-the-gate }
    description: 他受命看守石门。
    access: { kind: private }
meters:
  - { id: "health:gatekeeper", definition_id: health, current: 15 }
quantities:
  - { definition_id: spirit-stone, amount: 20 }
ratings:
  - { id: "resolve:gatekeeper", definition_id: resolve, value: 3 }
agent:
  id: gatekeeper
  model_profiles:
    bootstrap: agent-strong
    mind: agent-fast
    reaction: agent-fast
  character:
    persona: { summary: 谨慎，重视职责。, voice: 简短克制。 }
    traits: []
    values: []
    emotions: []
    attitudes: []
    goals:
      - id: guard-gate
        description: 守住石门。
        priority: 0.9
        progress: 0
        target_ids: []
        motivated_by_ids: []
    commitments: []
  belief:
    local_entities:
      - { id: self, name: 我, description: 石门守卫。, status: observed }
    evidence: []
    claims: []
    bindings:
      - { local_entity_id: self, canonical_entity_ids: [gatekeeper] }
```

`placement` 为另一个 Entity ID 或 null。Fact value 为 text、number、boolean、entity 或 none；access 为 public、private 或指定 Agent。Meter、Quantity 和 Rating 必须引用 `mechanics.yaml` 中的定义并满足范围约束。

一个 Entity 以 `shared_activity_resources` 实例化自己拥有的共享 pool，例如独立的工作台 Entity 可以声明：

```yaml
shared_activity_resources:
  - { definition_id: workbench-use, capacity: 1 }
```

capacity 是非负有限数；loader 以 world hash、definition ID 和 Entity ID 派生 pool ID。Entity retirement 使容量变为不可用。硬容量不能由普通 Fact 代替，运行时 reduction 或 retirement 也不能遗留仍占用该 pool 的 Activity。

`agent` 可选；存在时，该 Entity 是可行动主体的 canonical 身体。Agent 拥有独立 character、belief、局部 identity 和模型 Profile。不同 Agent 不能共享 canonical Entity，每个 Agent 必须恰有一个 local binding 指向自身 Entity。没有 `agent` 的 Entity 仍可作为地点、物品、组织或其他世界对象。

Character 的 persona summary 必填，其他 facets 可为空。Belief 的 local entities、evidence、claims 和 bindings 构成该 Agent 的私有认知；claim 可以与 canonical truth 冲突。剧本不填写运行时 revision、step、provenance、lifecycle ledger 或时间戳，这些字段由 loader 和执行内核物化。

## `participation.yaml`

缺失该文件时，世界没有 Origin：可以以 Observer 身份单步、批量和实时演化，也可以接管已有 Agent，但不能通过普通新游戏创建角色。

```yaml
origins:
  - id: courtyard-wanderer
    title: 庭院旅人
    fantasy: 带着未知来历抵达石门。
    description: 从一名没有既定历史的旅人开始。
    entity_kind: person
    spawn_entity_id: courtyard
    persona: 好奇而谨慎。
    default_goal: 弄清这里发生了什么。
    relationship_hooks: [守门人会留意你的来意。]
    risks: [陌生身份可能引起怀疑。]
    mechanics_profile_id: wanderer
    image:
      path: origins/wanderer.webp
      alt: 一名站在石门庭院中的旅人
    fallback_arrival: 你站在石门庭院里，周围的世界仍在自行运转。
```

Origin 定义身份幻想、出生位置、初始 persona、默认 goal、关系钩子、风险、必填 Mechanics Profile、可选 Agent Profile、可选静态图片和入场生成失败时的回退文本。Participant 只能提供显示名称、外观描述和自由动机；引擎从 profile 确定性创建 Entity、Agent、goal、Meter、Quantity、Rating 和语义 ID，不让 LLM 修改出生点或数值。Observer 接管初始或运行时创建的存活 Agent 不依赖 Origin。

## 静态资源

资源只允许真实 PNG、WebP 和 AVIF；拒绝 SVG、动画和伪造扩展名。单文件不超过 4 MiB，世界总计不超过 32 MiB，宽高均不超过 4096 像素。Origin 图片必须提供用途化 alt 文本。

导入时按内容计算 SHA-256，运行时通过 hash 只读服务。世界 content hash 覆盖 manifest、法则、机制、实体、参与配置以及资源内容身份。

## 引用与加载

loader 验证 Entity、placement 无环、Fact、Agent self binding、character/belief 局部引用、全部 Mechanics Profile 与 shared-resource definition/pool 引用及范围、random distribution、模型 Profile、Origin spawn/mechanics/image、数量和所有 ID 唯一性。初始 Agent 的 `nextAction` 由引擎设为 null；初始 lifecycle、Fact provenance、character 时间戳和运行时身份由引擎注入。

loader 只接受 `schema_version: 14`。旧世界包、状态和存档直接拒绝，不提供迁移或兼容层。
