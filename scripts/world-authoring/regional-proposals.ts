import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";
import type { SourceParagraph } from "./extraction-contract";

const key = z.string().min(1);
const time = z.strictObject({ status: z.enum(["confirmed", "backprojection", "future", "unknown"]), reason: key });
export const regionalProposalSchema = z.strictObject({ records: z.array(z.strictObject({
  moduleId: key, candidateId: key,
  recommendation: z.enum(["accept", "correct", "alias", "history", "later", "defer", "out-of-scope", "transfer"]),
  sourceClaim: key, reason: key, targetIds: z.array(key), destinationModule: key.nullable(),
  existenceAtOpening: time, statementAtOpening: time, learnedTime: key,
  conflicts: z.array(key), missingContent: z.array(key), evidence: z.array(z.strictObject({ paragraph: key })).min(1),
})) });
export type RegionalProposal = z.infer<typeof regionalProposalSchema>;
export interface RegionalProposalTask { moduleId: string; candidateId: string; sourceChapterIds: string[] }

/** A complete preliminary opinion cannot approve, mutate, or close an editorial queue. */
export function validateRegionalProposal(input: unknown, tasks: RegionalProposalTask[], paragraphs: SourceParagraph[],
  targetIds: ReadonlySet<string>, moduleIds: ReadonlySet<string>) {
  const result = regionalProposalSchema.parse(input);
  const identity = (row: { moduleId: string; candidateId: string }) => `${row.moduleId}\0${row.candidateId}`;
  const expected = new Map(tasks.map(task => [identity(task), task]));
  if (expected.size !== tasks.length) throw new Error("duplicate regional proposal task");
  const seen = new Set<string>();
  const byId = new Map(paragraphs.map(paragraph => [paragraph.id, paragraph]));
  for (const row of result.records) {
    const id = identity(row), task = expected.get(id);
    if (!task) throw new Error(`unexpected regional proposal ${id}`);
    if (seen.has(id)) throw new Error(`duplicate regional proposal ${id}`);
    seen.add(id);
    if (new Set(row.targetIds).size !== row.targetIds.length) throw new Error(`duplicate proposal target ${id}`);
    for (const target of row.targetIds) if (!targetIds.has(target)) throw new Error(`unknown proposal target ${target}`);
    if (["accept", "alias"].includes(row.recommendation) && (!row.targetIds.length || row.missingContent.length || row.conflicts.length)) {
      throw new Error(`accept/alias requires existing complete targets and no unresolved conflict ${id}: recommendation=${row.recommendation}, targetIds=${JSON.stringify(row.targetIds)}, missingContent=${JSON.stringify(row.missingContent)}, conflicts=${JSON.stringify(row.conflicts)}; keep substantive gaps and use defer/correct, or remove a gap only after checking the provided source and authored targets`);
    }
    if ((row.recommendation === "transfer") !== (row.destinationModule !== null)) throw new Error(`invalid proposal transfer ${id}: destinationModule=${JSON.stringify(row.destinationModule)}, recommendation=${row.recommendation}; destinationModule must be null unless recommendation is transfer, and transfer requires a different known module`);
    if (row.destinationModule !== null && (row.destinationModule === row.moduleId || !moduleIds.has(row.destinationModule))) throw new Error(`unknown proposal destination ${id}`);
    for (const ref of row.evidence) if (!byId.has(ref.paragraph)) throw new Error(`unknown proposal paragraph ${ref.paragraph}`);
    if (!row.evidence.some(ref => task.sourceChapterIds.includes(byId.get(ref.paragraph)!.chapterId))) throw new Error(`missing original candidate source ${id}`);
  }
  const missing = [...expected.keys()].filter(id => !seen.has(id));
  if (missing.length) throw new Error(`missing regional proposals: ${missing.join(", ")}`);
  return result;
}

export function regionalProposalSchemaFor(tasks: RegionalProposalTask[], paragraphs: SourceParagraph[]) {
  if (!paragraphs.length || !tasks.length) throw new Error("regional proposal requires tasks and complete source");
  return regionalProposalSchema.extend({ records: z.array(regionalProposalSchema.shape.records.element.extend({
    evidence: z.array(z.strictObject({ paragraph: z.enum(paragraphs.map(paragraph => paragraph.id)) })).min(1),
  })).length(tasks.length) });
}

export function editorialModuleSnapshot(moduleInput: unknown, claimsInput: unknown, subjectsInput: unknown = []) {
  const entry = z.object({ id: z.string() }).passthrough();
  const region = z.object({ entities: z.array(entry), laws: z.array(z.unknown()).default([]), quantityDefinitions: z.array(z.unknown()).default([]) }).passthrough().parse(moduleInput);
  const claims = z.array(entry).parse(claimsInput), subjects = z.array(entry).parse(subjectsInput);
  return { hash: contentHash({ module: moduleInput, claims: claimsInput, subjects: subjectsInput }),
    entities: region.entities.map(entity => { const copy = { ...entity }; delete copy.agent; return copy; }),
    claims, subjects, laws: region.laws, quantityDefinitions: region.quantityDefinitions };
}

/** The opening package is part of the authored world, even though it is not a region. */
export function editorialOpeningSnapshot(input: unknown, claims: unknown) {
  const opening = z.object({ template: z.object({
    entities: z.array(z.unknown()),
    laws: z.object({ laws: z.array(z.unknown()) }),
    mechanics: z.object({ quantities: z.array(z.unknown()) }),
  }).passthrough() }).passthrough().parse(input);
  const snapshot = editorialModuleSnapshot({ entities: opening.template.entities,
    laws: opening.template.laws.laws, quantityDefinitions: opening.template.mechanics.quantities }, claims);
  return { ...snapshot, hash: contentHash({ module: input, claims }) };
}
