import { z } from "zod";
import type { AgentState, CausalSource, ModelExecutionAudit, SimulationState, WorldDeltaOperation, WorldEntity, WorldFact } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import { loadPromptAsset } from "../prompts";
import type { JsonValue } from "../runtime/json";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import type { ActionFrame } from "./contracts";
import type { DirectDecisions } from "./decisions";
import { agentCapabilityModels } from "../models/capability-bindings";
import { selected } from "./decisions";
import { ModelOutputError, type StructuredModelResult } from "../models/model-provider";
import { establishedEntityDirectory } from "./state";
import type { DecisionQuestionV2 } from "../models/decision-v2";

const schema = z.object({
  description: z.string().min(1),
  entities: z.array(z.object({ key: z.string().min(1), kind: z.string().min(1), name: z.string().min(1),
    appearance: z.string().min(1), label: z.string().min(1),
    placement: z.string().min(1),
    character: z.object({ persona: z.string().min(1), voice: z.string(), goal: z.string().min(1) }).nullable().optional(),
  })).default([]),
  facts: z.array(z.object({ subject: z.string().min(1), predicate: z.string().min(1),
    value: z.union([z.string(), z.boolean()]), description: z.string().min(1) })).default([]),
  events: z.array(z.string().min(1)).default([]),
});
export type WorldExpansionDraft = z.infer<typeof schema>;
export interface WorldExpansion {
  draft: WorldExpansionDraft;
  operations: WorldDeltaOperation[];
  entities: WorldEntity[];
  facts: WorldFact[];
}
const idFor = (frame: ActionFrame, key: string) => `expansion-${contentHash([frame.id, key]).slice(0, 40)}`;

/** All structural identities and private initial cognition are owned by code. */
export function materializeExpansion(state: Readonly<SimulationState>, definition: WorldRuntimeContract, frame: ActionFrame, draft: WorldExpansionDraft): WorldExpansion {
  const source: CausalSource = { causes: [{ kind: "action", id: frame.id }], assertions: [{ kind: "entity_lifecycle", entityId: frame.actorEntityId, expected: "active" }] };
  const sceneId = state.truth.placements[frame.actorEntityId] ?? frame.actorEntityId;
  const refs: Record<string, string | null> = { actor: frame.actorEntityId, target: frame.targetEntityId, tool: frame.toolEntityId, scene: sceneId };
  for (const entity of draft.entities) {
    if (Object.hasOwn(refs, entity.key) || ["__proto__", "constructor", "prototype"].includes(entity.key)) throw new Error("Expansion keys must be unique and cannot shadow existing roles");
    refs[entity.key] = idFor(frame, `entity:${entity.key}`);
  }
  const operations: WorldDeltaOperation[] = [], entities: WorldEntity[] = [], facts: WorldFact[] = [];
  const addFact = (subjectId: string, key: string, predicate: string, value: string | boolean, description: string) => {
    // New details may supplement knowledge; established properties are changed by ordinary adjudication.
    if (Object.values(state.truth.facts).some(fact => fact.subjectId === subjectId && fact.predicate === predicate)) throw new Error(`Existing property cannot be replaced by expansion: ${predicate}`);
    if (facts.some(fact => fact.subjectId === subjectId && fact.predicate === predicate)) return;
    const fact: WorldFact = { id: idFor(frame, `fact:${key}`), subjectId, predicate,
      value: typeof value === "boolean" ? { kind: "boolean", value } : { kind: "text", value }, description,
      access: { kind: "public" }, provenance: source.causes };
    facts.push(fact); operations.push({ kind: "set_fact", fact, ...source });
  };
  const pending = [...draft.entities], ordered: WorldExpansionDraft["entities"] = [];
  const available = new Set(["scene", "actor", "target", "tool"].flatMap(key => refs[key] ? [key, refs[key]!] : []));
  while (pending.length) {
    const index = pending.findIndex(entity => available.has(entity.placement));
    if (index < 0) throw new Error("Expansion placements contain an unknown reference or cycle");
    const entity = pending.splice(index, 1)[0]!;
    ordered.push(entity); available.add(entity.key); available.add(refs[entity.key]!);
  }
  for (const draftEntity of ordered) {
    const id = refs[draftEntity.key]!, placementId = Object.hasOwn(refs, draftEntity.placement) ? refs[draftEntity.placement]
      : Object.values(refs).includes(draftEntity.placement) ? draftEntity.placement : null;
    if (!placementId) throw new Error("Expansion placement has no actual target");
    const entity: WorldEntity = { id, kind: draftEntity.character ? "person" : draftEntity.kind, name: draftEntity.name,
      description: draftEntity.appearance, lifecycle: "active", createdAtStep: state.step + 1 };
    entities.push(entity); operations.push({ kind: "create_entity", entity, placementId, ...source });
    addFact(id, `${draftEntity.key}:appearance`, "appearance", draftEntity.appearance, draftEntity.appearance);
    addFact(id, `${draftEntity.key}:label`, "appearance_label", draftEntity.label, draftEntity.label);
    if (draftEntity.character) {
      const step = state.step + 1, evidenceId = idFor(frame, `${draftEntity.key}:origin`), goalId = idFor(frame, `${draftEntity.key}:goal`);
      const agent: AgentState = { id, entityId: id, modelProfiles: structuredClone(definition.modelProfiles),
        character: { persona: { summary: draftEntity.character.persona, voice: draftEntity.character.voice, updatedAtStep: step, evidenceIds: [evidenceId] },
          traits: {}, values: {}, emotions: {}, attitudes: {}, commitments: {},
          goals: { [goalId]: { id: goalId, description: draftEntity.character.goal, priority: 0.7, progress: 0, targetIds: [], motivatedByIds: [],
            status: "active", createdAtStep: step, updatedAtStep: step, evidenceIds: [evidenceId] } } },
        belief: { localEntities: { self: { id: "self", name: draftEntity.name, description: draftEntity.appearance, status: "observed" },
          here: { id: "here", name: "此处", description: "自己实际到达的地方。", status: "observed" } }, claims: {},
          evidence: { [evidenceId]: { id: evidenceId, kind: "observation", description: "我已到达此处。", sourceId: frame.id, step } } },
        bindings: { self: { localEntityId: "self", canonicalEntityIds: [id] }, here: { localEntityId: "here", canonicalEntityIds: [placementId] } },
        observationCursorStep: step, nextAction: null };
      operations.push({ kind: "create_agent", agent, ...source });
    }
  }
  for (const [index, fact] of draft.facts.entries()) {
    const subject = Object.hasOwn(refs, fact.subject) ? refs[fact.subject]
      : Object.values(refs).includes(fact.subject) ? fact.subject : null;
    if (!subject) throw new Error(`Unknown expansion subject: ${fact.subject}`);
    addFact(subject, `detail:${index}`, fact.predicate, fact.value, fact.description);
  }
  for (const [index, event] of draft.events.entries()) addFact(sceneId, `event:${index}`, `occurrence-${idFor(frame, String(index))}`, event, event);
  return { draft, operations, entities, facts };
}

