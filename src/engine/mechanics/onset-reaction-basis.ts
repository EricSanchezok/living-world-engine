import type { D20CheckRequest, D20CheckResult } from "../contracts/model";

/** The check-backed admission rule shared by onset production and diagnostic consumers. */
export function successfulOnsetPerceptionChecks(
  observerEntityId: string,
  sourceActionId: string,
  perception: Readonly<{ requests: readonly D20CheckRequest[]; checks: readonly D20CheckResult[] }>,
): D20CheckRequest[] {
  const resultById = new Map(perception.checks.map(result => [result.requestId, result]));
  return perception.requests.filter(request =>
    request.phase === "perception" && request.actorId === observerEntityId &&
    resultById.get(request.id)?.succeeded &&
    request.causes.some(cause => cause.kind === "action" && cause.id === sourceActionId) &&
    request.causes.some(cause => cause.kind === "fact" || cause.kind === "law"))
    .sort((left, right) => left.id.localeCompare(right.id));
}
