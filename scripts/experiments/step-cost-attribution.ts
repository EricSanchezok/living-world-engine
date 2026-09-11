import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { contentHash } from "../../src/engine/models/model-audit";
import { ExperimentBudget, type ExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { STEP_E2_BUDGET } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { attributeTokenCost, httpConcurrency, recordedLogicalRepair, recordedPhysicalRepair, verifyHttpUsage } from "../../src/engine/benchmarks/step-efficiency/cost-attribution";
import { recordedContext } from "../../src/engine/benchmarks/step-efficiency/repair-tail";
import { DEEPSEEK_FLASH_TARIFF_20260908, documentedFlashCost } from "../../src/engine/benchmarks/step-efficiency/documented-pricing";

const [rootArgument, outputArgument] = process.argv.slice(2);
if (!rootArgument || !outputArgument) throw new Error("usage: step-cost-attribution.ts E2-root separate-output-directory");
const root = path.resolve(rootArgument), output = path.resolve(outputArgument);
if (root === output || existsSync(path.join(root, "writer.lock"))) throw new Error("requires separate output and a drained writer");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const budget = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET);
if (budget.summary.blockingUnknown.length) throw new Error("review and quarantine unsettled evidence before this drained-run audit");
type Entry = { kind: string; id: string; trialId: string; priceId?: string; usage: ExperimentUsage };
const entries = readFileSync(path.join(root, "budget.jsonl"), "utf8").trim().split("\n")
  .map(line => (JSON.parse(line) as { entry: Entry }).entry);
const reserved = new Map(entries.filter(entry => entry.kind === "reserve").map(entry => [entry.id, entry]));
const settlements = new Map(entries.filter(entry => ["settle", "reconcile_overrun"].includes(entry.kind)).map(entry => [entry.id, entry]));

/** Explicit prompt/schema signatures; unrecognized roles stay unclassified. */
function roleFor(message: string, schema: Record<string, unknown>) {
  if (message.startsWith("Initialize this character's private beliefs")) return "bootstrap";
  if (message.startsWith("Inspect the proposed actions and accessible world evidence")) return "truth-perception";
  if (message.startsWith("Audit the candidate transition in")) return "causal-review";
  if (message.startsWith("Compile the assigned action slots.")) return "action-compilation";
  if (message.startsWith("Use the supplied perspective, prepared action")) return "agent-reaction";
  if (message.startsWith("Produce one candidate transition")) return "truth-transition";
  if (message.startsWith("Review each plan in")) return "resolution-plan-review";
  if (message.startsWith("Render each supplied task's assigned observer")) return "observation-rendering";
  const wire = JSON.stringify(schema);
  if (message.startsWith("Commit exactly one grounded plan")) return wire.includes('"const":"commit_plans"') ? "resolution-plan" : "resolution-continuation";
  return "unclassified";
}

