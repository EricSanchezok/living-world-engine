import type { RuntimeError } from "./observability";

export const EXECUTION_STAGES = [
  { index: 0, key: "input-roster", label: "输入绑定与 Agent roster" },
  { index: 1, key: "action-compilation", label: "行动编译" },
  { index: 2, key: "grounding-resource-admission", label: "Grounding 与资源准入" },
  { index: 3, key: "reaction-perception", label: "反应与感知" },
  { index: 4, key: "temporal-dependency", label: "时间边界与依赖图" },
  { index: 5, key: "truth-resolution", label: "Truth 裁决与计划校验" },
  { index: 6, key: "transition-causal-verification", label: "状态变更与因果校验" },
  { index: 7, key: "observation-agent-mind", label: "观察与 AgentMind" },
  { index: 8, key: "canonical-validation", label: "Canonical 校验" },
  { index: 9, key: "atomic-commit", label: "原子提交" },
] as const;

export const DIRECT_EXECUTION_STAGES = [
  { index: 0, key: "input-roster", label: "输入绑定与 Agent roster" },
  { index: 1, key: "direct-action", label: "行动解释与选择" },
  { index: 2, key: "direct-adjudication", label: "局部裁决与活动准入" },
  { index: 3, key: "direct-settlement", label: "事件结算与观察" },
  { index: 4, key: "canonical-validation", label: "Canonical 校验" },
  { index: 5, key: "atomic-commit", label: "原子提交" },
] as const;

export function executionStages(producer?: string): readonly ExecutionStage[] {
  return producer === "direct" || producer === "direct-world" ? DIRECT_EXECUTION_STAGES : EXECUTION_STAGES;
}

export type ExecutionStageKey = ExecutionStage["key"];
export type ExecutionStage = typeof EXECUTION_STAGES[number] | typeof DIRECT_EXECUTION_STAGES[number];

export interface ExecutionStagePosition {
  index: number;
  key: ExecutionStageKey;
  label: string;
}

export interface ExecutionStageHooks {
  readonly enabled: boolean;
  readonly current?: ExecutionStagePosition;
  before(stage: ExecutionStagePosition): Promise<void>;
  after(stage: ExecutionStagePosition): Promise<void>;
  failed(stage: ExecutionStagePosition, error: RuntimeError): void;
}

export function executionStage(key: ExecutionStageKey, producer?: string): ExecutionStagePosition {
  const stage = executionStages(key.startsWith("direct-") ? "direct" : producer).find((candidate) => candidate.key === key);
  if (!stage) throw new Error(`unknown execution stage: ${key}`);
  return stage;
}
