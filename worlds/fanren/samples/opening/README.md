# 开篇编写样本

这是《凡人修仙传》共同开篇时点的局部样本，提供韩立、山村药童和灵界化神商行东家三个入口。原著人物只有一位韩立；原创入口建立各自的人物关系、物品、义务与认知。自由场景补全关闭。它不包含完整人界、灵界或其余六个已设计身份，不能替代完整世界验收。

[运行目录](world/script.yaml)是可导入的 schema v18 世界；[构建回执](../../authoring/reviews/opening-sample-build.json)记录文件指纹、来源依赖和 ZIP 回读结果。[制作档案](../../authoring/README.md)负责来源、覆盖和接续。[真实游玩记录](../../authoring/validation/initial-live-runs.json)保留已发现的运行问题，不能把导入成功视为玩法通过。

在根目录运行 `npx tsx scripts/world-authoring/build-fanren.ts sample`，将审定模块编译为此目录，并把导入 ZIP 写到 `.livingworld-cache/fanren-artifacts/opening-sample.zip`。构建需要已经获取的原文缓存来核对指纹；不会下载或猜测缺失内容。

角色选择：韩立直接接管既有身份；药童有三十六文私钱、自己的工具、师父所有的十二包药材与借阅札记；化神东家有私人灵石、独立记账的商号资金、实际到货、尚在货场的货物及两份未履行订单。关于灵根、货物去向和个人动机的隐藏事实不会自动进入玩家知识。
