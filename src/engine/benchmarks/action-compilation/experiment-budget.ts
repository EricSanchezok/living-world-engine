import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { contentHash } from "../../models/model-audit";

export const EXPERIMENT_PHASES = ["discovery", "confirmation", "probes", "calibration", "review"] as const;
export type ExperimentPhase = typeof EXPERIMENT_PHASES[number] | "trajectory";
const budgetPhases = [...EXPERIMENT_PHASES, "trajectory"] as const;

export const AC_FP1_BUDGET = Object.freeze({
  currency: "CNY",
  maximumNanoCny: 1_000_000_000_000,
  inputMissNanoCnyPerToken: 3_000,
  inputHitNanoCnyPerToken: 100,
  outputNanoCnyPerToken: 9_000,
  pricingSource: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
  pricingCheckedAt: "2026-09-05",
  modelId: "deepseek-v4-flash",
  maxHttpRequests: { discovery: 200, confirmation: 400 },
  maxKnownTokens: { discovery: 8_000_000, confirmation: 16_000_000 },
});

export interface ExperimentPrice {
  accountId: string;
  modelId: string;
  inputMissNanoCnyPerToken: number;
  inputHitNanoCnyPerToken: number;
  outputNanoCnyPerToken: number;
  pricingSource: string;
  pricingCheckedAt: string;
}

export interface ExperimentBudgetPolicy {
  maximumNanoCny: number;
  inputMissNanoCnyPerToken: number;
  inputHitNanoCnyPerToken: number;
  outputNanoCnyPerToken: number;
  maxHttpRequests: Partial<Record<ExperimentPhase, number>>;
  maxKnownTokens: Partial<Record<ExperimentPhase, number>>;
  prices?: Record<string, ExperimentPrice>;
  phaseBudgets?: Array<{ phases: ExperimentPhase[]; maximumNanoCny: number }>;
  /** Explicit opt-in for a live single writer; recovered unsettled sends remain unknown. */
  maxConcurrentRequests?: number;
}

const integer = z.number().int().nonnegative().safe();
const usageSchema = z.strictObject({ input: integer, output: integer, cacheHit: integer });
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const reviewedPriceSchema = z.strictObject({
  accountId: z.string().min(1), modelId: z.string().min(1),
  inputMissNanoCnyPerToken: integer.positive(), inputHitNanoCnyPerToken: integer.positive(), outputNanoCnyPerToken: integer.positive(),
  pricingSource: z.url(), pricingCheckedAt: z.string().min(1),
});
const phaseBudgetsSchema = z.array(z.strictObject({
  phases: z.array(z.enum(budgetPhases)).min(1), maximumNanoCny: integer,
})).min(1).max(budgetPhases.length);
const entrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("register_model_price"), priceId: z.string().min(1), price: reviewedPriceSchema,
    reason: z.string().min(10), evidenceHash: hashSchema,
    budgetHash: z.string(), previousHash: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("reconcile_routed_usage"), id: z.string().min(1), priceId: z.string().min(1),
    requestedModelId: z.string().min(1), servedModelId: z.string().min(1), usage: usageSchema,
    reason: z.string().min(10), evidenceHash: hashSchema,
    budgetHash: z.string(), previousHash: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("authorize_tranche"), id: z.string().min(1), amountNanoCny: integer.positive(),
    priorExposureNanoCny: integer, reason: z.string().min(10), evidenceHash: hashSchema,
    budgetHash: z.string(), previousHash: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("review_peak_prices"), priceId: z.string().min(1), originalPriceHash: hashSchema,
    price: reviewedPriceSchema, requests: z.array(z.strictObject({ id: z.string().min(1), usageHash: hashSchema })).min(1),
    reason: z.string().min(10), evidenceHash: hashSchema,
    budgetHash: z.string(), previousHash: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("reallocate_phases"), phaseBudgets: phaseBudgetsSchema,
    reason: z.string().min(10), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    budgetHash: z.string(), previousHash: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("reserve"), id: z.string().min(1), trialId: z.string().min(1),
    phase: z.enum(budgetPhases), inputCeiling: integer.positive(), outputCeiling: integer.positive(),
    version: z.literal(2).optional(), priceId: z.string().min(1).optional(), priceHash: z.string().optional(),
    budgetHash: z.string(), previousHash: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("settle"), id: z.string().min(1), usage: usageSchema,
    budgetHash: z.string(), previousHash: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("quarantine"), id: z.string().min(1), reason: z.string().min(10),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    budgetHash: z.string(), previousHash: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("reconcile_overrun"), id: z.string().min(1), usage: usageSchema,
    reason: z.string().min(10), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    budgetHash: z.string(), previousHash: z.string().nullable(),
  }),
]);
type Entry = z.infer<typeof entrySchema>;
export type ExperimentUsage = z.infer<typeof usageSchema>;
type Reservation = Extract<Entry, { kind: "reserve" }>;

