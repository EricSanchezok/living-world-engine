import type { JsonValue } from "../runtime/json";
import type { ProgramInterpreter } from "./interpreter";

/** Exact stalled conditions are useful repair input; repeated hash proofs stay in the durable journal. */
export function programRevisionContext(program: ProgramInterpreter): JsonValue {
  const snapshot = program.snapshot(), definition = program.program.definition;
  const started = snapshot.events.some(event => event.kind === "predicate" && event.reason === "start" && event.verdict === "yes");
  const frontier = program.position.map(position => ({ position, node: definition.nodes.find(node => node.id === position.nodeId)! }));
  const predicateIds = new Set(frontier.flatMap(({ node }) =>
    node.kind === "branch" || node.kind === "repeat" || node.kind === "wait" ? [node.predicateId] : []));
  if (!started) predicateIds.add(definition.startPredicateId);
  const conditions = [...predicateIds].map(id => {
    const predicate = definition.predicates.find(predicate => predicate.id === id)!;
    const last = snapshot.events.findLast(event => event.kind === "predicate" && event.predicateId === id);
    return { predicate, lastVerdict: last?.kind === "predicate" ? last.verdict : null };
  });
  return JSON.parse(JSON.stringify({ definition, parameters: program.parameterValues, status: program.status,
    frontier, conditions, completion: program.completion,
    interruption: snapshot.events.findLast(event => event.kind === "interrupt") ?? null,
    repairRequirements: [
      "Address these exact current frontier conditions, not just the original goal.",
      "If a condition is unknown and no concrete external evidence is expected, add an information-gathering or contributing action before waiting.",
      "Do not repeat an unchanged guard of an unobserved final result before the first useful action.",
      "Retain actual completed work from the owner's perspective and receipts; never infer success from a planned step."
    ],
    receipts: snapshot.events.flatMap(event => event.kind === "settle" ? [{ atSeconds: event.receipt.atSeconds,
      status: event.receipt.status, madeProgress: event.receipt.madeProgress }] : []),
  })) as JsonValue;
}
