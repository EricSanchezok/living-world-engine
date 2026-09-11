import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { retrievalModelAsset } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/model-assets";
import {
  hashLocalModelDirectory,
  livingWorldCacheRoot,
} from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";

interface InstallOptions {
  model: string;
  cacheRoot: string;
}

export interface RetrievalModelAssetDescriptor {
  name: string;
  modelId: string;
  sourceRepository: string;
  revision: string;
  files: readonly string[];
  onnxSourceFile?: string;
  onnxSha256: string;
  directorySha256: string;
  encoderFingerprint: string;
}

function usage(): string {
  return `Usage: retrieval-model-install --model multilingual-e5-base [options]

Options:
  --model <name>            Pinned retrieval model name
  --cache-root <directory>  Cache root (default: $LIVINGWORLD_CACHE_ROOT or .livingworld-cache)
  --help
`;
}

function required(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

export function parseRetrievalModelInstallArgs(argv: readonly string[]): InstallOptions {
  const options: Partial<InstallOptions> = { cacheRoot: livingWorldCacheRoot() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--model") options.model = required(argv, ++index, argument);
    else if (argument === "--cache-root") options.cacheRoot = path.resolve(required(argv, ++index, argument));
    else if (argument === "--help" || argument === "-h") throw new Error(usage());
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.model) throw new Error("--model is required");
  retrievalModelAsset(options.model);
  return options as InstallOptions;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest("hex")}`;
}

function assetDirectory(cacheRoot: string, asset: RetrievalModelAssetDescriptor): string {
  return path.join(
    path.resolve(cacheRoot),
    "models",
    asset.name,
    asset.directorySha256.slice("sha256:".length),
  );
}

async function verifyAsset(directory: string, asset: RetrievalModelAssetDescriptor): Promise<void> {
  const onnxHash = await sha256File(path.join(directory, "onnx", "model.onnx"));
  if (onnxHash !== asset.onnxSha256) {
    throw new Error(`retrieval model ONNX hash mismatch: expected ${asset.onnxSha256}, got ${onnxHash}`);
  }
  const directoryHash = hashLocalModelDirectory(directory);
  if (directoryHash !== asset.directorySha256) {
    throw new Error(`retrieval model directory hash mismatch: expected ${asset.directorySha256}, got ${directoryHash}`);
  }
}

export async function installRetrievalModel(
  options: InstallOptions,
  dependencies: {
    fetcher?: typeof fetch;
    asset?: RetrievalModelAssetDescriptor;
  } = {},
): Promise<Record<string, unknown>> {
  const asset = dependencies.asset ?? retrievalModelAsset(options.model);
  const target = assetDirectory(options.cacheRoot, asset);
  if (existsSync(target)) {
    await verifyAsset(target, asset);
    return {
      model: asset.name,
      modelId: asset.modelId,
      revision: asset.revision,
      directory: target,
      directorySha256: asset.directorySha256,
      onnxSha256: asset.onnxSha256,
      alreadyInstalled: true,
    };
  }

  const modelRoot = path.dirname(target);
  mkdirSync(modelRoot, { recursive: true });
  const staging = mkdtempSync(path.join(modelRoot, `.install-${asset.name}-`));
  const fetcher = dependencies.fetcher ?? fetch;
  try {
    for (const relative of asset.files) {
      const destination = path.join(staging, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      const source = relative === "onnx/model.onnx" ? asset.onnxSourceFile ?? relative : relative;
      const url = `https://huggingface.co/${asset.sourceRepository}/resolve/${asset.revision}/${source}?download=true`;
      const response = await fetcher(url, { redirect: "follow" });
      if (!response.ok || !response.body) {
        throw new Error(`retrieval model download failed for ${relative}: HTTP ${response.status}`);
      }
      await pipeline(
        Readable.fromWeb(response.body as never),
        createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      );
    }
    await verifyAsset(staging, asset);
    if (existsSync(target)) {
      await verifyAsset(target, asset);
      rmSync(staging, { recursive: true, force: true });
    } else {
      renameSync(staging, target);
    }
    return {
      model: asset.name,
      modelId: asset.modelId,
      revision: asset.revision,
      directory: target,
      directorySha256: asset.directorySha256,
      onnxSha256: asset.onnxSha256,
      alreadyInstalled: false,
    };
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const options = parseRetrievalModelInstallArgs(argv);
    process.stdout.write(`${JSON.stringify(await installRetrievalModel(options), null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Usage:")) {
      process.stdout.write(message);
      return 0;
    }
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