export async function createWorldExpansion(state: Readonly<SimulationState>, definition: WorldRuntimeContract, frame: ActionFrame, decisions: DirectDecisions, context: JsonValue, reads: Record<string, string>) {
  const system = loadPromptAsset("system/world-expansion.md"), userPrompt = loadPromptAsset("user/world-expansion.md");
  const audits: ModelExecutionAudit[] = [];
  let repair: string | null = null;
  let previousDraft: WorldExpansionDraft | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let result: StructuredModelResult<WorldExpansionDraft>;
    try { result = await decisions.provider.generateStructured({ ...decisions.scope, modelRegistrySnapshotHash: decisions.control.registryHash,
      profileId: agentCapabilityModels(state, decisions.control, frame.actorId).creation, subjectId: "world", role: "creation", modelInvocation: decisions.next("world"),
      system, userPrompt, promptVersion: `world-expansion-${contentHash([system, userPrompt])}`, schemaName: "WorldExpansionDraftV1", schema,
      context: { localWorld: context, establishedEntities: establishedEntityDirectory(state), requestedAction: frame, previousDraft, repair }, jsonExamplePolicy: "omit" }); }
    catch (error) {
      if (error instanceof ModelOutputError) {
        if (error.audit) audits.push(error.audit);
        repair = error.message;
        if (attempt === 0) continue;
      }
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { audits });
    }
    audits.push(result.audit);
    previousDraft = result.value;
    let expansion: WorldExpansion;
    try { expansion = materializeExpansion(state, definition, frame, result.value); }
    catch (error) { repair = error instanceof Error ? error.message : String(error); continue; }
    try {
      if (!expansion.operations.length) return { expansion, audits };
      const { entities, facts, events } = result.value;
      const identities = entities.filter(entity => entity.character).map(entity => ({ addition: entity,
        existing: Object.values(state.truth.entities).filter(existing => existing.id === frame.actorEntityId ||
          existing.id === frame.targetEntityId || existing.name === entity.name ||
          entity.name.length > 1 && existing.name.includes(entity.name))
          .map(existing => ({ id: existing.id, name: existing.name, description: existing.description,
            appearance: Object.values(state.truth.facts).filter(fact => fact.subjectId === existing.id && fact.predicate === "appearance") })),
      }));
      const passages = [
        ...entities.map(entity => ({ owner: entity.name, text: entity.appearance, kind: entity.kind, characterRegistered: Boolean(entity.character) })),
        ...facts.map(fact => ({ owner: fact.subject, text: `${fact.description} ${fact.value}` })),
        ...events.map(text => ({ owner: "scene", text })),
      ];
      const coverage = Object.fromEntries(passages.map((passage, index): [string, DecisionQuestionV2] => [`coverage${index}`, {
        type: "choice", version: "expansion-coverage-2",
        instructions: { task: "Check only NEW content in this passage against the declared inventory and existing authored scene. Newly mentioned people and independent portable objects need entries. Tools, weapons, containers, loose poles, food and furniture are independent even when held or decorative. Body parts, ordinary clothing and integral fixed surfaces need no entry. A fixed control console or fixture already authored in existing appearance facts is established; do not demand that this addition recreate it. Existing things need no duplicate. An object newly invented only inside another new appearance is not thereby registered. A new person needs character settings. Compare actual entries, not a summary's claim of completeness.", passage,
          declaredInventory: entities.map(entity => ({ name: entity.name, label: entity.label, key: entity.key, characterRegistered: Boolean(entity.character) })),
          existingLocalEntities: (context as { entities?: JsonValue }).entities ?? [],
          existingAppearanceFacts: ((context as { facts?: JsonValue[] }).facts ?? [])
            .filter(fact => fact && typeof fact === "object" && !Array.isArray(fact) && (fact as Record<string, JsonValue>).predicate === "appearance") },
        criteria: { complete: "Every independent person and object in this passage is registered", missing: "At least one independent person or object in this passage lacks an entry" },
      }]));
      const admitted = await decisions.ask(null, { localWorld: context, establishedEntities: establishedEntityDirectory(state), action: frame, addition: { entities, facts, events } } as unknown as JsonValue,
        reads, {
          accept: { type: "choice", version: "expansion-admission-2", instructions: "Can this addition occur here, respecting existing facts, time, materials and private knowledge? Public descriptions cannot expose secrets or manufacture a successful player outcome. Do not clone or relocate an established named person or business under an alias. Ordinary distinct items of a generic kind are allowed. The continuity directory is world-only, not automatic perceptual evidence.",
            criteria: { apply: "Plausible and consistent; introduce it", reject: "Conflicts or lacks necessary means", unknown: "Insufficient basis" } },
          ...coverage,
          ...Object.fromEntries(identities.map((identity, index): [string, DecisionQuestionV2] => [`identity${index}`, {
            type: "choice", version: "expansion-identity-1", instructions: { task: "Does this proposed new person duplicate an already existing individual? Compare name, appearance and role. The actor and target already exist. A legitimately distinct namesake is allowed; the same individual with added descriptive details is a duplicate, not a new arrival.",
              proposedPerson: identity.addition as unknown as JsonValue, existingPeople: identity.existing as unknown as JsonValue },
            criteria: { distinct: "This is a different person, including a justified namesake", duplicate: "This is an existing individual restated as new" },
          }])),
        });
      if (selected(admitted, "accept") !== "apply") return { expansion: null, audits };
      const missing = passages.filter((_, index) => selected(admitted, `coverage${index}`) === "missing");
      const duplicates = identities.filter((_, index) => selected(admitted, `identity${index}`) === "duplicate");
      if (!missing.length && !duplicates.length) return { expansion, audits };
      repair = `${missing.length ? `These passages mention a person or independently usable object without an entity entry: ${JSON.stringify(missing)}. Add missing entries, or remove unneeded props from those passages. Existing authored fixtures need no duplicate.` : ""}
${duplicates.length ? `These proposed people duplicate existing identities: ${JSON.stringify(duplicates)}. Remove the clones, including any dependent content. Use actor/target for existing bound roles; introduce only distinct new people.` : ""}
Return the complete corrected draft. This draft is not committed yet; actually update every affected field, including facts, rather than only the summary.`;
    }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { audits }); }
  }
  throw Object.assign(new Error(repair ?? "World expansion could not be materialized"), { audits });
}
