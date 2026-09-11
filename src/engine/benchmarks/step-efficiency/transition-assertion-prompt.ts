import { loadPromptAsset } from "../../prompts";

const originalUserRule = "Every assertion attached to an outcome, operation, event, or mechanic must already be true against the supplied state at this boundary, so use the current elapsed time rather than a hoped-for future threshold.";
const originalSystemRule = "Every proposed effect must be supported by a relevant action, rule, check, random result, event, fact, or mechanic and by a condition that is true before the write.";

/** Benchmark candidate: align model instructions with the three existing
 * evaluation states without changing assertions, state or kernel validation. */
export function transitionAssertionPrompt(userPrompt: string, system: string) {
  if (userPrompt.split(originalUserRule).length !== 2 || system.split(originalSystemRule).length !== 2) throw new Error("transition assertion prompt drift");
  const rule = loadPromptAsset("shared/transition-assertion-states.md").trim();
  return { userPrompt: userPrompt.replace(originalUserRule, rule),
    system: system.replace(originalSystemRule, "Support every proposed effect with a relevant action, rule, check, random result, event, fact or mechanic. " + rule) };
}
