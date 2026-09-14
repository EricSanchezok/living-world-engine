import { z } from "zod";
import { resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import { createTruthReferenceResolver, projectModelAction } from "../../contracts/prompts";
import { declaredRandomPlanSchema } from "../../mechanics/plan-random-completion";
import { inspectResolutionPlanDrafts } from "../../mechanics/truth-engine";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, ModelOutputError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { bindResolutionAdmission, type ResolutionAdmissionSource } from "./resolution-admission";

const instruction = loadPromptAsset("shared/planning-candidate-selection.md");
const userPrompt = "Select one complete eligible planning candidate supported by the original source and planning duties, or abstain. Return only the selection object.";
export const planningCandidateSelectionSchema = z.strictObject({ candidateIndex: z.number().int().min(0).max(2).nullable(), reason: z.string().trim().min(1) });
export const PLANNING_CANDIDATE_SELECTION = `fixed-planning-candidate-selection-v1@${contentHash({ instruction, userPrompt }).slice(0, 16)}`;
type Value = Record<string, unknown>;
const object = (value: unknown): Value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelConfigurationError("planning selection requires an object context");
  return value as Value;
};
const directiveSchema = z.union([declaredRandomPlanSchema, resolutionPlanCommitDirectiveSchema]);

/** Fixed-pool semantic screening conveys no sampling or correctness guarantee.
 * @see docs/decisions/0219-screen-fixed-planning-candidate-selection.md */
export class PlanningCandidateSelection {
  readonly bindingHash: string;
  private readonly sourceHash: string;
  private readonly requestHash: string;
  private readonly preprocess: StructuredModelRequest<unknown>["preprocessOutput"];
  private readonly binding: ReturnType<typeof bindResolutionAdmission>[number];
  private readonly pool: Array<{ index: number; raw: unknown; canonical: unknown; eligible: boolean; screeningFailure: string | null }>;

  constructor(private readonly original: StructuredModelRequest<unknown>, private readonly source: ResolutionAdmissionSource, candidates: readonly unknown[]) {
    if (candidates.length !== 3 || original.role !== "truth-resolution" || original.schemaName !== "truth_resolution_plan_commit") {
      throw new ModelConfigurationError("planning selection requires three initial singleton planning proposals");
    }
    const context = object(original.context), state = object(context.state);
    if (context.repair != null || Object.hasOwn(context, "candidateSelection") ||
      ["committedResolutionPlans", "resolutionReceipts", "committedCheckRequests", "checkResults", "committedRandomRequests", "randomResults", "commitmentRounds"]
        .some(key => !Array.isArray(state[key]) || state[key].length !== 0)) throw new ModelConfigurationError("planning selection requires the initial uncommitted source");
    this.binding = bindResolutionAdmission({ ...source, contexts: [original.context] })[0]!;
    if (this.binding.actions.length !== 1 || original.subjectId !== this.binding.identityOwner) throw new ModelConfigurationError("planning selection assignment mismatch");
    const resolver = createTruthReferenceResolver({ state: source.state, definition: source.definition, actions: source.actions });
    const projected = source.actions.map(action => projectModelAction(action, resolver));
    const actionSet = object(state.actionSet);
    if (["initial", "available"].some(key => contentHash(actionSet[key]) !== contentHash(projected))) throw new ModelConfigurationError("planning selection requires the complete original action set");
    this.sourceHash = contentHash(source);
    this.requestHash = this.hashRequest();
    this.preprocess = original.preprocessOutput;
    this.pool = candidates.map((value, index) => {
      const raw = structuredClone(value);
      let canonical: unknown = null, screeningFailure: string | null = null;
      try { canonical = this.validate(raw); } catch (error) { screeningFailure = String(error); }
      return { index, raw, canonical, eligible: screeningFailure === null, screeningFailure };
    });
    this.assertSource();
    this.bindingHash = contentHash({ source: this.sourceHash, request: this.requestHash, pool: this.pool });
  }

