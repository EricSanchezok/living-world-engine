import { z } from "zod";
import { containsStandaloneExplicitNumber, parseExplicitNumber } from "./explicit-number";
import { worldDeltaOperationSchema } from "../contracts/llm-schemas";
import type {
  AgentActionProposal,
  CausalAssertion,
  D20CheckRequest,
  D20CheckResult,
  DiscreteRandomRequest,
  DiscreteRandomResult,
  MechanicInvocation,
  MechanicResult,
  SimulationState,
  WorldDeltaOperation,
} from "../contracts/model";
import type { ResolutionPlan, ResolutionReceipt } from "./resolution";
import {
  deriveClampedMeterDelta,
  materializeCondition,
  mergeCondition,
} from "./resolution";
import { quantityId } from "../runtime/runtime-id";

export interface RulePackageReference {
  id: string;
  version: string;
  config: unknown;
  adjudication: string;
  rules: Array<{ id: string; description: string }>;
}

export interface MechanicPromptContract {
  packageId: string;
  version: string;
  ruleId: string;
  description: string;
  inputSchema: unknown;
}

/**
 * Project a runtime mechanic input schema into the vocabulary used by the
 * model protocol. Runtime rules intentionally keep `*Id`/`*Ids` fields: the
 * rule implementation receives canonical identities after materialization.
 * A model must see the same typed shape with `*Ref`/`*Refs` fields instead, so
 * it cannot mistake an engine id for a model-owned value. This only rewrites
 * JSON Schema metadata; runtime validation continues to use the authored
 * Zod schema in the registry.
 */
export function projectMechanicInputSchema(input: unknown): unknown {
  const rewriteKey = (key: string): string =>
    key.endsWith("Ids") ? `${key.slice(0, -3)}Refs` :
      key.endsWith("Id") ? `${key.slice(0, -2)}Ref` : key;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object)) {
      if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
        const properties: Record<string, unknown> = {};
        for (const [propertyName, propertySchema] of Object.entries(child as Record<string, unknown>)) {
          const modelName = rewriteKey(propertyName);
          const projected = visit(propertySchema);
          if (modelName !== propertyName && projected && typeof projected === "object" && !Array.isArray(projected)) {
            const schema = projected as Record<string, unknown>;
            const description = typeof schema.description === "string" ? schema.description : "";
            const hint = "模型引用字段：使用当前请求目录中的 ref 句柄，不要填写引擎 ID。";
            const next: Record<string, unknown> = {
              ...schema,
              description: description ? `${description} ${hint}` : hint,
            };
            if (next.type === "string" && next.pattern === undefined) next.pattern = "^ref:";
            if (next.type === "array" && next.items && typeof next.items === "object" && !Array.isArray(next.items)) {
              const items = { ...(next.items as Record<string, unknown>) };
              if (items.type === "string" && items.pattern === undefined) items.pattern = "^ref:";
              next.items = items;
            }
            properties[modelName] = next;
          } else {
            properties[modelName] = projected;
          }
        }
        output[key] = properties;
        continue;
      }
      if (key === "required" && Array.isArray(child)) {
        output[key] = child.map((entry) => typeof entry === "string" ? rewriteKey(entry) : entry);
        continue;
      }
      output[key] = visit(child);
    }
    return output;
  };
  return visit(input);
}

export interface MechanicInputValidationIssue {
  path: Array<string | number>;
  message: string;
}

/**
 * A model-produced mechanic input is a quality failure owned by one
 * invocation.  It must never be interpreted as evidence that the action has
 * world-wide interaction scope.
 */
export class MechanicInputValidationError extends Error {
  readonly invocationId: string;
  readonly packageId: string;
  readonly ruleId: string;
  readonly issues: readonly MechanicInputValidationIssue[];

  constructor(input: {
    invocationId: string;
    packageId: string;
    ruleId: string;
    issues: readonly MechanicInputValidationIssue[];
    cause?: unknown;
  }) {
    super(
      `mechanic ${input.invocationId} input does not satisfy ` +
      `${input.packageId}/${input.ruleId}: ${input.issues.map((issue) => issue.message).join("; ")}`,
      { cause: input.cause },
    );
    this.name = "MechanicInputValidationError";
    this.invocationId = input.invocationId;
    this.packageId = input.packageId;
    this.ruleId = input.ruleId;
    this.issues = structuredClone(input.issues);
  }
}

export interface RuleExecutionContext {
  state: SimulationState;
  actions: readonly AgentActionProposal[];
  resolutionPlans: readonly ResolutionPlan[];
  resolutionReceipts: readonly ResolutionReceipt[];
  checkRequests: readonly D20CheckRequest[];
  checkResults: readonly D20CheckResult[];
  randomRequests: readonly DiscreteRandomRequest[];
  randomResults: readonly DiscreteRandomResult[];
  priorMechanicResults?: readonly MechanicResult[];
  candidateDirectOperations?: readonly WorldDeltaOperation[];
}

