# Decision log

Every durable choice with meaningful alternatives—architecture or process—lives in this directory. Specs own risk-boundary change contracts; decisions preserve rationale; commits own change history.

## Format

Records use MADR (Markdown Any Decision Records) with the documented `Class:` extension. A record is named `NNNN-title.md` directly in this directory. Numbers are sequential, zero-padded to four digits, and never reassigned.

### Required sections

Every record contains these `##` sections in order:

1. `## Status`
2. `## Context and Problem Statement`
3. `## Decision Drivers`
4. `## Considered Options`
5. `## Decision Outcome`
6. `## Pros and Cons of the Options`
7. `## Links`

`## Links` may contain `None.` but must exist. Additional sections may follow it.

### Status and Class

The first non-empty line below `## Status` is `Proposed`, `Accepted`, `Rejected`, `Deprecated`, or `Superseded by [NNNN](NNNN-title.md)`. A shipped record describes current or frozen reality and is never rewritten into its opposite; create and cross-link a successor instead.

An optional adjacent `Class:` line uses `architecture`, `process`, `testing`, `feature`, `bug-fix`, or `simplification`.

## Writing rules

- Create or update a decision only when a change chooses among meaningful alternatives and future maintainers may revisit the rationale. Do not use decisions for routine implementation, mechanical refactors, obvious test-defined fixes, feature contracts, or commit history.
- State the choice, what it beats, and what it gives up. List genuine alternatives and why the selected option won.
- Cite material external evidence with a stable descriptive link in `## Links`.
- Cross-reference records with relative Markdown links, never bare numbers.
- Describe the live contract. Change stories belong to commits; risk-boundary behavior belongs to [Specs](../specs/README.md).

`scripts/verify-decisions.mjs` enforces naming, numbering, section order, statuses, classes, and supersession targets. The manifest-selected runner invokes it.

## Index