  private hashRequest(): string {
    return contentHash({ context: this.original.context, system: this.original.system, userPrompt: this.original.userPrompt,
      promptVersion: this.original.promptVersion, schema: z.toJSONSchema(this.original.schema, { target: "draft-07" }), wire: this.original.wireJsonSchema,
      role: this.original.role, schemaName: this.original.schemaName, profileId: this.original.profileId, subjectId: this.original.subjectId,
      registry: this.original.modelRegistrySnapshotHash, runtime: this.original.runtimeIdentity, workloadId: this.original.workloadId, batchId: this.original.batchId,
      structuredOutputMode: this.original.structuredOutputMode, jsonExamplePolicy: this.original.jsonExamplePolicy, jsonObjectPostlude: this.original.jsonObjectPostlude,
      jsonSyntaxRecovery: this.original.jsonSyntaxRecovery, contextLayout: this.original.contextLayout, repairContextPlacement: this.original.repairContextPlacement });
  }

  private assertSource(): void {
    if (contentHash(this.source) !== this.sourceHash || this.hashRequest() !== this.requestHash || this.original.preprocessOutput !== this.preprocess) {
      throw new ModelConfigurationError("planning selection source or request changed after binding");
    }
  }

  private validate(raw: unknown) {
    const copy = structuredClone(raw);
    const decoded = this.original.preprocessOutput?.(copy);
    if (decoded?.symbolRepairs.length) throw new ModelOutputError("planning selection does not admit locally repaired proposals");
    const canonical = directiveSchema.parse(this.original.schema.parse(decoded ? decoded.value : copy));
    if (canonical.plans.some(plan => plan.mode !== "automatic")) throw new ModelOutputError("proposal is outside the fixed automatic-plan screen");
    const { state, definition } = this.source;
    const result = inspectResolutionPlanDrafts({ state, definition, actions: this.binding.actions, groundings: this.binding.groundings,
      identityOwner: this.binding.identityOwner, drafts: canonical.plans,
      allowedCauses: { action: new Set(this.binding.actions.map(action => action.id)), check: new Set(), random: new Set(),
        event: new Set(state.truth.events.map(event => event.id)), fact: new Set(Object.keys(state.truth.facts)),
        law: new Set(definition.laws.map(law => law.id)), mechanic: new Set() } });
    if (!result.valid) throw new ModelOutputError(JSON.stringify(result.issues));
    return canonical;
  }

  view() {
    this.assertSource();
    return { contract: PLANNING_CANDIDATE_SELECTION, bindingHash: this.bindingHash, sourceContextHash: contentHash(this.original.context),
      sourceInputHash: this.sourceHash, eligibleIndices: this.pool.filter(candidate => candidate.eligible).map(candidate => candidate.index),
      candidates: structuredClone(this.pool), originalRoleContract: structuredClone(object(this.original.context).roleContract),
      originalInstructions: { system: this.original.system, userPrompt: this.original.userPrompt, finalContract: this.original.jsonObjectPostlude ?? null } };
  }

  request(): StructuredModelRequest<z.infer<typeof planningCandidateSelectionSchema>> {
    const selection = this.view();
    if (!selection.eligibleIndices.length) throw new ModelOutputError("no eligible planning candidate; selection cannot proceed");
    return { ...this.original, schemaName: "truth_resolution_candidate_selection", schema: planningCandidateSelectionSchema,
      wireJsonSchema: z.toJSONSchema(planningCandidateSelectionSchema, { target: "draft-07" }), jsonExamplePolicy: "omit",
      preprocessOutput: undefined, jsonObjectPostlude: undefined, system: instruction, userPrompt,
      promptVersion: `${this.original.promptVersion}/${PLANNING_CANDIDATE_SELECTION}`,
      context: { ...structuredClone(object(this.original.context)),
        roleContract: { role: "planning-candidate-selector", modelOwns: ["whole-candidate semantic selection or abstention"],
          engineOwns: ["candidate identity and eligibility", "unchanged decoding", "canonical validation", "random commitment"] },
        candidateSelection: selection } };
  }

  decode(value: unknown): unknown {
    this.assertSource();
    const choice = planningCandidateSelectionSchema.parse(value);
    if (choice.candidateIndex === null) throw new ModelOutputError(`no supported planning candidate selected: ${choice.reason}`);
    const selected = this.pool[choice.candidateIndex]!;
    if (!selected.eligible) throw new ModelOutputError("selector chose a rejected planning candidate");
    if (contentHash(this.validate(selected.raw)) !== contentHash(selected.canonical)) throw new ModelConfigurationError("selected planning candidate decoding changed");
    this.assertSource();
    return structuredClone(selected.raw);
  }
}
