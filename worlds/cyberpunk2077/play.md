# 导入并进入夜之城

本页是游玩教程。身份的具体资源和开场见[角色表](roles.md)，设定与制作范围见[作者参考](authoring/README.md)。

1. 在仓库根目录生成并校验世界包：

   ```sh
   node worlds/cyberpunk2077/authoring/build.mjs
   npm run world:validate -- worlds/cyberpunk2077/world
   ```

2. 启动本地工作台，在世界导入入口上传 `worlds/cyberpunk2077/dist/cyberpunk2077-night-city.zip`。也可在服务未运行时使用命令行，给导入和服务指定同一个数据目录：

   ```sh
   LIVINGWORLD_DATA_ROOT=.livingworld-v23 npm run world:import -- worlds/cyberpunk2077/dist/cyberpunk2077-night-city.zip
   LIVINGWORLD_DATA_ROOT=.livingworld-v23 npm run dev
   ```

   首次启动应用会安装内置世界；命令行先创建目录时不会替已有目录补装内置世界。如需保留内置内容，优先先启动应用，再从网页导入。已有实例是世界的独立快照；重新导入不能更新它们，应另建实例检验新版本。

3. 在世界列表选择“赛博朋克 2077：夜之城众生”，以观察者创建实例。打开控制角色入口，搜索 `O01` 至 `O12`，选择姓名并接管。接管继承原有现金、物品、关系和私人认知，不会生成第二个同名角色。这一入口使用预置姓名；自由改名、外观编辑及新建出身初始化不属于本包能力。

4. 在角色视角查看人物、财物和已知地点，直接用自然语言行动。例如 O01 可以输入“请马尔科逐项解释这份维修报价，我先核对再决定是否付款”，O05 可以输入“与劳尔一起检查冷藏车的阀门，然后讨论三辆车如何调度”。必须实际付款才发生现金变化，询价和口头承诺不会自动扣款。

5. 可以拒绝最初的方案、回到自己的住所、去市场采购或寻找别的职业联系。其他人的意愿仍由他们决定。保存后重新打开同一实例，接管身份及已有经历保留。

共同和业务账户使用现场语音终端。需要付款时直接说出申请，例如：“我对项目账户的语音终端说：请向艾达支付 6000 欧元的首批控制器货款，使用项目资金。”核对回执与余额后再判断交易是否完成；询价、写草稿或操作其他设备都不等于已付款。

世界使用 decision-jev、creation-deepseek 与 decision-deepseek-long Profile。长输出回退使用同一 DeepSeek 账号，给复杂裁决保留 32768 token 输出上限；普通请求仍走已有主 Profile。导入、初始人物建立和接管不需要模型推理；提交行动、NPC 决策及文字呈现需要这些 Profile 的服务可用。账号配置及故障检查遵循仓库的[开发说明](../../docs/development.md)和[调试参考](../../docs/debugging.md)。
