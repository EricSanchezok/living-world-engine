import type { TemporalProfileDefinition } from "../../mechanics/temporal";
import {
  extractActionTemporalEvidence,
  temporalProfileEligibility,
} from "../../mechanics/temporal";
import {
  projectActionCompilationContextForModel,
} from "../../algorithms/eager-reference/action-compilation-context";

export interface ActionCompilationCorpusRecord {
  id: string;
  category: string;
  action: {
    rawText: string;
    goal: string;
    means: string | null;
  };
  live?: {
    actorId: string;
    expectedProfileIds: string[];
  };
}

export interface ActionCompilationGoldRecord {
  expectedDurationSourceTexts: string[];
  expectedQuantitySourceTexts: string[];
  mustIncludeEligibleProfileIds: string[];
  mustExcludeEligibleProfileIds: string[];
  requiredCandidateAnchors: string[];
  allowedReferenceUses: string[];
  allowWorld: boolean;
  expectedExpansion: boolean;
}

export interface ActionCompilationGold {
  schemaVersion: 1;
  categoryDefaults?: Record<string, {
    include: string[];
    exclude: string[];
  }>;
  records: Record<string, ActionCompilationGoldRecord>;
}

function expectedGoldRecord(
  record: ActionCompilationCorpusRecord,
  gold: ActionCompilationGold,
): ActionCompilationGoldRecord | null {
  const expected = gold.records[record.id];
  if (!expected) return null;
  const defaults = gold.categoryDefaults?.[record.category];
  return {
    ...expected,
    mustIncludeEligibleProfileIds: expected.mustIncludeEligibleProfileIds ?? defaults?.include ?? [],
    mustExcludeEligibleProfileIds: expected.mustExcludeEligibleProfileIds ?? defaults?.exclude ?? [],
  };
}

export function parseActionCompilationCorpus(source: string): ActionCompilationCorpusRecord[] {
  const records = source.split(/\r?\n/u).filter((line) => line.trim()).map((line) =>
    JSON.parse(line) as ActionCompilationCorpusRecord);
  const ids = records.map((record) => record.id);
  if (new Set(ids).size !== ids.length) throw new Error("Action Compilation corpus contains duplicate ids");
  return records;
}

export function evaluateTemporalGold(
  corpus: readonly ActionCompilationCorpusRecord[],
  gold: ActionCompilationGold,
  profiles: Readonly<Record<string, TemporalProfileDefinition>>,
): { cases: number; failures: string[] } {
  const failures: string[] = [];
  for (const record of corpus) {
    const expected = expectedGoldRecord(record, gold);
    if (!expected) {
      failures.push(`${record.id}: missing gold record`);
      continue;
    }
    const evidence = extractActionTemporalEvidence(record.action.rawText, profiles);
    const durations = evidence.filter((entry) => entry.kind === "duration").map((entry) => entry.sourceText).sort();
    const quantities = evidence.filter((entry) => entry.kind === "quantity").map((entry) => entry.sourceText).sort();
    if (JSON.stringify(durations) !== JSON.stringify([...expected.expectedDurationSourceTexts].sort())) {
      failures.push(`${record.id}: duration evidence ${JSON.stringify(durations)}`);
    }
    if (JSON.stringify(quantities) !== JSON.stringify([...expected.expectedQuantitySourceTexts].sort())) {
      failures.push(`${record.id}: quantity evidence ${JSON.stringify(quantities)}`);
    }
    for (const profileId of expected.mustIncludeEligibleProfileIds) {
      const profile = profiles[profileId];
      if (!profile || !temporalProfileEligibility(profile, evidence).eligible) {
        failures.push(`${record.id}: expected eligible profile ${profileId}`);
      }
    }
    for (const profileId of expected.mustExcludeEligibleProfileIds) {
      const profile = profiles[profileId];
      if (!profile || temporalProfileEligibility(profile, evidence).eligible) {
        failures.push(`${record.id}: expected excluded profile ${profileId}`);
      }
    }
  }
  for (const id of Object.keys(gold.records)) {
    if (!corpus.some((record) => record.id === id)) failures.push(`${id}: gold record has no corpus action`);
  }
  return { cases: corpus.length, failures };
}

