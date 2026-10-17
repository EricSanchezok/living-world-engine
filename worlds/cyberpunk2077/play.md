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

   应用首次创建本地数据库时会安装内置世界；若已用命令行导入创建数据库，应用不会自动补装内置世界。如需保留内置内容，先启动应用，再从网页导入。已有实例是世界的独立快照；重新导入不能更新它们，应另建实例检验新版本。当前运行时使用实例格式 v32；旧格式目录应保留为归档，在新的数据目录建立实例，不迁移旧存档。

3. 在世界列表选择“赛博朋克 2077：夜之城众生”，以观察者创建实例。在观察角色列表选择 `O01` 至 `O12` 对应的姓名，再接管角色。接管继承原有现金、物品、关系和私人认知，不会生成第二个同名角色。这一入口使用预置姓名；自由改名、外观编辑及新建出身初始化不属于本包能力。

4. 在角色视角查看人物、财物和已知地点，直接用自然语言行动。例如 O01 可以输入“请马尔科逐项解释这份维修报价，我先核对再决定是否付款”，O05 可以输入“与劳尔一起检查冷藏车的阀门，然后讨论三辆车如何调度”。必须实际付款才发生现金变化，询价和口头承诺不会自动扣款。

5. 可以拒绝最初的方案、回到自己的住所、去市场采购或寻找别的职业联系。其他人的意愿仍由他们决定。保存后重新打开同一实例，接管身份及已有经历保留。

共同和业务账户使用现场语音终端。需要付款时直接说出申请，例如：“我对项目账户的语音终端说：请向艾达支付 6000 欧元的首批控制器货款，使用项目资金。”核对回执与余额后再判断交易是否完成；询价、写草稿或操作其他设备都不等于已付款。

世界裁决使用 decision-deepseek-long，人物的自主动作解释与文字创作使用 creation-deepseek。人物还声明 decision-jev 作为 decision 能力绑定；各能力如何选择 Profile 见[模型职责](../../docs/game-design/direct-runtime.md#model-responsibilities)，输出容量与请求时限以[模型配置](../../config/models.yaml)为准。复杂回合可能需要较长时间。导入和初始人物建立不需要模型推理；接管会根据角色自己的记忆生成开场，提交行动、NPC 决策及文字呈现也需要这些 Profile 的服务可用。账号配置及故障检查遵循仓库的[开发说明](../../docs/development.md)和[调试参考](../../docs/debugging.md)。
