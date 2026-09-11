import { pathToFileURL } from "node:url";
import { contentHash } from "../../src/engine/models/model-audit";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelConfigurationError } from "../../src/engine/models/model-provider";
import { recordedContext } from "../../src/engine/benchmarks/step-efficiency/repair-tail";
import { repairPromptLayout } from "../../src/engine/prompts/repair-layout";
import { countDeepSeekContext } from "./deepseek-context-admission";
import { prepareTransitionExampleProbe, runTransitionPairProbe } from "./step-transition-example-probe";

const TRIAL = "probes-e2-logical-tail-01";

export async function prepareLogicalTailProbe() {
  const base = await prepareTransitionExampleProbe();
  const requests = (["B", "T"] as const).map(arm => ({ ...base.requests[1]!, workloadId: TRIAL, batchId: `${TRIAL}-${arm}`,
    ...(arm === "T" ? { repairContextPlacement: "logical-tail-v1" as const } : {}) }));
  const bodies: Array<{ messages: Array<{ content: string }> }> = [], admissions: Array<Awaited<ReturnType<typeof countDeepSeekContext>>> = [];
  for (const request of requests) {
    let captured = false;
    const gateway = createModelGateway(base.catalog, { [base.catalog.account("deepseek-api").api_key_env]: "offline-only" }, {
      maxTransportAttempts: 1, registry: base.registryBinding, fetchForAccount: () => async (_input, init) => {
        const body = JSON.parse(String(init?.body)); bodies.push(body); admissions.push(await countDeepSeekContext(body)); captured = true;
        throw new ModelConfigurationError("offline tail request captured");
      } });
    try { await gateway.generateStructured(request); } catch (error) { if (!captured) throw error; }
  }
  if (admissions[0]!.bodyHash !== base.manifest.contextBudgets[1]!.bodyHash) throw new Error("inline no-example control changed");
  const expected = structuredClone(bodies[0]!), message = expected.messages[1]!.content;
  const context = recordedContext(message), layout = repairPromptLayout(requests[0]!.userPrompt, context.text, "logical-tail-v1");
  expected.messages[1]!.content = message.slice(0, context.start) + layout.contextJson + message.slice(context.end) + layout.tail;
  if (contentHash(expected) !== contentHash(bodies[1])) throw new Error("tail request changed beyond exact feedback relocation");
  const manifest = { ...base.manifest, trialId: TRIAL, contextBudgets: admissions,
    acceptance: "Independent paired one-response diagnostic with no example in either arm. The only T change relocates the existing bound repair object and its exact notice after the schema; restore the original complete context losslessly. No output transfer, additional online repair, stronger inference or retries. Formal coverage and references precede source review. A single pair is not reliability, semantic or gameplay qualification." };
  return { ...base, requests, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTransitionPairProbe(prepareLogicalTailProbe).catch(error => { console.error(error); process.exitCode = 1; });
}
