import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import AdmZip from "adm-zip";
import { describe, expect, it, vi } from "vitest";
import { LocalDatabase } from "../src/server/local-database";
import { WorldHost } from "../src/server/world-host";
import { directTestProvider, nativeAnswer, directCreationContext } from "../src/engine/testing/direct-provider";
import { projectAgentPerspective } from "../src/engine/cognition/agent-perspective";
import { replaySimulationState } from "../src/engine/runtime/transaction";
import type { SimulationState } from "../src/engine/contracts/model";
import { parseModelCatalog } from "../src/engine/models/model-catalog";
import { ModelGateway } from "../src/engine/models/model-gateway";
import { createTestModelRegistry } from "../src/engine/testing/model-provider";

const base = path.resolve("worlds/cyberpunk2077");
interface Role { code: string; id: string; home: string; work: string; cash: number; contacts: string[]; assets: string[]; contracts: string[] }
const roles = JSON.parse(readFileSync(path.join(base, "authoring/playable-roles.json"), "utf8")) as Role[];
const quantity = (state: SimulationState, holder: string, definition = "eurodollar") =>
  Object.values(state.truth.quantities).find(item => item.holderId === holder && item.definitionId === definition)?.amount;
const archive = () => { const zip = new AdmZip(); zip.addLocalFolder(path.join(base, "world")); return zip.toBuffer(); };
function makeProvider(company = false) {
  const fixture = directTestProvider(wire => {
  const context = wire.state as { submittedAction?: unknown; perspective?: { agentId: string; interactions?: Array<{ relation: string; operation: string }> }; intent?: { wakeReasons: string[] } };
  const who = context.perspective?.agentId;
  const player = who === (company ? "lead" : "heir") && !!context.submittedAction;
  const initial = context.intent?.wakeReasons.includes("initial-decision");
  const paid = context.perspective?.interactions?.some(item => item.relation === "self" && item.operation === "transfer");
  const account = company && who === "lead-budget" && !initial && !paid;
  const recipient = company ? player ? "known-lead-budget" : "known-ada" : "known-marco";
  const choices: Record<string, string> = { operation: player ? company ? "speak" : "transfer" : account ? "transfer" : "wait", target: recipient, recipient,
    resource: "eurodollar", amount: company ? "n6000" : "n800", timing: "default", speech: company && player ? "input" : "none",
    transfer_authority: company && player ? "request" : "give", transfer_execution: company && player ? "expression" : "transfer", interaction: "world_action" };
  return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
    let value = choices[id] ?? (id.includes("outcome") ? "succeeded" : id.includes("goal_status") || id.includes("belief_status") || id.includes("fact") ? "unchanged"
      : id.includes("visible") || /_entity\d+$/u.test(id) ? "visible" : id.includes("delivery") ? "delivered" : "none");
    if (id.startsWith("resource_amount_")) value = company ? "n6000" : "n800";
    if (id.endsWith("_request_progress") || id.startsWith("progress_")) value = "complete";
    if (id.endsWith("_expression")) value = "no_change";
    if (id.endsWith("_duration")) value = "s30";
    if (id.startsWith("paragraph")) value = "grounded";
    return [id, nativeAnswer(question, id === "expression" ? 0 : value)];
  }));
}, wire => {
  const context = directCreationContext(wire);
  if (context.scene) return { paragraphs: ["你处理了眼前的付款，其他人仍在会客室。"] };
  return company ? { attempt: "请求办理项目采购付款", utterance: "请项目账户向艾达实际支付 6000 欧元的首批控制器货款。", manner: null }
    : { attempt: "把 800 欧元维修款交给马尔科", utterance: null, manner: null };
  });
  const source = fixture.catalog.snapshot();
  source.profiles["decision-deepseek-long"] = { ...source.profiles["decision-deepseek"]!, max_output_tokens: 32768 };
  const catalog = parseModelCatalog(source), registry = createTestModelRegistry(catalog);
  return { ...fixture, catalog, registry, gateway: new ModelGateway(catalog,
    { TYPESAFE_API_KEY: "test-private-key", TEST_MODEL_API_KEY: "test-private-key" },
    { registry, fetch: fixture.transport, maxTransportAttempts: 1 }) };
}

