import type { DecisionQuestionV2 } from "../models/decision-v2";
import type { ActionFrame } from "./contracts";

export function canHaveWitnesses(frame: ActionFrame): boolean {
  return Boolean(frame.utterance) || ["speak", "transfer", "use", "change", "move"].includes(frame.kind);
}

export const contactPolicy = {
  access: "Judge actual perceptual access using the supplied local placements, barriers and event. For an actor introduced by this event, respect its arrival timing; do not grant knowledge of earlier events.",
  hearing: "Can this recipient hear THESE actually spoken words? Nearby ordinary audible speech or a shout is heard unless established distance, a barrier, whispering, deafness or another concrete circumstance prevents it. Missing names, unfamiliarity, uncertainty about the claim, or not being its addressee do not prevent hearing. Judge hearing only, not whether the recipient will answer, agree or obey. Private thoughts are never spoken words.",
  method: "Can this recipient perceive THIS physical method and its actual effect? Use sight and other available senses, with the established placement, concealment and barriers. Decide perception independently of willingness to respond. Private thoughts and hidden properties are not observable.",
  actorVisibility: "Can THIS recipient see the acting person's public appearance during this event? Judge actual line of sight, placement, light and concealment. Hearing a voice through a barrier does not establish sight; an unfamiliar person standing openly nearby can be seen without knowing their name.",
  relevance: "Should this passive witness reconsider its next action because of THIS perceived event? Consult state.recipientConcerns for its own goals, commitments and current work. Reconsider for a plausible opportunity, threat, changed condition, request involving it or information that could affect those concerns. Uncertainty also means reconsider. Retain without reconsidering only clearly incidental background interaction. This does not decide its action, prevent later initiative, erase memory or grant access to hidden facts. The event's actually observable part is the only new stimulus.",
};

/** Direct interaction is never suppressed by passive-witness relevance. */
export function isPassiveWitness(frame: ActionFrame, recipient: string): boolean {
  return frame.targetEntityId !== recipient && !(frame.utterance && frame.targetEntityId === null);
}

/** Existing and newly admitted actors reference the same shared event and policies. */
export function contactQuestions(frame: ActionFrame, recipient: string, samePlace: boolean) {
  const question = (field: keyof typeof contactPolicy, criteria: Record<string, string>): DecisionQuestionV2 => ({
    type: "choice", version: "direct-contact-2", instructions: {
      task: "Apply state.contactPolicy.access and state.contactPolicy[field]. Resolve actionId in state.actions.",
      field, data: { actionId: frame.id, recipient, samePlace },
    }, criteria,
  });
  return {
    delivery: question(frame.utterance ? "hearing" : "method",
    { delivered: "The actual words or physical method and effect are perceived", unavailable: "No actual perception", unknown: "Perception is uncertain" }),
    actorVisibility: question("actorVisibility",
      { visible: "The recipient can see the actor", hidden: "Only another channel such as sound is available", unknown: "Sight is not established" }),
    relevance: question("relevance",
      { reconsider: "Relevant or uncertain: allow a private decision", retain: "Clearly incidental: remember without a new decision" }),
  };
}
