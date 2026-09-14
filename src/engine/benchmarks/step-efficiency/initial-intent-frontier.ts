import { z } from "zod";
import { ACTIVITY_TEMPORAL_EVIDENCE } from "../../contracts/activity-temporal-evidence";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { agentIntentProgramSchema, inspectAgentIntentProgram, INTENT_PROGRAM_PREFIX } from "./agent-intent-program";

const instruction = loadPromptAsset("shared/initial-intent-frontier.md");
export const INITIAL_INTENT_FRONTIER = `initial-intent-frontier-v1@${contentHash({ instruction,
  embedding: INTENT_PROGRAM_PREFIX, eligibility: "unique-active-at-interval-start-empty-progress-stages-and-commitments-v1" }).slice(0, 16)}`;
const actionIdentitySchema = z.object({ actionRef: z.string(), actorRef: z.string(), rawText: z.string(), goal: z.string(),
  means: z.string().nullable(), targetRefs: z.array(z.string()) });
const actionSchema = actionIdentitySchema.passthrough();
const sourceSchema = z.object({ task: z.record(z.string(), z.unknown()), state: z.object({
  actionSet: z.object({ initial: z.array(actionSchema), available: z.array(actionSchema), assigned: z.array(actionSchema) }),
  temporalExecution: z.object({ contractVersion: z.literal(ACTIVITY_TEMPORAL_EVIDENCE), sourceHash: z.string(),
    boundary: z.object({ fromElapsedSeconds: z.number().nonnegative(), toElapsedSeconds: z.number().nonnegative() }).passthrough(),
    activities: z.record(z.string(), z.unknown()) }),
  committedResolutionPlans: z.array(z.unknown()), resolutionReceipts: z.array(z.unknown()),
}) });
const initialActivitySchema = z.object({ sourceActionRef: z.string(), actorRef: z.string(), status: z.literal("active"),
  startedAtSeconds: z.number(), updatedAtSeconds: z.number(), stageIndex: z.literal(0), progress: z.null(),
  plan: z.object({ startsAtSeconds: z.number(), progress: z.null(), stages: z.array(z.unknown()).length(0) }),
});
type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
type FrontierRow = { actionRef: string; actorRef: string; activityRef: string; sourceActionHash: string; programHash: string;
  activityHash: string; root: number; nodeCount: number; frontier: Array<{ nodeId: number; kind: string; [key: string]: unknown }> };

/** Syntax-only source view; temporal evidence gates initial applicability, never condition truth. */
export class InitialIntentFrontierView {
  readonly context: unknown;
  readonly rows: FrontierRow[] = [];
  readonly sourceHash: string;
  private readonly viewHash: string;

