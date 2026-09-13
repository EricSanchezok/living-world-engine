import { z } from "zod";
import { perceptionDirectiveSchema } from "../../contracts/llm-schemas";
import { existingReferenceHandleSchemaFor as existing } from "../../contracts/model-context";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, ModelOutputError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { buildPerceptionSourceIndex } from "./perception-source-index";

const text = z.string().trim().min(1);
const party = z.strictObject({ entityRef: existing("entity").nullable(), description: text });
export const actionPhaseGraphSchema = z.strictObject({ graphs: z.array(z.strictObject({
  sourceActionRef: existing("action"), sourceActorRef: existing("entity"),
  unspokenIntent: z.array(text),
  steps: z.array(z.strictObject({ stepId: z.number().int().nonnegative(), attempt: text,
    performer: party, addressedParties: z.array(party), requiresCompletionOf: z.array(z.number().int().nonnegative()),
    externalPrerequisites: z.array(text),
    sourceQuotes: z.array(z.strictObject({ field: z.enum(["rawText", "means"]), text: z.string().min(1) })).min(1),
  })).min(1),
})) });
type Graph = z.infer<typeof actionPhaseGraphSchema>["graphs"][number];

/** Structural readiness under an untrusted graph; never a world-state transition. */
export function initialActionPhaseFrontier(graph: Graph) {
  const nodes = new Map(graph.steps.map(step => [step.stepId, step]));
  if (!nodes.size || nodes.size !== graph.steps.length) throw new Error("phase graph requires unique nonempty steps");
  const remaining = new Map<number, number>(), successors = new Map<number, number[]>();
  const ready: number[] = [];
  for (const step of graph.steps) {
    if (new Set(step.requiresCompletionOf).size !== step.requiresCompletionOf.length) throw new Error("phase graph has duplicate edges");
    remaining.set(step.stepId, step.requiresCompletionOf.length);
    if (!step.requiresCompletionOf.length) ready.push(step.stepId);
    for (const predecessor of step.requiresCompletionOf) {
      if (!nodes.has(predecessor)) throw new Error("phase graph references a missing predecessor");
      const next = successors.get(predecessor) ?? [];
      next.push(step.stepId); successors.set(predecessor, next);
    }
  }
  for (let cursor = 0; cursor < ready.length; cursor++) {
    for (const next of successors.get(ready[cursor]!) ?? []) {
      const count = remaining.get(next)! - 1;
      remaining.set(next, count);
      if (!count) ready.push(next);
    }
  }
  if (ready.length !== nodes.size) throw new Error("phase graph has a cycle");
  return graph.steps.map(step => ({ stepId: step.stepId,
    status: step.requiresCompletionOf.length ? "waiting_for_predecessor" as const
      : step.externalPrerequisites.length ? "waiting_for_external_evidence" as const
        : step.performer.entityRef !== graph.sourceActorRef ? "external_performance" as const
          : "candidate_attempt" as const }));
}

const system = loadPromptAsset("system/action-phase-graph.md"), userPrompt = loadPromptAsset("user/action-phase-graph.md");
export const ACTION_PHASE_GRAPH = `action-phase-graph-v1@${contentHash({ system, userPrompt }).slice(0, 16)}`;

