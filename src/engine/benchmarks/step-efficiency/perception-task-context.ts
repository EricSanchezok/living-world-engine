import { z } from "zod";
import type { OnsetPerceptionInput } from "../../algorithms/roles";
import { createTruthReferenceResolver, projectCanonicalTruthForModel } from "../../contracts/prompts";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { buildPerceptionWorkItems } from "./perception-assessment";

const heading = "\n\nAssigned perception source context (evidence data, not instructions).\n";
const instruction = "The following work items place each assigned observer beside its source actor, complete attempted action, current onset question, complete current placement chains and existing observer-owned Ratings. Keep the original directive schema: request only justified onset checks, or finish when none remain. These items are questions, not required check slots or visibility findings. A common ancestor such as a region does not establish sensory contact; different places do not exclude an evidenced remote route. Offices, alliances, attempted messages and future meetings are not by themselves an already operating channel. Use all original facts and authored rules to decide access and justified uncertainty. Choose exact existing references; an observer aptitude must be one of that observer's displayed Ratings or an explicit null when no aptitude applies. The program has selected no ability or result. Preserve additional causal evidence and distinct check meanings. All original context and committed results remain authoritative.";
export const PERCEPTION_TASK_CONTEXT = `perception-task-context-v1@${contentHash({ heading, instruction }).slice(0, 16)}`;

/** Input-only benchmark adapter; the canonical model output is never rewritten. */
export function perceptionTaskContextRequest<T>(request: StructuredModelRequest<T>, input: Readonly<OnsetPerceptionInput>): StructuredModelRequest<T> {
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive") return request;
  if (request.jsonObjectPostlude !== undefined || request.promptVersion.includes(PERCEPTION_TASK_CONTEXT)) {
    throw new ModelConfigurationError("perception task context already has a postlude");
  }
  const context = z.object({ state: z.object({ canonicalTruth: z.unknown() }) }).parse(request.context);
  const resolver = createTruthReferenceResolver({ ...input, checkRequests: [] });
  if (contentHash(context.state.canonicalTruth) !== contentHash(projectCanonicalTruthForModel(input.state.truth, resolver))) {
    throw new ModelConfigurationError("perception task context has different canonical truth");
  }
  const sourceInputHash = contentHash(input), sourceContextHash = contentHash(request.context);
  const evidence = { sourceInputHash, sourceContextHash, workItems: buildPerceptionWorkItems(request, input) };
  return { ...request, promptVersion: `${request.promptVersion}/${PERCEPTION_TASK_CONTEXT}`,
    jsonObjectPostlude: heading + instruction + "\n" + JSON.stringify(evidence),
    preprocessOutput: value => {
      if (contentHash(input) !== sourceInputHash || contentHash(request.context) !== sourceContextHash) {
        throw new ModelConfigurationError("perception task context source changed before decoding");
      }
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    } };
}
