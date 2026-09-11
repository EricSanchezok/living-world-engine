import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { contentHash } from "../../models/model-audit";
import { ExperimentBudget } from "./experiment-budget";
import { immutableExperimentJson } from "./experiment-artifacts";
import type { FirstPassTrialEvidence } from "./first-pass-runner";

const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const validId = (id: string) => /^(?:discovery|confirmation)-P0[1-4]-\d{2}-(?:B|R|S|SC|SF|SCF)-http-\d{3}$/u.test(id);

/** Only a recorded node TCP connect failure proves that no TLS/HTTP request was sent.
 * Response timeouts, connection resets, missing usage and generic fetch failures do not. */
function assertNotSent(frame: { evidence: FirstPassTrialEvidence; hash: string; stopReason: string | null }) {
  const evidence = frame.evidence;
  const events = evidence.events.filter((event) => event.event === "model.transport.failed");
  const cause = events[0]?.error?.cause;
  if (contentHash(evidence) !== frame.hash || !frame.stopReason || !evidence.stateUnchanged ||
    evidence.compilerAccepted || evidence.calls.length !== 1 || evidence.calls[0]?.audit || events.length !== 1 ||
    !cause || !["ETIMEDOUT", "ECONNREFUSED"].includes(cause.code ?? "") ||
    !cause.message?.startsWith(`connect ${cause.code} `) || !cause.stack?.includes("TCPConnectWrap.afterConnect")) {
    throw new Error("transport outcome is not a proven zero-send TCP connection failure");
  }
}

export function verifiedNotSentHttp(root: string, httpId: string): boolean {
  if (!validId(httpId)) return false;
  const directory = path.join(root, "http", httpId), file = path.join(directory, "not-sent.json");
  if (!existsSync(file)) return false;
  const receipt = read(file);
  const evidencePath = path.join(root, "not-sent-transports", httpId, "result.json");
  const frame = read(evidencePath), request = read(path.join(directory, "request.json"));
  assertNotSent(frame);
  if (receipt.kind !== "tcp-connect-not-sent" || receipt.httpId !== httpId || receipt.evidenceHash !== frame.hash ||
    receipt.frozenHash !== frame.frozenHash || receipt.frozenHash !== read(path.join(root, "frozen.json")).hash ||
    receipt.requestHash !== request.bodyHash || contentHash(request.body) !== request.bodyHash ||
    frame.evidence.trial.id !== request.trial.id || request.id !== httpId ||
    existsSync(path.join(directory, "response.json"))) throw new Error("not-sent reconciliation evidence drift");
  return true;
}

/** Explicit offline reconciliation. Keeps the reservation and appends a proven zero-usage
 * settlement; archives the unsampled trial and preserves its original request artifact. */
export function reconcileNotSentTrial(root: string, trialId: string, budget: ExperimentBudget) {
  const httpId = `${trialId}-http-001`;
  if (!validId(httpId)) throw new Error("invalid reconciliation trial id");
  const http = path.join(root, "http", httpId);
  const matches = readdirSync(path.join(root, "http")).filter((id) => id.startsWith(`${trialId}-http-`));
  if (matches.length !== 1 || matches[0] !== httpId || existsSync(path.join(http, "response.json"))) {
    throw new Error("trial may already contain provider sampling; cannot redraw");
  }
  const original = path.join(root, "trials", trialId), archive = path.join(root, "not-sent-transports", httpId);
  const frame = read(path.join(existsSync(archive) ? archive : original, "result.json"));
  assertNotSent(frame);
  const frozen = read(path.join(root, "frozen.json")), request = read(path.join(http, "request.json"));
  if (frame.frozenHash !== frozen.hash || frame.evidence.trial.id !== trialId || request.trial.id !== trialId ||
    request.id !== httpId || contentHash(request.body) !== request.bodyHash) throw new Error("reconciliation identity drift");
  const journal = readFileSync(path.join(root, "budget.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).entry);
  const reservations = journal.filter((entry) => entry.kind === "reserve" && entry.trialId === trialId);
  const settlement = journal.find((entry) => entry.kind === "settle" && entry.id === httpId);
  if (reservations.length !== 1 || reservations[0]?.id !== httpId ||
    (settlement && contentHash(settlement.usage) !== contentHash({ input: 0, output: 0, cacheHit: 0 }))) {
    throw new Error("reconciliation reservation/usage mismatch");
  }
  if (!existsSync(archive)) { mkdirSync(path.dirname(archive), { recursive: true }); renameSync(original, archive); }
  const receipt = { kind: "tcp-connect-not-sent", httpId, frozenHash: frozen.hash, evidenceHash: frame.hash, requestHash: request.bodyHash,
    reason: "Recorded TCPConnectWrap.afterConnect failure before TLS/HTTP; no model sample; not an unknown response timeout." };
  immutableExperimentJson(path.join(http, "not-sent.json"), receipt);
  if (!verifiedNotSentHttp(root, httpId)) throw new Error("not-sent receipt verification failed");
  if (!settlement) budget.settle(httpId, { input: 0, output: 0, cacheHit: 0 });
  return receipt;
}
