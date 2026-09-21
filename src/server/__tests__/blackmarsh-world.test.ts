import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { DeterministicModelProvider } from "../../engine/testing/model-provider";
import { loadModelCatalog } from "../../engine/models/model-catalog";
import { EagerReferenceAlgorithm } from "../../engine/algorithms/eager-reference/eager-reference";
import { SimulationEngine } from "../../engine/runtime/simulation";
import { loadWorldScript } from "../../script/world-loader";
import { parseWorldArchive } from "../world-import";

const worldRoot = path.resolve("worlds/blackmarsh/world");
const blackmarshModelCatalog = loadModelCatalog();

const agentIds = [
  "player",
  "archon-devers",
  "autarch-elana",
  "azure-king",
  "bedewald-atheling",
  "canon-brannoc",
  "chief-bjarni",
  "chief-kalfvald",
  "chief-yngvar",
  "curator-iseult-vale",
  "duke-caedwine",
  "ealdorman-paddock-ryburn",
  "egil-longhair",
  "gmung",
  "governor-tyrilas",
  "hamdir",
  "high-captain-sinerian",
  "high-chief-cruk",
  "john-abrams",
  "king-graptar",
  "king-neptar",
  "king-nilal",
  "king-ragnar",
  "king-suduk",
  "kinkaris",
  "kostbera",
  "lady-aerindel",
  "lord-ingwold",
  "lord-maracan",
  "lord-mazardan",
  "lord-octa",
  "lord-travvarn",
  "lord-varxis",
  "master-corvin-hale",
  "matthew-thanes",
  "mayor-holbein-redleaf",
  "naomi",
  "neera-dane",
  "rinisar-anothil",
  "sapphire-enchantress",
  "scytheback",
  "sheriff-barris-ironoak",
  "sigrun-the-boneless",
  "sir-autse-darkheart",
  "sir-causari",
  "sir-dennis-langre",
  "thil-the-cowled",
  "wizard-of-the-isle",
] as const;

const hexCoordinates = [
  "0105", "0107", "0211", "0214", "0217", "0302", "0309", "0318", "0407", "0409",
  "0413", "0415", "0515", "0605", "0608", "0610", "0616", "0702", "0712", "0804",
  "0814", "0909", "0912", "0913", "0918", "1002", "1014", "1103", "1107", "1112",
  "1113", "1213", "1214", "1217", "1302", "1305", "1306", "1307", "1309", "1316",
  "1406", "1503", "1506", "1515", "1518", "1602", "1609", "1701", "1706", "1709",
  "1807", "1816", "1902", "1905", "1911", "1914", "2015", "2105", "2109", "2114",
  "2201", "2203", "2207", "2306", "2401", "2410", "2411", "2416", "2505", "2509",
  "2618", "2704", "2706", "2707", "2714",
] as const;

const expectedHexPlacements = {
  "alhert-island": ["2015"],
  "black-marshes": ["0214", "0413", "0415", "0515", "0814", "1014", "1213", "1214"],
  "blackmarsh-region": [
    "0309", "0409", "0610", "0616", "0918", "1113", "1506", "1602", "1609",
    "1706", "1807", "2201", "2203", "2401", "2505", "2509", "2704",
  ],
  "crimson-hills": ["1911", "2109", "2207", "2306"],
  "dragonbone-peaks": ["1701", "1902", "1905", "2105"],
  "driftwood-isle": ["1816"],
  "grey-sea": ["2416", "2618", "2706", "2707", "2714"],
  "greywoods": ["0107", "0407", "0605", "0608", "0804"],
  "lanis-river": ["0712"],
  "pendar-mountains": ["0105", "0211"],
  "rednut-river": ["0302", "0702", "1002", "1103", "1302", "1305", "1503"],
  "sheltered-bay": ["1316", "1515", "1914", "2114", "2410", "2411"],
  "smoking-bay": ["0909", "0912", "0913", "1107", "1112", "1306", "1307", "1309", "1406"],
  "tave-marshes": ["1709"],
  "westwall": ["1217", "1518"],
  "white-mountains": ["0217", "0318"],
} as const;

