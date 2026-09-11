# Share rejected cause domains in planning diagnostics

Artifact-Version: 1
Status: Approved

## Intent

Prevent diagnostic amplification from making a recoverable planning error exceed the model context window. This model-visible experiment is covered by the continuing autonomous full-step optimization authorization and uses the existing budget. Its approval does not certify semantic preservation by the model or gameplay latency.

## Contract

The opt-in planning catalog representation uses a new version that pools repeated rejectedDomain arrays inside repair evidence after physical batching. Every complete historical domain remains visible once, with its content hash. Each original occurrence has an explicit reference and registered source path. The decoder restores all original arrays, including their ordering and slot memberships, and checks the complete original state hash. Current legal choices, previous outputs, diagnostic reasons, issue paths, and originalValue evidence remain complete. Pool membership never authorizes a current selection or changes an old index's meaning.

Only repeated diagnostic arrays are factored; ordinary world state and non-repair fields are not candidates. Unique or uneconomical domains remain inline. A missing, changed, duplicate or mismatched reference fails reconstruction. No diagnostic is accepted as a world operation, no invalid cause is repaired mechanically, and the canonical output schema and validators remain unchanged. Raw requests and responses remain in the Ledger. Existing historical records are preserved rather than regenerated.

The representation is pinned by the planning catalog setting, prompt asset hash, and code revision. Defaults remain unselected. The provider introduces no additional model call, dropped action, reduced batch size, changed thinking setting or larger context allowance. A frozen failing request must pass exact reconstruction and actual complete-body token admission before a paid diagnostic begins.

## Plan

Add one reversible diagnostic-domain codec at the existing planning catalog adapter. Provide its decoding instruction and test the real physical batch and HTTP path. Reconstruct the stopped request, measure its complete token count, then freeze a fresh diagnostic and record the result in the existing work log.

## Verification

Cover repeated and distinct old domains, narrowed repair, changed current candidate scope, malformed references, domain and state drift, non-repair collisions, and unsupported roles. Preserve neighboring valid output and rejected output validation through the real gateway. Run relevant tests and check:fast before committing. Report representation savings separately from model correctness and complete action-to-feedback latency.

## Evidence

The [cause codec](../../src/engine/mechanics/source-indexed-plan-causes.ts) owns historical index evidence. The [planning adapter](../../src/engine/mechanics/planning-catalog-encoding.ts) owns this optional input layout. [Decision 0160](../decisions/0160-share-complete-rejected-domains.md) records why complete sharing is preferred to dropping diagnostics or extending limits.
