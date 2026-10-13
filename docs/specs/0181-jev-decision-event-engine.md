# Jev Decision Event Engine

Artifact-Version: 1
Status: Superseded by [0182](0182-jev-direct-world-runtime.md)

## Intent

Replace repeated generative world adjudication with reusable declarative programs, native Jev decisions, event-driven execution and on-demand DeepSeek creation. The user explicitly approved this contract in the implementation request on 2026-10-12. Preserve open natural-language actions, script-driven generality, private cognition, deterministic mechanics and durable evidence. The frozen comparison baseline is Git commit `824125cec21e29ef6ce42c0ac8d7743afb728c15`.

## Contract

### Models and decisions

The gateway exposes creation and decision capabilities. The production decision profile pins `jev-1.13.0` through TypeSafe's native System One API; the creation profile uses `deepseek-flash` with thinking disabled. Accounts resolve credentials from the existing server environment. Credentials never enter requests stored in the Ledger, saved state or browser projections. Each physical request retains its exact body, response, model identity, usage, timing, repair and fallback provenance through the existing execution evidence path.

A DecisionBatch binds one authorized view, immutable question versions, choice domains, program identity and input hash. Results retain the chosen values and complete probability distributions. Independent questions share one view and request; dependent questions run only after their prerequisites. Different Agents never share private decision context. Probabilities are diagnostics, not world randomness. Conditions preserve supported, refuted and unknown. Program nodes own their unknown policy: wait for an identified dependency or request expansion.

Cache identity includes the model/profile binding, program/question/candidate identities and every input dependency version. A changed dependency invalidates reuse. Complete required evidence is never silently truncated. Jev's 32k state-plus-largest-question and 64k combined budgets are enforced conservatively before dispatch. A task that cannot be losslessly separated uses the same typed decision contract through DeepSeek with explicit fallback provenance.

### Programs and creation

ProgramDefinition is immutable and source-bound. ProgramInstance retains parameter bindings, execution position, waiting dependencies, issued work and committed receipts. World rule programs and Agent intention programs occupy separate namespaces and authority scopes. Model-generated programs are declarations interpreted by owned code, never executable JavaScript or direct world patches.

Programs support attempts, conditions, sequence, parallel work, waits and resumable interruption. Mechanical control flow and legal transitions belong to code. Ending a program, satisfying its milestone and completing a persistent Agent goal are distinct decisions. No request, invitation, proposed transfer or promise establishes delivery, consent, ownership or completion without actual evidence.

Initial coverage includes every active goal: a runnable program, an explicit justified wait or required expansion. Unknown actions, strategies and content trigger on-demand creation. One targeted repair is allowed after structural/reference/semantic rejection; exhaustion is recoverable and does not mutate the world. Dialogue that can establish testimony or commitments is generated before adjudication and becomes observable only through actual delivery. Post-commit narration cannot create effects or knowledge.

### World events and commits

A single ordered event journal owns world time. Due activities, private observations, dependency changes, deadlines and authored world timers trigger local work. Connected conflicting actions are adjudicated together; independent components may prepare concurrently. Commits cannot pass an unresolved earlier event. Read-set versions allow reuse across unrelated commits without accepting stale reads.

WorldEventCandidate binds its event, read/write sets, source and decision evidence, declared effects and committed random requests. CanonicalCommitter remains responsible for references, quantities, conservation, authority, causality, time, atomicity, observation provenance and replay. Source-bound decision evidence replaces the requirement for a particular causal-verifier prompt invocation. A declared unsupported effect cannot be admitted by model confidence.

Decision/control records may share a simulation instant; physical world advancement remains positive. Same-input no-progress cycles terminate in recoverable failure. Pending work and its receipts survive restart without duplicate effects. Agent cognition, canonical state and authorized player knowledge remain distinct.

### Persistence and product

World schema is v15, SimulationState v17 and WorldInstance v24. Old saves stay archived without migration or silent producer changes. Each instance pins its complete algorithm, model and admitted program identities. The default is the decision-event engine; replaced runtime implementations are removed after qualification and remain available only from the frozen baseline revision.

Natural-language player input remains the public action interface. Trusted local Inspector includes program position, wake reasons, decisions, expansion causes and cost. Ordinary clients never receive another Agent's private programs, cognition or canonical identity bindings.

## Plan

Implement the native decision gateway and strict program contracts first. Add the interpreter, creation/admission, world-effect materialization and event scheduler. Connect cognition, truth, observation, persistence and Inspector through the new contracts. Change bundled worlds and defaults together, remove replaced paths after verification, and record independently verified units in local commits.

## Verification

Exercise native HTTP through the real gateway with only remote transport replaced. Cover exact choice domains, malformed distributions, unknown, context overflow, cancellation, rate limits, credentials, usage and request evidence. Program tests cover completion versus receipt, unsupported effects, source invalidation, unknown waits, loops, parallel work, interruption, restart and replay. World tests cover deception, refusal, private knowledge, shared resources, deadlines and fixed random commitments through real import, WorldHost, commit and reload entry points.

Run relevant tests and `npm run check:fast` for every independently committable unit. Use the full 49-subject Blackmarsh tasks and a station repair/resource-exchange fixture. Compare A (frozen engine), B (new engine with DeepSeek decisions) and C (new engine with Jev decisions). Start with three canary groups, then confirmation. Freeze task inputs, acceptance, source and model bindings before inference; include failures, retries, repairs, rejected candidates, cold compilation and creation cost.

Qualification targets are at least 80% Jev runtime physical requests, at least 80% fewer DeepSeek requests than A, at least 70% lower cost per successful task, at least 50% lower median useful-feedback latency with non-regressing P95, and at least 90% independent task completion without regression against A. Extra decision calls cannot inflate the Jev share. Mechanical, cognitive-isolation and replay checks must all pass. Censored baselines do not yield speedup ratios. Further live calls share a cumulative CNY 100 ceiling including planning probes; incomplete evidence remains unqualified.

## Evidence

Native decision and creation capabilities, private programs, world rule compilation, source-bound commits, event scheduling, persistence, Inspector and the v15/v17/v24 contracts are implemented. Ordinary WorldHost creation selects decision-event@7 with pinned script capability profiles; deterministic integration covers actual creation, advancement, restart and offline replay. The full fast gate passed 2283 tests across 369 files. [Live entry evidence](../research/2026-10-13-jev-runtime-entry-evidence.md) records a conserved station resource transfer, incomplete repair goals and provider connection failures during the latest full-world startup. [Qualification evidence](../research/2026-10-13-jev-engine-qualification.md) retains failed and censored A/B/C results, unexecuted trials, actual model counts and all budget reservations; the targets have not passed. Retirement of the explicitly registered reference execution chain remains pending qualification. [Decision 0227](../decisions/0227-jev-decision-event-engine.md) owns the architecture choice. The prior [repair validation report](../research/2026-09-22-step-e3-repair-validation.md) owns historical full-world costs and failure evidence; planning probes do not establish production qualification.
