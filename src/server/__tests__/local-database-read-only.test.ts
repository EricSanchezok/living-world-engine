import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalDatabase, LocalDatabaseReadOnlyError } from "../local-database";

describe("LocalDatabase read-only connections", () => {
  it("reads beside the writer without acquiring or deleting its lease", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-read-only-"));
    const file = path.join(root, "livingworld.sqlite");
    const writer = new LocalDatabase(file, { heartbeat: false, ownerId: "writer" });
    const reader = new LocalDatabase(file, { readOnly: true, heartbeat: false });

    try {
      writer.writeExperimentEnrollmentStop("fixture", "1", "cache integrity failure");
      writer.writeExperimentEnrollmentStop("fixture", "1", "later reason must not replace the first stop");
      expect(reader.readExperimentEnrollmentStop("fixture", "1")).toBe("cache integrity failure");
      expect(() => reader.writeExperimentEnrollmentStop("fixture", "1", "changed"))
        .toThrow(LocalDatabaseReadOnlyError);
      expect(reader.debugDoctor()).toMatchObject({ schemaVersion: 9, indexFresh: true });
      expect(() => reader.debugRebuildIndex()).toThrow(LocalDatabaseReadOnlyError);
      reader.close();

      expect(() => new LocalDatabase(file, {
        heartbeat: false,
        ownerId: "contender",
        isProcessAlive: () => true,
      })).toThrow("already owned by another Living World Engine instance");
    } finally {
      writer.close();
    }
  });
});