const rows = [...settlements.values()].map(entry => {
  const reservation = reserved.get(entry.id);
  if (!reservation) throw new Error("settlement without reservation");
  const request = read(path.join(root, "http", entry.id, "request.json"));
  const response = read(path.join(root, "http", entry.id, "response.json"));
  if (request.id !== entry.id || response.id !== entry.id || request.trial.id !== reservation.trialId) throw new Error("HTTP/ledger identity mismatch");
  const usage = verifyHttpUsage(request, response, entry.usage);
  const price = STEP_E2_BUDGET.prices![reservation.priceId!];
  if (!price) throw new Error("price binding missing");
  const cost = attributeTokenCost(usage, price);
  const body = JSON.parse(response.raw);
  if (request.body.model !== DEEPSEEK_FLASH_TARIFF_20260908.model || body.model !== request.body.model) throw new Error("documented tariff model mismatch");
  const providerAmountFields = { response: Object.keys(body).filter(key => /cost|price|amount|billing/iu.test(key)),
    usage: Object.keys(body.usage).filter(key => /cost|price|amount|billing/iu.test(key)) };
  const base = { id: entry.id, trialId: reservation.trialId, bodyHash: request.bodyHash, responseHash: response.rawHash,
    startedAt: request.startedAt as string, completedAt: response.completedAt as string,
    elapsedMs: response.elapsedMs as number, inFlightAtDispatch: request.inFlightAtDispatch ?? null, usage, ...cost,
    providerAmountFields, documentedTariff: documentedFlashCost(usage, request.startedAt, response.completedAt) };
  if (!reservation.trialId.startsWith("trajectory-")) return { ...base, role: "experiment-probe", detail: null };
  const message = request.body.messages.find((item: { role: string }) => item.role === "user")?.content as string;
  if (!message) throw new Error("gameplay request has no user message");
  const context = recordedContext(message).value;
  const schemaText = message.split("\nJSON Schema: ")[1]?.split("\n")[0];
  if (!schemaText) throw new Error("gameplay schema evidence missing");
  const schema = JSON.parse(schemaText);
  const logicalRepair = recordedLogicalRepair(context), shared = logicalRepair.shared;
  const physicalRepair = recordedPhysicalRepair(message, context);
  const role = roleFor(message, schema);
  const catalog = shared?.shared.referenceCatalog as { candidates?: unknown } | undefined;
  const task = context.task as { slots?: unknown[] } | undefined;
  return { ...base, role, detail: {
    schemaHash: contentHash(schema), schemaBytes: Buffer.byteLength(schemaText), contextHash: contentHash(context), contextBytes: bytes(context),
    ...physicalRepair, ...logicalRepair.detail, physicalSlotCount: task?.slots?.length ?? null,
    exactPhysicalCardinality: task?.slots ? schema.properties?.slots?.minItems === task.slots.length && schema.properties?.slots?.maxItems === task.slots.length : null,
    emptySlotsExample: message.includes('Example JSON output shape: {"slots":[]}'),
    sharedCatalogBytes: catalog ? bytes(catalog) : 0,
    catalogOrderBytes: shared?.slots.reduce((sum, slot) => sum + (slot.catalogCandidateOrder ? bytes(slot.catalogCandidateOrder) : 0), 0) ?? 0,
  } };
});
const sum = (items: typeof rows, fn: (row: typeof rows[number]) => number) => items.reduce((n, row) => n + fn(row), 0);
const aggregate = (items: typeof rows) => ({ http: items.length,
  inputTokens: sum(items, row => row.usage.input), outputTokens: sum(items, row => row.usage.output), cacheHitTokens: sum(items, row => row.usage.cacheHit),
  costNanoCny: sum(items, row => row.totalNanoCny), missCostNanoCny: sum(items, row => row.missNanoCny),
  hitCostNanoCny: sum(items, row => row.hitNanoCny), outputCostNanoCny: sum(items, row => row.outputNanoCny),
  allInputCachedSensitivityNanoCny: sum(items, row => row.allInputCachedSensitivityNanoCny),
  documentedTariffDispatchEstimateNanoCny: sum(items, row => row.documentedTariff.dispatchEstimateNanoCny),
  documentedTariffIntervalMinimumNanoCny: sum(items, row => row.documentedTariff.intervalMinimumNanoCny),
  documentedTariffIntervalMaximumNanoCny: sum(items, row => row.documentedTariff.intervalMaximumNanoCny),
  requestsCrossingTariffBoundary: items.filter(row => row.documentedTariff.crossesTariffBoundary).length,
  identifiedRepairHttp: items.filter(row => row.detail?.physicalRepair || row.detail?.logicalRepair).length,
  identifiedRepairCostNanoCny: sum(items, row => row.detail?.physicalRepair || row.detail?.logicalRepair ? row.totalNanoCny : 0),
  documentedTariffRepairEstimateNanoCny: sum(items, row => row.detail?.physicalRepair || row.detail?.logicalRepair ? row.documentedTariff.dispatchEstimateNanoCny : 0),
  concurrency: httpConcurrency(items),
});
const uncertainRequests = budget.summary.quarantinedUnknown.map(id => {
  const reservation = reserved.get(id);
  if (!reservation) throw new Error("quarantined request lacks a reservation");
  const request = read(path.join(root, "http", id, "request.json"));
  if (request.id !== id || request.trial.id !== reservation.trialId || contentHash(request.body) !== request.bodyHash) throw new Error("unsettled request evidence mismatch");
  const responsePath = path.join(root, "http", id, "response.json");
  const response = existsSync(responsePath) ? read(responsePath) : null;
  if (response && (response.id !== id || contentHash(response.raw) !== response.rawHash)) throw new Error("unsettled response evidence mismatch");
  return { id, trialId: reservation.trialId, bodyHash: request.bodyHash, responseHash: response?.rawHash ?? null,
    status: response?.status ?? null, usage: null, costNanoCny: null, reservation, quarantine: entries.find(entry => entry.kind === "quarantine" && entry.id === id) };
});
const knownTotal = aggregate(rows);
const total = { ...knownTotal, http: knownTotal.http + uncertainRequests.length, knownUsageHttp: knownTotal.http,
  unknownUsageHttp: uncertainRequests.length, unknownReservedNanoCny: budget.summary.reservedNanoCny,
  reviewedAdmissionKnownNanoCny: budget.summary.estimatedPeakNanoCny,
  budgetExposureNanoCny: budget.summary.estimatedPeakNanoCny + budget.summary.reservedNanoCny };
