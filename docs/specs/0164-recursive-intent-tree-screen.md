# Recursive Intent Tree Screen

Artifact-Version: 1
Status: Approved

## Intent

Test whether nested source intentions remove graph-reference and target-index bookkeeping without weakening the [intent-program contract](0161-agent-intent-program-screen.md). This prerequisite screen serves the [complete-player objective](0122-player-action-efficiency.md), including all forty-eight autonomous subjects and the separate external player in eventual integration.

## Contract

The producer chooses a recursive program directly. Attempt, sequence, parallel, if, while and await retain the same meanings as the indexed program. Child values are embedded nodes; attempt and condition nodes carry their own original local targetHandles. There is no separately authored node ID, root ID, child reference or action-level target list. Code traverses the complete tree in preorder, assigns node IDs and interns local targets in first-occurrence order. It then invokes the existing indexed-program decoder and canonical AgentMind validators. Every branch, condition, exact text and ordered leaf target list survives lowering and reconstruction. A malformed or foreign target remains a model-owned rejection with complete raw-output and billable audit evidence.

Tree nesting eliminates graph cycles, missing child IDs and unreachable nodes from JSON-representable inputs. Target interning eliminates unused action-level targets; it does not delete chosen work or infer a referent. Repeated targets in different leaves share an action-level entry. Duplicate target occurrences within a leaf retain the existing rejection. Conditions remain unevaluated natural language. A structurally valid tree can still hide work inside conditions, contradict its ordering, assume delivery or choose an unsupported action; the screen confers no executable or semantic authority on it.

The indexed program is an internal diagnostic embedding. The producer does not change default cognition, perception, world scheduling, persistence or external-player input. It does not select one short leaf in place of the full chosen plan, establish physical effects, or evaluate a guard.

## Plan

Compare the exact indexed-program request from the complete twelve-request preflight of the earlier source-program screen as B against the recursive producer as C. Freeze six original eight-subject private contexts and twelve alternating primary-only requests using official deepseek-flash with thinking disabled. The earlier interrupted paid run is not resumed or filled in. Preserve every non-action field, all source contexts and canonical validators. Block repair and retry before HTTP, stop later dispatch on missing billable audit, and retain every actual first response. No critic, new RNG or world commit is permitted in this screen.

Preflight complete historical text fixtures as one attempt in both representations through the real gateway and AgentMind. Verify exact B physical requests, complete program reconstruction and unchanged historical cognition/targets before paid dispatch. Review each actual candidate's full tree and its own private source before downstream qualification, explicitly checking condition-versus-work, sequential-versus-parallel meaning, absent addressees and compound leaf boundaries. Report structural failures, semantic counterexamples, node/frontier coverage, token/cache/call costs and the limits of this bootstrap screen. Zero structural rejection alone does not justify integration or a full-player success claim.

## Verification

Test nested concurrent and sequential work, while, if with both branches, and waiting. Verify inverse lowering, exact text, local target order, duplicate leaf target rejection and original private-state immutability. Exercise valid and foreign-target results through actual AgentMind and gateway, and malformed trees through the rejected-output audit boundary. Verify recursive wire-schema references resolve from the complete request document, not an isolated subtree. Run relevant checks and check:fast before a local commit and paid freeze.

## Evidence

[Producer tests](../../src/engine/benchmarks/step-efficiency/agent-recursive-intent.test.ts) own engineering evidence. [Decision 0210](../decisions/0210-compile-nested-intentions-to-indexed-programs.md) records alternatives and the limited AST-generation connection.