export interface RuleResultDraft {
  code: string;
  data: unknown;
  operations: WorldDeltaOperation[];
}

export interface MechanicRule {
  id: string;
  description: string;
  inputSchema: z.ZodType<unknown>;
  resolve: (
    context: RuleExecutionContext,
    config: unknown,
    input: unknown,
    invocation: MechanicInvocation,
  ) => RuleResultDraft;
}

export interface RulePackage {
  id: string;
  version: string;
  configSchema: z.ZodType<unknown>;
  adjudication: string;
  rules: readonly MechanicRule[];
  validateDirectOperations?: (
    context: RuleExecutionContext,
    config: unknown,
    operations: readonly WorldDeltaOperation[],
  ) => void;
}

interface SelectedPackage {
  definition: RulePackage;
  config: unknown;
}

export interface ResolvedMechanics {
  invocations: MechanicInvocation[];
  results: MechanicResult[];
  operations: WorldDeltaOperation[];
}

const ruleResultDraftSchema = z.strictObject({
  code: z.string().min(1),
  data: z.json(),
  operations: z.array(worldDeltaOperationSchema),
});

function resolveInvocation(
  entry: SelectedPackage,
  context: RuleExecutionContext,
  invocation: MechanicInvocation,
  priorMechanicResults: readonly MechanicResult[],
  directOperations: readonly WorldDeltaOperation[],
): { invocation: MechanicInvocation; result: MechanicResult } {
  const rule = entry.definition.rules.find((candidate) => candidate.id === invocation.ruleId);
  if (!rule) throw new Error(`mechanic ${invocation.id} cites unknown rule ${invocation.ruleId}`);
  const input = rule.inputSchema.parse(invocation.input);
  const normalizedInvocation = { ...structuredClone(invocation), input: structuredClone(input) };
  const draft = ruleResultDraftSchema.parse(rule.resolve(
    {
      ...structuredClone(context),
      priorMechanicResults: structuredClone(priorMechanicResults),
      candidateDirectOperations: structuredClone(directOperations),
    },
    structuredClone(entry.config),
    structuredClone(input),
    structuredClone(normalizedInvocation),
  ));
  const invocationMechanics = new Set(invocation.causes
    .filter((cause) => cause.kind === "mechanic")
    .map((cause) => cause.id));
  if (draft.operations.some((operation) => operation.causes.some((cause) =>
    cause.kind === "mechanic" && !invocationMechanics.has(cause.id)))) {
    throw new Error(`rule ${invocation.packageId}/${invocation.ruleId} claims undeclared mechanic provenance`);
  }
  const mechanicCause = { kind: "mechanic" as const, id: invocation.id };
  const derived = draft.operations.map((operation) => ({
    ...structuredClone(operation),
    causes: [...structuredClone(operation.causes), mechanicCause],
    ...(operation.kind === "set_condition" ? {
      condition: {
        ...structuredClone(operation.condition),
        provenance: [...structuredClone(operation.condition.provenance), mechanicCause],
      },
    } : {}),
  })) as WorldDeltaOperation[];
  return {
    invocation: normalizedInvocation,
    result: {
      invocationId: invocation.id,
      packageId: invocation.packageId,
      ruleId: invocation.ruleId,
      code: draft.code,
      data: structuredClone(draft.data),
      operations: derived,
    },
  };
}

export class RulePackageRegistry {
  private readonly packages = new Map<string, RulePackage>();

  constructor(packages: readonly RulePackage[] = []) {
    for (const rulePackage of packages) this.register(rulePackage);
  }

  register(rulePackage: RulePackage): void {
    if (!rulePackage.id.trim() || !rulePackage.version.trim()) throw new Error("rule package identity is required");
    if (this.packages.has(rulePackage.id)) throw new Error(`duplicate rule package ${rulePackage.id}`);
    const ruleIds = rulePackage.rules.map((rule) => rule.id);
    if (ruleIds.some((id) => !id.trim()) || new Set(ruleIds).size !== ruleIds.length) {
      throw new Error(`rule package ${rulePackage.id} has invalid rule ids`);
    }
    this.packages.set(rulePackage.id, rulePackage);
  }

  private select(references: readonly RulePackageReference[]): Map<string, SelectedPackage> {
    const selected = new Map<string, SelectedPackage>();
    for (const reference of references) {
      const definition = this.packages.get(reference.id);
      if (!definition || definition.version !== reference.version) {
        throw new Error(`rule package runtime is unavailable: ${reference.id}@${reference.version}`);
      }
      selected.set(reference.id, { definition, config: definition.configSchema.parse(reference.config) });
    }
    return selected;
  }

