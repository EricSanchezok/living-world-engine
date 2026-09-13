import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import type { UnreviewedTruthResolution } from "../../algorithms/roles";
import type { WorldDeltaOperation } from "../../contracts/model";
import { contentHash } from "../../models/model-audit";
import type { InteractionDependency } from "../../runtime/execution";
import { DeterministicModelProvider } from "../../testing/model-provider";
import { resolutionExceedsDeclaredDependencies, resolvedComponentsConflict } from "../action-dependency";
import type { ConditionState } from "../resolution";

function fixture() {
  const provider = new DeterministicModelProvider();
  const state = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
    seed: 47, modelCatalog: provider.catalog,
  }).initialState;
  const condition = (id: string, subjectId = "player"): ConditionState => ({
    id, subjectId, label: "Ready", description: "The subject is ready.", magnitude: "minor",
    durationProfileId: "brief", conditionProfileId: null, stackingKey: null,
    remainingUses: null, expiresAtElapsedSeconds: 10, access: { kind: "public" },
    provenance: [{ kind: "law", id: "time-passes" }],
  });
  state.truth.conditions.existing = condition("existing");
  const set = (id: string, subjectId = "player"): WorldDeltaOperation => ({
    kind: "set_condition", condition: condition(id, subjectId), causes: [{ kind: "law", id: "time-passes" }], assertions: [],
  });
  const resolution = (operations: WorldDeltaOperation[]): UnreviewedTruthResolution => ({
    proposal: { baseRevision: state.revision, operations, outcomes: [], events: [],
      observations: [], decisionRequests: [], mechanicInvocations: [] },
    initialActions: [], actions: [], reactionRequests: [], reactionDecisions: [],
    stimulusObservations: [], requests: [], checks: [], randomRequests: [], randomResults: [],
    commitmentRounds: [], resolutionPlans: [], resolutionReceipts: [], rng: structuredClone(state.truth.rng),
    mechanicResults: [], causalAssertionResults: [], modelAudits: [], reactionModelAudits: [],
  });
  return { state, set, resolution };
}

function dependency(reads: InteractionDependency["reads"], writes: InteractionDependency["writes"]): InteractionDependency {
  return { kind: "action", id: "action", actorId: "player", reads, writes, audienceAgentIds: [],
    sharedResourceClaims: [], globalFallback: false };
}

describe("fresh condition dependency coverage", () => {
  it("covers new identity allocation under its declared subject without altering evidence or RNG", () => {
    const { state, set, resolution } = fixture();
    const result = resolution([set("new")]);
    const deps = [dependency([], [{ kind: "entity", id: "player" }])];
    const before = contentHash({ state, result, deps });
    expect(resolutionExceedsDeclaredDependencies(state, result, deps)).toBe(false);
    expect(contentHash({ state, result, deps })).toBe(before);
  });

  it.each([
    dependency([{ kind: "entity", id: "player" }], []),
    dependency([{ kind: "entity", id: "player" }], [{ kind: "entity", id: "keeper" }]),
    dependency([{ kind: "entity", id: "player" }], [{ kind: "placement", id: "player" }]),
    dependency([{ kind: "entity", id: "player" }], [{ kind: "condition", id: "new" }]),
  ])("requires the actual existing subject's entity write: %#", (deps) => {
    const { state, set, resolution } = fixture();
    expect(resolutionExceedsDeclaredDependencies(state, resolution([set("new")]), [deps])).toBe(true);
  });

  it("does not authorize an unknown subject or an overwrite through the fresh-record rule", () => {
    const { state, set, resolution } = fixture();
    expect(resolutionExceedsDeclaredDependencies(state, resolution([set("new", "unknown")]), [
      dependency([], [{ kind: "entity", id: "unknown" }]),
    ])).toBe(true);
    expect(resolutionExceedsDeclaredDependencies(state, resolution([set("existing")]), [
      dependency([], [{ kind: "entity", id: "player" }]),
    ])).toBe(true);
    expect(resolutionExceedsDeclaredDependencies(state, resolution([set("existing")]), [
      dependency([{ kind: "entity", id: "player" }], [{ kind: "condition", id: "existing" }]),
    ])).toBe(false);
  });

  it("validates every creation even when repeated operations reuse one fresh ID", () => {
    const { state, set, resolution } = fixture();
    expect(resolutionExceedsDeclaredDependencies(state, resolution([set("new"), set("new", "keeper")]), [
      dependency([{ kind: "entity", id: "keeper" }], [{ kind: "entity", id: "player" }]),
    ])).toBe(true);
  });
});

describe("condition creation scope conflicts", () => {
  it("allows independent subjects but detects duplicate new IDs even across subjects", () => {
    const { state, set, resolution } = fixture();
    const left = resolution([set("left")]);
    const deps = [dependency([], [{ kind: "entity", id: "player" }])];
    const rightDeps = [dependency([], [{ kind: "entity", id: "keeper" }])];
    expect(resolvedComponentsConflict(state, left, resolution([set("right", "keeper")]), deps, rightDeps)).toBe(false);
    expect(resolvedComponentsConflict(state, left, resolution([set("left", "keeper")]), deps, rightDeps)).toBe(true);
    expect(resolvedComponentsConflict(state, left, resolution([set("right")]), deps, deps)).toBe(true);
  });

  it.each([
    dependency([{ kind: "entity", id: "player" }], []),
    dependency([{ kind: "placement", id: "player" }], []),
    dependency([{ kind: "condition", id: "existing" }], []),
    dependency([], [{ kind: "condition", id: "existing" }]),
    { ...dependency([], []), globalFallback: true },
  ])("detects a conflicting declared scope even with no physical delta: %#", (reader) => {
    const { state, set, resolution } = fixture();
    const create = resolution([set("new")]);
    const observe = resolution([]);
    const deps = [dependency([], [{ kind: "entity", id: "player" }])];
    expect(resolvedComponentsConflict(state, create, observe, deps, [reader])).toBe(true);
    expect(resolvedComponentsConflict(state, observe, create, [reader], deps)).toBe(true);
  });

  it("checks actual old and new condition subjects and undeclared entity accesses", () => {
    const { state, set, resolution } = fixture();
    const create = resolution([set("new")]);
    const operations: WorldDeltaOperation[] = [
      set("existing", "keeper"),
      { kind: "remove_condition", conditionId: "existing", causes: [{ kind: "law", id: "time-passes" }], assertions: [] },
      { kind: "retire_entity", entityId: "player", causes: [{ kind: "law", id: "time-passes" }], assertions: [] },
    ];
    for (const operation of operations) {
      expect(resolvedComponentsConflict(state, create, resolution([operation]), [], [])).toBe(true);
    }
    expect(resolvedComponentsConflict(state, create, resolution([]), [], [
      dependency([{ kind: "entity", id: "keeper" }], []),
    ])).toBe(false);
  });
});