export class ExperimentBudgetError extends Error {
  constructor(message: string) { super(message); this.name = "ExperimentBudgetError"; }
}

/** Unknown sends block work unless explicitly quarantined at their full reserved ceiling. */
export class ExperimentBudget {
  private readonly reservations = new Map<string, Reservation>();
  private readonly settlements = new Map<string, ExperimentUsage>();
  private lastHash: string | null = null;
  private readonly liveRequests = new Set<string>();
  private readonly quarantines = new Map<string, Extract<Entry, { kind: "quarantine" }>>();
  private readonly reconciledOverruns = new Set<string>();
  private readonly reviewedPrices = new Map<string, ExperimentPrice>();
  private readonly registeredPrices = new Map<string, ExperimentPrice>();
  private readonly routedResponses = new Map<string, Extract<Entry, { kind: "reconcile_routed_usage" }>>();
  private readonly priceReviews: Array<{ evidenceHash: string; requests: number; priceHash: string }> = [];
  private phaseBudgets: NonNullable<ExperimentBudgetPolicy["phaseBudgets"]>;
  private readonly authorizations: Array<Extract<Entry, { kind: "authorize_tranche" }>> = [];
  private tranche?: { entry: Extract<Entry, { kind: "authorize_tranche" }>; priorIds: Set<string> };
  private maximumNanoCny: number;
  readonly policyHash: string;

  constructor(private readonly journal: string, readonly policy: ExperimentBudgetPolicy = AC_FP1_BUDGET) {
    if (!Number.isSafeInteger(policy.maxConcurrentRequests ?? 1) ||
      (policy.maxConcurrentRequests ?? 1) < 1 || (policy.maxConcurrentRequests ?? 1) > 64) {
      throw new ExperimentBudgetError("invalid request concurrency limit");
    }
    this.maximumNanoCny = policy.maximumNanoCny;
    this.policyHash = contentHash(policy);
    this.phaseBudgets = structuredClone(policy.phaseBudgets ?? []);
    if (!existsSync(journal)) return;
    const text = readFileSync(journal, "utf8");
    if (text && !text.endsWith("\n")) throw new ExperimentBudgetError("budget journal has an incomplete final record");
    for (const line of text.trimEnd().split("\n").filter(Boolean)) {
      const frame = z.strictObject({ entry: entrySchema, sha256: z.string() }).parse(JSON.parse(line));
      if (contentHash(frame.entry) !== frame.sha256) throw new ExperimentBudgetError("budget record checksum mismatch");
      this.apply(frame.entry);
    }
  }

  private charge(input: number, output: number, cacheHit = 0, reservation?: Reservation, reviewed = false): number {
    const original = this.policy.prices ? this.price(reservation?.priceId ?? "") : this.policy;
    const price = (reviewed && reservation ? this.reviewedPrices.get(reservation.id) : undefined) ?? original;
    if (!price) throw new ExperimentBudgetError("missing account/model price binding");
    const value = (input - cacheHit) * price.inputMissNanoCnyPerToken +
      cacheHit * price.inputHitNanoCnyPerToken + output * price.outputNanoCnyPerToken;
    if (!Number.isSafeInteger(value) || value < 0) throw new ExperimentBudgetError("invalid token charge");
    return value;
  }

