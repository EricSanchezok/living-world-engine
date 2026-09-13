import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DiscreteRandomDefinition } from "../../src/engine/contracts/model";
import { createSeededRng, resolveDiscreteRandomRequests, validateDiscreteRandomDefinitions } from "../../src/engine/mechanics/random";
import { contentHash } from "../../src/engine/models/model-audit";

type Value = Record<string, unknown>;
const object = (value: unknown): Value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a complete source object");
  return value as Value;
};

/** Offline audit of existing distributions. No game clock, world state, API or RNG ledger is changed. */
export function auditRandomTriggerLookahead(sourceRoot: string, output: string) {
  const sourceFile = path.join(sourceRoot, "run/ledger-events.json");
  const sourceBytes = readFileSync(sourceFile, "utf8");
  const events = JSON.parse(sourceBytes) as Array<{ event: string; payload?: unknown }>;
  const preparation = object(events.find(event => event.event === "step.preparation.started")?.payload);
  const definition = object(preparation.definition), state = object(preparation.state), truth = object(state.truth);
  if (Object.keys(object(state.agents)).length !== 49) throw new Error("Expected the complete 49-agent source");
  const distributions = definition.randomDistributions as DiscreteRandomDefinition[];
  validateDiscreteRandomDefinitions(distributions);
  const before = contentHash(preparation), samples = 4096, horizon = 64, baseSeed = 20260913;
  const started = performance.now();
  const rows = distributions.map(distribution => {
    const gate = distribution.steps[0];
    if (!gate || gate.when !== null || gate.count !== 1 || gate.aggregate !== "first" ||
      gate.outcomes.some(value => typeof value !== "boolean")) {
      return { distributionId: distribution.id, eligibleBooleanGate: false, reason: "First step is not a single unconditional Boolean draw." };
    }
    const p = gate.outcomes.filter(value => value === true).length / gate.outcomes.length;
    if (p === 0 || p === 1) return { distributionId: distribution.id, eligibleBooleanGate: false, probabilityTrue: p, reason: "Degenerate gate; no stochastic waiting-time study needed." };
    const histogram: Record<string, number> = {}, conditionalOutcomes: Record<string, number> = {};
    let totalTrials = 0, totalRngWords = 0, censored = 0, sampleSquares = 0;
    for (let sample = 0; sample < samples; sample++) {
      let rng = createSeededRng(baseSeed + sample), hit = false, trials = 0;
      for (let period = 1; period <= horizon; period++) {
        const result = resolveDiscreteRandomRequests(rng, [{ id: `lookahead-${sample}-${period}`,
          distributionId: distribution.id, distribution,
          causes: [{ kind: "law", id: "committed-source-randomness" }] }]);
        rng = result.rng; trials++;
        const drawn = result.results[0]!;
        if (drawn.steps[0]!.aggregate === true) {
          hit = true;
          const key = JSON.stringify(drawn.steps.slice(1).map(step => ({ id: step.stepId, skipped: step.skipped, aggregate: step.aggregate })));
          conditionalOutcomes[key] = (conditionalOutcomes[key] ?? 0) + 1;
          break;
        }
      }
      if (!hit) censored++;
      histogram[String(trials)] = (histogram[String(trials)] ?? 0) + 1;
      totalTrials += trials; sampleSquares += trials * trials; totalRngWords += rng.draws;
    }
    const meanTrials = totalTrials / samples;
    return { distributionId: distribution.id, description: distribution.description, eligibleBooleanGate: true,
      probabilityTrue: p, samples, horizon, censored, histogram, conditionalOutcomes,
      empiricalMeanTrials: meanTrials,
      descriptiveStandardError: Math.sqrt(Math.max(0, (sampleSquares / samples - meanTrials * meanTrials) / samples)),
      iidGeometricExpectedTrials: 1 / p,
      iidTruncatedExpectedTrials: (1 - (1 - p) ** horizon) / p,
      iidNoTrueWithinHorizon: (1 - p) ** horizon,
      totalKernelRequests: totalTrials, totalRngWords,
      meanFalseIntervalsBeforeStop: (totalTrials - (samples - censored)) / samples,
      applicability: "Boolean-gate statistics only. Cadence, actor exposure, state invariance, other events and RNG ordering are not proven by this distribution definition." };
  });
  if (contentHash(preparation) !== before) throw new Error("Source changed during offline audit");
  mkdirSync(output, { recursive: false });
  const save = (name: string, value: unknown) => writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  save("manifest.json", { protocol: "source-random-trigger-lookahead-audit-v1",
    codeRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceEventsHash: contentHash(sourceBytes), preparationHash: before, worldHash: state.worldHash,
    distributionHash: contentHash(distributions), runnerHash: contentHash(readFileSync(new URL(import.meta.url), "utf8")),
    samples, horizon, baseSeed, completeAgents: 49, newHttp: 0, worldCommits: 0 });
  save("result.json", { rows, elapsedMs: performance.now() - started,
    initialActivities: Object.keys(object(truth.activities)).length, initialTimers: Object.keys(object(truth.timers)).length,
    newHttp: 0, wholeGoalAchieved: false,
    limits: ["Uses the existing kernel's full conditional distributions, with fresh isolated seeded streams; no inverse-CDF replacement or changed production RNG.",
      "IID geometric formulas are reference expectations, not a proof that finite seeded streams are independent.",
      "No measured LLM call savings or player speedup. False-interval counts are only a conditional opportunity if independent evidence permits skipping their semantic adjudication.",
      "A safe future scheduler needs typed cadence/exposure, dependency invalidation and a random commitment order before advancing the world. Current definition descriptions alone do not establish these."] });
  return rows.map(row => ({ distributionId: row.distributionId, eligible: row.eligibleBooleanGate,
    probabilityTrue: row.probabilityTrue, empiricalMeanTrials: row.empiricalMeanTrials }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output || process.argv.length !== 4) throw new Error("Expected source-player-directory output-directory");
  process.stdout.write(`${JSON.stringify(auditRandomTriggerLookahead(source, output))}\n`);
}
