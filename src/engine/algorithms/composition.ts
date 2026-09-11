import type { z } from "zod";
import { contentHash } from "../models/model-audit";
import {
  assertJsonObject,
  assertJsonValue,
  frozenClone,
  type JsonObject,
} from "../runtime/json";

export const ALGORITHM_ROLES = [
  "world-execution",
  "agent-cognition",
  "action-compilation",
  "candidate-selection",
  "candidate-ranking",
  "candidate-allocation",
  "symbol-repair",
  "interaction-grounding",
  "reaction-resolution",
  "onset-perception",
  "reaction-decision",
  "truth-resolution",
  "observation-rendering",
  "work-batching",
  "work-scheduling",
  "output-recovery",
] as const;

export type AlgorithmRole = typeof ALGORITHM_ROLES[number];
export type AlgorithmMaturity = "reference" | "candidate" | "diagnostic";

export interface AlgorithmRef<R extends AlgorithmRole = AlgorithmRole> {
  role: R;
  id: string;
  version: string;
  contractVersion: number;
  config: JsonObject;
  children: Readonly<Record<string, AlgorithmRef>>;
  manifestHash: string;
}

export interface AlgorithmIdentity<R extends AlgorithmRole = AlgorithmRole> {
  role: R;
  id: string;
  version: string;
  contractVersion: number;
}

export interface AlgorithmImplementation<R extends AlgorithmRole = AlgorithmRole> {
  readonly algorithmIdentity: AlgorithmIdentity<R>;
}

export interface AlgorithmChildSlot {
  name: string;
  role: AlgorithmRole;
}

export interface ResolvedAlgorithm<R extends AlgorithmRole = AlgorithmRole> {
  readonly path: string;
  readonly ref: AlgorithmRef<R>;
  readonly implementation: AlgorithmImplementation<R>;
  readonly children: Readonly<Record<string, ResolvedAlgorithm>>;
}

export interface AlgorithmFactoryContext<Services extends object> {
  readonly services: Readonly<Services>;
  readonly path: string;
  readonly ref: AlgorithmRef;
  readonly children: Readonly<Record<string, ResolvedAlgorithm>>;
}

export interface AlgorithmDefinition<
  R extends AlgorithmRole = AlgorithmRole,
  Services extends object = Record<string, never>,
> extends AlgorithmIdentity<R> {
  readonly maturity: AlgorithmMaturity;
  readonly configSchema: z.ZodType<unknown>;
  readonly children: readonly AlgorithmChildSlot[];
  readonly create: (context: AlgorithmFactoryContext<Services>) => AlgorithmImplementation<R>;
  readonly preflight?: (context: Omit<AlgorithmFactoryContext<Services>, "children">) => void;
}

export interface AlgorithmCatalogEntry extends AlgorithmIdentity {
  maturity: AlgorithmMaturity;
  childRoles: Readonly<Record<string, AlgorithmRole>>;
}

const roles = new Set<string>(ALGORITHM_ROLES);
const identityFields = ["role", "id", "version", "contractVersion"] as const;
const refFields = [...identityFields, "config", "children", "manifestHash"].sort();

