import { z } from "zod";
import type { SourceParagraph } from "./extraction-contract";
import { sourceAdjudicationSchemaFor, validateSourceAdjudication,
  type AdjudicationInput, type SourceAdjudication } from "./source-adjudication";
import { sourceValidationDiagnostics } from "./source-validation-diagnostics";

const keyedCollections = ["records", "aliases", "issues"] as const;
const indexedCollections = ["omissions", "identities"] as const;
type Collection = typeof keyedCollections[number] | typeof indexedCollections[number];
type Row = Record<string, unknown>;
type Target = { key: string; index: number | null; previous: unknown; problems: string[] };
type RepairPlan = { collection: Collection; targets: Target[]; rows: unknown[] };

function object(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rowKey(collection: Collection, value: unknown): string | undefined {
  if (!object(value)) return undefined;
  if (collection === "aliases") return typeof value.objectId === "string" && typeof value.alias === "string"
    ? JSON.stringify([value.objectId, value.alias]) : undefined;
  return typeof value.id === "string" ? value.id : undefined;
}

function sameKeys(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length &&
    actual.every(key => expected.includes(key));
}

/** Repairs replace only identified invalid rows; full source validation still owns acceptance. */
export function createAdjudicationRepair(draft: unknown, input: AdjudicationInput, paragraphs: SourceParagraph[]):
{ schema: z.ZodType; context: unknown; merge(patch: unknown): unknown } | undefined {
  const collections = [...keyedCollections, ...indexedCollections];
  if (!object(draft) || Object.keys(draft).some(key => !["chapters", ...collections].includes(key)) ||
    !paragraphs.length || new Set(paragraphs.map(paragraph => paragraph.id)).size !== paragraphs.length) return undefined;
  // Missing open-ended inventories cannot establish that an omissions or identity scan occurred.
  if (indexedCollections.some(key => !Array.isArray(draft[key]))) return undefined;
  if (keyedCollections.some(key => draft[key] !== undefined && !Array.isArray(draft[key]))) return undefined;
  const source = structuredClone(input), sources = structuredClone(paragraphs);
  const original = structuredClone(draft);
  const fullSchema = sourceAdjudicationSchemaFor(source, sources);
  const expected: Record<typeof keyedCollections[number], string[]> = {
    records: [...source.objects, ...source.facts].map(row => row.id),
    aliases: source.objects.flatMap(row => row.aliases.map(alias => JSON.stringify([row.id, alias]))),
    issues: source.issues.map(row => row.id),
  };
  if (Object.values(expected).some(keys => new Set(keys).size !== keys.length) ||
    new Set(source.chapters).size !== source.chapters.length) return undefined;
  const objectIds = new Set(source.objects.map(row => row.id));
  const plans: RepairPlan[] = [];
  const shape: Record<string, z.ZodType> = {};
  const problemsFor = (collection: Collection, row: unknown): string[] => {
    const parsed = fullSchema.shape[collection].element.safeParse(row);
    if (!parsed.success) return [sourceValidationDiagnostics(parsed.error, row)];
    const value = parsed.data as unknown as Row, problems: string[] = [];
    if (collection === "records" && objectIds.has(String(value.id)) !== (value.existenceAtOpening !== null)) {
      problems.push("Object existence at opening must be supplied for objects and null for facts; distinguish existence from the statement's time.");
    }
    const evidence = value.evidence as unknown[];
    if (["records", "aliases"].includes(collection) && value.verdict === "supported" && !evidence.length) {
      problems.push("A supported judgment requires source evidence.");
    }
    if (collection === "issues" && value.status === "resolved-in-this-batch" && !evidence.length) {
      problems.push("A resolved issue requires source evidence; procedural notes do not resolve it.");
    }
    if (collection === "identities" && value.relation !== "unresolved" && !evidence.length) {
      problems.push("A resolved identity relation requires source evidence.");
    }
    return problems;
  };

  for (const collection of keyedCollections) {
    const rows = (original[collection] ?? []) as unknown[], byKey = new Map<string, { row: unknown; index: number }>();
    for (const [index, row] of rows.entries()) {
      const key = rowKey(collection, row);
      // Foreign, missing or conflicting identities cannot safely be assigned to a repair target.
      if (key === undefined || !expected[collection].includes(key) || byKey.has(key)) return undefined;
      byKey.set(key, { row, index });
    }
    const targets = expected[collection].flatMap(key => {
      const present = byKey.get(key), problems = present ? problemsFor(collection, present.row) : ["The required input row is missing."];
      return problems.length ? [{ key, index: present?.index ?? null, previous: present?.row ?? null, problems }] : [];
    });
    if (!targets.length) continue;
    const aliasPairs = collection === "aliases" ? targets.map(target => JSON.parse(target.key) as [string, string]) : [];
    const rowSchema = collection === "aliases"
      ? fullSchema.shape.aliases.element.extend({ objectId: z.enum([...new Set(aliasPairs.map(pair => pair[0]))]),
        alias: z.enum([...new Set(aliasPairs.map(pair => pair[1]))]) })
      : collection === "records" ? fullSchema.shape.records.element.extend({ id: z.enum(targets.map(target => target.key)) })
        : fullSchema.shape.issues.element.extend({ id: z.enum(targets.map(target => target.key)) });
    shape[collection] = z.array(rowSchema).length(targets.length)
      .refine(rows => sameKeys(rows.map(row => rowKey(collection, row)!), targets.map(target => target.key)), "Each repair target must occur exactly once.");
    plans.push({ collection, targets, rows });
  }
  for (const collection of indexedCollections) {
    const rows = original[collection] as unknown[];
    const targets = rows.flatMap((row, index) => {
      const problems = problemsFor(collection, row);
      return problems.length ? [{ key: String(index), index, previous: row, problems }] : [];
    });
    if (!targets.length) continue;
    shape[collection] = z.array(z.strictObject({ index: z.number().int().nonnegative(), value: fullSchema.shape[collection].element }))
      .length(targets.length).refine(rows => sameKeys(rows.map(row => String(row.index)), targets.map(target => target.key)),
        "Only the listed original row indices may be repaired, each exactly once.");
    plans.push({ collection, targets, rows });
  }
  const repairChapters = !Array.isArray(original.chapters) || !original.chapters.every(value => typeof value === "string") ||
    !sameKeys(original.chapters as string[], source.chapters);
  if (repairChapters) shape.chapters = z.array(z.string()).length(source.chapters.length)
    .refine(chapters => sameKeys(chapters, source.chapters), "Provide the complete input chapter list exactly once.");
  if (!Object.keys(shape).length) return undefined;
  const schema = z.strictObject(shape);
  return {
    schema,
    context: {
      task: "Return only the listed repair rows in their named collections. Keep complete sourceClaim and every required field in each replacement. Other rows are retained unchanged. For omissions and identities, index is the original zero-based row index, not a new position. This patch does not replace the initial full-source scan.",
      targets: plans.map(plan => ({ collection: plan.collection, rows: plan.targets.map(target => ({
        ...(plan.collection === "aliases" ? { objectId: JSON.parse(target.key)[0], alias: JSON.parse(target.key)[1] }
          : indexedCollections.some(key => key === plan.collection) ? { index: target.index } : { id: target.key }),
        previous: structuredClone(target.previous), problems: target.problems,
      })) })),
      ...(repairChapters ? { chapters: { previous: original.chapters ?? null, required: [...source.chapters] } } : {}),
    },
    merge(patch: unknown) {
      const replacements = schema.parse(patch) as Record<string, unknown[]>;
      const result = structuredClone(original);
      for (const plan of plans) {
        const rows = structuredClone(plan.rows);
        const indexed = indexedCollections.some(key => key === plan.collection);
        for (const replacement of replacements[plan.collection]!) {
          const row = indexed ? (replacement as { value: unknown }).value : replacement;
          const key = indexed ? String((replacement as { index: number }).index) : rowKey(plan.collection, row)!;
          const target = plan.targets.find(target => target.key === key)!;
          if (target.index === null) rows.push(structuredClone(row));
          else rows[target.index] = structuredClone(row);
        }
        result[plan.collection] = rows;
      }
      if (repairChapters) result.chapters = replacements.chapters;
      for (const key of keyedCollections) if (result[key] === undefined) result[key] = [];
      const complete: SourceAdjudication = fullSchema.parse(result);
      validateSourceAdjudication(complete, source, sources);
      return complete;
    },
  };
}