function syntheticGoldContext(record: ActionCompilationCorpusRecord, gold: ActionCompilationGoldRecord): Record<string, unknown> {
  const anchorCandidates = gold.requiredCandidateAnchors.map((label, index) => ({
    handle: `ref:entity:anchor-${index}`,
    kind: "entity",
    label,
    meaning: "gold-required candidate",
    allowedUses: ["target", "conflict"],
    visibility: "slot",
    details: { description: `required detail for ${label}` },
  }));
  const distractors = Array.from({ length: 32 }, (_, index) => ({
    handle: `ref:entity:distractor-${index}`,
    kind: "entity",
    label: `unrelated-${index}`,
    meaning: "gold distractor",
    allowedUses: ["target", "conflict"],
    visibility: "role",
    details: { description: `unrelated detail ${index}` },
  }));
  return {
    contractVersion: 17,
    task: { assignment: { availableHandles: [...anchorCandidates, ...distractors].map((entry) => entry.handle) }, slots: [] },
    state: {
      currentElapsedSeconds: 0,
      canonicalTruth: {},
      slots: [{
        slot: 0,
        action: {
          actionRef: "ref:action:gold",
          actorRef: "ref:agent:gold",
          targetRefs: anchorCandidates.map((entry) => entry.handle),
          ...record.action,
        },
        existingActivities: [],
      }],
    },
    referenceCatalog: {
      version: 1,
      hash: "gold",
      candidates: [
        ...anchorCandidates,
        ...distractors,
        { handle: "ref:action:gold", kind: "action", label: record.action.rawText, meaning: "action", allowedUses: ["cause"], visibility: "slot", details: { rawText: record.action.rawText } },
        { handle: "ref:agent:gold", kind: "agent", label: "Gold actor", meaning: "actor", allowedUses: ["audience"], visibility: "slot", details: { entityRef: "ref:entity:anchor-0" } },
        { handle: "ref:world:world", kind: "world", label: "world", meaning: "global", allowedUses: ["conflict"], visibility: "role", details: { currentElapsedSeconds: 0 } },
      ],
    },
    referenceCatalogs: [],
    repair: null,
  };
}

export function evaluateGoldDetailRecall(
  corpus: readonly ActionCompilationCorpusRecord[],
  gold: ActionCompilationGold,
): { required: number; recalled: number; recall: number; failures: string[] } {
  let required = 0;
  let recalled = 0;
  const failures: string[] = [];
  for (const record of corpus) {
    const expected = expectedGoldRecord(record, gold);
    if (!expected) continue;
    const context = syntheticGoldContext(record, expected);
    const projected = projectActionCompilationContextForModel(context);
    const candidates = projected.referenceCatalog.candidates;
    for (const anchor of expected.requiredCandidateAnchors) {
      required += 1;
      if (candidates.some((entry) => entry.label === anchor && entry.details != null)) recalled += 1;
      else failures.push(`${record.id}: missing details for ${anchor}`);
    }
    const projectedCandidates = (projected.referenceCatalog as { candidates: unknown[] }).candidates;
    const sourceCandidates = (context.referenceCatalog as { candidates: unknown[] }).candidates;
    if (projectedCandidates.length !== sourceCandidates.length) {
      failures.push(`${record.id}: candidate namespace changed`);
    }
  }
  return { required, recalled, recall: required === 0 ? 1 : recalled / required, failures };
}

export function runTemporalEvidencePropertyCases(
  profiles: Readonly<Record<string, TemporalProfileDefinition>>,
  count = 1_000,
): { cases: number; failures: string[] } {
  const failures: string[] = [];
  const rateProfiles = Object.values(profiles).filter((profile): profile is Extract<TemporalProfileDefinition, { kind: "rate" }> =>
    profile.kind === "rate");
  for (let index = 0; index < count; index += 1) {
    const amount = index % 997 + 1;
    const duration = index % 2 === 0;
    if (duration) {
      const unit = ["秒", "分钟", "小时", "天", "周"][index % 5]!;
      const sourceText = `${amount}${unit}`;
      const evidence = extractActionTemporalEvidence(`case-${index}: 等待${sourceText}。`, profiles);
      if (!evidence.some((entry) => entry.kind === "duration" && entry.amount === amount && entry.sourceText === sourceText)) {
        failures.push(`case-${index}: duration`);
      }
      continue;
    }
    const profile = rateProfiles[index % Math.max(rateProfiles.length, 1)];
    if (!profile) {
      failures.push(`case-${index}: no rate profile`);
      continue;
    }
    const alias = [profile.unit, ...profile.unitAliases][index % (profile.unitAliases.length + 1)]!;
    const sourceText = `${amount}${alias}`;
    const evidence = extractActionTemporalEvidence(`case-${index}: 前进${sourceText}。`, profiles);
    if (!evidence.some((entry) => entry.kind === "quantity" && entry.amount === amount &&
      entry.sourceText === sourceText && entry.compatibleProfileIds.includes(profile.id))) {
      failures.push(`case-${index}: profile quantity`);
    }
  }
  return { cases: count, failures };
}
