import {
  CachedQueryEncoder,
  type LocalEncoderRuntime,
} from "./local-encoder";
import type { PassageEmbeddingEncoder } from "./embedding-cache";
import type {
  ActionCompilationRetrievalRuntimeOptions,
  BatchSlotRetrievalResult,
} from "./runtime";
import { MULTILINGUAL_E5_BASE_ASSET } from "./model-assets";

export interface RelationalRrfCandidateInput {
  context: Readonly<Record<string, unknown>>;
  slotIndex: number;
}

export interface RelationalRrfPreparationDataset {
  contexts: ReadonlyMap<string, {
    contextHash: string;
    context: Readonly<Record<string, unknown>>;
  }>;
  cases: readonly {
    caseId: string;
    contextHash: string;
    slotIndex: number;
    source: { worldHash: string };
  }[];
}

type CandidateRetrieverInput = RelationalRrfCandidateInput;

export const R5_RELATIONAL_PASSAGE_SCHEMA_VERSION = 1 as const;
export const RELATIONAL_RRF_ENCODER_MODEL_ID = MULTILINGUAL_E5_BASE_ASSET.modelId;
export const RELATIONAL_RRF_ENCODER_FINGERPRINT = MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint;
export const RELATIONAL_RRF_MAX_QUERY_BATCH_SIZE = 60 as const;

export function relationalRrfEncoderFingerprint(
  encoder: LocalEncoderRuntime,
  passageSchemaVersion: number = R5_RELATIONAL_PASSAGE_SCHEMA_VERSION,
): string {
  if (passageSchemaVersion !== R5_RELATIONAL_PASSAGE_SCHEMA_VERSION) {
    throw new Error(`relational RRF passage schema must be ${R5_RELATIONAL_PASSAGE_SCHEMA_VERSION}`);
  }
  if (encoder.modelId !== MULTILINGUAL_E5_BASE_ASSET.modelId ||
    encoder.modelHash !== MULTILINGUAL_E5_BASE_ASSET.directorySha256 ||
    encoder.dimensions !== MULTILINGUAL_E5_BASE_ASSET.dimensions ||
    encoder.libraryVersion !== MULTILINGUAL_E5_BASE_ASSET.runtimeLibraryVersion) {
    throw new Error("relational RRF encoder runtime does not match the pinned production asset");
  }
  return MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint;
}

export const R5_CANDIDATE_RETRIEVAL_STAGES = [
  "relational-passage",
  "multi-seed-expand",
  "typed-channel-rrf",
] as const;

export type R5CandidateRetrievalStage = typeof R5_CANDIDATE_RETRIEVAL_STAGES[number];

export interface R5CandidateRetrieverOptions {
  stage: R5CandidateRetrievalStage;
  encoder: LocalEncoderRuntime;
  passageEncoder?: PassageEmbeddingEncoder;
  maxPathDepth?: number;
  pseudoSeedCount?: number;
}

interface Candidate {
  candidateKey: string;
  kind: string;
  label: string;
  meaning: string;
  allowedUses: string[];
  scope?: { kind?: string; slot?: number };
  details?: unknown;
}

type Relation =
  | "agent-entity"
  | "entity-placement"
  | "placement-container"
  | "entity-meter"
  | "entity-quantity"
  | "entity-rating"
  | "fact-subject"
  | "fact-object"
  | "condition-subject"
  | "action-actor"
  | "action-target"
  | "action-profile"
  | "candidate-reference";

interface Edge {
  from: string;
  to: string;
  relation: Relation;
}

interface CatalogIndex {
  hash: string;
  candidates: Candidate[];
  byKey: Map<string, Candidate>;
  edges: Map<string, Edge[]>;
  lexicalDocuments: Map<string, { length: number; frequencies: ReadonlyMap<string, number> }>;
  documentFrequency: Map<string, number>;
  averageFieldLength: number;
}

interface PathEvidence {
  depth: number;
  priority: number;
}

export type RelationalRrfGraphTraversal = "field-use-constrained" | "typed-state-support";

export interface RelationalRrfGraphTrace {
  slotIndex: number;
  policy: RelationalRrfGraphTraversal;
  anchors: readonly { candidateKey: string; roles: readonly string[] }[];
  paths: readonly { candidateKey: string; depth: number; priority: number }[];
}

interface PreparedEncoderData {
  candidateVectors: ReadonlyMap<string, ReadonlyMap<string, readonly number[]>>;
  queryVectors: ReadonlyMap<string, readonly number[]>;
}

const R5_RETRIEVAL_CHANNELS = ["identity", "state", "fact", "temporal"] as const;
type R5RetrievalChannel = typeof R5_RETRIEVAL_CHANNELS[number];

export const RELATIONAL_RRF_RETRIEVAL_CHANNELS = R5_RETRIEVAL_CHANNELS;