function requiredText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required`);
}

function validateAlgorithmId(value: unknown, label: string): asserts value is string {
  requiredText(value, label);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new Error(`${label} must be kebab-case`);
  }
}

function validateAlgorithmVersion(value: unknown, label: string): asserts value is string {
  requiredText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
}

function validateRole(value: unknown, label: string): asserts value is AlgorithmRole {
  if (typeof value !== "string" || !roles.has(value)) throw new Error(`${label} is invalid: ${String(value)}`);
}

function validateIdentity(value: AlgorithmIdentity, label: string): void {
  validateRole(value.role, `${label} role`);
  validateAlgorithmId(value.id, `${label} id`);
  validateAlgorithmVersion(value.version, `${label} version`);
  if (!Number.isSafeInteger(value.contractVersion) || value.contractVersion < 1) {
    throw new Error(`${label} contract version must be a positive integer`);
  }
}

function refBody<R extends AlgorithmRole>(ref: Omit<AlgorithmRef<R>, "manifestHash">): Omit<AlgorithmRef<R>, "manifestHash"> {
  return frozenClone(ref);
}

export function defineAlgorithmRef<R extends AlgorithmRole>(input: {
  role: R;
  id: string;
  version: string;
  contractVersion: number;
  config: JsonObject;
  children?: Readonly<Record<string, AlgorithmRef>>;
}): AlgorithmRef<R> {
  validateIdentity(input, "algorithm");
  assertJsonObject(input.config, "algorithm config");
  for (const [slot, child] of Object.entries(input.children ?? {})) {
    requiredText(slot, "algorithm child slot");
    if (!/^[a-z][A-Za-z0-9]*$/u.test(slot)) throw new Error(`algorithm child slot is invalid: ${slot}`);
    validateAlgorithmRef(child, `root.${slot}`);
  }
  const body = refBody({
    role: input.role,
    id: input.id,
    version: input.version,
    contractVersion: input.contractVersion,
    config: input.config,
    children: input.children ?? {},
  });
  const ref = frozenClone({ ...body, manifestHash: contentHash(body) });
  validateAlgorithmRef(ref);
  return ref;
}

export function validateAlgorithmRef(ref: AlgorithmRef, path = "root", ancestors = new Set<object>()): void {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) throw new Error(`${path} algorithm reference is required`);
  if (ancestors.has(ref)) throw new Error(`${path} algorithm reference must not contain cycles`);
  ancestors.add(ref);
  const keys = Object.keys(ref).sort();
  if (JSON.stringify(keys) !== JSON.stringify(refFields)) {
    throw new Error(`${path} algorithm reference fields must be exactly: ${refFields.join(", ")}`);
  }
  validateIdentity(ref, `${path} algorithm`);
  assertJsonObject(ref.config, `${path} algorithm config`);
  if (!ref.children || typeof ref.children !== "object" || Array.isArray(ref.children)) {
    throw new Error(`${path} algorithm children must be an object`);
  }
  for (const [slot, child] of Object.entries(ref.children)) {
    requiredText(slot, `${path} child slot`);
    if (!/^[a-z][A-Za-z0-9]*$/u.test(slot)) {
      throw new Error(`${path} child slot is invalid: ${slot}`);
    }
    validateAlgorithmRef(child, `${path}.${slot}`, ancestors);
  }
  requiredText(ref.manifestHash, `${path} algorithm manifest hash`);
  const { manifestHash, ...body } = ref;
  if (contentHash(body) !== manifestHash) {
    throw new Error(`${path} algorithm manifest hash mismatch: ${ref.role}/${ref.id}@${ref.version}`);
  }
  ancestors.delete(ref);
}

function definitionKey(identity: AlgorithmIdentity): string {
  return `${identity.role}/${identity.id}@${identity.version}`;
}

function sameIdentity(left: AlgorithmIdentity, right: AlgorithmIdentity): boolean {
  return identityFields.every((field) => left[field] === right[field]);
}

export class AlgorithmRegistry<Services extends object = Record<string, never>> {
  private readonly definitions = new Map<string, AlgorithmDefinition<AlgorithmRole, Services>>();
  private readonly instances = new WeakSet<object>();

  register<R extends AlgorithmRole>(definition: AlgorithmDefinition<R, Services>): void {
    validateIdentity(definition, "algorithm definition");
    if (!(["reference", "candidate", "diagnostic"] as const).includes(definition.maturity)) {
      throw new Error(`algorithm definition maturity is invalid: ${String(definition.maturity)}`);
    }
    if (!definition.configSchema || typeof definition.configSchema.safeParse !== "function") {
      throw new Error("algorithm definition requires a configuration schema");
    }
    if (typeof definition.create !== "function") throw new Error("algorithm definition requires a factory");
    const slotNames = new Set<string>();
    for (const child of definition.children) {
      requiredText(child.name, "algorithm child slot name");
      if (!/^[a-z][A-Za-z0-9]*$/u.test(child.name)) throw new Error(`algorithm child slot is invalid: ${child.name}`);
      if (slotNames.has(child.name)) throw new Error(`algorithm definition contains duplicate child slot: ${child.name}`);
      slotNames.add(child.name);
      validateRole(child.role, `algorithm child ${child.name} role`);
    }
    const key = definitionKey(definition);
    if (this.definitions.has(key)) throw new Error(`algorithm is already registered: ${key}`);
    const registered = Object.freeze({
      ...definition,
      children: Object.freeze(definition.children.map((child) => Object.freeze({ ...child }))),
    }) as AlgorithmDefinition<AlgorithmRole, Services>;
    this.definitions.set(key, registered);
  }

  list(): readonly AlgorithmCatalogEntry[] {
    return [...this.definitions.values()]
      .map((definition) => ({
        role: definition.role,
        id: definition.id,
        version: definition.version,
        contractVersion: definition.contractVersion,
        maturity: definition.maturity,
        childRoles: Object.fromEntries(definition.children.map((child) => [child.name, child.role])),
      }))
      .sort((left, right) => definitionKey(left).localeCompare(definitionKey(right)));
  }

  has(ref: AlgorithmRef): boolean {
    try {
      this.validateTree(ref);
      return true;
    } catch {
      return false;
    }
  }

  validateTree(ref: AlgorithmRef): void {
    validateAlgorithmRef(ref);
    this.validateNode(ref, "root");
  }

  validateTreeMaturity(ref: AlgorithmRef, allowed: readonly AlgorithmMaturity[]): void {
    this.validateTree(ref);
    const allowedMaturities = new Set(allowed);
    this.validateNodeMaturity(ref, "root", allowedMaturities);
  }

  resolve<R extends AlgorithmRole>(ref: AlgorithmRef<R>, services: Readonly<Services>): ResolvedAlgorithm<R> {
    this.validateTree(ref);
    const snapshot = frozenClone(ref);
    return this.resolveNode(snapshot, services, "root") as ResolvedAlgorithm<R>;
  }

  private definition(ref: AlgorithmRef): AlgorithmDefinition<AlgorithmRole, Services> {
    const key = definitionKey(ref);
    const definition = this.definitions.get(key);
    if (!definition) throw new Error(`algorithm is not registered: ${key}`);
    return definition;
  }

  private validateNode(ref: AlgorithmRef, path: string): void {
    const definition = this.definition(ref);
    if (definition.contractVersion !== ref.contractVersion) {
      throw new Error(`${path} algorithm contract version is not registered: ${definitionKey(ref)}#${ref.contractVersion}`);
    }
    const parsed = definition.configSchema.safeParse(ref.config);
    if (!parsed.success) throw new Error(`${path} algorithm config is invalid: ${definitionKey(ref)}`);
    assertJsonValue(parsed.data, `${path} parsed algorithm config`);
    if (contentHash(parsed.data) !== contentHash(ref.config)) {
      throw new Error(`${path} algorithm config must be explicit and canonical: ${definitionKey(ref)}`);
    }
    const expected = new Map(definition.children.map((child) => [child.name, child.role]));
    const actualSlots = Object.keys(ref.children).sort();
    const expectedSlots = [...expected.keys()].sort();
    if (JSON.stringify(actualSlots) !== JSON.stringify(expectedSlots)) {
      throw new Error(`${path} algorithm child slots must be exactly: ${expectedSlots.join(", ")}`);
    }
    for (const [slot, child] of Object.entries(ref.children)) {
      const expectedRole = expected.get(slot);
      if (child.role !== expectedRole) {
        throw new Error(`${path}.${slot} algorithm role must be ${expectedRole}, got ${child.role}`);
      }
      this.validateNode(child, `${path}.${slot}`);
    }
  }

  private validateNodeMaturity(
    ref: AlgorithmRef,
    path: string,
    allowed: ReadonlySet<AlgorithmMaturity>,
  ): void {
    const definition = this.definition(ref);
    if (!allowed.has(definition.maturity)) {
      throw new Error(`${path} algorithm maturity is not allowed: ${definitionKey(ref)} is ${definition.maturity}`);
    }
    for (const [slot, child] of Object.entries(ref.children)) {
      this.validateNodeMaturity(child, `${path}.${slot}`, allowed);
    }
  }

  private resolveNode(ref: AlgorithmRef, services: Readonly<Services>, path: string): ResolvedAlgorithm {
    const definition = this.definition(ref);
    const children = Object.fromEntries(
      Object.entries(ref.children).map(([slot, child]) => [slot, this.resolveNode(child, services, `${path}.${slot}`)]),
    );
    const context = { services, path, ref, children };
    definition.preflight?.({ services, path, ref });
    const implementation = definition.create(context);
    if (!implementation || typeof implementation !== "object") {
      throw new Error(`${path} algorithm factory did not return an implementation: ${definitionKey(ref)}`);
    }
    if (!implementation.algorithmIdentity || !sameIdentity(implementation.algorithmIdentity, definition)) {
      throw new Error(`${path} algorithm factory returned the wrong identity: ${definitionKey(ref)}`);
    }
    if (this.instances.has(implementation)) {
      throw new Error(`${path} algorithm factory reused an implementation: ${definitionKey(ref)}`);
    }
    this.instances.add(implementation);
    return Object.freeze({
      path,
      ref,
      implementation,
      children: Object.freeze(children),
    });
  }
}
