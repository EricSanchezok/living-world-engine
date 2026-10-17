import type { DecisionQuestionV2 } from "../models/decision-v2";
import type { JsonValue } from "../runtime/json";
import type { ActionFrame } from "./contracts";

export function canHaveWitnesses(frame: ActionFrame): boolean {
  return Boolean(frame.utterance) || ["speak", "transfer", "use", "change", "move"].includes(frame.kind);
}

/** Existing and newly admitted actors use the same hearing and sight judgments. */
export function contactQuestions(frame: ActionFrame, recipient: string, samePlace: boolean) {
  const question = (field: string, criteria: Record<string, string>): DecisionQuestionV2 => ({
    type: "choice", version: "direct-contact-1", instructions: {
      task: "Judge actual perceptual access using the supplied local placements, barriers and event. For an actor introduced by this event, respect its arrival timing; do not grant knowledge of earlier events.",
      field, data: { action: frame as unknown as JsonValue, recipient, samePlace },
    }, criteria,
  });
  return {
    delivery: question(frame.utterance
      ? "Can this recipient hear THESE actually spoken words? Nearby ordinary audible speech or a shout is heard unless established distance, a barrier, whispering, deafness or another concrete circumstance prevents it. Missing names, unfamiliarity, uncertainty about the claim, or not being its addressee do not prevent hearing. Judge hearing only, not whether the recipient will answer, agree or obey. Private thoughts are never spoken words."
      : "Can this recipient perceive THIS physical method and its actual effect? Use sight and other available senses, with the established placement, concealment and barriers. Decide perception independently of willingness to respond. Private thoughts and hidden properties are not observable.",
    { delivered: "The actual words or physical method and effect are perceived", unavailable: "No actual perception", unknown: "Perception is uncertain" }),
    actorVisibility: question("Can THIS recipient see the acting person's public appearance during this event? Judge actual line of sight, placement, light and concealment. Hearing a voice through a barrier does not establish sight; an unfamiliar person standing openly nearby can be seen without knowing their name.",
      { visible: "The recipient can see the actor", hidden: "Only another channel such as sound is available", unknown: "Sight is not established" }),
  };
}
