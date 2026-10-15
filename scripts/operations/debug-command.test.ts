import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { defineEngineOperationManifest } from "../../src/engine/runtime/execution";
import { LocalDatabase } from "../../src/server/local-database";
import { runDebugCommand } from "./debug-command";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedDatabase(): { file: string; invocationId: string } {
  const root = mkdtempSync(path.join(tmpdir(), "lwe-debug-cli-"));
  roots.push(root);
  const file = path.join(root, "livingworld.sqlite");
  const database = new LocalDatabase(file, { heartbeat: false });
  const trace = database.beginExecution({
    id: "cli-execution",
    kind: "diagnostic",
    instanceId: "cli-instance",
    manifest: defineEngineOperationManifest({ id: "debug-cli", version: "1", config: {} }),
    worldHash: contentHash("world"),
    codeRevision: "test",
    codeDirty: false,
    modelCatalogHash: contentHash("catalog"),
    seed: 1,
    runtimeConfig: {},
  });
  trace.emit({
    event: "model.invocation.started",
    correlation: { instanceId: "cli-instance", requestId: "cli-request", modelInvocationId: "cli-source", modelRole: "agent-mind" },
    attributes: { providerId: "provider", profileId: "profile", modelId: "model" },
  });
  database.finishExecution("cli-execution", { status: "succeeded" });
  database.close();
  return { file, invocationId: "cli-execution::cli-source" };
}

function stdout(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

describe("debug CLI", () => {
  it("prints help without opening a database", async () => {
    const output = stdout();
    expect(await runDebugCommand(["--help"])).toBe(0);
    expect(output.mock.calls.at(-1)?.[0]).toContain("find       Search durable debug evidence");
  });

  it("finds and inspects a public invocation using JSON output", async () => {
    const seeded = seedDatabase();
    const output = stdout();
    expect(await runDebugCommand(["find", "--invocation", seeded.invocationId, "--database", seeded.file])).toBe(0);
    const found = JSON.parse(output.mock.calls.at(-1)?.[0] as string);
    expect(found.invocations[0].id).toBe(seeded.invocationId);

    output.mockClear();
    expect(await runDebugCommand(["inspect", "--invocation", seeded.invocationId, "--database", seeded.file])).toBe(0);
    const inspected = JSON.parse(output.mock.calls.at(-1)?.[0] as string);
    expect(inspected.id).toBe(seeded.invocationId);
  });

  it("returns a non-zero integrity status and machine-readable doctor output", async () => {
    const seeded = seedDatabase();
    const output = stdout();
    expect(await runDebugCommand(["doctor", "--database", seeded.file])).toBe(0);
    const report = JSON.parse(output.mock.calls.at(-1)?.[0] as string);
    expect(report).toMatchObject({ schemaVersion: 9, indexFresh: true });
  });
});
