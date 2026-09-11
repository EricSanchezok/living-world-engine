import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { REVIEW_DIMENSIONS } from "./constrained-semantic-review";
import { AC_FP3_PROTOCOL } from "./semantic-first-pass-protocol";
import { loadPromptAsset } from "../../prompts";

export type ReviewDimension = typeof REVIEW_DIMENSIONS[number];
export type ReviewVerdict = "pass" | "fail" | "unresolved";
type Scope = "source" | "output" | "state" | "rules";
export interface ReviewAtom { id: string; scope: Scope; pointer: string; value: unknown }
export interface SemanticReviewEntry {
  id: string; stateHash: string; rulesHash: string; source: unknown; output: unknown;
}
export interface SemanticReviewPacket { state: unknown; rules: unknown; entries: SemanticReviewEntry[] }

/** Leaf addresses preserve every supplied value, including empty containers. */
function atoms(scope: Scope, document: unknown, owner: string, pointer = ""): ReviewAtom[] {
  if (document !== null && typeof document === "object" && Object.keys(document).length) {
    return Object.entries(document).flatMap(([key, value]) => atoms(scope, value, owner,
      pointer + "/" + key.replace(/~/gu, "~0").replace(/\//gu, "~1")));
  }
  return [{ id: contentHash({ owner, scope, pointer, value: document }).slice(0, 16), scope, pointer, value: document }];
}

export function makeReviewEntry(source: unknown, output: unknown, state: unknown, rules: unknown): SemanticReviewEntry {
  const binding = { source, output, stateHash: contentHash(state), rulesHash: contentHash(rules) };
  return { id: contentHash(binding), ...binding };
}

export function visibleReviewPacket(packet: SemanticReviewPacket) {
  const stateHash = contentHash(packet.state), rulesHash = contentHash(packet.rules);
  if (!packet.entries.length || packet.entries.length > AC_FP3_PROTOCOL.review.maxPacketEntries ||
    new Set(packet.entries.map((entry) => entry.id)).size !== packet.entries.length) throw new Error("invalid review packet coverage");
  for (const entry of packet.entries) {
    if (entry.stateHash !== stateHash || entry.rulesHash !== rulesHash ||
      entry.id !== makeReviewEntry(entry.source, entry.output, packet.state, packet.rules).id) throw new Error("review state/rules/output identity drift");
  }
  return { stateHash, rulesHash,
    sharedEvidence: [...atoms("state", packet.state, stateHash), ...atoms("rules", packet.rules, rulesHash)],
    entries: packet.entries.map((entry) => ({ id: entry.id,
      evidence: [...atoms("source", entry.source, entry.id), ...atoms("output", entry.output, entry.id)] })) };
}

export const FP3_REVIEW_PROMPT = {
  version: 1,
  system: loadPromptAsset("system/action-compilation-semantic-review.md"),
  userPrompt: loadPromptAsset("user/action-compilation-semantic-review.md"),
} as const;

export const fp3ReviewResponseSchema = z.strictObject({ results: z.array(z.strictObject({ id: z.string(),
  checks: z.array(z.strictObject({ dimension: z.enum(REVIEW_DIMENSIONS), verdict: z.enum(["pass", "fail", "unresolved"]),
    reason: z.string().min(1).max(600), evidenceIds: z.array(z.string()).min(1).max(12) })).length(7),
})) });
export interface ValidatedReview {
  id: string; usable: boolean; problem: string | null;
  checks: Array<{ dimension: ReviewDimension; verdict: ReviewVerdict; grounded: boolean; reason: string }>;
}

/** Structural defects are errors, not semantic negatives; calibration counts either as incorrect. */
export function validateFp3Review(value: unknown, packet: SemanticReviewPacket): ValidatedReview[] {
  const visible = visibleReviewPacket(packet);
  const unavailable = (problem: string): ValidatedReview[] => packet.entries.map(({ id }) => ({ id, usable: false, problem,
    checks: REVIEW_DIMENSIONS.map((dimension) => ({ dimension, verdict: "unresolved", grounded: false, reason: problem })) }));
  const parsed = fp3ReviewResponseSchema.safeParse(value);
  if (!parsed.success) return unavailable("invalid review response structure");
  if (parsed.data.results.some((row) => !visible.entries.some((entry) => entry.id === row.id))) return unavailable("unknown review identity");
  return visible.entries.map((entry) => {
    const matches = parsed.data.results.filter((row) => row.id === entry.id);
    if (matches.length !== 1 || new Set(matches[0]!.checks.map((check) => check.dimension)).size !== 7) {
      return unavailable("missing/duplicate identity or dimension").find((row) => row.id === entry.id)!;
    }
    const allowed = new Map([...visible.sharedEvidence, ...entry.evidence].map((atom) => [atom.id, atom]));
    const checks = matches[0]!.checks.map((check) => {
      const refs = check.evidenceIds.map((id) => allowed.get(id));
      const grounded = refs.every(Boolean) && refs.some((atom) => atom?.scope === "source") && refs.some((atom) => atom?.scope === "output");
      return { dimension: check.dimension, verdict: grounded ? check.verdict : "unresolved" as const, grounded, reason: check.reason };
    });
    const usable = checks.every((check) => check.grounded);
    return { id: entry.id, usable, problem: usable ? null : "invalid or cross-entry evidence", checks };
  });
}

export interface CalibrationCase {
  entry: SemanticReviewEntry; dimension: ReviewDimension; expected: ReviewVerdict;
  proof: { sourcePointer: string; outputPointer: string; relation: "equal" | "different" | "missing"; sourceValue: unknown; outputValue: unknown };
}

/** Controlled projections, not human gold or full compiler-output accuracy. */
export function buildFp3Calibration() {
  const state = { id: "ac-fp3-calibration-state-v1", revision: 0, nowSeconds: 0,
    actors: Array.from({ length: 16 }, (_, index) => ({ id: "actor-" + index, privateKnowledge: [], grainAvailable: 100 })),
    facts: { bellRinging: false, gateOpen: false, sealedLetterReadable: false },
    evidenceCompleteness: "Facts not provided by source, output or state are unknown, not false." };
  const rules = {
    semantics: "Source constraints are authoritative requirements. Output records an intended attempt, never its successful completion. Output compiledConstraints are operative, not commentary.",
    temporal: "wait-until stops only when its stated condition holds; a timer does not establish that condition.",
    privacy: "Knowledge requires observation or authorized communication; no such event has occurred in this snapshot.",
    freedom: "Arbitrary natural-language means are allowed. There is no closed action menu.",
    dependencies: "The named reader, writer and recipient must retain their exact source roles; replacing one is not an equivalent compilation.",
  };
  const cases: CalibrationCase[] = [];
  for (const dimension of REVIEW_DIMENSIONS) for (let index = 0; index < 16; index++) {
    const actor = "actor-" + index, target = "marker-" + index, quantity = index + 2;
    const actions: Record<ReviewDimension, { text: string; field: string; value: unknown; wrong: unknown; paraphrase: string }> = {
      "actor-identity": { text: actor + " attempts to hand a sealed note to keeper-" + index + ".", field: "actorId", value: actor, wrong: "actor-" + ((index + 1) % 16), paraphrase: "Try handing the sealed note to keeper-" + index + "." },
      "derived-intent": { text: "Try to deliver note-" + index + " intact to its keeper; do not open or destroy it.", field: "intent", value: "attempt intact delivery of note-" + index, wrong: "destroy note-" + index + " to prevent delivery", paraphrase: "Attempt to bring note-" + index + " to its keeper without altering it." },
      "temporal-boundary": { text: "Wait by " + target + " until the bell rings, however long that takes; do not stop merely because " + quantity + " seconds elapse.", field: "stopCondition", value: "bell rings", wrong: quantity + " seconds elapse whether or not the bell rings", paraphrase: "Remain by " + target + ", ending this wait only on hearing the bell." },
      "quantities-resources": { text: "Attempt to transfer exactly " + quantity + " units of grain to store-" + index + ", keeping the rest.", field: "grainUnits", value: quantity, wrong: quantity + 10, paraphrase: "Try moving " + quantity + " grain units into store-" + index + "; leave other grain untouched." },
      "dependencies-audience": { text: "Read " + target + ", then privately report its markings only to keeper-" + index + "; do not address other keepers.", field: "recipient", value: "keeper-" + index, wrong: "keeper-" + ((index + 1) % 16), paraphrase: "Inspect " + target + " and attempt a private report to keeper-" + index + " alone." },
      "knowledge-isolation": { text: "Ask keeper-" + index + " what the sealed letter says. Its contents have not been seen or communicated.", field: "alreadyKnowsLetterContents", value: false, wrong: true, paraphrase: "Try asking keeper-" + index + " about the letter; the actor does not yet know its contents." },
      "open-action-freedom": { text: "Try using rope-" + index + " and stone-" + index + " together to improvise a swinging signal, without replacing this with a standard movement.", field: "means", value: "improvise a swinging signal with rope-" + index + " and stone-" + index, wrong: "discard the improvisation and choose MOVE_NORTH from a fixed action menu", paraphrase: "Attempt to fashion a pendulum-like signal from stone-" + index + " tied to rope-" + index + "." },
    };
    const action = actions[dimension];
    const source = { id: "proposal-" + index, actorId: actor, rawText: action.text, constraints: { [action.field]: action.value } };
    for (const expected of ["pass", "fail"] as const) {
      const outputValue = expected === "pass" ? action.value : action.wrong;
      const output = { actorId: actor, status: "proposed-attempt", description: action.paraphrase, compiledConstraints: { [action.field]: outputValue } };
      if (dimension === "actor-identity") output.actorId = String(outputValue);
      cases.push({ entry: makeReviewEntry(source, output, state, rules), dimension, expected,
        proof: { sourcePointer: "/constraints/" + action.field, outputPointer: "/compiledConstraints/" + action.field,
          relation: expected === "pass" ? "equal" : "different", sourceValue: action.value, outputValue } });
    }
  }
  for (const dimension of REVIEW_DIMENSIONS) for (let index = 0; index < 4; index++) {
    const scenarios: Record<ReviewDimension, [string, string, string]> = {
      "actor-identity": ["The guard attempts to move the crate. The guard's canonical identity is unavailable.", "actorId", "unresolved-guard-" + index],
      "derived-intent": ["Carry out the instruction on the missing page. The page's text is unavailable.", "intent", "deliver parcel-" + index],
      "temporal-boundary": ["Wait for the interval stated on the missing timetable. Its duration is unavailable.", "durationSeconds", String(20 + index)],
      "quantities-resources": ["Transfer the amount specified in the missing order. Neither that amount nor its unit is available.", "quantity", (index + 3) + " grain units"],
      "dependencies-audience": ["Send the report to the recipient named on the missing address slip. That address is unavailable.", "recipient", "keeper-" + index],
      "knowledge-isolation": ["Use the information previously observed by an unspecified actor. The observation and knowledge records for this actor are unavailable.", "alreadyKnows", "password-" + index],
      "open-action-freedom": ["Perform the improvised maneuver described on the missing page. The maneuver's description is unavailable.", "means", "rope-and-stone maneuver-" + index],
    };
    const [rawText, field, value] = scenarios[dimension];
    const source = { id: "partial-" + dimension + "-" + index, rawText, necessaryEvidence: null };
    const output = { status: "proposed-attempt", [field]: value };
    cases.push({ entry: makeReviewEntry(source, output, state, rules), dimension, expected: "unresolved",
      proof: { sourcePointer: "/necessaryEvidence", outputPointer: "/" + field, relation: "missing", sourceValue: null, outputValue: value } });
  }
  return { version: 1, provenance: "controlled-semantic-projections-not-human-gold-not-compiler-output-accuracy", state, rules, cases };
}

export function assertCalibrationProofs(calibration: ReturnType<typeof buildFp3Calibration>): void {
  const at = (value: unknown, pointer: string) => pointer.slice(1).split("/").reduce<unknown>((node, key) =>
    node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined, value);
  if (calibration.cases.length !== 252 || new Set(calibration.cases.map(({ entry }) => entry.id)).size !== 252) throw new Error("calibration count/identity drift");
  for (const dimension of REVIEW_DIMENSIONS) for (const verdict of ["pass", "fail", "unresolved"] as const) {
    if (calibration.cases.filter((item) => item.dimension === dimension && item.expected === verdict).length !== (verdict === "unresolved" ? 4 : 16)) {
      throw new Error("calibration dimension/polarity count drift");
    }
  }
  for (const item of calibration.cases) {
    const left = at(item.entry.source, item.proof.sourcePointer), right = at(item.entry.output, item.proof.outputPointer);
    if (left === undefined || right === undefined || contentHash(left) !== contentHash(item.proof.sourceValue) || contentHash(right) !== contentHash(item.proof.outputValue)) throw new Error("calibration proof address drift");
    const expected = left === null ? "unresolved" : contentHash(left) === contentHash(right) ? "pass" : "fail";
    const relation = expected === "unresolved" ? "missing" : expected === "pass" ? "equal" : "different";
    if (expected !== item.expected || relation !== item.proof.relation) throw new Error("calibration proof/label contradiction");
  }
}

export function scoreFp3Calibration(calibration: ReturnType<typeof buildFp3Calibration>, reviews: readonly ValidatedReview[]) {
  assertCalibrationProofs(calibration);
  const rows = calibration.cases.map((item) => {
    const matches = reviews.filter((row) => row.id === item.entry.id);
    const check = matches.length === 1 ? matches[0]!.checks.find((row) => row.dimension === item.dimension) : undefined;
    const usable = matches.length === 1 && matches[0]!.usable && !!check?.grounded;
    return { id: item.entry.id, dimension: item.dimension, expected: item.expected, actual: check?.verdict ?? null,
      usable, correct: usable && check?.verdict === item.expected, reason: check?.reason ?? "missing review" };
  });
  const correct = (verdict: ReviewVerdict, dimension?: ReviewDimension) => rows.filter((row) => row.expected === verdict && (!dimension || row.dimension === dimension) && row.correct).length;
  const dimensions = REVIEW_DIMENSIONS.map((dimension) => ({ dimension, positive: correct("pass", dimension), negative: correct("fail", dimension) }));
  const positive = correct("pass"), negative = correct("fail"), unresolved = correct("unresolved");
  const calibrated = positive >= 107 && negative >= 107 && unresolved >= 27 && dimensions.every((row) => row.positive >= 15 && row.negative >= 15);
  return { calibrated, positive: { correct: positive, total: 112 }, negative: { correct: negative, total: 112 },
    unresolved: { correct: unresolved, total: 28 }, usable: rows.filter((row) => row.usable).length, dimensions, rows };
}
