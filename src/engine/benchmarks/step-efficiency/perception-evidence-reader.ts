import { z } from "zod";
import { perceptionDirectiveSchema } from "../../contracts/llm-schemas";
import { canonicalize, contentHash } from "../../models/model-audit";
import { ModelConfigurationError, ModelOutputError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { compactPerceptionCatalog, PERCEPTION_CATALOG_TRANSPORT } from "./perception-catalog-transport";
import { buildPerceptionSourceIndex } from "./perception-source-index";

type Value = Record<string, unknown>;
const record = (value: unknown): Value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelConfigurationError("perception evidence reader requires an object source");
  return value as Value;
};
const instruction = loadPromptAsset("shared/perception-evidence-reader.md");
const completeInstruction = loadPromptAsset("shared/perception-evidence-complete.md");
export const PERCEPTION_EVIDENCE_READER = `perception-evidence-reader-v2@${contentHash({ instruction, completeInstruction, catalog: PERCEPTION_CATALOG_TRANSPORT }).slice(0, 16)}`;
const readSchema = z.strictObject({ kind: z.literal("read_evidence"), reads: z.array(z.strictObject({ table: z.string().min(1), keys: z.array(z.string().min(1)) })).min(1) });
export const perceptionEvidenceDirectiveSchema = z.union([perceptionDirectiveSchema, readSchema]);
type ReadDirective = z.infer<typeof readSchema>;

/**
 * Immutable data movement; semantic sufficiency remains the adjudicator's responsibility.
 * @see docs/decisions/0201-read-world-evidence-on-demand.md for the design and primary sources.
 */
export class PerceptionEvidenceReader {
  readonly sourceHash: string;
  private readonly sourceIndex: ReturnType<typeof buildPerceptionSourceIndex>;
  private readonly tables = new Map<string, Value>();
  private readonly loaded = new Map<string, Set<string>>();
  private readonly catalogView: Value;
  private readonly journal: Array<{ round: number; reads: ReadDirective["reads"]; resultHash: string }> = [];
  private complete = false;

