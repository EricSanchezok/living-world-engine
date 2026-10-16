import type { RequestSuggestionsInput } from "../../../../../../../shared/world-api";
import { WorldHost } from "../../../../../../../server/world-host";
import { json, observeHttpJsonBody, observedRoute, principalId, readJson } from "../../../../../h";

export async function POST(
  request: Request,
  { params }: RouteContext<"/api/instances/[id]/participants/[participantId]/suggestions">,
): Promise<Response> {
  return observedRoute(request, async (scope) => {
    const { id, participantId } = await params;
    const body = await readJson<RequestSuggestionsInput>(request);
    observeHttpJsonBody(scope, body);
    const identity = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 128;
    if (!body || !identity(body.sourceId) || !identity(body.requestId) ||
      (body.expectedRequestId !== null && !identity(body.expectedRequestId))) {
      return json({ error: "invalid suggestion request" }, 400);
    }
    return json(await WorldHost.get().requestSuggestions(id, participantId, body, principalId(request)), 202);
  });
}
