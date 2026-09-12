import { ACTION_COMPILATION_FIELD_USES } from "../../algorithms/eager-reference/action-compilation-validation";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (reason: string): never => { throw new ModelConfigurationError(`compilation reference uses: ${reason}`); };
const record = (value: unknown): Value => object(value) ? value : fail("expected source object");
const field = "referenceUseBindings";
const instruction = loadPromptAsset("shared/compilation-reference-uses.md");
const contracts = { state: ACTION_COMPILATION_FIELD_USES.stateDependency, audience: ACTION_COMPILATION_FIELD_USES.audience };
export const COMPILATION_REFERENCE_USES = `action-local-reference-uses-v1@${contentHash({ instruction, contracts }).slice(0, 16)}`;

interface Candidate {
  candidateKey: string;
  kind: string;
  allowedUses: string[];
  scope: { kind: "shared" } | { kind: "slot"; slot: number };
  details?: Value;
}

/** Materialize only exact already-visible links; labels never establish identity. */
export function compilationReferenceUses(source: unknown) {
  const root = record(source), task = record(root.task), catalog = record(root.referenceCatalog);
  if (!Array.isArray(task.slots) || !task.slots.length || !Array.isArray(catalog.candidates)) return fail("missing source slots or catalog");
  const candidates = new Map<string, Candidate>();
  for (const value of catalog.candidates) {
    const row = record(value), scope = record(row.scope);
    if (typeof row.candidateKey !== "string" || !/^r[0-9]{3,}$/u.test(row.candidateKey) || candidates.has(row.candidateKey) ||
      typeof row.kind !== "string" || !Array.isArray(row.allowedUses) || row.allowedUses.some(use => typeof use !== "string") ||
      (scope.kind !== "shared" && (scope.kind !== "slot" || !Number.isSafeInteger(scope.slot) || Number(scope.slot) < 0))) return fail("invalid catalog binding");
    candidates.set(row.candidateKey, { candidateKey: row.candidateKey, kind: row.kind, allowedUses: row.allowedUses as string[],
      scope: scope.kind === "shared" ? { kind: "shared" } : { kind: "slot", slot: Number(scope.slot) },
      ...(object(row.details) ? { details: row.details } : {}) });
  }
  const visible = (candidate: Candidate, slot: number) => candidate.scope.kind === "shared" || candidate.scope.slot === slot;
  const permitted = (key: unknown, slot: number, use: keyof typeof contracts): Candidate | undefined => {
    const candidate = typeof key === "string" ? candidates.get(key) : undefined;
    const contract = contracts[use];
    return candidate && visible(candidate, slot) && (contract.kinds as readonly string[]).includes(candidate.kind) &&
      candidate.allowedUses.includes(contract.use) ? candidate : undefined;
  };
  const agentsByEntity = new Map<string, Candidate[]>();
  for (const candidate of candidates.values()) {
    const entityKey = candidate.details?.entityRef;
    if (candidate.kind !== "agent" || typeof entityKey !== "string") continue;
    if (candidates.get(entityKey)?.kind !== "entity") continue;
    const linked = agentsByEntity.get(entityKey) ?? [];
    linked.push(candidate); agentsByEntity.set(entityKey, linked);
  }
  const slotIds = new Set<number>();
  const counts = { slots: 0, targets: 0, entityAlternatives: 0, linkedAudienceChoices: 0, unavailableTargets: 0 };
  const projectedSlots = task.slots.map(value => {
    const slot = record(value), index = slot.slot;
    if (!Number.isSafeInteger(index) || Number(index) < 0 || slotIds.has(Number(index)) || Object.hasOwn(slot, field)) return fail("invalid slot or projection collision");
    slotIds.add(Number(index)); counts.slots++;
    const references = record(slot.actionReferences), actor = record(references.actor);
    if (!Array.isArray(references.targets)) return fail("missing target binding list");
    const actorEntity = permitted(actor.boundEntityCandidateKey, Number(index), "state");
    const actorAgent = permitted(actor.agentCandidateKey, Number(index), "audience");
    if (actorEntity && actorEntity.kind !== "entity") return fail("actor state binding must be an Entity");
    if (typeof actorAgent?.details?.entityRef === "string" && actorEntity && actorAgent.details.entityRef !== actorEntity.candidateKey) return fail("actor and catalog links disagree");
    const view = {
      actor: { status: actor.status, stateDependencyCandidateKey: actorEntity?.candidateKey ?? null,
        audienceAgentCandidateKey: actorAgent?.candidateKey ?? null },
      targets: references.targets.map(value => {
        const target = record(value);
        if (!Number.isSafeInteger(target.targetIndex) || !Array.isArray(target.candidateKeys) || target.candidateKeys.some(key => typeof key !== "string")) return fail("invalid target binding");
        counts.targets++;
        const unavailableCandidateKeys: string[] = [];
        const alternatives = (target.candidateKeys as string[]).flatMap(key => {
          const entity = permitted(key, Number(index), "state");
          if (!entity || entity.kind !== "entity") { unavailableCandidateKeys.push(key); counts.unavailableTargets++; return []; }
          const audience = (agentsByEntity.get(key) ?? []).filter(agent => permitted(agent.candidateKey, Number(index), "audience"))
            .map(agent => agent.candidateKey).sort();
          counts.entityAlternatives++; counts.linkedAudienceChoices += audience.length;
          return [{ stateDependencyCandidateKey: key, audienceAgentCandidateKeys: audience }];
        });
        return { targetIndex: target.targetIndex, label: target.label, status: target.status, alternatives, unavailableCandidateKeys };
      }),
    };
    // Insert beside the original bindings, leaving every original key in order.
    return Object.fromEntries(Object.entries(structuredClone(slot)).flatMap(([key, value]) =>
      key === "actionReferences" ? [[key, value], [field, view]] : [[key, value]]));
  });
  const context = structuredClone(root);
  record(context.task).slots = projectedSlots;
  const restored = structuredClone(context);
  for (const slot of record(restored.task).slots as Value[]) delete slot[field];
  if (JSON.stringify(restored) !== JSON.stringify(source)) return fail("projection changed original ordered context");
  return { context, proof: { sourceContextHash: contentHash(source), contextHash: contentHash(context), ...counts,
    originalContextPreserved: true, outputSchemaChanged: false, inferredBindings: 0 } };
}

export function compilationReferenceUsesRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "action-compilation" || request.schemaName !== "action_compilation_at_eligible_source_choice_v1") return request;
  if (request.promptVersion.includes(COMPILATION_REFERENCE_USES)) return fail("already applied");
  const projected = compilationReferenceUses(request.context);
  const system = [request.system, instruction].join("\n\n");
  return { ...request, context: projected.context, system,
    promptVersion: `${request.promptVersion}/${COMPILATION_REFERENCE_USES}`,
    preprocessOutput: raw => {
      if (contentHash(request.context) !== projected.proof.sourceContextHash || contentHash(projected.context) !== projected.proof.contextHash) return fail("source binding changed");
      return request.preprocessOutput?.(raw) ?? { value: raw, symbolRepairs: [] };
    } };
}