const CHANNEL_KINDS: Readonly<Record<R5RetrievalChannel, ReadonlySet<string>>> = {
  identity: new Set(["agent", "entity", "placement"]),
  state: new Set(["meter", "rating", "quantity", "placement"]),
  fact: new Set(["fact", "condition"]),
  temporal: new Set(["action", "temporal_profile"]),
};

const CHANNEL_HINTS: Readonly<Record<R5RetrievalChannel, string>> = {
  identity: "identity actor target person place entity 身份 行动者 目标 人物 地点 实体",
  state: "state meter rating quantity placement current 状态 数值 属性 数量 位置 当前",
  fact: "fact evidence constraint cause conflict knowledge 事实 证据 约束 原因 冲突 知识",
  temporal: "action temporal profile time schedule duration 行动 时间 时序 期限",
};

const SUPPORTED_KINDS = new Set([
  "action",
  "agent",
  "entity",
  "condition",
  "fact",
  "meter",
  "placement",
  "quantity",
  "rating",
  "temporal_profile",
]);

const SUPPORTED_USES = new Set([
  "assertion",
  "audience",
  "cause",
  "conflict",
  "modifier",
  "profile",
  "source",
  "subject",
  "target",
]);

const RELATION_PRIORITY: Readonly<Record<Relation, number>> = {
  "action-actor": 100,
  "action-target": 100,
  "action-profile": 100,
  "agent-entity": 90,
  "entity-placement": 80,
  "placement-container": 70,
  "entity-meter": 65,
  "entity-quantity": 65,
  "entity-rating": 65,
  "fact-subject": 60,
  "fact-object": 60,
  "condition-subject": 55,
  "candidate-reference": 35,
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalize(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("zh-CN");
}

function candidateKey(value: unknown): value is string {
  return typeof value === "string" && /^candidate_[0-9a-f]{12}$/u.test(value);
}

function visible(candidate: Candidate, slotIndex: number): boolean {
  if (!candidate.scope || candidate.scope.kind === "shared") return true;
  return candidate.scope.kind === "slot" && candidate.scope.slot === slotIndex;
}

function typed(candidate: Candidate): boolean {
  return SUPPORTED_KINDS.has(candidate.kind) && candidate.allowedUses.some((use) => SUPPORTED_USES.has(use));
}

function tokens(value: string): string[] {
  const output = new Set<string>();
  for (const segment of normalize(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    output.add(segment);
    if (/\p{Script=Han}/u.test(segment)) {
      for (const character of segment) output.add(character);
      for (let index = 0; index + 1 < segment.length; index += 1) output.add(segment.slice(index, index + 2));
    } else if (segment.length >= 3) {
      for (let index = 0; index + 2 < segment.length; index += 1) output.add(segment.slice(index, index + 3));
    }
  }
  return [...output];
}

function collectQueryText(value: unknown, key: string | undefined, output: string[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (!candidateKey(value) && !/^ref:/u.test(value) && key !== "hash" && key !== "slot" && !/id$/iu.test(key ?? "")) {
      output.push(value);
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    output.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectQueryText(entry, key, output, depth + 1));
    return;
  }
  const input = object(value);
  if (!input) return;
  for (const childKey of Object.keys(input).sort()) {
    if (/candidatekey|enginehandle|hash/iu.test(childKey)) continue;
    collectQueryText(input[childKey], childKey, output, depth + 1);
  }
}

function collectReferences(value: unknown, output = new Set<string>()): Set<string> {
  if (candidateKey(value)) {
    output.add(value);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectReferences(entry, output));
    return output;
  }
  const input = object(value);
  if (input) Object.values(input).forEach((entry) => collectReferences(entry, output));
  return output;
}

function relationForField(field: string, candidate: Candidate): Relation {
  if (field === "entityRef" && candidate.kind === "agent") return "agent-entity";
  if (field === "entityRef" && candidate.kind === "placement") return "entity-placement";
  if (field === "placementRef" && candidate.kind === "entity") return "entity-placement";
  if (field === "containerRef") return "placement-container";
  if (field === "entityRef" && candidate.kind === "meter") return "entity-meter";
  if (field === "holderRef") return "entity-quantity";
  if (field === "entityRef" && candidate.kind === "rating") return "entity-rating";
  if (field === "subjectRef" && candidate.kind === "condition") return "condition-subject";
  if (field === "subjectRef" && candidate.kind === "fact") return "fact-subject";
  if (field === "value" && candidate.kind === "fact") return "fact-object";
  return "candidate-reference";
}

function parseCandidates(context: Readonly<Record<string, unknown>>): { hash: string; candidates: Candidate[] } {
  const catalog = object(context.referenceCatalog);
  const values = Array.isArray(catalog?.candidates) ? catalog.candidates : [];
  return {
    hash: typeof catalog?.hash === "string" ? catalog.hash : "catalog-without-hash",
    candidates: values.flatMap((value) => {
      const input = object(value);
      if (!input || !candidateKey(input.candidateKey) || typeof input.kind !== "string") return [];
      return [{
        candidateKey: input.candidateKey,
        kind: input.kind,
        label: typeof input.label === "string" ? input.label : "",
        meaning: typeof input.meaning === "string" ? input.meaning : "",
        allowedUses: Array.isArray(input.allowedUses)
          ? input.allowedUses.filter((use): use is string => typeof use === "string")
          : [],
        scope: object(input.scope) as Candidate["scope"],
        details: input.details,
      } satisfies Candidate];
    }),
  };
}

function serialiseRelationalValue(
  value: unknown,
  field: string,
  byKey: ReadonlyMap<string, Candidate>,
  depth = 0,
): string[] {
  if (depth > 6 || value === null || value === undefined) return [];
  if (candidateKey(value)) {
    const linked = byKey.get(value);
    return linked
      ? [`${field}: [${linked.kind}] ${linked.label} — ${linked.meaning}`]
      : [];
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [`${field}: ${String(value)}`];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => serialiseRelationalValue(entry, field, byKey, depth + 1));
  }
  const input = object(value);
  if (!input) return [];
  return Object.keys(input).sort().flatMap((childField) =>
    serialiseRelationalValue(input[childField], `${field}.${childField}`, byKey, depth + 1));
}

