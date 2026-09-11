import { z } from "zod";
import type { AgentActionProposal, SimulationState } from "../../contracts/model";
import type { CandidateSelectionResult } from "../../algorithms/roles";
import { actionCompilationContext, compileActions } from "../../algorithms/eager-reference/action-compiler";
import { ActionCompilationCodec } from "../../algorithms/eager-reference/action-compilation-representation";
import { representedActionCompilationPrompt } from "../../algorithms/eager-reference/represented-action-compiler";
import { validateActionCompilationShortlistMembership } from "../../algorithms/eager-reference/action-compilation-validation";
import { DEFAULT_EAGER_OUTPUT_RECOVERY } from "../../algorithms/eager-reference/eager-slot-batching";
import { shortlistEvidenceContext } from "../../algorithms/eager-reference/candidate-retrieval/shortlist-evidence";
import { contentHash } from "../../models/model-audit";
import type { ModelCatalog } from "../../models/model-catalog";
import { composeJsonObjectPrompt, discriminatorInstruction, structuredPromptBytes } from "../../prompts";
import { ScriptedModelProvider } from "../../testing/model-provider";
import { parseLosslessExperimentJson } from "../action-compilation/lossless-json";
import type { TemporalProbeBody } from "./temporal-diagnostic";

export interface GoalDiagnosticArm {
  state: SimulationState;
  fullContext: Record<string, unknown>;
  selected: Pick<CandidateSelectionResult, "modelContext"> & {
    selectedKeysBySlot: Array<[number, string[]]>;
    diagnostics: Pick<CandidateSelectionResult["diagnostics"], "selectedCount" | "visibleCount">;
  };
}
export interface GoalDiagnosticSource {
  proof: { index: number; kind: string; actionsHash: string; arms: Record<"B" | "P", {
    stateHash: string; fullContextHash: string; modelContextHash: string;
  }> };
  actions: AgentActionProposal[];
  scope: { workloadId: string; batchId: string };
  profileId: string;
  arms: Record<"B" | "P", GoalDiagnosticArm>;
}

/** Reconstruct through the production projection before trusting a prepared request. */
export function bindGoalDiagnostic(source: GoalDiagnosticSource, arm: "B" | "P") {
  const data = source.arms[arm], proof = source.proof.arms[arm];
  if (source.actions.length !== 12 || new Set(source.actions.map((action) => action.id)).size !== 12 ||
    contentHash(source.actions) !== source.proof.actionsHash || contentHash(data.state) !== proof.stateHash ||
    contentHash(data.fullContext) !== proof.fullContextHash || contentHash(data.selected.modelContext) !== proof.modelContextHash) {
    throw new Error("goal diagnostic source binding mismatch");
  }
  const rebuilt = actionCompilationContext(data.state, source.actions.map((action) => ({ key: action.id,
    payload: { action }, issues: [] })), source.scope);
  if (contentHash(rebuilt) !== proof.fullContextHash) throw new Error("goal diagnostic state/context mismatch");
  const selected = new Map(data.selected.selectedKeysBySlot);
  if (selected.size !== 12 || [...selected.keys()].some((slot) => !Number.isInteger(slot) || slot < 0 || slot >= 12)) {
    throw new Error("goal diagnostic slot selection mismatch");
  }
  const visible = z.object({ referenceCatalog: z.object({ candidates: z.array(z.object({ candidateKey: z.string(),
    scope: z.discriminatedUnion("kind", [z.object({ kind: z.literal("shared") }), z.object({ kind: z.literal("slot"), slot: z.number() })]),
  }).passthrough()) }).passthrough() }).passthrough().parse(data.selected.modelContext);
  const keys = new Set(visible.referenceCatalog.candidates.map((candidate) => candidate.candidateKey));
  const fullCount = z.object({ referenceCatalog: z.object({ candidates: z.array(z.unknown()) }) }).parse(data.fullContext).referenceCatalog.candidates.length;
  const restored = shortlistEvidenceContext(data.fullContext, [...keys]).context;
  if (contentHash(restored) !== proof.modelContextHash || fullCount !== data.selected.diagnostics.visibleCount) {
    throw new Error("goal diagnostic model evidence differs from its source");
  }
  for (const [slot, allowed] of selected) {
    const scoped = visible.referenceCatalog.candidates.filter((candidate) => candidate.scope.kind === "shared" || candidate.scope.slot === slot)
      .map((candidate) => candidate.candidateKey).sort();
    if (new Set(allowed).size !== allowed.length || contentHash([...allowed].sort()) !== contentHash(scoped)) {
      throw new Error("goal diagnostic reference scope mismatch");
    }
  }
  if (keys.size !== data.selected.diagnostics.selectedCount || keys.size / data.selected.diagnostics.visibleCount >= .2) {
    throw new Error("goal diagnostic root candidate budget mismatch");
  }
  return { data, selected };
}

