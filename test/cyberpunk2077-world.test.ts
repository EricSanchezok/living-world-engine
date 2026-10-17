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
import { readDirectState } from "../src/engine/direct/state";

const base = path.resolve("worlds/cyberpunk2077");
interface Role { code: string; id: string; home: string; work: string; cash: number; contacts: string[]; assets: string[]; contracts: string[] }
const roles = JSON.parse(readFileSync(path.join(base, "authoring/playable-roles.json"), "utf8")) as Role[];
const coverage = JSON.parse(readFileSync(path.join(base, "authoring/coverage.json"), "utf8")) as { counts: { agents: number; automatedServices: number; people: number } };
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
    expect(report.counts).toMatchObject({ playableRoles: 12 });
    expect(report.counts.agents).toBe(report.counts.people + report.counts.automatedServices);
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
        expect(Object.values(state.agents)).toHaveLength(coverage.counts.agents);
        expect(readDirectState(state.executionState!, state).models.decision).toBe("decision-deepseek-long");
        expect(state.agents[role.id]!.modelProfiles.decision).toBe("decision-jev");
        expect(quantity(state, role.id)).toBe(role.cash);
        expect(state.truth.placements[role.id]).toBe(role.work);
        expect(state.truth.entities[role.home]).toBeDefined();
        expect(document.policyBindings[role.id]?.kind).toBe("external");
        expect(Object.values(document.policyBindings).filter(policy => policy.kind === "model")).toHaveLength(coverage.counts.agents - 1);
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
      expect(JSON.stringify(projectAgentPerspective(state, state.agents.operator!))).not.toContain("备用供电板接点间歇失效");
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  }, 60000);

  it("imports distinct production stocks, funded commissions and blank work records without inventing results", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "night-city-work-products-"));
    const provider = makeProvider(); await provider.registry.capture();
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const encoded = execFileSync(process.execPath, ["--input-type=module", "-e",
        "import { renderWorld, worldArchive } from './worlds/cyberpunk2077/authoring/build.mjs'; process.stdout.write(worldArchive(renderWorld().files).toString('base64'));"], { encoding: "utf8" });
      const imported = database.importWorld(Buffer.from(encoded, "base64"), provider.catalog);
      const host = new WorldHost({ repository: database, store: database, ledger: database, provider: provider.gateway });
      const created = await host.createInstance({ worldId: imported.id, start: { kind: "observer" } });
      const state = database.readInstance(created.summary.id).document.state;
      const fact = (subjectId: string, predicate: string) => Object.values(state.truth.facts).find(value => value.subjectId === subjectId && value.predicate === predicate);
      expect(state.truth.placements.reed).toBe("electric-orgasm");
      expect(state.truth.placements["dino-office"]).toBe("electric-orgasm");
      expect(JSON.stringify(projectAgentPerspective(state, state.agents.dino!))).not.toMatch(/FIA|所罗门|李德/);
      const alexView = JSON.stringify(projectAgentPerspective(state, state.agents.alex!));
      expect(alexView).toContain("李德当年已经死亡");
      expect(alexView).not.toContain("survived-cover-death");
      for (const actor of ["rogue", "kerry"]) {
        expect(state.agents[actor]!.belief.localEntities["remembered-johnny"]?.name).toBe("记忆中的强尼");
        expect(state.agents[actor]!.bindings["remembered-johnny"]?.canonicalEntityIds).toEqual([]);
      }
      expect(state.truth.placements["heir-service-pipe"]).toBe("heir-utility-room");
      expect(state.truth.placements["heir-plumbing-tools"]).toBe("heir-utility-room");
      expect(fact("heir-service-pipe", "leaking")?.value).toEqual({ kind: "boolean", value: true });
      expect(fact("heir-service-pipe", "supply-isolated")?.value).toEqual({ kind: "boolean", value: false });
      expect(fact("heir-service-pipe", "pressure-tested")?.value).toEqual({ kind: "boolean", value: false });
      expect(quantity(state, "heir", "components")).toBe(2);
      expect(fact("heir", "storage-components")?.value).toEqual({ kind: "entity", entityId: "heir-seal-stock" });
      expect(JSON.stringify(projectAgentPerspective(state, state.agents.heir!))).not.toContain("活接内部的兼容密封垫老化");
      expect(quantity(state, "partner", "industrial-blank")).toBe(36);
      expect(quantity(state, "partner", "trial-housing")).toBe(0);
      expect(quantity(state, "partner", "components")).toBeUndefined();
      expect(quantity(state, "partner-stock", "industrial-blank")).toBeUndefined();
      expect(fact("partner", "storage-industrial-blank")?.value).toEqual({ kind: "entity", entityId: "partner-stock" });
      expect(fact("partner", "storage-trial-housing")?.value).toEqual({ kind: "entity", entityId: "partner-output" });
      expect(fact("partner-output", "customer-accepted")?.value).toEqual({ kind: "boolean", value: false });
      expect(fact("partner-line", "safe-full-rate")?.value).toEqual({ kind: "boolean", value: false });
      expect(quantity(state, "owen", "trial-housing")).toBe(0);
      expect(fact("partner-customer-stock", "owner")?.value).toEqual({ kind: "entity", entityId: "grille-equipment" });
      expect(quantity(state, "ada", "control-unit")).toBe(6);
      expect(quantity(state, "lead", "control-unit")).toBe(0);
      expect(fact("ada", "storage-control-unit")?.value).toEqual({ kind: "entity", entityId: "lead-controllers" });
      expect(fact("lead-controllers", "owner")?.value).toEqual({ kind: "entity", entityId: "ada" });
      expect(fact("lead", "storage-control-unit")?.value).toEqual({ kind: "entity", entityId: "lead-received-stock" });
      expect(fact("lead-received-stock", "owner")?.value).toEqual({ kind: "entity", entityId: "crownbridge-services" });
      expect(fact("lead-budget", "owner")?.value).toEqual({ kind: "entity", entityId: "crownbridge-services" });
      expect(fact("lead-received-stock", "received-for-project")?.value).toEqual({ kind: "boolean", value: false });
      for (const [account, representative, balance, payee] of [
        ["editor-settlement", "celia", 4800, "editor"],
        ["fleet-client-settlement", "mei", 8000, "fleet-reserve"],
        ["manager-venue-settlement", "paulo", 10000, "manager-fund"],
        ["partner-customer-settlement", "owen", 2400, "partner-wages"],
        ["operator-community-fund", "pump-commissioner", 1800, "operator"],
        ["broker-customer-settlement", "jun", 8000, "broker-supplier"],
      ] as const) {
        expect(quantity(state, account)).toBe(balance);
        expect(quantity(state, representative)).toBe(1200);
        expect(fact(account, "automated-service")?.value).toEqual({ kind: "boolean", value: true });
        expect(Object.values(state.agents[account]!.bindings).some(binding => binding.canonicalEntityIds.includes(payee))).toBe(true);
      }
      const records = [
        ["heir", "heir-maintenance-log"], ["lead", "lead-delivery-record"], ["editor", "editor-edit-log"],
        ["apprentice", "apprentice-clinical-record"], ["fleet", "fleet-maintenance-log"], ["medic", "medic-care-log"],
        ["fleet", "fleet-delivery-log"], ["manager", "manager-show-log"],
        ["armorer", "armorer-test-log"], ["partner", "partner-batch-log"], ["broker", "broker-discrepancy-log"],
        ["manager", "manager-test-report"], ["reporter", "reporter-notebook"], ["operator", "operator-diagnostic-log"],
      ];
      for (const [owner, record] of records) {
        expect(state.truth.entities[record!]!.kind).toBe("data-file");
        expect(fact(record!, "record-state")?.value).toEqual({ kind: "text", value: "blank" });
        expect(fact(record!, "entries")?.access.kind).toBe("agents");
        expect(fact(record!, "authorized-writer")?.value).toEqual({ kind: "entity", entityId: owner });
        expect(Object.values(state.agents[owner!]!.bindings).some(binding => binding.canonicalEntityIds.includes(record!))).toBe(true);
      }
      expect(fact("reporter-notebook", "entries")?.access).toEqual({ kind: "agents", agentIds: ["reporter", "leila", "amara"] });
      expect(fact("apprentice-clinical-record", "entries")?.access).toEqual({ kind: "agents", agentIds: ["apprentice", "lin", "ana"] });
      expect(JSON.stringify(projectAgentPerspective(state, state.agents.heir!))).not.toContain("事故调查内部核验笔记");
      expect(JSON.stringify(projectAgentPerspective(state, state.agents.bo!))).not.toContain("安娜接口维护记录");
      expect(state.truth.entities["fleet-tools"]).toBeDefined();
      expect(quantity(state, "fleet", "cargo-unit")).toBe(4);
      expect(quantity(state, "fleet", "industrial-freight-unit")).toBe(6);
      expect(quantity(state, "freight-receiver", "cargo-unit")).toBe(0);
      expect(quantity(state, "freight-receiver", "industrial-freight-unit")).toBe(0);
      expect(state.truth.placements["freight-receiver"]).toBe("fleet-destination");
      expect(fact("fleet-cargo", "delivery-destination")?.value).toEqual({ kind: "entity", entityId: "fleet-destination" });
      expect(fact("fleet-regular-cargo", "delivery-accepted")?.value).toEqual({ kind: "boolean", value: false });
      expect(fact("armorer-crate", "owner")?.value).toEqual({ kind: "entity", entityId: "rancho-community-watch" });
      expect(fact("armorer-crate", "owner")?.access).toEqual({ kind: "agents", agentIds: ["watch-registrar"] });
      expect(fact("armorer-crate", "custodian")?.value).toEqual({ kind: "entity", entityId: "grant" });
      expect(quantity(state, "grant", "watch-gear-unit")).toBe(3);
      expect(quantity(state, "watch-registrar", "watch-gear-unit")).toBe(0);
      expect(JSON.stringify(projectAgentPerspective(state, state.agents.armorer!))).not.toContain("GC-14、GC-15、GC-16归社区守望队");
      expect(quantity(state, "raul", "cooling-valve")).toBe(1);
      expect(quantity(state, "nela", "interlock-sensor")).toBe(1);
      expect(quantity(state, "broker", "control-cargo-unit")).toBe(4);
      expect(quantity(state, "broker", "cargo-unit")).toBeUndefined();
      expect(quantity(state, "freight-receiver", "control-cargo-unit")).toBe(0);
      expect(fact("broker-batch", "consignor")?.value).toEqual({ kind: "entity", entityId: "broker-supplier" });
      expect(state.truth.placements["manager-stage"]).toBe("manager-venue");
      expect(state.truth.placements["venue-listener"]).toBe("manager-venue");
      expect(fact("manager-show", "performance-completed")?.value).toEqual({ kind: "boolean", value: false });
      expect(fact("manager-show", "settled")?.value).toEqual({ kind: "boolean", value: false });
      expect(fact("operator-pump", "owner")?.value).toEqual({ kind: "entity", entityId: "northside-water-coop" });
      expect(state.truth.placements["pump-commissioner"]).toBe("operator-work");
      expect(state.truth.placements["accident-witness"]).toBe("reporter-accident-site");
      expect(fact("reporter-draft", "editor-approved")?.value).toEqual({ kind: "boolean", value: false });
      expect(fact("reporter-publication-slot", "published")?.value).toEqual({ kind: "boolean", value: false });
      expect(fact("reporter-publication-slot", "published-copy")?.access.kind).toBe("public");
      expect(fact("reporter-draft", "body")?.access.kind).toBe("agents");
      expect(Object.values(state.truth.facts).filter(value => value.predicate === "signed").every(value => value.value.kind === "boolean" && !value.value.value)).toBe(true);
      expect(provider.transport).not.toHaveBeenCalled();
      expect(replaySimulationState(state)).toEqual(state);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30000);

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
