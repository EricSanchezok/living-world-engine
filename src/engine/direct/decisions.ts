import type { StructuredModelProvider, ModelExecutionScope } from "../models/model-provider";
import { executeDecisionV2, decisionPromptV2, type DecisionBatchV2, type DecisionQuestionV2 } from "../models/decision-v2";
import { contentHash } from "../models/model-audit";
import type { JsonValue } from "../runtime/json";
import type { DirectDecisionUse, DirectRuntimeState } from "./contracts";
import { dependencyVersions } from "./state";

export class DirectDecisions {
  readonly uses: DirectDecisionUse[] = [];
  private ordinals: Record<string, number> = {};
  constructor(readonly provider: StructuredModelProvider, readonly control: DirectRuntimeState, readonly scope: ModelExecutionScope) {}
  next(subject: string): number { return this.ordinals[subject] = (this.ordinals[subject] ?? 0) + 1; }
  async ask(owner: string | null, state: JsonValue, reads: Record<string, string>, questions: Record<string, DecisionQuestionV2>, profiles = this.control.models) {
    const batch: DecisionBatchV2 = { version: 2, view: owner ? { kind: "agent", agentId: owner, projectionHash: contentHash(state) }
      : { kind: "world", projectionHash: contentHash(state) }, state, questions, dependencies: dependencyVersions(this.control, reads) };
    const key = contentHash({ batch, profiles, catalog: this.control.modelCatalogHash, registry: this.control.registryHash, prompt: decisionPromptV2().version });
    const cached = this.control.cache.find(entry => entry.key === key);
    if (cached) { this.uses.push({ batch, result: cached.result, reused: true }); return cached.result.answers; }
    const subjectId = owner ?? "world";
    const result = await executeDecisionV2(this.provider, { ...this.scope, subjectId, profileId: profiles.decision,
      fallbackProfileId: profiles.fallback, modelRegistrySnapshotHash: this.control.registryHash,
      allocateInvocation: () => this.next(subjectId), batch });
    this.control.cache.push({ key, result });
    if (this.control.cache.length > 256) this.control.cache.shift();
    this.uses.push({ batch, result, reused: false }); return result.answers;
  }
  audits() { return this.uses.filter(use => !use.reused).flatMap(use => use.result.audits); }
}
export function selected(answers: Awaited<ReturnType<DirectDecisions["ask"]>>, key: string): string {
  const value = answers[key]; if (value?.type !== "choice") throw new Error(`missing choice ${key}`);
  return value.choice;
}
