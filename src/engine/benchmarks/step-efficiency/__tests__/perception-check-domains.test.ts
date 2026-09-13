import Ajv from "ajv";
import path from "node:path";
import { expect, it } from "vitest";
import { perceptionDirectiveSchema } from "../../../contracts/llm-schemas";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { contentHash } from "../../../models/model-audit";
import type { StructuredModelRequest } from "../../../models/model-provider";
import { ScriptedModelProvider, noStimulusReportsForTargets } from "../../../testing/model-provider";
import { loadWorldScript } from "../../../../script/world-loader";
import { perceptionCheckDomainsRequest } from "../perception-check-domains";

it("compiles complete owner/source choices from the real perception entry while preserving valid canonical checks", async () => {
  const provider = new ScriptedModelProvider(() => ({ kind: "done", reports: noStimulusReportsForTargets(input) }));
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const state = definition.initialState;
  const input = { definition, state, identityOwner: "check-domains", groundings: [],
    actions: [
      { id: "conceal", actorId: "player", baseRevision: state.revision, rawText: "Hide the key", goal: "Keep it hidden", means: null, targetIds: [] },
      { id: "watch", actorId: "keeper", baseRevision: state.revision, rawText: "Watch the doorway", goal: "Notice arrivals", means: null, targetIds: [] },
    ], perceptionTargets: [{ observerId: "keeper", sourceActionId: "conceal" }, { observerId: "player", sourceActionId: "watch" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  const before = contentHash(input), generate = provider.generateStructured.bind(provider);
  const captured: StructuredModelRequest<unknown>[] = [];
  provider.generateStructured = request => {
    const adapted = perceptionCheckDomainsRequest(request);
    expect(adapted.context).toBe(request.context); expect(adapted.schema).toBe(request.schema);
    expect(adapted.system).toBe(request.system); expect(adapted.userPrompt).toBe(request.userPrompt);
    expect(adapted.preprocessOutput).toBeUndefined();
    captured.push(adapted); return generate(adapted);
  };
  await new TruthEngine(provider, { repairAttempts: 0 }).perceiveOnset(input,
    { workloadId: "domain-world", batchId: "onset", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
  // Zod owns Unicode reference patterns; Ajv 6 evaluates the remaining Draft-07 constraints.
  const schema = JSON.parse(JSON.stringify(captured[0]!.wireJsonSchema), (key, value) => key === "pattern" && typeof value === "string" && value.includes("\\p{") ? undefined : value);
  const validate = new Ajv({ schemaId: "auto", unknownFormats: "ignore" }).compile(schema);
  const check = { proposalKey: "notice", actorRef: "ref:entity:keeper", targetRef: "ref:entity:key", ratingRef: "ref:rating:resolve:keeper",
    difficulty: { kind: "environment", band: "easy", source: { kind: "law", ref: "ref:law:time-passes" } }, mode: "normal", stakes: "Notice concealment", visibility: "full",
    causes: [{ kind: "law", ref: "ref:law:time-passes" }, { kind: "action", ref: "ref:action:conceal" }] };
  const accepts = (value: unknown) => perceptionDirectiveSchema.safeParse(value).success && validate(value);
  for (const ratingRef of [null, "ref:rating:resolve:keeper"]) expect(accepts({ kind: "request_checks", requests: [{ ...check, ratingRef }] })).toBe(true);
  const opposing = { ...check, targetRef: "ref:entity:key", difficulty: { kind: "opposed", targetRef: "ref:entity:player", ratingRef: "ref:rating:resolve:player", source: { kind: "rating", ref: "ref:rating:resolve:player" } } };
  expect(accepts({ kind: "request_checks", requests: [opposing] })).toBe(true);
  for (const invalid of [
    { ...check, ratingRef: "ref:rating:resolve:player" },
    { ...check, ratingRef: "ref:rating:invented" },
    { ...check, causes: [{ kind: "action", ref: "ref:action:watch" }] },
    { ...check, actorRef: "ref:entity:key", ratingRef: null },
    { ...opposing, difficulty: { ...opposing.difficulty, targetRef: "ref:entity:keeper" } },
    { ...opposing, difficulty: { ...opposing.difficulty, source: { kind: "rating", ref: "ref:rating:resolve:keeper" } } },
  ]) expect(accepts({ kind: "request_checks", requests: [invalid] })).toBe(false);
  expect(accepts({ kind: "done", reports: noStimulusReportsForTargets(input) })).toBe(true);
  expect(contentHash(input)).toBe(before);
});
