import { vi } from "vitest";
import { ModelGateway } from "../models/model-gateway";
import { parseModelCatalog } from "../models/model-catalog";
import { createTestModelCatalog, createTestModelRegistry } from "./model-provider";

export function decisionQuestionIds(body: Record<string, unknown>): string[] {
  const message = (body.messages as Array<{ role: string; content: string }>).findLast(message => message.role === "user")!.content;
  const marker = "JSON Schema: ", offset = message.lastIndexOf(marker);
  const schema = JSON.parse(message.slice(offset + marker.length));
  return Object.keys(schema.properties.answers.properties);
}

/** Only remote HTTP is replaced; model identities, schemas, audits and queueing use the real gateway. */
export function decisionTestProvider(output?: (body: Record<string, unknown>, attempt: number) => unknown) {
  const base = createTestModelCatalog(["world-test"]);
  const catalog = parseModelCatalog({ schema_version: 3, scheduler: base.scheduler, registry: base.registry, accounts: base.accounts,
    profiles: { "world-test": { ...base.profile("world-test"), allowed_roles: ["decision", "creation"] } } });
  const registry = createTestModelRegistry(catalog); let calls = 0;
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls += 1;
    const value = output ? output(body, calls) : { answers: Object.fromEntries(decisionQuestionIds(body).map(id => [id, { choice: "yes" }])) };
    return Response.json({ id: `request-${calls}`, model: "scripted:world-test", created: 1,
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(value) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
  });
  return { gateway: new ModelGateway(catalog, { TEST_MODEL_API_KEY: "private-test-key" }, { registry, fetch: transport }), transport, registry };
}
