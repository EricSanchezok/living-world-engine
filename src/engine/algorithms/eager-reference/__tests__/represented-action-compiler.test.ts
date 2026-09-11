import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import type { AgentActionProposal } from "../../../contracts/model";
import { contentHash } from "../../../models/model-audit";
import { deterministicActionCompilationBatch, ScriptedModelProvider } from "../../../testing/model-provider";
import { SourceActionDescription } from "../source-action-description";
import { compileActions } from "../action-compiler";
import { ActionCompilationCodec, type ActionCompilationRepresentation } from "../action-compilation-representation";
import { representedActionCompiler, representedActionCompilationPrompt } from "../represented-action-compiler";
import type { ActionCompilationBatchDraft } from "../../../contracts/llm-schemas";
import type { ActionCompilationCandidateKey } from "../../../contracts/model-context";

const actions: AgentActionProposal[] = [{
  id: "inspect-gate", actorId: "player", baseRevision: 0,
  rawText: "Examine the gate.", goal: "Inspect the gate", means: null, targetIds: [],
}];

async function baseline(emptyResourcePools = false) {
  let output: unknown;
  const provider = new ScriptedModelProvider(({ profileId, context }) => {
    output = deterministicActionCompilationBatch(profileId, context);
    return output;
  });
  const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  if (emptyResourcePools) state.truth.sharedActivityResourcePools = {};
  const scope = { workloadId: "representation", batchId: "batch", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  const result = await compileActions(provider, state, actions, scope, "truth-engine", 12);
  return { state, scope, result, output, context: provider.requests[0]!.context };
}

describe("represented production compiler", () => {
  it.each<ActionCompilationRepresentation>(["A", "AT"])("normalizes exact ordinal padding in the first %s call with raw audit evidence", async arm => {
    const base = await baseline();
    const before = contentHash(base.state);
    const codec = new ActionCompilationCodec(arm, base.context);
    const wire = codec.encodeOutput(base.output) as { slots: Array<{ temporalPlan: { profileRef: string } }> };
    const padded = wire.slots[0]!.temporalPlan.profileRef;
    const shortened = padded.replace(/^r0+(?=\d)/u, "r");
    expect(shortened).not.toBe(padded);
    wire.slots[0]!.temporalPlan.profileRef = shortened;
    const raw = structuredClone(wire);
    const provider = new ScriptedModelProvider(() => wire);
    const result = await representedActionCompiler(arm)(provider, base.state, actions, base.scope, "truth-engine", 12);
    expect(provider.requests).toHaveLength(1);
    expect(result.compilations).toEqual(base.result.compilations);
    expect(contentHash(base.state)).toBe(before);
    expect(wire).toEqual(raw);
    const invocation = result.modelAudits.flatMap(audit => audit.invocations)[0]!;
    expect(invocation.rawOutputHash).not.toBe(invocation.normalizedOutputHash);
    expect(invocation.symbolRepairs).toEqual([expect.objectContaining({
      status: "normalized", method: "exact", originalValue: shortened, correctedValue: padded,
      path: ["slots", 0, "temporalPlan", "profileRef"], catalogHash: codec.dictionaryHash,
    })]);
  });

  it.each<ActionCompilationRepresentation>(["B1", "A", "T", "AT"])("preserves a real populated resource pool through %s", async arm => {
    const base = await baseline();
    const pool = Object.values(base.state.truth.sharedActivityResourcePools)[0]!;
    const codec = new ActionCompilationCodec(arm, base.context);
    const candidates = (base.context as { referenceCatalog: { candidates: Array<{ kind: string; candidateKey: ActionCompilationCandidateKey }> } })
      .referenceCatalog.candidates;
    const selected = candidates.find(candidate => candidate.kind === "shared_resource_pool")!;
    const output = structuredClone(base.output) as ActionCompilationBatchDraft;
    output.slots[0]!.interactionDependency.sharedResourceClaims = [{
      resourcePoolCandidateKey: selected.candidateKey, basis: { kind: "default" },
    }];
    const provider = new ScriptedModelProvider(() => codec.encodeOutput(output));
    const result = await representedActionCompiler(arm)(provider, base.state, actions, base.scope, "truth-engine", 12);
    expect(provider.requests).toHaveLength(1);
    expect(result.compilations[0]!.dependency.sharedResourceClaims[0]!.poolId).toBe(pool.id);
  });

  it.each<ActionCompilationRepresentation>(["B1", "A", "T", "AT"])("specializes the empty world resource domain through %s and repair", async arm => {
    const base = await baseline(true);
    expect(Object.keys(base.state.truth.sharedActivityResourcePools)).toEqual([]);
    const before = contentHash(base.state);
    const codec = new ActionCompilationCodec(arm, base.context);
    const candidates = (base.context as { referenceCatalog: { candidates: Array<{ kind: string; candidateKey: ActionCompilationCandidateKey }> } })
      .referenceCatalog.candidates;
    const entity = candidates.find(candidate => candidate.kind === "entity")!;
    const invalid = structuredClone(base.output) as ActionCompilationBatchDraft;
    invalid.slots[0]!.interactionDependency.sharedResourceClaims = [{
      resourcePoolCandidateKey: entity.candidateKey, basis: { kind: "default" },
    }];
    const wire = codec.encodeOutput(invalid);
    const wireBefore = structuredClone(wire);
    let calls = 0;
    const provider = new ScriptedModelProvider(() => ++calls === 1 ? {} : codec.encodeOutput(base.output));
    const generate = provider.generateStructured.bind(provider);
    provider.generateStructured = async request => {
      expect(request.schema.safeParse(wire).success).toBe(false);
      expect(wire).toEqual(wireBefore);
      return generate(request);
    };
    const result = await representedActionCompiler(arm)(provider, base.state, actions, base.scope, "truth-engine", 12);
    expect(provider.requests).toHaveLength(2);
    expect(result.compilations).toEqual(base.result.compilations);
    expect(contentHash(base.state)).toBe(before);
  });

  it.each<ActionCompilationRepresentation>(["B1", "A", "T", "AT"])("materializes identical plans, activities and dependencies through %s", async (arm) => {
    const base = await baseline();
    const before = contentHash(base.state);
    const codec = new ActionCompilationCodec(arm, base.context);
    const provider = new ScriptedModelProvider(() => codec.encodeOutput(base.output));
    const result = await representedActionCompiler(arm)(provider, base.state, actions, base.scope, "truth-engine", 12);
    expect(result.compilations).toEqual(base.result.compilations);
    expect(result.metrics).toEqual(base.result.metrics);
    expect(provider.requests).toHaveLength(1);
    expect(contentHash(base.state)).toBe(before);
  });

  it.each<ActionCompilationRepresentation>(["A", "AT"])("uses real localized repair for an unknown %s alias", async (arm) => {
    const base = await baseline();
    const codec = new ActionCompilationCodec(arm, base.context);
    let requests = 0;
    const provider = new ScriptedModelProvider(() => {
      const wire = codec.encodeOutput(base.output) as { slots: Array<{ temporalPlan: { profileRef: string } }> };
      if (++requests === 1) wire.slots[0]!.temporalPlan.profileRef = "r999";
      return wire;
    });
    const result = await representedActionCompiler(arm)(provider, base.state, actions, base.scope, "truth-engine", 12);
    expect(provider.requests).toHaveLength(2);
    expect(result.metrics.repairCalls).toBe(1);
    expect(result.compilations).toEqual(base.result.compilations);
    expect(result.modelAudits.flatMap((audit) => audit.invocations).flatMap((invocation) => invocation.symbolRepairs ?? [])).toEqual([]);
  });

  it("does not alter the production prompt or add unrelated instructions", () => {
    const base = representedActionCompilationPrompt("B1");
    const alias = representedActionCompilationPrompt("A");
    const temporal = representedActionCompilationPrompt("T");
    expect(base.system).toContain("twelve lowercase hexadecimal");
    expect(alias.system).not.toContain("twelve lowercase hexadecimal");
    expect(alias.system).toContain("zero-padded decimal ordinal");
    expect(temporal.system).toContain("twelve lowercase hexadecimal");
    expect(temporal.system).toContain('"first": <assertion>');
    expect(new Set([base.version, alias.version, temporal.version, representedActionCompilationPrompt("AT").version]).size).toBe(4);
    expect(alias.userPrompt).toBe(base.userPrompt);
  });

  it("preserves compiled behavior through the opt-in eligible profile schema", async () => {
    const base = await baseline();
    const codec = new ActionCompilationCodec("T", base.context);
    const provider = new ScriptedModelProvider(() => codec.encodeOutput(base.output));
    const result = await representedActionCompiler("T", true)(provider, base.state, actions, base.scope, "truth-engine", 12);
    expect(result.compilations).toEqual(base.result.compilations);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.context).toEqual(base.context);
    expect(provider.requests[0]!.schemaName).toBe("action_compilation_t_eligible_v1");
    expect(() => representedActionCompiler("A", true)).toThrow("temporal representation");
  });

  it.each([false, true])("uses named temporal operators and repairs contradictory selections with omitted schema %s", async omitField => {
    const base = await baseline();
    const codec = new ActionCompilationCodec("AT", base.context, base.context, undefined, true);
    const description = new SourceActionDescription(base.context, actions);
    let calls = 0;
    const provider = new ScriptedModelProvider(() => {
      const wire = codec.encodeOutput(description.omit(base.output)) as { slots: Array<{ temporalPlan: Record<string, unknown> }> };
      if (++calls === 1) wire.slots[0]!.temporalPlan.profileRef = "r000";
      return wire;
    });
    const result = await representedActionCompiler("AT", true, true, true, true, omitField)(provider, base.state, actions, base.scope, "truth-engine", 12);
    expect(provider.requests).toHaveLength(2);
    expect(result.metrics.repairCalls).toBe(1);
    expect(result.compilations[0]!.plan).toEqual({ ...base.result.compilations[0]!.plan, description: actions[0]!.rawText });
    expect(provider.requests[0]!.schemaName).toBe(`action_compilation_at_eligible_source_choice_contract${omitField ? "_omitted" : ""}_v1`);
    expect(provider.requests[0]!.system).toContain("completeEntireActionAfterFixedDurationProfile");
    expect(representedActionCompilationPrompt("AT", true, true, true).version).not.toBe(representedActionCompilationPrompt("AT", true, true).version);
  });

  it("preserves materialized behavior and one call with locally annotated profile choices", async () => {
    const base = await baseline();
    const codec = new ActionCompilationCodec("AT", base.context);
    const provider = new ScriptedModelProvider(() => codec.encodeOutput(base.output));
    const result = await representedActionCompiler("AT", true, false, true)(provider, base.state, actions, base.scope, "truth-engine", 12);
    expect(result.compilations).toEqual(base.result.compilations);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.context).toEqual(codec.encodeContext(base.context));
    expect(provider.requests[0]!.schemaName).toBe("action_compilation_at_eligible_choice_v1");
    expect(() => representedActionCompiler("A", false, false, true)).toThrow("temporal representation");
  });

  it.each((["B1", "T", "AT"] as const).flatMap(arm => [false, true].map(omitField => ({ arm, omitField }))))("binds omitted descriptions through $arm with omitted schema $omitField", async ({ arm, omitField }) => {
    const base = await baseline();
    const codec = new ActionCompilationCodec(arm, base.context);
    const description = new SourceActionDescription(base.context, actions);
    const provider = new ScriptedModelProvider(() => codec.encodeOutput(description.omit(description.restore({
      slots: (base.output as { slots: Array<{ temporalPlan: Record<string, unknown> }> }).slots.map((slot) => {
        const temporalPlan = { ...slot.temporalPlan };
        delete temporalPlan.description;
        return { ...slot, temporalPlan };
      }),
    }))));
    const generate = provider.generateStructured.bind(provider);
    provider.generateStructured = async request => {
      expect(request.schema.safeParse(codec.encodeOutput(base.output)).success).toBe(!omitField);
      return generate(request);
    };
    const result = await representedActionCompiler(arm, arm !== "B1", true, arm === "AT", false, omitField)(provider, base.state, actions, base.scope, "truth-engine", 12);
    expect(provider.requests).toHaveLength(1);
    expect(result.compilations[0]!.plan.description).toBe(actions[0]!.rawText);
    expect(result.compilations[0]!.activity.plan.description).toBe(actions[0]!.rawText);
    expect(result.compilations[0]!.activity.sourceAction).toEqual(actions[0]);
    const expected = structuredClone(base.result.compilations);
    expected[0]!.plan.description = actions[0]!.rawText;
    expected[0]!.activity.plan.description = actions[0]!.rawText;
    expect(result.compilations).toEqual(expected);
    const request = provider.requests[0]!;
    expect(request.system).toContain(omitField ? "excluded from the output schema" : "Omit this field");
    expect(request.schemaName.endsWith("_omitted_v1")).toBe(omitField);
  });

  it.each([false, true])("rejects contradictory description before localized acceptance with omitted schema %s", async omitField => {
    const base = await baseline();
    const codec = new ActionCompilationCodec("AT", base.context);
    let calls = 0;
    const provider = new ScriptedModelProvider(() => {
      const wire = codec.encodeOutput(base.output) as { slots: Array<{ temporalPlan: { description?: string } }> };
      if (++calls === 1) wire.slots[0]!.temporalPlan.description = "Examine the gate and recruit a guard.";
      else delete wire.slots[0]!.temporalPlan.description;
      return wire;
    });
    const result = await representedActionCompiler("AT", true, true, false, false, omitField)(provider, base.state, actions, base.scope, "truth-engine", 12);
    expect(provider.requests).toHaveLength(2);
    expect(result.metrics.repairCalls).toBe(1);
    expect(result.compilations[0]!.activity.plan.description).toBe(actions[0]!.rawText);
    expect(JSON.stringify(provider.requests[1]!.context)).toContain("paraphrasing or adding work is forbidden");
  });

  it("preserves other wire fields, temporal branches and source bindings when the description schema is omitted", async () => {
    const base = await baseline();
    const codec = new ActionCompilationCodec("AT", base.context, base.context, undefined, true);
    const binding = new SourceActionDescription(base.context, actions);
    const schema = codec.wireSchema(base.context, true, true);
    const { z } = await import("zod");
    const optional = z.toJSONSchema(binding.wireSchema(schema), { target: "draft-07" });
    const omitted = z.toJSONSchema(binding.wireSchema(schema, true), { target: "draft-07" });
    const expected = structuredClone(optional) as Record<string, unknown>;
    const strip = (value: unknown): number => {
      if (!value || typeof value !== "object") return 0;
      if (Array.isArray(value)) return value.reduce((sum, entry) => sum + strip(entry), 0);
      const node = value as Record<string, unknown>;
      const properties = node.properties as Record<string, unknown> | undefined;
      if (properties?.profileRef && properties.description) { delete properties.description; return 1; }
      return Object.values(node).reduce<number>((sum, entry) => sum + strip(entry), 0);
    };
    expect(strip(expected)).toBeGreaterThan(0);
    expect(omitted).toEqual(expected);
    expect(representedActionCompilationPrompt("AT", true, true, true, true).version)
      .not.toBe(representedActionCompilationPrompt("AT", true, true, true).version);
    expect(() => representedActionCompiler("AT", true, false, true, true, true)).toThrow("source ownership");
    expect(() => representedActionCompilationPrompt("AT", false, true, true, true)).toThrow("source ownership");
  });

  it("rebinds source text by action identity when repair slots are reordered", async () => {
    const base = await baseline();
    const { task } = base.context as { task: { slots: Array<Record<string, unknown>> } };
    const source = { ...actions[0]!, id: "second-action", rawText: "Wait for the bell, then leave." };
    const { actionCompilationCandidateKeyForHandle, referenceHandleFor } = await import("../../../contracts/model-context");
    const context = { task: { slots: [{ ...task.slots[0], slot: 0, actionReferences: {
      actionCandidateKey: actionCompilationCandidateKeyForHandle(referenceHandleFor("action", source.id)),
    } }] } };
    const bound = new SourceActionDescription(context, [...actions, source]);
    expect(bound.restore({ slots: [{ slot: 0, temporalPlan: {} }] })).toEqual({
      slots: [{ slot: 0, temporalPlan: { description: source.rawText } }],
    });
    expect(() => new SourceActionDescription(context, actions)).toThrow("binding");
    expect(bound.restore({ slots: [{ slot: 9, temporalPlan: {} }] })).toEqual({ slots: [{ slot: 9, temporalPlan: {} }] });
  });

  it("keeps independent alias namespaces for concurrently compiled physical roots", async () => {
    const base = await baseline();
    const second = { ...actions[0]!, id: "inspect-keeper", actorId: "keeper", rawText: "Keeper watches the gate." };
    const roots = new Map<string, { context: unknown; output: unknown }>();
    const baselineProvider = new ScriptedModelProvider(({ profileId, context }) => {
      const text = (context as { task: { slots: Array<{ action: { rawText: string } }> } }).task.slots[0]!.action.rawText;
      const output = deterministicActionCompilationBatch(profileId, context);
      roots.set(text, { context, output });
      return output;
    });
    const expected = await compileActions(baselineProvider, base.state, [...actions, second], base.scope, "truth-engine", 1);
    const provider = new ScriptedModelProvider(({ context }) => {
      const text = (context as { task: { slots: Array<{ action: { rawText: string } }> } }).task.slots[0]!.action.rawText;
      const root = roots.get(text)!;
      return new ActionCompilationCodec("AT", root.context).encodeOutput(root.output);
    });
    const result = await representedActionCompiler("AT")(provider, base.state, [...actions, second], base.scope, "truth-engine", 1);
    expect(result.compilations).toEqual(expected.compilations);
    expect(provider.requests).toHaveLength(2);
    expect(result.metrics.repairCalls).toBe(0);
  });

});
