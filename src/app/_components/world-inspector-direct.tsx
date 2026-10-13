"use client";

import type { WorldInspectorStepDetail } from "../../shared/world-inspector-api";
import { JsonInspector } from "./world-inspector-json";

export function WorldInspectorDirect({ value, actorId }: { value: NonNullable<WorldInspectorStepDetail["directRuntime"]>; actorId: string }) {
  const relevant = (id: string) => actorId === "world" || actorId === id;
  const calls = value.calls.filter(call => relevant(call.subjectId) || call.subjectId === "world");
  const decisions = value.decisions.filter(decision => decision.view.kind === "world" || relevant(decision.view.agentId));
  const invocations = calls.flatMap(call => call.invocations), physical = invocations.reduce((sum, call) => sum + call.transports, 0);
  const known = invocations.reduce((sum, call) => sum + (call.cost.estimateCny ?? 0), 0);
  const unknown = invocations.filter(call => call.cost.estimateCny === null || call.cost.unknownTransportUsage).length;
  return <section className="cg-inspector-section">
    <header className="cg-inspector-section__header"><strong>意图、行动与 Jev 判断</strong><b>{value.actions.filter(action => relevant(action.actorId)).length} 项已结算行动</b></header>
    <p className="cg-inspector-technical-note">已记录物理请求 {physical} 次，复用判断 {decisions.filter(decision => decision.reused).length} 批；
      已知费用估算 ¥{known.toFixed(4)}{unknown ? `；${unknown} 项费用不完整` : ""}。失败传输的完整记录见模型调用列表。</p>
    <JsonInspector label="当前目标、活动、等待及局部失败" value={Object.fromEntries(Object.entries(value.intents).filter(([id]) => relevant(id)))} />
    <JsonInspector label="唤醒原因" value={value.wakes.filter(wake => relevant(wake.ownerId))} />
    <JsonInspector label="已结算行动及正在进行的活动" value={{ actions: value.actions.filter(action => relevant(action.actorId)), activities: value.activities.filter(action => relevant(action.actorId)) }} />
    <JsonInspector label="Choice、Noul、Score 判断与实际依赖" value={decisions} />
    <JsonInspector label="按需扩展的能力" value={value.capabilities.filter(capability => capability.ownerId === null || relevant(capability.ownerId))} />
    <JsonInspector label="模型配置、调用用量与价格依据" value={{ models: value.models, calls }} />
  </section>;
}
