import { vi } from "vitest";
import { ModelGateway } from "../models/model-gateway";
import { parseModelCatalog } from "../models/model-catalog";
import { createTestModelCatalog, createTestModelRegistry } from "./model-provider";
import type { DecisionQuestionV2 } from "../models/decision-v2";

export interface DirectTestWire { model: string; state: unknown; questions: Record<string, DecisionQuestionV2>;
  messages?: Array<{ role: string; content: string }> }

export function directCreationContext(wire: DirectTestWire): Record<string, unknown> {
  const prompt = wire.messages?.find(message => message.role === "user")?.content ?? "";
  const start = prompt.indexOf("\n\n{") + 2, end = prompt.indexOf("\n\nReturn exactly one JSON object");
  return JSON.parse(prompt.slice(start, end < 0 ? undefined : end));
}

export function directDecisionContext(wire: DirectTestWire): Pick<DirectTestWire, "state" | "questions"> | undefined {
  if (wire.questions) return wire;
  const context = directCreationContext(wire);
  if (context.playerReading) return readingDecision(context.playerReading as TestReading);
  return context.decision as Pick<DirectTestWire, "state" | "questions"> | undefined;
}

interface TestReading { state: Record<string, unknown>; catalog: Record<string, Record<string, string>>;
  cognition: Record<string, DecisionQuestionV2>; exactQuotes: Record<string, string> }
function readingDecision(reading: TestReading): Pick<DirectTestWire, "state" | "questions"> {
  const choice = (criteria: Record<string, string>): DecisionQuestionV2 => ({ type: "choice", version: "test-reading", instructions: "Scripted interpretation boundary", criteria });
  return { state: reading.state, questions: { ...Object.fromEntries(Object.entries(reading.catalog).map(([id, criteria]) => [id, choice(criteria)])),
    ...reading.cognition, interaction: choice({ world_action: "World action", clarification: "Clarification", request_complete: "This submission already has complete receipts" }),
    speech: choice({ none: "None", create: "Created words", input: "Literal input", ...reading.exactQuotes }),
    reflection: choice({ none: "None", create: "Private synthesis" }), expression: { type: "noul", version: "test-reading", instructions: "Expressive action" } } };
}

export function directTestProvider(respond: (wire: DirectTestWire, call: number) => unknown | Response | Promise<unknown | Response>,
  create?: (wire: DirectTestWire) => unknown | Response | Promise<unknown | Response>, options: { maxInputBytes?: number; suggestions?: (wire: DirectTestWire) => unknown | Promise<unknown> } = {}) {
  const source = createTestModelCatalog().snapshot();
  source.accounts.typesafe = { ...source.accounts["scripted-test"]!, protocol: "typesafe-systemone", dialect: "typesafe",
    models_dev_provider_id: "typesafe", base_url: "https://typesafe.test/v1", api_key_env: "TYPESAFE_API_KEY" };
  source.profiles["decision-jev"] = { ...source.profiles["decision-jev"]!, account_id: "typesafe",
    ...(options.maxInputBytes ? { max_input_bytes: options.maxInputBytes } : {}),
    selector: { kind: "exact", model_id: "jev-1.13.0" } };
  const catalog = parseModelCatalog(source), registry = createTestModelRegistry(catalog);
  let calls = 0;
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body));
    calls++;
    const decision = !wire.questions ? directCreationContext(wire).decision as { state: unknown; questions: Record<string, DecisionQuestionV2> } | undefined : undefined;
    const reading = !wire.questions ? directCreationContext(wire).playerReading as TestReading | undefined : undefined;
    let response: unknown;
    if (!wire.questions && directCreationContext(wire).task === "action-suggestions") {
      response = options.suggestions ? await options.suggestions(wire) : { items: [] };
    } else if (reading) {
      const decoded = await respond({ ...wire, ...readingDecision(reading) }, calls);
      if (decoded instanceof Response) return decoded;
      const raw = decoded as Record<string, Record<string, unknown>>;
      const pick = (id: string) => String(raw[id]?.choice ?? "none");
      const operation = pick("operation"), speech = pick(operation === "reflect" ? "reflection" : "speech");
      const request = reading.state.submittedAction as { rawText: string };
      const literal = reading.exactQuotes[speech];
      const expressive = Number(raw.expression?.noul ?? 0) >= 0.5;
      let expression: { attempt?: string; utterance?: string | null; manner?: string | null } = {
        attempt: request.rawText, utterance: operation === "speak" ? literal ?? (speech === "input" ? request.rawText : null) : null, manner: null };
      const prepare = ["speak", "transfer"].includes(operation) && ["none", "discover"].includes(pick("recipient"));
      if (!prepare && (operation === "speak" && (!literal || expressive) || operation === "reflect" && speech === "create" ||
        ["use", "change"].includes(operation) || expressive)) {
        const context = { ...reading.state, chosenDirection: operation, playerControlled: true, currentPlayerRequest: request.rawText };
        const synthetic = { ...wire, messages: [{ role: "user", content: `Expression fixture\n\n${JSON.stringify(context)}\n\nReturn exactly one JSON object` }] };
        const created = await (create ? create(synthetic) : respond(synthetic, calls));
        if (created instanceof Response) return created;
        expression = { ...expression, ...created as typeof expression };
      }
      response = { understanding: "Scripted coherent player interpretation", interaction: pick("interaction"),
        requestAnalysis: { authorizedSteps: [request.rawText], establishedReceipts: [], remainingSteps: [request.rawText] },
        action: { ...Object.fromEntries(Object.keys(reading.catalog).map(id => [id, pick(id)])),
          attempt: expression.attempt ?? request.rawText, utterance: expression.utterance ?? null, manner: expression.manner ?? null,
          literalQuote: literal && operation === "speak" ? speech : "none" },
        cognition: Object.fromEntries(Object.keys(reading.cognition).map(id => [id, pick(id)])) };
    } else response = await (decision ? respond({ ...wire, ...decision }, calls) : !wire.questions && create ? create(wire) : respond(wire, calls));
    if (response instanceof Response) return response;
    if (decision) response = { answers: Object.fromEntries(Object.entries(response as Record<string, Record<string, unknown>>).map(([id, answer]) =>
      [id, answer[String(answer.type)]])) };
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
  return nativeChoice(question, value in question.criteria ? value : ["world_action", "none", "unnamed", "target"].find(key => key in question.criteria) ?? Object.keys(question.criteria)[0]!);
}