  get summary() {
    const phases = Object.fromEntries(budgetPhases.map((phase) => [phase, {
      httpRequests: 0, knownTokens: 0, estimatedPeakNanoCny: 0, reservedNanoCny: 0,
    }])) as Record<ExperimentPhase, { httpRequests: number; knownTokens: number; estimatedPeakNanoCny: number; reservedNanoCny: number }>;
    const unsettled: string[] = [];
    let reservedNanoCny = 0;
    let originalEstimatedPeakNanoCny = 0;
    let trancheKnownNanoCny = 0, trancheReservedNanoCny = 0;
    for (const [id, request] of this.reservations) {
      phases[request.phase].httpRequests += 1;
      const usage = this.settlements.get(id);
      if (!usage) {
        unsettled.push(id);
        const ceiling = this.charge(request.inputCeiling, request.outputCeiling, 0, request);
        reservedNanoCny += ceiling;
        phases[request.phase].reservedNanoCny += ceiling;
        if (this.tranche && !this.tranche.priorIds.has(id)) trancheReservedNanoCny += ceiling;
      } else {
        phases[request.phase].knownTokens += usage.input + usage.output;
        originalEstimatedPeakNanoCny += this.charge(usage.input, usage.output, usage.cacheHit, request);
        const known = this.charge(usage.input, usage.output, usage.cacheHit, request, true);
        phases[request.phase].estimatedPeakNanoCny += known;
        if (this.tranche && !this.tranche.priorIds.has(id)) trancheKnownNanoCny += known;
      }
    }
    const estimatedPeakNanoCny = Object.values(phases).reduce((sum, phase) => sum + phase.estimatedPeakNanoCny, 0);
    const tranche = this.tranche ? { id: this.tranche.entry.id, amountNanoCny: this.tranche.entry.amountNanoCny,
      knownNanoCny: trancheKnownNanoCny, reservedNanoCny: trancheReservedNanoCny,
      remainingNanoCny: this.tranche.entry.amountNanoCny - trancheKnownNanoCny - trancheReservedNanoCny } : undefined;
    return {
      maximumNanoCny: this.maximumNanoCny, authorizations: structuredClone(this.authorizations), tranche,
      remainingNanoCny: Math.min(this.maximumNanoCny - estimatedPeakNanoCny - reservedNanoCny, tranche?.remainingNanoCny ?? Infinity),
      phases, unsettled, reservedNanoCny,
      inFlight: unsettled.filter((id) => this.liveRequests.has(id)),
      unknown: unsettled.filter((id) => !this.liveRequests.has(id)),
      blockingUnknown: unsettled.filter((id) => !this.liveRequests.has(id) && !this.quarantines.has(id)),
      quarantinedUnknown: unsettled.filter((id) => this.quarantines.has(id)),
      reconciledOverruns: [...this.reconciledOverruns],
      originalEstimatedPeakNanoCny, priceReviews: structuredClone(this.priceReviews),
      registeredPrices: Object.fromEntries([...this.registeredPrices].map(([id, price]) => [id, structuredClone(price)])),
      routedResponses: [...this.routedResponses.values()].map(entry => structuredClone(entry)),
      estimatedPeakNanoCny,
      policyHash: this.policyHash,
      phaseBudgets: structuredClone(this.phaseBudgets),
      phaseBudgetHash: contentHash(this.phaseBudgets),
    };
  }

  /** Reserve a complete prospective run against its phase and the whole ledger.
   * Unknown usage remains charged to the request's original phase. */
  assertRunCapacity(phase: ExperimentPhase, maximumRunNanoCny: number): void {
    if (!Number.isSafeInteger(maximumRunNanoCny) || maximumRunNanoCny <= 0) throw new ExperimentBudgetError("invalid prospective run cap");
    const summary = this.summary, group = summary.phaseBudgets.find(entry => entry.phases.includes(phase));
    if (!group || group.phases.reduce((sum, item) => sum + summary.phases[item].estimatedPeakNanoCny + summary.phases[item].reservedNanoCny, 0) +
      maximumRunNanoCny > group.maximumNanoCny ||
      maximumRunNanoCny > summary.remainingNanoCny) {
      throw new ExperimentBudgetError("full frozen trajectory cap does not fit the remaining phase and total budget");
    }
  }

