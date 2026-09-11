import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { planningSourceContexts } from "./planning-source-contexts";

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`planning action frames: ${message}`); };
const record = (value: unknown): Value => object(value) ? value : fail("missing source record");
const rows = (value: unknown): Value[] => Array.isArray(value) && value.every(object) ? value : fail("missing source rows");
const instruction = loadPromptAsset("shared/planning-action-frames.md");
export const PLANNING_ACTION_FRAMES = `source-planning-action-frames-v1@${contentHash(instruction).slice(0, 16)}`;

/** Join existing actor and Activity identities; do not adjudicate progress or action meaning. */
export function planningActionFrames(context: unknown, contexts = planningSourceContexts(context)): Value {
  const source = record(context), worklist = record(record(source.task).planningWorklist);
  const actions = rows(worklist.actions);
  const seen = new Set<number>();
  const frames = actions.map(row => {
    if (!Number.isSafeInteger(row.actionIndex) || (row.actionIndex as number) < 0 || seen.has(row.actionIndex as number) ||
      !Number.isSafeInteger(row.slot) || (row.slot as number) < 0) return fail("ambiguous action assignment");
    seen.add(row.actionIndex as number);
    const logical = record(contexts[row.slot as number]), state = record(logical.state), action = record(row.action);
    const assigned = rows(record(state.actionSet).assigned).filter(entry => entry.actionRef === action.actionRef);
    if (assigned.length !== 1 || ["actorRef", "rawText", "goal", "means"].some(field => contentHash(assigned[0]![field]) !== contentHash(action[field]))) return fail("worklist source action changed");
    const actors = rows(state.actors).filter(actor => actor.agentRef === action.actorRef);
    if (actors.length !== 1 || typeof actors[0]!.entityRef !== "string") return fail("ambiguous actor identity");
    const actor = actors[0]!, entity = record(record(record(state.canonicalTruth).entities)[actor.entityRef as string]);
    const temporal = record(state.temporalExecution), boundary = record(temporal.boundary);
    const canonicalBoundary = record(state.temporalBoundary);
    if (["fromElapsedSeconds", "toElapsedSeconds", "deltaSeconds"].some(field => !Number.isSafeInteger(boundary[field]) || boundary[field] !== canonicalBoundary[field]) ||
      (boundary.deltaSeconds as number) <= 0 || (boundary.fromElapsedSeconds as number) + (boundary.deltaSeconds as number) !== boundary.toElapsedSeconds) return fail("temporal boundary mismatch");
    const activities = Object.entries(record(temporal.activities)).filter(([, value]) => record(value).sourceActionRef === action.actionRef);
    if (activities.length > 1 || activities.some(([, value]) => record(value).actorRef !== action.actorRef)) return fail("ambiguous Activity identity");
    return { actionIndex: row.actionIndex, slot: row.slot,
      sourceAction: { actionRef: action.actionRef, actorRef: action.actorRef, rawText: action.rawText, goal: action.goal, means: action.means, targetRefs: action.targetRefs },
      actor: { ...structuredClone(actor), entity: structuredClone(entity) },
      interval: { fromElapsedSeconds: boundary.fromElapsedSeconds, toElapsedSeconds: boundary.toElapsedSeconds, deltaSeconds: boundary.deltaSeconds },
      activity: activities[0] ? { activityRef: activities[0][0], ...structuredClone(record(activities[0][1])) } : null,
    };
  });
  if (worklist.actionCount !== actions.length || [...seen].sort((a, b) => a - b).some((index, ordinal) => index !== ordinal)) return fail("incomplete action coverage");
  return { contract: PLANNING_ACTION_FRAMES, sourceContextHash: contentHash(source), frames };
}

export function planningActionFramesRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || request.schemaName !== "truth_resolution_plan_commit_batch") return request;
  const source = record(request.context), task = record(source.task);
  if (request.promptVersion.includes(PLANNING_ACTION_FRAMES) || Object.hasOwn(task, "planningActionFrames")) return fail("already applied");
  const frames = planningActionFrames(source), sourceHash = contentHash(source);
  const context = { ...structuredClone(source), task: { ...structuredClone(task), planningActionFrames: frames } };
  const contextHash = contentHash(context);
  const system = [request.system, instruction].join("\n\n");
  return { ...request, context, system, promptVersion: `${request.promptVersion}/${PLANNING_ACTION_FRAMES}@${contentHash(frames).slice(0, 16)}`,
    preprocessOutput: value => {
      if (contentHash(source) !== sourceHash || contentHash(context) !== contextHash) return fail("source or projection changed before decoding");
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    } };
}
