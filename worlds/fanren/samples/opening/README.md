# 开篇编写样本

这是《凡人修仙传》共同开篇时点的九入口局部样本：八种原创出身及唯一韩立。原创入口建立各自的人物关系、物品、义务与认知。自由场景补全关闭。它不包含完整人界、灵界，不能替代完整世界验收。

[运行目录](world/script.yaml)是可导入的 schema v18 世界；[构建回执](../../authoring/reviews/opening-sample-build.json)记录文件指纹、来源依赖和 ZIP 回读结果。[制作档案](../../authoring/README.md)负责来源、覆盖和接续。[早期真实游玩](../../authoring/validation/initial-live-runs.json)、[后续复测](../../authoring/validation/followup-live-runs.json)、[复合动作复测](../../authoring/validation/compound-action-retest.json)和[新增六入口实测](../../authoring/validation/nine-origin-first-runs.json)分别保留实测证据与限制。不能把导入成功视为玩法通过。

在根目录运行 `npx tsx scripts/world-authoring/build-fanren.ts sample`，将审定模块编译为此目录，并把导入 ZIP 写到 `.livingworld-cache/fanren-artifacts/opening-sample.zip`。构建需要已经获取的原文缓存来核对指纹；不会下载或猜测缺失内容。

角色选择与具体背景见[九种身份设计](../../authoring/origins.yaml)。韩立接管既有身份；药童持受托药材；富商继承人拥有私钱但尚未接掌商号；镖局学徒确实无灵根；旁支、筑基、结丹、化神和炼虚出身带有对应能力与资产。家产、族产、货物、人情与有争议物品单独表达。隐藏灵根、货物去向、封签内容和个人动机不会自动进入玩家知识。

v0.3.0 为灵根和可调查物件补齐发现条件。验灵读取既有属性；验灵者先获得结果，报告另行发生。已入门原创身份及镖局学徒保有以前接受检查的记忆，韩立、药童和富商继承人尚不知道自己的资质。具体验灵手艺为原创补写。[检测和阵片检查记录](../../authoring/validation/discovery-live-runs.json)保留状态证据与呈现限制。