  validate(references: readonly Omit<RulePackageReference, "adjudication" | "rules">[]): RulePackageReference[] {
    const seen = new Set<string>();
    return references.map((reference) => {
      if (seen.has(reference.id)) throw new Error(`duplicate rule package reference ${reference.id}`);
      seen.add(reference.id);
      const rulePackage = this.packages.get(reference.id);
      if (!rulePackage) throw new Error(`unknown rule package ${reference.id}`);
      if (rulePackage.version !== reference.version) {
        throw new Error(`rule package ${reference.id} requires version ${rulePackage.version}, received ${reference.version}`);
      }
      return {
        id: reference.id,
        version: reference.version,
        config: rulePackage.configSchema.parse(reference.config),
        adjudication: rulePackage.adjudication,
        rules: rulePackage.rules.map((rule) => ({ id: rule.id, description: rule.description })),
      };
    });
  }

  /**
   * Returns the exact input contracts of the selected runtime rules. The
   * projection intentionally omits package configuration and executable code;
   * it is safe to include in model context and remains script-driven.
   */
  promptContracts(references: readonly RulePackageReference[], vocabulary: "model" | "runtime" = "model"): MechanicPromptContract[] {
    return references.flatMap((reference) => {
      const rulePackage = this.packages.get(reference.id);
      if (!rulePackage || rulePackage.version !== reference.version) {
        throw new Error(`rule package runtime is unavailable: ${reference.id}@${reference.version}`);
      }
      return rulePackage.rules.map((rule) => ({
        packageId: rulePackage.id,
        version: rulePackage.version,
        ruleId: rule.id,
        description: rule.description,
        inputSchema: vocabulary === "model" ? projectMechanicInputSchema(z.toJSONSchema(rule.inputSchema, { target: "draft-07" }))
          : z.toJSONSchema(rule.inputSchema, { target: "draft-07" }),
      }));
    }).sort((left, right) =>
      `${left.packageId}:${left.ruleId}`.localeCompare(`${right.packageId}:${right.ruleId}`));
  }

  /** Validate every model-proposed invocation against the runtime rule input. */
  validateInvocationInputs(
    references: readonly RulePackageReference[],
    invocations: readonly MechanicInvocation[],
  ): void {
    const selected = this.select(references);
    for (const invocation of invocations) {
      const entry = selected.get(invocation.packageId);
      if (!entry) {
        throw new MechanicInputValidationError({
          invocationId: invocation.id,
          packageId: invocation.packageId,
          ruleId: invocation.ruleId,
          issues: [{ path: ["packageId"], message: `inactive mechanic package ${invocation.packageId}` }],
        });
      }
      const rule = entry.definition.rules.find((candidate) => candidate.id === invocation.ruleId);
      if (!rule) {
        throw new MechanicInputValidationError({
          invocationId: invocation.id,
          packageId: invocation.packageId,
          ruleId: invocation.ruleId,
          issues: [{ path: ["ruleId"], message: `unknown mechanic rule ${invocation.ruleId}` }],
        });
      }
      try {
        rule.inputSchema.parse(invocation.input);
      } catch (error) {
        const issues = error instanceof z.ZodError
          ? error.issues.map((issue) => ({
            path: issue.path.map((part) => typeof part === "symbol" ? part.description ?? "symbol" : part),
            message: issue.message,
          }))
          : [{ path: ["input"], message: error instanceof Error ? error.message : String(error) }];
        throw new MechanicInputValidationError({
          invocationId: invocation.id,
          packageId: invocation.packageId,
          ruleId: invocation.ruleId,
          issues,
          cause: error,
        });
      }
    }
  }

  resolve(
    references: readonly RulePackageReference[],
    context: RuleExecutionContext,
    invocations: readonly MechanicInvocation[],
    directOperations: readonly WorldDeltaOperation[],
  ): ResolvedMechanics {
    const selected = this.select(references);
    if (directOperations.some((operation) => operation.causes.some((cause) => cause.kind === "mechanic"))) {
      throw new Error("direct operations cannot claim mechanic-derived provenance");
    }
    for (const entry of selected.values()) {
      entry.definition.validateDirectOperations?.(
        structuredClone(context),
        structuredClone(entry.config),
        structuredClone(directOperations),
      );
    }

    const invocationIds = new Set<string>();
    const normalizedInvocations: MechanicInvocation[] = [];
    const results: MechanicResult[] = [];
    const operations: WorldDeltaOperation[] = [];
    for (const invocation of invocations) {
      if (invocationIds.has(invocation.id)) throw new Error(`duplicate mechanic invocation ${invocation.id}`);
      invocationIds.add(invocation.id);
      const entry = selected.get(invocation.packageId);
      if (!entry) throw new Error(`mechanic ${invocation.id} cites inactive package ${invocation.packageId}`);
      const resolved = resolveInvocation(entry, context, invocation, results, directOperations);
      normalizedInvocations.push(resolved.invocation);
      results.push(resolved.result);
      operations.push(...resolved.result.operations);
    }
    return { invocations: normalizedInvocations, results, operations };
  }
}