describe("Cyberpunk 2077 authored world through import and persistent play", () => {
  it("keeps generated runtime and role documentation reproducible", () => {
    const report = JSON.parse(execFileSync(process.execPath, [path.join(base, "authoring/build.mjs"), "--check"], { encoding: "utf8" }));
    expect(report.counts).toMatchObject({ people: 101, agents: 107, automatedServices: 6, playableRoles: 12, organizations: 22 });
    expect(report.narrativeExpansion).toBe(false);
  });

  it("admits all twelve existing identities with their assets, reciprocal contacts, contracts and saved cognition", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "night-city-origins-")), filename = path.join(root, "world.sqlite");
    const provider = makeProvider(); await provider.registry.capture();
    let database = new LocalDatabase(filename, { heartbeat: false });
    const saved = new Map<string, { role: Role; state: SimulationState }>();
    try {
      const imported = database.importWorld(archive(), provider.catalog);
      expect(imported.id).toBe("cyberpunk2077-night-city");
      const host = new WorldHost({ repository: database, store: database, ledger: database, provider: provider.gateway });
      for (const role of roles) {
        const created = await host.createInstance({ worldId: imported.id, start: { kind: "observer" } });
        const id = created.summary.id, before = database.readInstance(id).document.state;
        const takeover = await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: role.id } });
        expect(takeover.conversation?.participantId).toBeTruthy();
        const document = database.readInstance(id).document, state = document.state;
        expect(state.truth).toEqual(before.truth);
        expect(state.agents[role.id]).toEqual(before.agents[role.id]);
        expect(Object.values(state.agents)).toHaveLength(107);
        expect(quantity(state, role.id)).toBe(role.cash);
        expect(state.truth.placements[role.id]).toBe(role.work);
        expect(state.truth.entities[role.home]).toBeDefined();
        expect(document.policyBindings[role.id]?.kind).toBe("external");
        expect(Object.values(document.policyBindings).filter(policy => policy.kind === "model")).toHaveLength(106);
        for (const contact of role.contacts) {
          expect(Object.values(state.agents[role.id]!.bindings).some(binding => binding.canonicalEntityIds.includes(contact))).toBe(true);
          expect(Object.values(state.agents[contact]!.bindings).some(binding => binding.canonicalEntityIds.includes(role.id))).toBe(true);
          expect(state.truth.placements[contact]).toBe(role.work);
        }
        const view = JSON.stringify(projectAgentPerspective(state, state.agents[role.id]!));
        for (const entity of [...role.assets, ...role.contracts]) {
          expect(state.truth.entities[entity]).toBeDefined();
          expect(Object.values(state.agents[role.id]!.bindings).some(binding => binding.canonicalEntityIds.includes(entity))).toBe(true);
          expect(view).toContain(state.truth.entities[entity]!.name);
        }
        saved.set(id, { role, state });
      }
      expect(provider.transport).not.toHaveBeenCalled();
      database.close(); database = new LocalDatabase(filename, { heartbeat: false });
      const restored = new WorldHost({ repository: database, store: database, ledger: database, provider: provider.gateway });
      for (const [id, { role, state }] of saved) {
        expect(restored.instance(id).conversation?.participantId).toBeTruthy();
        expect(database.readInstance(id).document.state).toEqual(state);
        expect(database.readInstance(id).document.policyBindings[role.id]?.kind).toBe("external");
      }
      const state = saved.values().next().value!.state;
      expect(quantity(state, "lead-budget")).toBe(48000); expect(quantity(state, "lead")).toBe(9000);
      expect(quantity(state, "manager-fund")).toBe(6800); expect(quantity(state, "manager")).toBe(4800);
      expect(Object.values(state.truth.facts).find(fact => fact.subjectId === "heir-repair-quote" && fact.predicate === "paid")?.value).toEqual({ kind: "boolean", value: false });
      expect(["fleet-flatbed", "fleet-boxtruck", "fleet-reefer"].map(id => state.truth.entities[id]?.kind)).toEqual(["vehicle", "vehicle", "vehicle"]);
      for (const actor of ["v", "jackie", "saburo", "takemura", "t-bug", "evelyn"]) expect(state.truth.entities[actor]?.lifecycle).toBe("active");
      expect(state.truth.placements["johnny-engram"]).toBe("relic");
      expect(state.agents["johnny-engram"]).toBeUndefined();
      expect(Object.values(state.agents.v!.bindings).some(binding => binding.canonicalEntityIds.includes("relic"))).toBe(false);
      expect(Object.values(state.agents.heir!.bindings).some(binding => binding.canonicalEntityIds.includes("johnny-engram"))).toBe(false);
      expect(JSON.stringify(projectAgentPerspective(state, state.agents.heir!))).not.toMatch(/FIA|供电板接点间歇失效|restricted-knowledge/);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  }, 60000);

  it.each([false, true])("commits an actual payment from the correct personal or company holder and restores it (company=%s)", async company => {
    const root = mkdtempSync(path.join(tmpdir(), "night-city-payment-")), filename = path.join(root, "world.sqlite");
    const provider = makeProvider(company); await provider.registry.capture();
    let database = new LocalDatabase(filename, { heartbeat: false });
    try {
      const imported = database.importWorld(archive(), provider.catalog);
      const host = new WorldHost({ repository: database, store: database, ledger: database, provider: provider.gateway });
      const created = await host.createInstance({ worldId: imported.id, start: { kind: "observer" } }), id = created.summary.id;
      const taken = await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: company ? "lead" : "heir" } });
      const before = database.readInstance(id).document.state;
      await host.submitAction(id, taken.conversation!.participantId, { expectedRevision: 0, submissionId: "pay-repair", text: company
        ? "我对项目账户的语音终端说：请向艾达实际支付 6000 欧元的首批控制器货款。" : "把 800 欧元实际转给马尔科作为管道维修款。" });
      await vi.waitFor(() => {
        const document = database.readInstance(id).document;
        const run = Object.values(document.runs).find(value => value.rootIntents.some(intent => intent.submissionId === "pay-repair"));
        expect(run?.status, JSON.stringify(run)).toBe("completed");
        expect(quantity(document.state, company ? "lead-budget" : "heir")).toBe(company ? 42000 : 17200);
      }, { timeout: 30000, interval: 25 });
      await host.drainNarratives(id);
      const state = database.readInstance(id).document.state;
      if (company) {
        expect(quantity(state, "lead-budget")).toBe(42000); expect(quantity(state, "ada")).toBe(7200);
        expect(quantity(state, "lead")).toBe(9000);
      } else {
        expect(quantity(state, "heir")).toBe(17200); expect(quantity(state, "marco")).toBe(2000);
      }
      expect(quantity(state, "heir-fund")).toBe(quantity(before, "heir-fund"));
      const total = (value: SimulationState) => Object.values(value.truth.quantities).filter(q => q.definitionId === "eurodollar").reduce((n, q) => n + q.amount, 0);
      expect(total(state)).toBe(total(before));
      expect(state.truth.elapsedSeconds).toBeGreaterThan(0);
      expect(replaySimulationState(state)).toEqual(state);
      database.close(); database = new LocalDatabase(filename, { heartbeat: false });
      expect(database.readInstance(id).document.state.truth).toEqual(state.truth);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  }, 40000);
});