function relationalPassage(candidate: Candidate, index: CatalogIndex): string {
  const details = serialiseRelationalValue(candidate.details, "details", index.byKey);
  const relations = (index.edges.get(candidate.candidateKey) ?? [])
    .map((edge) => {
      const linked = index.byKey.get(edge.to);
      return linked ? `${edge.relation}: [${linked.kind}] ${linked.label}` : "";
    })
    .filter(Boolean);
  return `passage: ${[
    `kind: ${candidate.kind}`,
    `uses: ${[...candidate.allowedUses].sort().join(" ")}`,
    `label: ${candidate.label}`,
    `meaning: ${candidate.meaning}`,
    ...details,
    ...relations,
  ].join(" ")}`;
}

function buildCatalogIndex(context: Readonly<Record<string, unknown>>): CatalogIndex {
  const parsed = parseCandidates(context);
  const byKey = new Map(parsed.candidates.map((candidate) => [candidate.candidateKey, candidate]));
  const edges = new Map<string, Edge[]>();
  const addEdge = (edge: Edge): void => {
    const values = edges.get(edge.from) ?? [];
    values.push(edge);
    edges.set(edge.from, values);
  };
  for (const candidate of parsed.candidates) {
    const details = object(candidate.details);
    if (!details) continue;
    for (const field of Object.keys(details).sort()) {
      for (const reference of collectReferences(details[field])) {
        if (!byKey.has(reference) || reference === candidate.candidateKey) continue;
        const relation = relationForField(field, candidate);
        addEdge({ from: candidate.candidateKey, to: reference, relation });
        addEdge({ from: reference, to: candidate.candidateKey, relation });
      }
    }
  }
  for (const [key, values] of edges) {
    edges.set(key, values.sort((left, right) =>
      left.relation.localeCompare(right.relation) || left.to.localeCompare(right.to)));
  }
  const lexicalDocuments: CatalogIndex["lexicalDocuments"] = new Map();
  const documentFrequency = new Map<string, number>();
  let totalFieldLength = 0;
  const partial: CatalogIndex = {
    hash: parsed.hash,
    candidates: parsed.candidates,
    byKey,
    edges,
    lexicalDocuments,
    documentFrequency,
    averageFieldLength: 1,
  };
  for (const candidate of parsed.candidates) {
    const field = normalize(relationalPassage(candidate, partial));
    const terms = tokens(field);
    const frequencies = new Map<string, number>();
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    lexicalDocuments.set(candidate.candidateKey, { length: terms.length, frequencies });
    totalFieldLength += terms.length;
    for (const term of frequencies.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  partial.averageFieldLength = parsed.candidates.length === 0 ? 1 : totalFieldLength / parsed.candidates.length;
  return partial;
}

function slotContext(input: CandidateRetrieverInput): Record<string, unknown> {
  const task = object(input.context.task);
  const slots = Array.isArray(task?.slots) ? task.slots : [];
  return object(slots.find((value) => object(value)?.slot === input.slotIndex)) ?? object(slots[input.slotIndex]) ?? {};
}

function queryText(input: CandidateRetrieverInput): string {
  const values: string[] = [];
  collectQueryText(slotContext(input), undefined, values);
  return normalize(values.join(" "));
}

function channelQueryText(input: CandidateRetrieverInput, channel: R5RetrievalChannel): string {
  const slot = slotContext(input);
  const values: string[] = [CHANNEL_HINTS[channel]];
  collectQueryText(slot.action, "action", values);
  const references = object(slot.actionReferences);
  if (Array.isArray(references?.targets)) {
    references.targets.forEach((target) => collectQueryText(object(target)?.label, "target", values));
  }
  if (channel === "identity" || channel === "state") {
    collectQueryText(object(slot.actorPerspective)?.self, "self", values);
  }
  if (channel === "fact") {
    collectQueryText(object(slot.actorPerspective)?.knowledge, "knowledge", values);
  }
  if (channel === "temporal") {
    collectQueryText(slot.temporalProfileEligibility, "temporal", values);
  }
  return normalize(values.join(" "));
}

function anchorKeys(input: CandidateRetrieverInput, index: CatalogIndex): { keys: Set<string>; roles: Map<string, Set<string>> } {
  const slot = slotContext(input);
  const references = object(slot.actionReferences);
  const keys = new Set<string>();
  const roles = new Map<string, Set<string>>();
  const add = (value: unknown, role: string): void => {
    if (!candidateKey(value)) return;
    const candidate = index.byKey.get(value);
    if (!candidate || !visible(candidate, input.slotIndex) || !typed(candidate)) return;
    keys.add(value);
    const values = roles.get(value) ?? new Set<string>();
    values.add(role);
    roles.set(value, values);
  };
  add(references?.actionCandidateKey, "action");
  const actor = object(references?.actor);
  if (actor?.status === "unique") {
    add(actor.agentCandidateKey, "actor");
    add(actor.boundEntityCandidateKey, "actor");
  }
  if (Array.isArray(references?.targets)) {
    references.targets.forEach((targetValue) => {
      const target = object(targetValue);
      if (target?.status === "unique" && Array.isArray(target.candidateKeys)) {
        target.candidateKeys.forEach((key) => add(key, "target"));
      }
    });
  }
  if (Array.isArray(slot.temporalProfileEligibility)) {
    slot.temporalProfileEligibility.forEach((profileValue) => {
      const profile = object(profileValue);
      if (profile?.eligible === true) add(profile.profileRef, "profile");
    });
  }
  return { keys, roles };
}

function slotEdges(input: CandidateRetrieverInput, index: CatalogIndex): Edge[] {
  const slot = slotContext(input);
  const references = object(slot.actionReferences);
  const action = references?.actionCandidateKey;
  if (!candidateKey(action)) return [];
  const output: Edge[] = [];
  const add = (value: unknown, relation: Relation): void => {
    if (!candidateKey(value) || !index.byKey.has(value)) return;
    output.push({ from: action, to: value, relation }, { from: value, to: action, relation });
  };
  const actor = object(references?.actor);
  if (actor?.status === "unique") {
    add(actor.agentCandidateKey, "action-actor");
    add(actor.boundEntityCandidateKey, "action-actor");
  }
  if (Array.isArray(references?.targets)) {
    references.targets.forEach((targetValue) => {
      const target = object(targetValue);
      if (target?.status === "unique" && Array.isArray(target.candidateKeys)) {
        target.candidateKeys.forEach((key) => add(key, "action-target"));
      }
    });
  }
  if (Array.isArray(slot.temporalProfileEligibility)) {
    slot.temporalProfileEligibility.forEach((profileValue) => {
      const profile = object(profileValue);
      if (profile?.eligible === true) add(profile.profileRef, "action-profile");
    });
  }
  return output;
}

function relationAllowed(
  relation: Relation,
  role: string | undefined,
  candidate: Candidate,
  policy: RelationalRrfGraphTraversal,
): boolean {
  if (role === "profile") return relation === "action-profile" && candidate.kind === "temporal_profile";
  if (policy === "typed-state-support" && (role === "actor" || role === "target")) {
    if (relation === "entity-quantity" && candidate.kind === "quantity" ||
      relation === "entity-rating" && candidate.kind === "rating" ||
      relation === "entity-meter" && candidate.kind === "meter" ||
      relation === "entity-placement" && candidate.kind === "placement") return true;
  }
  if (role === "target") return relation !== "action-profile" && candidate.allowedUses.includes("target");
  if (role === "actor") {
    return relation !== "action-profile" &&
      (candidate.kind === "agent" || candidate.kind === "entity" || candidate.allowedUses.includes("subject"));
  }
  return true;
}

function graphPaths(
  input: CandidateRetrieverInput,
  index: CatalogIndex,
  anchors: ReadonlySet<string>,
  roles: ReadonlyMap<string, ReadonlySet<string>>,
  maxDepth: number,
  policy: RelationalRrfGraphTraversal = "field-use-constrained",
): Map<string, PathEvidence> {
  const paths = new Map<string, PathEvidence>();
  const ephemeral = new Map<string, Edge[]>();
  for (const edge of slotEdges(input, index)) {
    const values = ephemeral.get(edge.from) ?? [];
    values.push(edge);
    ephemeral.set(edge.from, values);
  }
  const queue: Array<{ key: string; depth: number; priority: number; role?: string }> = [];
  for (const key of anchors) {
    const role = [...(roles.get(key) ?? [])].sort()[0];
    paths.set(key, { depth: 0, priority: 100 });
    queue.push({ key, depth: 0, priority: 100, role });
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    const outgoing = [...(index.edges.get(current.key) ?? []), ...(ephemeral.get(current.key) ?? [])]
      .sort((left, right) => left.relation.localeCompare(right.relation) || left.to.localeCompare(right.to));
    for (const edge of outgoing) {
      const candidate = index.byKey.get(edge.to);
      if (!candidate || !visible(candidate, input.slotIndex) || !typed(candidate) ||
        !relationAllowed(edge.relation, current.role, candidate, policy)) continue;
      const evidence = {
        depth: current.depth + 1,
        priority: Math.max(1, current.priority * 0.6 + RELATION_PRIORITY[edge.relation] * 0.4),
      };
      const existing = paths.get(edge.to);
      if (existing && (existing.depth < evidence.depth ||
        existing.depth === evidence.depth && existing.priority >= evidence.priority)) continue;
      paths.set(edge.to, evidence);
      queue.push({ key: edge.to, ...evidence, role: current.role });
    }
  }
  return paths;
}

function bm25(index: CatalogIndex, candidate: Candidate, queryTerms: readonly string[]): number {
  const document = index.lexicalDocuments.get(candidate.candidateKey);
  if (!document?.length || queryTerms.length === 0) return 0;
  let score = 0;
  for (const term of queryTerms) {
    const frequency = document.frequencies.get(term) ?? 0;
    if (frequency === 0) continue;
    const documentFrequency = index.documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (index.candidates.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
    score += idf * frequency / (frequency + 0.5 + 0.5 * document.length / index.averageFieldLength);
  }
  return score;
}

function normalizeScores(values: ReadonlyMap<string, number>): Map<string, number> {
  const entries = [...values.entries()];
  const max = Math.max(...entries.map(([, value]) => value), 0);
  const min = Math.min(...entries.map(([, value]) => value), 0);
  const span = max - min;
  return new Map(entries.map(([key, value]) => [key, span === 0 ? 0 : (value - min) / span]));
}

function dot(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  let result = 0;
  for (let index = 0; index < length; index += 1) result += left[index]! * right[index]!;
  return result;
}

function rankSlot(
  stage: R5CandidateRetrievalStage,
  input: CandidateRetrieverInput,
  index: CatalogIndex,
  encoderData: PreparedEncoderData,
  maxPathDepth: number,
  pseudoSeedCount: number,
  graphTraversal: RelationalRrfGraphTraversal = "field-use-constrained",
  onGraphTrace?: (trace: RelationalRrfGraphTrace) => void,
): { candidateKey: string; score: number }[] {
  const candidates = index.candidates.filter((candidate) => visible(candidate, input.slotIndex) && typed(candidate));
  const { keys: anchors, roles } = anchorKeys(input, index);
  const paths = graphPaths(input, index, anchors, roles, maxPathDepth, graphTraversal);
  onGraphTrace?.({
    slotIndex: input.slotIndex,
    policy: graphTraversal,
    anchors: [...anchors].sort().map(candidateKey => ({ candidateKey, roles: [...(roles.get(candidateKey) ?? [])].sort() })),
    paths: [...paths].sort(([left], [right]) => left.localeCompare(right))
      .map(([candidateKey, evidence]) => ({ candidateKey, ...evidence })),
  });
  const query = queryText(input);
  const queryTerms = tokens(query);
  const lexical = normalizeScores(new Map(candidates.map((candidate) => [
    candidate.candidateKey,
    bm25(index, candidate, queryTerms),
  ])));
  const candidateVectors = encoderData.candidateVectors.get(index.hash);
  const queryVector = encoderData.queryVectors.get(query);
  const dense = normalizeScores(new Map(candidates.map((candidate) => [
    candidate.candidateKey,
    candidateVectors && queryVector ? dot(candidateVectors.get(candidate.candidateKey) ?? [], queryVector) : 0,
  ])));
  const descendingKeys = (scores: ReadonlyMap<string, number>): string[] => candidates
    .map((candidate) => candidate.candidateKey)
    .sort((left, right) =>
      (scores.get(right) ?? 0) - (scores.get(left) ?? 0) || left.localeCompare(right));
  const reciprocalRankFusion = new Map<string, number>();
  if (stage === "typed-channel-rrf") {
    for (const channel of R5_RETRIEVAL_CHANNELS) {
      const channelCandidates = candidates.filter((candidate) => CHANNEL_KINDS[channel].has(candidate.kind));
      const channelQuery = channelQueryText(input, channel);
      const channelTerms = tokens(channelQuery);
      const channelVector = encoderData.queryVectors.get(channelQuery);
      const lexicalScores = new Map(channelCandidates.map((candidate) => [
        candidate.candidateKey,
        bm25(index, candidate, channelTerms),
      ]));
      const denseScores = new Map(channelCandidates.map((candidate) => [
        candidate.candidateKey,
        candidateVectors && channelVector ? dot(candidateVectors.get(candidate.candidateKey) ?? [], channelVector) : 0,
      ]));
      for (const scores of [lexicalScores, denseScores]) {
        const ranked = channelCandidates.map((candidate) => candidate.candidateKey).sort((left, right) =>
          (scores.get(right) ?? 0) - (scores.get(left) ?? 0) || left.localeCompare(right));
        ranked.forEach((key, index) => {
          reciprocalRankFusion.set(key, (reciprocalRankFusion.get(key) ?? 0) + 1 / (60 + index + 1));
        });
      }
    }
  }
  const pseudoSeeds = stage === "multi-seed-expand" || stage === "typed-channel-rrf"
    ? new Set<string>([
        ...descendingKeys(lexical).slice(0, pseudoSeedCount),
        ...descendingKeys(dense).slice(0, pseudoSeedCount),
      ])
    : new Set<string>();
  const pseudoPaths = pseudoSeeds.size > 0
    ? graphPaths(input, index, pseudoSeeds, new Map(), 1)
    : new Map<string, PathEvidence>();
  const anchorKinds = new Set([...anchors].map((key) => index.byKey.get(key)?.kind).filter((kind): kind is string => Boolean(kind)));
  const anchorUses = new Set([...anchors].flatMap((key) => index.byKey.get(key)?.allowedUses ?? []));
  return candidates.map((candidate) => {
    const path = paths.get(candidate.candidateKey);
    const pseudoPath = pseudoPaths.get(candidate.candidateKey);
    const role = candidate.allowedUses.some((use) => anchorUses.has(use)) ? 1 : 0;
    const degree = (index.edges.get(candidate.candidateKey) ?? []).length;
    const graphScore =
      (anchors.has(candidate.candidateKey) ? 1000 : 0) +
      (path?.priority ?? 0) * 2 +
      (path ? (path.depth === 0 ? 100 : 50 / path.depth) : 0) +
      (degree > 0 ? 20 : 0) - degree * 0.01;
    const pseudoSeedScore = pseudoSeeds.has(candidate.candidateKey)
      ? 250
      : pseudoPath ? 150 + pseudoPath.priority * 3 : 0;
    const channelMemberships = R5_RETRIEVAL_CHANNELS
      .filter((channel) => CHANNEL_KINDS[channel].has(candidate.kind)).length;
    const fusedRankScore = channelMemberships === 0
      ? 0
      : (reciprocalRankFusion.get(candidate.candidateKey) ?? 0) / channelMemberships;
    const score = stage === "typed-channel-rrf"
      ? graphScore + role * 300 +
        fusedRankScore * 3_500 +
        (lexical.get(candidate.candidateKey) ?? 0) * 120 +
        (dense.get(candidate.candidateKey) ?? 0) * 140 +
        pseudoSeedScore
      : graphScore + role * 300 +
        (lexical.get(candidate.candidateKey) ?? 0) * 120 +
        (dense.get(candidate.candidateKey) ?? 0) * 140 +
        (anchorKinds.has(candidate.kind) ? 0 : 18) +
        (role === 1 ? 0 : 8) +
        pseudoSeedScore;
    return { candidateKey: candidate.candidateKey, score };
  }).sort((left, right) => right.score - left.score || left.candidateKey.localeCompare(right.candidateKey));
}

async function prepareEncoderData(
  dataset: RelationalRrfPreparationDataset,
  indexes: ReadonlyMap<string, CatalogIndex>,
  encoder: LocalEncoderRuntime,
  passageEncoder?: PassageEmbeddingEncoder,
): Promise<PreparedEncoderData> {
  const passageTexts = new Set<string>();
  const passagesByCatalog = new Map<string, Map<string, string>>();
  for (const [hash, index] of indexes) {
    const passages = new Map<string, string>();
    for (const candidate of index.candidates.filter((value) => typed(value) && value.kind !== "action")) {
      const passage = relationalPassage(candidate, index);
      passages.set(candidate.candidateKey, passage);
      passageTexts.add(passage);
    }
    passagesByCatalog.set(hash, passages);
  }
  const uniquePassages = [...passageTexts].sort();
  if (passageEncoder && passageEncoder.encoder.modelHash !== encoder.modelHash) {
    throw new Error("R5 passage cache encoder does not match the retrieval encoder");
  }
  const worldHashes = [...new Set(dataset.cases.map((item) => item.source.worldHash))].sort();
  if (worldHashes.length !== 1) throw new Error("one R5 encoder preparation may contain only one world content hash");
  const passageVectors = passageEncoder
    ? (await passageEncoder.encodePassages({
        worldContentHash: worldHashes[0]!,
        passages: uniquePassages,
        allowWrite: true,
      })).vectors
    : await encoder.encodeBatch(uniquePassages);
  const vectorByPassage = new Map(uniquePassages.map((passage, index) => [passage, passageVectors[index] ?? []]));
  const candidateVectors = new Map<string, ReadonlyMap<string, readonly number[]>>();
  for (const [hash, passages] of passagesByCatalog) {
    candidateVectors.set(hash, new Map([...passages].map(([key, passage]) => [key, vectorByPassage.get(passage) ?? []])));
  }
  const queries = new Set<string>();
  for (const item of dataset.cases) {
    const context = dataset.contexts.get(item.contextHash);
    if (!context) throw new Error(`case ${item.caseId} context disappeared during R5 encoder preparation`);
    const input = { context: context.context, slotIndex: item.slotIndex };
    queries.add(queryText(input));
    R5_RETRIEVAL_CHANNELS.forEach((channel) => queries.add(channelQueryText(input, channel)));
  }
  const uniqueQueries = [...queries].sort();
  const queryVectors = await encoder.encodeBatch(uniqueQueries.map((query) => `query: ${query}`));
  return {
    candidateVectors,
    queryVectors: new Map(uniqueQueries.map((query, index) => [query, queryVectors[index] ?? []])),
  };
}

export function r5RelationalPassagesForContext(
  context: Readonly<Record<string, unknown>>,
): readonly { candidateKey: string; passage: string }[] {
  const index = buildCatalogIndex(context);
  return index.candidates
    .filter((candidate) => typed(candidate) && candidate.kind !== "action")
    .sort((left, right) => left.candidateKey.localeCompare(right.candidateKey))
    .map((candidate) => ({ candidateKey: candidate.candidateKey, passage: relationalPassage(candidate, index) }));
}

export interface RelationalRrfPhysicalBatchOptions {
  encoder: LocalEncoderRuntime;
  passageEncoder: PassageEmbeddingEncoder;
  queryEncoder?: CachedQueryEncoder;
  maxPathDepth?: number;
  pseudoSeedCount?: number;
  allowPassageWrites?: boolean;
  /** Experimental evidence-path policy; output-use permissions do not change. */
  graphTraversal?: RelationalRrfGraphTraversal;
  /** Local diagnostic snapshot, never included in model context. */
  onGraphTrace?: (trace: RelationalRrfGraphTrace) => void;
}

export type RelationalRrfPhysicalBatchRetriever = NonNullable<
  ActionCompilationRetrievalRuntimeOptions["retrievePhysicalBatch"]
>;

/**
 * Production R5.5 ranking boundary. One invocation builds one relational
 * index, reads/encodes each unique passage once, and submits every unique
 * slot/channel query miss through one process-cached encoder batch.
 */
export function createRelationalRrfPhysicalBatchRetriever(
  options: RelationalRrfPhysicalBatchOptions,
): RelationalRrfPhysicalBatchRetriever {
  const maxPathDepth = options.maxPathDepth ?? 3;
  if (!Number.isSafeInteger(maxPathDepth) || maxPathDepth < 1 || maxPathDepth > 4) {
    throw new Error("relational RRF maxPathDepth must be an integer from 1 to 4");
  }
  const pseudoSeedCount = options.pseudoSeedCount ?? 16;
  if (!Number.isSafeInteger(pseudoSeedCount) || pseudoSeedCount < 1 || pseudoSeedCount > 64) {
    throw new Error("relational RRF pseudoSeedCount must be an integer from 1 to 64");
  }
  if (options.passageEncoder.encoder.modelHash !== options.encoder.modelHash) {
    throw new Error("relational RRF passage cache encoder does not match the retrieval encoder");
  }
  const queryEncoder = options.queryEncoder ?? new CachedQueryEncoder(options.encoder);
  const allowPassageWrites = options.allowPassageWrites ?? true;
  const graphTraversal = options.graphTraversal ?? "field-use-constrained";
  if (graphTraversal !== "field-use-constrained" && graphTraversal !== "typed-state-support") {
    throw new Error(`unsupported relational RRF graph traversal: ${String(graphTraversal)}`);
  }

  return async ({ worldContentHash, context, slotIndices, signal }): Promise<BatchSlotRetrievalResult> => {
    if (signal?.aborted) throw signal.reason ?? new Error("candidate retrieval aborted");
    const index = buildCatalogIndex(context);
    const slots = [...new Set(slotIndices)].sort((left, right) => left - right);
    const inputs = new Map(slots.map((slotIndex) => [slotIndex, { context, slotIndex }]));
    const queries = new Set<string>();
    for (const input of inputs.values()) {
      queries.add(queryText(input));
      R5_RETRIEVAL_CHANNELS.forEach((channel) => queries.add(channelQueryText(input, channel)));
    }
    const uniqueQueries = [...queries].sort();
    if (uniqueQueries.length > RELATIONAL_RRF_MAX_QUERY_BATCH_SIZE) {
      throw new Error(
        `relational RRF query batch exceeds ${RELATIONAL_RRF_MAX_QUERY_BATCH_SIZE}: ${uniqueQueries.length}`,
      );
    }
    const passages = index.candidates
      .filter((candidate) => typed(candidate) && candidate.kind !== "action")
      .sort((left, right) => left.candidateKey.localeCompare(right.candidateKey))
      .map((candidate) => ({
        candidateKey: candidate.candidateKey,
        text: relationalPassage(candidate, index),
      }));

    const passageStartedAt = performance.now();
    const encodedPassages = await options.passageEncoder.encodePassages({
      worldContentHash,
      passages: passages.map((passage) => passage.text),
      allowWrite: allowPassageWrites,
    });
    const passageTotalMs = Math.max(0, performance.now() - passageStartedAt);
    if (encodedPassages.vectors.length !== passages.length) {
      throw new Error("relational RRF passage encoder returned the wrong vector count");
    }
    const candidateVectors = new Map<string, readonly number[]>(passages.map((passage, index) => [
      passage.candidateKey,
      encodedPassages.vectors[index]!,
    ]));

    const queryStartedAt = performance.now();
    const encodedQueries = await queryEncoder.encodeBatch(uniqueQueries);
    const queryEncodeMs = Math.max(0, performance.now() - queryStartedAt);
    if (signal?.aborted) throw signal.reason ?? new Error("candidate retrieval aborted");
    const queryVectors = new Map(uniqueQueries.map((query, index) => [query, encodedQueries.vectors[index]!]));
    const encoderData: PreparedEncoderData = {
      candidateVectors: new Map([[index.hash, candidateVectors]]),
      queryVectors,
    };
    const perSlot = new Map(slots.map((slotIndex) => [slotIndex, {
      candidates: rankSlot(
        "typed-channel-rrf",
        inputs.get(slotIndex)!,
        index,
        encoderData,
        maxPathDepth,
        pseudoSeedCount,
        graphTraversal,
        options.onGraphTrace,
      ),
    }]));

    return {
      perSlot,
      cache: {
        passageHits: encodedPassages.hits,
        passageMisses: encodedPassages.misses,
        queryHits: encodedQueries.hits,
        queryMisses: encodedQueries.misses,
        readMs: encodedPassages.readMs ?? Math.max(0, passageTotalMs - (encodedPassages.encodeMs ?? 0)),
        passageEncodeMs: encodedPassages.encodeMs ?? (encodedPassages.misses > 0 ? passageTotalMs : 0),
        queryEncodeMs,
        queryBatchSize: uniqueQueries.length,
      },
    };
  };
}

export async function createR5ActionCompilationSlotRetriever(
  dataset: RelationalRrfPreparationDataset,
  options: R5CandidateRetrieverOptions,
): Promise<NonNullable<ActionCompilationRetrievalRuntimeOptions["retrieveSlot"]>> {
  if (!R5_CANDIDATE_RETRIEVAL_STAGES.includes(options.stage)) {
    throw new Error(`unsupported R5 candidate retrieval stage: ${String(options.stage)}`);
  }
  const maxPathDepth = options.maxPathDepth ?? 3;
  if (!Number.isSafeInteger(maxPathDepth) || maxPathDepth < 1 || maxPathDepth > 4) {
    throw new Error("R5 maxPathDepth must be an integer from 1 to 4");
  }
  const pseudoSeedCount = options.pseudoSeedCount ?? 16;
  if (!Number.isSafeInteger(pseudoSeedCount) || pseudoSeedCount < 1 || pseudoSeedCount > 64) {
    throw new Error("R5 pseudoSeedCount must be an integer from 1 to 64");
  }
  const indexes = new Map<string, CatalogIndex>();
  for (const context of dataset.contexts.values()) {
    const index = buildCatalogIndex(context.context);
    indexes.set(index.hash, index);
  }
  const encoderData = await prepareEncoderData(dataset, indexes, options.encoder, options.passageEncoder);
  return async ({ context, slotIndex, signal }) => {
    if (signal?.aborted) throw signal.reason ?? new Error("candidate retrieval aborted");
    const parsed = parseCandidates(context);
    const index = indexes.get(parsed.hash) ?? buildCatalogIndex(context);
    return {
      candidates: rankSlot(options.stage, { context, slotIndex }, index, encoderData, maxPathDepth, pseudoSeedCount),
    };
  };
}
