import { vi } from "vitest";
import { ModelGateway } from "../models/model-gateway";
import { parseModelCatalog } from "../models/model-catalog";
import { createTestModelCatalog, createTestModelRegistry } from "./model-provider";
import type { DecisionQuestionV2 } from "../models/decision-v2";

export function directTestProvider(respond: (wire: { model: string; state: unknown;
  questions: Record<string, DecisionQuestionV2> }, call: number) => unknown | Response | Promise<unknown | Response>) {
  const source = createTestModelCatalog().snapshot();
  source.accounts.typesafe = { ...source.accounts["scripted-test"]!, protocol: "typesafe-systemone", dialect: "typesafe",
    models_dev_provider_id: "typesafe", base_url: "https://typesafe.test/v1", api_key_env: "TYPESAFE_API_KEY" };
  source.profiles["decision-jev"] = { ...source.profiles["decision-jev"]!, account_id: "typesafe",
    selector: { kind: "exact", model_id: "jev-1.13.0" } };
  const catalog = parseModelCatalog(source), registry = createTestModelRegistry(catalog);
  let calls = 0;
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body));
    const response = await respond(wire, ++calls);
    if (response instanceof Response) return response;
    if (!wire.questions) return Response.json({ id: `direct-${calls}`, model: wire.model, created: 1,
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(response) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
    return Response.json({ model: wire.model, answers: response, usage: { input_tokens: 100, output_tokens: 10 } });
  });
  return { catalog, registry, transport, gateway: new ModelGateway(catalog,
    { TYPESAFE_API_KEY: "test-private-key", TEST_MODEL_API_KEY: "test-private-key" }, { registry, fetch: transport, maxTransportAttempts: 1 }) };
}

export function nativeChoice(question: DecisionQuestionV2, choice: string) {
  if (question.type !== "choice") throw new Error("not a choice");
  return { type: "choice", choice, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])), confidence: 1 };
}

export function nativeAnswer(question: DecisionQuestionV2, choice: string | number = "none") {
  if (question.type === "noul") return { type: "noul", noul: typeof choice === "number" ? choice : 1 };
  if (question.type === "score") return { type: "score", score: typeof choice === "number" ? choice : 1,
    legend: Object.fromEntries(question.criteria.map((value, index) => [String(index), value])),
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === 1 ? 1 : 0])), confidence: 1 };
  const value = String(choice);
  return nativeChoice(question, value in question.criteria ? value : "none" in question.criteria ? "none" : Object.keys(question.criteria)[0]!);
}
