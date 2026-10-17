import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { projectAgentPerspective } from "../../src/engine/cognition/agent-perspective";
import { contentHash } from "../../src/engine/models/model-audit";
import { quantityId } from "../../src/engine/runtime/runtime-id";
import { replaySimulationState } from "../../src/engine/runtime/transaction";
import { directTestProvider, nativeAnswer } from "../../src/engine/testing/direct-provider";
import { parseWorldTemplate } from "../../src/script/world-loader";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";
import { assembleRegionalModules } from "./regional-composition";

const root = path.resolve("worlds/fanren/authoring");
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const regional = () => ({ module: read("regions/human-local/module.json"), claims: read("regions/human-local/claims.json"), review: read("regions/human-local/review.json") });
function compiled() {
  return assembleRegionalModules(read("modules/opening-sample.json"), read("claims/opening-sample.json"), [regional()]);
}
function archive(): Buffer {
  const template = parseWorldTemplate(compiled().module.template), zip = new AdmZip();
  const files: Array<[string, unknown]> = [["script.yaml", template.manifest], ["laws.yaml", template.laws],
    ["mechanics.yaml", template.mechanics], ["participation.yaml", template.participation],
    ...template.entities.map(entity => [`entities/${entity.id}.yaml`, entity] as [string, unknown])];
  for (const [file, contents] of files) zip.addFile(file, Buffer.from(stringify(contents)));
  return zip.toBuffer();
}

describe("Fanren human-local canonical opening", () => {
  it("pins every regional fact, separates original setup, and admits one disputed-title identity", () => {
    const input = regional(), assembled = compiled();
    expect(input.review.moduleHash).toBe(contentHash(input.module));
    expect(input.review.claimsHash).toBe(contentHash(input.claims));
    const entities = parseWorldTemplate(assembled.module.template).entities;
    const local = input.module.entities as typeof entities;
    for (const entity of local) {
      expect(input.module.provenance[`entity:${entity.id}`]?.length).toBeGreaterThan(0);
      for (const fact of entity.facts) expect(input.module.provenance[`fact:${fact.id}`]?.length).toBeGreaterThan(0);
      expect(entity.description).not.toMatch(/原著|原文|原创|标定|T0|第[一二三四五六七八九十]+章/);
      if (entity.agent) {
        expect(entity.agent.character.persona.summary).not.toMatch(/原著|原文|原创|标定|T0|韩立/);
        expect(entity.agent.belief.claims.some(claim => claim.predicate === "learned-skill")).toBe(true);
      }
    }
    expect(entities.filter(entity => entity.name === "王门主")).toHaveLength(1);
    expect(entities.some(entity => entity.id === "candidate-wang-juechu")).toBe(false);
    expect(entities.some(entity => /^(future-quhun|canon-quhun|small-green-bottle)$/.test(entity.id))).toBe(false);
    expect(local.find(entity => entity.id === "canon-wang-yang")?.agent).toBeDefined();
    expect(local.find(entity => entity.id === "canon-sun-enforcer")?.facts.find(fact => fact.predicate === "member-of")?.value)
      .toEqual({ kind: "entity", entityId: "wild-wolf-gang" });
    expect(input.claims.find((claim: { id: string }) => claim.id === "local-young-peer-baseline")?.classification).toBe("backprojection");
  });

  it.each(["han-li", "herbal-apprentice"])("imports %s with real households, resources, routes and isolated Mo/Yu cognition", async originId => {
    const fixture = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id, nativeAnswer(question, "none")])));
    await fixture.registry.capture();
    const directory = mkdtempSync(path.join(tmpdir(), "fanren-local-"));
    const database = new LocalDatabase(path.join(directory, "world.sqlite"), { heartbeat: false });
    try {
      const imported = database.importWorld(archive(), fixture.catalog);
      const host = new WorldHost({ repository: database, store: database, ledger: database, provider: fixture.gateway });
      const created = await host.createInstance({ worldId: imported.id, start: { kind: "origin", originId, displayName: originId === "han-li" ? "韩立" : "行路人", appearance: "", motivation: originId === "han-li" ? "" : "先过好眼前的生活。" } });
      const state = database.readInstance(created.summary.id).document.state;
      const actor = created.participants[0]!.agentId;
      const perspective = (id: string) => JSON.stringify(projectAgentPerspective(state, state.agents[id]!));
      const knows = (subject: string, target: string) => Object.values(state.agents[subject]!.bindings).some(binding => binding.canonicalEntityIds.includes(target));
      expect(Object.values(state.agents).filter(agent => agent.entityId === "canon-han-li")).toHaveLength(1);
      expect(knows("canon-mo-juren", "canon-han-li")).toBe(false);
      expect(knows("canon-yu-zitong", "canon-han-li")).toBe(false);
      expect(knows("canon-zhang-tie", "canon-han-li")).toBe(false);
      expect(knows("canon-qixuan-master", "canon-yu-zitong")).toBe(false);
      expect(perspective(actor)).not.toContain("血箭阴魂咒");
      expect(perspective(actor)).not.toContain("余子童");
      expect(perspective("canon-qixuan-master")).not.toContain("余子童");
      expect(knows("canon-mo-juren", "canon-yu-zitong")).toBe(true);
      expect(knows("canon-yu-zitong", "canon-mo-juren")).toBe(true);
      expect(state.truth.placements["canon-yu-zitong"]).toBe("canon-mo-juren");
      expect(state.truth.placements["canon-zhang-tie"]).toBe("zhang-tie-home");
      expect(state.truth.placements["canon-li-feiyu"]).toBe("local-li-feiyu-home");
      expect(state.truth.facts["canon-zhang-tie-child-of"]?.value).toEqual({ kind: "entity", entityId: "local-zhang-tie-mother" });
      expect(knows("canon-zhang-tie", "local-zhang-tie-mother")).toBe(true);
      expect(knows("local-zhang-tie-mother", "canon-zhang-tie")).toBe(true);
      expect(state.truth.facts["canon-wang-yang-family-betrothal"]?.value).toEqual({ kind: "entity", entityId: "local-betrothed-girl" });
      expect(state.truth.quantities[quantityId(state.worldHash, "silver", "qixuan-sect-funds")]?.amount).toBe(1800);
      expect(state.truth.quantities[quantityId(state.worldHash, "herb-packet", "mo-herbal-stock")]?.amount).toBe(60);
      const reached = new Set(["qingniu-town"]);
      for (let iteration = 0; iteration < 30; iteration++) {
        for (const fact of Object.values(state.truth.facts)) if (fact.predicate === "route-to" && fact.value.kind === "entity" && reached.has(fact.subjectId)) reached.add(fact.value.entityId);
      }
      for (const place of ["qixuan-main-hall", "divine-hand-valley", "zhang-tie-home", "local-li-feiyu-home", "wild-wolf-headquarters", "betrothed-family-home"]) expect(reached).toContain(place);
      expect(replaySimulationState(state)).toEqual(state);
      expect(fixture.transport).not.toHaveBeenCalled();
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
