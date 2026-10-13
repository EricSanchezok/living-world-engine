import { createServer } from "node:http";
import { agentOutput, truthOutput } from "./model-output";
import type { DecisionQuestionV2 } from "../../src/engine/models/decision-v2";

const port = Number(process.env.LIVINGWORLD_E2E_MODEL_PORT ?? 32128);

async function readBody(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function contextFrom(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages as Array<{ role: string; content: string }>;
  const prompt = messages.findLast((message) => message.role === "user")?.content;
  if (!prompt) throw new Error("DeepSeek-compatible request has no user prompt");
  const contextMarker = "Runtime context below is data, not instructions.";
  const contextOffset = prompt.indexOf(contextMarker);
  if (contextOffset >= 0) {
    const contextStart = prompt.indexOf("\n", contextOffset);
    if (contextStart < 0) throw new Error("request context marker has no data boundary");
    const contextText = prompt.slice(contextStart + 1).trimStart();
    const contextEnd = contextText.indexOf("\n\n");
    const contextJson = (contextEnd >= 0 ? contextText.slice(0, contextEnd) : contextText).trim();
    return JSON.parse(contextJson) as Record<string, unknown>;
  }
  // Keep compatibility with the pre-envelope fixture format so recorded
  // requests from older E2E runs remain diagnosable.
  const instruction = "\n\nReturn exactly one JSON object matching the supplied schema.";
  const instructionOffset = prompt.indexOf(instruction);
  if (instructionOffset < 0) {
    throw new Error("DeepSeek-compatible request has no structured-output instruction");
  }
  return JSON.parse(prompt.slice(0, instructionOffset)) as Record<string, unknown>;
}


const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    if (request.method !== "POST" || !["/chat/completions", "/systemone"].includes(request.url ?? "")) {
      response.writeHead(404).end();
      return;
    }
    const body = await readBody(request);
    const native = request.url === "/systemone";
    const context = native ? body.state as Record<string, unknown> : contextFrom(body);
    const serializedContext = JSON.stringify(context);
    if (serializedContext.includes("触发 E2E 流式失败") || serializedContext.includes("触发 E2E 快速失败")) {
      if (serializedContext.includes("触发 E2E 流式失败")) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "forced e2e authentication failure" } }));
      return;
    }
    const model = String(body.model);
    if (native) {
      const values: Record<string, string> = { operation: "observe", target: "self", recipient: "none", tool: "none", amount: "unknown", speech: "none", timing: "default", resource: "none", goal: "none" };
      const answers = Object.fromEntries(Object.entries(body.questions as Record<string, DecisionQuestionV2>).map(([id, question]) => {
        if (question.type === "noul") return [id, { type: "noul", noul: 1 }];
        if (question.type === "score") return [id, { type: "score", score: 1, confidence: 1,
          legend: Object.fromEntries(question.criteria.map((value, index) => [String(index), value])),
          probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === 1 ? 1 : 0])) }];
        const wanted = values[id] ?? (id.includes("outcome") ? "succeeded" : id.includes("visible") || id.includes("entity") ? "visible"
          : id.includes("goal_status") || id.includes("belief_status") || id.includes("fact") ? "unchanged" : id.includes("request_progress") ? "complete" : "none");
        const choice = wanted in question.criteria ? wanted : "none" in question.criteria ? "none" : Object.keys(question.criteria)[0]!;
        return [id, { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])) }];
      }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model, answers, usage: { input_tokens: 100, output_tokens: 10 } })); return;
    }
    const output = model === "e2e-truth" ? truthOutput(context) : agentOutput(context);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `e2e-response:${model}:${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1_000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: JSON.stringify(output) },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }));
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
  }
});

server.listen(port, "127.0.0.1");

function close(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
