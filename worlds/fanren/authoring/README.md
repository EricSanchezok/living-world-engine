# 《凡人修仙传》制作档案

本目录是制作参考与进度的唯一入口。范围为本传涉及的人界、灵界及解释两界所需的关联空间；仙界不作为可探索世界。执行范围见[已批准规格](../../../docs/specs/0196-canonical-world-and-participation-seeds.md)。[前期调研](../../../docs/research/2026-10-17-fanren-canonical-world-authoring.md)保留抽读证据，不能替代本目录的完整制作状态。

## 时间与真实性

共同起点是第一章开头那一夜，三叔尚未到韩家提出入门安排。客观事实、人物说法、依据后文回溯的推定、原创补充、运行数值标定分别标记。章节发表顺序不等于世界时钟。人物后来才得到的装备、师承、职位和消息不得提前写入。

## 完成边界

正文获取、结构校验、逐批阅读、事实提取、二次复核、开篇定位、运行编译和实际游玩是不同状态。文件存在或自动检索命中都不能升级为人工阅读或复核。目录中的公告、作者感言、读者手册、番外和正文章节分开处理。正文仍有疑点时保留未决项；不从百科或模型记忆填成原文。

人界和灵界均须完成地区、人物、关系、规则、产业资源、历史及跨区联系。150 人和 700 人只属于测试档位。完整世界验收不能由某个局部样本或规模档位代替。

原始正文与网页缓存保留在仓库已忽略的 `.livingworld-cache/fanren-sources/`，不进入世界包或 Git。可审计的来源元数据、内容指纹、章节索引、差异、事实与原创设计进入本目录。运行目录只接收经过审定的资料。

## 编写与接续

[来源基线与核对工具](sources/README.md)记录获取和版本差异；[章节母表](coverage/chapters.jsonl)与[阅读批次](coverage/batches.json)记录文本进度；[世界覆盖表](coverage/world.json)记录两界、九种身份和运行验收。[第一批阅读记录](coverage/batch-0001.md)保留开篇时间隔离与待核问题。

每批最多八章，正文约两万中文字；长章按场景分段。事实条目保留来源章节身份、版本指纹、段落定位、成立时间、人物获知时间、依赖和冲突。不同来源的章节编号只能作为显示信息，身份使用来源章节 ID。标题缺失、错号、重号不得自动合并或删除正文。

[第五至十二批处理记录](coverage/batches-0005-0012.md)保留本轮引用、人物认识与身份歧义的修订，以及下一批提取和整章审定的不同接续位置。

[第十三至二十八批处理记录](coverage/batches-0013-0028.md)记录精确引用修订、索引覆盖与待审定边界。

[第二十九至三十六批处理记录](coverage/batches-0029-0036.md)记录后续正文引用、结构修订和接续位置；其中的后期人物关系仍不直接进入共同开篇。

[第三十七至四十四批处理记录](coverage/batches-0037-0044.md)记录后续引文与章节归属修订；当时累计 305 章完成候选提取，整章最终审定尚未完成；这是历史进度，当前状态见下文交付状态与来源封账。

[候选全域索引](index/README.md)按稳定记录身份连接批次资料，保留同名歧义。[制作分区](coverage/regional-plan.json)与[全域检索线索](index/region-mentions.json)同时覆盖人界、灵界和必要关联空间；字面命中不视为已读、已复核或开篇存在证明。

恢复工作先读取来源与覆盖状态、未决问题和最近已审定批次，随后处理下一个未完成批次。任何事实变更都检查依赖它的人物、关系、规则、出身与运行数据。构建不得用模型临时补齐资料。

## 交付状态

人界、灵界及限定关联空间的内容已完成统一制作与来源审定。35 个制作模块包含 5,164 个实体、846 个可行动人物，提供八种原创出身和唯一韩立身份。正式运行目标为[《凡人修仙传》世界包](../world/)。原著未明的开篇位置、资产和人员配置仍按回溯或原创标记；后期人物不会因进入索引就全部成为开篇存活角色。

