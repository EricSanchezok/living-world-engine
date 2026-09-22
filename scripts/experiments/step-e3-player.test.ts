import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertE3ContinuationPaths, completedE3Inputs } from "./step-e3-player";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
function directory() {
  const value = mkdtempSync(path.join(tmpdir(), "e3-resume-")); directories.push(value); return value;
}
function input(root: string, index: number, overrides: Record<string, unknown> = {}) {
  const row = { index: index - 1, revision: 1, stateHash: "unchanged-world", result: {
    submissionId: `step-e3-canary-2-${index}`, text: `input ${index}`, baseRevision: 1,
    status: "stopped", endedElapsedMs: 100, failure: "provider context overflow", feedback: [],
  }, ...overrides };
  writeFileSync(path.join(root, `input-${index}.json`), JSON.stringify(row));
  return row;
}
const texts = ["input 1", "input 2", "input 3"];

it("retains failed inputs as a completed prefix instead of retrying them", () => {
  const root = directory(), first = input(root, 1), second = input(root, 2);
  const completed = completedE3Inputs(root, "canary-2", texts, "unchanged-world", ["failed", "failed"]);
  expect(completed).toEqual([first, second]);
  expect(texts.slice(completed.length)).toEqual(["input 3"]);
});

it("rejects a missing or noncontiguous input checkpoint", () => {
  const root = directory();
  expect(() => completedE3Inputs(root, "canary-2", texts, "unchanged-world", [])).toThrow("settled input");
  input(root, 2);
  expect(() => completedE3Inputs(root, "canary-2", texts, "unchanged-world", ["failed"])).toThrow("contiguous prefix");
});

it("rejects world drift and a live persisted run", () => {
  const root = directory(); input(root, 1);
  expect(() => completedE3Inputs(root, "canary-2", texts, "changed-world", ["failed"])).toThrow("current world state");
  expect(() => completedE3Inputs(root, "canary-2", texts, "unchanged-world", ["running"])).toThrow("remains live");
});

it("rejects changed input identity, text and revision continuity", () => {
  const root = directory(); input(root, 1);
  expect(() => completedE3Inputs(root, "another-pair", texts, "unchanged-world", [])).toThrow("binding changed");
  expect(() => completedE3Inputs(root, "canary-2", ["new prompt", ...texts.slice(1)], "unchanged-world", [])).toThrow("binding changed");
  input(root, 2, { result: { submissionId: "step-e3-canary-2-2", text: "input 2", baseRevision: 7,
    status: "stopped", endedElapsedMs: 20 } });
  expect(() => completedE3Inputs(root, "canary-2", texts, "unchanged-world", [])).toThrow("binding changed");
});

it("allows administrative recovery only, never an engine or prompt change", () => {
  expect(() => assertE3ContinuationPaths(["scripts/experiments/step-e3-player.ts", "docs/research/results.md"])).not.toThrow();
  for (const file of ["src/engine/mechanics/truth-engine.ts", "src/engine/prompts/shared/executable-interaction.md",
    "scripts/experiments/step-e3-runtime.ts", "worlds/blackmarsh/world/laws.yaml", "package-lock.json"]) {
    expect(() => assertE3ContinuationPaths([file])).toThrow("Frozen E3 producer changed");
  }
});
