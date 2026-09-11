import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashLocalModelDirectory } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import {
  installRetrievalModel,
  parseRetrievalModelInstallArgs,
  type RetrievalModelAssetDescriptor,
} from "./retrieval-model-install";

const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

describe("retrieval model installer", () => {
  it("requires the one pinned production model", () => {
    expect(parseRetrievalModelInstallArgs(["--model", "multilingual-e5-base"]).model)
      .toBe("multilingual-e5-base");
    expect(() => parseRetrievalModelInstallArgs([])).toThrow("--model is required");
    expect(() => parseRetrievalModelInstallArgs(["--model", "floating-model"]))
      .toThrow("unsupported retrieval model");
  });

  it("downloads a fixed file set, verifies both hashes, and reuses an exact install", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-model-install-"));
    roots.push(root);
    const reference = path.join(root, "reference");
    mkdirSync(path.join(reference, "onnx"), { recursive: true });
    const config = Buffer.from("fixture-config");
    const onnx = Buffer.from("fixture-onnx");
    writeFileSync(path.join(reference, "config.json"), config);
    writeFileSync(path.join(reference, "onnx", "model.onnx"), onnx);
    const asset: RetrievalModelAssetDescriptor = {
      name: "multilingual-e5-base",
      modelId: "fixture/base",
      sourceRepository: "fixture/base",
      revision: "a".repeat(40),
      files: ["config.json", "onnx/model.onnx"],
      onnxSourceFile: "onnx/model_quantized.onnx",
      onnxSha256: sha256(onnx),
      directorySha256: hashLocalModelDirectory(reference),
      encoderFingerprint: `sha256:${"b".repeat(64)}`,
    };
    const bodies = new Map([
      ["config.json", config],
      ["onnx/model_quantized.onnx", onnx],
    ]);
    const requests: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      const relative = [...bodies.keys()].find((file) => url.includes(`/${file}?download=true`));
      return relative ? new Response(bodies.get(relative), { status: 200 }) : new Response(null, { status: 404 });
    };
    const options = { model: asset.name, cacheRoot: path.join(root, "cache") };

    const installed = await installRetrievalModel(options, { asset, fetcher: fetcher as typeof fetch });
    expect(installed).toMatchObject({ alreadyInstalled: false, directorySha256: asset.directorySha256 });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("/onnx/model_quantized.onnx?download=true");
    expect(existsSync(installed.directory as string)).toBe(true);

    requests.splice(0);
    const reused = await installRetrievalModel(options, { asset, fetcher: fetcher as typeof fetch });
    expect(reused).toMatchObject({ alreadyInstalled: true, directory: installed.directory });
    expect(requests).toHaveLength(0);
    expect(readdirSync(path.dirname(installed.directory as string)).some((entry) => entry.startsWith(".install-")))
      .toBe(false);
  });
});
