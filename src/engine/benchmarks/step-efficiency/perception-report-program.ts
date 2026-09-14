import { z } from "zod";
import type { OnsetPerceptionInput, OnsetPerceptionResult } from "../../algorithms/roles";
import type { D20CheckRequest, D20CheckResult } from "../../contracts/model";
import { onsetPerceptionReportSchema, perceptionDirectiveSchema } from "../../contracts/llm-schemas";
import { projectPerceptionTargets } from "../../contracts/perception-references";
import { createTruthReferenceResolver, projectCanonicalTruthForModel, projectModelAction } from "../../contracts/prompts";
import { materializeOnsetPerceptionChecks, TruthEngine } from "../../mechanics/truth-engine";
import { materializeOnsetPerceptionReceipts } from "../../mechanics/onset-receipts";
import { resolveD20Checks } from "../../mechanics/random";
import { contentHash } from "../../models/model-audit";
import { combineModelExecutionAudits, ModelConfigurationError, ModelOutputError, setModelInvocationOutcome, setModelInvocationResultKind, type ModelExecutionScope, type StructuredModelProvider, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

const instruction = loadPromptAsset("shared/perception-report-program.md");
const key = z.string().min(1);
const checkKeys = z.array(key);
const [negative, perceived] = onsetPerceptionReportSchema.options;
const reportSchema = z.discriminatedUnion("kind", [
  negative.omit({ checkRefs: true }).extend({ checkKeys }),
  perceived.omit({ checkRefs: true }).extend({ checkKeys }),
]);
const nodeIndex = z.number().int().nonnegative();
export const perceptionReportProgramSchema = z.strictObject({
  kind: z.literal("perception_program"),
  requests: z.array(perceptionDirectiveSchema.options[0].shape.requests.element),
  roots: z.array(z.strictObject({ targetIndex: nodeIndex, node: nodeIndex })),
  nodes: z.array(z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("report"), report: reportSchema }),
    z.strictObject({ kind: z.literal("branch"), checkKey: key, succeeded: nodeIndex, failed: nodeIndex }),
    z.strictObject({ kind: z.literal("defer"), checkKeys: checkKeys.min(1), reason: z.string().trim().min(1) }),
  ])),
});
type Program = z.infer<typeof perceptionReportProgramSchema>;
type Directive = z.infer<typeof perceptionDirectiveSchema>;
type Value = Record<string, unknown>;
const object = (value: unknown): Value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelConfigurationError("perception program requires an object context");
  return value as Value;
};
export const PERCEPTION_REPORT_PROGRAM = `perception-report-program-v1@${contentHash({ instruction,
  schema: z.toJSONSchema(perceptionReportProgramSchema, { target: "draft-07" }) }).slice(0, 16)}`;
export interface PerceptionProgramTrace {
  kind: "checks" | "reports" | "defer";
  programHash: string;
  sourceHash: string;
  inputHash: string;
  visitedNodes: number[];
  resultHash: string | null;
}

function assertSource(request: StructuredModelRequest<unknown>, input: OnsetPerceptionInput): void {
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive" || request.subjectId !== input.identityOwner || request.preprocessOutput) {
    throw new ModelConfigurationError("perception program requires the original canonical onset request");
  }
  const context = object(request.context), state = object(context.state), assignment = object(object(context.task).assignment);
  const resolver = createTruthReferenceResolver({ ...input, observerIds: input.perceptionTargets?.map(target => target.observerId) });
  const actions = input.actions.map(action => projectModelAction(action, resolver));
  if (contentHash(projectCanonicalTruthForModel(input.state.truth, resolver, { includeMechanics: true })) !== contentHash(state.canonicalTruth) ||
    ["initial", "assigned", "available"].some(field => contentHash(object(state.actionSet)[field]) !== contentHash(actions)) ||
    contentHash(projectPerceptionTargets(input.perceptionTargets ?? [], input.state, input.actions, resolver)) !== contentHash(assignment.perceptionTargets) ||
    contentHash(state.temporalBoundary) !== contentHash(input.temporalBoundary)) throw new ModelConfigurationError("perception program complete source mismatch");
}

