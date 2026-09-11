import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadWorldScript } from "../../../script/world-loader";
import {
  algorithmRef,
  defineAlgorithmManifest,
  WorldExecutionAlgorithmRegistry,
  type AlgorithmManifest,
  type BootstrapCandidate,
  type BootstrapInput,
  type ExecutionContext,
  type WorldExecutionAlgorithm,
  type WorldStepCandidate,
  type WorldStepInput,
  type WorldStepPreparation,
} from "../execution";
import { contentHash } from "../../models/model-audit";
import { SimulationEngine } from "../simulation";
import { createTestModelCatalog } from "../../testing/model-provider";

const fixture = path.resolve("test/fixtures/open-world-script");

function algorithmManifest(id = "mutation-probe"): AlgorithmManifest {
  return defineAlgorithmManifest({ id, version: "1", config: {}, children: {} });
}

class MutatingAlgorithm implements WorldExecutionAlgorithm {
  constructor(readonly manifest = algorithmManifest()) {}

  async bootstrap(input: Readonly<BootstrapInput>, context: ExecutionContext): Promise<BootstrapCandidate> {
    void context;
    (input.state as { truth: { elapsedSeconds: number } }).truth.elapsedSeconds = 999;
    throw new Error("candidate generation failed");
  }

  async prepareStep(input: Readonly<WorldStepInput>, context: ExecutionContext): Promise<WorldStepPreparation> {
    void input;
    void context;
    throw new Error("unused");
  }

  async completeStep(
    input: Readonly<WorldStepInput>,
    preparation: Readonly<WorldStepPreparation>,
    reactions: readonly import("../execution").ExternalReactionInput[],
    context: ExecutionContext,
  ): Promise<WorldStepCandidate> {
    void input;
    void preparation;
    void reactions;
    void context;
    throw new Error("unused");
  }
}

describe("execution kernel boundary", () => {
  it("does not expose canonical state write capability to an algorithm", async () => {
    const definition = loadWorldScript(fixture, { modelCatalog: createTestModelCatalog() });
    const engine = new SimulationEngine(definition, new MutatingAlgorithm());
    const before = contentHash(engine.snapshot);

    await expect(engine.bootstrapAgents()).rejects.toThrow("candidate generation failed");
    expect(contentHash(engine.snapshot)).toBe(before);
    expect(engine.snapshot.truth.elapsedSeconds).toBe(0);
  });

  it("pins a factory to the registered manifest hash", () => {
    const registry = new WorldExecutionAlgorithmRegistry();
    const registered = algorithmManifest("registered");
    registry.register(registered, () => new MutatingAlgorithm(registered));
    expect(registry.create(algorithmRef(registered), { provider: {} as never }).manifest.hash).toBe(registered.hash);

    const invalid = { ...registered, hash: "0".repeat(64) };
    expect(() => new WorldExecutionAlgorithmRegistry().register(invalid, () => new MutatingAlgorithm()))
      .toThrow("manifest hash mismatch");
  });

  it("resolves multiple opaque configurations through one algorithm definition", () => {
    const registry = new WorldExecutionAlgorithmRegistry();
    const configuredManifest = (config: import("../execution").JsonObject) => defineAlgorithmManifest({
      id: "configured",
      version: "1",
      config,
      children: {},
    });
    registry.registerDefinition({
      role: "world-execution",
      id: "configured",
      version: "1",
      contractVersion: 7,
      maturity: "diagnostic",
      configSchema: z.strictObject({ slots: z.number().int().positive() }),
      children: [],
      create: ({ ref }) => new MutatingAlgorithm(configuredManifest(ref.config)),
    });
    const first = algorithmRef(configuredManifest({ slots: 2 }));
    const second = algorithmRef(configuredManifest({ slots: 7 }));

    expect(registry.has(first)).toBe(true);
    expect(registry.has(second)).toBe(true);
    expect(registry.create(first, { provider: {} as never }).manifest.config).toEqual({ slots: 2 });
    expect(registry.create(second, { provider: {} as never }).manifest.config).toEqual({ slots: 7 });
    expect(registry.has({ ...first, config: { slots: 3 } })).toBe(false);
  });

  it("rejects malformed manifest configuration and component identities", () => {
    expect(() => defineAlgorithmManifest({
      id: "invalid-json",
      version: "1",
      config: { callback: (() => undefined) as never },
      children: {},
    })).toThrow("JSON-safe");
    expect(() => defineAlgorithmManifest({
      id: "blank-version",
      version: " ",
      config: {},
      children: {},
    })).toThrow("version is required");
    const symbolConfig = { visible: true } as Record<PropertyKey, unknown>;
    symbolConfig[Symbol("hidden")] = "not-hashed";
    expect(() => defineAlgorithmManifest({
      id: "symbol-config",
      version: "1",
      config: symbolConfig as never,
      children: {},
    })).toThrow("symbol keys");
    const hiddenConfig = {};
    Object.defineProperty(hiddenConfig, "hidden", { value: true, enumerable: false });
    expect(() => defineAlgorithmManifest({
      id: "hidden-config",
      version: "1",
      config: hiddenConfig,
      children: {},
    })).toThrow("enumerable data property");
    const valid = algorithmManifest("extra-field");
    expect(() => new WorldExecutionAlgorithmRegistry().register(
      { ...valid, uncommittedMetadata: true } as never,
      () => new MutatingAlgorithm(valid),
    )).toThrow("manifest fields must be exactly");
  });

  it("rejects unsupported contracts, unknown hashes, and wrong factory manifests", () => {
    const registered = algorithmManifest("registered");
    const unsupported = { ...registered, contractVersion: 1 } as unknown as AlgorithmManifest;
    expect(() => new WorldExecutionAlgorithmRegistry().register(unsupported, () => new MutatingAlgorithm()))
      .toThrow("unsupported execution algorithm contract version");

    const registry = new WorldExecutionAlgorithmRegistry();
    registry.register(registered, () => new MutatingAlgorithm(algorithmManifest("different")));
    expect(() => registry.create(algorithmRef(registered), { provider: {} as never }))
      .toThrow("factory returned the wrong manifest");
    expect(() => registry.create({
      ...algorithmRef(registered),
      manifestHash: "sha256:unknown",
    }, { provider: {} as never })).toThrow("manifest hash mismatch");

    const incompleteManifest = algorithmManifest("incomplete");
    const incompleteRegistry = new WorldExecutionAlgorithmRegistry();
    incompleteRegistry.register(incompleteManifest, () => ({ manifest: incompleteManifest }) as never);
    expect(() => incompleteRegistry.create(algorithmRef(incompleteManifest), { provider: {} as never }))
      .toThrow("incomplete algorithm contract");
  });

  it("requires a fresh algorithm instance from every factory call", () => {
    const manifest = algorithmManifest("fresh-instance");
    const singleton = new MutatingAlgorithm(manifest);
    const registry = new WorldExecutionAlgorithmRegistry();
    registry.register(manifest, () => singleton);

    registry.create(algorithmRef(manifest), { provider: {} as never });
    expect(() => registry.create(algorithmRef(manifest), { provider: {} as never }))
      .toThrow("reused an algorithm instance");
  });
});
