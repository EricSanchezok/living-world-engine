import { describe, expect, it } from "vitest";
import { z } from "zod";
import { actionCompilationBatchSchema, type ActionCompilationCausalAssertion } from "../../../contracts/llm-schemas";
import { actionCompilationCandidateKeySchema } from "../../../contracts/model-context";
import { ActionCompilationCodec, TEMPORAL_CONTRACT_SELECTORS, type ActionCompilationRepresentation } from "../action-compilation-representation";

const key = (index: number) => actionCompilationCandidateKeySchema.parse(`candidate_${index.toString(16).padStart(12, "0")}`);
const context = {
  referenceCatalog: { candidates: Array.from({ length: 16 }, (_, index) => ({
    candidateKey: key(index), kind: index < 2 ? "temporal_profile" : "entity",
    details: index < 2 ? { kind: index === 0 ? "conditional" : "fixed" } : null,
    label: key(3), scope: index === 3 ? { kind: "slot", slot: 1 } : { kind: "shared" },
  })) },
  task: { slots: [{ slot: 0, action: { rawText: key(3) }, previousAttempt: null }] },
};
const assertions: ActionCompilationCausalAssertion[] = [
  { kind: "check_result", checkRef: key(2), expected: "succeeded" },
  { kind: "random_result", requestRef: key(2), stepRef: key(3), expected: { entityRef: key(4), nested: [key(5), null, true, 2] } },
  ...[
    { kind: "text" as const, value: key(3) }, { kind: "number" as const, value: 2.5 },
    { kind: "boolean" as const, value: false }, { kind: "none" as const }, { kind: "entity" as const, entityRef: key(4) },
  ].map((expected) => ({ kind: "fact_matches" as const, factRef: key(2), expected })),
  { kind: "fact_absent", factRef: key(2) },
  { kind: "entity_absent", entityRef: key(2) },
  { kind: "entity_lifecycle", entityRef: key(2), expected: "active" },
  { kind: "placement_equals", entityRef: key(2), placementRef: key(3) },
  { kind: "placement_not_equals", entityRef: key(2), placementRef: null },
  { kind: "shared_placement", leftEntityRef: key(2), rightEntityRef: key(3) },
  { kind: "meter_compare", meterRef: key(2), operator: "eq", value: -2 },
  { kind: "quantity_compare", quantityRef: key(2), operator: "ne", value: 3 },
  { kind: "rating_compare", ratingRef: key(2), operator: "lt", value: 4 },
  { kind: "shared_resource_capacity_compare", poolRef: key(2), operator: "gte", value: 5 },
  { kind: "elapsed_seconds_compare", operator: "lte", value: 6 },
];

function batch(profile: number, list = assertions) {
  return { slots: [{ slot: 0, temporalPlan: {
    profileRef: key(profile), basis: { kind: "action_text_evidence", evidenceKey: key(5) },
    description: String(key(6)), continuationAssertions: list,
    causes: ["action", "check", "random", "event", "fact", "law", "mechanic"].map((kind) => ({ kind, ref: key(7) })),
  }, interactionDependency: {
    stateDependencies: { requiredExistingCandidateKeys: [key(8)], potentiallyAffectedCandidateKeys: [key(9), key(10)] },
    audienceAgentCandidateKeys: [key(11)], sharedResourceClaims: [
      { resourcePoolCandidateKey: key(12), basis: { kind: "default" } },
      { resourcePoolCandidateKey: key(13), basis: { kind: "explicit_quantity", amount: 2.75, unit: "litres", sourceText: key(14) } },
    ],
  } }] };
}

