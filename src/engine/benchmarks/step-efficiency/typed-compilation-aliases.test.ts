import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { loadWorldScript } from "../../../script/world-loader";
import { ActionCompilationCodec } from "../../algorithms/eager-reference/action-compilation-representation";
import { representedActionCompiler } from "../../algorithms/eager-reference/represented-action-compiler";
import { compileActions } from "../../algorithms/eager-reference/action-compiler";
import { deterministicActionCompilationBatch, ScriptedModelProvider } from "../../testing/model-provider";
import { TypedCompilationAliases } from "./typed-compilation-aliases";

const ref = { type: "string", pattern: "^r[0-9]{3,}$" };
const branch = (kind: string, expected: unknown) => ({ type: "object", properties: { kind: { const: kind }, ref, expected } });
const schema = { type: "object", properties: { choices: { type: "array", items: { oneOf: [
  branch("random_result", {}), branch("fact_matches", { oneOf: [
    { type: "object", properties: { kind: { const: "entity" }, entityRef: ref } },
    { type: "object", properties: { kind: { const: "text" }, value: { type: "string" } } },
  ] }),
] } } } };
const context = () => ({ referenceCatalog: { candidates: [
  { candidateKey: "r000", kind: "agent", label: "Same character" },
  { candidateKey: "r001", kind: "entity", label: "Same character" },
] }, task: { slots: [{ actorRef: "r000", action: { rawText: "r001" } }] } });

it("distinguishes same-label records while preserving opaque literals and overlapping union leaves", () => {
  const source = context(), codec = new TypedCompilationAliases(source, schema);
  const value = { choices: [
    { kind: "random_result", ref: "r000", expected: { entityRef: "r001", ref: "r000" } },
    { kind: "fact_matches", ref: "r000", expected: { kind: "entity", entityRef: "r001" } },
    { kind: "fact_matches", ref: "r000", expected: { kind: "text", value: "r001" } },
  ] };
  const wire = codec.encodeOutput(value);
  expect(wire).toEqual({ choices: [
    { kind: "random_result", ref: "agent_r000", expected: { entityRef: "r001", ref: "r000" } },
    { kind: "fact_matches", ref: "agent_r000", expected: { kind: "entity", entityRef: "entity_r001" } },
    { kind: "fact_matches", ref: "agent_r000", expected: { kind: "text", value: "r001" } },
  ] });
  expect(codec.decodeOutput(wire)).toEqual(value);
  expect(codec.encodeContext()).toMatchObject({ task: { slots: [{ actorRef: "agent_r000", action: { rawText: "r001" } }] } });
  for (const bad of ["r000", "entity_r000", "agent_r999", "agent_r0"]) {
    expect(codec.decodeOutput({ choices: [{ kind: "random_result", ref: bad, expected: null }] })).toMatchObject({
      choices: [{ ref: `invalid-typed-alias:${bad}` }],
    });
  }
  source.referenceCatalog.candidates[0]!.kind = "entity";
  expect(() => codec.decodeOutput(wire)).toThrow("source binding changed");
});

it("round-trips actual AT choice schemas and preserves the real compiler materialization", async () => {
  const baseline = new ScriptedModelProvider(({ profileId, context }) => deterministicActionCompilationBatch(profileId, context));
  const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: baseline.catalog });
  const actions = [{ id: "inspect-gate", actorId: "player", baseRevision: 0, rawText: "Examine the gate.", goal: "Inspect the gate", means: null, targetIds: [] }];
  const scope = { workloadId: "typed", batchId: "batch", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  const original = await compileActions(baseline, state, actions, scope, "truth-engine", 12);
  const root = baseline.requests[0]!.context, raw = deterministicActionCompilationBatch("truth-engine", root);
  const at = new ActionCompilationCodec("AT", root);
  const wire = at.encodeOutput(raw);
  let encoded: unknown;
  const provider = new ScriptedModelProvider(() => encoded);
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = async request => {
    const codec = new TypedCompilationAliases(request.context, z.toJSONSchema(request.schema, { target: "draft-07" }));
    const adapted = codec.request(request); encoded = codec.encodeOutput(wire);
    expect(z.fromJSONSchema(codec.wireJsonSchema).safeParse(encoded).success).toBe(true);
    expect(codec.decodeOutput(encoded)).toEqual(wire);
    expect(adapted.schema).toBe(request.schema);
    return generate(adapted);
  };
  const actual = await representedActionCompiler("AT", true, true, true)(provider, state, actions, scope, "truth-engine", 12);
  expect(provider.requests).toHaveLength(1);
  expect(actual.compilations).toEqual(original.compilations);
});
