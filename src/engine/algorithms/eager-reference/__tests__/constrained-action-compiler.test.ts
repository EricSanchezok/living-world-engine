import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import type { AgentActionProposal } from "../../../contracts/model";
import { createActionCompilationReferenceResolver } from "../../../contracts/model-context";
import { actionCompilationBatchSchema } from "../../../contracts/llm-schemas";
import { actionGroundingReferenceResolver, actionGroundingSharedContext } from "../../../mechanics/action-dependency";
import { deterministicActionCompilationBatch, ScriptedModelProvider } from "../../../testing/model-provider";
import { compileActions } from "../action-compiler";
import { ConstrainedActionCompilationCodec } from "../constrained-action-compilation-codec";
import { constrainedActionCompiler } from "../constrained-action-compiler";

const actions: AgentActionProposal[] = [{ id: "inspect-gate", actorId: "player", baseRevision: 0,
  rawText: "Examine the gate.", goal: "Inspect the gate", means: null, targetIds: [] }];
async function fixture() {
  let output: unknown;
  const provider = new ScriptedModelProvider(({ profileId, context }) => output = deterministicActionCompilationBatch(profileId, context));
  const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const scope = { workloadId: "constrained", batchId: "batch", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  const result = await compileActions(provider, state, actions, scope, "truth-engine", 12);
  const resolver = actionGroundingSharedContext(state, actions, actionGroundingReferenceResolver(state, actions, new Map([[actions[0]!.id, 0]])), true).referenceResolver;
  return { state, scope, result, output, context: provider.requests[0]!.context, resolver: createActionCompilationReferenceResolver(resolver, resolver) };
}

describe("constrained production compiler", () => {
  it.each([{ capabilities: true, snapshots: false }, { capabilities: false, snapshots: true }, { capabilities: true, snapshots: true }])("preserves real materialization for %j", async (options) => {
    const base = await fixture();
    const codec = new ConstrainedActionCompilationCodec({ ...options, ...base });
    const wire = codec.encodeOutput(base.output);
    expect(codec.schema.safeParse(wire).success).toBe(true);
    expect(codec.decodeOutput(wire)).toEqual(base.output);
    const provider = new ScriptedModelProvider(() => wire);
    const result = await constrainedActionCompiler({ ...options, structuredOutputMode: "json-schema-strict" })(provider, base.state, actions, base.scope, "truth-engine", 12);
    expect(result.compilations).toEqual(base.result.compilations);
    expect(provider.requests).toHaveLength(1);
  });

  it("enforces the exact resolver permission set and rejects invented keys", async () => {
    const base = await fixture();
    const codec = new ConstrainedActionCompilationCodec({ ...base, capabilities: true, snapshots: false });
    const candidates = (base.context as { referenceCatalog: { candidates: Array<{ candidateKey: string }> } }).referenceCatalog.candidates;
    for (const [slot, uses] of codec.allowed) for (const [use, keys] of uses) for (const candidate of candidates) {
      let permitted = true;
      try { base.resolver.scopedToSlot(slot).resolve(candidate.candidateKey, use); } catch { permitted = false; }
      expect(keys.includes(candidate.candidateKey)).toBe(permitted);
    }
    const wire = codec.encodeOutput(base.output) as { slots: Record<string, { temporalPlan: { profileRef: string } }> };
    wire.slots["0"]!.temporalPlan.profileRef = "candidate_ffffffffffff";
    expect(codec.schema.safeParse(wire).success).toBe(false);
  });

  it("does not silently normalize wrong wire structure or shadow slot identity", async () => {
    const base = await fixture();
    const codec = new ConstrainedActionCompilationCodec({ ...base, capabilities: true, snapshots: false });
    expect(actionCompilationBatchSchema.safeParse(codec.decodeOutput(base.output)).success).toBe(false);
    const wire = codec.encodeOutput(base.output) as { slots: Record<string, Record<string, unknown>> };
    wire.slots["0"]!.slot = 0;
    expect(actionCompilationBatchSchema.safeParse(codec.decodeOutput(wire)).success).toBe(false);
  });

  it("maps an entity snapshot to a visible selector and refuses hidden entity values", async () => {
    const base = await fixture();
    const context = structuredClone(base.context) as { referenceCatalog: { candidates: Array<{ kind: string; candidateKey: string; details: unknown }> } };
    const candidate = context.referenceCatalog.candidates.find((entry) => entry.kind === "fact")!;
    const entity = base.resolver.candidatesFor("assertion").find((entry) => entry.kind === "entity")!;
    const fact = base.state.truth.facts[base.resolver.resolve(candidate.candidateKey, "assertion").engineId]!;
    fact.value = { kind: "entity", entityId: base.resolver.resolve(entity.candidateKey, "assertion").engineId };
    candidate.details = { value: { kind: "entity", entityRef: entity.candidateKey } };
    const codec = new ConstrainedActionCompilationCodec({ ...base, context, capabilities: true, snapshots: true });
    expect(codec.snapshots.get(`0:${candidate.candidateKey}`)).toEqual({ kind: "entity", entityRef: entity.candidateKey });
    const selectedKeysBySlot = new Map([[0, context.referenceCatalog.candidates.filter((entry) => entry.candidateKey !== entity.candidateKey).map((entry) => entry.candidateKey)]]);
    const hidden = new ConstrainedActionCompilationCodec({ ...base, context, capabilities: true, snapshots: true, selectedKeysBySlot });
    expect(hidden.snapshots.has(`0:${candidate.candidateKey}`)).toBe(false);
  });

  it("uses unchanged localized recovery after a wire constraint failure", async () => {
    const base = await fixture();
    const codec = new ConstrainedActionCompilationCodec({ ...base, capabilities: true, snapshots: false });
    let calls = 0;
    const provider = new ScriptedModelProvider(() => {
      const wire = codec.encodeOutput(base.output) as { slots: Record<string, { temporalPlan: { profileRef: string } }> };
      if (++calls === 1) wire.slots["0"]!.temporalPlan.profileRef = "candidate_ffffffffffff";
      return wire;
    });
    const result = await constrainedActionCompiler({ capabilities: true, snapshots: false, structuredOutputMode: "json-schema-strict" })(provider, base.state, actions, base.scope, "truth-engine", 12);
    expect(result.compilations).toEqual(base.result.compilations);
    expect(result.metrics.repairCalls).toBe(1);
  });

  it.each([{ kind: "text", value: "candidate_ffffffffffff" }, { kind: "number", value: 12.5 },
    { kind: "boolean", value: false }, { kind: "none" }])("decodes only explicit exact visible snapshots: %j", async (value) => {
    const base = await fixture();
    const context = structuredClone(base.context) as { referenceCatalog: { candidates: Array<{ kind: string; candidateKey: string; details: unknown }> } };
    const candidate = context.referenceCatalog.candidates.find((entry) => entry.kind === "fact")!;
    const resolved = base.resolver.resolve(candidate.candidateKey, "assertion");
    base.state.truth.facts[resolved.engineId]!.value = value as typeof base.state.truth.facts[string]["value"];
    candidate.details = { value };
    const codec = new ConstrainedActionCompilationCodec({ ...base, context, capabilities: true, snapshots: true });
    const canonical = structuredClone(base.output) as { slots: Array<{ temporalPlan: { continuationAssertions: unknown[] } }> };
    const decode = (expected: unknown) => {
      canonical.slots[0]!.temporalPlan.continuationAssertions = [{ kind: "fact_matches", factRef: candidate.candidateKey, expected }];
      return (codec.decodeOutput(codec.encodeOutput(canonical)) as typeof canonical).slots[0]!.temporalPlan.continuationAssertions[0];
    };
    expect(decode({ mode: "snapshot" })).toEqual({ kind: "fact_matches", factRef: candidate.candidateKey, expected: value });
    expect(decode({ kind: "number", value: 999 })).toEqual({ kind: "fact_matches", factRef: candidate.candidateKey, expected: { kind: "number", value: 999 } });
    expect(decode({ mode: "snapshot", value: 999 })).toEqual({ kind: "fact_matches", factRef: candidate.candidateKey, expected: { mode: "snapshot", value: 999 } });
    base.state.truth.facts[resolved.engineId]!.value = { kind: "number", value: 999 };
    expect(decode({ mode: "snapshot" })).toEqual({ kind: "fact_matches", factRef: candidate.candidateKey, expected: value });
    candidate.details = null;
    const hidden = new ConstrainedActionCompilationCodec({ ...base, context, capabilities: true, snapshots: true });
    expect(hidden.snapshots.has(`0:${candidate.candidateKey}`)).toBe(false);
  });
});