describe("AC-FP1 reversible representation", () => {
  it.each([
    ["A", false, false], ["AT", false, false], ["AT", true, false], ["AT", true, true],
  ] as const)("normalizes only declared alias leaves through %s choice=%s named=%s", (arm, choice, named) => {
    const codec = new ActionCompilationCodec(arm, context, context, undefined, named);
    const schema = codec.wireSchema(context, false, choice);
    const preprocess = codec.aliasPreprocessor(schema);
    for (const profile of [0, 1]) {
      const canonical = batch(profile);
      const wire = JSON.parse(JSON.stringify(codec.encodeOutput(canonical), (_key, value) =>
        typeof value === "string" ? value.replace(/^r0+(?=\d)/u, "r") : value)) as {
        slots: Array<{ temporalPlan: { description: string; continuationAssertions: ActionCompilationCausalAssertion[] |
          { first: ActionCompilationCausalAssertion; rest: ActionCompilationCausalAssertion[] } };
          interactionDependency: ReturnType<typeof batch>["slots"][number]["interactionDependency"] }>;
      };
      canonical.slots[0]!.temporalPlan.description = wire.slots[0]!.temporalPlan.description = "r003";
      const conditions = wire.slots[0]!.temporalPlan.continuationAssertions;
      const list = Array.isArray(conditions) ? conditions : [conditions.first, ...conditions.rest];
      for (const entries of [canonical.slots[0]!.temporalPlan.continuationAssertions, list]) {
        const random = entries.find(item => item.kind === "random_result")!;
        if (random.kind === "random_result") random.expected = { entityRef: "r004", nested: ["r005", { ref: "r006" }] };
        const literal = entries.find(item => item.kind === "fact_matches" && item.expected.kind === "text")!;
        if (literal.kind === "fact_matches" && literal.expected.kind === "text") literal.expected.value = "r007";
      }
      const before = structuredClone(wire);
      const prepared = preprocess(wire);
      expect(schema.safeParse(prepared.value).success).toBe(true);
      expect(codec.decodeValidated(prepared.value)).toEqual(canonical);
      expect(wire).toEqual(before);
      expect(prepared.symbolRepairs.length).toBeGreaterThan(20);
      expect(new Set(prepared.symbolRepairs.map(item => JSON.stringify(item.path))).size).toBe(prepared.symbolRepairs.length);
      expect(preprocess(prepared.value)).toEqual({ value: prepared.value, symbolRepairs: [] });
    }
  });

  it("rejects unknown and nondecimal aliases without changing them or opaque fields", () => {
    const codec = new ActionCompilationCodec("AT", context);
    const preprocess = codec.aliasPreprocessor(codec.wireSchema(context));
    for (const invalid of ["r999", "r999999999999999999999999999999999999999", "r-1", "r+1", "r1.0", "r1e0", "R001", " r1", "r1 ", "r١", key(1)]) {
      const wire = codec.encodeOutput(batch(1)) as ReturnType<typeof batch>;
      wire.slots[0]!.temporalPlan.profileRef = invalid as ReturnType<typeof key>;
      const prepared = preprocess(wire);
      expect(prepared).toEqual({ value: wire, symbolRepairs: [] });
      expect(() => codec.decodeValidated(prepared.value)).toThrow();
    }
    const extra = { ...codec.encodeOutput(batch(1)) as object, entityRef: "r3" };
    expect(preprocess(extra)).toEqual({ value: extra, symbolRepairs: [] });
  });

  it("normalizes ordinals with the root width after repair reorders and narrows the directory", () => {
    const full = structuredClone(context);
    full.referenceCatalog.candidates.push(...Array.from({ length: 1_100 }, (_, index) => ({
      ...context.referenceCatalog.candidates[2]!, candidateKey: key(index + 16),
    })));
    const codec = new ActionCompilationCodec("A", full);
    const repair = { ...context, referenceCatalog: { candidates: context.referenceCatalog.candidates.slice().reverse() } };
    const schema = codec.wireSchema(repair);
    const value = batch(1);
    const wire = codec.encodeOutput(value) as ReturnType<typeof batch>;
    wire.slots[0]!.temporalPlan.profileRef = "r0000001" as ReturnType<typeof key>;
    const normalized = codec.aliasPreprocessor(schema)(wire);
    expect(normalized.symbolRepairs[0]!.correctedValue).toBe("r0001");
    expect(normalized.symbolRepairs[0]!.catalogHash).toBe(codec.dictionaryHash);
    expect(codec.decodeValidated(normalized.value)).toEqual(value);
    expect(codec.aliases.get(key(1_000))).toBe("r1000");
  });

  it("round-trips every named temporal contract without changing source, conditions or legal profile choices", () => {
    const root = structuredClone(context);
    const kinds = Object.keys(TEMPORAL_CONTRACT_SELECTORS);
    kinds.forEach((kind, index) => {
      root.referenceCatalog.candidates[index]!.kind = "temporal_profile";
      root.referenceCatalog.candidates[index]!.details = { kind };
    });
    const codec = new ActionCompilationCodec("AT", root, root, undefined, true);
    const plain = new ActionCompilationCodec("AT", root);
    for (const [index, kind] of kinds.entries()) for (const list of [[], assertions]) {
      const canonical = batch(index, list), wire = codec.encodeOutput(canonical);
      expect(codec.wireSchema(root).safeParse(wire).success).toBe(plain.wireSchema(root).safeParse(plain.encodeOutput(canonical)).success);
      expect(codec.decodeValidated(wire)).toEqual(canonical);
      expect(JSON.stringify(wire)).toContain(TEMPORAL_CONTRACT_SELECTORS[kind]);
    }
    expect(codec.encodeContext(root)).toEqual(plain.encodeContext(root));
  });

  it("does not sanitize a wrong, duplicate or untagged temporal operator into an accepted canonical plan", () => {
    const codec = new ActionCompilationCodec("AT", context, context, undefined, true);
    const base = codec.encodeOutput(batch(1)) as { slots: Array<{ temporalPlan: Record<string, unknown> }> };
    const untagged = new ActionCompilationCodec("AT", context).encodeOutput(batch(1)) as typeof base;
    const selector = TEMPORAL_CONTRACT_SELECTORS.fixed!;
    const selection = base.slots[0]!.temporalPlan.profileRef as Record<string, unknown>;
    for (const changed of [
      { ...base.slots[0]!.temporalPlan, profileRef: { [selector]: "r000" } },
      { ...base.slots[0]!.temporalPlan, profileRef: { ...selection, [TEMPORAL_CONTRACT_SELECTORS.conditional!]: "r000" } },
      { ...base.slots[0]!.temporalPlan, profileRef: { ...selection, unexpected: true } },
      untagged.slots[0]!.temporalPlan,
    ]) {
      const wire = { slots: [{ ...base.slots[0], temporalPlan: changed }] };
      expect(codec.wireSchema(context).safeParse(wire).success).toBe(false);
      expect(() => codec.decodeValidated(wire)).toThrow();
    }
    const schema = z.toJSONSchema(codec.wireSchema(context)) as unknown as { properties: { slots: { items: { properties: { temporalPlan: { oneOf: unknown[] } } } } } };
    expect(schema.properties.slots.items.properties.temporalPlan.oneOf).toHaveLength(2);
    expect(() => new ActionCompilationCodec("A", context, context, undefined, true)).toThrow("temporal representation");
  });
  it("annotates each temporal choice with exact visible evidence without changing accepted values or context", () => {
    const codec = new ActionCompilationCodec("AT", context);
    const before = structuredClone(context);
    const plain = codec.wireSchema(context), annotated = codec.wireSchema(context, false, true);
    const json = z.toJSONSchema(annotated) as unknown as { properties: { slots: { items: { properties: { temporalPlan: { oneOf: Array<{
      properties: { profileRef: { oneOf: Array<{ const: string; description: string }> } };
    }> } } } } } };
    const choices = json.properties.slots.items.properties.temporalPlan.oneOf.flatMap((branch) => branch.properties.profileRef.oneOf);
    expect(choices).toHaveLength(2);
    for (const choice of choices) {
      const source = context.referenceCatalog.candidates.find((candidate) => candidate.candidateKey === codec.inverseAliases.get(choice.const))!;
      expect(JSON.parse(choice.description)).toEqual({ label: source.label, details: source.details });
    }
    for (const profile of [0, 1, 3]) for (const list of [[], assertions]) {
      const wire = codec.encodeOutput(batch(profile, list));
      expect(annotated.safeParse(wire).success).toBe(plain.safeParse(wire).success);
      if (annotated.safeParse(wire).success) expect(codec.decodeValidated(wire)).toEqual(batch(profile, list));
    }
    expect(context).toEqual(before);
    const hidden = structuredClone(context);
    hidden.referenceCatalog.candidates[0]!.details = null;
    const trusted = new ActionCompilationCodec("AT", context, context, new Map([[key(0), "conditional"], [key(1), "fixed"]]));
    expect(() => trusted.wireSchema(hidden, false, true)).toThrow("already visible");
  });
  it.each<ActionCompilationRepresentation>(["B1", "A", "T", "AT"])("binds full and repair cardinality in %s without accepting empty or extra slots", (arm) => {
    const root = structuredClone(context);
    root.task.slots.push({ ...root.task.slots[0]!, slot: 1 });
    const codec = new ActionCompilationCodec(arm, root);
    const value = batch(1);
    const schema = codec.wireSchema(root);
    expect(schema.safeParse({ slots: [] }).success).toBe(false);
    expect(schema.safeParse(codec.encodeOutput(value)).success).toBe(false);
    value.slots.push({ ...value.slots[0]!, slot: 1 });
    expect(schema.safeParse(codec.encodeOutput(value)).success).toBe(true);
    const repair = codec.wireSchema(context);
    expect(repair.safeParse(codec.encodeOutput(value)).success).toBe(false);
    value.slots.pop();
    expect(repair.safeParse(codec.encodeOutput(value)).success).toBe(true);
  });
  it.each<ActionCompilationRepresentation>(["B1", "A", "T", "AT"])("preserves every assertion, value, cause and claim for %s", (arm) => {
    const codec = new ActionCompilationCodec(arm, context);
    const schema = codec.wireSchema(context);
    for (const profile of [0, 1]) {
      const canonical = actionCompilationBatchSchema.parse(batch(profile));
      const encoded = codec.encodeOutput(canonical);
      expect(schema.safeParse(encoded).success).toBe(true);
      expect(codec.decodeValidated(encoded)).toEqual(canonical);
    }
    expect(codec.decodeValidated(codec.encodeOutput(batch(1, [])))).toEqual(batch(1, []));
  });

  it("round-trips 1,000 fixed-seed assertion combinations without erasing nonconditional conditions", () => {
    let seed = 0xACF001;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const codec = new ActionCompilationCodec("AT", context);
    const schema = codec.wireSchema(context);
    for (let index = 0; index < 1_000; index++) {
      const profile = index % 2;
      const length = next() % 9 + (profile === 0 ? 1 : 0);
      const list = Array.from({ length }, () => structuredClone(assertions[next() % assertions.length]!));
      const value = actionCompilationBatchSchema.parse(batch(profile, list));
      const encoded = codec.encodeOutput(value);
      expect(schema.safeParse(encoded).success).toBe(true);
      expect(codec.decodeValidated(encoded)).toEqual(value);
    }
  });

  it("changes reference positions only, not free text, evidence IDs or arbitrary random JSON", () => {
    const codec = new ActionCompilationCodec("A", context);
    const encoded = codec.encodeOutput(batch(0)) as ReturnType<typeof batch>;
    const plan = encoded.slots[0]!.temporalPlan;
    expect(plan.description).toBe(key(6));
    expect(plan.basis.evidenceKey).toBe(key(5));
    expect(plan.continuationAssertions[1]).toEqual({ ...assertions[1], requestRef: "r002", stepRef: "r003" });
    expect(plan.continuationAssertions[2]).toEqual({ ...assertions[2], factRef: "r002" });
    expect(plan.continuationAssertions[6]).toEqual({ kind: "fact_matches", factRef: "r002", expected: { kind: "entity", entityRef: "r004" } });
    const mapped = codec.encodeContext(context) as typeof context;
    expect(mapped.task.slots[0]!.action.rawText).toBe(key(3));
    expect(mapped.referenceCatalog.candidates[3]!.candidateKey).toBe("r003");
    expect(mapped.referenceCatalog.candidates[3]!.label).toBe(key(3));
    expect(mapped.referenceCatalog.candidates[3]!.scope).toEqual({ kind: "slot", slot: 1 });
  });

  it("enforces conditional first/rest without admitting empty conditions or deleting legal lists", () => {
    const codec = new ActionCompilationCodec("T", context);
    const schema = codec.wireSchema(context);
    expect(schema.safeParse(codec.encodeOutput(batch(0, []))).success).toBe(false);
    expect(schema.safeParse(batch(0, [])).success).toBe(false);
    expect(schema.safeParse(batch(0)).success).toBe(false);
    expect(schema.safeParse(batch(1)).success).toBe(true);
    const wrong = codec.encodeOutput(batch(0)) as ReturnType<typeof batch>;
    wrong.slots[0]!.temporalPlan.profileRef = key(1);
    expect(schema.safeParse(wrong).success).toBe(false);
  });

  it("restricts the schema to the union of trusted eligible profiles without changing context or legal assertions", () => {
    const slot = context.task.slots[0]!;
    const root = { ...structuredClone(context), task: { slots: [
      { ...slot, temporalProfileEligibility: [{ profileRef: key(0), eligible: true }, { profileRef: key(1), eligible: false }] },
      { ...slot, slot: 1, temporalProfileEligibility: [{ profileRef: key(0), eligible: false }, { profileRef: key(1), eligible: true }] },
    ] } };
    const before = structuredClone(root);
    const codec = new ActionCompilationCodec("T", root);
    for (const profile of [0, 1]) {
      const value = batch(profile);
      value.slots.push({ ...value.slots[0]!, slot: 1 });
      expect(codec.wireSchema(root, true).safeParse(codec.encodeOutput(value)).success).toBe(true);
    }
    const repair = { ...root, task: { slots: [root.task.slots[0]!] } };
    expect(codec.wireSchema(repair, true).safeParse(codec.encodeOutput(batch(0))).success).toBe(true);
    expect(codec.wireSchema(repair, true).safeParse(codec.encodeOutput(batch(1))).success).toBe(false);
    expect(codec.wireSchema(repair).safeParse(codec.encodeOutput(batch(1))).success).toBe(true);
    expect(codec.decodeValidated(codec.encodeOutput(batch(0)))).toEqual(batch(0));
    expect(codec.encodeContext(root)).toEqual(root);
    expect(root).toEqual(before);
    expect(() => codec.wireSchema(context, true)).toThrow("trusted eligibility");
    const none = { ...root, task: { slots: [{ ...slot, temporalProfileEligibility: [{ profileRef: key(0), eligible: false }] }] } };
    expect(() => codec.wireSchema(none, true)).toThrow("no legal profile");
  });

  it("uses trusted script semantics when the unchanged projector omits profile details", () => {
    const compact = structuredClone(context);
    compact.referenceCatalog.candidates[0]!.details = null;
    const kinds = new Map([[key(0), "conditional"], [key(1), "fixed"]]);
    const codec = new ActionCompilationCodec("AT", compact, compact, kinds);
    expect(codec.wireSchema(compact).safeParse(codec.encodeOutput(batch(0))).success).toBe(true);
    expect(codec.decodeValidated(codec.encodeOutput(batch(0)))).toEqual(batch(0));
    expect(codec.wireSchema(compact).safeParse(codec.encodeOutput(batch(0, []))).success).toBe(false);
    expect(() => new ActionCompilationCodec("A", compact)).not.toThrow();
    expect((codec.encodeContext(compact) as typeof compact).referenceCatalog.candidates[0]!.details).toBeNull();
    expect(() => new ActionCompilationCodec("T", compact)).toThrow("missing script-owned");
  });

  it("keeps root aliases stable on reordered/subset repair contexts and rejects new keys", () => {
    const codec = new ActionCompilationCodec("AT", context);
    const repair = structuredClone(context);
    repair.referenceCatalog.candidates = repair.referenceCatalog.candidates.slice(0, 7).reverse();
    const mapped = codec.encodeContext(repair) as typeof context;
    expect(mapped.referenceCatalog.candidates[0]!.candidateKey).toBe("r006");
    expect(codec.dictionaryHash).toBe(new ActionCompilationCodec("AT", context).dictionaryHash);
    repair.referenceCatalog.candidates[0]!.candidateKey = key(99);
    expect(() => codec.encodeContext(repair)).toThrow("does not include repair candidate");
  });

  it("never fuzzy-corrects unknown aliases or accepts canonical keys from alias output", () => {
    const codec = new ActionCompilationCodec("A", context);
    for (const invalid of ["r999", "rO00", "R000", "r00", key(0)]) {
      const wire = codec.encodeOutput(batch(0)) as ReturnType<typeof batch>;
      wire.slots[0]!.temporalPlan.profileRef = invalid as ReturnType<typeof key>;
      expect(() => codec.decodeValidated(wire)).toThrow();
    }
  });

  it("reserves stable private repair ordinals without serializing the full catalog", () => {
    const full = structuredClone(context);
    full.referenceCatalog.candidates.push(...Array.from({ length: 1_100 }, (_, index) => ({
      ...context.referenceCatalog.candidates[2]!, candidateKey: key(index + 16),
    })));
    const codec = new ActionCompilationCodec("A", context, full);
    expect(codec.rootVisibleKeyCount).toBe(16);
    expect(codec.aliases.size).toBe(1_116);
    expect(codec.aliases.get(key(0))).toBe("r000");
    expect(codec.aliases.get(key(99))).toBe("r099");
    expect(codec.aliases.get(key(1_000))).toBe("r1000");
    const wire = codec.encodeContext(context) as typeof context;
    expect(wire.referenceCatalog.candidates).toHaveLength(16);
    expect(JSON.stringify(wire)).not.toContain("r099");
    const repair = structuredClone(context);
    repair.referenceCatalog.candidates.push(full.referenceCatalog.candidates[99]!);
    expect((codec.encodeContext(repair) as typeof context).referenceCatalog.candidates.at(-1)!.candidateKey).toBe("r099");
    expect(codec.aliases.get(key(0))).toBe("r000");
  });

  it("encodes canonical repair output with the same assertion order and namespace", () => {
    const codec = new ActionCompilationCodec("AT", context);
    const repair = { ...context, task: { slots: [{ slot: 0, previousAttempt: batch(0).slots[0] }] } };
    const wire = codec.encodeContext(repair) as typeof repair;
    expect(wire.task.slots[0]!.previousAttempt).toEqual((codec.encodeOutput(batch(0)) as ReturnType<typeof batch>).slots[0]);
  });

  it("points profile feedback at the displayed named selector without changing evidence", () => {
    const codec = new ActionCompilationCodec("AT", context, context, undefined, true);
    const previous = batch(0).slots[0]!;
    const issue = { path: ["temporalPlan", "profileRef"], originalValue: key(0) };
    const wire = codec.encodeContext({ ...context, task: { slots: [{ previousAttempt: previous, issues: [issue] }] } }) as {
      task: { slots: Array<{ issues: Array<{ path: string[]; originalValue: string }> }> };
    };
    expect(wire.task.slots[0]!.issues[0]).toEqual({
      path: ["temporalPlan", "profileRef", TEMPORAL_CONTRACT_SELECTORS.conditional!], originalValue: "r000",
    });
    expect(issue).toEqual({ path: ["temporalPlan", "profileRef"], originalValue: key(0) });
  });

  it.each(["A", "AT"] as const)("keeps rejected reference evidence in the %s wire namespace without rewriting literals or mismatched evidence", arm => {
    const codec = new ActionCompilationCodec(arm, context);
    const previous = batch(0).slots[0]!;
    const encodeIssue = (path: Array<string | number>, originalValue: unknown) => {
      const issue = { code: "reference.disallowed_use", class: "reference", path, originalValue, allowedHandles: [key(9)], reason: `Keep literal wording ${key(8)}` };
      const repair = { ...context, task: { slots: [{ slot: 0, previousAttempt: previous, issues: [issue] }] } };
      const before = structuredClone(repair);
      const wire = codec.encodeContext(repair) as typeof repair;
      expect(repair).toEqual(before);
      expect(wire.task.slots[0]!.issues[0]!.allowedHandles).toEqual(["r009"]);
      expect(wire.task.slots[0]!.issues[0]!.reason).toBe(issue.reason);
      return wire.task.slots[0]!.issues[0]!;
    };
    expect(encodeIssue(["interactionDependency", "stateDependencies", "requiredExistingCandidateKeys", 0], key(8)).originalValue).toBe("r008");
    expect(encodeIssue(["temporalPlan", "continuationAssertions", 0, "checkRef"], key(2))).toMatchObject({
      originalValue: "r002", path: ["temporalPlan", "continuationAssertions", arm === "AT" ? "first" : 0, "checkRef"],
    });
    expect(encodeIssue(["temporalPlan", "continuationAssertions", 1, "requestRef"], key(2))).toMatchObject({
      originalValue: "r002", path: ["temporalPlan", "continuationAssertions", ...(arm === "AT" ? ["rest", 0] : [1]), "requestRef"],
    });
    expect(encodeIssue(["temporalPlan", "continuationAssertions", 1, "expected", "entityRef"], key(4)).originalValue).toBe(key(4));
    expect(encodeIssue(["temporalPlan", "description"], key(6)).originalValue).toBe(key(6));
    expect(encodeIssue(["interactionDependency", "stateDependencies", "requiredExistingCandidateKeys", 0], key(9)).originalValue).toBe(key(9));
    expect(encodeIssue(["missing"], key(8)).originalValue).toBe(key(8));
  });
});