/** Conditional report compilation, not a contingency-planning correctness proof.
 * @see docs/decisions/0220-compile-conditional-perception-reports.md */
export class PerceptionReportProgram {
  readonly programHash: string;
  private readonly program: Program;
  private readonly sourceHash: string;
  private readonly checks: ReturnType<typeof materializeOnsetPerceptionChecks>;
  private readonly keys: Map<string, number>;

  constructor(private readonly source: OnsetPerceptionInput, value: unknown) {
    this.sourceHash = contentHash(source);
    this.program = perceptionReportProgramSchema.parse(structuredClone(value));
    this.keys = new Map(this.program.requests.map((request, index) => [request.proposalKey, index]));
    if (this.keys.size !== this.program.requests.length) throw new ModelOutputError("perception program repeats a check key");
    this.checks = materializeOnsetPerceptionChecks({ ...source, requests: [], commitmentRound: 0 }, this.program.requests);
    const targets = source.perceptionTargets ?? [];
    if (this.program.roots.length !== targets.length || new Set(this.program.roots.map(root => root.targetIndex)).size !== targets.length ||
      this.program.roots.some(root => root.targetIndex >= targets.length)) throw new ModelOutputError("perception program must cover every assigned target once");
    const reached = new Set<number>(), usedChecks = new Set<string>();
    const dependency = (checkKey: string, targetIndex: number) => {
      const index = this.keys.get(checkKey), check = index === undefined ? undefined : this.checks[index];
      const target = targets[targetIndex]!;
      if (!check || check.actorId !== source.state.agents[target.observerId]?.entityId ||
        !check.causes.some(cause => cause.kind === "action" && cause.id === target.sourceActionId)) throw new ModelOutputError("perception program check has wrong observer or source action");
      usedChecks.add(checkKey);
    };
    const edges = this.program.nodes.map(node => node.kind === "branch" ? [node.succeeded, node.failed] : []);
    const incoming = this.program.nodes.map(() => 0);
    for (const next of edges.flat()) {
      if (!this.program.nodes[next]) throw new ModelOutputError("perception program references an unknown node");
      incoming[next]!++;
    }
    if (this.program.roots.some(root => !this.program.nodes[root.node])) throw new ModelOutputError("perception program references an unknown node");
    const order = incoming.flatMap((count, index) => count === 0 ? [index] : []);
    for (let position = 0; position < order.length; position++) {
      for (const next of edges[order[position]!]!) if (--incoming[next]! === 0) order.push(next);
    }
    if (order.length !== this.program.nodes.length) throw new ModelOutputError("perception program contains a cycle");
    // A shared continuation receives only success facts guaranteed on every
    // incoming path. A may-tested union also detects repeated tests on any path.
    for (const root of this.program.roots) {
      const targetIndex = root.targetIndex;
      const knowledge = new Map<number, { tested: Set<string>; succeeded: Set<string> }>([[root.node, { tested: new Set(), succeeded: new Set() }]]);
      const merge = (next: number, tested: Set<string>, succeeded: Set<string>) => {
        const previous = knowledge.get(next);
        knowledge.set(next, previous ? { tested: new Set([...previous.tested, ...tested]),
          succeeded: new Set([...previous.succeeded].filter(key => succeeded.has(key))) } : { tested, succeeded });
      };
      for (const index of order) {
        const known = knowledge.get(index);
        if (!known) continue;
        const node = this.program.nodes[index]!;
        reached.add(index);
        if (node.kind === "report") {
          if (node.report.targetIndex !== targetIndex) throw new ModelOutputError("perception program report changes its assigned target");
          if (new Set(node.report.checkKeys).size !== node.report.checkKeys.length) throw new ModelOutputError("perception program report repeats a check dependency");
          for (const checkKey of node.report.checkKeys) {
            dependency(checkKey, targetIndex);
            if (node.report.kind === "perceived" && !known.succeeded.has(checkKey)) throw new ModelOutputError("perceived report requires a successful branch for each check dependency");
          }
          if (node.report.kind === "perceived" && !node.report.checkKeys.length && this.checks.some(check => check.actorId === source.state.agents[targets[targetIndex]!.observerId]?.entityId &&
            check.causes.some(cause => cause.kind === "action" && cause.id === targets[targetIndex]!.sourceActionId))) throw new ModelOutputError("perceived report bypasses its declared uncertainty");
        } else if (node.kind === "defer") {
          node.checkKeys.forEach(checkKey => dependency(checkKey, targetIndex));
        } else {
          dependency(node.checkKey, targetIndex);
          if (known.tested.has(node.checkKey)) throw new ModelOutputError("perception program tests the same check repeatedly along one path");
          const tested = new Set([...known.tested, node.checkKey]);
          merge(node.succeeded, tested, new Set([...known.succeeded, node.checkKey]));
          merge(node.failed, tested, new Set(known.succeeded));
        }
      }
    }
    if (reached.size !== this.program.nodes.length || usedChecks.size !== this.keys.size) throw new ModelOutputError("perception program has unused nodes or check declarations");
    this.assertUnchanged();
    this.programHash = contentHash(this.program);
  }

