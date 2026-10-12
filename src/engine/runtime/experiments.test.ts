import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EAGER_REFERENCE_ALGORITHM_REF, eagerReferenceAlgorithmRef, registerBuiltinAlgorithms } from "../algorithms/registry";
import { DEFAULT_EAGER_REFERENCE_CONFIG } from "../algorithms/eager-reference/eager-reference";
import { defineAlgorithmRef, type AlgorithmRef, type AlgorithmRole } from "../algorithms/composition";
import { WorldExecutionAlgorithmRegistry } from "./execution";
import {
  AlgorithmExperimentRegistry,
  defineAlgorithmExperimentManifest,
  experimentAssignmentBucket,
  validateAlgorithmExperimentManifest,
} from "./experiments";

function replaceChild<R extends AlgorithmRole>(
  ref: AlgorithmRef<R>,
  slot: string,
  child: AlgorithmRef,
): AlgorithmRef<R> {
  return defineAlgorithmRef({
    role: ref.role,
    id: ref.id,
    version: ref.version,
    contractVersion: ref.contractVersion,
    config: ref.config,
    children: { ...ref.children, [slot]: child },
  });
}

function fixture() {
  const algorithms = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
  const manifest = defineAlgorithmExperimentManifest({
    id: "candidate-retrieval-canary",
    version: "1",
    salt: "fixture-salt",
    eligibility: { worldContentHashes: [`sha256:${"1".repeat(64)}`] },
    variants: [
      { id: "control", allocationBasisPoints: 7_000, algorithmRef: EAGER_REFERENCE_ALGORITHM_REF },
      { id: "treatment", allocationBasisPoints: 3_000, algorithmRef: eagerReferenceAlgorithmRef({ ...DEFAULT_EAGER_REFERENCE_CONFIG, actionCompilationMaxSlots: 1 }) },
    ],
    activationEvidence: { artifactHash: `sha256:${"2".repeat(64)}`, verifier: "npm run fixture" },
  });
  const registry = new AlgorithmExperimentRegistry(algorithms);
  registry.register(manifest);
  registry.activate(manifest.id, manifest.version);
  return { registry, manifest };
}