if (total.costNanoCny !== budget.summary.originalEstimatedPeakNanoCny) throw new Error("attribution does not reconcile to the original complete budget valuation");
const trials = [...new Set([...rows, ...uncertainRequests].map(row => row.trialId))].map(trialId => {
  const selected = rows.filter(row => row.trialId === trialId);
  const known = aggregate(selected), unknownUsageHttp = uncertainRequests.filter(row => row.trialId === trialId).length;
  return { trialId, ...known, http: known.http + unknownUsageHttp, knownUsageHttp: known.http, unknownUsageHttp,
    roles: Object.fromEntries([...new Set(selected.map(row => row.role))]
    .map(role => [role, aggregate(selected.filter(row => row.role === role))])) };
});
const report = { method: "drained-E2-known-usage-and-quarantined-HTTP-v3", budget: budget.summary,
  documentedTariff: DEEPSEEK_FLASH_TARIFF_20260908, documentedTariffHash: contentHash(DEEPSEEK_FLASH_TARIFF_20260908), total, trials, rows, uncertainRequests,
  caveats: ["A failed step's root work is not a measured successful-gameplay cost floor.",
    "Request and role costs retain original frozen rates. Reviewed peak-price valuations, when present, affect only the separately named admission total and remain tariff estimates rather than invoices.",
    "HTTP counts include explicitly quarantined sends. Token and cost aggregates describe known usage only; uncertain sends retain their full ceiling in budget exposure, never zero-priced or silently refunded.",
    "Repair attribution covers trajectory HTTP with explicit logical feedback or physical feedback in either context or a verified transport tail; probe repetitions, unlabelled split descendants and rescheduling remain excluded.",
    "Failure tail and repairs can overlap; they cannot be added as independent savings.",
    "All-input-cached cost is sensitivity at unchanged token counts, not attainable savings or an invoice.",
    "Documented-tariff estimates apply the reviewed tariff to historical usage; they do not establish historical prices, billing currency, account discounts or actual debits.",
    "Credential rotation does not establish an account change; request evidence contains no provider account identity.",
    "HTTP interval union excludes local work; overlapping duration sums are not wall time.",
    "JSON byte counts are representation diagnostics, not model tokens or guaranteed cache hits."] };
mkdirSync(output, { recursive: true });
const destination = path.join(output, `audit-${contentHash(report)}.json`);
writeFileSync(destination, JSON.stringify(report, null, 2), { flag: "wx" });
console.log(JSON.stringify({ destination, total, trajectories: trials.filter(trial => trial.trialId.startsWith("trajectory-")) }, null, 2));
