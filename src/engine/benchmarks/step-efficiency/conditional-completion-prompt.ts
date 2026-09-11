import { loadPromptAsset } from "../../prompts";

const originalBoundaryRule = 'For fixed, rate and staged Activities, an active Activity must remain continuing until its trusted scheduled completion boundary, unless supported failure or blockage ends it; a completed scheduled boundary must settle with a non-continuing outcome; retain exactly one outcome during repair.';

/** Benchmark candidate only; retain exact task/state/schema outside this rule. */
export function conditionalCompletionPrompt(userPrompt: string): string {
  if (userPrompt.split(originalBoundaryRule).length !== 2) throw new Error("conditional completion prompt boundary drift");
  return userPrompt.replace(originalBoundaryRule, loadPromptAsset("shared/conditional-completion.md").trim());
}