const coreResolutionConfigSchema = z.strictObject({});

const applyReceiptInputSchema = z.strictObject({
  receiptId: z.string().regex(/^rt:resolution-receipt:[a-f0-9]{64}$/),
});

function priorDerivedOperations(context: RuleExecutionContext): WorldDeltaOperation[] {
  return context.priorMechanicResults?.flatMap((result) => structuredClone(result.operations)) ?? [];
}

function projectedConditions(context: RuleExecutionContext): Map<string, import("./resolution").ConditionState> {
  const projected = new Map(Object.values(context.state.truth.conditions)
    .map((condition) => [condition.id, structuredClone(condition)]));
  for (const operation of priorDerivedOperations(context)) {
    if (operation.kind === "set_condition") projected.set(operation.condition.id, structuredClone(operation.condition));
    if (operation.kind === "remove_condition") projected.delete(operation.conditionId);
  }
  return projected;
}

function projectedMeterCurrents(context: RuleExecutionContext): Map<string, number> {
  const projected = new Map(Object.values(context.state.truth.meters).map((meter) => [meter.id, meter.current]));
  for (const operation of priorDerivedOperations(context)) {
    if (operation.kind === "set_meter") projected.set(operation.meter.id, operation.meter.current);
    if (operation.kind === "adjust_meter") {
      const current = projected.get(operation.meterId);
      if (current === undefined) throw new Error(`prior mechanic adjusts unknown meter ${operation.meterId}`);
      projected.set(operation.meterId, current + operation.amount);
    }
  }
  return projected;
}

function conditionSources(receipt: ResolutionReceipt): Set<string> {
  const plan = receipt.plan;
  const sources = [
    ...plan.means.map((mean) => mean.source),
    ...plan.factors.map((factor) => factor.source),
    ...(plan.difficulty ? [plan.difficulty.source] : []),
    ...receipt.effects.flatMap((effect) => effect.intent.sourceRefs),
  ];
  return new Set(sources.filter((source) => source.kind === "condition").map((source) => source.id));
}

const applyReceipt: MechanicRule = {
  id: "apply-receipt",
  description: "从已提交的 ResolutionReceipt 和世界 mechanics profiles 派生 Meter 与 Condition 操作。输入只能引用 receipt，不能携带数值。",
  inputSchema: applyReceiptInputSchema,
  resolve: (context, _config, input, invocation) => {
    const receiptId = (input as z.infer<typeof applyReceiptInputSchema>).receiptId;
    const receipt = context.resolutionReceipts.find((candidate) => candidate.id === receiptId);
    if (!receipt) throw new Error(`unknown resolution receipt ${receiptId}`);
    if (receipt.operations.length > 0) throw new Error(`resolution receipt ${receiptId} is already finalized`);
    const checkResult = receipt.checkRequestId
      ? context.checkResults.find((candidate) => candidate.requestId === receipt.checkRequestId)
      : null;
    if (receipt.checkRequestId && !checkResult) throw new Error(`resolution receipt ${receiptId} has no check result`);
    const assertions: CausalAssertion[] = checkResult ? [{
      kind: "check_result",
      checkId: checkResult.requestId,
      expected: checkResult.succeeded ? "succeeded" : "failed",
    }] : [{
      kind: "entity_lifecycle",
      entityId: receipt.plan.actorId,
      expected: context.state.truth.entities[receipt.plan.actorId]?.lifecycle ?? "active",
    }];
    const causes = structuredClone(invocation.causes);
    const operations: WorldDeltaOperation[] = [];
    const conditionMap = projectedConditions(context);
    const meterCurrents = projectedMeterCurrents(context);
    for (const conditionId of [...conditionSources(receipt)].sort()) {
      const condition = conditionMap.get(conditionId);
      if (!condition || condition.remainingUses === null) continue;
      if (condition.remainingUses <= 1) {
        operations.push({
          kind: "remove_condition",
          conditionId,
          causes: structuredClone(causes),
          assertions: structuredClone(assertions),
        });
        conditionMap.delete(conditionId);
      } else {
        const consumed = {
          ...structuredClone(condition),
          remainingUses: condition.remainingUses - 1,
          provenance: structuredClone(causes),
        };
        operations.push({
          kind: "set_condition",
          condition: consumed,
          causes: structuredClone(causes),
          assertions: structuredClone(assertions),
        });
        conditionMap.set(conditionId, consumed);
      }
    }
    for (const effect of receipt.effects) {
      if (effect.intent.kind === "meter") {
        const meter = context.state.truth.meters[effect.intent.meterId];
        const definition = meter ? context.state.truth.mechanics.meters[meter.definitionId] : null;
        const profile = context.state.truth.mechanics.impactProfiles[effect.intent.impactProfileId];
        if (!meter || !definition || meter.entityId !== effect.intent.targetId || !profile ||
          profile.meterDefinitionId !== meter.definitionId) {
          throw new Error(`receipt ${receiptId} has an invalid meter effect ${effect.intent.id}`);
        }
        const unsigned = profile.amounts[effect.magnitude];
        const desired = profile.direction === "increase" ? unsigned : -unsigned;
        const current = meterCurrents.get(meter.id);
        if (current === undefined) throw new Error(`receipt ${receiptId} has no projected meter ${meter.id}`);
        const amount = deriveClampedMeterDelta(current, definition.min, definition.max, desired);
        if (amount !== 0) {
          operations.push({
            kind: "adjust_meter",
            meterId: meter.id,
            amount,
            causes: structuredClone(causes),
            assertions: structuredClone(assertions),
          });
          meterCurrents.set(meter.id, current + amount);
        }
        continue;
      }
      const duration = context.state.truth.mechanics.durationProfiles[effect.intent.durationProfileId];
      const profile = effect.intent.conditionProfileId
        ? context.state.truth.mechanics.conditionProfiles[effect.intent.conditionProfileId]
        : null;
      if (!duration || (effect.intent.conditionProfileId !== null && !profile)) {
        throw new Error(`receipt ${receiptId} has an invalid condition effect ${effect.intent.id}`);
      }
      const incoming = materializeCondition({
        intent: effect.intent,
        magnitude: effect.magnitude,
        duration,
        profile,
        elapsedSeconds: context.state.truth.elapsedSeconds,
        provenance: causes,
      });
      const merged = mergeCondition([...conditionMap.values()], incoming);
      conditionMap.clear();
      for (const condition of merged.conditions) conditionMap.set(condition.id, condition);
      operations.push({
        kind: "set_condition",
        condition: merged.condition,
        causes: structuredClone(causes),
        assertions: structuredClone(assertions),
      });
    }
    return {
      code: receipt.effects.length === 0 ? "receipt-settled-no-effect" : "receipt-effects-derived",
      data: {
        receiptId,
        outcome: receipt.outcome,
        effects: receipt.effects.map((effect) => ({
          id: effect.intent.id,
          role: effect.role,
          magnitude: effect.magnitude,
        })),
      },
      operations,
    };
  },
};

