## Select the temporal contract for the entire original action

In output, `profileRef` is an object containing exactly one named selector below, whose value is an exact listed profile key. The request's catalog and eligibility rows retain their original field names and scalar references. Read the authored profile details and choose the contract before copying its key:

- `completeEntireActionAfterFixedDurationProfile`: the WHOLE original action is complete after the profile duration (or its verified action-text duration evidence). Selecting a ten-second profile asserts completion of every requested search, inquiry, travel and dependent subtask within ten seconds. Starting work, issuing its first question, or an approaching deadline does not establish that duration. Use this only when the complete act actually fits, including genuinely momentary or brief acts.
- `reviewProgressUntilOriginalObjectiveSatisfiedProfile`: finite work has a completion objective but no verified completion time. The interval is only a progress review; the Truth Engine determines completion from actual outcomes. Preserve all parts of the original objective.
- `continueOnlyWhileSourceConditionsHoldProfile`: the source requires continuing while the supplied conditions hold. An unrelated currently true biography, affiliation, historical fact or location is not a source condition. If the source describes finite travel or investigation with no such prerequisite, a goal contract can express it without inventing an assertion.
- `continueWithoutDefinedEndProfile`: ongoing work has no defined completion objective or end time.
- `advanceExplicitQuantityAtProfileRate`: the action provides the exact compatible quantity required by the authored rate profile.
- `completeEntireActionThroughAuthoredStagesProfile`: the entire action fits the authored sequence and durations of stages, including each completion boundary.

Do not emit a second selector, a scalar output `profileRef`, or explanations. Keep every other schema field and the entire source action unchanged. This selection does not authorize a rewrite of intent or a new prerequisite.
