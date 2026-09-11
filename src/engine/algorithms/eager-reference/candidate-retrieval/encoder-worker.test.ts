import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createEncoderWorker } from "./encoder-worker";

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "encoder-worker-"));
  const modulePath = path.join(directory, "fixture.mjs");
  writeFileSync(modulePath, `
import { existsSync, writeFileSync } from 'node:fs';
export const env = {};
export async function pipeline(task, directory, options) {
  if (task !== 'feature-extraction' || options.dtype !== 'fp32' || options.device !== 'cpu' || !options.local_files_only || env.allowRemoteModels || !env.allowLocalModels) throw Error('inference contract changed');
  const extractor = async (texts, options) => {
    if (texts.includes('exit')) process.exit(7);
    if (texts.includes('reject')) throw Error('fixture inference rejected');
    if (texts.includes('block')) {
      writeFileSync(directory + '/entered', '1');
      const deadline = Date.now() + 3000;
      while (!existsSync(directory + '/release')) {
        if (Date.now() > deadline) throw Error('host event loop could not release inference');
      }
    }
    if (options.pooling !== 'mean' || !options.normalize || !options.truncation || options.max_length !== 128) throw Error('pooling contract changed');
    return { dims: [texts.length, 2], data: new Float32Array(texts.flatMap(t => [t.length, 0.25])) };
  };
  extractor.tokenizer = (texts, options) => {
    if (options.padding !== 'max_length' || !options.truncation || options.max_length !== 128) throw Error('token contract changed');
    return { texts, input_ids: { dims: [texts.length, 128] }, attention_mask: {} };
  };
  extractor.model = async ({ texts }) => ({ last_hidden_state: { dims: [texts.length, 2], data: new Float32Array(texts.flatMap(t => [t.length, 0.25])) } });
  extractor.dispose = async () => {};
  return extractor;
}
export function mean_pooling(output) { return { ...output, normalize(p, axis) { if (p !== 2 || axis !== -1) throw Error('normalization changed'); return output; } }; }
`);
  return { directory, options: { moduleUrl: pathToFileURL(modulePath).href, modelDirectory: directory,
    dimensions: 2, maxBatchSize: 2, maxTokens: 128, explicitFp32: false } };
}

describe("local encoder worker", () => {
  it("keeps the host responsive while inference synchronously waits for a host release", async () => {
    const { directory, options } = fixture();
    const worker = await createEncoderWorker(options);
    try {
      const blocked = worker.encodeBatch(["block"]);
      // Capture rejection immediately; the fixture bounds failure if the host cannot run.
      const outcome = blocked.then(value => ({ value }), error => ({ error }));
      let entered = false;
      for (let attempt = 0; attempt < 200 && !entered; attempt++) {
        entered = await readFile(path.join(directory, "entered")).then(() => true, () => false);
        if (!entered) await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(entered).toBe(true);
      writeFileSync(path.join(directory, "release"), "1");
      expect(await outcome).toEqual({ value: [[5, 0.25]] });
    } finally { await worker.dispose(); }
  });

  it.each([false, true])("preserves order, batches, fp32 pooling and disposal (explicit=%s)", async explicitFp32 => {
    const { options } = fixture();
    const worker = await createEncoderWorker({ ...options, explicitFp32 });
    try {
      expect(await Promise.all([worker.encodeBatch(["a", "bbb", "cc"]), worker.encodeBatch(["dddd"]), worker.encodeBatch([])]))
        .toEqual([[[1, 0.25], [3, 0.25], [2, 0.25]], [[4, 0.25]], []]);
    } finally { await worker.dispose(); }
    await expect(worker.encodeBatch(["after"])).rejects.toThrow("disposed");
    await worker.dispose();
  });

  it("rejects one inference without losing a queued request", async () => {
    const { options } = fixture();
    const worker = await createEncoderWorker(options);
    try {
      const outcomes = await Promise.allSettled([worker.encodeBatch(["reject"]), worker.encodeBatch(["ok"])]);
      expect(outcomes[0]).toMatchObject({ status: "rejected", reason: new Error("fixture inference rejected") });
      expect(outcomes[1]).toEqual({ status: "fulfilled", value: [[2, 0.25]] });
    } finally { await worker.dispose(); }
  });

  it("rejects all pending requests and future work on native worker exit", async () => {
    const { options } = fixture();
    const worker = await createEncoderWorker(options);
    const outcomes = await Promise.allSettled([worker.encodeBatch(["exit"]), worker.encodeBatch(["pending"])]);
    expect(outcomes.map(outcome => outcome.status)).toEqual(["rejected", "rejected"]);
    await expect(worker.encodeBatch(["later"])).rejects.toThrow("worker exited (7)");
    await expect(worker.dispose()).rejects.toThrow("worker exited (7)");
  });

  it("propagates model loading failure", async () => {
    const { directory, options } = fixture();
    writeFileSync(path.join(directory, "fixture.mjs"), "throw Error('model unavailable');");
    await expect(createEncoderWorker(options)).rejects.toThrow("model unavailable");
  });
});
