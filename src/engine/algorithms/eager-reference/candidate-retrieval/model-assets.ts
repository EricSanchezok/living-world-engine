export const MULTILINGUAL_E5_BASE_ASSET = Object.freeze({
  name: "multilingual-e5-base",
  modelId: "intfloat/multilingual-e5-base",
  sourceRepository: "Xenova/multilingual-e5-base",
  revision: "d59ab9ac3405fabf723089ec5577010211014c99",
  // The runtime filename is an alias; this SHA belongs to the quantized source.
  onnxSourceFile: "onnx/model_quantized.onnx",
  precision: "dynamic-int8",
  files: Object.freeze([
    "config.json",
    "onnx/model.onnx",
    "sentencepiece.bpe.model",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
  ]),
  onnxSha256: "sha256:df7a9a29309e3ad491e1783adf8baee710262cc06079c7cbab63c630277fac94",
  directorySha256: "sha256:b89491c981d9c3d8a9990782e0439073043e0aa567424de32078ea9cb72c1541",
  encoderFingerprint: "sha256:25c0f4bc4ddc81782c76a7be891f4b71d81b9d277267fc801e2f4cd10779a543",
  dimensions: 768,
  runtimeLibraryVersion: "@huggingface/transformers@4.2.0;onnxruntime-node@1.24.3",
} as const);

export type RetrievalModelName = typeof MULTILINGUAL_E5_BASE_ASSET.name;

export function retrievalModelAsset(name: string) {
  if (name !== MULTILINGUAL_E5_BASE_ASSET.name) {
    throw new Error(`unsupported retrieval model: ${name}`);
  }
  return MULTILINGUAL_E5_BASE_ASSET;
}
