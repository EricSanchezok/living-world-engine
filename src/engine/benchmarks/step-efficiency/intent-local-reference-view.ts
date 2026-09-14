import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { agentIntentProgramSchema, inspectAgentIntentProgram, INTENT_PROGRAM_PREFIX } from "./agent-intent-program";

const instruction = loadPromptAsset("shared/intent-local-reference-view.md");
export const INTENT_LOCAL_VIEW_PREFIX = "INTENT_LOCAL_REFERENCE_VIEW_V1 (syntax-only intention; resolve intentTargets in the originating action's intentReferenceDomains row):\n";
const symbol = (ordinal: number) => `intent-local-${ordinal}`;
export const INTENT_LOCAL_REFERENCE_VIEW = `intent-local-reference-view-v1@${contentHash({ instruction,
  prefix: INTENT_LOCAL_VIEW_PREFIX, symbol: symbol(0), source: INTENT_PROGRAM_PREFIX }).slice(0, 16)}`;
const actionSchema = z.object({ actionRef: z.string(), actorRef: z.string(), rawText: z.string(), goal: z.string(), targetRefs: z.array(z.string()) });
const sourceSchema = z.object({ task: z.record(z.string(), z.unknown()), state: z.object({ actionSet: z.object({
  initial: z.array(actionSchema), available: z.array(actionSchema), assigned: z.array(actionSchema),
}) }) });
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
type Path = Array<string | number>;
type Replacement = { path: Path; source: string; view: string };

/** Parameter names are local to each action; matching source text never selects an actor. */
export class IntentLocalReferenceViewCodec {
  readonly context: unknown;
  readonly domains: Array<{ actionRef: string; actorRef: string; bindings: Array<{ symbol: string; localEntityRef: string }> }> = [];
  readonly replacements: Replacement[] = [];
  readonly sourceHash: string;
  private readonly viewHash: string;

  constructor(readonly source: unknown) {
    this.sourceHash = contentHash(source);
    const parsed = sourceSchema.parse(source);
    if (Object.hasOwn(parsed.task, "intentReferenceDomains")) throw new ModelConfigurationError("intent reference domains already present");
    const views = new Map<string, string>(), opaque = new Set<string>(), actions = new Map<string, z.infer<typeof actionSchema>>();
    for (const action of [...parsed.state.actionSet.initial, ...parsed.state.actionSet.available, ...parsed.state.actionSet.assigned]) {
      const prior = actions.get(action.actionRef);
      if (prior && contentHash(prior) !== contentHash(action)) throw new ModelConfigurationError("intent action domain differs between worksets");
      if (prior) continue;
      actions.set(action.actionRef, action);
      for (const text of [action.rawText, action.goal]) {
        if (!text.startsWith(INTENT_PROGRAM_PREFIX)) continue;
        let value: unknown;
        try { value = JSON.parse(text.slice(INTENT_PROGRAM_PREFIX.length)); } catch { continue; }
        const result = agentIntentProgramSchema.safeParse(value);
        if (!result.success) continue;
        // Only the exact diagnostic embedding is recognized; other text retains its bytes.
        if (INTENT_PROGRAM_PREFIX + JSON.stringify(result.data) !== text) continue;
        try {
          if (new Set(action.targetRefs).size !== action.targetRefs.length) throw new Error("duplicate local target references");
          inspectAgentIntentProgram(result.data, action.targetRefs.length);
        } catch { opaque.add(text); continue; }
        const view = { ...result.data, nodes: result.data.nodes.map(node => {
          if (!("targetIndices" in node)) return node;
          const { targetIndices, ...rest } = node;
          return { ...rest, intentTargets: targetIndices.map(symbol) };
        }) };
        views.set(text, INTENT_LOCAL_VIEW_PREFIX + JSON.stringify(view));
      }
    }
    // A program-looking player utterance with no matching domain remains opaque everywhere.
    for (const text of opaque) views.delete(text);
    for (const action of actions.values()) {
      if (views.has(action.rawText) || views.has(action.goal)) this.domains.push({ actionRef: action.actionRef, actorRef: action.actorRef,
        bindings: action.targetRefs.map((localEntityRef, ordinal) => ({ symbol: symbol(ordinal), localEntityRef })) });
    }
    const project = (value: unknown, path: Path): unknown => {
      if (typeof value === "string") {
        const view = views.get(value);
        if (view === undefined) return value;
        this.replacements.push({ path, source: value, view }); return view;
      }
      if (Array.isArray(value)) return value.map((item, ordinal) => project(item, [...path, ordinal]));
      if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, project(item, [...path, key])]));
      return value;
    };
    const context = project(source, []) as ObjectValue;
    if (this.domains.length) (context.task as ObjectValue).intentReferenceDomains = { contract: INTENT_LOCAL_REFERENCE_VIEW,
      scope: "Each row belongs only to its actionRef; its symbols are parameters, never global planning indices.", actions: this.domains };
    this.context = context;
    this.viewHash = contentHash(context);
    if (contentHash(this.restore()) !== this.sourceHash) throw new ModelConfigurationError("intent reference view source restoration failed");
  }

  restore(): unknown {
    if (contentHash(this.context) !== this.viewHash) throw new ModelConfigurationError("intent reference view changed before restoration");
    const restored = structuredClone(this.context) as ObjectValue;
    if (this.domains.length) delete (restored.task as ObjectValue).intentReferenceDomains;
    for (const { path, source, view } of this.replacements) {
      let holder: unknown = restored;
      for (const key of path.slice(0, -1)) holder = (holder as ObjectValue)[key];
      const key = path.at(-1)!;
      if ((holder as ObjectValue)[key] !== view) throw new ModelConfigurationError("intent reference view changed before restoration");
      (holder as ObjectValue)[key] = source;
    }
    return restored;
  }
}

/** Isolated logical planning screen; the response contract and adjudication remain canonical. */
export function intentLocalReferenceViewProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return { catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids), generateStructured: async request => {
      if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair"].includes(request.schemaName)) return inner.generateStructured(request);
      if (request.promptVersion.includes(INTENT_LOCAL_REFERENCE_VIEW)) throw new ModelConfigurationError("intent reference view already applied");
      const codec = new IntentLocalReferenceViewCodec(request.context);
      if (!codec.domains.length) return inner.generateStructured(request);
      const userPrompt = [request.userPrompt, instruction].join("\n\n");
      const result = await inner.generateStructured({ ...request, context: codec.context,
        userPrompt, promptVersion: `${request.promptVersion}/${INTENT_LOCAL_REFERENCE_VIEW}` });
      if (contentHash(request.context) !== codec.sourceHash || contentHash(codec.restore()) !== codec.sourceHash) {
        throw new ModelConfigurationError("intent reference view source or projection mutated");
      }
      // Physical prompt evidence retains the view version; the enclosing repair loop owns logical identity.
      return { ...result, audit: { ...result.audit, promptVersion: request.promptVersion } };
    } };
}