  private assertUnchanged(): void {
    if (contentHash(this.source) !== this.sourceHash) throw new ModelConfigurationError("perception program source changed");
  }

  first(requestContext: unknown): { directive: Directive; trace: PerceptionProgramTrace } {
    this.assertUnchanged();
    if (!this.checks.length) {
      const result = this.finish([], []);
      if (!result.directive) throw new ModelOutputError("a no-check perception program cannot defer");
      return { ...result, directive: result.directive };
    }
    const directive: Directive = { kind: "request_checks", requests: structuredClone(this.program.requests) };
    return { directive, trace: this.trace("checks", requestContext, [], directive) };
  }

  materializedChecks(): D20CheckRequest[] {
    this.assertUnchanged();
    return structuredClone(this.checks);
  }

  finish(requests: readonly D20CheckRequest[], results: readonly D20CheckResult[]): { directive: Directive | null; trace: PerceptionProgramTrace } {
    this.assertUnchanged();
    const resolver = createTruthReferenceResolver({ ...this.source, checkRequests: this.checks,
      observerIds: this.source.perceptionTargets?.map(target => target.observerId) });
    const handles: string[] = this.checks.map(check => resolver.handleFor("check", check.id));
    const ids = this.checks.map(check => check.id);
    if (contentHash(requests) !== contentHash(this.checks) || results.length !== ids.length ||
      new Set(results.map(result => result.requestId)).size !== ids.length || results.some(result => !ids.includes(result.requestId) || typeof result.succeeded !== "boolean")) {
      throw new ModelConfigurationError("perception program requires its exact committed check results");
    }
    const outcomes = new Map(results.map(result => [resolver.handleFor("check", result.requestId) as string, result.succeeded]));
    const continuation = { requests, results };
    const visited: number[] = [], reports = [];
    for (const root of this.program.roots) {
      let index = root.node;
      while (true) {
        visited.push(index);
        const node = this.program.nodes[index]!;
        if (node.kind === "defer") return { directive: null, trace: this.trace("defer", continuation, visited, null) };
        if (node.kind === "branch") {
          index = outcomes.get(handles[this.keys.get(node.checkKey)!]!) ? node.succeeded : node.failed;
          continue;
        }
        const { checkKeys, ...report } = node.report;
        reports.push({ ...structuredClone(report), checkRefs: checkKeys.map(checkKey => handles[this.keys.get(checkKey)!]) });
        break;
      }
    }
    const directive = perceptionDirectiveSchema.parse({ kind: "done", reports });
    return { directive, trace: this.trace("reports", continuation, visited, directive) };
  }

  private trace(kind: PerceptionProgramTrace["kind"], context: unknown, visitedNodes: number[], directive: Directive | null): PerceptionProgramTrace {
    return { kind, programHash: this.programHash, sourceHash: this.sourceHash, inputHash: contentHash(context),
      visitedNodes, resultHash: directive === null ? null : contentHash(directive) };
  }
}

/** Capture the real initial request without HTTP, then run the compiled
 * capability through the same check, RNG and receipt functions as TruthEngine. */