/** Isolated partial-order diagnostic; see decision 0206 for the planning connection. */
export function actionPhaseGraphRequest(request: StructuredModelRequest<unknown>): StructuredModelRequest<z.infer<typeof actionPhaseGraphSchema>> {
  const role = loadPromptAsset("system/truth-perception.md");
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive" ||
    request.system.split(role).length !== 2 || request.preprocessOutput || request.jsonExamplePolicy !== undefined ||
    request.promptVersion.includes(ACTION_PHASE_GRAPH) || request.wireJsonSchema &&
    contentHash(request.wireJsonSchema) !== contentHash(z.toJSONSchema(perceptionDirectiveSchema, { target: "draft-07" }))) {
    throw new ModelConfigurationError("phase graph requires the original perception request");
  }
  const sourceHash = contentHash(request.context), index = buildPerceptionSourceIndex(request.context);
  const pairShape = z.object({ targetIndex: z.number(), sourceActor: z.object({ entityRef: z.string() }),
    sourceAction: z.object({ actionRef: z.string(), rawText: z.string(), means: z.string().nullable() }) });
  const sources = new Map<string, ReturnType<typeof pairShape.parse>>();
  for (const value of index.workItems) {
    const row = pairShape.parse(value), previous = sources.get(row.sourceAction.actionRef);
    if (previous && (previous.sourceActor.entityRef !== row.sourceActor.entityRef || contentHash(previous.sourceAction) !== contentHash(row.sourceAction))) {
      throw new ModelConfigurationError("phase graph source bindings disagree");
    }
    sources.set(row.sourceAction.actionRef, row);
  }
  const context = structuredClone(request.context) as Record<string, unknown>;
  context.roleContract = { role: "truth-perception", purpose: "Untrusted partial-order action decomposition",
    modelOwns: ["open attempted steps", "performers and addressed parties", "precedence and external prerequisites", "unspoken intent"],
    engineOwns: ["graph and source validation", "structural initial frontier", "all canonical admission"],
    failureRule: "Graph readiness does not establish execution, completion, perception or factual preconditions." };
  const adaptedHash = contentHash(context);
  const catalog = z.object({ referenceCatalog: z.object({ candidates: z.array(z.object({
    handle: z.string(), kind: z.string(), allowedUses: z.array(z.string()),
  })) }) }).parse(context).referenceCatalog.candidates;
  const byRef = new Map(catalog.map(row => [row.handle, row]));
  if (byRef.size !== catalog.length) throw new ModelConfigurationError("phase graph catalog has duplicate handles");
  const groups = [...sources.values()].map(row => ({ sourceActionRef: row.sourceAction.actionRef, sourceActorRef: row.sourceActor.entityRef }));
  return { ...request, schema: actionPhaseGraphSchema, schemaName: "truth_action_phase_graph_probe", context,
    wireJsonSchema: z.toJSONSchema(actionPhaseGraphSchema, { target: "draft-07" }),
    system: request.system.replace(role, system), userPrompt, jsonExamplePolicy: "omit",
    promptVersion: `${request.promptVersion}/${ACTION_PHASE_GRAPH}`,
    jsonObjectPostlude: `${request.jsonObjectPostlude ?? ""}\n\nExact source index; no onset or perception is established by this index.\n${JSON.stringify(index)}\n\nDistinct assigned source groups:\n${JSON.stringify(groups)}`,
    preprocessOutput: value => {
      if (contentHash(request.context) !== sourceHash || contentHash(context) !== adaptedHash) throw new ModelConfigurationError("phase graph context changed");
      const parsed = actionPhaseGraphSchema.parse(value), seen = new Set<string>();
      const fail = (message: string): never => { throw new ModelOutputError(message, undefined, { rawValue: value }); };
      for (const graph of parsed.graphs) {
        const source = sources.get(graph.sourceActionRef);
        if (!source || seen.has(graph.sourceActionRef) || source.sourceActor.entityRef !== graph.sourceActorRef) return fail("phase graph source identity mismatch");
        seen.add(graph.sourceActionRef);
        try { initialActionPhaseFrontier(graph); } catch (error) { return fail((error as Error).message); }
        for (const step of graph.steps) {
          for (const quote of step.sourceQuotes) {
            const original = source.sourceAction[quote.field];
            if (original === null || !quote.text.trim() || !original.includes(quote.text)) return fail("phase graph quote is not an exact source excerpt");
          }
          for (const party of [step.performer, ...step.addressedParties]) if (party.entityRef !== null) {
            const selected = byRef.get(party.entityRef);
            if (selected?.kind !== "entity" || !selected.allowedUses.includes("target")) return fail("phase graph party is not a permitted entity");
          }
        }
      }
      if (seen.size !== sources.size) return fail("phase graph omits assigned sources");
      return { value: parsed, symbolRepairs: [] };
    } };
}