  private validate(entry: Entry): void {
    if (entry.budgetHash !== this.policyHash || entry.previousHash !== this.lastHash) {
      throw new ExperimentBudgetError("budget policy or journal chain mismatch");
    }
    if (entry.kind === "register_model_price") {
      if (!this.policy.prices || this.price(entry.priceId)) throw new ExperimentBudgetError("model price registration requires a new immutable price identifier");
    } else if (entry.kind === "reconcile_routed_usage") {
      const reservation = this.reservations.get(entry.id);
      const original = reservation && this.price(reservation.priceId ?? ""), served = this.price(entry.priceId);
      if (!reservation || this.settlements.has(entry.id) || !original || !served ||
        original.accountId !== served.accountId || original.modelId !== entry.requestedModelId ||
        served.modelId !== entry.servedModelId || entry.requestedModelId === entry.servedModelId) {
        throw new ExperimentBudgetError("routed response request/account/model binding mismatch");
      }
      const usage = entry.usage;
      const actual = this.charge(usage.input, usage.output, usage.cacheHit, { ...reservation, priceId: entry.priceId });
      if (usage.cacheHit > usage.input || usage.input > reservation.inputCeiling || usage.output > reservation.outputCeiling ||
        actual > this.charge(reservation.inputCeiling, reservation.outputCeiling, 0, reservation)) {
        throw new ExperimentBudgetError("routed response exceeds its original reservation");
      }
    } else if (entry.kind === "authorize_tranche") {
      const totals = this.summary;
      if (totals.unsettled.some(id => !this.quarantines.has(id))) throw new ExperimentBudgetError("drain and resolve unknown usage before authorization");
      if (this.authorizations.some(item => item.id === entry.id || item.evidenceHash === entry.evidenceHash)) throw new ExperimentBudgetError("duplicate budget authorization");
      if (entry.priorExposureNanoCny !== totals.estimatedPeakNanoCny + totals.reservedNanoCny) throw new ExperimentBudgetError("authorization exposure binding mismatch");
      if (!Number.isSafeInteger(this.maximumNanoCny + entry.amountNanoCny)) throw new ExperimentBudgetError("authorization amount overflow");
    } else if (entry.kind === "review_peak_prices") {
      if (this.summary.blockingUnknown.length) throw new ExperimentBudgetError("resolve unknown usage before price review");
      const original = this.price(entry.priceId);
      if (!original || entry.originalPriceHash !== contentHash(original) ||
        entry.price.accountId !== original.accountId || entry.price.modelId !== original.modelId) {
        throw new ExperimentBudgetError("price review account/model/original binding mismatch");
      }
      for (const key of ["inputMissNanoCnyPerToken", "inputHitNanoCnyPerToken", "outputNanoCnyPerToken"] as const) {
        if (entry.price[key] > original[key]) throw new ExperimentBudgetError("reviewed peak exceeds original conservative rate");
      }
      const ids = new Set<string>();
      for (const request of entry.requests) {
        const reservation = this.reservations.get(request.id), usage = this.settlements.get(request.id);
        if (ids.has(request.id) || this.reviewedPrices.has(request.id)) throw new ExperimentBudgetError("duplicate or repeated price review");
        if (!usage || !reservation || reservation.priceId !== entry.priceId || reservation.priceHash !== entry.originalPriceHash ||
          contentHash(usage) !== request.usageHash) throw new ExperimentBudgetError("price review settlement/usage binding mismatch");
        ids.add(request.id);
      }
    } else if (entry.kind === "reallocate_phases") {
      const totals = this.summary;
      if (totals.unsettled.some(id => !this.quarantines.has(id))) {
        throw new ExperimentBudgetError("drain and resolve unknown usage before phase reallocation");
      }
      const original = (this.policy.phaseBudgets ?? []).flatMap(group => group.phases).sort();
      const phases = entry.phaseBudgets.flatMap(group => group.phases).sort();
      const maximum = entry.phaseBudgets.reduce((sum, group) => sum + group.maximumNanoCny, 0);
      if (!original.length || new Set(phases).size !== phases.length || contentHash(phases) !== contentHash(original)) {
        throw new ExperimentBudgetError("phase reallocation must cover the same phases exactly once");
      }
      if (!Number.isSafeInteger(maximum) || maximum > this.maximumNanoCny) {
        throw new ExperimentBudgetError("phase reallocation cannot increase the total budget");
      }
      for (const group of entry.phaseBudgets) {
        const held = [...this.reservations.values()]
          .filter(request => group.phases.includes(request.phase) && !this.settlements.has(request.id))
          .reduce((sum, request) => sum + this.charge(request.inputCeiling, request.outputCeiling, 0, request), 0);
        const known = group.phases.reduce((sum, phase) => sum + totals.phases[phase].estimatedPeakNanoCny, 0);
        if (known + held > group.maximumNanoCny) throw new ExperimentBudgetError("phase reallocation cannot erase incurred or reserved cost");
      }
    } else if (entry.kind === "reserve") {
      const price = this.price(entry.priceId ?? "");
      if (this.policy.prices) {
        if (entry.version !== 2 || !price || entry.priceHash !== contentHash(price)) {
          throw new ExperimentBudgetError("missing or changed account/model price binding");
        }
        for (const rate of [price.inputMissNanoCnyPerToken, price.inputHitNanoCnyPerToken, price.outputNanoCnyPerToken]) {
          if (!Number.isSafeInteger(rate) || rate < 0) throw new ExperimentBudgetError("invalid price rate");
        }
      } else if (entry.version || entry.priceId || entry.priceHash) {
        throw new ExperimentBudgetError("legacy budget cannot accept a model price binding");
      }
      const totals = this.summary;
      if (totals.unsettled.filter((id) => !this.quarantines.has(id)).length >= (this.policy.maxConcurrentRequests ?? 1)) {
        throw new ExperimentBudgetError("unsettled provider usage fills the request concurrency limit");
      }
      if ([...this.quarantines.keys()].some((id) => this.reservations.get(id)!.trialId === entry.trialId)) {
        throw new ExperimentBudgetError("quarantined trial is permanently closed");
      }
      if ([...this.reconciledOverruns].some((id) => this.reservations.get(id)!.trialId === entry.trialId)) {
        throw new ExperimentBudgetError("reconciled overrun trial is permanently closed");
      }
      if ([...this.routedResponses.keys()].some(id => this.reservations.get(id)!.trialId === entry.trialId)) {
        throw new ExperimentBudgetError("routed response trial is permanently closed");
      }
      if (this.reservations.has(entry.id)) throw new ExperimentBudgetError("duplicate HTTP reservation");
      if (totals.phases[entry.phase].httpRequests >= (this.policy.maxHttpRequests[entry.phase] ?? 0)) {
        throw new ExperimentBudgetError("phase HTTP budget exhausted");
      }
      const pending = [...this.reservations.values()].filter((reservation) => !this.settlements.has(reservation.id));
      const phaseReservedTokens = pending.filter((reservation) => reservation.phase === entry.phase)
        .reduce((sum, reservation) => sum + reservation.inputCeiling + reservation.outputCeiling, 0);
      if (totals.phases[entry.phase].knownTokens + phaseReservedTokens + entry.inputCeiling + entry.outputCeiling >
        (this.policy.maxKnownTokens[entry.phase] ?? 0)) throw new ExperimentBudgetError("phase token reserve does not fit");
      const ceiling = this.charge(entry.inputCeiling, entry.outputCeiling, 0, entry);
      for (const group of this.phaseBudgets) {
        const groupReserved = pending.filter((reservation) => group.phases.includes(reservation.phase))
          .reduce((sum, reservation) => sum + this.charge(reservation.inputCeiling, reservation.outputCeiling, 0, reservation), 0);
        if (group.phases.includes(entry.phase) && group.phases.reduce((sum, phase) => sum + totals.phases[phase].estimatedPeakNanoCny, 0) + groupReserved + ceiling > group.maximumNanoCny) {
          throw new ExperimentBudgetError("phase monetary reserve does not fit");
        }
      }
      if (ceiling > totals.remainingNanoCny) throw new ExperimentBudgetError("CNY budget exhausted");
    } else if (entry.kind === "settle" || entry.kind === "reconcile_overrun") {
      const reservation = this.reservations.get(entry.id);
      if (!reservation || this.settlements.has(entry.id)) throw new ExperimentBudgetError("unknown or already settled HTTP request");
      if (entry.usage.cacheHit > entry.usage.input) throw new ExperimentBudgetError("cache hit exceeds total input");
      const overrun = entry.usage.input > reservation.inputCeiling || entry.usage.output > reservation.outputCeiling;
      if (entry.kind === "settle" && overrun) {
        throw new ExperimentBudgetError("provider usage exceeded its trusted reservation ceiling");
      }
      if (entry.kind === "reconcile_overrun" && !overrun) throw new ExperimentBudgetError("reviewed usage does not exceed the reservation");
      this.charge(entry.usage.input, entry.usage.output, entry.usage.cacheHit, reservation);
    } else if (!this.reservations.has(entry.id) || this.settlements.has(entry.id) || this.quarantines.has(entry.id)) {
      throw new ExperimentBudgetError("quarantine requires an unresolved, unquarantined request");
    }
  }

