import path from "node:path";
import { encodeProgramDraft } from "../programs/creation-codec";
import { loadWorldScript } from "../../script/world-loader";
import { createTestModelCatalog } from "./model-provider";
import { decisionQuestionIds, decisionTestProvider } from "./decision-provider";
import type { ProgramDefinition } from "../programs/definition";
import type { WorldProgramDefinition } from "../events/world-program";
import type { PolicyBinding } from "../runtime/execution";

export const nativeProgramTestConfig = { decision: "world-test", creation: "world-test", fallback: "world-test", maxDependencyRounds: 32 };
export function nativeProgramFixture(options: { goalVerdict?: "yes" | "no" | "unknown"; reuse?: boolean; worldVerdict?: "yes" | "no" | "unknown" } = {}) {
  const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: createTestModelCatalog() });
  const program: ProgramDefinition = { version: 1, id: "ask-purpose", name: "Ask the purpose", description: "Ask and await evidence.", owner: { kind: "agent", agentId: "keeper" },
    sourceIds: ["goal:guard-gate"], parameters: { recipient: { kind: "entity", description: "Known traveler" } },
    reads: ["evidence"], writes: [], entry: "ask", startPredicateId: "ready", interrupts: [], milestones: [],
    goals: [{ goalId: "guard-gate", predicateId: "complete" }],
    nodes: [{ id: "ask", kind: "attempt", intent: "Spend 5 seconds asking {recipient} why they are here.", entityTargetParameters: ["recipient"],
      speech: { kind: "authored", text: "Why are you here?" }, onFailure: "expand", onPartial: "wait" }],
    predicates: [{ id: "ready", description: "Available plan", sourceIds: ["goal:guard-gate"], reads: ["evidence"], unknown: "wait",
      test: { kind: "mechanical", operator: "eq", left: { kind: "literal", value: true }, right: { kind: "literal", value: true } } },
    { id: "complete", description: "Duty complete", sourceIds: ["goal:guard-gate"], reads: ["evidence"], unknown: "wait",
      test: { kind: "semantic", instructions: "Is the actual guarding duty complete?" } }] };
  const rule: WorldProgramDefinition = { version: 1, namespace: "world", id: "ask-reachable", description: "Ask a nearby traveler a question.",
    sourceIds: ["world"], parameters: { actor: { kind: "entity", description: "Speaker" }, recipient: { kind: "entity", description: "Listener" },
      utterance: { kind: "text", description: "Exact words" } }, reads: ["entity:{actor}", "entity:{recipient}", "placement:{actor}", "placement:{recipient}"], writes: [],
    timing: { profileId: "explicit-duration", basis: { kind: "explicit_duration", seconds: { kind: "literal", value: 5 }, sourceText: "5 seconds" } }, random: [],
    predicates: [{ id: "reachable", description: "Speech can be heard", sourceIds: ["world"], reads: ["placement:{actor}", "placement:{recipient}"], unknown: "wait",
      test: { kind: "semantic", instructions: "Does the actual speaker address the reachable listener?" } }],
    branches: [{ id: "spoken", when: [{ predicateId: "reachable", equals: "yes" }], acknowledgement: "attempted", outcome: "succeeded",
      description: "The keeper asks a question.", effects: [], deliveries: [{ kind: "speech", recipientParameter: "recipient", text: "{utterance}" }] }] };
  const configured = decisionTestProvider(body => {
    const wire = (body.messages as Array<{ content: string }>).map(message => message.content).join("\n");
    if (wire.includes("Compile a reusable private behavior program")) return encodeProgramDraft(program, { recipient: "traveler" });
    if (wire.includes("You compile authored world sources")) return { definition: rule, parameters: wire.includes("Hello keeper") ?
      { actor: "player", recipient: "keeper", utterance: "Hello keeper" } : { actor: "keeper", recipient: "player", utterance: "Why are you here?" } };
    if (wire.includes("Render the player's submitted action.")) return { utterance: "Hello keeper" };
    if (wire.includes("Choose which actual active goal")) return { answers: { goal: { choice: wire.includes("guard-gate") ? options.reuse ? "p0" : "g0" : "wait" } } };
    const choice = wire.includes("You update an Agent's existing beliefs") ? "unchanged" : wire.includes("actual long-term goal") ? options.goalVerdict ?? "unknown" : options.worldVerdict ?? "yes";
    return { answers: Object.fromEntries(decisionQuestionIds(body).map(id => [id, { choice }])) };
  }, ["world-test", "truth-deepseek", "agent-deepseek"]);
  const roster: Record<string, PolicyBinding> = { keeper: { kind: "model", agentId: "keeper", profiles: world.initialState.agents.keeper!.modelProfiles },
    player: { kind: "external", agentId: "player", participantId: "human" } };
  return { world, configured, roster, program, rule };
}
