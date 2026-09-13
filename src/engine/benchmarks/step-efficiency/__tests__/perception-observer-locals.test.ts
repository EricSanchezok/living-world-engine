import path from "node:path";
import Ajv from "ajv";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { contentHash } from "../../../models/model-audit";
import { createModelGateway } from "../../../models/model-gateway";
import type { StructuredModelRequest } from "../../../models/model-provider";
import { ScriptedModelProvider, createTestModelRegistry } from "../../../testing/model-provider";
import { perceptionTemporalRoutesRequest } from "../perception-temporal-routes";
import { perceptionObserverLocalsRequest } from "../perception-observer-locals";

type Source = { state: {
  actors: Array<{ entityRef: string; availableLocalEntityRefs: string[]; localEntityBindings: Array<{ localEntityRef: string; canonicalEntityRefs: string[] }> }>;
  committedCheckRequests: Array<{ checkRef: string; actorRef: string }>;
}; task: { assignment: { perceptionTargets: Array<{ targetIndex: number; observerRef: string }> } } };
type Physical = { messages: Array<{ role: string; content: string }> };

it.each(["existing", "introduction", "foreign", "out_of_range", "undeclared", "repair", "check", "failed_check"])(
  "preserves observer ownership through the real gateway and onset receipt (%s)", async mode => {
    const provider = new ScriptedModelProvider(() => { throw Error("Use the actual HTTP gateway"); });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
    const state = structuredClone(definition.initialState);
    const keeper = state.agents.keeper!;
    for (const [id, canonicalEntityIds] of [["unbound", []], ["uncertain", ["key", "gate"]]] as const) {
      keeper.belief.localEntities[id] = { id, name: id, description: "An existing uncertain local appearance.", status: "observed" };
      keeper.bindings[id] = { ...keeper.bindings.self!, localEntityId: id, canonicalEntityIds: [...canonicalEntityIds] };
    }
    const input = { definition, state, identityOwner: "observer-symbols", groundings: [],
      actions: ["player", "keeper"].map(actorId => ({ id: `${actorId}-speak`, actorId, baseRevision: state.revision,
        rawText: "Greet the other person aloud.", goal: "Communicate", means: null, targetIds: [] })),
      perceptionTargets: [{ observerId: "keeper", sourceActionId: "player-speak" }, { observerId: "player", sourceActionId: "keeper-speak" }],
      temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
    const inputHash = contentHash(input);
    const results = [];
    for (const encoded of [false, true]) {
      if (!encoded && ["foreign", "out_of_range", "undeclared", "repair"].includes(mode)) continue;
      const originalRequests: StructuredModelRequest<unknown>[] = [], adaptedRequests: StructuredModelRequest<unknown>[] = [], physical: Physical[] = [];
      const gateway = createModelGateway(provider.catalog, { TEST_MODEL_API_KEY: "test-only" }, {
        registry: createTestModelRegistry(provider.catalog), maxTransportAttempts: 1,
        fetchForAccount: () => async (_url, init) => {
          physical.push(JSON.parse(String(init?.body)));
          const source = originalRequests.at(-1)!.context as Source;
          let output: unknown;
          if ((mode === "check" || mode === "failed_check") && physical.length === 1) {
            output = { kind: "request_checks", requests: [{ proposalKey: "notice", actorRef: "ref:entity:keeper", targetRef: "ref:entity:player", ratingRef: null,
              difficulty: { kind: "environment", band: mode === "failed_check" ? "extreme" : "trivial", source: { kind: "law", ref: "ref:law:time-passes" } },
              mode: "normal", stakes: "Notice the greeting through the ambient noise", visibility: "full",
              causes: [{ kind: "action", ref: "ref:action:player-speak" }, { kind: "law", ref: "ref:law:time-passes" }] }] };
          } else output = { kind: "done", reports: source.task.assignment.perceptionTargets.map(target => {
            const actor = source.state.actors.find(row => row.entityRef === target.observerRef)!;
            let reference: unknown = encoded ? { observerLocalIndex: 0 } : actor.availableLocalEntityRefs[0];
            if (mode === "introduction" || mode === "undeclared") reference = { proposalKey: `new-appearance-${target.targetIndex}` };
            if (mode === "out_of_range") reference = { observerLocalIndex: actor.availableLocalEntityRefs.length };
            if (mode === "foreign" || mode === "repair" && physical.length === 1) {
              reference = source.state.actors.find(row => row.entityRef !== target.observerRef)!.availableLocalEntityRefs[0];
            }
            return { targetIndex: target.targetIndex, route: "direct_current", presentCue: "An audible greeting.",
              reason: "The observer hears the source person's greeting.", evidence: [{ kind: "law", ref: "ref:law:time-passes" }],
              checkRefs: source.state.committedCheckRequests.filter(check => check.actorRef === target.observerRef).map(check => check.checkRef),
              stimulus: { summary: "An audible greeting.", introductions: mode === "introduction" ? [{ localEntity: {
                proposalKey: `new-appearance-${target.targetIndex}`, name: "An unfamiliar voice", description: "An audible appearance without an established identity.", status: "observed",
              }, canonicalEntityRef: null }] : [], apparentClaims: [{ subjectRef: reference, predicate: "associated-appearance",
                value: { kind: "local_entity", entityRef: reference }, description: "This local appearance is present in the greeting." }], sourceEventRefs: [] } };
          }) };
          if (encoded) {
            // Zod validates Unicode patterns; Ajv 6 checks the advertised field and target domains.
            const schema = JSON.parse(JSON.stringify(adaptedRequests.at(-1)!.wireJsonSchema), (key, value) =>
              key === "pattern" && typeof value === "string" && value.includes("\\p{") ? undefined : value);
            const validate = new Ajv({ schemaId: "auto", unknownFormats: "ignore" }).compile(schema);
            const invalidWire = mode === "foreign" || mode === "out_of_range" || mode === "repair" && physical.length === 1;
            expect(validate(output)).toBe(!invalidWire);
          }
          return new Response(JSON.stringify({ id: `symbols-${physical.length}`, model: "scripted:truth-deepseek",
            choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { headers: { "content-type": "application/json" } });
        },
      });
      provider.generateStructured = request => {
        originalRequests.push(request);
        const baseline = perceptionTemporalRoutesRequest(request), adapted = encoded ? perceptionObserverLocalsRequest(baseline) : baseline;
        adaptedRequests.push(adapted);
        expect(adapted.context).toBe(baseline.context);
        expect(adapted.schema).toBe(baseline.schema);
        expect(adapted.system).toBe(baseline.system);
        expect(adapted.userPrompt).toBe(baseline.userPrompt);
        if (encoded) {
          expect(adapted.jsonObjectPostlude).toContain(baseline.jsonObjectPostlude);
          expect(() => perceptionObserverLocalsRequest(adapted)).toThrow("exact temporal");
          expect(() => perceptionObserverLocalsRequest({ ...baseline, wireJsonSchema: {} })).toThrow("exact temporal");
        }
        return gateway.generateStructured(adapted);
      };
      const run = new TruthEngine(provider, { repairAttempts: mode === "repair" ? 1 : 0 }).perceiveOnset(input,
        { workloadId: "symbol-world", batchId: "onset", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
      if (["foreign", "out_of_range", "undeclared", "failed_check"].includes(mode)) {
        await expect(run).rejects.toThrow();
        expect(physical).toHaveLength(mode === "failed_check" ? 2 : 1);
      } else {
        const result = await run;
        results.push(result);
        expect(result.receipts).toHaveLength(2);
        expect(result.receipts.every(receipt => receipt.kind === "perceived")).toBe(true);
        expect(result.modelAudit.invocations).toHaveLength(mode === "repair" || mode === "check" ? 2 : 1);
        expect(result.rng.draws).toBe(state.truth.rng.draws + (mode === "check" ? 1 : 0));
        if (mode === "repair") expect((originalRequests[1]!.context as { repair: { issues: unknown[] } }).repair.issues.length).toBeGreaterThan(0);
      }
      expect(contentHash(input)).toBe(inputHash);
      if (encoded) {
        const adapted = adaptedRequests[0]!, source = adapted.context as Source;
        const before = contentHash(source);
        for (const actor of source.state.actors) expect(adapted.jsonObjectPostlude).toContain(JSON.stringify(actor.localEntityBindings[0]));
        const raw = { kind: "done", reports: [] }, rawHash = contentHash(raw);
        expect(() => adapted.preprocessOutput!(raw)).toThrow();
        expect(contentHash(raw)).toBe(rawHash);
        const baseline = perceptionTemporalRoutesRequest(originalRequests[0]!);
        const duplicate = structuredClone(baseline.context) as Source;
        duplicate.state.actors[0]!.availableLocalEntityRefs.push(duplicate.state.actors[0]!.availableLocalEntityRefs[0]!);
        expect(() => perceptionObserverLocalsRequest({ ...baseline, context: duplicate })).toThrow("inventory");
        const noncontiguous = structuredClone(baseline.context) as Source;
        noncontiguous.task.assignment.perceptionTargets[0]!.targetIndex = 9;
        expect(() => perceptionObserverLocalsRequest({ ...baseline, context: noncontiguous })).not.toThrow();
        expect(contentHash(source)).toBe(before);
        source.state.actors[0]!.availableLocalEntityRefs.reverse();
        expect(() => adapted.preprocessOutput!(raw)).toThrow("source changed");
      }
    }
    if (results.length === 2) {
      expect(results[1]!.receipts).toEqual(results[0]!.receipts);
      expect(results[1]!.requests).toEqual(results[0]!.requests);
      expect(results[1]!.checks).toEqual(results[0]!.checks);
      expect(results[1]!.rng).toEqual(results[0]!.rng);
    }
  },
);
