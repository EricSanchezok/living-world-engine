"use client";

import type { WorldInspectorStepDetail } from "../../shared/world-inspector-api";
import { JsonInspector } from "./world-inspector-json";

type Programs = NonNullable<WorldInspectorStepDetail["programs"]>;
const statusLabels: Record<string, string> = { running: "执行中", waiting: "等待证据", interrupted: "已中断", ended: "程序已结束",
  "needs-expansion": "需要新计划", completed: "目标已有完成证据", startable: "可执行", "needs-generation": "需要生成计划", "needs-decision": "等待判断",
  queued: "排队", "compilation-required": "需要生成或修复" };

export function WorldInspectorPrograms({ value, actorId }: { value: Programs; actorId: string }) {
  const relevant = (id: string) => actorId === "world" || actorId === id;
  const programs = value.programs.filter(program => relevant(program.ownerId));
  const decisions = value.decisions.filter(decision => relevant(decision.subjectId) || decision.subjectId === "world");
  const calls = value.calls.filter(call => relevant(call.subjectId) || call.subjectId === "world");
  const physical = calls.reduce((sum, call) => sum + call.invocations.reduce((count, invocation) => count + invocation.transports, 0), 0);
  const knownCost = calls.reduce((sum, call) => sum + call.invocations.reduce((cost, invocation) => cost + (invocation.cost.estimateCny ?? 0), 0), 0);
  const unknown = calls.flatMap(call => call.invocations).filter(invocation => invocation.cost.estimateCny === null || invocation.cost.unknownTransportUsage).length;
  return <section className="cg-inspector-section">
    <header className="cg-inspector-section__header"><strong>程序与决策</strong><b>{programs.length} 个程序实例</b></header>
    <p className="cg-inspector-technical-note">本次物理请求 {physical} 次，复用判断 {decisions.filter(decision => decision.reused).length} 项。
      已知用量估算 ¥{knownCost.toFixed(4)}{unknown ? `；${unknown} 项费用不完整` : ""}。费用按固定预算价格估算，包含修复请求。</p>
    <JsonInspector label="模型配置、调用用量与价格依据" value={{ models: value.models, calls }} />
    <div className="cg-inspector-slot-table-wrap"><table className="cg-inspector-slot-table">
      <caption>实际角色目标覆盖</caption><thead><tr><th scope="col">角色</th><th scope="col">目标</th><th scope="col">私有计划</th><th scope="col">世界执行</th><th scope="col">依据</th></tr></thead>
      <tbody>{value.worldCoverage.filter(row => relevant(row.ownerId)).map(row => <tr key={`${row.ownerId}:${row.goalId}`}>
        <td>{row.ownerId}</td><td>{row.goalId}</td><td>{statusLabels[row.status] ?? row.status}</td>
        <td>{statusLabels[row.executionStatus] ?? row.executionStatus}</td><td>{[...row.reasons, ...row.attempts.flatMap(attempt => attempt.failure ? [attempt.failure] : [])].join("；")}</td>
      </tr>)}</tbody>
    </table></div>
    {programs.map(program => <details key={program.instanceId} open={program.active}>
      <summary>{program.ownerId} · {program.name} · {statusLabels[program.status] ?? program.status}</summary>
      <p>执行结束：{program.completion.executionEnded ? "是" : "否"}；里程碑已有证据：{Object.keys(program.completion.milestones).length}；
        长期目标已有证据：{Object.keys(program.completion.goals).length}。</p>
      {program.completion.expansionReason && <p>扩展原因：{program.completion.expansionReason}</p>}
      <JsonInspector label="程序位置、等待条件与完成证据" value={program} />
    </details>)}
    <JsonInspector label="本次唤醒事件" value={value.wakes.filter(event => event.subjectId === null || relevant(event.subjectId))} />
    <JsonInspector label="资源占用、排队与释放记录" value={value.activities.filter(activity => relevant(activity.actorId))} />
    <JsonInspector label="已预约行动与恢复原因" value={{ pending: value.pending.filter(pending => relevant(pending.actorId)),
      failures: value.failures.filter(failure => relevant(failure.ownerId)) }} />
    <details><summary>具体判断 · {decisions.length} 项</summary>
      {decisions.map((decision, index) => <details key={`${decision.evidenceHash}:${decision.questionId}:${index}`}>
        <summary>{decision.subjectId} · {decision.choice} · {decision.model}{decision.reused ? " · 已复用" : ""}</summary>
        <p>{decision.instructions}</p>
        <JsonInspector label="候选项、概率与调用证据" value={decision} />
      </details>)}
    </details>
  </section>;
}
