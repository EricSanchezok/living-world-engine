# World Instance API 与会话体验

## 投影边界

公共产品契约为 `src/shared/world-api.ts`（API v17）。Participant 的 `controlledView` 是本人所控 Agent 在当前 revision 的 `AgentPerspectiveView`；DTO 只包含 Arrival、行动、Observation、授权 Activity 进度与该 Agent 的私有状态。反应窗口只额外投影本人 stimulus，不暴露 basis、其他主体请求或 canonical binding。对话由这些持久事实投影，不保存独立聊天记录。

Observer 契约为 `src/shared/world-observer-api.ts`。`selected.perspective` 与 Participant 使用同一投影器，包含所选 Agent 的精确自身状态、授权关系、主观认知、角色状态和完整主观历史；切换 Agent 不形成跨主体认知聚合。

本地受信任 Inspector 使用 `src/shared/world-inspector-api.ts`。它可以读取 canonical truth、隐藏检定、全部认知和 Execution Ledger，因此默认不可见，数据不能进入 Participant 或 Observer 投影。

当前 Principal Resolver 从 `x-lwe-principal` 读取稳定身份，本地默认值为 `local`。产品入口限制一个 active Participant；World Instance、PolicyBinding 和 ActionWindow 以复数 Participant 建模。

## HTTP 资源

| 方法与路径 | 语义 |
|---|---|
| `GET /api/worlds` | 列出已安装的 schema v17 世界 |
| `POST /api/worlds/import` | 导入或显式替换世界 ZIP |
| `DELETE /api/worlds/:id` | 在没有关联实例时卸载世界 |
| `GET /api/worlds/:id/start-options` | 读取 Origin 与 Observer 准入选项 |
| `GET /api/worlds/:id/assets/:hash` | 读取已验证的不可变静态图片 |
| `GET /api/instances` | 列出 World Instance |
| `POST /api/instances` | 以 Origin 或 Observer 原子创建实例 |
| `GET/PATCH/DELETE /api/instances/:id` | 读取、重命名或删除实例 |
| `POST /api/instances/:id/advance` | Observer 推进一个或指定数量的时间边界 |
| `PUT /api/instances/:id/realtime` | Observer 启停严格串行实时调度 |
| `GET /api/instances/:id/observer` | 按 AgentId 读取单主体 Observer 投影 |
| `GET/PUT /api/instances/:id/control` | 读取可接管 Agent 或原子转移控制权 |
| `POST /api/instances/:id/participants/:participantId/suggestions` | 显式请求或更换当前决策点的行动建议 |
| `POST /api/instances/:id/participants/:participantId/actions` | 幂等持久化自然语言根意图并启动逐边界 WorldRun |
| `POST /api/instances/:id/run/pause` | 在提交边界暂停指定 generation 的 WorldRun |
| `POST /api/instances/:id/run/resume` | 为 paused 或 budget-paused WorldRun 创建新 lease 并恢复 |
| `GET /api/instances/:id/events` | 订阅只含重新读取提示的实例更新 SSE |
| `GET /api/instances/:id/inspector/**` | 读取本地受信任 Inspector 投影与 Ledger 证据 |

所有改变世界或控制状态的请求使用 revision 或 WorldRun generation CAS。行动以 `submissionId` 幂等；重复请求返回已投影结果，不重复推进。失败、取消、暂停和迟到尝试不推进 revision；内部错误只存在于 Ledger 和 Inspector。

## 创建与控制

世界详情页的“开始新游戏”在当前 URL 打开两阶段准入对话框。身份选择与角色定制共用最大 66rem 宽、`min(48rem, 100dvh - 2rem)` 高的固定弹窗，标题与操作区固定，主体独立滚动；步骤切换只淡化内容。第一阶段是可横向切换的身份牌组，全部 Origin 与 Observer 作为同级卡片；Origin 有图片资产时显示图片，缺失时由宿主显示默认身份卡面。选定 Origin 后，第二阶段才收集名字、外观和动机。取消不创建实例；确认后执行 bootstrap、Origin admission、Arrival 与实例持久化，再进入 `/play/:instanceId`。Arrival 失败使用 Origin 回退旁白。

Observer 创建不生成 Participant。Observer 可以推进无人世界、选择任一 Agent 的视角，并接管任意存活且未被 external 策略占用的 Agent。接管持久化新的视角 Arrival；退出或切换角色在一个 CAS 中把原角色恢复为 model 策略。

缺失 `participation.yaml` 的世界没有 Origin，但仍支持 Observer 与接管已有 Agent。

## Participant 会话

Participant 页面使用 44rem 单轴 assistant-ui 消息流。第一条 World 消息是持久 Arrival；玩家行动为右侧自适应气泡，World Observation 为无气泡正文。最新 World 回复的复制操作旁提供“行动建议”按钮，按需结果由 `conversation.suggestions` 独立投影在回复之后，点击条目只填入 composer；非空草稿暂时隐藏建议与入口，异步结果不覆盖草稿或抢焦点。