  constructor(readonly source: unknown) {
    this.sourceHash = contentHash(source);
    const parsed = sourceSchema.safeParse(source);
    if (!parsed.success) throw new ModelConfigurationError("initial intent frontier requires complete logical actions and temporal evidence");
    const { task, state } = parsed.data, temporal = state.temporalExecution;
    if (Object.hasOwn(task, "initialIntentFrontiers")) throw new ModelConfigurationError("initial intent frontier already present");
    if (temporal.boundary.toElapsedSeconds < temporal.boundary.fromElapsedSeconds) throw new ModelConfigurationError("initial intent frontier interval is reversed");
    const actions = new Map<string, z.infer<typeof actionSchema>>();
    for (const action of [...state.actionSet.initial, ...state.actionSet.available, ...state.actionSet.assigned]) {
      const prior = actions.get(action.actionRef);
      // Assigned-only means permissions are annotations, not a different source intention.
      if (prior && contentHash(actionIdentitySchema.parse(prior)) !== contentHash(actionIdentitySchema.parse(action))) {
        throw new ModelConfigurationError("initial intent frontier action differs between worksets");
      }
      actions.set(action.actionRef, action);
    }
    if (new Set(state.actionSet.assigned.map(action => action.actionRef)).size !== state.actionSet.assigned.length) {
      throw new ModelConfigurationError("initial intent frontier has duplicate assigned actions");
    }
    if (!state.committedResolutionPlans.length && !state.resolutionReceipts.length) for (const action of state.actionSet.assigned) {
      if (action.means !== null || action.goal !== action.rawText || !action.rawText.startsWith(INTENT_PROGRAM_PREFIX)) continue;
      let value: unknown;
      try { value = JSON.parse(action.rawText.slice(INTENT_PROGRAM_PREFIX.length)); } catch { continue; }
      const program = agentIntentProgramSchema.safeParse(value);
      if (!program.success || INTENT_PROGRAM_PREFIX + JSON.stringify(program.data) !== action.rawText) continue;
      if (!action.actorRef.startsWith("ref:agent:") || new Set(action.targetRefs).size !== action.targetRefs.length ||
        action.targetRefs.some(ref => !ref.startsWith(`ref:local_entity:${action.actorRef.slice("ref:agent:".length)}::`))) continue;
      let inspection: ReturnType<typeof inspectAgentIntentProgram>;
      try { inspection = inspectAgentIntentProgram(program.data, action.targetRefs.length); } catch { continue; }
      const matches = Object.entries(temporal.activities).filter(([, activity]) => object(activity) && activity.sourceActionRef === action.actionRef);
      if (matches.length !== 1) continue;
      const [activityRef, activity] = matches[0]!, initial = initialActivitySchema.safeParse(activity);
      if (!initial.success || initial.data.actorRef !== action.actorRef ||
        [initial.data.startedAtSeconds, initial.data.updatedAtSeconds, initial.data.plan.startsAtSeconds]
          .some(time => time !== temporal.boundary.fromElapsedSeconds)) continue;
      const nodes = new Map(program.data.nodes.map(node => [node.nodeId, node]));
      this.rows.push({ actionRef: action.actionRef, actorRef: action.actorRef, activityRef,
        sourceActionHash: contentHash(action), programHash: contentHash(program.data), activityHash: contentHash(activity),
        root: program.data.root, nodeCount: inspection.nodeCount,
        frontier: inspection.frontier.map(entry => {
          const node = nodes.get(entry.nodeId)!;
          if (!("targetIndices" in node)) throw new ModelConfigurationError("initial intent frontier contains a structural node");
          const { targetIndices, ...rest } = node;
          return { ...rest, localTargetRefs: targetIndices.map(index => action.targetRefs[index]!) };
        }) });
    }
    const context = structuredClone(source) as { task: Value };
    if (this.rows.length) context.task.initialIntentFrontiers = { contract: INITIAL_INTENT_FRONTIER,
      temporalSourceHash: temporal.sourceHash, boundary: structuredClone(temporal.boundary), actions: this.rows };
    this.context = context;
    this.viewHash = contentHash(context);
    this.assertUnchanged();
  }

  assertUnchanged(): void {
    if (contentHash(this.source) !== this.sourceHash || contentHash(this.context) !== this.viewHash) {
      throw new ModelConfigurationError("initial intent frontier source or view mutated");
    }
    const restored = structuredClone(this.context) as { task: Value };
    if (this.rows.length) delete restored.task.initialIntentFrontiers;
    if (contentHash(restored) !== this.sourceHash) throw new ModelConfigurationError("initial intent frontier source restoration failed");
  }
}

/** Add evidence before physical batching; retain the enclosing logical repair-loop identity. */
export function initialIntentFrontierProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return { catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids), generateStructured: async request => {
      if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair"].includes(request.schemaName)) return inner.generateStructured(request);
      if (request.promptVersion.includes(INITIAL_INTENT_FRONTIER)) throw new ModelConfigurationError("initial intent frontier already applied");
      const view = new InitialIntentFrontierView(request.context);
      if (!view.rows.length) return inner.generateStructured(request);
      view.assertUnchanged();
      try {
        const result = await inner.generateStructured({ ...request, context: view.context,
          userPrompt: [request.userPrompt, instruction].join("\n\n"), promptVersion: `${request.promptVersion}/${INITIAL_INTENT_FRONTIER}` });
        return { ...result, audit: { ...result.audit, promptVersion: request.promptVersion } };
      } finally { view.assertUnchanged(); }
    } };
}