const advanceConditionsInputSchema = z.strictObject({
  seconds: z.number().int().positive(),
});

const advanceConditions: MechanicRule = {
  id: "advance-conditions",
  description: "在引擎推进模拟时间前，按 condition/duration/impact profiles 结算持续影响和到期状态。",
  inputSchema: advanceConditionsInputSchema,
  resolve: (context, _config, input, invocation) => {
    const { seconds } = input as z.infer<typeof advanceConditionsInputSchema>;
    const conditions = projectedConditions(context);
    const meterCurrents = projectedMeterCurrents(context);
    const operations: WorldDeltaOperation[] = [];
    const end = context.state.truth.elapsedSeconds + seconds;
    for (const condition of [...conditions.values()].sort((left, right) => left.id.localeCompare(right.id))) {
      const profile = condition.conditionProfileId
        ? context.state.truth.mechanics.conditionProfiles[condition.conditionProfileId]
        : null;
      if (profile?.recurringImpactProfileId) {
        const impact = context.state.truth.mechanics.impactProfiles[profile.recurringImpactProfileId];
        const meter = Object.values(context.state.truth.meters).find((candidate) =>
          candidate.entityId === condition.subjectId && candidate.definitionId === impact?.meterDefinitionId);
        const definition = meter ? context.state.truth.mechanics.meters[meter.definitionId] : null;
        if (!impact || !meter || !definition) {
          throw new Error(`condition ${condition.id} has no meter for recurring impact`);
        }
        const current = meterCurrents.get(meter.id);
        if (current === undefined) throw new Error(`condition ${condition.id} has no projected meter state`);
        const unsigned = impact.amounts[condition.magnitude];
        const desired = impact.direction === "increase" ? unsigned : -unsigned;
        const amount = deriveClampedMeterDelta(current, definition.min, definition.max, desired);
        if (amount !== 0) {
          operations.push({
            kind: "adjust_meter",
            meterId: meter.id,
            amount,
            causes: structuredClone(invocation.causes),
            assertions: [{ kind: "meter_compare", meterId: meter.id, operator: "eq", value: current }],
          });
          meterCurrents.set(meter.id, current + amount);
        }
      }
      if (condition.expiresAtElapsedSeconds !== null && condition.expiresAtElapsedSeconds <= end) {
        operations.push({
          kind: "remove_condition",
          conditionId: condition.id,
          causes: structuredClone(invocation.causes),
          assertions: [{
            kind: "elapsed_seconds_compare",
            operator: "eq",
            value: context.state.truth.elapsedSeconds,
          }],
        });
      }
    }
    return {
      code: operations.length === 0 ? "conditions-unchanged" : "conditions-advanced",
      data: { seconds, endElapsedSeconds: end, operationCount: operations.length },
      operations,
    };
  },
};

const quantityAmountSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("explicit_action_amount"),
    actionId: z.string().min(1),
    quotedText: z.string().trim().min(1).max(64),
    amount: z.number().positive().finite(),
  }),
  z.strictObject({
    kind: z.literal("existing_state"),
    quantityId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("random_result"),
    requestId: z.string().min(1),
    stepId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("trusted_rule"),
    mechanicId: z.string().min(1),
    dataPath: z.array(z.string().min(1)).min(1).max(8),
  }),
]);

type QuantityAmountSource = z.infer<typeof quantityAmountSourceSchema>;

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object" || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function deriveQuantityAmount(
  context: RuleExecutionContext,
  source: QuantityAmountSource,
): { amount: number; assertion: CausalAssertion | null } {
  if (source.kind === "explicit_action_amount") {
    const action = context.actions.find((candidate) => candidate.id === source.actionId);
    const sourceText = action ? [action.rawText, action.goal, action.means ?? ""].join("\n") : "";
    const parsed = parseExplicitNumber(source.quotedText);
    if (!action || !containsStandaloneExplicitNumber(sourceText, source.quotedText) || parsed !== source.amount) {
      throw new Error("explicit quantity amount is not present verbatim in its action");
    }
    return { amount: source.amount, assertion: null };
  }
  if (source.kind === "existing_state") {
    const quantity = context.state.truth.quantities[source.quantityId];
    if (!quantity) throw new Error(`unknown existing quantity ${source.quantityId}`);
    return {
      amount: quantity.amount,
      assertion: {
        kind: "quantity_compare",
        definitionId: quantity.definitionId,
        holderId: quantity.holderId,
        operator: "eq",
        value: quantity.amount,
      },
    };
  }
  if (source.kind === "random_result") {
    const result = context.randomResults.find((candidate) => candidate.requestId === source.requestId);
    const step = result?.steps.find((candidate) => candidate.stepId === source.stepId);
    if (!step || typeof step.aggregate !== "number" || !Number.isFinite(step.aggregate) || step.aggregate <= 0) {
      throw new Error("random quantity amount is not a positive committed number");
    }
    return {
      amount: step.aggregate,
      assertion: {
        kind: "random_result",
        requestId: source.requestId,
        stepId: source.stepId,
        expected: step.aggregate,
      },
    };
  }
  const result = context.priorMechanicResults?.find((candidate) => candidate.invocationId === source.mechanicId);
  const value = result ? valueAtPath(result.data, source.dataPath) : undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("trusted rule quantity amount is not a positive prior mechanic result");
  }
  return { amount: value, assertion: null };
}

function validateQuantitySourceCause(source: QuantityAmountSource, invocation: MechanicInvocation): void {
  const required = source.kind === "explicit_action_amount"
    ? { kind: "action" as const, id: source.actionId }
    : source.kind === "random_result"
      ? { kind: "random" as const, id: source.requestId }
      : source.kind === "trusted_rule"
        ? { kind: "mechanic" as const, id: source.mechanicId }
        : null;
  if (required && !invocation.causes.some((cause) => cause.kind === required.kind && cause.id === required.id)) {
    throw new Error(`${source.kind} quantity source is absent from mechanic causes`);
  }
}

const transferQuantityInputSchema = z.strictObject({
  definitionId: z.string().min(1),
  fromHolderId: z.string().min(1),
  toHolderId: z.string().min(1),
  amountSource: quantityAmountSourceSchema,
});

const transferQuantity: MechanicRule = {
  id: "transfer-quantity",
  description: "按 explicit_action_amount、existing_state、random_result 或 trusted_rule provenance 派生守恒转移量。",
  inputSchema: transferQuantityInputSchema,
  resolve: (context, _config, input, invocation) => {
    const value = input as z.infer<typeof transferQuantityInputSchema>;
    validateQuantitySourceCause(value.amountSource, invocation);
    const derived = deriveQuantityAmount(context, value.amountSource);
    const from = Object.values(context.state.truth.quantities).find((quantity) =>
      quantity.definitionId === value.definitionId && quantity.holderId === value.fromHolderId);
    if (!from || from.amount < derived.amount || value.fromHolderId === value.toHolderId ||
      !context.state.truth.entities[value.toHolderId]) throw new Error("invalid or insufficient quantity transfer");
    if (value.amountSource.kind === "explicit_action_amount") {
      const actionId = value.amountSource.actionId;
      const action = context.actions.find((candidate) => candidate.id === actionId);
      if (!action || context.state.agents[action.actorId]?.entityId !== value.fromHolderId) {
        throw new Error("explicit transfer amount belongs to another holder");
      }
    }
    return {
      code: "quantity-transfer-derived",
      data: { amount: derived.amount, provenance: value.amountSource.kind },
      operations: [{
        kind: "transfer_quantity",
        definitionId: value.definitionId,
        fromHolderId: value.fromHolderId,
        toHolderId: value.toHolderId,
        amount: derived.amount,
        causes: structuredClone(invocation.causes),
        assertions: [derived.assertion ?? {
          kind: "quantity_compare",
          definitionId: value.definitionId,
          holderId: value.fromHolderId,
          operator: "gte",
          value: derived.amount,
        }],
      }],
    };
  },
};

