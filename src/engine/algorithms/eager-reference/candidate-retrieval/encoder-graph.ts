import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

interface Graph {
  node?: Array<{ opType?: string; attribute?: Array<{ g?: Graph | null; graphs?: Graph[] }> }>;
  initializer?: Array<{ dataType?: number }>;
}
interface Model { producerName?: string; graph?: Graph }

/** Read the installed ONNX schema without importing browser inference code. */
export function decodeEncoderGraph(bytes: Uint8Array): Model {
  const runtimeRequire = createRequire(path.join(process.cwd(), "package.json"));
  const resolver = runtimeRequire.resolve;
  let root = path.dirname(Reflect.apply(resolver, runtimeRequire, ["onnxruntime-web"]) as string);
  while (path.basename(root) !== "onnxruntime-web") {
    const parent = path.dirname(root);
    if (parent === root) throw new Error("cannot locate installed ONNX schema");
    root = parent;
  }
  const schema = runtimeRequire(path.join(root, "lib/onnxjs/ort-schema/protobuf/onnx.js")) as {
    onnx: { ModelProto: { decode(value: Uint8Array): Model } };
  };
  return schema.onnx.ModelProto.decode(bytes);
}

export function inspectFullPrecisionEncoder(file: string, expectedSha256: string) {
  const bytes = readFileSync(file);
  const sha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedSha256) throw new Error("explicit encoder ONNX hash drift");
  const model = decodeEncoderGraph(bytes);
  if (!model.graph?.node?.length) throw new Error("encoder has no executable ONNX graph");
  const operators: Record<string, number> = {}, initializerTypes: Record<string, number> = {};
  const visit = (graph: Graph) => {
    for (const node of graph.node ?? []) {
      const op = node.opType ?? "";
      operators[op] = (operators[op] ?? 0) + 1;
      if (/Quantize|QLinear|MatMulInteger|MatMulNBits/iu.test(op)) throw new Error("explicit fp32 encoder contains a quantization operator: " + op);
      for (const attribute of node.attribute ?? []) {
        if (attribute.g) visit(attribute.g);
        for (const nested of attribute.graphs ?? []) visit(nested);
      }
    }
    for (const tensor of graph.initializer ?? []) {
      const type = tensor.dataType ?? 0;
      initializerTypes[type] = (initializerTypes[type] ?? 0) + 1;
      // FLOAT weights; INT32/INT64/BOOL shape, axis and mask constants.
      if (![1, 6, 7, 9].includes(type)) throw new Error("explicit fp32 encoder contains a non-fp32 weight type: " + type);
    }
  };
  visit(model.graph);
  if (!initializerTypes[1]) throw new Error("encoder has no fp32 initializers");
  return { sha256, producer: model.producerName ?? null, operators, initializerTypes, bytes: bytes.length };
}
