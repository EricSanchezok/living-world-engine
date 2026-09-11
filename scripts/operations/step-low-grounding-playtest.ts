import path from "node:path";
import { STEP_E1_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/protocol";
import { prepareLowGroundingVariant } from "../experiments/step-low-grounding-variant";
import { runStepEfficiencyPlaytest } from "./step-efficiency-playtest";

const root = path.resolve(STEP_E1_PROTOCOL.root, "variants/low-grounding-direct-dns-v3");
const variant = prepareLowGroundingVariant(root, { dnsEndpoint: "https://1.1.1.1/dns-query", socketConnectAttempts: 2 });
void runStepEfficiencyPlaytest({ dataRoot: path.join(root, "game-data"), catalogPath: variant.catalogPath,
  worldsRoot: variant.worldsRoot, manifestHash: variant.manifestHash, groundingProfileId: variant.profileId,
  label: "Full-world diagnostic of enabled/low grounding with a direct HTTPS DNS resolver; microbenchmark optimization gates were not met." })
  .catch((error: unknown) => { console.error(error);process.exitCode = 1; });
