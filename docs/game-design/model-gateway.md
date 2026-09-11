# 模型账户、目录与 Gateway

`config/models.yaml` 是生产运行时的可信模型配置入口。它保存账户渠道、协议、方言、请求地址、密钥环境变量名、并发限制与 Profile，不保存密钥。运行时严格读取并冻结 schema v3 配置；账户有凭据时才构造 Adapter，只有实际激活的 Profile 缺少凭据才会失败。

## 本地可信配置

```yaml
schema_version: 3
registry:
  refresh_interval_ms: 3600000
  request_timeout_ms: 10000
  stale_after_ms: 86400000
accounts:
  deepseek-api:
    channel: api
    region: global
    protocol: openai-chat
    dialect: deepseek
    models_dev_provider_id: deepseek
    base_url: https://api.deepseek.com
    api_key_env: DEEPSEEK_API_KEY
    max_concurrency: 16
profiles:
  truth-deepseek:
    account_id: deepseek-api
    selector: { kind: exact, model_id: deepseek-v4-flash }
    description: 高吞吐世界真值裁决
    allowed_roles: [truth-perception, truth-reaction-routing, truth-resolution, truth-transition, temporal-planner, action-grounding, observation-renderer, causal-verifier, arrival-generator]
    request_timeout_ms: 300000
    max_output_tokens: 131072
    # Application-level UTF-8 request budget; this is not the provider's
    # token-based context window. Oversized batches are split before transport.
    max_input_bytes: 4000000
    inference:
      thinking: disabled
      effort: auto
      reasoning_budget_tokens: auto
      reasoning_summary: auto
      text_verbosity: auto
      temperature: auto
      top_p: auto
model_overrides: {}
```

账户 ID 与 Profile ID 使用小写 kebab-case。账户选择 `openai-chat`、`openai-responses` 或 `anthropic-messages` 协议驱动，并选择一个独立 vendor dialect；同一协议和方言下增加区域或套餐账户只修改配置。`base_url`、`api_key_env` 与鉴权目标只来自本地配置，远程目录不能改写它们。当前账户清单以 [`config/models.yaml`](../../config/models.yaml) 为准；校园网 `qwen-campus` 使用 Qwen 方言向内部 OpenAI-compatible 网关发送 `chat_template_kwargs.enable_thinking`，并以 models.dev 中同模型 ID 的元数据作为能力锚点；SuperGrok 消费订阅不构成 xAI API 账户。

账户可以声明可选的 `network.local_address_env`，让服务从指定环境变量
读取物理网卡 IP，并仅为该账户创建绑定 `localAddress` 的 Node transport。
该值不进入模型审计或持久化状态；未设置时使用默认 Node 网络。当前
`qwen-campus` 使用 `QWEN_LOCAL_ADDRESS` 作为本地 TUN 绕行开关。

Accounts can independently opt into `network.dns_over_https_url`, an HTTPS endpoint supporting Cloudflare/Google DNS JSON. The account transport resolves IPv4 addresses with single-flight requests and the minimum alias/address TTL, while preserving the provider URL, Host and TLS verification. Only the DNS hostname goes to the resolver. Failed or mismatched answers fail closed; provider redirects and cross-origin use are rejected. Existing sockets may remain open after a DNS TTL expires; new connections refresh expired answers. This option does not retry model requests or change model billing evidence.

`network.socket_connect_attempts` accepts one or two and defaults to one. Selecting two enables [bounded socket establishment](../decisions/0111-bounded-socket-establishment.md) before HTTP handoff; the workbench and experiment runners use the same catalog setting. Failures after handoff remain subject to the separate model HTTP retry and billing policies.

