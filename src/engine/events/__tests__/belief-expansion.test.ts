import { describe, expect, it } from "vitest";
import { nativeProgramFixture, nativeProgramTestConfig } from "../../testing/native-program-world";
import { decisionQuestionIds } from "../../testing/decision-provider";
import { historyReplayBaseHash } from "../../runtime/history-replay";
import { replaySimulationState } from "../../runtime/transaction";
import { SimulationEngine } from "../../runtime/simulation";
import { contentHash } from "../../models/model-audit";
import { DecisionEventAlgorithm } from "../algorithm";
import { restoreDecisionEventStep } from "../journal";
import { readDecisionEventState } from "../runtime-state";
import { settleProgramWorldEvent } from "../settlement";
import { applyEventBeliefs } from "../cognition";

function fixture(mode: "ready" | "repair" | "failed" | "unknown" | "skip") {
  const f = nativeProgramFixture();
  f.world.initialState.agents.keeper!.character.persona.summary = "PRIVATE_KEEPER_STRATEGY";
  f.world.historyBaseHash = historyReplayBaseHash(f.world.initialState);
  const original = f.configured.transport.getMockImplementation()!;
  let creations = 0;
  f.configured.transport.mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const wire = (body.messages as Array<{ content: string }>).map(message => message.content).join("\n");
    const respond = (value: unknown) => Response.json({ id: `belief-${f.configured.transport.mock.calls.length}`,
      model: body.model, created: 1, choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(value) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
    if (wire.includes("You propose new private beliefs")) {
      creations += 1;
      expect(wire).not.toContain("PRIVATE_KEEPER_STRATEGY");
      expect(wire).not.toContain("canonicalEntityIds");
      const evidenceIds = JSON.parse(wire.match(/"newEvidenceIds"\s*:\s*(\[[^\]]+\])/u)![1]!) as string[];
      const entityIds = JSON.parse(wire.match(/"entityIds"\s*:\s*(\[[^\]]+\])/u)![1]!) as string[];
      return respond({ claims: [{ subjectId: mode === "failed" || mode === "repair" && creations === 1 ? "invented-entity" : entityIds[0],
        predicate: "heard-inquiry", value: { kind: "text", value: "The speaker asked why I am here." },
        description: "I heard a question about my purpose.", evidenceIds }] });
    }
    if (wire.includes("Assess this specific candidate private claim")) {
      return respond({ answers: Object.fromEntries(decisionQuestionIds(body).map(id =>
        [id, { choice: mode === "unknown" ? "unknown" : "supported" }])) });
    }
    if (wire.includes("decide whether any new durable claim")) {
      return respond({ answers: Object.fromEntries(decisionQuestionIds(body).map(id =>
        [id, { choice: id === "expand" ? mode === "skip" ? "unknown" : "needed" : "unchanged" }])) });
    }
    return original(url, init);
  });
  return { ...f, creations: () => creations };
}

describe("new private beliefs from actual delivered evidence", () => {
  it("uses the Agent's creation capability for belief admission and offline replay", async () => {
    const f = fixture("ready");
    f.world.initialState.agents.player!.modelProfiles.creation = "world-test";
    f.world.historyBaseHash = historyReplayBaseHash(f.world.initialState);
    await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway));
    const boot = await engine.bootstrapAgents();
    const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const proof = restoreDecisionEventStep(boot, result.committed.decisionEvent!);
    expect(proof.beliefRevisions.find(value => value.agentId === "player")!.creation!.audit!.profileId).toBe("world-test");
    expect(proof.preparedControl.models.creation).toBe("creation-deepseek");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it.each(["ready", "repair", "unknown"] as const)("creates and judges a %s interpretation through the real entry and replays without inference", async mode => {
    const f = fixture(mode); await f.configured.registry.capture();
    const algorithm = new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig);
    const engine = new SimulationEngine(f.world, algorithm), boot = await engine.bootstrapAgents();
    const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const proof = restoreDecisionEventStep(boot, result.committed.decisionEvent!);
    const revision = proof.beliefRevisions.find(value => value.agentId === "player")!;
    expect(f.creations()).toBe(mode === "repair" ? 2 : 1);
    expect(revision.creation?.status).toBe("ready");
    expect(revision.creation?.audit?.invocations.map(value => value.outputDisposition)).toEqual(mode === "repair" ? ["rejected", "llm-repaired"] : ["accepted"]);
    const claim = Object.values(result.state.agents.player!.belief.claims).find(value => value.predicate === "heard-inquiry")!;
    expect(claim).toMatchObject({ stance: mode === "unknown" ? "suspected" : "believed", confidence: 0.5, evidenceIds: revision.evidenceIds });
    expect(claim.id).toMatch(/^rt:claim:/u);
    expect(result.state.agents.keeper!.belief.claims).toEqual(boot.agents.keeper!.belief.claims);
    expect(result.state.truth.elapsedSeconds).toBe(5);
    const calls = f.configured.transport.mock.calls.length;
    expect(replaySimulationState(result.state)).toEqual(result.state);
    expect(f.configured.transport).toHaveBeenCalledTimes(calls);
    const preview = settleProgramWorldEvent(boot, proof.preparedControl, proof.event!, proof.authority, algorithm.manifest.hash).state;
    const forged = structuredClone(revision); forged.creation!.sourceHash = contentHash("another-owner-input");
    forged.hash = contentHash(Object.fromEntries(Object.entries(forged).filter(([key]) => key !== "hash")));
    expect(() => applyEventBeliefs(preview, forged, proof.preparedControl.agents.player!.resources, "world-test")).toThrow("another private input");
  });
  it.each(["failed", "skip"] as const)("retains raw observations when expansion is %s and never fabricates a belief", async mode => {
    const f = fixture(mode); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    const boot = await engine.bootstrapAgents();
    const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    expect(f.creations()).toBe(mode === "failed" ? 2 : 0);
    expect(result.state.agents.player!.belief.claims).toEqual(boot.agents.player!.belief.claims);
    expect(Object.values(result.state.agents.player!.belief.evidence).some(value => value.kind === "testimony")).toBe(true);
    expect(readDecisionEventState(result.state.executionState!, result.state).failures.some(value => value.phase === "belief")).toBe(mode === "failed");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
});
