import type { AgentActionProposal, MechanicInvocation, SimulationState } from "../contracts/model";
import { createCoreRulePackageRegistry, type RulePackageRegistry, type RuleExecutionContext } from "../mechanics/rule-package";
import type { ProgramResources } from "../programs/definition";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { quantityId, runtimeId } from "../runtime/runtime-id";
import { worldProgramBoundary, worldProvenance, type BoundWorldProgram } from "./adjudication";
import { evaluateWorldValue, materializeWorldBranch } from "./world-program";
import type { WorldRandomCommitment } from "./randomness";
import { worldOperationReads, worldOperationWrites } from "./resources";
import { materializeWorldResolutions, worldResolutionReceipt } from "./resolutions";

export interface WorldMechanicsContext { state: Readonly<SimulationState>; definition: WorldRuntimeContract; randomness?: WorldRandomCommitment | null; rulePackages?: RulePackageRegistry }
const registry = createCoreRulePackageRegistry();

export function worldMechanicContracts(definition: WorldRuntimeContract, rulePackages: RulePackageRegistry = registry) {
  return rulePackages.promptContracts(definition.rulePackages, "runtime")
    .filter(contract => !["advance-conditions", "apply-receipt"].includes(contract.ruleId));
}

function mechanicalReads(invocations: MechanicInvocation[], state: Readonly<SimulationState>): string[] {
  const keys = new Set(["mechanics"]);
  for (const invocation of invocations) {
    const input = invocation.input as Record<string, unknown>;
    if (invocation.ruleId === "transfer-quantity" || invocation.ruleId === "change-quantity") {
      const holders = invocation.ruleId === "transfer-quantity" ? [input.fromHolderId, input.toHolderId] : [input.holderId];
      for (const holder of holders as string[]) {
        keys.add(`entity:${holder}`); keys.add(`quantity:${quantityId(state.worldHash, input.definitionId as string, holder)}`);
      }
      if (typeof input.lawId === "string") keys.add(`law:${input.lawId}`);
      const source = input.amountSource as { kind: string; quantityId?: string };
      if (source.kind === "existing_state") keys.add(`quantity:${source.quantityId}`);
      if (source.kind === "explicit_action_amount") keys.add("agentRoster");
    } else {
      // Profile instantiation checks collection membership and existing runtime IDs.
      for (const key of ["entities", "meters", "quantities", "ratings", "conditions"]) keys.add(key);
    }
  }
  return [...keys];
}

/** The same trusted rule implementations derive quantities and reject raw numeric effects. */
export function materializeWorldMechanics(bound: BoundWorldProgram, branchId: string, resources: ProgramResources, context: WorldMechanicsContext) {
  const branch = bound.program.definition.branches.find(branch => branch.id === branchId);
  if (!branch) throw new Error("unknown mechanical branch");
  const direct = materializeWorldBranch(bound.program, branchId, bound.parameters, resources, worldProvenance(bound), bound.attempt);
  const action: AgentActionProposal = { id: bound.attempt.id, actorId: bound.attempt.actorId, baseRevision: context.state.revision,
    rawText: bound.attempt.intent, goal: bound.attempt.intent, means: bound.attempt.utterance, targetIds: [] };
  const revision = context.randomness?.plan.sourceRevision ?? context.state.revision;
  const resolved = materializeWorldResolutions(context.state, context.definition, resources, bound, revision);
  const receipts = resolved.filter(value => branch.resolutions.includes(value.key)).map((value, ordinal) => worldResolutionReceipt(
    context.state, context.definition, value.plan, value.check,
    value.check ? context.randomness?.checks.find(result => result.requestId === value.check!.id) ?? null : null, ordinal, revision));
  const derived: MechanicInvocation[] = receipts.map((receipt, ordinal) => ({
    id: runtimeId({ worldHash: context.state.worldHash, revision: context.state.revision, kind: "mechanic", stage: "world-program-resolution",
      owner: [bound.attempt.id, receipt.id], round: 0, ordinal }),
    packageId: "core-resolution", ruleId: "apply-receipt", input: { receiptId: receipt.id }, ...worldProvenance(bound),
    causes: [...worldProvenance(bound).causes, ...(receipt.checkRequestId ? [{ kind: "check" as const, id: receipt.checkRequestId }] : [])],
  }));
  const invocations: MechanicInvocation[] = [...derived, ...branch.mechanics.map((template, ordinal) => ({
    id: runtimeId({ worldHash: context.state.worldHash, revision: context.state.revision, kind: "mechanic", stage: "world-program",
      owner: [bound.attempt.id, bound.program.hash, branchId, template.id], round: 0, ordinal }),
    packageId: template.packageId, ruleId: template.ruleId,
    input: evaluateWorldValue(template.input, bound.parameters, resources, bound.attempt), ...worldProvenance(bound),
    causes: [...worldProvenance(bound).causes, ...(context.randomness?.plan.requests.map(request => ({ kind: "random" as const, id: request.id })) ?? [])],
  }))];
  const effectState = { ...context.state, truth: { ...context.state.truth,
    elapsedSeconds: worldProgramBoundary(bound, resources) } } as SimulationState;
  const input: RuleExecutionContext = { state: effectState, actions: [action], resolutionPlans: resolved.map(value => value.plan), resolutionReceipts: receipts,
    checkRequests: context.randomness?.plan.checkRequests ?? [], checkResults: context.randomness?.checks ?? [],
    randomRequests: context.randomness?.plan.requests ?? [], randomResults: context.randomness?.results ?? [] };
  const mechanics = (context.rulePackages ?? registry).resolve(context.definition.rulePackages, input, invocations, direct);
  const reads = mechanicalReads(mechanics.invocations, context.state);
  if (resolved.length) for (const key of ["facts", "placements", "ratings", "conditions", "meters", "mechanics"]) if (!reads.includes(key)) reads.push(key);
  for (const [index, receipt] of receipts.entries()) receipt.operations = mechanics.results[index]!.operations;
  const operations = [...direct, ...mechanics.operations];
  const actualReads = [...new Set([...reads, ...operations.flatMap(operation => worldOperationReads(context.state, operation))])];
  const writes = [...new Set(operations.flatMap(operation => worldOperationWrites(context.state, operation)))];
  return { operations, mechanics, reads: actualReads, writes, resolutionPlans: resolved.map(value => value.plan), resolutionReceipts: receipts };
}
