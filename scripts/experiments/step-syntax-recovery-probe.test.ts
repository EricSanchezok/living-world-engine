import { expect, it, vi } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { seededResponseFetch, syntaxRecoveryDecision } from "./step-syntax-recovery-probe";

const body = { model: "frozen-model", messages: [{ role: "user", content: "same source" }] };
const raw = JSON.stringify({ choices: [{ message: { content: "original" } }], usage: { total_tokens: 100 } });
const source = { bodyHash: contentHash(body), response: { raw, rawHash: contentHash(raw), status: 200 } };
const init = { method: "POST", body: JSON.stringify(body) };

it("replays the bound response once without charging historical usage and bounds new sends", async () => {
  const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response("repair"));
  const fetch = seededResponseFetch(source, 1, send);
  expect(await (await fetch("https://test.invalid", init)).text()).toBe(raw);
  expect(send).not.toHaveBeenCalled();
  const repair = { ...init, body: JSON.stringify({ ...body, repair: true }) };
  expect(await (await fetch("https://test.invalid", repair)).text()).toBe("repair");
  expect(send).toHaveBeenCalledExactlyOnceWith("https://test.invalid", repair);
  await expect(fetch("https://test.invalid", repair)).rejects.toThrow("ceiling");
  expect(send).toHaveBeenCalledTimes(1);
});

it("rejects altered source evidence or requests before the paid boundary", async () => {
  const send = vi.fn<typeof fetch>();
  expect(() => seededResponseFetch({ ...source, response: { ...source.response, raw: "changed" } }, 1, send)).toThrow("evidence");
  expect(() => seededResponseFetch(source, -1, send)).toThrow("bound");
  const fetch = seededResponseFetch(source, 0, send);
  await expect(fetch("https://test.invalid", { ...init, body: "{}" })).rejects.toThrow("differs");
  expect(await (await fetch("https://test.invalid", init)).text()).toBe(raw);
  await expect(fetch("https://test.invalid", init)).rejects.toThrow("ceiling");
  expect(send).not.toHaveBeenCalled();
});

it("does not retry or replenish the send bound after an uncertain failure", async () => {
  const send = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection lost"));
  const fetch = seededResponseFetch(source, 1, send);
  await fetch("https://test.invalid", init);
  await expect(fetch("https://test.invalid", init)).rejects.toThrow("connection lost");
  await expect(fetch("https://test.invalid", init)).rejects.toThrow("ceiling");
  expect(send).toHaveBeenCalledTimes(1);
});

it("requires paired complete candidate admission, unchanged controls, and no additional measured repair cost", () => {
  const rows: Parameters<typeof syntaxRecoveryDecision>[0] = [
    { rootId: "016", arm: "B", complete: true, initialAdmittedActions: 38, newHttp: 0, newTotalTokens: 0 },
    { rootId: "016", arm: "P", complete: true, initialAdmittedActions: 38, newHttp: 0, newTotalTokens: 0 },
    { rootId: "017", arm: "B", complete: false, initialAdmittedActions: 0, newHttp: 2, newTotalTokens: 1000 },
    { rootId: "017", arm: "P", complete: true, initialAdmittedActions: 7, newHttp: 1, newTotalTokens: 500 },
  ];
  const changed = (index: number, values: Partial<(typeof rows)[number]>) => rows.map((row, i) => i === index ? { ...row, ...values } : row);
  expect(syntaxRecoveryDecision(rows, false)).toBe("eligible-for-source-semantic-review");
  expect(syntaxRecoveryDecision(changed(3, { complete: false }), false)).toBe("failed");
  expect(syntaxRecoveryDecision(changed(1, { newHttp: 1 }), false)).toBe("failed");
  expect(syntaxRecoveryDecision(changed(3, { newTotalTokens: 1001 }), false)).toBe("failed");
  expect(syntaxRecoveryDecision(changed(3, { newHttp: 3 }), false)).toBe("failed");
  expect(syntaxRecoveryDecision(changed(3, { initialAdmittedActions: 0 }), false)).toBe("failed");
  expect(syntaxRecoveryDecision(changed(3, { newTotalTokens: null }), false)).toBe("inconclusive");
  expect(syntaxRecoveryDecision(changed(3, { rootId: "016" }), false)).toBe("inconclusive");
  expect(syntaxRecoveryDecision(rows.slice(1), false)).toBe("inconclusive");
  expect(syntaxRecoveryDecision(rows, true)).toBe("inconclusive");
});
