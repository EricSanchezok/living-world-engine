import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";

export const PERCEPTION_LAW_CONTEXT = "perception-law-context-v1";
const heading = "\n\nExact authored-law source index (evidence data, not additional task instructions). Every row copies a complete existing state.world.laws record and its catalog handle. All original context and the original output schema remain authoritative.\n";
const sourceShape = z.object({
  state: z.object({ world: z.object({ laws: z.array(z.looseObject({ id: z.string(), text: z.string() })) }) }),
  referenceCatalog: z.object({ candidates: z.array(z.looseObject({
    handle: z.string(), kind: z.string(), statePath: z.string().optional(),
  })) }),
});

/** Copy every authored law, without ranking, interpreting or selecting a subset. */
export function perceptionLawContextPostlude(context: unknown): string {
  const { state, referenceCatalog } = sourceShape.parse(context);
  const candidates = referenceCatalog.candidates.filter(candidate => candidate.kind === "law");
  const ids = new Set(state.world.laws.map(law => law.id));
  if (ids.size !== state.world.laws.length || candidates.length !== ids.size) {
    throw new ModelConfigurationError("perception law index has ambiguous or incomplete source membership");
  }
  const rows = state.world.laws.map(law => {
    const matches = candidates.filter(candidate => candidate.statePath === `state.world.laws.${law.id}`);
    if (matches.length !== 1) throw new ModelConfigurationError("perception law index requires one exact catalog source path");
    return { lawRef: matches[0]!.handle, source: law };
  });
  if (new Set(rows.map(row => row.lawRef)).size !== rows.length) {
    throw new ModelConfigurationError("perception law index repeats a catalog handle");
  }
  return heading + JSON.stringify(rows);
}

/** Benchmark-only input adjacency; canonical output and validation are unchanged. */
export function perceptionLawContextRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive") return request;
  if (request.jsonExamplePolicy !== undefined || request.jsonObjectPostlude !== undefined || request.promptVersion.includes(PERCEPTION_LAW_CONTEXT)) {
    throw new ModelConfigurationError("perception law context requires an unmodified request layout");
  }
  return { ...request, promptVersion: `${request.promptVersion}/${PERCEPTION_LAW_CONTEXT}`,
    jsonObjectPostlude: perceptionLawContextPostlude(request.context) };
}

const bodyShape = z.looseObject({ messages: z.array(z.looseObject({ role: z.string(), content: z.string() })) });

/** Compare all settings and text, allowing only the exact bound source index. */
export function verifyOnlyPerceptionLawContextAdded(baseline: unknown, treatment: unknown, context: unknown): void {
  const original = bodyShape.parse(baseline), changed = bodyShape.parse(treatment);
  const expected = structuredClone(original);
  const messages = expected.messages.filter(message => message.role === "user");
  if (messages.length !== 1 || messages[0]!.content.includes(heading)) {
    throw new ModelConfigurationError("perception law context requires one unmodified user message");
  }
  messages[0]!.content += perceptionLawContextPostlude(context);
  if (contentHash(expected) !== contentHash(changed)) {
    throw new ModelConfigurationError("perception treatment changed more than the exact law source index");
  }
}
