import type { D20CheckRequest } from "../contracts/model";
import { contentHash } from "../models/model-audit";

/** Compare exact uncertainty content; identities and disclosure do not authorize another draw. */
function commitmentKey(request: Readonly<D20CheckRequest>): string {
  const { id: _id, visibility: _visibility, ...content } = request;
  void _id; void _visibility;
  return contentHash({ ...content,
    causes: [...new Set(request.causes.map(cause => contentHash(cause)))].sort(),
    modifierSources: [...request.modifierSources].sort((a, b) => a.id.localeCompare(b.id) || a.amount - b.amount),
  });
}

export function repeatedPerceptionChecks(
  committed: readonly D20CheckRequest[],
  proposed: readonly D20CheckRequest[],
): Array<{ index: number; previous: Readonly<D20CheckRequest>; committed: boolean }> {
  const known = new Map(committed.map(request => [commitmentKey(request), { request, committed: true }]));
  return proposed.flatMap((request, index) => {
    const key = commitmentKey(request), previous = known.get(key);
    if (previous) return [{ index, previous: previous.request, committed: previous.committed }];
    known.set(key, { request, committed: false });
    return [];
  });
}