export async function runPerceptionReportProgram(provider: StructuredModelProvider, source: OnsetPerceptionInput, scope: ModelExecutionScope,
  onTrace?: (trace: PerceptionProgramTrace) => void): Promise<OnsetPerceptionResult> {
  const sourceHash = contentHash(source);
  const wrap = (generateStructured: StructuredModelProvider["generateStructured"]): StructuredModelProvider => ({
    catalog: provider.catalog, availableProfileSummaries: role => provider.availableProfileSummaries(role),
    assertProfilesAvailable: ids => provider.assertProfilesAvailable(ids), generateStructured });
  let captured: StructuredModelRequest<unknown> | undefined;
  const stopped = new ModelConfigurationError("initial perception request captured without inference");
  try {
    await new TruthEngine(wrap(async request => { captured = request; throw stopped; }), { repairAttempts: 0 }).perceiveOnset(source, scope);
  } catch (error) { if (error !== stopped) throw error; }
  if (!captured) throw new ModelConfigurationError("initial perception request was not captured");
  const original = captured;
  assertSource(original, source);
  const requestContextHash = contentHash(original.context);
  const version = `${original.promptVersion}/${PERCEPTION_REPORT_PROGRAM}`;
  const result = await provider.generateStructured({ ...original, schemaName: "truth_perception_report_program", schema: perceptionReportProgramSchema,
    wireJsonSchema: z.toJSONSchema(perceptionReportProgramSchema, { target: "draft-07" }), jsonExamplePolicy: "omit",
    jsonObjectPostlude: undefined, promptVersion: version, userPrompt: [original.userPrompt, instruction].join("\n\n") });
  const observedAudits = [result.audit];
  try {
    if (contentHash(source) !== sourceHash || contentHash(original.context) !== requestContextHash) throw new ModelConfigurationError("perception program source changed during generation");
    setModelInvocationResultKind(result.audit, "truth-perception_perception_program");
    const program = new PerceptionReportProgram(source, result.value);
    const first = program.first(original.context); onTrace?.(first.trace);
    const requests = program.materializedChecks();
    const resolved = resolveD20Checks(structuredClone(source.state.truth.rng), requests);
    const final = first.directive.kind === "done" ? first : program.finish(requests, resolved.results);
    if (first.directive.kind !== "done") onTrace?.(final.trace);
    if (!final.directive) {
      let replayed = false;
      // Replay the actual model-declared initial batch and its one paid audit.
      // The ordinary engine derives the identical fixed draw from the original
      // RNG; only its returned transcript can proceed toward a world commit.
      return await new TruthEngine(wrap(async request => {
        if (contentHash(source) !== sourceHash) throw new ModelConfigurationError("deferred perception source changed");
        if (!replayed) {
          if (contentHash(request.context) !== contentHash(original.context)) throw new ModelConfigurationError("deferred perception initial request changed");
          replayed = true;
          return { value: request.schema.parse(first.directive), audit: structuredClone(result.audit) };
        }
        try {
          const continuation = await provider.generateStructured({ ...request, promptVersion: version });
          observedAudits.push(continuation.audit);
          return continuation;
        } catch (error) {
          if (error instanceof ModelOutputError && error.audit) observedAudits.push(error.audit);
          throw error;
        }
      }), { repairAttempts: 0 }).perceiveOnset(source, scope);
    }
    if (final.directive.kind !== "done") throw new ModelConfigurationError("compiled perception did not finish");
    const receipts = materializeOnsetPerceptionReceipts({ ...source, targets: source.perceptionTargets ?? [], requests, checks: resolved.results }, final.directive.reports);
    if (contentHash(source) !== sourceHash) throw new ModelConfigurationError("compiled perception changed source state");
    return { targets: structuredClone([...(source.perceptionTargets ?? [])]), receipts, requests, checks: resolved.results,
      commitmentRounds: requests.length ? [{ kind: "check", phase: "perception", requestIds: requests.map(request => request.id) }] : [],
      rng: resolved.rng, modelAudit: result.audit, aliases: requests.map((request, index) => [result.value.requests[index]!.proposalKey, request.id]) };
  } catch (error) {
    const audit = combineModelExecutionAudits(observedAudits);
    setModelInvocationOutcome(audit, "rejected", [String(error)]);
    throw new ModelOutputError(`perception program rejected: ${String(error)}`, audit, { rawValue: result.value, cause: error });
  }
}
