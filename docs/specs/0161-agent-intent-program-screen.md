# Agent Intent Program Screen

Artifact-Version: 1
Status: Approved

## Intent

Test a decision-time source representation instead of reconstructing execution structure from a historical compound action. The [action-phase graph screen](0160-action-phase-graph-screen.md) isolates the latter approach. This screen retains the [complete-player objective](0122-player-action-efficiency.md) and compares new autonomous choices under complete private evidence; historical action text is not a semantic gold answer.

## Contract

The experimental AgentMind producer returns the existing ordered targetHandles and one rooted intent program. Attempts retain unrestricted natural-language text. Sequence, parallel, if, while and await nodes express control flow; conditions remain untrusted natural-language conditions, not executable world predicates. Node references form one reachable tree with unique IDs, no cycles and no shared children. Target indices refer only to that action's ordered targetHandles and every listed target must be used in an attempt or condition. Existing AgentMind target resolution, slot ownership, private evidence, belief/character validation and source identity remain authoritative.

The decoder embeds the entire program as a version-marked JSON string in canonical rawText and goal, with means null and the original ordered targets. It neither selects a shorter action nor discards future branches, repetition or waiting. The serialized program can be recovered exactly; index meaning travels with the action's existing ordered targets. This is a new producer contract and an isolated canonical embedding, not an equivalent rewrite of historical three-field actions or a promoted persistence format. No default runtime, external player input, Truth adjudicator or world scheduler adopts the representation.

Initial inspection descends into the first sequence child and every parallel child, returning an attempt or a condition to evaluate. It never declares a condition true, skips a wait, completes an attempt or chooses a branch. Agent intentions do not establish world facts, another subject's cooperation, delivery or physical arrival. Source review distinguishes irrational or unsupported assumptions from legal new choices and deliberate uncertainty.

## Plan

Use the complete six original bootstrap batches of eight subjects each. B uses the single-text producer; C uses intent programs. Preserve each original private context, all non-action schema fields and canonical validators. Freeze twelve alternating primary-only HTTP calls with official deepseek-flash and thinking disabled. Block retries and semantic repair before network, retain the rejected output and actual recovery demand, and stop later dispatch if usage or audit is missing. No world commits, new RNG, critic calls or batch reductions are part of the screen. The forty-eight autonomous subjects are the original cohort; a successful bootstrap is not a forty-nine-subject player action.

Preflight both arms through real AgentMind with explicit synthetic transport fixtures derived from the six original successful replies. B places every historical action text into one full text; C places that same complete text in one attempt node, preserving original targets and private patches. These fixtures verify the embedding and materializer, not semantic quality or actual model success. B's physical requests must also match the prior single-text treatment. Freeze source, program contract, runner, fixtures and physical requests before inference. Review all generated candidates against their own current situations, including conditional speech, delegated work, absent participants and source-supported private cognition. Record changed output cost and any extra downstream interpretation required before considering integration.

## Verification

Exercise the real AgentMind and gateway with only external HTTP replaced. Verify nested sequence/parallel/conditional/repeating intentions, exact reversible embedding, original private patches and local target ownership, all nodes reachable, no cycle/shared child, no invalid index or unused selected target, rejection of legacy action fields, and immutable source state. Verify initial inspection never evaluates conditions or settles actions. Run focused checks and check:fast before a local commit and paid freeze.

## Evidence

[Producer tests](../../src/engine/benchmarks/step-efficiency/agent-intent-program.test.ts) own engineering evidence. [Decision 0207](../decisions/0207-generate-structured-intentions-at-decision-time.md) owns alternatives and the high-level-program connection.
