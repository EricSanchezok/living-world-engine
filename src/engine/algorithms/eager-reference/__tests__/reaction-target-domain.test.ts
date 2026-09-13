import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { loadWorldScript } from "../../../../script/world-loader";
import type { ObservationPacket, ReactionRequest } from "../../../contracts/model";
import { createAgentReferenceResolver } from "../../../contracts/model-context";
import { reactionDecisionDraftSchema } from "../../../contracts/llm-schemas";
import { contentHash } from "../../../models/model-audit";
import type { StructuredModelRequest } from "../../../models/model-provider";
import { ScriptedModelProvider } from "../../../testing/model-provider";
import { AgentMind } from "../agent-mind";

function fixture(invalidFirst = false) {
  let calls = 0;
  const provider = new ScriptedModelProvider(() => ({ kind: "replace", replacementAction: {
    rawText: "Ask the visitor what they need, then continue guarding if they leave.",
    goal: "Understand the visitor's request", means: null,
    targetHandles: invalidFirst && calls++ === 0 ? ["ref:observation:stimulus"] : ["ref:local_entity:visitor"],
  } }));
  const requests: StructuredModelRequest<unknown>[] = [];
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = request => { requests.push(request); return generate(request); };
  const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const agent = state.agents.keeper!;
  const original = { id: "prepared-action", actorId: agent.id, baseRevision: state.revision,
    rawText: "Guard the gate", goal: "Keep watch", means: null, targetIds: [] };
  const stimulus: ObservationPacket = { id: "stimulus", observerId: agent.id, step: state.step + 1, kind: "stimulus",
    summary: "A visitor asks for help.", sourceEventIds: [],
    introductions: [{ localEntity: { id: "visitor", name: "A visitor", description: "Someone asking for help", status: "observed" }, canonicalEntityId: "player" }],
    // Reference catalogs can include a mentioned identity that was never introduced.
    apparentClaims: [{ id: "rumor", subjectId: "unintroduced", predicate: "waiting", value: { kind: "boolean", value: true }, description: "A rumor about another person" }],
  };
  const request: ReactionRequest = { id: "reaction", agentId: agent.id, triggerActionId: original.id,
    originalIntent: { kind: "prepared_action", actionId: original.id }, stimulus, perceptionReceiptHash: "source" };
  const known = new Set([...Object.keys(agent.belief.localEntities), "visitor"]);
  const resolver = createAgentReferenceResolver(agent, [stimulus]);
  const allowed = resolver.catalog.candidates.filter(candidate => candidate.kind === "local_entity" &&
    candidate.allowedUses.includes("target") && known.has(resolver.resolve(candidate.handle).engineId)).map(candidate => candidate.handle);
  const run = () => new AgentMind(provider).react(state, agent, original, request,
    { workloadId: "reaction-test", batchId: "onset", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
  return { provider, requests, state, original, stimulus, allowed, run };
}

it("specializes the real reaction request to every known or introduced local target without changing valid decisions", async () => {
  const test = fixture(), before = contentHash(test.state);
  const result = await test.run();
  const request = test.requests[0]!;
  expect(request.wireJsonSchema).toBeDefined();
  const wire = z.fromJSONSchema(request.wireJsonSchema!);
  const decision = (targets: string[]) => ({ kind: "replace", replacementAction: {
    rawText: "A conditional attempt", goal: "An open-ended goal", means: null, targetHandles: targets,
  } });
  for (const targets of [[], test.allowed, [...test.allowed, ...test.allowed]]) {
    expect(wire.parse(decision(targets))).toEqual(reactionDecisionDraftSchema.parse(decision(targets)));
  }
  expect(wire.parse({ kind: "keep" })).toEqual({ kind: "keep" });
  for (const target of ["ref:observation:stimulus", "ref:agent:keeper", "ref:local_entity:unintroduced", "ref:entity:player", "ref:local_entity:missing"]) {
    expect(wire.safeParse(decision([target])).success).toBe(false);
  }
  expect(result).toMatchObject({ kind: "replace", replacementAction: { targetIds: ["visitor"] } });
  expect(contentHash(test.state)).toBe(before);
  expect(JSON.stringify(request.context)).not.toContain("canonicalEntityId");
});

it("retains an invalid model response and repairs with the exact target field and domain", async () => {
  const test = fixture(true);
  await test.run();
  expect(test.provider.requests).toHaveLength(2);
  const repaired = test.requests[1]!;
  const context = repaired.context as { repair: { issues: Array<{ path: unknown[]; originalValue: unknown; allowedHandles: string[] }> } };
  expect(context.repair.issues).toEqual([expect.objectContaining({
    path: ["replacementAction", "targetHandles", 0], originalValue: "ref:observation:stimulus", allowedHandles: test.allowed,
  })]);
  expect(repaired.wireJsonSchema).toEqual(test.requests[0]!.wireJsonSchema);
});
