import { contentHash } from "../../src/engine/models/model-audit";
import { E3_TASKS } from "./step-e3-tasks";
import type { ModelCatalog } from "../../src/engine/models/model-catalog";

export type JevArm = "A" | "B" | "C";
export interface JevTrial { id: string; category: number; seed: number; order: JevArm[]; phase: "canary" | "confirmation" }
/** Keep exact world profile values while excluding unrelated accounts from registry capture. */
export function qualificationCatalogDocument(source: ModelCatalog, arm: JevArm) {
  const profiles = arm === "A" ? ["truth-deepseek", "agent-deepseek"] : ["decision-jev", "decision-deepseek", "creation-deepseek"];
  const accounts = [...new Set(profiles.map(id => source.profile(id).account_id))];
  return { schema_version: source.schemaVersion, scheduler: source.scheduler, registry: source.registry,
    accounts: Object.fromEntries(accounts.map(id => [id, source.account(id)])),
    profiles: Object.fromEntries(profiles.map(id => [id, source.profile(id)])),
    model_overrides: Object.fromEntries([...new Set(accounts.map(id => source.account(id).models_dev_provider_id))]
      .filter(id => source.modelOverrides[id]).map(id => [id, source.modelOverrides[id]])) };
}
export const JEV_QUALIFICATION_LIMITS = { maxDispatchMs: 600_000, maxCommitsPerLease: 6, pollMs: 250 } as const;
export const JEV_QUALIFICATION_PROTOCOL = {
  id: "jev-direct-world-three-arm-v2", tasks: E3_TASKS, limits: JEV_QUALIFICATION_LIMITS,
  initialization: "Independent initialization per arm, including all 48 autonomous subjects and the same player origin. Initial NPC work may be a persistent runtime task in the direct architecture. Cold initialization and subsequent runtime requests are charged separately; no bootstrap or model output is copied between producers.",
  evaluation: "All planned trials and inputs remain in the denominator. A terminal run or program is not task success. Review durable world state and delivered observations against each task goal and forbidden behavior. Candidate feedback latency requires independent semantic review before it becomes useful-feedback latency. Unfinished or censored baseline trials have no speedup or successful-task cost ratio. No source or prompt tuning inside a frozen cohort.",
  counting: "Count actual paid HTTP requests, including failed generation, repair, context fallback and rejected output. Runtime excludes cold bootstrap and player arrival, reported separately. Replays must make zero model requests. Do not split questions to inflate the Jev share.",
  producerBindings: "Schema versions, model capabilities, core rule implementation and explicit condition cadence are producer-bound and retained separately. Shared authored content is compared after removing those fields. New condition cadence is an architectural difference, not proof of identical temporal semantics; any affected task requires explicit review.",
  trials: [
    ...Array.from({ length: 3 }, (_, i): JevTrial => ({ id: `canary-${i + 1}`, category: i, seed: 20260922 + i,
      order: [["A", "B", "C"], ["B", "C", "A"], ["C", "A", "B"]][i] as JevArm[], phase: "canary" })),
    ...E3_TASKS.flatMap((_, category) => Array.from({ length: 5 }, (_, i): JevTrial => ({
      id: `confirmation-${category + 1}-${i + 1}`, category, seed: 20261001 + category * 5 + i,
      order: [["A", "B", "C"], ["B", "C", "A"], ["C", "A", "B"]][(category * 5 + i) % 3] as JevArm[], phase: "confirmation",
    }))),
  ],
} as const;

/** Compare shared authored content; producer-specific bindings are also frozen in the manifest. */
export function semanticWorldHash(value: unknown): string {
  function normalize(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(Object.entries(input).filter(([key]) =>
      !["schema_version", "schemaVersion", "model_profiles", "modelProfiles", "recurring_interval_seconds"].includes(key))
      .map(([key, item]) => [key, key === "version" && (input as { id?: string }).id === "core-resolution"
        ? "producer-bound" : normalize(item)]));
  }
  return contentHash(normalize(value));
}

export function assertQualificationClock(previous: { revision: number; step: number; elapsedSeconds: number },
  current: { revision: number; step: number; elapsedSeconds: number }, physicalAdvances: number[]) {
  if (current.revision !== previous.revision + 1) throw new Error("noncontiguous committed revision");
  if (physicalAdvances.length === 0) {
    if (current.step !== previous.step || current.elapsedSeconds !== previous.elapsedSeconds) throw new Error("control commit advanced world time");
  } else if (physicalAdvances.length !== 1 || physicalAdvances[0]! <= 0 || current.step !== previous.step + 1 ||
    current.elapsedSeconds !== previous.elapsedSeconds + physicalAdvances[0]!) throw new Error("invalid physical world-time advance");
}

/** Participant arrival can create revision one without executing a world step. */
export function assertQualificationInitialState(value: { subjects: number; revision: number; step: number; historyLength: number }) {
  if (value.subjects !== 49 || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.step !== 0 || value.historyLength !== 0) {
    throw new Error("full49 initialization is incomplete or already advanced");
  }
}