  private apply(entry: Entry): void {
    this.validate(entry);
    if (entry.kind === "register_model_price") this.registeredPrices.set(entry.priceId, structuredClone(entry.price));
    else if (entry.kind === "reconcile_routed_usage") {
      this.routedResponses.set(entry.id, structuredClone(entry));
      this.settlements.set(entry.id, entry.usage);
      this.reviewedPrices.set(entry.id, this.price(entry.priceId)!);
    } else if (entry.kind === "authorize_tranche") {
      this.maximumNanoCny += entry.amountNanoCny;
      this.authorizations.push(structuredClone(entry));
      this.tranche = { entry: structuredClone(entry), priorIds: new Set(this.reservations.keys()) };
    } else if (entry.kind === "review_peak_prices") {
      for (const request of entry.requests) this.reviewedPrices.set(request.id, structuredClone(entry.price));
      this.priceReviews.push({ evidenceHash: entry.evidenceHash, requests: entry.requests.length, priceHash: contentHash(entry.price) });
    } else if (entry.kind === "reallocate_phases") this.phaseBudgets = structuredClone(entry.phaseBudgets);
    else if (entry.kind === "reserve") this.reservations.set(entry.id, entry);
    else if (entry.kind === "settle" || entry.kind === "reconcile_overrun") {
      this.settlements.set(entry.id, entry.usage);
      if (entry.kind === "reconcile_overrun") this.reconciledOverruns.add(entry.id);
    }
    else this.quarantines.set(entry.id, entry);
    this.lastHash = contentHash(entry);
  }

