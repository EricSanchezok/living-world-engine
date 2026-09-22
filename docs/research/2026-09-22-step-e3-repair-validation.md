# STEP-E3：修复与追加预算验证

本记录跟踪原实验暴露的缺陷修复及独立 R1 验证。[原实验报告](2026-09-22-step-e3-execution.md)保留原冻结版本的 23/198 条测量；新版本结果不填入原版本剩余的 175 条。

## 确定性修复

| 问题 | 修复边界 | 验证证据 | 提交 |
| --- | --- | --- | --- |
| Activity details 覆盖同名 Temporal Profile | Profile 与 Activity 按各自身份建索引 | 实际编译回归；5 份历史 context 的批次与单槽内容一致，源不变 | `481caa23` |
| 反应中的新身份未传给替换动作编译器 | 只在本 Agent 的临时计划副本应用冻结 stimulus 的绑定 | 序列化、恢复、替换编译、提交、重放及跨 Agent 隔离 | `7cf96ee5` |
| C 在完成阶段改写冻结执行状态 | 反应 program 只用于当前 completion，不改冻结 journal | 真实注册入口先复现拒绝，修复后提交、重放、重复提交拒绝和下一步通过 | `c5b43f3d` |
| 失败运行留下 busy Activity，阻断新输入 | 验证所有权、revision、幂等身份后建立新 WorldRun，保留旧错误 | 完整宿主回归；原数据库副本接收新输入且旧 run 和世界哈希不变 | `e4d9566a` |
| 定向修复拒绝本计划的待定 Condition | 仅允许同 action、subject、channel 的效果字段沿用原编号 | 正例提交重放；5 类越界反例回滚；历史 5 个失败输出材料化全部通过 | `77440c53` |
| Observation action 数组重复导致超出模型上下文 | B/C 同时选用现有精确 record/sequence 字典 | 真实 12 槽请求从 2,982,683 字节减至 1,501,664 字节，展开哈希一致；注册入口回归通过 | `bc22e73c` |

各修复单元均在完整 `check:fast` 通过后提交并推送。条件修复后的完整检查为 341 个测试文件、2068 条测试。离线复现和自动测试没有 DeepSeek 支出，也不构成真实玩家任务成功证据。永久回归与原因分别记录在 postmortem [0144](../postmortems/0144-activity-details-overwrote-temporal-profiles.md)、[0145](../postmortems/0145-reaction-compilation-lost-introduced-identities.md)、[0146](../postmortems/0146-reaction-programs-mutated-frozen-execution-state.md)、[0147](../postmortems/0147-failed-runs-blocked-new-player-actions.md)、[0148](../postmortems/0148-plan-repair-rejected-its-own-pending-conditions.md)、[0149](../postmortems/0149-observation-repetition-exhausted-model-context.md)。

## R1 验证协议

R1 使用独立证据根 `.livingworld-benchmarks/step-e3/repair-v1/` 和独立追加 100 元账本。协议、完整 49 人世界、三组 canary 与三十组 confirmation 的固定队列、原输入与接受条件由 [0180](../specs/0180-executable-interaction-diagnostic.md)及[运行器](../../scripts/experiments/step-e3-player.ts)约束。修复后的 B、C producer 均为 version 3。原世界不补写 authored capabilities，不减少角色、动作自由或批量槽位。

每对实验重新初始化一次完整世界，再从相同未演化快照分成 B/C；各臂沿各自实际提交轨迹执行。所有初始化、修复、失败、回退和未知用量都计费；负面质量结果不取消后续诊断，预算门限仍然约束派发。费用按冻结的 DeepSeek 峰值单价估算，不替代账户账单。

## 实测状态

R1 实测尚未启动；当前支出为 0。原实验中的反馈主体混淆、无实际效果的持续推进及 W0 规则覆盖率问题尚无改善结论。后续评估以持久世界变化和有来源的反馈为准，不将成功状态、经过的时间或模型自述视作目标完成。
