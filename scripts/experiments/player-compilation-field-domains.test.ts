import { expect, it } from "vitest";
import { typedAliasReplay } from "./player-compilation-field-domains";
import { TypedCompilationAliases } from "../../src/engine/benchmarks/step-efficiency/typed-compilation-aliases";
import { completeDeepSeekJsonStream } from "../../src/engine/models/deepseek-json-stream";

it("replays complete historical streams with an exact alias inverse and historical usage provenance", () => {
  const codec = new TypedCompilationAliases({ referenceCatalog: { candidates: [{ kind: "agent", candidateKey: "r000" }] } },
    { type: "object", properties: { actorRef: { type: "string", pattern: "^r[0-9]{3,}$" } } });
  const raw = `data: ${JSON.stringify({ id: "original", model: "deepseek-flash", object: "chat.completion.chunk", choices: [
    { index: 0, delta: { role: "assistant", content: '{"actorRef":"r000"}' }, finish_reason: "stop" },
  ], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 } })}\n\ndata: [DONE]\n\n`;
  const replay = typedAliasReplay(raw, codec), response = completeDeepSeekJsonStream(replay.body);
  expect(response.usage).toEqual(completeDeepSeekJsonStream(raw).usage);
  expect(JSON.parse(response.choices[0]!.message.content)).toEqual({ actorRef: "agent_r000" });
  expect(replay.proof).toMatchObject({ roundTripEqual: true, usageOrigin: "historical; no new inference" });
  const malformed = raw.replace('r000\\"}', 'r000\\",}');
  const recovered = typedAliasReplay(malformed, codec);
  expect(recovered.proof).toMatchObject({ originalRecovery: "syntax-repair", roundTripEqual: true });
  expect(recovered.proof.originalTextHash).not.toBe(replay.proof.originalTextHash);
  expect(recovered.proof.originalValueHash).toBe(replay.proof.originalValueHash);
  expect(() => typedAliasReplay(raw.replace("data: [DONE]", ""), codec)).toThrow();
});
