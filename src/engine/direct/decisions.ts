import type { StructuredModelProvider, ModelExecutionScope } from "../models/model-provider";
import { executeDecisionV2, decisionPromptV2, type DecisionBatchV2, type DecisionQuestionV2, type DecisionInstructionProfile } from "../models/decision-v2";
import { contentHash } from "../models/model-audit";
import type { JsonValue } from "../runtime/json";
import type { DirectDecisionUse, DirectRuntimeState } from "./contracts";
import { dependencyVersions } from "./state";

function wireValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(wireValue) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, wireValue(child)])) as T;
  return value;
}

export class DirectDecisions {
  readonly uses: DirectDecisionUse[] = [];
  private readonly modelAudits: import("../contracts/model").ModelExecutionAudit[] = [];
  private ordinals: Record<string, number> = {};
  constructor(readonly provider: StructuredModelProvider, readonly control: DirectRuntimeState, readonly scope: ModelExecutionScope) {}
  next(subject: string): number { return this.ordinals[subject] = (this.ordinals[subject] ?? 0) + 1; }
  async ask(owner: string | null, state: JsonValue, reads: Record<string, string>, questions: Record<string, DecisionQuestionV2>, profiles = this.control.models,
    instructionProfile?: DecisionInstructionProfile) {
    // Optional TypeScript fields have the same meaning before and after JSON persistence.
    state = wireValue(state); questions = wireValue(questions);
    const batch: DecisionBatchV2 = { version: 2, view: owner ? { kind: "agent", agentId: owner, projectionHash: contentHash(state) }
      : { kind: "world", projectionHash: contentHash(state) }, state: structuredClone(state), questions: structuredClone(questions), dependencies: dependencyVersions(this.control, reads) };
    const key = contentHash({ batch, profiles, catalog: this.control.modelCatalogHash, registry: this.control.registryHash, prompt: decisionPromptV2(instructionProfile).version });
    const cached = this.control.cache[key];
    if (cached) { this.uses.push({ batch, result: cached, reused: true }); return cached.answers; }
    const subjectId = owner ?? "world";
    const result = await executeDecisionV2(this.provider, { ...this.scope, subjectId, profileId: profiles.decision,
      memorySubjects: owner ? [owner] : Object.keys((state as { deliveredEvidence?: Record<string, unknown> }).deliveredEvidence ?? {}),
      fallbackProfileId: profiles.fallback, modelRegistrySnapshotHash: this.control.registryHash,
      allocateInvocation: () => this.next(subjectId), instructionProfile, batch });
    const { audits, ...saved } = result;
    this.modelAudits.push(...audits);
    this.control.cache[key] = saved;
    const keys = Object.keys(this.control.cache);
    if (keys.length > 256) delete this.control.cache[keys[0]!];
    this.uses.push({ batch, result: saved, reused: false }); return result.answers;
  }
  audits() { return this.modelAudits; }
}
export function selected(answers: Awaited<ReturnType<DirectDecisions["ask"]>>, key: string): string {
  const value = answers[key]; if (value?.type !== "choice") throw new Error(`missing choice ${key}`);
  return value.choice;
}
