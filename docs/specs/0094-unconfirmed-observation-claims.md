# Unconfirmed observation claims

Artifact-Version: 1
Status: Approved

## Intent

Offer an explicit model-output branch for an unresolved perception without changing the public observation or belief value contracts. A statement that evidence does not establish a proposition must not be encoded as Boolean false or known absence.

## Contract

An opt-in source-bound observation candidate uses a tagged physical claim union. The asserted branch contains every existing claim field and an explicit asserted tag. The unconfirmed branch contains the same subject reference and predicate, a model-authored description of the unresolved proposition, and the unconfirmed tag; it cannot contain a value. No engine code classifies natural-language descriptions or changes an existing Boolean decision.

Mechanical materialization removes the asserted tag and otherwise preserves that branch exactly. For an unconfirmed claim, its canonical value is text and its description is the same text: the fixed label `尚未确认：` followed by the complete model-authored description. The label renders the model-selected branch; it is not a magic value or a downstream parsing protocol. The model-visible contract declares this mapping before generation. This preserves an unresolved proposition as language, not a Boolean or a fabricated canonical fact. Raw tagged output remains in the existing request/response audit. Canonical observations, belief schemas, game routes and saves retain their current shape.

Every original claim value remains expressible through the asserted branch. All actions, contexts, candidate references, summaries, introductions and event references remain complete. Existing schema constraints apply inside each branch, and canonical Zod validation, reference materialization, cognitive isolation and final candidate review still apply after decoding. Missing tags, an unconfirmed value, mixed branch fields or malformed records fail instead of receiving defaults. Decoding never infers a tag from prose, drops a claim, assigns an actor, or changes an asserted false into unknown.

The encoding is separately pinned in the experimental Composition and prompt identity and is applied below physical observation batching, after the evidence layout. Repairs use the same current encoding and source binding. No extra model request, thinking, critic, action reduction or context truncation is introduced. Defaults remain unchanged. The canonical asserted encode/decode round trip is exact; the unconfirmed branch is an explicit text materialization, not a claim of a bijection between wire annotations and canonical text.

## Plan

Implement the strict claim union and decoder, add the experimental configuration, and verify canonical round trips, uncertainty text materialization and real HTTP decoding. Freeze complete-body diagnostics against original and controlled source inputs before measuring model behavior. A new output branch is a hypothesis about failure reduction, not a proof that models select it correctly.

## Verification

Exercise true, false, absence, text, numeric and local-entity values; multiple claims and observers; complete original prose; empty arrays; unconfirmed propositions; contradictory extra values; malformed tags; and schema drift. Verify no calls for decoding and unchanged canonical validation and real renderer materialization. Run focused tests and check:fast before committing. Paid review separately checks event support, access, intended versus realized action and whether the model still asserts false for an unresolved proposition.

## Evidence

The [encoding](../../src/engine/mechanics/observation-claim-encoding.ts) owns the model-output union and its [tests](../../src/engine/mechanics/__tests__/observation-claim-encoding.test.ts) verify the mechanical boundary. [Decision 0155](../decisions/0155-explicit-unconfirmed-observation-branch.md) records the representation choice. [Spec 0093](0093-evidence-first-observation-layout.md) owns the retained evidence layout.
