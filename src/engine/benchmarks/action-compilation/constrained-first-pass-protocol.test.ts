import { describe, expect, it } from "vitest";
import { contentHash } from "../../models/model-audit";
import { AC_FP2_ARMS, AC_FP2_CANDIDATES, AC_FP2_PROTOCOL, constrainedFirstPassSchedule } from "./constrained-first-pass-protocol";
import { verifyConstrainedSourceManifest } from "./constrained-first-pass-sources";

describe("AC-FP2 fixed experiment contract", () => {
  it("balances each discovery arm in every source and schedule position", () => {
    const schedule = constrainedFirstPassSchedule("discovery");
    expect(schedule).toHaveLength(144);
    expect(schedule).toEqual(constrainedFirstPassSchedule("discovery"));
    expect(new Set(schedule.map(({ id }) => id)).size).toBe(144);
    for (const arm of AC_FP2_ARMS) {
      const trials = schedule.filter((trial) => trial.arm === arm);
      expect(trials).toHaveLength(24);
      expect(trials.reduce((sum, trial) => sum + AC_FP2_PROTOCOL.sources[trial.sourceIndex]!.size, 0)).toBe(258);
      for (const source of AC_FP2_PROTOCOL.sources) {
        const positions = schedule.flatMap((trial, index) => trial.arm === arm && trial.sourceId === source.id ? [index % 6] : []);
        expect(positions.sort()).toEqual([0, 1, 2, 3, 4, 5]);
      }
    }
  });

  it("requires an eligible confirmation candidate and preserves 64 paired batches", () => {
    expect(() => constrainedFirstPassSchedule("confirmation")).toThrow("sealed candidate");
    for (const candidate of AC_FP2_CANDIDATES) {
      const schedule = constrainedFirstPassSchedule("confirmation", candidate);
      expect(schedule).toHaveLength(128);
      for (const arm of ["B", candidate]) {
        const trials = schedule.filter((trial) => trial.arm === arm);
        expect(trials).toHaveLength(64);
        expect(trials.reduce((sum, trial) => sum + AC_FP2_PROTOCOL.sources[trial.sourceIndex]!.size, 0)).toBe(688);
      }
      for (let index = 0; index < schedule.length; index += 2) {
        const first = schedule[index]!;
        expect(first.arm).toBe((first.repetition + first.sourceIndex) % 2 ? candidate : "B");
        expect(schedule[index + 1]!.sourceId).toBe(first.sourceId);
      }
    }
  });

  it("rejects manifest tampering and unsafe or duplicate historical file names", () => {
    const manifest = { version: 1, codeHash: "a".repeat(64), oracleHash: "b".repeat(64), files: [
      ...AC_FP2_PROTOCOL.sources.flatMap(({ id }) => ["B1", "A", "T", "AT", "source"].map((arm) => ({ file: `${id}-${arm}.json`, hash: "c".repeat(64) }))),
      ...["oracle.json", "verification.json", "protocol.json"].map((file) => ({ file, hash: "d".repeat(64) })),
    ] };
    const hash = contentHash(manifest);
    expect(verifyConstrainedSourceManifest({ manifest, hash }, hash)).toEqual(manifest);
    expect(() => verifyConstrainedSourceManifest({ manifest: { ...manifest, version: 2 }, hash }, hash)).toThrow();
    expect(() => verifyConstrainedSourceManifest({ manifest, hash }, "e".repeat(64))).toThrow("hash mismatch");
    for (const file of ["../outside.json", "oracle.json"]) {
      const changed = structuredClone(manifest);
      changed.files[0]!.file = file;
      const changedHash = contentHash(changed);
      expect(() => verifyConstrainedSourceManifest({ manifest: changed, hash: changedHash }, changedHash)).toThrow("file set mismatch");
    }
  });
});
