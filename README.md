# Living World Engine

An engine for persistent, interactive worlds inhabited by autonomous AI agents.

本仓库是 **Computable Worlds** 研究方向的一个持续演化实现与实验工作台，当前运行时品牌为 Living World Engine（活世界引擎）。研究对象不是某一个固定引擎，而是能够被初始化、推进、观察、干预和回放的可执行世界；核心问题是这种世界轨迹能否训练模型获得状态条件化的交互拟真与持久世界线能力。

当前实现是剧本驱动的开放世界 AI 游戏引擎：玩家提交的是任意自然语言目标，而不是动作菜单中的 `actionId`；所有自主 Agent 基于各自有限认知同时行动，唯一 Truth Engine 依据世界真相、法则与检定联合裁决，并在每个世界步骤原子持久化。实现会继续变化，不应被视为 Computable Worlds 的定义或最终架构。

研究文献与论文方向统一维护在 Scholens 项目 [Computable Worlds](https://scholens.sanchezcloud.net/projects/26668cf0-6489-4657-9b33-c1aba2b14a1b) 中。

## 快速开始

```sh
npm install
DEEPSEEK_API_KEY=... npm run dev
```

打开 <http://localhost:3000>。默认[模型目录](docs/game-design/model-gateway.md)注册 DeepSeek、OpenAI、xAI、校园网 Qwen3.8-27B，以及智谱、MiniMax、Kimi、MiMo 的 API 与编程套餐账户；只有世界或 Agent 实际选择某个 Profile 时才要求对应密钥，缺失时显式失败且不 fallback。仓库参考世界当前统一使用固定的 `deepseek-v4-flash` Profile，并关闭 thinking；本地 live smoke 默认使用校园网 `Qwen3.8-27B`，Benchmark 与回放可以固定快照和具体模型。运行时不以别名、环境字段覆盖或生产 mock 改写选择结果。

`npm run dev` 使用 SQLite Execution Ledger 持久记录完整执行证据；正常运行、Inspector、重放和实验读取同一事实源。数据包含参与者输入与世界秘密，存储和访问边界见[运行时可观测性](docs/game-design/runtime-observability.md)。

仓库中的[参考世界工程](worlds/README.md)提供可审阅、可校验的可玩内容；应用创建全新的本地数据库时会通过普通严格导入路径安装随附世界。用于测试契约的最小世界位于 `test/fixtures/open-world-script/`，不作为产品内容安装。

## 常用命令

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm run world:validate -- <world-directory>
npm run world:import -- <world.zip> [--replace]
npm run models:status
npm run models:refresh
npm run debug:doctor
npm run debug -- find --invocation '<execution-id>::<source-invocation-id>'
npm run test:live:model -- --account <account-id>
npm run test:live:glm
npm run test:live:deepseek
npm run test:live:qwen
npm run check:fast
npm run check:all
```

`test:live:qwen` 使用校园网 `Qwen3.8-27B` Profile，`test:live:glm` 显式切换到 GLM Coding Plan Profile，`test:live:deepseek` 使用参考世界默认的 DeepSeek Profile；三条路径都必须形成 revision。Qwen 路径要求 `INF_API_KEY`，GLM 和 DeepSeek 分别要求 `ZHIPU_CODING_PLAN_API_KEY` 或 `DEEPSEEK_API_KEY`，不打印或持久化密钥。

## 从哪里开始读

- [系统架构](docs/architecture.md)
- [世界剧本格式](docs/game-design/script-format.md)
- [Truth Engine 运行时](docs/game-design/engine-runtime.md)
- [模型目录与 Gateway](docs/game-design/model-gateway.md)
- [World Instance API 与参与体验](docs/game-design/presentation.md)
- [决策日志](docs/decisions/README.md)