const changeQuantityInputSchema = z.strictObject({
  kind: z.enum(["produce", "consume"]),
  definitionId: z.string().min(1),
  holderId: z.string().min(1),
  lawId: z.string().min(1),
  amountSource: quantityAmountSourceSchema,
});

const changeQuantity: MechanicRule = {
  id: "change-quantity",
  description: "在 Quantity 声明的生产/消耗法则下，从四类允许 provenance 派生数量。",
  inputSchema: changeQuantityInputSchema,
  resolve: (context, _config, input, invocation) => {
    const value = input as z.infer<typeof changeQuantityInputSchema>;
    validateQuantitySourceCause(value.amountSource, invocation);
    const definition = context.state.truth.mechanics.quantities[value.definitionId];
    const laws = value.kind === "produce" ? definition?.productionLawIds : definition?.consumptionLawIds;
    if (!laws?.includes(value.lawId) || !invocation.causes.some((cause) => cause.kind === "law" && cause.id === value.lawId)) {
      throw new Error(`law ${value.lawId} cannot authorize ${value.kind} quantity`);
    }
    if (!context.state.truth.entities[value.holderId]) throw new Error(`unknown quantity holder ${value.holderId}`);
    const derived = deriveQuantityAmount(context, value.amountSource);
    const quantity = Object.values(context.state.truth.quantities).find((candidate) =>
      candidate.definitionId === value.definitionId && candidate.holderId === value.holderId);
    if (value.kind === "consume" && (!quantity || quantity.amount < derived.amount)) {
      throw new Error("insufficient quantity consumption");
    }
    const operation = value.kind === "produce" ? {
      kind: "produce_quantity" as const,
      definitionId: value.definitionId,
      holderId: value.holderId,
      amount: derived.amount,
      lawId: value.lawId,
    } : {
      kind: "consume_quantity" as const,
      definitionId: value.definitionId,
      holderId: value.holderId,
      amount: derived.amount,
      lawId: value.lawId,
    };
    return {
      code: `quantity-${value.kind}-derived`,
      data: { amount: derived.amount, provenance: value.amountSource.kind },
      operations: [{
        ...operation,
        causes: structuredClone(invocation.causes),
        assertions: [derived.assertion ?? {
          kind: "entity_lifecycle",
          entityId: value.holderId,
          expected: context.state.truth.entities[value.holderId].lifecycle,
        }],
      }],
    };
  },
};

const instantiateEntityProfileInputSchema = z.strictObject({
  entityId: z.string().min(1),
  profileId: z.string().min(1),
});

const instantiateEntityCohortInputSchema = z.strictObject({
  entityIds: z.array(z.string().min(1)).min(1).max(256),
  profileId: z.string().min(1),
}).superRefine((value, context) => {
  if (new Set(value.entityIds).size !== value.entityIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "entityIds must be unique" });
  }
});

function instantiateProfileOperations(
  context: RuleExecutionContext,
  profileId: string,
  entityIds: readonly string[],
  invocation: MechanicInvocation,
): WorldDeltaOperation[] {
  const profile = context.state.truth.mechanics.entityMechanicsProfiles[profileId];
  if (!profile) throw new Error(`unknown entity mechanics profile ${profileId}`);
  return [...entityIds].sort().flatMap((entityId) => {
    // The invocation itself asserts that each entity was absent before the
    // transition. Profile writes run after create_entity operations, so their
    // operation-level assertion must observe the newly active entity in the
    // causal working state.
    const assertions: CausalAssertion[] = [{ kind: "entity_lifecycle", entityId, expected: "active" }];
    return [
      ...profile.meters.map((entry) => ({
        kind: "set_meter" as const,
        meter: {
          id: `${entityId}-${entry.definitionId}`,
          definitionId: entry.definitionId,
          entityId,
          current: entry.current,
          firedThresholdIds: [],
        },
        causes: structuredClone(invocation.causes),
        assertions: structuredClone(assertions),
      })),
      ...profile.quantities.map((entry) => ({
        kind: "set_quantity" as const,
        quantity: {
          id: quantityId(context.state.worldHash, entry.definitionId, entityId),
          definitionId: entry.definitionId,
          holderId: entityId,
          amount: entry.amount,
        },
        causes: structuredClone(invocation.causes),
        assertions: structuredClone(assertions),
      })),
      ...profile.ratings.map((entry) => ({
        kind: "set_rating" as const,
        rating: {
          id: `${entityId}-${entry.definitionId}`,
          definitionId: entry.definitionId,
          entityId,
          value: entry.value,
        },
        causes: structuredClone(invocation.causes),
        assertions: structuredClone(assertions),
      })),
    ] as WorldDeltaOperation[];
  });
}

