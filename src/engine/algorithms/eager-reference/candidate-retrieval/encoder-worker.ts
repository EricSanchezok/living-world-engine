import { Worker } from "node:worker_threads";

interface EncoderWorkerOptions {
  moduleUrl: string;
  modelDirectory: string;
  dimensions: number;
  maxBatchSize: number;
  maxTokens: number;
  explicitFp32: boolean;
}

// A literal bootstrap keeps native dependency loading outside Next's module
// rewriting. The caller supplies an absolute URL from the native resolver.
const encoderWorkerSource = String.raw`
const { parentPort, workerData: config } = require('node:worker_threads');
async function main() {
  const transformers = await import(config.moduleUrl);
  transformers.env.allowRemoteModels = false;
  transformers.env.allowLocalModels = true;
  const extractor = await transformers.pipeline('feature-extraction', config.modelDirectory, {
    device: 'cpu', dtype: 'fp32', local_files_only: true,
  });
  function vectors(output, count) {
    if (!Array.isArray(output.dims) || output.dims.length < 2) throw Error('encoder output must have batch and embedding dimensions');
    const dimensions = output.dims.at(-1);
    if (dimensions !== config.dimensions) throw Error('encoder output dimension mismatch');
    if (output.data.length < count * dimensions) throw Error('encoder output data is shorter than expected');
    return Array.from({ length: count }, (_, row) => Array.from({ length: dimensions }, (_, col) => Number(output.data[row * dimensions + col])));
  }
  async function encode(texts) {
    const result = [];
    for (let offset = 0; offset < texts.length; offset += config.maxBatchSize) {
      const batch = texts.slice(offset, offset + config.maxBatchSize);
      if (config.explicitFp32) {
        const inputs = extractor.tokenizer(batch, { padding: 'max_length', truncation: true, max_length: config.maxTokens });
        if (inputs.input_ids.dims[1] !== config.maxTokens) throw Error('explicit encoder tokenizer exceeded its pinned token length');
        const outputs = await extractor.model(inputs);
        const pooled = transformers.mean_pooling(outputs.last_hidden_state, inputs.attention_mask).normalize(2, -1);
        if (!(pooled.data instanceof Float32Array)) throw Error('explicit encoder did not return fp32 embeddings');
        result.push(...vectors(pooled, batch.length));
      } else {
        result.push(...vectors(await extractor(batch, { pooling: 'mean', normalize: true, truncation: true, max_length: config.maxTokens }), batch.length));
      }
    }
    return result;
  }
  // One extractor owns one ordered queue, including disposal. Native ONNX run
  // can block this worker, but cannot starve the host's sockets or timers.
  let queue = Promise.resolve();
  parentPort.on('message', ({ id, texts, dispose }) => {
    queue = queue.then(async () => {
      try {
        const value = dispose ? await extractor.dispose() : await encode(texts);
        parentPort.postMessage({ id, value });
      } catch (error) {
        parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (dispose) parentPort.close();
      }
    });
  });
  parentPort.postMessage({ ready: true });
}
main().catch(error => { throw error; });
`;

export async function createEncoderWorker(options: EncoderWorkerOptions): Promise<{
  encodeBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
  dispose(): Promise<void>;
}> {
  const worker = new Worker(encoderWorkerSource, { eval: true, workerData: options });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let sequence = 0;
  let failure: Error | undefined;
  let disposing: Promise<void> | undefined;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = (error: Error): void => {
    failure ??= error;
    readyReject(failure);
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
    worker.unref();
  };
  worker.on("error", fail);
  worker.on("messageerror", fail);
  worker.on("exit", (code) => fail(new Error(`local encoder worker exited (${code})`)));
  worker.on("message", (message: { ready?: boolean; id?: number; value?: unknown; error?: string }) => {
    if (message.ready) readyResolve();
    else if (message.id !== undefined) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error !== undefined) request?.reject(new Error(message.error));
      else request?.resolve(message.value);
    }
    if (pending.size === 0) worker.unref();
  });
  try { await ready; } catch (error) { await worker.terminate(); throw error; }

  function send(message: { texts?: readonly string[]; dispose?: true }): Promise<unknown> {
    if (failure) return Promise.reject(failure);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.ref();
      try { worker.postMessage({ ...message, id }); }
      catch (error) {
        pending.delete(id);
        if (pending.size === 0) worker.unref();
        reject(error);
      }
    });
  }
  return {
    encodeBatch(texts) {
      if (disposing) return Promise.reject(new Error("local encoder is disposed"));
      return send({ texts }) as Promise<readonly (readonly number[])[]>;
    },
    dispose() {
      disposing ??= send({ dispose: true }).then(() => undefined).finally(async () => { await worker.terminate(); });
      return disposing;
    },
  };
}
