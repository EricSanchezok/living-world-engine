# 世界导入

## 入口

- 浏览器：`POST /api/worlds/import`，multipart 字段 `file`，可选 `replace=true`。
- CLI：`npm run world:import -- <world.zip> [--replace]`。
- 目录预检：`npm run world:validate -- <world-directory>`。

## 安全限制

ZIP 本体最多 50 MiB、最多 5000 条目、展开数据最多 100 MiB。条目名拒绝反斜杠、NUL、绝对路径、`..` 穿越以及经 Unicode NFC 和大小写折叠后冲突的名称。展开后的世界还要通过严格目录、schema v15、静态图片与当前模型目录校验；未知 Profile、可执行代码、符号链接和未声明目录均拒绝。

## 原子安装

导入只在系统临时目录解压并规范化；完整 layout、schema、模型 Profile、规则包与图片验证成功后，按规范内容计算 `sha256`。`mechanics.yaml` 的离散随机分布以有序 steps 和原始 outcome 槽位进入契约；`participation.yaml` 与资源内容 hash 共同进入世界身份。SQLite 事务写入不可变 `world_versions` 并切换 `world_catalog` 当前指针；目标存在而未显式 replace 时返回 409。验证失败不开始写事务，数据库失败不改变当前版本，所有 staging 都会清理。

归档文件本身不作为运行时文件树安装；数据库保存规范化世界内容和按 hash 寻址的已验证静态资源。导入不迁移其他 schema 或存档，不安装依赖，也不执行世界内代码。