  private persist(entry: Entry): void {
    this.validate(entry);
    appendFileSync(this.journal, `${JSON.stringify({ entry, sha256: contentHash(entry) })}\n`, { encoding: "utf8", flush: true });
    this.apply(entry);
  }

  reserve(input: { id: string; trialId: string; phase: ExperimentPhase; inputCeiling: number; outputCeiling: number; priceId?: string }): void {
    if (this.summary.blockingUnknown.length > 0) throw new ExperimentBudgetError("unsettled provider usage blocks further sends");
    const price = this.price(input.priceId ?? "");
    this.persist(entrySchema.parse({ ...input, ...(price ? { version: 2, priceHash: contentHash(price) } : {}), kind: "reserve", budgetHash: this.policyHash, previousHash: this.lastHash }));
    this.liveRequests.add(input.id);
  }

  settle(id: string, usage: ExperimentUsage): void {
    this.persist(entrySchema.parse({ kind: "settle", id, usage, budgetHash: this.policyHash, previousHash: this.lastHash }));
    this.liveRequests.delete(id);
  }

  markUnknown(id: string): void {
    if (!this.reservations.has(id) || this.settlements.has(id)) throw new ExperimentBudgetError("unknown or already settled HTTP request");
    this.liveRequests.delete(id);
  }

  price(id: string): ExperimentPrice | undefined {
    const price = this.registeredPrices.get(id) ?? this.policy.prices?.[id];
    return price && structuredClone(price);
  }

  registerModelPrice(input: { priceId: string; price: ExperimentPrice; reason: string; evidenceHash: string }): void {
    if (this.liveRequests.size) throw new ExperimentBudgetError("drain all live requests before price registration");
    this.persist(entrySchema.parse({ ...input, kind: "register_model_price", budgetHash: this.policyHash, previousHash: this.lastHash }));
  }

  reconcileRoutedUsage(input: { id: string; priceId: string; requestedModelId: string; servedModelId: string;
    usage: ExperimentUsage; reason: string; evidenceHash: string }): void {
    if (this.liveRequests.size) throw new ExperimentBudgetError("drain all live requests before routed response review");
    this.persist(entrySchema.parse({ ...input, kind: "reconcile_routed_usage", budgetHash: this.policyHash, previousHash: this.lastHash }));
  }

