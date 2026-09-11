import type { CompiledAction } from "../../algorithms/roles";
import type { AgentActionProposal } from "../../contracts/model";
import { contentHash } from "../../models/model-audit";
import type { bindFirstPassOracle } from "./first-pass-oracle";

type Oracle = ReturnType<typeof bindFirstPassOracle>;
export interface BlindCompilationReview {
  reviewId: string;
  oracleHash: string;
  stateHash: string;
  actionId: string;
  canonicalCompilationHash: string;
  action: AgentActionProposal;
  compilation: CompiledAction;
}

export type SemanticAuditVerdict = "pass" | "fail" | "unresolved";
export interface SemanticAuditFinding {
  ruleId: string;
  verdict: SemanticAuditVerdict;
  evidencePaths: string[];
  explanation: string;
}

/** Missing observations cannot become success by an empty every() reduction. */
export function combineSemanticFindings(findings: readonly SemanticAuditFinding[]): SemanticAuditVerdict {
  if (findings.some((finding) => finding.verdict === "fail")) return "fail";
  if (!findings.length || findings.some((finding) => finding.verdict === "unresolved")) return "unresolved";
  return "pass";
}

/** Audit the available evidence, not an implementation of open-language adjudication.
 * This intentionally exposes the missing predicates instead of certifying prose cards. */
export function auditSemanticObservability(oracle: Oracle, entries: readonly BlindCompilationReview[]) {
  const oracleHash = contentHash(oracle);
  const seen = new Set<string>();
  const rows = entries.map((entry) => {
    const card = oracle.actions.find((action) => action.actionId === entry.actionId);
    const identity = { oracleHash: entry.oracleHash, stateHash: entry.stateHash,
      actionId: entry.actionId, canonicalCompilationHash: entry.canonicalCompilationHash };
    if (!card || entry.oracleHash !== oracleHash || entry.stateHash !== card.stateHash ||
      contentHash(entry.action) !== card.actionHash || contentHash(entry.compilation) !== entry.canonicalCompilationHash ||
      contentHash(identity) !== entry.reviewId || seen.has(entry.reviewId)) {
      throw new Error("semantic observability input identity mismatch or duplicate review");
    }
    seen.add(entry.reviewId);
    const compilation = entry.compilation;
    const findings: SemanticAuditFinding[] = [{
      ruleId: "source-action-retention", verdict: contentHash(compilation.activity.sourceAction) === card.actionHash ? "pass" : "fail",
      evidencePaths: ["action", "compilation.activity.sourceAction"],
      explanation: "Exact original proposal retention is necessary, but does not validate derived intent.",
    }, {
      ruleId: "compiled-identity", verdict: compilation.plan.actionId === card.actionId &&
        compilation.plan.actorId === card.actor && compilation.activity.sourceActionId === card.actionId &&
        compilation.activity.actorId === card.actor && compilation.dependency.id === card.actionId &&
        compilation.dependency.actorId === card.actor ? "pass" : "fail",
      evidencePaths: ["compilation.plan", "compilation.activity", "compilation.dependency"],
      explanation: "Compiled identities must belong to the original subject and action.",
    }];
    // This is the exact pre-existing oracle rule, not a heuristic new profile whitelist.
    const medicalRule = "A medical treatment profile for these nonmedical actions, or a waiting profile for a current communication/administrative action merely because its text includes a future condition.";
    if (!oracle.globalForbidden.includes(medicalRule)) throw new Error("frozen nonmedical oracle rule is absent");
    findings.push({ ruleId: "nonmedical-profile", verdict: compilation.plan.profileId === "field-treatment" ? "fail" : "pass",
      evidencePaths: ["oracle.globalForbidden", "compilation.plan.profileId"],
      explanation: "The frozen Blackmarsh oracle explicitly forbids medical treatment for all 43 source actions; other profiles are not thereby certified.",
    });
    findings.push({ ruleId: "derived-description-intent", verdict: "unresolved",
      evidencePaths: ["compilation.plan.description", "compilation.activity.plan.description", "action.rawText"],
      explanation: "Free-text derived descriptions reach reaction/activity contexts. There is no independent registered meaning predicate or exact-output adjudication for this description.",
    });
    findings.push({ ruleId: "dependency-completeness-and-relevance", verdict: "unresolved",
      evidencePaths: ["compilation.dependency", "action", "oracle.globalMust"],
      explanation: "Legal references and retained action text do not establish all and only justified reads, effects, audiences and resource claims.",
    });
    for (const kind of ["must", "forbidden"] as const) card[kind].forEach((obligation, index) => findings.push({
      ruleId: `${card.source}:${card.slot}:${kind}:${index}`, verdict: "unresolved",
      evidencePaths: [`oracle.actions[${oracle.actions.indexOf(card)}].${kind}[${index}]`, "compilation"],
      explanation: `Prose obligation has no executable predicate or independent exact-output adjudication: ${obligation}`,
    }));
    return { ...identity, reviewId: entry.reviewId, sourceId: card.source, actor: card.actor,
      profileId: compilation.plan.profileId, findings, verdict: combineSemanticFindings(findings) };
  });
  const counts = { pass: 0, fail: 0, unresolved: 0 };
  for (const row of rows) counts[row.verdict]++;
  return {
    version: 1, kind: "semantic-observability-audit", oracleHash, reviewPackHash: contentHash(entries),
    scope: "Historical development evidence only; not AC-FP2 treatment results or a completed semantic evaluator.",
    counts, total: rows.length, adjudicableFraction: rows.length ? (counts.pass + counts.fail) / rows.length : 0,
    allMandatoryObligationsCovered: false,
    missingEvidence: ["Independent meaning predicates or adjudications for derived descriptions",
      "Action-specific dependency/resource relevance and completeness predicates",
      "Executable must/forbidden cards and positive/alternative/negative fixtures",
      "Downstream observations for obligations not represented in compilation"],
    rows,
  };
}