全书 2,451 个正文单位、398 批输入的当前状态见[来源封账](coverage/source-closure.json)与[章节母表](coverage/chapters.jsonl)。[全局候选清单](reviews/global-candidate-manifest.json)和地区处置合计覆盖 53,818 条候选；8,370 项来源疑点逐条保留处置依据。逐批来源复核、编辑对候选的直接审定和针对性原文回读分开记录，不宣称根代理重新逐字读过整部小说。早期批次日志与[本地阶段验收](reviews/bounded-closing-review.md)保留当时边界，当前制作状态以封账和[世界覆盖表](coverage/world.json)为准。

九种身份的背景、资产权属、具体人物、秘密与开场选择见[出身设计](origins.yaml)。[开篇编写样本](../samples/opening/README.md)是保留的历史阶段产物；新世界使用完整运行包，不再以样本名称作为正式入口。完整包的导入、出身初始化、真实游玩及定点修复见[统一验收记录](validation/full-world-acceptance.json)；内容审定、运行结果和呈现质量分别有证据，不互相替代。

[最终游玩复核](validation/full-world-play-review.md)说明实际完成的盘货与报告、呈现修复、调用量和体验限制。正式世界入口为 `/worlds/fanren`，名称为《凡人修仙传》。

已有实测作为具体行为的证据复用：[首轮](validation/initial-live-runs.json)、[自由移动和法力消耗](validation/followup-live-runs.json)、[盘货报告与御物](validation/compound-action-retest.json)、[六个新增入口](validation/nine-origin-first-runs.json)、[富商付款](validation/merchant-payment-retest.json)、[灵根检测与阵片调查](validation/discovery-live-runs.json)。这些记录保留各自世界版本、失败、修复和保底呈现情况，不改写成最终版本全部玩法通过。

[150 人与 700 人规模试验](validation/population-probes.json)各完成一次真实自治推进，分别有 150 / 700 人决策、143 / 693 人实际行动。试验主要清点已有财物，关系事实存在但没有覆盖长期、高冲突的复杂社会演化。本轮不重复已通过试验；完整包的新验收须单列加载人数与实际参与人数，不能把 846 个可行动人物写成 846 人都已实际行动。

历史[实现检查记录](validation/implementation-checks.json)保持原本的样本验证及预期拒绝边界。最终构建重新计算来源、候选、引用和区域签审；保存的完成布尔值不能独立放行。

## 抽取与构建工具

[正文复核执行参考](sources/adjudication.md)说明 Flash 默认配置、无需模型调用的计划检查、合格结果复用、局部修复及调用上限。

[抽取规则](extraction-policy.md)用于每批两遍正文对照。`npx tsx scripts/world-authoring/extract-fanren.ts --start batch-0001 --count 1` 调用已配置模型，原始输出与调用证据保存在忽略缓存中；[抽取候选](extractions/batch-0001.json)保留定位指纹，不携带原文段落，也不自动获得运行许可。精确引文失败会阻止产物，必要的编辑修改另存[绑定来源和草稿指纹的修订记录](reviews/batch-0001-corrections.json)。机器提取可以先于人工逐章通读；`extracted` 不意味着 `reviewed`。

[样本事实](claims/opening-sample.json)只对选定事实作开篇审核，不能据此把整章标为复核完毕。[样本模块](modules/opening-sample.json)存完整运行合同；[审定记录](reviews/opening-sample.json)绑定模块与事实指纹。构建先检查依赖、开篇时间、原文定位与审批指纹，再执行世界格式校验及 ZIP 导入回读。构建过程不调用模型，也不填补未知。

```sh
npx tsx scripts/world-authoring/build-fanren.ts full
npm run world:validate -- worlds/fanren/world
npx tsx scripts/world-authoring/play-fanren-sample.ts herbal-apprentice
npx tsx scripts/world-authoring/play-fanren-sample.ts merchant-root
npx tsx scripts/world-authoring/scale-fanren-sample.ts 150
```

完整目标使用 `build-fanren.ts full`；当章节、两界目录、身份或正文完整性仍有未决项时，该命令拒绝发布。原文、原始调用和 ZIP 位于忽略缓存，受版本管理的世界 YAML 与构建回执可以独立检验。
