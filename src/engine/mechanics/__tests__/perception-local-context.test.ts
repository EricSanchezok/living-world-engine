import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import type { OnsetPerceptionInput } from "../../algorithms/roles";
import { onsetPerceptionReportSchema } from "../../contracts/llm-schemas";
import type { ModelReferenceCatalog } from "../../contracts/model-context";
import { contentHash } from "../../models/model-audit";
import { createModelGateway } from "../../models/model-gateway";
import { ScriptedModelProvider, createTestModelRegistry } from "../../testing/model-provider";
import { selectTemporalBoundary } from "../temporal";
import { TruthEngine } from "../truth-engine";

type Context = { state: { actors: Array<{ entityRef: string; availableLocalEntityRefs: string[];
  localEntityBindings: Array<{ localEntityRef: string; canonicalEntityRefs: string[] }> }> };
  task: { assignment: { allowedProposalKinds: string[]; perceptionTargets: Array<{ targetIndex: number; observerRef: string }> } };
  referenceCatalog: ModelReferenceCatalog; repair: { issues: unknown[] } | null };

function fixture() {
  const provider = new ScriptedModelProvider(() => { throw new Error("use the real gateway"); }, undefined, false);
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const state = structuredClone(definition.initialState);
  const input: OnsetPerceptionInput = { definition, state, identityOwner: "onset-local", groundings: [],
    actions: [{ id: "hand", actorId: "player", baseRevision: state.revision, rawText: "Raise my hand while silently recalling a secret.",
      goal: "Raise a hand", means: null, targetIds: [] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "hand" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  return { provider, input, run: () => new TruthEngine(provider, { repairAttempts: 1 }).perceiveOnset(input,
    { workloadId: "local-context", batchId: "onset", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } }) };
}

it.each(["valid", "canonical-subject", "canonical-value", "other-observer"])(
  "uses the supplied observer namespace through the actual gateway and materializer (%s)", async mode => {
    const f = fixture(), contexts: Context[] = [], bodies: string[] = [];
    if (mode === "other-observer") {
      f.input.actions.push({ ...f.input.actions[0]!, id: "watch", actorId: "keeper", rawText: "Watch silently." });
      f.input.perceptionTargets = [...f.input.perceptionTargets!, { observerId: "player", sourceActionId: "watch" }];
    }
    const before = contentHash(f.input);
    const gateway = createModelGateway(f.provider.catalog, { TEST_MODEL_API_KEY: "test-only" }, {
      registry: createTestModelRegistry(f.provider.catalog), maxTransportAttempts: 1,
      fetchForAccount: () => async (_url, init) => {
        bodies.push(String(init?.body));
        const context = contexts.at(-1)!, keeper = context.state.actors.find(actor => actor.entityRef === "ref:entity:keeper");
        expect(keeper).toBeDefined();
        const traveler = keeper!.localEntityBindings.find(binding => binding.canonicalEntityRefs.includes("ref:entity:player"))!.localEntityRef;
        const self = keeper!.localEntityBindings.find(binding => binding.canonicalEntityRefs.includes("ref:entity:keeper"))!.localEntityRef;
        expect(keeper!.availableLocalEntityRefs).toContain(traveler);
        expect(context.referenceCatalog.candidates.find(candidate => candidate.handle === traveler)?.allowedUses).toContain("subject");
        expect(context.referenceCatalog.candidates.find(candidate => candidate.handle === self)?.allowedUses).toContain("target");
        expect(context.task.assignment.allowedProposalKinds).toContain("local_entity");
        const wrongOwner = context.state.actors.find(actor => actor.entityRef === "ref:entity:player")?.availableLocalEntityRefs[0];
        const bad = bodies.length === 1;
        const reports = context.task.assignment.perceptionTargets.map(target => target.observerRef === "ref:entity:keeper"
          ? { targetIndex: target.targetIndex, kind: "perceived", reason: "The raised hand is visible, the silent thought is not.",
            evidence: [{ kind: "entity", ref: "ref:entity:player" }], checkRefs: [], stimulus: {
              summary: "The traveler raises a hand toward you.", introductions: [], sourceEventRefs: [], apparentClaims: [{
                subjectRef: bad && mode === "canonical-subject" ? "ref:entity:player" : bad && mode === "other-observer" ? wrongOwner : traveler,
                predicate: "gestures-toward", value: { kind: "local_entity", entityRef: bad && mode === "canonical-value" ? "ref:entity:keeper" : self },
                description: "A visible hand gesture toward the keeper.",
              }] } }
          : { targetIndex: target.targetIndex, kind: "no_stimulus", reason: "Silent watching supplies no outward onset.",
            evidence: [{ kind: "entity", ref: "ref:entity:keeper" }], checkRefs: [] });
        return new Response(JSON.stringify({ id: "local-context-" + bodies.length, model: "scripted:truth-deepseek",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ kind: "done", reports }) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    f.provider.generateStructured = request => { contexts.push(structuredClone(request.context) as Context); return gateway.generateStructured(request); };
    const result = await f.run(), receipt = result.receipts.find(item => item.observerId === "keeper")!;
    expect(receipt.kind).toBe("perceived");
    if (receipt.kind !== "perceived") throw new Error("missing stimulus");
    expect(receipt.stimulus.apparentClaims[0]).toMatchObject({ subjectId: "traveler", value: { kind: "local_entity", localEntityId: "self" } });
    expect(JSON.stringify(receipt.stimulus)).not.toContain("ref:entity:");
    expect(bodies).toHaveLength(mode === "valid" ? 1 : 2);
    if (mode !== "valid") expect(contexts[1]!.repair!.issues.length).toBeGreaterThan(0);
    expect(result.requests).toEqual([]); expect(result.rng).toEqual(f.input.state.truth.rng);
    expect(contentHash(f.input)).toBe(before);
  },
);

it.each(["subjectRef", "value"])("declares the local identity kind for stimulus claim %s", field => {
  const claim = { subjectRef: "ref:local_entity:keeper::traveler", predicate: "sees", value: { kind: "local_entity", entityRef: "ref:local_entity:keeper::self" }, description: "A local relation." };
  if (field === "subjectRef") claim.subjectRef = "ref:entity:player";
  else claim.value.entityRef = "ref:entity:keeper";
  expect(onsetPerceptionReportSchema.safeParse({ targetIndex: 0, kind: "perceived", reason: "Visible.", evidence: [{ kind: "entity", ref: "ref:entity:player" }], checkRefs: [],
    stimulus: { summary: "A gesture.", introductions: [], sourceEventRefs: [], apparentClaims: [claim] } }).success).toBe(false);
});
