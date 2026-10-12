import { contentHash } from "../models/model-audit";
import { admitProgram, type ProgramAdmission, type ProgramDefinition } from "../programs/definition";
import { ProgramInterpreter, type ProgramReceipt } from "../programs/interpreter";

export function programFixture() {
  const definition: ProgramDefinition = { version: 1, id: "ask-trade", name: "Ask before trading", owner: { kind: "agent", agentId: "agent-a" },
    description: "Ask, wait for acceptance and trade; verify delivery separately.", sourceIds: ["goal:delivery"],
    parameters: { recipient: { kind: "entity", description: "The known recipient" } }, reads: ["self", "contact", "task"], writes: ["task"],
    entry: "root", startPredicateId: "ready", nodes: [
      { id: "root", kind: "sequence", children: ["ask", "wait", "trade"] },
      { id: "ask", kind: "attempt", intent: "Ask {recipient} to trade", entityTargetParameters: ["recipient"], speech: { kind: "authored", text: "Will you accept the trade?" },
        onFailure: "expand", onPartial: "wait" },
      { id: "wait", kind: "wait", predicateId: "accepted", deadlineSeconds: 30 },
      { id: "trade", kind: "attempt", intent: "Trade with {recipient}", entityTargetParameters: ["recipient"], speech: { kind: "none" },
        onFailure: "expand", onPartial: "wait" },
    ], predicates: [
      { id: "ready", description: "Ready", reads: ["self"], sourceIds: ["goal:delivery"], unknown: "wait",
        test: { kind: "mechanical", operator: "eq", left: { kind: "read", resource: "self", path: ["ready"] }, right: { kind: "literal", value: true } } },
      { id: "accepted", description: "Explicit acceptance", reads: ["contact"], sourceIds: ["goal:delivery"], unknown: "wait",
        test: { kind: "semantic", instructions: "Has the recipient explicitly accepted these terms?" } },
      { id: "delivered", description: "Actual delivery", reads: ["task"], sourceIds: ["goal:delivery"], unknown: "wait",
        test: { kind: "mechanical", operator: "eq", left: { kind: "read", resource: "task", path: ["delivered"] }, right: { kind: "literal", value: true } } },
    ], interrupts: [], milestones: [{ id: "terms-accepted", predicateId: "accepted" }], goals: [{ goalId: "deliver", predicateId: "delivered" }] };
  const admission: ProgramAdmission = { ownerId: "agent-a", sources: new Map([["goal:delivery", contentHash("deliver")]]),
    resources: new Set(["self", "contact", "task"]), goalIds: new Set(["deliver"]) };
  const resources: Record<string, { version: number; value: { [key: string]: boolean | string } }> = {
    self: { version: 0, value: { ready: true } }, contact: { version: 0, value: { reply: "none" } }, task: { version: 0, value: { delivered: false } },
  };
  const entities = new Set(["local:recipient"]), parameters = { recipient: "local:recipient" };
  const program = admitProgram(definition, admission);
  const interpreter = new ProgramInterpreter(program, "instance-a", parameters, entities);
  const receipts = new Map<string, ProgramReceipt>();
  return { definition, admission, resources, entities, parameters, program, interpreter, receipts };
}