  constructor(private readonly source: unknown, readonly maxReadRounds: number) {
    if (!Number.isSafeInteger(maxReadRounds) || maxReadRounds < 1) throw new ModelConfigurationError("perception read-round limit must be positive");
    this.sourceHash = contentHash(source);
    this.sourceIndex = buildPerceptionSourceIndex(source);
    this.catalogView = compactPerceptionCatalog(source);
    const state = record(record(source).state), truth = record(state.canonicalTruth);
    for (const [table, value] of Object.entries(truth)) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        this.tables.set(table, record(value)); this.loaded.set(table, new Set());
      }
    }
    const load = (table: string, key: unknown) => {
      if (typeof key !== "string" || !Object.hasOwn(this.tables.get(table) ?? {}, key)) throw new ModelConfigurationError(`missing initial perception evidence: ${table}/${String(key)}`);
      this.loaded.get(table)!.add(key);
    };
    for (const key of Object.keys(this.tables.get("mechanics") ?? {})) load("mechanics", key);
    for (const item of this.sourceIndex.workItems) {
      for (const node of [...item.observerPlacementChain, ...item.sourceActorPlacementChain]) {
        load("entities", node.entityRef); load("placements", node.placementRef);
      }
      for (const rating of item.observerRatings) load("ratings", rating.ratingRef);
    }
    const allKeys = new Map<string, string>();
    for (const [table, rows] of this.tables) for (const key of Object.keys(rows)) {
      if (allKeys.has(key)) throw new ModelConfigurationError("ambiguous canonical evidence key");
      allKeys.set(key, table);
    }
    const preloadChecks = (value: unknown): void => {
      if (typeof value === "string" && allKeys.has(value)) load(allKeys.get(value)!, value);
      else if (Array.isArray(value)) value.forEach(preloadChecks);
      else if (value && typeof value === "object") Object.values(value).forEach(preloadChecks);
    };
    preloadChecks(state.committedCheckRequests);
    this.complete = [...this.tables].every(([table, rows]) => this.loaded.get(table)!.size === Object.keys(rows).length);
  }

  assertSource(): void {
    if (contentHash(this.source) !== this.sourceHash) throw new ModelConfigurationError("perception evidence source changed after binding");
  }

  view(): Value {
    this.assertSource();
    const copy = structuredClone(this.catalogView), state = record(copy.state), truth = record(state.canonicalTruth);
    if (!this.complete) for (const [table, rows] of this.tables) {
      truth[table] = { totalRecords: Object.keys(rows).length, directory: Object.keys(rows),
        loaded: Object.fromEntries([...this.loaded.get(table)!].map(key => [key, structuredClone(rows[key])])) };
    }
    copy.evidenceAccess = { contract: PERCEPTION_EVIDENCE_READER, sourceHash: this.sourceHash,
      representation: this.complete ? "complete-source" : "partial-tables-with-complete-directories",
      remainingReadRounds: this.maxReadRounds - this.journal.length, completeContextTable: "source_context",
      readReceipts: structuredClone(this.journal), assignedSourceIndex: structuredClone(this.sourceIndex) };
    return copy;
  }

  read(value: unknown) {
    this.assertSource();
    const request = readSchema.parse(value);
    if (this.complete) throw new ModelOutputError("perception evidence is already complete; return a canonical perception decision");
    if (this.journal.length >= this.maxReadRounds) throw new ModelOutputError("perception evidence read limit reached; the attempt remains incomplete");
    const seen = new Set<string>();
    const results = request.reads.map(({ table, keys }) => {
      if (seen.has(table) || new Set(keys).size !== keys.length) throw new ModelOutputError(`duplicate perception read selector for ${table}; combine its exact keys once`);
      seen.add(table);
      if (table === "source_context") {
        if (keys.length) throw new ModelOutputError("source_context requires an empty keys array to read the complete snapshot");
        return { table, keys: [], records: structuredClone(this.source), hash: this.sourceHash };
      }
      const rows = this.tables.get(table);
      if (!rows) throw new ModelOutputError(`unknown perception evidence table ${table}; use a displayed canonical table or source_context`);
      const selected = keys.length ? keys : Object.keys(rows);
      for (const key of selected) if (!Object.hasOwn(rows, key)) throw new ModelOutputError(`unknown evidence key ${key} in ${table}; select an exact directory key`);
      const records = Object.fromEntries(selected.map(key => [key, structuredClone(rows[key])]));
      return { table, keys: selected, records, hash: contentHash(records) };
    });
    if (!results.some(result => result.table === "source_context" || result.keys.some(key => !this.loaded.get(result.table)!.has(key)))) {
      throw new ModelOutputError("perception read adds no evidence; select unread values or return a canonical perception decision");
    }
    for (const result of results) {
      if (result.table === "source_context") this.complete = true;
      else result.keys.forEach(key => this.loaded.get(result.table)!.add(key));
    }
    if ([...this.tables].every(([table, rows]) => this.loaded.get(table)!.size === Object.keys(rows).length)) this.complete = true;
    const response = { sourceHash: this.sourceHash, round: this.journal.length + 1, results };
    this.journal.push({ round: response.round, reads: structuredClone(request.reads), resultHash: contentHash(response) });
    return response;
  }

  assertLoadedReferences(value: unknown): void {
    this.assertSource();
    if (this.complete) return;
    const walk = (node: unknown): void => {
      if (typeof node === "string") {
        for (const [table, rows] of this.tables) if (Object.hasOwn(rows, node) && !this.loaded.get(table)!.has(node)) {
          throw new ModelOutputError(`perception result cites unread evidence ${node}; read its value from ${table} before deciding`);
        }
      } else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") Object.values(node).forEach(walk);
    };
    walk(value);
  }

  request(request: StructuredModelRequest<unknown>): StructuredModelRequest<unknown> {
    this.assertSource();
    if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive" || contentHash(request.context) !== this.sourceHash ||
      request.promptVersion.includes(PERCEPTION_EVIDENCE_READER)) throw new ModelConfigurationError("perception reader requires its unadapted source request");
    const wire = structuredClone(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
    const alternatives = wire.oneOf ?? wire.anyOf;
    if (!Array.isArray(alternatives)) throw new ModelConfigurationError("perception reader requires the original directive union");
    if (!this.complete) alternatives.push(z.toJSONSchema(readSchema, { target: "draft-07" }));
    return { ...request, schemaName: this.complete ? request.schemaName : "truth_perception_evidence_directive",
      schema: this.complete ? request.schema : perceptionEvidenceDirectiveSchema, wireJsonSchema: wire, jsonExamplePolicy: "omit",
      promptVersion: `${request.promptVersion}/${PERCEPTION_EVIDENCE_READER}`,
      jsonObjectPostlude: `${request.jsonObjectPostlude ?? ""}\n\n${this.complete ? completeInstruction : instruction}`,
      preprocessOutput: value => {
        this.assertSource();
        if (record(value).kind === "read_evidence") return { value, symbolRepairs: [] };
        this.assertLoadedReferences(value);
        return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
      } };
  }

  transformBody(body: unknown): Value {
    this.assertSource();
    const copy = structuredClone(record(body));
    const users = Array.isArray(copy.messages) ? copy.messages.map(record).filter(message => message.role === "user") : [];
    const source = JSON.stringify(canonicalize(this.source));
    if (users.length !== 1 || typeof users[0]!.content !== "string" || users[0]!.content.split(source).length !== 2) throw new ModelConfigurationError("perception reader HTTP context does not match its source");
    users[0]!.content = users[0]!.content.replace(source, JSON.stringify(canonicalize(this.view())));
    return copy;
  }
}