- [0000 — Use Markdown Architectural Decision Records](0000-use-markdown-architectural-decision-records.md)
- [0001 — Repo-seed Is a Skill, Not a Template](0001-repo-seed-is-a-skill-not-a-template.md)
- [0002 — Self-governing Repository Design](0002-self-governing-repository-design.md)
- [0003 — Instantiate Repo-review per Project](0003-repo-review-instantiated-per-project.md)
- [0004 — Game-first Principles](0004-game-first-principles.md)
- [0005 — Script Format v1](0005-script-format-v1.md)
- [0006 — Engine Mechanics Modules](0006-engine-mechanics-modules.md)
- [0007 — Engine Runtime](0007-engine-runtime.md)
- [0008 — Engine Completeness](0008-engine-completeness.md)
- [0009 — Documentation and Agent Notes](0009-documentation-and-agent-notes.md)
- [0010 — Import Staging Cleanup](0010-import-staging-cleanup.md)
- [0011 — Layout and Presentation Tokens](0011-layout-and-presentation-tokens.md)
- [0012 — UI Theme Assets and Multiple Scripts](0012-ui-theme-assets-multiscript.md)
- [0013 — Adopt Repo-seed Governance Layer](0013-adopt-repo-seed-governance-layer.md)
- [0014 — LLM Context Management](0014-llm-context-management.md)
- [0015 — Memory Strength and Retrieval](0015-memory-strength-retrieval-supersede.md)
- [0016 — Dead Contract Wiring and UI Consumption](0016-dead-contract-wiring-and-ui-consumption.md)
- [0017 — Session Persistence and Refresh Recovery](0017-session-persistence-refresh-recovery-meta.md)
- [0018 — Immersive Frontend Script Code v2](0018-immersive-frontend-script-code-v2.md)
- [0019 — Semantic Enums to Free Text](0019-semantic-enums-to-free-text.md)
- [0020 — Post-merge Audit and Single-home Injection](0020-post-merge-audit-single-home-injection.md)
- [0021 — Gameplay and Engine Extension v2](0021-gameplay-and-engine-extension-v2.md)
- [0022 — UI Host and Script Extension v3](0022-ui-host-and-script-extension-v3.md)
- [0023 — Layout, Theme, and Accessibility v2](0023-layout-theme-and-accessibility-v2.md)
- [0024 — Frontend Workbench and CI](0024-frontend-workbench-and-ci.md)
- [0025 — Emberfall Industrial Folk Mystery](0025-emberfall-industrial-folk-mystery.md)
- [0026 — Starlight Shift Console](0026-starlight-shift-console.md)
- [0027 — Session-first UI API v4](0027-session-first-ui-api-v4.md)
- [0028 — Conversation-first Game Layout](0028-conversation-first-game-layout.md)
- [0029 — ReUI App Shell and UI API v5](0029-reui-app-shell-and-ui-api-v5.md)
- [0030 — Manus-style Game Workspace and UI API v6](0030-manus-style-game-workspace-and-ui-api-v6.md)
- [0031 — Epistemic Multi-Agent Truth Engine](0031-epistemic-multi-agent-truth-engine.md)
- [0032 — Open-world Facts and the d20 Kernel](0032-open-world-facts-and-d20-kernel.md)
- [0033 — Persistent Streaming World Runs](0033-persistent-streaming-world-runs.md)
- [0034 — Truth Engine Verification Matrix](0034-truth-engine-verification-matrix.md)
- [0035 — Truth Engine Hardening and Verifiable Audit](0035-truth-engine-hardening-and-verifiable-audit.md)
- [0036 — Multi-provider Model Gateway and Fair Scheduler](0036-multi-provider-model-gateway-and-fair-scheduler.md)
- [0037 — Agent Evolution, Self-awareness, and Reaction Window](0037-agent-evolution-self-awareness-and-reaction-window.md)
- [0038 — Rename the Project to Living World Engine](0038-project-rename-to-living-world-engine.md)
- [0039 — Pinned World Runtime Contract](0039-pinned-world-runtime-contract.md)
- [0040 — Resumable Player Intent](0040-resumable-player-intent.md)
- [0041 — Local SQLite Runtime](0041-local-sqlite-runtime.md)
- [0042 — Causal Assurance and Staged Model Profiles](0042-causal-assurance-and-staged-model-profiles.md)
- [0043 — End-to-end Runtime Observability](0043-end-to-end-runtime-observability.md)
- [0044 — Local Assistant UI Immersive Session Shell](0044-local-assistant-ui-immersive-session-shell.md)
- [0045 — Versioned Reference World Projects](0045-versioned-reference-world-projects.md)
- [0046 — Committed Discrete Random Distributions](0046-committed-discrete-random-distributions.md)
- [0047 — On-demand Model-provider Credentials](0047-on-demand-model-provider-credentials.md)
- [0048 — Engine-owned Runtime Identities](0048-engine-owned-runtime-identities.md)
- [0049 — World Run Failure and Stream Boundaries](0049-world-run-failure-and-stream-boundaries.md)
- [0050 — Development-default Full Observability](0050-development-default-full-observability.md)
- [0051 — Assistant UI Upstream Session Surface](0051-assistant-ui-upstream-session-surface.md)
- [0052 — Persistent Game Context and World Library](0052-persistent-game-context-and-world-library.md)
- [0053 — Context-local Settings Overlays](0053-context-local-settings-overlays.md)
- [0054 — Composer Focus and Intrinsic Player Bubbles](0054-composer-focus-and-intrinsic-player-bubbles.md)
- [0055 — Trusted World-evolution Inspector](0055-trusted-world-evolution-inspector.md)
- [0056 — Control State and Settings Grouping](0056-control-state-and-settings-grouping.md)
- [0057 — Failure-aware World Inspector](0057-failure-aware-world-inspector.md)
- [0058 — Timely Gated Local Commits](0058-timely-gated-local-commits.md)
- [0059 — Unified Execution Kernel and Ledger](0059-unified-execution-kernel-and-ledger.md)
- [0060 — Model-output Field Ownership](0060-model-output-field-ownership.md)
- [0061 — Unified Agent and External Policy](0061-unified-agent-and-external-policy.md)
- [0062 — World Instance Participation and ActionWindow](0062-world-instance-participation-and-action-window.md)
- [0063 — Eager-reference Execution](0063-eager-reference-execution.md)
- [0064 — Conversation Core and Agent-perspective Observer](0064-conversation-core-and-agent-perspective-observer.md)
- [0065 — Platform Visual Baselines and Deterministic Layout](0065-platform-visual-baselines-and-deterministic-layout.md)
- [0066 — Upgrade to Progressive Repo-seed Governance](0066-upgrade-progressive-repo-seed-governance.md)
- [0067 — Open Semantic Resolution Plans](0067-open-semantic-resolution-plans.md)
- [0068 — Unified Agent Perspective](0068-unified-agent-perspective.md)
- [0069 — Blobatar World Spirit](0069-blobatar-world-spirit.md)
- [0070 — Event-boundary Temporal Runtime](0070-event-boundary-temporal-runtime.md)
- [0071 — Pin Algorithms and Own Stable Telemetry in the Engine](0071-pin-algorithms-and-own-telemetry-in-the-engine.md)
- [0072 — Seed Bundled Reference Worlds](0072-seed-bundled-reference-worlds.md)
- [0073 — Stage Perceptible Reactions Before Temporal-boundary Selection](0073-stage-reactions-before-temporal-boundary-selection.md)
- [0074 — Enforce Script-owned Shared-resource Pools in the Canonical Kernel](0074-enforce-script-owned-shared-resource-pools.md)
- [0075 — Pin Configured Execution Algorithms](0075-pin-configured-execution-algorithms.md)
- [0076 — Resolve Models from Audited Capability Snapshots](0076-resolve-models-from-audited-capability-snapshots.md)
- [0077 — Organize Engine Code by Ownership Boundaries](0077-engine-module-topology.md)
- [0078 — External Prompt Bundles](0078-external-prompt-bundles.md)
- [0079 — Truth Engine 输出修复边界](0079-truth-engine-output-repair-boundaries.md)
- [0080 — Conversation Timeline Rail and Stateful Composer](0080-conversation-timeline-rail-and-stateful-composer.md)
- [0081 — Selective Admission Reuse and Stage Overlap](0081-selective-admission-reuse-and-stage-overlap.md)
- [0082 — Truth Engine Fixed Slot Batching](0082-truth-engine-fixed-slot-batching.md)
- [0083 — Qwen Campus Model Profile](0083-qwen-campus-model-profile.md)
- [0084 — Account-scoped Node Network Binding](0084-account-scoped-node-network-binding.md)
- [0085 — World Inspector Hierarchical Selection](0085-world-inspector-hierarchical-selection.md)
- [0086 — Model Semantic Contract and Reference Boundaries](0086-model-semantic-contract-and-reference-boundaries.md)
- [0087 — Bounded Action Compilation Context](0087-bounded-action-compilation-context.md)
- [0088 — Action Compilation Candidate-Key Protocol](0088-action-compilation-candidate-key-protocol.md)
- [0089 — World Inspector Staged Debugging and Replay](0089-world-inspector-staged-debug-and-replay.md)
- [0090 — Model Reliability Optimization and Local Transparency](0090-model-reliability-optimization-and-local-transparency.md)
- [0091 — AgentMind Slot Context and Bounded JSON Recovery](0091-agentmind-slot-context-and-bounded-json-recovery.md)
- [0092 — Agent-Native Debug Query Projections](0092-agent-native-debug-query-projections.md)
- [0093 — World Inspector Summary-first Information Hierarchy](0093-world-inspector-summary-first.md)
- [0094 — Action Compilation Candidate-Key Length](0094-action-compilation-candidate-key-length.md)
- [0095 — Probe-overlay Counterfactual Replay](0095-probe-overlay-counterfactual-replay.md)
- [0096 — Versioned Behavioral Benchmark Datasets](0096-versioned-behavioral-benchmark-datasets.md)
- [0097 — Action Compilation Graph-aware Candidate Retrieval](0097-action-compilation-graph-retrieval.md)
- [0098 — Content-addressed Embedding Cache and Immutable Canary Enrollment](0098-content-addressed-embedding-cache-and-immutable-canary-enrollment.md)
- [0099 — Typed Hierarchical Algorithm Composition](0099-typed-hierarchical-algorithm-composition.md)
- [0100 — Promote Relational RRF and Refresh Reference Data](0100-promote-relational-rrf-and-refresh-reference-data.md)
- [0159 — Isolate Local Encoder Inference from the Host Event Loop](0159-isolate-local-encoder-inference.md)
