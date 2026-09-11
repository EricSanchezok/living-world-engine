# Private scalars and record keys became global bans

Artifact-Version: 1

## Executive summary

Observation validation confused equality of ordinary words with disclosure of private information. The earlier local-alias correction left this assumption in private fact values and cognition record keys, while a regression test preserved the incorrect behavior.

## Summary

The complete 49-observer observation dictionary experiment produced ten logical information-boundary rejections. Nine responses used `in-progress`, which also occurred in two unrelated private operation-state facts. One used `preservation` inside its own activity description, colliding with another Agent's character-value key. One of the nine responses additionally contained a protected canonical identifier. The first two collisions do not establish disclosure; the additional identifier remains independently rejected.

Both experiment arms also contained separate source-semantic errors, including an unsupported reply to a player's lodging inquiry, a future inspection narrated as complete, and an event attributed to the wrong action. Mechanical observation acceptance does not resolve those errors.

## Timeline

- The source execution is `3e8bc6ea-e5b2-46b4-8bab-5c66fc2cea78`, instance `4140b64c-b980-4c7d-9737-205fb55224e4`, Ledger sequences 139–760. The observation input imports the immutable candidate from the bounded `review-repair-01` diagnostic.
- `observation-dictionary-01` recorded five actual HTTP calls per arm, ten total. The candidate arm stopped before repair HTTP; all original outputs, audits and logical failures remain preserved.
- Direct evaluation of the original guard against the actual post-proposal state identified the private sources of the matched words. Source review found the test requiring private text `hold` to reject `households`.
- New positive and negative source-relation tests produced eleven failures in the old implementation. The correction uses typed cognition references and explicit private fact relations under execution producer version 20.
- An offline counterfactual replay matched all five physical requests and normalized outputs in each arm, including their original audits. Baseline observations passed without issues. Candidate observations retained one original protected-identifier rejection; the renderer returned a fallback for that observer after two blocked repair requests. This is 48 first-pass candidate observations plus one fallback, not 49 first-pass successes. No HTTP or world-state persistence occurred, and historical results were not rewritten.

## Root cause

The guard represented private scalar values and bare private record keys as globally owned tokens. Equality of `in-progress` did not identify which subject had which status. Character keys also lacked their model-reference type. The [earlier alias incident](0055-private-aliases-became-global-vocabulary-bans.md) corrected only owner-qualified local references and explicitly retained the other token classes. Tests checked the implementation's vocabulary ban instead of testing independence from unrelated private state.

The same value-only rule could miss explicit numeric, Boolean or entity-valued private relationships. Treating a literal screen as a complete information-flow policy therefore produced both false positives and incomplete coverage.

## Guardrails

The [source-scoped disclosure contract](../specs/0123-source-scoped-observation-disclosure.md) and [source-relation decision](../decisions/0172-check-private-information-by-source-relation.md) define the correction and its limits. The [public-boundary tests](../../src/engine/cognition/__tests__/information-boundary.test.ts) cover ordinary text under unrelated hidden changes, typed foreign references, complete private descriptions, exact fact relationships across all value types, subject and predicate discrimination, known and authorized facts, new bindings and ambiguity. The [renderer regression](../../src/engine/cognition/__tests__/observation-renderer.test.ts) verifies single-call materialization of ordinary progress and retains real copied-description repair.

The deterministic guard cannot establish the correctness of paraphrases, uncertainty, action completion or narrative attribution. The [full player acceptance contract](../specs/0122-player-action-efficiency.md) remains required; this correction does not establish a 60-second action or continuous playable world.
