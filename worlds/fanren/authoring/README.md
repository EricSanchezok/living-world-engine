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

[第三十七至四十四批处理记录](coverage/batches-0037-0044.md)记录后续引文与章节归属修订；累计 305 章完成候选提取，整章最终审定仍未完成。

[候选全域索引](index/README.md)按稳定记录身份连接批次资料，保留同名歧义。[制作分区](coverage/regional-plan.json)与[全域检索线索](index/region-mentions.json)同时覆盖人界、灵界和必要关联空间；字面命中不视为已读、已复核或开篇存在证明。

恢复工作先读取来源与覆盖状态、未决问题和最近已审定批次，随后处理下一个未完成批次。任何事实变更都检查依赖它的人物、关系、规则、出身与运行数据。构建不得用模型临时补齐资料。

## 交付状态

[本地收尾验收](reviews/bounded-closing-review.md)汇总当前地区草稿、新版运行时的九种身份初始化、限额真实游玩和完整世界的剩余门禁；[剩余清单](coverage/local-completion-gaps.json)保留尚未审定的具体类型与数量。该记录不将地区草稿或阶段试玩升级为全域验收。

通用出身初始化与既有人物入口已经落地。[九种身份设计](origins.yaml)包含背景、资产权属、具体人物、秘密与开场选择。[开篇编写样本](../samples/opening/README.md)提供九个可导入入口，均通过实际宿主初始化、认知隔离、财产检查与回放测试；它是阶段产物，不是两界完整世界。正文全篇校勘、全域展开、各身份完整玩法以及三个规模档位的验证仍未完成。

[首轮真实游玩记录](validation/initial-live-runs.json)检查持久化状态而非模型自报。样本入口、家庭认知与资产隔离通过静态及宿主测试；[后续复测](validation/followup-live-runs.json)已验证韩立自由移动和施术者法力扣除，并修复重复上下文传输；[复合动作复测](validation/compound-action-retest.json)又验证了目标库存清点、向指定对象报告、御物结束状态与法力消耗；其他玩法和规模验证仍未完成。

[新增六入口实测](validation/nine-origin-first-runs.json)验证了无灵根身份施法失败、私财资助不动族库、合作提议不改变族产、筑基与炼虚实际御物。筑基与旁支各有一次初始叙事被拒绝，随后修复通过，终态无降级呈现。[富商付款复测](validation/merchant-payment-retest.json)验证“五两”按五两守恒转移，商号资金未动；该轮首段叙事仍使用了保底呈现。这些单项结果不代表各身份的全部生活与修炼玩法已经通过。

[检测与调查实测](validation/discovery-live-runs.json)验证样本 v0.3.0：普通目测不泄露灵根；原创修士实际验灵、消耗法力后获知既有属性，再用对话报告给玩家；炼虚阵师检查阵片只发现已写入的结构。验灵轮仍有一段叙事使用保底呈现。检测手艺和原创器物的检查条件明确标为原创补写，不能冒充原著指定方法。

[150 人与 700 人规模试验](validation/population-probes.json)均完成一次真实自治推进，分别有 150 / 700 人决策、143 / 693 人实际行动。新增居民是试验用原创人物；任务主要是清点自己的财物，关系事实保留但未进行复杂关系冲突。长期演化、高冲突场景、九入口在大规模中的运行及完整两界人口仍未验证。两轮实际调用量、token、耗时、Ledger 完整性和限制均写入记录，未取得的费用保持未知。

[实现检查记录](validation/implementation-checks.json)记录整套仓库检查、局部样本验证、此前超时及完整构建的预期拒绝。测试通过不改变全域资料仍待制作的状态。

## 抽取与构建工具

[抽取规则](extraction-policy.md)用于每批两遍正文对照。`npx tsx scripts/world-authoring/extract-fanren.ts --start batch-0001 --count 1` 调用已配置模型，原始输出与调用证据保存在忽略缓存中；[抽取候选](extractions/batch-0001.json)保留定位指纹，不携带原文段落，也不自动获得运行许可。精确引文失败会阻止产物，必要的编辑修改另存[绑定来源和草稿指纹的修订记录](reviews/batch-0001-corrections.json)。机器提取可以先于人工逐章通读；`extracted` 不意味着 `reviewed`。

[样本事实](claims/opening-sample.json)只对选定事实作开篇审核，不能据此把整章标为复核完毕。[样本模块](modules/opening-sample.json)存完整运行合同；[审定记录](reviews/opening-sample.json)绑定模块与事实指纹。构建先检查依赖、开篇时间、原文定位与审批指纹，再执行世界格式校验及 ZIP 导入回读。构建过程不调用模型，也不填补未知。

```sh
npx tsx scripts/world-authoring/build-fanren.ts sample
npm run world:validate -- worlds/fanren/samples/opening/world
npx tsx scripts/world-authoring/play-fanren-sample.ts herbal-apprentice
npx tsx scripts/world-authoring/play-fanren-sample.ts merchant-root
npx tsx scripts/world-authoring/scale-fanren-sample.ts 150
```

完整目标使用 `build-fanren.ts full`；当章节、两界目录、身份或正文完整性仍有未决项时，该命令拒绝发布。原文、原始调用和 ZIP 位于忽略缓存，受版本管理的世界 YAML 与构建回执可以独立检验。