const regionIds = [
  "alhert-island",
  "black-marshes",
  "crimson-hills",
  "dragonbone-peaks",
  "driftwood-isle",
  "grey-sea",
  "greywoods",
  "lanis-river",
  "pendar-mountains",
  "rednut-river",
  "sandstone-island",
  "sheltered-bay",
  "smoking-bay",
  "tave-marshes",
  "thornbrush-island",
  "westwall",
  "white-mountains",
] as const;

const requiredNonAgentEntityIds = [
  "black-dragon-mother",
  "black-dragon-young",
  "camden-iron-river-route",
  "castle-blackmarsh-depths",
  "centaur-rustling-band",
  "chimera-nesting-herd",
  "crystal-skeleton",
  "darkheart-undead-host",
  "daur-anthar-earth-elemental",
  "mountain-that-fell-roc-flock",
  "eight-headed-hydra",
  "egil-supply-guard",
  "giant-ant-colony",
  "giant-crab-population",
  "great-hall-black-pudding",
  "greywood-rift-incursion",
  "inuacus-garrison",
  "maelstrom-water-elemental",
  "lost-ochre-scout-expedition",
  "moon-shell-mermaids",
  "muncaester-northern-trade-road",
  "ochre-jelly-infestation",
  "pixie-village-community",
  "rednut-giant-snake-colony",
  "rednut-hippogriff-flock",
  "sheltered-bay-dragon-turtle",
  "tave-weretiger-circle",
  "tavis-rescue-sloop",
  "tribute-place-garrison",
  "treasure-wreck-sea-serpent",
  "treasure-wreck-shark-school",
  "troll-caravan-raiders",
  "westwall-hill-giants",
  "white-mountain-boar-herd",
  "wessex-garrison",
] as const;

const settlementPopulations = {
  "hex-0217-oldan-hold": 342,
  "hex-0409-strangeholms": 292,
  "hex-0608-ashdown": 121,
  "hex-0610-greenton": 642,
  "hex-0804-stardell-falls": 503,
  "hex-0913-castle-blackmarsh": 1_294,
  "hex-1002-wedmor": 255,
  "hex-1302-camden": 214,
  "hex-1305-muncaester": 895,
  "hex-1316-jorvik": 481,
  "hex-1506-ethanfeld": 145,
  "hex-2411-ysby": 80,
  "hex-2509-gamla": 405,
  "hex-2704-daretop": 415,
} as const;

function zipWorld(): Buffer {
  const zip = new AdmZip();
  const walk = (directory: string, relative: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const entryPath = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(absolute, entryPath);
      else zip.addFile(path.posix.join("world", entryPath), readFileSync(absolute));
    }
  };
  walk(worldRoot, "");
  return zip.toBuffer();
}

