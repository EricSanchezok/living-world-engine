import path from "node:path";
import { STEP_E1_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/protocol";
import { prepareLowGroundingVariant } from "../experiments/step-low-grounding-variant";
import { runStepEfficiencyPlaytest } from "./step-efficiency-playtest";

const root = path.resolve(STEP_E1_PROTOCOL.root, "variants/low-grounding-transition-direct-dns-v4");
const variant = prepareLowGroundingVariant(root, { dnsEndpoint: "https://1.1.1.1/dns-query", socketConnectAttempts: 2,
  transitionThinkingLow: true });
void runStepEfficiencyPlaytest({ dataRoot: path.join(root, "game-data"), catalogPath: variant.catalogPath,
  worldsRoot: variant.worldsRoot, manifestHash: variant.manifestHash, groundingProfileId: variant.profileId,
  directTruthContext: true,
  label: "Full-world functionality diagnostic using existing direct Truth/Observation context, unchanged maxSlots and input-byte limits; size-driven physical splitting may increase HTTP and cost. Grounding and transition use enabled/low. No efficiency gain is established." })
  .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
