# Unmatched Closing Delimiter Recovery Experiment

Artifact-Version: 1
Status: Approved

## Intent

Under the user's autonomous [non-thinking gameplay experiment](0029-nonthinking-gameplay-efficiency-experiment.md), test whether strictly limited local syntax recovery can avoid whole-batch model repairs for repeated unmatched closing delimiters. This authorization adds no budget and does not promote a runtime default or reinterpret historical failures.

## Contract

The experimental recovery may delete only a closing brace or bracket that does not match the most recently opened, still-unclosed container, outside JSON strings. It may not delete a matching closer, an opener, a separator, any field or value, or a closer outside the single root. It never inserts characters, changes references, chooses effects, fills missing fields, combines roots or salvages descendants. At most 128 such deletions are allowed; exceeding the limit rejects the entire recovery rather than truncating output.

The surviving complete text must parse as one strict JSON object or array and contain no duplicate object keys, including escaped spellings of the same key. Missing opening/closing structure, incomplete strings, trailing content and remaining syntax errors reject this candidate. Retain the original response, exact deletion offsets, recovered-text hash and recovery policy identity. This is a declared syntax interpretation of malformed text, not proof of the model's intended semantics.

Existing parser behavior remains the baseline. Runtime integration is explicitly selected and exposes its recovery disposition. Strict parsing and existing complete top-level corrections retain precedence. The restricted candidate then runs before broad syntax repair, because broad repair can invent an extra slot or return a fragment with a different root shape. If the restricted candidate declines, existing broad recovery remains available as a separately identified legacy interpretation; the new candidate's guarantees do not claim to describe that legacy branch. Recovered values still pass the same wire codec, canonical schema, slot/action coverage, reference permissions, materializer and semantic checks. Invalid references or factor sources cannot become successful through syntax recovery. The model, thinking setting, full context, root cardinality, generation and repair ceilings remain unchanged.

## Plan

First implement and test the isolated recovery candidate. Replay immutable failures through the real admission path, replacing only the model boundary, and distinguish actual historical outcomes from counterfactual results. Verify the replay provider's rejection semantics against the real adapter. Freeze any prospective comparison and source-semantic review before new paid requests; full-world admission and acceptance remain owned by the encompassing experiment.

## Verification

Test nested mixed containers, repeated errors, escaped quotes and delimiter characters inside strings. Reject duplicate keys, missing fields or openers, unmatched root suffixes, concatenated values, incomplete responses and cases requiring a matching closer to be removed. Assert exact preservation of all non-deleted source characters and unchanged valid JSON behavior. Test through actual schema/materializer and scoped slot recovery; successful parsing alone is insufficient. Run relevant tests and `npm run check:fast` before each local commit.

## Evidence

The existing experiment evidence owns immutable raw responses and prospective trial manifests. [Decision 0122](../decisions/0122-limit-unmatched-closer-recovery.md) owns the restricted grammar interpretation and alternatives. Runtime deployment remains separately gated by source-bound semantics and complete-world execution.
