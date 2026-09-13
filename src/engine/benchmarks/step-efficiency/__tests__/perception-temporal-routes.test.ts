import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { contentHash } from "../../../models/model-audit";
import { createModelGateway } from "../../../models/model-gateway";
import type { StructuredModelRequest } from "../../../models/model-provider";
import { ScriptedModelProvider, createTestModelRegistry } from "../../../testing/model-provider";
import { perceptionTemporalRoutesRequest } from "../perception-temporal-routes";
import { buildPerceptionSourceIndex } from "../perception-source-index";

it.each(["direct_current", "current_channel", "awaiting_transfer", "no_current_stimulus", "invalid_pending", "check_continuation", "failed_check"])(
  "preserves canonical perception through real gateway and TruthEngine (%s)", async mode => {
    const provider = new ScriptedModelProvider(() => { throw Error("Use the actual gateway"); });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
    definition.laws.push({ id: "live-voice", text: "The keeper's listening mirror continuously relays the player's audible speech to the keeper, without a messenger or later return.", severity: "hard" });
    const state = structuredClone(definition.initialState);
    const input = { definition, state, identityOwner: "temporal-routes", groundings: [],
      actions: [{ id: "speak", actorId: "player", baseRevision: state.revision,
        rawText: mode.includes("pending") || mode === "awaiting_transfer" ? "Ask a witness to tell the keeper later." : "Greet the keeper aloud.",
        goal: "Communicate", means: null, targetIds: [] }],
      perceptionTargets: [{ observerId: "keeper", sourceActionId: "speak" }],
      temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
    const before = contentHash(input), originalRequests: StructuredModelRequest<unknown>[] = [], adaptedRequests: StructuredModelRequest<unknown>[] = [];
    const physical: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const stimulus = { summary: "An audible greeting reaches you.", introductions: [], apparentClaims: [], sourceEventRefs: [] };
    const base = { targetIndex: 0, reason: "The selected temporal case describes the present information boundary.",
      evidence: [{ kind: "entity", ref: "ref:entity:player" }], checkRefs: [] as string[] };
    let calls = 0;
    const gateway = createModelGateway(provider.catalog, { TEST_MODEL_API_KEY: "test-only" }, {
      registry: createTestModelRegistry(provider.catalog), maxTransportAttempts: 1,
      fetchForAccount: () => async (_url, init) => {
        physical.push(JSON.parse(String(init?.body))); calls++;
        const current = originalRequests.at(-1)!.context as { state: { committedCheckRequests: Array<{ checkRef: string }> } };
        const reportBase = { ...base, checkRefs: current.state.committedCheckRequests.map(check => check.checkRef) };
        let output: unknown;
        if ((mode === "check_continuation" || mode === "failed_check") && calls === 1) {
          output = { kind: "request_checks", requests: [{ proposalKey: "notice", actorRef: "ref:entity:keeper", targetRef: "ref:entity:player", ratingRef: null,
            difficulty: { kind: "environment", band: mode === "failed_check" ? "extreme" : "trivial", source: { kind: "law", ref: "ref:law:time-passes" } },
            mode: "normal", stakes: "Notice the greeting through the ambient noise", visibility: "full",
            causes: [{ kind: "action", ref: "ref:action:speak" }, { kind: "law", ref: "ref:law:time-passes" }] }] };
        } else {
          const report = mode === "current_channel" ? { ...reportBase, route: mode, channelDescription: "The live mirror carries the voice now.",
            evidence: [...base.evidence, { kind: "law", ref: "ref:law:live-voice" }], channelBasis: [{ kind: "law", ref: "ref:law:live-voice" }], stimulus }
            : mode === "awaiting_transfer" || mode === "invalid_pending" ? { ...reportBase, route: "awaiting_transfer", firstReceiver: "An unnamed witness",
              requiredTransfer: "The witness must later find and tell the keeper.", ...(mode === "invalid_pending" && calls === 1 ? { stimulus } : {}) }
            : mode === "no_current_stimulus" ? { ...reportBase, route: mode }
            : { ...reportBase, route: "direct_current", presentCue: "The keeper hears the greeting now.", stimulus };
          output = { kind: "done", reports: [report] };
        }
        return new Response(JSON.stringify({ id: `route-${calls}`, model: "scripted:truth-deepseek",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { headers: { "content-type": "application/json" } });
      },
    });
    provider.generateStructured = request => {
      originalRequests.push(request);
      const adapted = perceptionTemporalRoutesRequest(request); adaptedRequests.push(adapted);
      const context = structuredClone(adapted.context) as Record<string, unknown>;
      context.roleContract = (request.context as Record<string, unknown>).roleContract;
      expect(context).toEqual(request.context);
      expect(adapted.schema).toBe(request.schema);
      expect(adapted.jsonObjectPostlude).toContain(JSON.stringify(buildPerceptionSourceIndex(request.context)));
      return gateway.generateStructured(adapted);
    };
    const run = new TruthEngine(provider, { repairAttempts: mode === "invalid_pending" ? 1 : 0 }).perceiveOnset(input,
      { workloadId: "route-world", batchId: "onset", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
    if (mode === "failed_check") {
      await expect(run).rejects.toThrow();
      expect(calls).toBe(2);
      expect(contentHash(input)).toBe(before);
      return;
    }
    const result = await run;
    const perceived = ["direct_current", "current_channel", "check_continuation"].includes(mode);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]!.kind).toBe(perceived ? "perceived" : "no_stimulus");
    if (result.receipts[0]!.kind === "perceived") expect(result.receipts[0]!.stimulus.summary).toBe(stimulus.summary);
    else expect(result.receipts[0]).not.toHaveProperty("stimulus");
    expect(result.receipts[0]!.reason).toBe(base.reason);
    expect(result.modelAudit.invocations).toHaveLength(mode === "invalid_pending" || mode === "check_continuation" ? 2 : 1);
    expect(result.rng.draws).toBe(state.truth.rng.draws + (mode === "check_continuation" ? 1 : 0));
    if (mode === "check_continuation") {
      expect(result.checks[0]!.succeeded).toBe(true);
      expect(result.receipts[0]!.checkIds).toEqual(result.requests.map(check => check.id));
    }
    if (mode === "invalid_pending") {
      const repair = (originalRequests[1]!.context as { repair: { issues: Array<{ path: unknown[] }> } }).repair;
      expect(repair.issues.length).toBeGreaterThan(0);
      expect(physical[1]!.messages.find(message => message.role === "user")!.content).toContain("stimulus");
    }
    for (const body of physical) expect(body.messages.find(message => message.role === "user")!.content).not.toContain("Example JSON output shape:");
    expect(contentHash(input)).toBe(before);

    const request = adaptedRequests[0]!;
    const pending = { ...base, route: "awaiting_transfer", firstReceiver: "A witness", requiredTransfer: "A later retelling" };
    for (const reports of [[{ ...pending, stimulus }], [], [pending, pending], [{ ...pending, targetIndex: 99 }]]) {
      expect(() => request.preprocessOutput!({ kind: "done", reports })).toThrow();
    }
    const channel = { ...base, route: "current_channel", channelDescription: "The live mirror", channelBasis: [{ kind: "law", ref: "ref:law:live-voice" }], stimulus };
    expect(() => request.preprocessOutput!({ kind: "done", reports: [channel] })).toThrow("report evidence");
    expect(() => request.preprocessOutput!({ kind: "done", reports: [{ ...channel, evidence: [{ kind: "law", ref: "ref:law:invented" }], channelBasis: [{ kind: "law", ref: "ref:law:invented" }] }] })).toThrow("report evidence");
    expect(() => perceptionTemporalRoutesRequest(request)).toThrow("unadapted");
    (request.context as Record<string, unknown>).repair = { changed: true };
    expect(() => request.preprocessOutput!({ kind: "done", reports: [pending] })).toThrow("source changed");
  },
);
