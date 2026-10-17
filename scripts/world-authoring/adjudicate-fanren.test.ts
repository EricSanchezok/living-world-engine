import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { createTestModelCatalog } from "../../src/engine/testing/model-provider";
import { directCreationContext, type DirectTestWire } from "../../src/engine/testing/direct-provider";
import { materializeSourceAdjudication, type SourceAdjudication } from "./source-adjudication";

function sourceFixture(ordinal: number) {
  const batchId = `batch-${String(ordinal).padStart(4, "0")}`, chapterId = `chapter-${ordinal}`;
  const texts = ["村医保存一份家传药方。", "药方记载止血方法，但未说明适用于所有人。"], body = `${texts.join("\n")}\n`;
  let offset = 0;
  const paragraphs = texts.map(text => { const start = offset; offset += [...text].length + 1;
    return { id: `${chapterId}:${start}`, chapterId, start, end: offset - 1, text, sha256: contentHash(text), sourceVersion: "test-source" }; });
  const batch = { id: batchId, parts: [{ chapter_id: chapterId, start: 0, end: [...body].length, sha256: contentHash(body) }] };
  const record = { sourceClaim: "村医保存家传药方。", verdict: "supported" as const, rationale: "正文明确叙述。", correction: null,
    basis: "narration" as const, opening: "unknown" as const, validTime: "本章场景", learnedTime: "本章叙述时",
    openingReason: "缺乏明确年代。", evidence: [{ paragraph: paragraphs[0]!.id }], existenceAtOpening: null };
  const canonical: SourceAdjudication = structuredClone({ chapters: [chapterId], records: [
    { id: `${batchId}-object-1`, ...record, existenceAtOpening: { status: "unknown", reason: "本章没有年龄。" } },
    { id: `${batchId}-fact-1`, ...record }], aliases: [], issues: [],
  omissions: [{ kind: "qualification", subject: "药方", description: "没有说明适用于所有人。", evidence: [{ paragraph: paragraphs[1]!.id }] }],
  identities: [{ left: "村医", right: "药方作者", relation: "unresolved", rationale: "持有人不必是作者。", evidence: [] }] });
  const materialized = materializeSourceAdjudication(canonical, paragraphs);
  const audit = (pass: string) => ({ subjectId: batchId, profileId: "old-profile", modelId: "old-model", modelMetadataHash: "test-metadata",
    modelCatalogHash: "old-catalog", promptVersion: "test-policy", invocations: [{ requestHash: contentHash(pass), responseHash: "response",
      rawOutputHash: "output", resultKind: null, context: { sections: { paragraphs: { itemCount: paragraphs.length, utf8Bytes: 160 } } } }] });
  const report = { batchId, chapters: [chapterId], approvedForRuntime: false, policyHash: "extraction-policy", schemaHash: "extraction-schema",
    identity: contentHash({ parts: batch.parts, policyHash: "extraction-policy", schemaHash: "extraction-schema", profileId: "old-profile", catalogHash: "old-catalog" }),
    audits: [audit("extract"), audit("review")],
    objects: [{ id: canonical.records[0]!.id, label: "村医", aliases: [], kind: "person", description: "药方的持有人。",
      status: "machine-reviewed-needs-adjudication", evidence: materialized.records[0]!.evidence }],
    facts: [{ id: canonical.records[1]!.id, subject: "村医", related: ["药方"], statement: "村医保存家传药方。", opening: "unknown",
      status: "machine-reviewed-needs-adjudication", evidence: materialized.records[1]!.evidence }], issues: [] };
  return { batch, chapterId, body, paragraphs, canonical, materialized, report };
}