describe("algorithm experiment registry", () => {
  it("uses a stable domain-separated basis-point bucket", () => {
    const input = { experimentManifestHash: `sha256:${"1".repeat(64)}`, salt: "salt", instanceId: "instance-1", assignmentVersion: "v1" };
    const bucket = experimentAssignmentBucket(input);
    expect(experimentAssignmentBucket(input)).toBe(bucket);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(10_000);
  });

  it("assigns and validates immutable instance enrollment", () => {
    const { registry, manifest } = fixture();
    const first = registry.enrollment({
      instanceId: "instance-1",
      worldContentHash: manifest.eligibility.worldContentHashes[0]!,
      defaultAlgorithmRef: EAGER_REFERENCE_ALGORITHM_REF,
      explicitExecutionTuning: false,
    });
    const repeated = registry.enrollment({
      instanceId: "instance-1",
      worldContentHash: manifest.eligibility.worldContentHashes[0]!,
      defaultAlgorithmRef: EAGER_REFERENCE_ALGORITHM_REF,
      explicitExecutionTuning: false,
    });
    expect(first).toEqual(repeated);
    expect(first.enrollment?.bucket).toBeGreaterThanOrEqual(0);
    expect(first.enrollment?.bucket).toBeLessThan(10_000);
    registry.validateEnrollment("instance-1", first.enrollment!);
  });

  it("excludes explicit tuning and fails when historical manifest evidence is missing", () => {
    const { registry, manifest } = fixture();
    expect(registry.enrollment({
      instanceId: "instance-1",
      worldContentHash: manifest.eligibility.worldContentHashes[0]!,
      defaultAlgorithmRef: EAGER_REFERENCE_ALGORITHM_REF,
      explicitExecutionTuning: true,
    })).toMatchObject({ enrollment: null, exclusionReason: "explicit-execution-tuning" });
    const enrollment = registry.enrollment({
      instanceId: "instance-2",
      worldContentHash: manifest.eligibility.worldContentHashes[0]!,
      defaultAlgorithmRef: EAGER_REFERENCE_ALGORITHM_REF,
      explicitExecutionTuning: false,
    }).enrollment!;
    const empty = new AlgorithmExperimentRegistry(registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry()));
    expect(() => empty.validateEnrollment("instance-2", enrollment)).toThrow(/historical experiment manifest is missing/u);
  });

  it("rejects allocation and manifest hash drift", () => {
    const { manifest } = fixture();
    expect(() => validateAlgorithmExperimentManifest({
      ...manifest,
      variants: manifest.variants.map((variant, index) => ({ ...variant, allocationBasisPoints: index === 0 ? 6_999 : 3_000 })),
    })).toThrow(/sum to 10000/u);
    expect(() => validateAlgorithmExperimentManifest({ ...manifest, salt: "changed" })).toThrow(/hash mismatch/u);
  });

  it("rejects diagnostic algorithms anywhere in an experiment composition", () => {
    const algorithms = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
    algorithms.registerAlgorithmDefinition({
      role: "candidate-selection",
      id: "diagnostic-selector",
      version: "1",
      contractVersion: 1,
      maturity: "diagnostic",
      configSchema: z.strictObject({}),
      children: [],
      create: () => ({
        algorithmIdentity: {
          role: "candidate-selection",
          id: "diagnostic-selector",
          version: "1",
          contractVersion: 1,
        },
      }),
    });
    const diagnosticSelection = defineAlgorithmRef({
      role: "candidate-selection",
      id: "diagnostic-selector",
      version: "1",
      contractVersion: 1,
      config: {},
    });
    const actionCompilation = replaceChild(
      EAGER_REFERENCE_ALGORITHM_REF.children.actionCompilation!,
      "candidateSelection",
      diagnosticSelection,
    );
    const composition = replaceChild(EAGER_REFERENCE_ALGORITHM_REF, "actionCompilation", actionCompilation);
    const manifest = defineAlgorithmExperimentManifest({
      id: "invalid-diagnostic-experiment",
      version: "1",
      salt: "fixture-salt",
      eligibility: { worldContentHashes: [] },
      variants: [
        { id: "control", allocationBasisPoints: 5_000, algorithmRef: EAGER_REFERENCE_ALGORITHM_REF },
        { id: "diagnostic", allocationBasisPoints: 5_000, algorithmRef: composition },
      ],
      activationEvidence: { artifactHash: `sha256:${"2".repeat(64)}`, verifier: "npm run fixture" },
    });

    expect(() => new AlgorithmExperimentRegistry(algorithms).register(manifest))
      .toThrow("root.actionCompilation.candidateSelection algorithm maturity is not allowed");
  });

  it("stops only future enrollment after a safety violation", () => {
    const { registry, manifest } = fixture();
    const existing = registry.enrollment({
      instanceId: "existing",
      worldContentHash: manifest.eligibility.worldContentHashes[0]!,
      defaultAlgorithmRef: EAGER_REFERENCE_ALGORITHM_REF,
      explicitExecutionTuning: false,
    }).enrollment!;
    registry.stopNewEnrollment("cache integrity failure");
    expect(registry.enrollmentStatus()).toEqual({ stopped: true, reason: "cache integrity failure" });
    expect(registry.enrollment({
      instanceId: "new",
      worldContentHash: manifest.eligibility.worldContentHashes[0]!,
      defaultAlgorithmRef: EAGER_REFERENCE_ALGORITHM_REF,
      explicitExecutionTuning: false,
    })).toMatchObject({ enrollment: null, exclusionReason: "experiment-stopped", exclusionDetail: "cache integrity failure" });
    expect(() => registry.validateEnrollment("existing", existing)).not.toThrow();
  });

  it("restores a persisted enrollment stop after process restart", () => {
    const stored = new Map<string, string>();
    const safetyStore = {
      readExperimentEnrollmentStop: (id: string, version: string) => stored.get(`${id}@${version}`),
      writeExperimentEnrollmentStop: (id: string, version: string, reason: string) => { stored.set(`${id}@${version}`, reason); },
    };
    const firstFixture = fixture();
    const first = new AlgorithmExperimentRegistry(
      registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry()),
      safetyStore,
    );
    first.register(firstFixture.manifest);
    first.activate(firstFixture.manifest.id, firstFixture.manifest.version);
    first.stopNewEnrollment("manifest drift");

    const recovered = new AlgorithmExperimentRegistry(
      registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry()),
      safetyStore,
    );
    recovered.register(firstFixture.manifest);
    recovered.activate(firstFixture.manifest.id, firstFixture.manifest.version);
    expect(recovered.enrollmentStatus()).toEqual({ stopped: true, reason: "manifest drift" });
  });
});