  /** A new user grant caps future requests independently; prior unused funds and later historical refunds cannot enlarge it. */
  authorizeTranche(input: { id: string; amountNanoCny: number; priorExposureNanoCny: number; reason: string; evidenceHash: string }): void {
    if (this.liveRequests.size) throw new ExperimentBudgetError("drain all live requests before authorization");
    this.persist(entrySchema.parse({ ...input, kind: "authorize_tranche", budgetHash: this.policyHash, previousHash: this.lastHash }));
  }

  /** Explicit peak-tariff review changes only named known valuations, retaining original charges and all unknown holds. */
  reviewPeakPrices(input: { priceId: string; originalPriceHash: string; price: ExperimentPrice;
    requests: Array<{ id: string; usageHash: string }>; reason: string; evidenceHash: string }): void {
    if (this.liveRequests.size) throw new ExperimentBudgetError("drain all live requests before price review");
    this.persist(entrySchema.parse({ ...input, kind: "review_peak_prices", budgetHash: this.policyHash, previousHash: this.lastHash }));
  }

  /** Prospective, evidence-bound allocation only; prices, total ceiling and prior charges stay fixed. */
  reallocatePhases(phaseBudgets: NonNullable<ExperimentBudgetPolicy["phaseBudgets"]>, evidence: { reason: string; evidenceHash: string }): void {
    if (this.liveRequests.size) throw new ExperimentBudgetError("drain all live requests before phase reallocation");
    this.persist(entrySchema.parse({ kind: "reallocate_phases", phaseBudgets, ...evidence,
      budgetHash: this.policyHash, previousHash: this.lastHash }));
  }

  /** Explicit evidence review closes the source trial; it neither refunds nor fabricates usage. */
  quarantineUnknown(id: string, evidence: { reason: string; evidenceHash: string }): void {
    if (this.liveRequests.size) throw new ExperimentBudgetError("drain all live requests before quarantine");
    this.persist(entrySchema.parse({ kind: "quarantine", id, ...evidence,
      budgetHash: this.policyHash, previousHash: this.lastHash }));
  }

  /** Account for reviewed provider usage without reopening an interrupted trial.
   * Ordinary settlement still stops on an overrun; runners never call this. */
  reconcileUsageOverrun(id: string, usage: ExperimentUsage, evidence: { reason: string; evidenceHash: string }): void {
    if (this.liveRequests.size) throw new ExperimentBudgetError("drain all live requests before reconciliation");
    this.persist(entrySchema.parse({ kind: "reconcile_overrun", id, usage, ...evidence,
      budgetHash: this.policyHash, previousHash: this.lastHash }));
  }
}

/** Missing usage is not zero usage; peak pricing is an estimate, not an account statement. */
export function deepSeekExperimentUsage(body: unknown): ExperimentUsage {
  if (body && typeof body === "object" && "usage" in body) {
    const usage = (body as { usage: unknown }).usage;
    if (usage && typeof usage === "object" && "input_tokens" in usage) {
      const parsed = z.object({ input_tokens: integer, output_tokens: integer, total_tokens: integer,
        input_tokens_details: z.object({ cached_tokens: integer }) }).parse(usage);
      if (parsed.total_tokens !== parsed.input_tokens + parsed.output_tokens || parsed.input_tokens_details.cached_tokens > parsed.input_tokens) {
        throw new ExperimentBudgetError("Responses usage totals do not reconcile");
      }
      return { input: parsed.input_tokens, output: parsed.output_tokens, cacheHit: parsed.input_tokens_details.cached_tokens };
    }
  }
  const parsed = z.object({
    usage: z.object({
      prompt_tokens: integer, completion_tokens: integer, total_tokens: integer,
      prompt_cache_hit_tokens: integer, prompt_cache_miss_tokens: integer,
    }),
  }).parse(body).usage;
  if (parsed.total_tokens !== parsed.prompt_tokens + parsed.completion_tokens ||
    parsed.prompt_cache_hit_tokens + parsed.prompt_cache_miss_tokens !== parsed.prompt_tokens) {
    throw new ExperimentBudgetError("provider usage totals do not reconcile");
  }
  return { input: parsed.prompt_tokens, output: parsed.completion_tokens, cacheHit: parsed.prompt_cache_hit_tokens };
}