async function inWorkspace(count: number, run: (context: {
  fixtures: ReturnType<typeof sourceFixture>[]; directory: string; logs: string[];
  runner: typeof import("./adjudicate-fanren").adjudicateFanren;
  gateway: typeof import("../../src/engine/models/model-gateway");
  testing: typeof import("../../src/engine/testing/model-provider");
  observability: typeof import("../../src/engine/runtime/observability");
}) => Promise<void>) {
  const directory = mkdtempSync(path.join(tmpdir(), "adjudication-runner-")), previousCwd = process.cwd(), previousExitCode = process.exitCode;
  const previousSignals = new Set([...process.listeners("SIGTERM"), ...process.listeners("SIGINT")]);
  const write = (file: string, value: unknown) => { const target = path.join(directory, file); mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value)); };
  const fixtures = Array.from({ length: count }, (_, index) => sourceFixture(index + 1));
  const root = "worlds/fanren/authoring", logs: string[] = [];
  write("config/models.yaml", createTestModelCatalog(["creation-deepseek"]).snapshot());
  write(`${root}/adjudication-policy.md`, "Read complete source; preserve every candidate judgment and qualify unsupported claims.");
  write(`${root}/coverage/batches.json`, fixtures.map(f => f.batch));
  write(`${root}/coverage/chapters.jsonl`, fixtures.map(f => JSON.stringify({ id: f.chapterId, source_version: "test-source" })).join("\n"));
  for (const f of fixtures) {
    write(`${root}/extractions/${f.batch.id}.json`, f.report);
    write(`.livingworld-cache/fanren-sources/chapters/${f.chapterId}.txt`, f.body);
  }
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { logs.push(String(chunk)); return true; });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { logs.push(String(chunk)); return true; });
  vi.stubEnv("LIVINGWORLD_MODEL_CATALOG_PATH", path.join(directory, "config/models.yaml"));
  try {
    process.chdir(directory);
    vi.resetModules();
    // Load all gateway classes after resetting modules so ModelOutputError keeps one identity.
    const [runner, gateway, testing, observability] = await Promise.all([
      import("./adjudicate-fanren"), import("../../src/engine/models/model-gateway"),
      import("../../src/engine/testing/model-provider"), import("../../src/engine/runtime/observability"),
    ]);
    await run({ fixtures, directory, logs, runner: runner.adjudicateFanren, gateway, testing, observability });
  } finally {
    for (const event of ["SIGINT", "SIGTERM"] as const) for (const listener of process.listeners(event)) {
      if (!previousSignals.has(listener)) process.off(event, listener);
    }
    stdout.mockRestore(); stderr.mockRestore(); vi.unstubAllEnvs();
    process.chdir(previousCwd); process.exitCode = previousExitCode;
    rmSync(directory, { recursive: true, force: true });
  }
}

function response(value: unknown): Response {
  return responseText(JSON.stringify(value));
}

function responseText(content: string): Response {
  return Response.json({ id: "local-response", object: "chat.completion", created: 1, model: "deepseek-flash",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } });
}

