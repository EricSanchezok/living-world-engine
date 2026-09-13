import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { contentHash } from "../../../models/model-audit";
import type { StructuredModelRequest } from "../../../models/model-provider";
import { ScriptedModelProvider, noStimulusReportsForTargets } from "../../../testing/model-provider";
import { buildPerceptionSourceIndex, perceptionSourceIndexRequest } from "../perception-source-index";

it("joins the real perception source by identity despite equal names, preserving every original field and canonical output", async () => {
  const provider = new ScriptedModelProvider(() => ({ kind: "done", reports: noStimulusReportsForTargets(input) }));
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const state = structuredClone(definition.initialState);
  state.truth.entities.player!.name = state.truth.entities.keeper!.name;
  const input = { definition, state, identityOwner: "source-index", groundings: [],
    actions: [{ id: "conceal", actorId: "player", baseRevision: state.revision, rawText: "Conceal the key in my sleeve", goal: "Hide it", means: null, targetIds: [] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "conceal" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  const before = contentHash(input), generate = provider.generateStructured.bind(provider);
  let captured: StructuredModelRequest<unknown> | undefined;
  provider.generateStructured = request => {
    const source = { ...request, jsonObjectPostlude: "Existing authored law index." };
    const adapted = perceptionSourceIndexRequest(source);
    expect(adapted.context).toBe(request.context);
    expect(adapted.schema).toBe(request.schema);
    expect(adapted.wireJsonSchema).toBe(request.wireJsonSchema);
    expect(adapted.system).toBe(request.system);
    expect(adapted.userPrompt).toBe(request.userPrompt);
    expect(adapted.jsonObjectPostlude?.startsWith(source.jsonObjectPostlude)).toBe(true);
    expect(adapted.preprocessOutput!({ kind: "done", reports: [] })).toEqual({ value: { kind: "done", reports: [] }, symbolRepairs: [] });
    captured = adapted;
    return generate(adapted);
  };
  await new TruthEngine(provider, { repairAttempts: 0 }).perceiveOnset(input,
    { workloadId: "index-world", batchId: "onset", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
  const source = captured!.context as { state: { canonicalTruth: { placements: Record<string, unknown>; entities: Record<string, { placementRef: unknown }>; ratings: Record<string, unknown> } }; referenceCatalog: { candidates: Array<{ handle: string }> } };
  const index = buildPerceptionSourceIndex(source), row = index.workItems[0]!;
  expect(row.observer.entityRef).toBe("ref:entity:keeper");
  expect(row.sourceActor.entityRef).toBe("ref:entity:player");
  expect(row.sourceAction.rawText).toBe(input.actions[0]!.rawText);
  expect(row.observerRatings.map(rating => rating.ratingRef)).toEqual(["ref:rating:resolve:keeper"]);
  expect(row.observerPlacementChain.map(entry => entry.entityRef)).toEqual(["ref:entity:keeper", "ref:entity:courtyard"]);
  expect(row.sourceActorPlacementChain.map(entry => entry.entityRef)).toEqual(["ref:entity:player", "ref:entity:courtyard"]);
  expect(contentHash(input)).toBe(before);
  for (const mutate of [
    (copy: typeof source) => { delete copy.state.canonicalTruth.placements["ref:placement:keeper"]; },
    (copy: typeof source) => {
      copy.state.canonicalTruth.placements["ref:placement:keeper"] = "ref:placement:keeper";
      copy.state.canonicalTruth.entities["ref:entity:keeper"]!.placementRef = "ref:placement:keeper";
    },
    (copy: typeof source) => { copy.referenceCatalog.candidates = copy.referenceCatalog.candidates.filter(r => r.handle !== "ref:rating:resolve:keeper"); },
  ]) {
    const changed = structuredClone(source); mutate(changed);
    expect(() => buildPerceptionSourceIndex(changed)).toThrow();
  }
  expect(() => perceptionSourceIndexRequest(captured!)).toThrow("already indexed");
  source.state.canonicalTruth.ratings = {};
  expect(() => captured!.preprocessOutput!({ kind: "done", reports: [] })).toThrow("source changed");
});