套餐账户表示引擎具备对应的传输能力，不代表扩大厂商许可的使用范围。部署者仍须遵守各产品当时的用途与工具限制；例如智谱区分通用 API 与 Coding 端点，MiniMax 为 Token Plan 单独签发 Key，Kimi 要求 Coding Key 与开放平台 URL 对应，MiMo 也将 Token Plan Key、端点和适用场景与按量 API 分开。具体约束以[智谱 Coding Plan](https://docs.bigmodel.cn/cn/coding-plan/quick-start)、[MiniMax Token Plan](https://platform.minimaxi.com/docs/token-plan/quickstart)、[Kimi Code FAQ](https://www.kimi.ai/help/kimi-code/faq)和[MiMo Token Plan](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access)的当前官方说明为准；引擎不伪装客户端，也不绕过这些限制。

Profile 的 `allowed_roles` 覆盖 Truth、temporal planner、action grounding、Observation renderer、causal verifier、Arrival Generator 和 AgentMind 系列角色，每次调用按精确角色校验。`max_input_bytes` 是完整序列化模型请求的硬上限，也是 Observation 分批的 Context 预算。推理字段使用统一语义：`auto` 表示不发送该参数；显式 thinking、effort、reasoning budget、sampling 或其他控制只有在快照声明支持时才可进入 transport，不支持时在请求前失败。

Profiles may explicitly select `response_transport: deepseek-sse-v1` for DeepSeek OpenAI Chat JSON-object generation. The SDK requests native SSE and usage while preserving the complete prompts, schema and generation settings. Runtime accepts only a complete stream with stable identity, terminal finish reason, reconciled usage and DONE; partial text never reaches canonical validation. The default remains non-streaming. See [the streamed response contract](../specs/0091-complete-streamed-json-responses.md).

## 动态模型目录

远程元数据唯一来自 `https://models.dev/api.json`。注册表只规范化本地账户引用的 provider、模型 ID、family、状态、reasoning controls、tool/structured output、采样、日期、modality 与 limit；models.dev 返回的 API URL、环境变量名和包名不进入快照，也不参与请求。`model_overrides` 可按字段修正元数据或禁用模型，快照为每个字段记录 `models.dev` 或 `local-override` 来源。

规范化快照按内容 SHA-256 写入 `LIVINGWORLD_DATA_ROOT/model-registry/snapshots/`，检查时间另存，因此相同目录内容不会制造新快照。刷新使用十秒超时、ETag/304、single-flight 和每小时后台周期；失败保留最后有效快照，损坏响应不能切换 current pointer。一次 execution 在第一次模型调用时捕获一个快照，全部并行 Agent 复用该 hash；后续 execution 才能看到新快照。Benchmark 与回放可在 `modelRegistrySnapshotHash` 中固定历史快照，历史文件缺失即失败。

`exact` selector 只接受指定 ID，模型缺失、禁用、deprecated 或能力不兼容时不替换。生产目录中所有使用 DeepSeek 账户的 Profile 都精确绑定 `deepseek-v4-flash` 并显式关闭 thinking，避免目录刷新后静默切换到 Pro 或推理模式。`latest-compatible` 在单个 models.dev provider 内应用 family、简单 include/exclude glob、文本 modality、结构化结果、输出 limit 与显式 inference 要求，再按 `release_date` 降序、`last_updated` 降序、ID 升序选出唯一模型。运行中没有跨模型、跨账户、跨套餐或跨供应商 fallback。

## 协议、方言与结构化结果

`ProtocolDriver` 只负责 OpenAI Chat、OpenAI Responses 或 Anthropic Messages 的通用 wire contract。`VendorDialect` 负责 thinking/effort 字段、特殊 header、prompt cache 与响应差异。Kimi Coding 使用 `LivingWorldEngine/<version>` User-Agent，并以 Profile、prompt bundle 内容哈希和 bundle version 生成稳定 `prompt_cache_key`；它不伪装其他编码客户端。

结构化结果按协议和模型能力使用三条路径：原生 strict JSON Schema；JSON Object 加 schema prompt 和本地 Zod；强制 `submit_result` tool call 加本地 Zod。所有成功结果再次通过调用点的 Zod schema。引擎不从 Markdown、前后缀文字、截断文本或普通自然语言中猜测 JSON。Qwen campus Profile 使用 JSON Object 加本地 Zod（避免 vLLM 在不同复杂 schema 间切换结构化输出后端），并由方言注入关闭 thinking 的 chat-template 参数。

每个请求都携带 `system`、一到两句英文 `userPrompt` 和 `context`。Gateway 使用统一的 Context envelope，把任务放在原始 JSON 数据之前，并明确标记数据不是指令；严格 schema、JSON Object 与 tool-call transport 复用同一装配和字节计量函数。角色提示词与 transport 文本位于 [`src/engine/prompts/`](../../src/engine/prompts/)，通过缓存 loader 读取、trim、校验和内容哈希版本化；Next standalone 追踪该目录，浏览器代码不得导入它。

`StructuredModelProvider.generateStructured` 返回已验证值和 `ModelExecutionAudit`。请求显式携带 Profile、workload、batch、角色、主体、bundle 版本、schema 名、system prompt、user prompt、JSON Context、Zod schema、execution correlation、可选历史快照 hash 与 `AbortSignal`。Gateway 在 transport 前完成角色、凭据、快照、selector、能力与输入预算校验，并记录 system、user、context 与完整 request 的 UTF-8 字节数。

## 调度、失败与审计

`FairModelScheduler` 将实际 HTTP 执行限制在 global concurrency 与账户 concurrency 的交集内。每个 workload 是 FIFO lane，lane 之间公平轮转；队列满或超时返回 `ModelOverloadedError`，取消同时移除待执行任务并传递给在途请求。网络错误、408、429 与 5xx 最多三次 transport attempt，遵循 `Retry-After` 或指数抖动；400/401、结构化输出失败与语义拒绝不做 transport retry。

任何失败都留在原 Profile 和账户。结构化输出或引擎语义失败可由调用层生成新的 semantic repair invocation；网络、配置、取消、Ledger 与终端错误丢弃候选并保持 canonical revision 不变。

`ModelExecutionAudit` 保存账户、渠道、协议、方言、models.dev provider、selector、选定模型、catalog hash、registry snapshot hash、模型 metadata hash、请求与实际发送的 inference、结构化输出模式以及 invocation evidence。Invocation 保存规范请求/响应 hash、Context 计量、transport、token usage、finish reason、provider request ID 与语义结论。API key、原始密钥 header 与隐藏思维链不进入审计。

## 诊断与操作

`GET /api/model-registry` 返回目录健康度、快照、账户凭据是否存在和 Profile 解析结果，不返回密钥、端点、方言配置、selector 或 inference 配置。`POST /api/model-registry/refresh` 只访问固定 models.dev 地址并受 single-flight 与速率限制。设置页的“模型供应商”区域提供相同的只读状态和刷新操作。

```sh
npm run models:status
npm run models:refresh
npm run test:live:model -- --account <account-id>
```

Live smoke 只在开发者显式提供对应环境变量时调用一个账户；缺少其他账户凭据不影响它。上下文权威和认知投影由 [Truth Engine 运行时规格](engine-runtime.md#observation-与认知隔离) 定义，世界对 Profile 的引用由 [世界剧本格式](script-format.md) 定义，选择与快照的架构理由见 [ADR 0076](../decisions/0076-resolve-models-from-audited-capability-snapshots.md)。
