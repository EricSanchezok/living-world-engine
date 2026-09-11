import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { contentHash } from "../../models/model-audit";
import { ModelOutputError, type StructuredModelProvider } from "../../models/model-provider";
import { deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";

it.each(["malformed", "unavailable", "null"])("repairs the latest transition candidate through the real step (%s provider value)", async (mode) => {
  const base = new ScriptedModelProvider(({ profileId, context }) => deterministicModelOutput(profileId, context));
  let attempts = 0, sourceHash = "", previous: unknown, previousInvocation: string | undefined;
  const provider: StructuredModelProvider = {
    catalog: base.catalog, availableProfileSummaries: role => base.availableProfileSummaries(role),
    assertProfilesAvailable: ids => base.assertProfilesAvailable(ids),
    async generateStructured(request) {
      if (request.role !== "truth-transition" || request.schemaName !== "truth_transition") return base.generateStructured(request);
      attempts += 1;
      const context = request.context as { repair: { previousOutputAvailable?: boolean; previousOutput?: unknown; candidateBinding?: unknown } | null };
      if (attempts === 1) {
        sourceHash = contentHash(context);
        expect(context.repair).toBeNull();
      } else {
        expect(context.repair).toMatchObject({ previousOutputAvailable: previous !== undefined,
          previousOutput: previous === undefined ? null : previous,
          candidateBinding: { sourceContextHash: sourceHash, schemaName: "truth_transition",
            previousInvocationId: previousInvocation, canonicalOutputHash: previous === undefined ? null : contentHash(previous) } });
      }
      const generated = await base.generateStructured(request);
      previousInvocation = generated.audit.invocations.at(-1)?.id;
      if (attempts === 1) {
        const value = generated.value as { outcomes: Array<{ assertions: unknown[] }> };
        value.outcomes[0]!.assertions = [{ kind: "fact_matches", factRef: "ref:fact:unknown-witness", expected: { kind: "text", value: "uncommitted" } }];
        previous = structuredClone(value);
        return generated;
      }
      if (attempts === 2) {
        previous = mode === "unavailable" ? undefined : mode === "null" ? null : { ...generated.value as object, outcomes: "malformed latest candidate" };
        throw new ModelOutputError("provider rejected its current transition", generated.audit, { rawValue: previous });
      }
      return generated;
    },
  };
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
  await engine.bootstrapAgents();
  const source = engine.snapshot;
  const result = await engine.step({
    player: { kind: "external", agentId: "player", participantId: "test-player" },
    keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
  }, { expectedRevision: source.revision, trigger: "participant_action", externalActions: [{
    submissionId: "inspect-courtyard", agentId: "player", rawText: "观察庭院", goal: "确认庭院状况", means: null, targetIds: [],
  }] });
  expect(attempts).toBe(3);
  expect(result.state.revision).toBe(source.revision + 1);
  expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
  expect(JSON.stringify(result.state.truth)).not.toContain("unknown-witness");
});