describe("source adjudication runner through the real model gateway", () => {
  it("recovers the exact rejected syntax locally, resumes its immutable cache with zero calls, and verifies reuse", async () => {
    await inWorkspace(1, async ({ fixtures: [f], directory, logs, runner, gateway, testing }) => {
      const { createAdjudicationTransport } = await import("./adjudication-transport");
      const transport = createAdjudicationTransport(f!.report, f!.paragraphs);
      const wire = transport.encode({ ...f!.canonical, records: f!.canonical.records.map(({ existenceAtOpening, ...rest }) => ({ existenceAtOpening, ...rest })) });
      const raw = JSON.stringify(wire).replace('"本章没有年龄。"}', '"本章没有年龄。","}');
      const fetch = vi.fn<typeof globalThis.fetch>(async () => responseText(raw));
      await runner(["--max-calls", "1"], (catalog, guardFetch) => new gateway.ModelGateway(catalog, { TEST_MODEL_API_KEY: "local-test-only" },
        { registry: testing.createTestModelRegistry(catalog), fetch: guardFetch(fetch), maxTransportAttempts: 1 }));
      expect(fetch).toHaveBeenCalledTimes(1);
      const reportFile = path.join(directory, `worlds/fanren/authoring/adjudications/${f!.batch.id}.json`);
      const saved = JSON.parse(readFileSync(reportFile, "utf8"));
      expect(saved.records).toEqual(f!.materialized.records);
      expect(saved.approvedForRuntime).toBe(false);
      expect(saved.localSyntaxRecovery).toMatchObject({ providerRejected: true, originalHash: contentHash(raw), cache: { attempt: 0 } });
      expect(saved.audits[0].invocations[0]).toMatchObject({ outputDisposition: "rejected", normalizedOutputHash: null });
      const cacheFile = path.join(directory, `.livingworld-cache/fanren-sources/adjudications/${f!.batch.id}/${saved.identity}/0.json`);
      const originalBytes = readFileSync(cacheFile, "utf8"), cached = JSON.parse(originalBytes);
      expect(cached).toMatchObject({ rejected: true, value: raw, wireValue: raw });
      expect(cached).not.toHaveProperty("localSyntaxRecovery");
      expect(logs.map(line => JSON.parse(line)).at(-1)).toMatchObject({ completed: 1, failed: 0, generationRequests: 1 });

      rmSync(reportFile);
      logs.length = 0;
      const noGateway = vi.fn(() => { throw new Error("Cached recovery must not initialize a model gateway"); });
      await runner(["--max-calls", "0"], noGateway);
      expect(noGateway).not.toHaveBeenCalled();
      const resumed = JSON.parse(readFileSync(reportFile, "utf8"));
      expect(resumed.localSyntaxRecovery).toEqual(saved.localSyntaxRecovery);
      expect(resumed.execution.recoveredFromCache).toBe(true);
      expect(readFileSync(cacheFile, "utf8")).toBe(originalBytes);
      expect(logs.map(line => JSON.parse(line)).at(-1)).toMatchObject({ completed: 1, failed: 0, generationRequests: 0 });

      logs.length = 0;
      await runner(["--plan"], noGateway);
      expect(logs.map(line => JSON.parse(line)).at(-1)).toMatchObject({ reused: 1, pending: 0, generationRequests: 0 });
      expect(noGateway).not.toHaveBeenCalled();
      expect(readFileSync(cacheFile, "utf8")).toBe(originalBytes);
    });
  });

  it("retains the existing paid fallback when local punctuation recovery fails complete coverage", async () => {
    await inWorkspace(1, async ({ fixtures: [f], directory, runner, gateway, testing }) => {
      const { createAdjudicationTransport } = await import("./adjudication-transport");
      const transport = createAdjudicationTransport(f!.report, f!.paragraphs);
      const incomplete = { ...f!.canonical, records: f!.canonical.records.slice(0, 1).map(({ existenceAtOpening, ...rest }) => ({ existenceAtOpening, ...rest })) };
      const raw = JSON.stringify(transport.encode(incomplete)).replace('"本章没有年龄。"}', '"本章没有年龄。","}');
      const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => fetch.mock.calls.length === 1 ? responseText(raw) : response(transport.encode(f!.canonical)));
      await runner(["--max-calls", "2"], (catalog, guardFetch) => new gateway.ModelGateway(catalog, { TEST_MODEL_API_KEY: "local-test-only" },
        { registry: testing.createTestModelRegistry(catalog), fetch: guardFetch(fetch), maxTransportAttempts: 1 }));
      expect(fetch).toHaveBeenCalledTimes(2);
      const saved = JSON.parse(readFileSync(path.join(directory, `worlds/fanren/authoring/adjudications/${f!.batch.id}.json`), "utf8"));
      expect(saved.records).toEqual(f!.materialized.records);
      expect(saved).not.toHaveProperty("localSyntaxRecovery");
      expect(saved.audits[0].invocations[0].outputDisposition).toBe("rejected");
      expect(saved.audits).toHaveLength(2);
    });
  });

  it("sends full source on all three requests and carries a rejected repair into the next targeted attempt", async () => {
    await inWorkspace(1, async ({ fixtures: [f], directory, logs, runner, gateway, testing }) => {
      const { createAdjudicationTransport } = await import("./adjudication-transport");
      const transport = createAdjudicationTransport(f!.report, f!.paragraphs);
      const initial = structuredClone(f!.canonical);
      initial.records[0]!.evidence = [];
      const invalidPatch = { records: [{ ...f!.canonical.records[0]!, existenceAtOpening: null }] };
      const correctedPatch = { records: [f!.canonical.records[0]] };
      const replies = [initial, invalidPatch, correctedPatch], contexts: Record<string, unknown>[] = [], userMessages: string[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        expect(init?.method).toBe("POST");
        const wire = JSON.parse(String(init?.body)) as DirectTestWire;
        contexts.push(directCreationContext(wire));
        userMessages.push(wire.messages!.find(message => message.role === "user")!.content);
        const reply = replies[contexts.length - 1];
        if (!reply) throw new Error("Unexpected extra model request");
        return response(transport.encode(reply));
      });
      await runner(["--max-calls", "3"], (catalog, guardFetch) => new gateway.ModelGateway(catalog, { TEST_MODEL_API_KEY: "local-test-only" },
        { registry: testing.createTestModelRegistry(catalog), fetch: guardFetch(fetch), maxTransportAttempts: 1 }));
      expect(fetch).toHaveBeenCalledTimes(3);
      const contextEnd = userMessages[0]!.indexOf("\n\nReturn exactly one JSON object");
      const sharedPrefix = userMessages[0]!.slice(0, contextEnd - 1);
      expect(sharedPrefix).toContain('"reviewManifest":');
      expect(userMessages.slice(1).every(message => message.startsWith(sharedPrefix))).toBe(true);
      for (const context of contexts) expect(context.paragraphs).toEqual(transport.paragraphs);
      expect(contexts[1]).toHaveProperty("revisionRequest.repair");
      expect(contexts[1]).not.toHaveProperty("draft");
      expect(contexts[2]).toMatchObject({ revisionRequest: { lastRepairFailure: { value: transport.encode(invalidPatch), problems: expect.stringContaining("existence time") } } });
      const saved = JSON.parse(readFileSync(path.join(directory, `worlds/fanren/authoring/adjudications/${f!.batch.id}.json`), "utf8"));
      expect(saved.records).toEqual(f!.materialized.records);
      expect(saved.records[1]).toEqual(f!.materialized.records[1]);
      expect(saved.omissions).toEqual(f!.materialized.omissions);
      expect(saved.identities).toEqual(f!.materialized.identities);
      expect(saved.approvedForRuntime).toBe(false);
      expect(saved.audits).toHaveLength(3);
      expect(saved.audits.every((audit: { invocations: Array<{ context: { sections: { paragraphs: { itemCount: number } } } }> }) =>
        audit.invocations[0]!.context.sections.paragraphs.itemCount === f!.paragraphs.length)).toBe(true);
      const cacheRoot = path.join(directory, `.livingworld-cache/fanren-sources/adjudications/${f!.batch.id}`);
      const identity = readdirSync(cacheRoot)[0]!;
      const rejected = JSON.parse(readFileSync(path.join(cacheRoot, identity, "1.json"), "utf8"));
      expect(rejected.value).toEqual(initial);
      expect(rejected.lastRepairFailure).toMatchObject({ value: invalidPatch, problems: expect.stringContaining("existence time") });
      expect(logs.map(line => JSON.parse(line)).at(-1)).toMatchObject({ status: "finished", generationRequests: 3, completed: 1, failed: 0 });
    });
  });

  it("cancels queued work on stop while preserving the in-flight HTTP result and its audit", async () => {
    await inWorkspace(2, async ({ fixtures, directory, logs, runner, gateway, testing, observability }) => {
      const { createAdjudicationTransport } = await import("./adjudication-transport");
      const observer = new observability.RecordingRuntimeObserver({ mode: "metrics" });
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      let activeSignal: AbortSignal | undefined, activeBatch: string | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        activeSignal = init?.signal ?? undefined;
        const context = directCreationContext(JSON.parse(String(init?.body)) as DirectTestWire);
        activeBatch = context.batch as string;
        const f = fixtures.find(item => item.batch.id === activeBatch)!;
        await released;
        return response(createAdjudicationTransport(f.report, f.paragraphs).encode(f.canonical));
      });
      const running = runner(["--count", "2", "--concurrency", "2", "--account-concurrency", "1", "--max-calls", "2"],
        (catalog, guardFetch) => new gateway.ModelGateway(catalog, { TEST_MODEL_API_KEY: "local-test-only" },
          { registry: testing.createTestModelRegistry(catalog), fetch: guardFetch(fetch), observer, maxTransportAttempts: 1 }));
      try {
        await expect.poll(() => observer.events.filter(event => event.event === "model.queue.started").length).toBe(2);
        expect(fetch).toHaveBeenCalledTimes(1);
        process.emit("SIGTERM");
        await expect.poll(() => logs.some(line => line.includes("cancelled-before-dispatch"))).toBe(true);
        expect(activeSignal?.aborted).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally { release(); await running; }
      const successful = path.join(directory, `worlds/fanren/authoring/adjudications/${activeBatch}.json`);
      const queued = fixtures.find(f => f.batch.id !== activeBatch)!;
      expect(existsSync(successful)).toBe(true);
      expect(existsSync(path.join(directory, `worlds/fanren/authoring/adjudications/${queued.batch.id}.json`))).toBe(false);
      expect(existsSync(path.join(directory, `.livingworld-cache/fanren-sources/adjudications/${queued.batch.id}-failure.json`))).toBe(false);
      const saved = JSON.parse(readFileSync(successful, "utf8"));
      expect(saved.audits).toHaveLength(1);
      expect(saved.audits[0].invocations[0].tokenUsage.input).toBe(100);
      expect(observer.events.filter(event => event.event === "model.transport.started")).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(logs.map(line => JSON.parse(line)).at(-1)).toMatchObject({ status: "stopped", generationRequests: 2, completed: 1, failed: 0 });
    });
  });

  it("stops queued HTTP dispatch when the active account reports payment required", async () => {
    await inWorkspace(2, async ({ fixtures, logs, runner, gateway, testing, observability }) => {
      const { createAdjudicationTransport } = await import("./adjudication-transport");
      const observer = new observability.RecordingRuntimeObserver({ mode: "metrics" });
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const context = directCreationContext(JSON.parse(String(init?.body)) as DirectTestWire);
        const f = fixtures.find(item => item.batch.id === context.batch)!;
        if (fetch.mock.calls.length === 1) {
          await released;
          return Response.json({ error: { message: "test account balance exhausted", type: "insufficient_balance" } }, { status: 402 });
        }
        return response(createAdjudicationTransport(f.report, f.paragraphs).encode(f.canonical));
      });
      const running = runner(["--count", "2", "--concurrency", "2", "--account-concurrency", "1", "--max-calls", "2"],
        (catalog, guardFetch) => new gateway.ModelGateway(catalog, { TEST_MODEL_API_KEY: "local-test-only" },
          { registry: testing.createTestModelRegistry(catalog), fetch: guardFetch(fetch), observer, maxTransportAttempts: 1 }));
      try {
        await expect.poll(() => observer.events.filter(event => event.event === "model.queue.started").length).toBe(2);
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally { release(); await running; }
      expect(logs.some(line => line.includes("payment-required"))).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(logs.map(line => JSON.parse(line)).at(-1)).toMatchObject({ status: "stopped", generationRequests: 2, completed: 0, failed: 1 });
    });
  });
});