const instantiateEntityProfile: MechanicRule = {
  id: "instantiate-entity-profile",
  description: "为同一 transition 新建的 Entity 按 entity_mechanics_profile 确定性初始化 Meter、Quantity 与 Rating。",
  inputSchema: instantiateEntityProfileInputSchema,
  resolve: (context, _config, input, invocation) => {
    const value = input as z.infer<typeof instantiateEntityProfileInputSchema>;
    if (context.state.truth.entities[value.entityId] ||
      !context.candidateDirectOperations?.some((operation) =>
        operation.kind === "create_entity" && operation.entity.id === value.entityId)) {
      throw new Error(`entity profile target ${value.entityId} is not created by this transition`);
    }
    const operations = instantiateProfileOperations(context, value.profileId, [value.entityId], invocation);
    return {
      code: "entity-mechanics-profile-instantiated",
      data: { entityId: value.entityId, profileId: value.profileId, operationCount: operations.length },
      operations,
    };
  },
};

const instantiateEntityCohort: MechanicRule = {
  id: "instantiate-entity-cohort",
  description: "为同一 transition 中新建的一组 Entity 按同一 entity_mechanics_profile 确定性初始化 Meter、Quantity 与 Rating。",
  inputSchema: instantiateEntityCohortInputSchema,
  resolve: (context, _config, input, invocation) => {
    const value = input as z.infer<typeof instantiateEntityCohortInputSchema>;
    const createdEntityIds = new Set((context.candidateDirectOperations ?? [])
      .filter((operation): operation is Extract<WorldDeltaOperation, { kind: "create_entity" }> =>
        operation.kind === "create_entity")
      .map((operation) => operation.entity.id));
    for (const entityId of value.entityIds) {
      if (context.state.truth.entities[entityId] || !createdEntityIds.has(entityId)) {
        throw new Error(`entity cohort target ${entityId} is not created by this transition`);
      }
    }
    const operations = instantiateProfileOperations(context, value.profileId, value.entityIds, invocation);
    return {
      code: "entity-mechanics-cohort-instantiated",
      data: {
        entityIds: [...value.entityIds].sort(),
        profileId: value.profileId,
        operationCount: operations.length,
      },
      operations,
    };
  },
};

export const coreResolutionRulePackage: RulePackage = {
  id: "core-resolution",
  version: "2.0.0",
  adjudication: "先提交 ResolutionPlan，再由引擎把命名难度、风险和效果档确定性映射为 d20 检定与规则效果。模型不得提交 raw DC、modifier、Meter delta、Condition 强度或 Rating 数值。",
  configSchema: coreResolutionConfigSchema,
  rules: [applyReceipt, advanceConditions, transferQuantity, changeQuantity, instantiateEntityProfile, instantiateEntityCohort],
  validateDirectOperations: (_context, _config, operations) => {
    for (const operation of operations) {
      if (operation.kind === "adjust_meter" || operation.kind === "set_meter" || operation.kind === "set_rating" ||
        operation.kind === "set_condition" || operation.kind === "remove_condition") {
        throw new Error(`${operation.kind} must be derived by a trusted core-resolution rule`);
      }
      if (operation.kind === "transfer_quantity" || operation.kind === "produce_quantity" ||
        operation.kind === "consume_quantity" || operation.kind === "set_quantity") {
        throw new Error(`${operation.kind} amount must be derived by a trusted core-resolution rule`);
      }
    }
  },
};

export function deriveCoreResolutionMechanicResult(
  context: RuleExecutionContext,
  invocation: MechanicInvocation,
  priorMechanicResults: readonly MechanicResult[],
  directOperations: readonly WorldDeltaOperation[],
): MechanicResult {
  if (invocation.packageId !== coreResolutionRulePackage.id) {
    throw new Error(`mechanic ${invocation.id} is not a core-resolution invocation`);
  }
  return resolveInvocation(
    { definition: coreResolutionRulePackage, config: {} },
    context,
    invocation,
    priorMechanicResults,
    directOperations,
  ).result;
}

export function createCoreRulePackageRegistry(): RulePackageRegistry {
  return new RulePackageRegistry([coreResolutionRulePackage]);
}
