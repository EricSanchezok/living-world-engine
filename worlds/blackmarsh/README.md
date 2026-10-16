# 黑沼边境

《黑沼边境》把完整 Blackmarsh 地区改编为 Living World Engine 的多 Agent 参考世界。它没有预定章节或胜利路线；城邦、游侠、精灵、维京流亡者、兽人部族、商会、外来帝国与古老异物从同一初始时刻开始追逐各自目标。

## 目录

- [`world/`](world/)：可直接校验、打包和导入的 schema v17 世界目录。
- [`docs/design-brief.md`](docs/design-brief.md)：玩家位置、创作边界、核心矛盾与动态世界原则。
- [`docs/source-ledger.md`](docs/source-ledger.md)：原始版本、校验和、逐章提取范围和排除项。
- [`docs/world-bible.md`](docs/world-bible.md)：统一历史、Viz、文明格局和超自然底层。
- [`docs/geography.md`](docs/geography.md)：17 个命名地理区、旅行尺度与全部 75 个 keyed hex。
- [`docs/factions.md`](docs/factions.md)：政权、组织、部族、机构的资源、盟敌与内部分裂。
- [`docs/agents.md`](docs/agents.md)：47 个初始自主 Agent 的选择尺度与戏剧压力。
- [`docs/knowledge-and-secrets.md`](docs/knowledge-and-secrets.md)：20 条原作传闻、秘密持有人与证据路径。
- [`docs/mechanics.md`](docs/mechanics.md)：生命、能力、资源、时间和聚合实体的数值标尺。
- [`docs/events.md`](docs/events.md)：静态遭遇分类、三个开局时钟和截止后的状态要求。
- [`ATTRIBUTION.md`](ATTRIBUTION.md)：上游署名、许可链接和改编声明。

## 校验

```sh
npm run world:validate -- worlds/blackmarsh/world
```

应用创建全新的本地数据库时，会把 `world/` 内容打包为内存中的单一世界根目录 ZIP，并通过与用户世界相同的严格导入路径安装一次。已有数据库不会在启动时自动覆盖或恢复该世界；手工验证安装流程时，仍可打包 `world/` 并从世界库导入。

## 内容原则

这个世界覆盖整片黑沼地区，而不是截取某段冒险。具名决策者以自主 Agent 运行；人口、部队、商队和兽群以实体与事实聚合。原作的固定遭遇被表达为初始局势、动机、有限认知和空间状态，后续结果由玩家与各 Agent 的行动共同产生。

世界内容及中文改编的许可边界见 [`ATTRIBUTION.md`](ATTRIBUTION.md)。