export function goalDiagnosticBody(source: GoalDiagnosticSource, arm: "B" | "P"): TemporalProbeBody {
  const { data } = bindGoalDiagnostic(source, arm);
  const context = data.selected.modelContext;
  const codec = new ActionCompilationCodec("T", context, data.fullContext);
  const schema = codec.wireSchema(context, true), prompt = representedActionCompilationPrompt("T");
  const bytes = structuredPromptBytes({ ...prompt, context: codec.encodeContext(context), schema });
  return { model: "deepseek-v4-flash", max_tokens: 131072, thinking: { type: "disabled" }, response_format: { type: "json_object" },
    messages: [{ role: "system", content: prompt.system }, { role: "user", content: composeJsonObjectPrompt({
      userPrompt: prompt.userPrompt, contextJson: bytes.contextJson,
      schemaJson: JSON.stringify(z.toJSONSchema(schema, { target: "draft-07" })),
      discriminator: discriminatorInstruction("action_compilation_t_eligible_v1"),
    }) }] };
}

/** Replay the model's one response through the actual compiler without any model repair. */
export async function scoreGoalDiagnostic(text: string, source: GoalDiagnosticSource, arm: "B" | "P", catalog: ModelCatalog) {
  const { data, selected } = bindGoalDiagnostic(source, arm);
  let rawJson = true;try { JSON.parse(text); } catch { rawJson = false; }
  let recoveredJson = false;
  try {
    const parsed = parseLosslessExperimentJson(text);recoveredJson = true;
    const codec = new ActionCompilationCodec("T", data.selected.modelContext, data.fullContext);
    const canonical = codec.decodeValidated(codec.wireSchema(data.selected.modelContext, true).parse(parsed.value));
    if (canonical.slots.length !== 12 || new Set(canonical.slots.map((slot) => slot.slot)).size !== 12) throw new Error("complete slot coverage required");
    for (const slot of canonical.slots) validateActionCompilationShortlistMembership({ value: slot, slot: slot.slot,
      allowedCandidateKeys: selected.get(slot.slot) ?? [] });
    const provider = new ScriptedModelProvider(() => structuredClone(canonical), catalog, false);
    const before = contentHash(data.state);
    const compiled = await compileActions(provider, data.state, source.actions, { ...source.scope,
      runtimeIdentity: { worldHash: data.state.worldHash, revision: data.state.revision } }, source.profileId, 12,
    { ...DEFAULT_EAGER_OUTPUT_RECOVERY, maxRepairs: 0 });
    if (provider.requests.length !== 1 || compiled.compilations.length !== 12 || contentHash(data.state) !== before) {
      throw new Error("offline compiler replay changed source or call cardinality");
    }
    return { rawJson, recoveredJson, formalPassed: true, plans: compiled.compilations.map((entry) => entry.plan),
      error: null, replayHttp: 0, fullSemantics: "unassessed" as const };
  } catch (error) {
    return { rawJson, recoveredJson, formalPassed: false, plans: [], error: error instanceof Error ? error.message : String(error),
      replayHttp: 0, fullSemantics: "unassessed" as const };
  }
}