describe("Blackmarsh reference world", () => {
  it("locks the semantic adjudication calibration matrix and its relative effect ordering", () => {
    const provider = new DeterministicModelProvider(blackmarshModelCatalog, false);
    const definition = loadWorldScript(worldRoot, { seed: 47, modelCatalog: provider.catalog });
    const calibrations = Object.fromEntries(definition.initialState.truth.mechanics.adjudicationCalibrations
      .map((entry) => [entry.id, entry]));
    const rank = { none: 0, minor: 1, standard: 2, major: 3, decisive: 4 } as const;

    expect(rank[calibrations["club-strike"].effect]).toBeLessThan(rank[calibrations["sword-strike"].effect]);
    expect(rank[calibrations["sword-strike"].effect]).toBeLessThan(rank[calibrations["enchanted-warhammer"].effect]);
    expect(rank[calibrations["enchanted-warhammer"].effect]).toBeLessThan(rank[calibrations["lethal-holy-sword"].effect]);
    expect(calibrations["lethal-holy-sword"]).toMatchObject({ risk: "dire", effect: "decisive" });
    expect(calibrations["flaming-sword"]).toMatchObject({ effect: "standard" });
    expect(calibrations["flaming-sword"].explanation).toContain("minor burning");
    expect(calibrations["armored-target"].effect).toBe("minor");
    expect(calibrations["carried-arsenal-single-means"]).toMatchObject({ effect: "standard" });
    expect(calibrations["sand-present"]).toMatchObject({ difficulty: "opposed", effect: "standard" });
    expect(calibrations["sand-absent"]).toMatchObject({ difficulty: "blocked", effect: "none" });
    expect(Object.keys(calibrations)).toEqual(expect.arrayContaining([
      "field-healing",
      "pick-lock",
      "foot-chase",
      "persuasion",
      "fair-trade",
      "long-project",
    ]));
  });

  it("loads the complete geography, autonomous cast, and three opening deadlines", () => {
    const provider = new DeterministicModelProvider(blackmarshModelCatalog, false);
    const definition = loadWorldScript(worldRoot, { seed: 47, modelCatalog: provider.catalog });
    const { truth } = definition.initialState;

    expect(definition).toMatchObject({
      id: "blackmarsh",
      manifestVersion: "1.1.0",
      runtimeDefaults: {
        maxAutonomousSpanSeconds: 300,
        realtimeIntervalMs: 300_000,
        actionWindowMs: 60_000,
      },
      rulePackages: [expect.objectContaining({ id: "core-resolution", version: "2.0.0" })],
    });
    expect(definition.initialState.schemaVersion).toBe(16);
    expect(definition.description).toContain("Robert Conley");
    expect(definition.description).toContain("batintheattic.blogspot.com");
    expect(definition.description).toContain("creativecommons.org/licenses/by/4.0");
    expect(truth.mechanics.impactProfiles.harm.amounts).toEqual({
      none: 0, minor: 2, standard: 5, major: 10, decisive: 30,
    });
    expect(truth.mechanics.adjudicationCalibrations.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["club-strike", "sword-strike", "flaming-sword", "sand-present", "sand-absent", "fair-trade"]),
    );
    expect(truth.mechanics.activityResources).toEqual({
      foreground: { id: "foreground", name: "前台行动", capacity: 1 },
    });
    expect(truth.mechanics.temporalProfiles).toMatchObject({
      "momentary-action": { kind: "fixed", durationSeconds: 1, checkpointSeconds: 1 },
      "explicit-duration": {
        kind: "fixed",
        selection: { semanticTags: ["explicit-duration"], evidenceRequirement: "explicit_duration" },
      },
      "road-travel": { kind: "rate", unitsPerPeriod: 4, periodSeconds: 3_600, checkpointUnits: 1 },
      "rough-travel": { kind: "rate", unitsPerPeriod: 2, periodSeconds: 3_600, checkpointUnits: 1 },
      "field-treatment": {
        kind: "staged",
        stages: [
          { id: "assess", durationSeconds: 300, checkpointSeconds: 300 },
          { id: "clean", durationSeconds: 900, checkpointSeconds: 300 },
          { id: "dress", durationSeconds: 1_800, checkpointSeconds: 300 },
        ],
      },
      "wait-until": { kind: "conditional", checkEverySeconds: 300 },
      "travel-until-arrival": { kind: "conditional", checkEverySeconds: 600 },
      "ongoing-watch": { kind: "ongoing", checkpointSeconds: 300 },
    });
    expect(truth.mechanics.temporalCalibrations.map((entry) => [entry.id, entry.profileId])).toEqual([
      ["sword-swing-time", "momentary-action"],
      ["short-interaction-time", "brief-action"],
      ["explicit-rest-time", "explicit-duration"],
      ["road-travel-time", "road-travel"],
      ["rough-travel-time", "rough-travel"],
      ["field-treatment-time", "field-treatment"],
      ["wait-condition-time", "wait-until"],
      ["unknown-distance-travel-time", "travel-until-arrival"],
      ["ongoing-watch-time", "ongoing-watch"],
    ]);

    expect(Object.keys(definition.initialState.agents).sort()).toEqual([...agentIds].sort());
    for (const agent of Object.values(definition.initialState.agents)) {
      expect(agent.entityId).toBe(agent.id);
      expect(agent.character.persona.summary.length).toBeGreaterThan(20);
      expect(agent.character.persona.voice.length).toBeGreaterThan(10);
      expect(Object.keys(agent.character.traits).length).toBeGreaterThanOrEqual(1);
      expect(Object.keys(agent.character.values).length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(agent.character.emotions).length).toBeGreaterThanOrEqual(1);
      expect(Object.keys(agent.character.attitudes).length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(agent.character.goals).length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(agent.character.commitments).length).toBeGreaterThanOrEqual(1);
      expect(Object.keys(agent.belief.localEntities).length).toBeGreaterThanOrEqual(4);
      expect(Object.keys(agent.belief.evidence).length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(agent.belief.claims).length).toBeGreaterThanOrEqual(2);

      const selfBindings = Object.values(agent.bindings).filter((binding) =>
        binding.canonicalEntityIds.includes(agent.entityId));
      expect(selfBindings).toHaveLength(1);
      const boundCanonicalIds = Object.values(agent.bindings)
        .flatMap((binding) => binding.canonicalEntityIds);
      expect(new Set(boundCanonicalIds).size, agent.id).toBe(boundCanonicalIds.length);
    }

    for (const entityId of requiredNonAgentEntityIds) {
      expect(truth.entities[entityId], entityId).toBeDefined();
      expect(definition.initialState.agents[entityId], entityId).toBeUndefined();
    }

    const coordinateFacts = Object.values(truth.facts)
      .filter((fact) => fact.predicate === "hex-coordinate");
    const coordinates = coordinateFacts.map((fact) => {
        expect(fact.value.kind).toBe("text");
        return fact.value.kind === "text" ? fact.value.value : "";
      })
      .sort();
    expect(coordinates).toEqual([...hexCoordinates].sort());
    const hexIdByCoordinate = Object.fromEntries(coordinateFacts.map((fact) => [
      fact.value.kind === "text" ? fact.value.value : "",
      fact.subjectId,
    ]));
    for (const [placementId, expectedCoordinates] of Object.entries(expectedHexPlacements)) {
      for (const coordinate of expectedCoordinates) {
        expect(truth.placements[hexIdByCoordinate[coordinate]], coordinate).toBe(placementId);
      }
    }

    const loadedPopulations = Object.fromEntries(Object.values(truth.facts)
      .filter((fact) => fact.predicate === "population" && fact.subjectId in settlementPopulations)
      .map((fact) => {
        expect(fact.value.kind, fact.id).toBe("number");
        return [fact.subjectId, fact.value.kind === "number" ? fact.value.value : Number.NaN] as const;
      })) as Record<string, number>;
    expect(loadedPopulations).toEqual(settlementPopulations);
    expect(Object.values(loadedPopulations).reduce((sum, population) => sum + Number(population), 0))
      .toBe(6_084);

    const regions = Object.values(truth.entities)
      .filter((entity) => entity.kind === "geographic-region")
      .map((entity) => entity.id)
      .sort();
    expect(regions).toEqual([...regionIds].sort());
    for (const regionId of regions) expect(truth.placements[regionId]).toBe("blackmarsh-region");

    const deadlines = Object.values(truth.facts)
      .filter((fact) => fact.predicate === "deadline-seconds")
      .map((fact) => [fact.subjectId, fact.value.kind === "number" ? fact.value.value : null])
      .sort(([left], [right]) => String(left).localeCompare(String(right)));
    expect(deadlines).toEqual([
      ["ochre-search-expedition", 108_000],
      ["rinisar-raven-cell", 64_800],
      ["sigrun-brigand-column", 36_000],
    ]);
    const openingOperations = {
      "ochre-search-expedition": {
        state: "in-progress",
        target: "sheltered-bay",
      },
      "rinisar-raven-cell": {
        state: "preparing",
        target: "eight-headed-hydra",
      },
      "sigrun-brigand-column": {
        state: "in-progress",
        target: "hex-0407-blackoak-castle",
      },
    } as const;
    for (const [subjectId, expected] of Object.entries(openingOperations)) {
      const operationFacts = Object.values(truth.facts).filter((fact) => fact.subjectId === subjectId);
      expect(operationFacts.filter((fact) => fact.predicate === "operation-state"), subjectId)
        .toHaveLength(1);
      expect(operationFacts.find((fact) => fact.predicate === "operation-state")?.value)
        .toEqual({ kind: "text", value: expected.state });
      expect(operationFacts.filter((fact) => fact.predicate === "operation-target"), subjectId)
        .toHaveLength(1);
      expect(operationFacts.find((fact) => fact.predicate === "operation-target")?.value)
        .toEqual({ kind: "entity", entityId: expected.target });
    }
    expect(Object.values(truth.facts).some((fact) => fact.predicate === "operational-clock")).toBe(false);

    expect(definition.laws.map((law) => law.id)).toEqual(expect.arrayContaining([
      "committed-source-randomness",
      "deadline-integrity",
      "lunar-calendar",
    ]));
    const randomSteps = Object.fromEntries(definition.randomDistributions.map((distribution) => [
      distribution.id,
      distribution.steps,
    ]));
    expect(randomSteps).toEqual({
      "moon-shell-viz-yield": [{
        id: "amount",
        count: 4,
        outcomes: [1, 2, 3, 4, 5, 6],
        aggregate: "sum",
        when: null,
      }],
      "oldan-current-visitors": [{
        id: "visitors",
        count: 5,
        outcomes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        aggregate: "sum",
        when: null,
      }],
      "rednut-snake-segment": [
        {
          id: "triggered",
          count: 1,
          outcomes: [false, false, false, true, true, true],
          aggregate: "first",
          when: null,
        },
        {
          id: "encounter-kind",
          count: 1,
          outcomes: ["den", "den", "den", "den", "snake", "snake"],
          aggregate: "first",
          when: { stepId: "triggered", equals: true },
        },
      ],
      "white-mountain-boar-hour": [
        {
          id: "triggered",
          count: 1,
          outcomes: [false, false, false, true],
          aggregate: "first",
          when: null,
        },
        {
          id: "group-size",
          count: 4,
          outcomes: [1, 2, 3, 4],
          aggregate: "sum",
          when: { stepId: "triggered", equals: true },
        },
      ],
    });
    expect(truth.facts["inuacus-garrison-standing-orders"]).toMatchObject({
      access: { kind: "private" },
      subjectId: "inuacus-garrison",
      value: {
        kind: "text",
        value: "defend-surrounding-farms-monitor-jorvik-and-stop-monsters-moving-north",
      },
    });
    expect(truth.facts["causari-current-orders"]).toBeUndefined();

    expect(truth.facts["blackmarsh-seconds-until-next-full-moon"].value)
      .toEqual({ kind: "number", value: 518_400 });
    expect(truth.facts["blackmarsh-lunar-cycle-seconds"].value)
      .toEqual({ kind: "number", value: 2_551_443 });
    expect(truth.facts["moon-shell-mermaids-viz-yield-distribution"].value)
      .toEqual({ kind: "text", value: "moon-shell-viz-yield" });
    expect(truth.facts["abrams-fleet-size"]).toMatchObject({
      predicate: "minimum-owned-ships",
      value: { kind: "number", value: 25 },
    });
    expect(truth.facts["hex-0217-foreign-merchant-distribution"].value)
      .toEqual({ kind: "text", value: "oldan-current-visitors" });
    expect(truth.facts["white-mountain-boar-herd-distribution"].value)
      .toEqual({ kind: "text", value: "white-mountain-boar-hour" });
    expect(truth.facts["rednut-giant-snake-colony-distribution"].value)
      .toEqual({ kind: "text", value: "rednut-snake-segment" });

    expect(truth.facts["dragonbone-peaks-caverns"].predicate).toBe("reported-subterranean-extent");
    expect(truth.facts["hex-1309-flying-ecology"].predicate).toBe("reported-fauna");
    expect(truth.facts["crystal-skeleton-reassembly"].predicate).toBe("dated-report-pattern");
    expect(truth.placements["tave-weretiger-circle"]).toBe("tave-marshes");
    expect(truth.placements["mountain-that-fell-roc-flock"]).toBe("blackmarsh-region");

    const dynamicDescriptionPattern =
      /\bt0\b|近期|当前|目前|如今|现任|正在|开局|今日|今夜|刚|即将|沉睡|已离开|正准备|正率|正寻找|正带|正为|准备在|仍在|尚未|现有|等待消息|混在.+库存|被.+握住/i;
    for (const entity of Object.values(truth.entities)) {
      expect(entity.description, entity.id).not.toMatch(dynamicDescriptionPattern);
    }

    const prohibitedLocationPredicates = {
      "hex-0211-graptars-base": ["population", "internal-security"],
      "hex-0407-blackoak-castle": ["population-composition", "political-condition", "faction-relations"],
      "hex-0413-sword-grove": ["government", "population"],
      "hex-0608-ashdown": ["social-composition", "current-policy"],
      "hex-0610-greenton": ["guard"],
      "hex-1107-neptars-grotto": ["population", "current-condition", "political-status"],
      "hex-1113-inuacus-keep": ["composition", "standing-order"],
      "hex-1213-witch-hill": ["current-search"],
      "hex-1217-hill-giant-steading": ["composition", "recurring-activity"],
      "hex-1307-naomis-island": ["inhabitants", "historical-relationship", "current-policy"],
      "hex-1309-mountain-that-fell": ["jurisdiction", "current-policy"],
      "hex-1406-egils-longships": ["deployed-force", "current-condition", "current-intent"],
      "hex-1518-norbury-castle": ["headcount", "strategic-mission"],
      "hex-1609-shelleater-territory": ["population", "government"],
      "hex-1807-brotherhood-ravines": ["ideology", "population-composition", "government"],
      "hex-1905-rinisars-camp": ["composition", "current-intent", "deadline-seconds"],
      "hex-1911-bateater-caves": ["population", "political-obligation"],
      "hex-2105-scythebacks-lair": ["ruler", "treasure", "alliance", "inhabitants"],
      "hex-2114-mermaid-island": ["composition", "recurring-activity"],
      "hex-2203-pixie-village": ["population", "recurring-behavior"],
      "hex-2207-bloodcrusher-caves": ["government", "population", "political-condition"],
      "hex-2401-giant-ant-warrens": ["population", "current-condition", "ecological-yield"],
      "hex-2416-azure-kings-hall": ["government", "population", "resource-route"],
      "hex-2707-kostberas-island": ["service"],
      "hex-2714-crystal-skeleton": ["depth-feet", "dated-report-pattern"],
    } as const;
    for (const [subjectId, predicates] of Object.entries(prohibitedLocationPredicates)) {
      const subjectPredicates = Object.values(truth.facts)
        .filter((fact) => fact.subjectId === subjectId)
        .map((fact) => fact.predicate);
      for (const predicate of predicates) {
        expect(subjectPredicates, `${subjectId} must not own ${predicate}`).not.toContain(predicate);
      }
    }
    expect(Object.values(truth.facts).some((fact) => fact.predicate === "current-intent")).toBe(false);
    const prohibitedCanonicalMindFactIds = [
      "bedewald-frontier-assignment",
      "bjarni-current-neutrality",
      "dennis-maracan-assessment",
      "gmung-opening-omen-boundary",
      "hamdir-independent-position",
      "hamdir-no-current-pledge",
      "kalfvald-ragnar-loyalty",
      "scytheback-raven-pawn-alliance",
      "suduk-opening-choice",
      "suduk-tribute-resentment",
      "yngvar-undecided-course",
    ];
    for (const factId of prohibitedCanonicalMindFactIds) expect(truth.facts[factId], factId).toBeUndefined();
    for (const subjectId of ["autarch-elana", "kinkaris", "scytheback", "sir-autse-darkheart"]) {
      const predicates = Object.values(truth.facts)
        .filter((fact) => fact.subjectId === subjectId)
        .map((fact) => fact.predicate);
      expect(predicates, subjectId).not.toContain("current-knowledge");
      expect(predicates, subjectId).not.toContain("knowledge-boundary");
    }

    expect(truth.facts["ragnar-ring-identity"]).toMatchObject({
      subjectId: "ragnars-lost-ring",
      access: { kind: "private" },
      value: { kind: "text", value: "lost-royal-ring-of-king-ragnar" },
    });
    expect(truth.placements["ragnars-lost-ring"]).toBe("castle-blackmarsh-jeweler");
    expect(definition.initialState.agents["king-ragnar"].bindings["lost-signet"].canonicalEntityIds)
      .toEqual(["ragnars-lost-ring"]);
    expect(definition.initialState.agents["bedewald-atheling"].bindings.hydra.canonicalEntityIds)
      .toEqual(["eight-headed-hydra"]);
    expect(definition.initialState.agents["lord-travvarn"].bindings["lost-expedition"].canonicalEntityIds)
      .toEqual(["lost-ochre-scout-expedition"]);
    expect(definition.initialState.agents["governor-tyrilas"].bindings["castle-depths"].canonicalEntityIds)
      .toEqual(["castle-blackmarsh-depths"]);
    expect(definition.initialState.agents["matthew-thanes"].bindings["northern-road"].canonicalEntityIds)
      .toEqual(["muncaester-northern-trade-road"]);
    expect(definition.initialState.agents["lord-varxis"].bindings["river-route"].canonicalEntityIds)
      .toEqual(["camden-iron-river-route"]);
    expect(JSON.stringify(definition.initialState.agents.player.belief)).not.toContain("ragnar-ring-identity");
    expect(truth.facts["mazardan-viz-offer"].value).toEqual({ kind: "number", value: 200 });
    expect(truth.facts["ochre-expedition-mission"].value)
      .toEqual({ kind: "text", value: "find-expedition-lost-five-years-ago-not-launch-an-invasion" });
  });

  it("passes the same strict ZIP import path as user-authored worlds", () => {
    const provider = new DeterministicModelProvider(blackmarshModelCatalog, false);
    expect(parseWorldArchive(zipWorld(), provider.catalog)).toMatchObject({
      id: "blackmarsh",
      name: "黑沼边境",
      version: "1.1.0",
      contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it("keeps legacy D&D statistics out of the executable package", () => {
    const source = [
      readFileSync(path.join(worldRoot, "script.yaml"), "utf8"),
      readFileSync(path.join(worldRoot, "mechanics.yaml"), "utf8"),
      readFileSync(path.join(worldRoot, "laws.yaml"), "utf8"),
      ...readdirSync(path.join(worldRoot, "entities"))
        .filter((file) => file.endsWith(".yaml"))
        .map((file) => readFileSync(path.join(worldRoot, "entities", file), "utf8")),
    ].join("\n");

    expect(source).not.toMatch(/\b(?:AC|HD|Ftr|Mu|Clr)\b|\b\d+d\d+\b/);
  });

  it("bootstraps all Agents and commits one deterministic open-world step", async () => {
    // The structural 48-Agent test keeps the production twelve-slot batching
    // policy while exercising observer-scoped semantic context.
    const provider = new DeterministicModelProvider(blackmarshModelCatalog);
    const definition = loadWorldScript(worldRoot, { seed: 47, modelCatalog: provider.catalog });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const state = engine.snapshot;
    expect(Object.values(state.agents)).toHaveLength(48);
    expect(Object.values(state.agents).every((agent) => agent.nextAction !== null)).toBe(true);
    expect(provider.requests.filter((request) => request.role === "agent-bootstrap")).toHaveLength(6);
    expect(provider.requests.filter((request) => request.role === "agent-bootstrap").every((request) =>
      (request.context as { roleContract: { role: string }; slots: Array<{ agentState: { perspective: { agentRef: string } } }> }).roleContract.role === "agent-bootstrap" &&
      (request.context as { slots: Array<{ agentState: { perspective: { agentRef: string } } }> }).slots.every((slot) =>
        state.agents[slot.agentState.perspective.agentRef.replace(/^ref:agent:/u, "")]?.modelProfiles.bootstrap === request.profileId))).toBe(true);
    const roster = Object.fromEntries(Object.values(state.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: agent.modelProfiles,
    }]));
    const completed = await engine.step(roster, {
      expectedRevision: state.revision,
      trigger: "manual",
      externalActions: [],
    });
    expect(completed.state).toMatchObject({ revision: 1, step: 1 });
    const actionCompilationRequests = provider.requests.filter((request) => request.role === "action-compilation");
    const actionRefs = actionCompilationRequests.flatMap((request) =>
      (request.context as { task: { slots: Array<{ actionReferences: { actionCandidateKey: string } }> } }).task.slots
        .map((slot) => slot.actionReferences.actionCandidateKey));
    expect(actionCompilationRequests.length).toBeGreaterThanOrEqual(4);
    expect(actionCompilationRequests.every((request) =>
      (request.context as { task: { slots: unknown[] } }).task.slots.length <= 12)).toBe(true);
    expect(actionRefs).toHaveLength(Object.values(state.agents).length);
    expect(new Set(actionRefs).size).toBe(actionRefs.length);
    expect(provider.requests.filter((request) => request.role === "agent-mind")).toHaveLength(6);
    expect(provider.requests.filter((request) => request.role === "agent-mind").every((request) =>
      (request.context as { roleContract: { role: string }; slots: Array<{ agentState: { perspective: { agentRef: string } } }> }).roleContract.role === "agent-mind" &&
      (request.context as { slots: Array<{ agentState: { perspective: { agentRef: string } } }> }).slots.every((slot) =>
        state.agents[slot.agentState.perspective.agentRef.replace(/^ref:agent:/u, "")]?.modelProfiles.mind === request.profileId))).toBe(true);
    const batchedAudits = [...engine.bootstrapModelAudits, ...completed.modelAudits]
      .filter((audit) => audit.role === "action-compilation" || audit.role === "agent-bootstrap" ||
        audit.role === "agent-mind");
    expect(batchedAudits.every((audit) => audit.invocations.length === 1)).toBe(true);
    const invocationIds = batchedAudits.flatMap((audit) => audit.invocations.map((invocation) => invocation.id));
    expect(new Set(invocationIds).size).toBe(invocationIds.length);
    expect(provider.requests.some((request) => request.role === "truth-perception")).toBe(false);
  // This intentionally exercises 48 Agents, profile-dependent action batches,
  // and the full semantic Truth/observation pipeline. Keep the timeout above the
  // structural workload's normal wall time so slower CI hosts do not turn a
  // valid contract check into a flaky failure.
  }, 120_000);
});