旁白中的实体引用标记替代可见称呼，并保留角色私有的实体身份。发布时只消除标记前后紧邻的完整重复词组，不对普通正文全局去重，也不解析已送达对白中的标记。相同称呼绑定不同身份时保持各自引用；单字重叠和拉丁单词内部的部分匹配不自动删除。

composer 只负责发送、失败重试和可选的高级 detach，不提供单步、批量或实时按钮。发送行动时，服务端先持久化 intent 和当前 decision point 的 ActionWindow，再由后台 WorldRun 逐个最早时间边界推进，直到活动完成、失败、中断、需要选择、玩家暂停或运行预算耗尽。

Participant 底部由一个外框承载输入与运行状态。普通输入最小高度为 64px，多行编辑可增高；提交后锁定编辑高度，运行阶段与计时原位更新，返回输入时恢复自适应。`queued`、`running`、`pausing` 或提交请求处理中不挂载 composer，仅在同框显示运行状态与暂停控制。正常等待输入没有额外决策提示。`paused`、`budget-paused`、`preparation-invalidated` 和 `awaiting-decision` 允许重新提交自然语言行动；未提交的 reaction window 同时显示 stimulus、输入框和“保持当前行动”控制。Observer 始终使用只读消息流，不挂载 composer。

同一个 Participant intent 可以投影多条 committed Observation；每条显示对应世界时间、Activity 阶段和授权进度。`queued` 显示经过权限过滤的资源名称与队列位置，`ready` 显示资源已预留且会在下一次时间推进开始；两者都不暴露其他持有者的 canonical 身份。WorldRun 自动执行时 composer 切换为运行控制台并提供暂停；paused 后可以恢复，也可以发送普通自然语言行动取消或改变当前 Activity。自然等待只显示普通输入框，没有暂停说明、恢复按钮或单人输入倒计时。刷新与重复提交不会新增消息或重复行动；服务重启只将执行中的 run 转为 paused，已经等待输入的 run 保持原状态。状态和期限由[运行时契约](engine-runtime.md#worldrun-与暂停恢复)定义。

消息按自然顺序接续；手动上翻停止自动跟随，主动发送或回到最新恢复跟随。乐观行动与已确认行动共用消息身份。消息底部按实际底栏高度加 24px 避让；后台更新不重新聚焦输入框。桌面会话在消息轴外提供消息时间线轨道。每个当前权限投影中的世界回复对应一个可聚焦刻度；刻度点击只滚动同一会话 viewport，并可显示该回复的标题、摘要、step、revision 和授权 Activity 进度。轨道不读取 canonical truth，不显示其他主体认知，也不替代原生滚动条。移动端隐藏轨道。

## Observer 会话

Observer 使用同一消息布局的只读形式。每条记录由所选 Agent 在某个 revision 的行动与收到的 Observation 构成；footer 提供 Agent 切换、单步、十步、实时、视角和接管。

Observer 不能提交角色行动。接管成功后页面切换为 Participant 会话，并以新的持久 Arrival 开始当前控制阶段。

## 视角 HUD

视角 HUD 是最新已提交 revision 的只读投影。默认按状态、物品、目标和已知信息组织。顶部显示角色名、当前位置与累计经过时间；状态显示实际存在的 Meter、可见 Condition 及其描述，Rating 直接以紧凑数值格呈现，并在能力区统一说明范围；物品按 Quantity 与 containment 分别呈现数量和具象携带物；后者使用物品格，并标明所在容器。界面不虚构容量、空槽或物品种类，不把数量资源和具象物品混成一个计数。宿主保留剧本声明的名称与单位，不推断能力等级或物品类别。

目标与有效承诺各有唯一的主展示位置，不投影为信念边或“推测存在”的节点。已知信息使用自适应卡片网格，直接显示名称、来源、简短摘要与相关信息条数，支持按名称、描述、事实和态度搜索。物品和已知对象打开同一个详情阅读区，显示完整描述、相关事实、相信/存疑/不相信的判断和态度。依据在详情底部去重集中列出，各条判断按编号引用；有依据的目标与承诺也通过此阅读区查看。返回保留搜索词、滚动位置和原触发控件焦点。每条事实或判断归在其主体下，态度归在其对象下。桌面与手机使用同一份 DOM 和详情入口，信息不依赖画布可用性。

关系图通过已知信息区的视图切换按需打开，是辅助导航，只渲染焦点对象的一跳关系；对象选择可到达所有已知节点。画布有独立固定高度，文字保持可读缩放，选择节点不重新拟合视口。图例仅列出当前出现的事实、信念与态度类型，开放 predicate 保留为连线标签。“查看详情”打开同一个详情阅读区。呈现取舍见[分组视角阅读](../decisions/0243-grouped-perspective-reading.md)。

打开或关闭 HUD 不提交 Action、不产生对话、不推进时间，也不修改 belief。远处 Entity 只通过授权 Fact 或 Agent belief 出现；HUD 不读取 canonical 远程 placement，也不解释随身关系消失的原因。

全站选择器使用共享的主题化弹出菜单，包括视角关系图、观察角色与 Inspector 控件；菜单通过 Portal 避免滚动容器裁切，支持键盘导航、长列表滚动和 Escape 关闭后焦点返回。

## 控制球与 Inspector

可拖动控制球提供主菜单、存档、设置和视角工具；移动端使用 Sheet。设置中的“高级角色控制”开启 Participant detach 与直接切换；“显示世界调试器”开启 Inspector 工具，并提示其包含剧透、隐藏检定、全部认知和完整时间因果证据。Inspector API v9 的桌面界面保持左侧范围选择、中间摘要、右侧详情的三列层级，并以“调用 / 图谱 / 流程”切换中心视图。中心只显示可扫描的趋势、状态、时间戳和核心计数；调用列表使用 cursor 分页与窗口化渲染，语义图按阶段聚合，技术图受节点上限约束。顶部综合搜索同时过滤当前窗口的 Agent、Revision、节点和调用；输入 `executionId::sourceInvocationId` 并提交时直接打开调用详情。右侧按需展开完整审计字段，包括动态 Δt、边界来源、TemporalPlan、Activity 转换、Timer、决策点、共享资源容量/持有/队列/分配证据、提交前后快照，以及 logical invocation、transport attempt、retry、token、字节、payload artifact 和 validation 路径。错误也遵循同一层级：中心和流程只投影状态与短摘要，完整错误原文只在右侧单一的默认折叠“错误详情”中出现；关联事件和 payload 各由外层分组提供唯一标题。中心调用与时间线各自只有一个滚动根。失败或进行中的 attempt 在没有 Revision 时仍可从面板进入；本地 Debug CLI 支持按 execution、request、trace、artifact 和 diagnostic code 直接查询。

Inspector 的实时更新采用“事件分类 → 合并刷新 → 局部投影 → 局部渲染”链路。`model.*` 事件只更新调用投影（以及当前选中的进行中调用详情），阶段、步骤和运行事件更新窗口摘要、流程与图谱；heartbeat 不触发读取。刷新使用 250ms trailing 与 750ms 最大等待的有界合并，同一资源请求串行化，后台刷新不清空已有内容或显示全屏 loading。窗口、调用行和图谱节点按稳定 ID 结构共享，三列和中心视图使用 memo 边界，保持选中对象、展开状态、滚动位置与用户图谱 viewport。图谱仅在拓扑变化时重新布局，状态变化只更新节点数据；时间线与调用列表都维持单一滚动根和有限可视窗口。Inspector 服务端在同一 Ledger 快照内复用事件索引与投影缓存，缓存只优化读取，不改变 Ledger、提交或引擎语义。

工具使用注册槽位扩展；没有数据的工具不显示。弹层关闭后焦点返回触发控件，控制球位置在浏览器偏好中恢复。

## 界面约束

界面只使用内置组件、Lucide 图标和 `--cg-*` token；世界包不能注入 UI。体验支持键盘、可见焦点、触控目标、320 px、200% 缩放、RTL、reduced motion、forced colors 和无图片回退。长 ID、错误与 JSON 必须在自身容器内换行或滚动，不能扩大侧栏或对话框。

设计依据见 [0061](../decisions/0061-unified-agent-and-external-policy.md)、[0063](../decisions/0063-eager-reference-execution.md)、[0064](../decisions/0064-conversation-core-and-agent-perspective-observer.md)、[0068](../decisions/0068-unified-agent-perspective.md)、[0070](../decisions/0070-event-boundary-temporal-runtime.md)与 [0074](../decisions/0074-enforce-script-owned-shared-resource-pools.md)。

## 情境行动建议

正文发布完成后的稳定决策点提供“行动建议”入口；开场、回合结束、读取与刷新均不自动生成。点击后按钮原位显示“生成中…”，输入保持可用；结果整组出现。“换一组”沿用同一接口与生成器，将上一组作为避重复依据，在成功之前保留旧条目；失败可以显式重试。空结果显示简短说明，不补固定文案。建议只依据已发布的开场与对话正文、玩家行动和本人目标；未介绍的名称、位置描述、机制标签和内部结果记录不进入场景依据。目标表达意图，上一组建议也只是未执行的想法，两者均不能作为外部事实。未知目标应通过寻找或询问来探索，不预设其存在或位置。建议表达可以尝试的方向，不保证成功。

每个 Participant 只保存当前来源、请求 ID、状态、条目和执行引用。公共接口提供 idle、generating、ready、failed；不可用来源返回 null。显式请求携带 sourceId、requestId 和 expectedRequestId；重复请求复用当前记录，过期或并发请求返回冲突。提交行动、失去控制或世界流程未结束会使旧来源失效，迟到结果同时校验来源与请求 ID。读取复用保存结果，重启将中断请求标记失败并保留已成功的条目，不重试生成。

每次接受的请求最多增加一次逻辑 creation 调用，传输重试沿用网关策略。建议在角色绑定的同一模型与快照上使用经能力校验的关闭推理参数，完整请求与结果由 Ledger 保存。请求不修改世界 revision、时间、认知或行动记录；结果通过现有实例通知发布，无独立轮询接口。职责取舍见[按需建议决策](../decisions/0242-on-demand-published-context-suggestions.md)。
