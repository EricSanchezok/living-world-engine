import { z } from "zod";
import { perceptionDirectiveSchema } from "../../contracts/llm-schemas";
import { projectPerceptionTargets } from "../../contracts/perception-references";
import { createTruthReferenceResolver, projectCanonicalTruthForModel, projectModelAction } from "../../contracts/prompts";
import { materializeOnsetPerceptionReceipts, type OnsetReceiptInput } from "../../mechanics/onset-receipts";
import { materializeOnsetPerceptionChecks } from "../../mechanics/truth-engine";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, ModelOutputError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

const instruction = loadPromptAsset("shared/perception-candidate-selection.md");
const userPrompt = loadPromptAsset("user/perception-candidate-selection.md");
const originalRole = loadPromptAsset("system/truth-perception.md");
export const PERCEPTION_CANDIDATE_SELECTION = `perception-candidate-selection-v1@${contentHash({ instruction, userPrompt }).slice(0, 16)}`;
export const perceptionCandidateSelectionSchema = z.strictObject({ candidateIndex: z.number().int().min(0).max(2).nullable(), reason: z.string().trim().min(1) });
export interface PerceptionSample { value: unknown; providerAccepted: boolean; failure?: string }
type Source = OnsetReceiptInput & { identityOwner: string };
type Value = Record<string, unknown>;
const object = (value: unknown): Value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelConfigurationError("candidate selection requires an object context");
  return value as Value;
};

/**
 * Sampling and prompted selection transfer no correctness guarantee.
 * @see docs/decisions/0202-sample-and-select-whole-perception-candidates.md for primary sources and limits.
 */
export class PerceptionCandidateSelection {
  readonly bindingHash: string;
  private readonly inputHash: string;
  private readonly requestHash: string;
  private readonly pool: Array<PerceptionSample & { index: number; eligible: boolean; screeningFailure: string | null }>;

  constructor(private readonly original: StructuredModelRequest<unknown>, private readonly source: Source, samples: readonly PerceptionSample[]) {
    if (samples.length !== 3 || source.requests.length || source.checks.length) throw new ModelConfigurationError("candidate selection requires three initial proposals before random commitment");
    if (original.role !== "truth-perception" || original.schemaName !== "truth_perception_directive" || original.preprocessOutput ||
      original.system.split(originalRole).length !== 2 ||
      contentHash(original.wireJsonSchema ?? z.toJSONSchema(original.schema, { target: "draft-07" })) !== contentHash(z.toJSONSchema(perceptionDirectiveSchema, { target: "draft-07" }))) {
      throw new ModelConfigurationError("candidate selection requires the unadapted canonical perception request");
    }
    const context = object(original.context), state = object(context.state), assignment = object(object(context.task).assignment);
    if (Object.hasOwn(context, "candidateSelection")) throw new ModelConfigurationError("candidate selection already bound");
    const resolver = createTruthReferenceResolver({ ...source, checkRequests: [], observerIds: source.targets.map(target => target.observerId) });
    if (contentHash(projectCanonicalTruthForModel(source.state.truth, resolver, { includeMechanics: true })) !== contentHash(state.canonicalTruth) ||
      contentHash(source.actions.map(action => projectModelAction(action, resolver))) !== contentHash(object(state.actionSet).available) ||
      contentHash(projectPerceptionTargets(source.targets, source.state, source.actions, resolver)) !== contentHash(assignment.perceptionTargets)) {
      throw new ModelConfigurationError("candidate selection source does not match the complete request");
    }
    this.inputHash = contentHash(source);
    this.requestHash = this.hashRequest();
    this.pool = samples.map((sample, index) => {
      const copy = structuredClone(sample);
      let screeningFailure: string | null = null;
      try {
        if (!sample.providerAccepted) throw new ModelOutputError(sample.failure ?? "proposal failed provider validation");
        this.validate(copy.value);
      } catch (error) { screeningFailure = String(error); }
      return { ...copy, index, eligible: screeningFailure === null, screeningFailure };
    });
    this.bindingHash = contentHash({ input: this.inputHash, request: this.requestHash, pool: this.pool });
  }

  private hashRequest(): string {
    return contentHash({ context: this.original.context, system: this.original.system, userPrompt: this.original.userPrompt,
      promptVersion: this.original.promptVersion, schema: z.toJSONSchema(this.original.schema, { target: "draft-07" }), wire: this.original.wireJsonSchema,
      role: this.original.role, schemaName: this.original.schemaName, profileId: this.original.profileId, subjectId: this.original.subjectId,
      registry: this.original.modelRegistrySnapshotHash, workloadId: this.original.workloadId, batchId: this.original.batchId,
      jsonExamplePolicy: this.original.jsonExamplePolicy, jsonObjectPostlude: this.original.jsonObjectPostlude });
  }

  private assertSource(): void {
    if (contentHash(this.source) !== this.inputHash || this.hashRequest() !== this.requestHash) throw new ModelConfigurationError("candidate selection source changed after binding");
  }

  private validate(value: unknown): void {
    const directive = perceptionDirectiveSchema.parse(value);
    if (directive.kind === "done") materializeOnsetPerceptionReceipts(this.source, directive.reports);
    else materializeOnsetPerceptionChecks({ ...this.source, actions: [...this.source.actions], perceptionTargets: this.source.targets, commitmentRound: 0 }, directive.requests);
  }

  view() {
    this.assertSource();
    return { contract: PERCEPTION_CANDIDATE_SELECTION, bindingHash: this.bindingHash,
      sourceContextHash: contentHash(this.original.context), sourceInputHash: this.inputHash,
      eligibleIndices: this.pool.filter(candidate => candidate.eligible).map(candidate => candidate.index), candidates: structuredClone(this.pool),
      originalRoleContract: structuredClone(object(this.original.context).roleContract), originalRoleInstructions: originalRole, originalUserPrompt: this.original.userPrompt };
  }

  request(): StructuredModelRequest<z.infer<typeof perceptionCandidateSelectionSchema>> {
    const selection = this.view();
    if (!selection.eligibleIndices.length) throw new ModelOutputError("no mechanically eligible perception candidate; selection cannot proceed");
    return { ...this.original, schemaName: "truth_perception_candidate_selection", schema: perceptionCandidateSelectionSchema,
      wireJsonSchema: z.toJSONSchema(perceptionCandidateSelectionSchema, { target: "draft-07" }), jsonExamplePolicy: "omit",
      system: this.original.system.replace(originalRole, instruction),
      userPrompt,
      promptVersion: `${this.original.promptVersion}/${PERCEPTION_CANDIDATE_SELECTION}`,
      context: { ...structuredClone(object(this.original.context)),
        roleContract: { role: "perception-candidate-selector", modelOwns: ["whole-candidate semantic selection or abstention"],
          engineOwns: ["candidate identity and eligibility", "unchanged decoding", "canonical validation", "random commitment"] },
        candidateSelection: selection } };
  }

  decode(value: unknown) {
    this.assertSource();
    const choice = perceptionCandidateSelectionSchema.parse(value);
    if (choice.candidateIndex === null) throw new ModelOutputError(`no supported perception candidate selected: ${choice.reason}`);
    const selected = this.pool[choice.candidateIndex]!;
    if (!selected.eligible) throw new ModelOutputError("selector chose a mechanically rejected perception candidate");
    this.validate(selected.value);
    return structuredClone(perceptionDirectiveSchema.parse(selected.value));
  }
}
