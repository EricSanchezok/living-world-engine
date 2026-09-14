import { expect, it } from "vitest";
import { observedExternalInterruptions } from "../observed-activity-interruptions";

it("follows current causal ancestors without treating clock, own progress or unwitnessed work as external stimuli", () => {
  const evidence: Parameters<typeof observedExternalInterruptions>[0] = {
    actions: [{ id: "a", actorId: "actor-a" }, { id: "b", actorId: "actor-b" }],
    requests: [{ id: "check", causes: [{ kind: "action", id: "a" }] }],
    randomRequests: [{ id: "random", causes: [{ kind: "check", id: "check" }] }],
    proposal: {
      mechanicInvocations: [{ id: "mechanic", causes: [{ kind: "random", id: "random" }] }],
      events: [
        { id: "clock", causes: [{ kind: "law", id: "time" }] },
        { id: "own", causes: [{ kind: "action", id: "b" }] },
        { id: "external", causes: [{ kind: "mechanic", id: "mechanic" }] },
        { id: "derived", causes: [{ kind: "event", id: "external" }, { kind: "event", id: "derived" }] },
      ],
      observations: [
        { observerId: "actor-a", sourceEventIds: ["derived"] },
        { observerId: "actor-b", sourceEventIds: ["clock", "own"] },
        { observerId: "actor-c", sourceEventIds: ["derived"] },
        { observerId: "actor-d", sourceEventIds: [] },
        { observerId: "actor-e", sourceEventIds: ["missing"] },
      ],
    },
  };
  expect([...observedExternalInterruptions(evidence)]).toEqual(["actor-c"]);
});
