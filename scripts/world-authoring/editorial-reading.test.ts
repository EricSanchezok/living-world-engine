import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { indexEditorialReading } from "./editorial-reading";

describe("editorial reading evidence", () => {
  it("keeps full-source attestations, claim-only second passes and missing fingerprints distinct", () => {
    const text = "甲乙\n丙丁";
    const result = indexEditorialReading([{ moduleId: "sample", file: "regions/sample/source-reading.json", report: {
      groups: [{ parts: [{ chapterId: "qq-1", sha256: contentHash(text), characters: 5,
        read: "root-complete-text-first-pass", secondPass: "root-reviewed-used-claim-anchors" }] }],
      additionalReadChapters: ["qq-1", "qq-2"],
    } }], () => text);
    expect(result.entries[0]).toMatchObject({ start: 0, end: 5, secondPass: "root-reviewed-used-claim-anchors", approvedForRuntime: false });
    expect(result.uniqueFingerprintBoundChapters).toBe(1);
    expect(result.unbound.map(entry => entry.chapterId)).toEqual(["qq-2"]);
    expect(result.invalid).toEqual([]);
  });
  it("rejects stale fingerprints, partial counts, missing attestations and duplicate module entries", () => {
    const text = "甲乙丙丁";
    const valid = { chapterId: "qq-1", sha256: contentHash(text), firstPass: "阅读全文" };
    const result = indexEditorialReading([{ moduleId: "sample", file: "reading.json", report: { sourceReads: [
      { ...valid, sha256: contentHash("旧版本") }, { ...valid, characters: 3 }, { ...valid, firstPass: "" }, valid, valid,
    ] } }], () => text);
    expect(result.entries).toHaveLength(1);
    expect(result.invalid.map(item => item.message)).toEqual([
      "Reading-version fingerprint differs from current source", "Reading character count differs from current source",
      "Missing first-pass reading attestation", "Duplicate chapter reading entry in the same module",
    ]);
  });
});
