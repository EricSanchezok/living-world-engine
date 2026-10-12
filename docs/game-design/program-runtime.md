# Decision and behavior program runtime

[Spec 0181](../specs/0181-jev-decision-event-engine.md) defines the replacement engine contract. The program runtime lives in `src/engine/programs/` and runs through the default registered decision-event producer.

## Private program boundary

`ProgramDefinition` is a declarative, immutable private plan. It binds one Agent, actual goal IDs, original source hashes, typed parameters, resource read/write declarations, start and interruption predicates, explicit milestone and goal evidence predicates, and a reachable control tree. The tree supports sequences, parallel work, attempts, branches, repeats, waits and terminal nodes. Only explicit repeat nodes express loops. Entity target parameters must resolve to that owner's supplied local entity catalog. Read/write declarations do not grant world mutation authority.

`ProgramLibrary` indexes definitions by content hash in owner namespaces. Another owner's plans cannot be retrieved for a private context. Original source changes require a new immutable definition. Coverage distinguishes startable work, evidence waits, pending decisions and missing generation; a compiled definition alone is not evidence that a goal has an executable frontier.

`compileAgentProgram` uses the creation profile through ModelGateway, checks the actual owner, goals, sources, parameters and control graph, and permits one targeted repair. The rejected candidate and issues use the existing logical repair binding and tail layout. Exhaustion returns a recoverable failure with both invocation audits. It never substitutes an empty successful plan.

Mechanical reads are checked against the actual private JSON shape before admission. Invented array fields, property reads on scalars and nonnumeric ordered operands enter the targeted repair; null values and not-yet-present array entries remain genuine missing evidence. The committer repeats the shape check for new instances. Revision input includes the exact control frontier, current condition verdicts, completion and receipt summary, with explicit requirements to address the stalled path. Repeated dependency hashes remain in the durable journal rather than the creation context.

The creation wire contract is a nested behavior tree with inline conditions and typed parameter values. The compiler derives control-node identities, interns identical conditions, binds the requesting owner and closes read/source dependencies. Entity values, resource keys, source IDs and goal IDs use their actual authorized domains in the wire schema, including conditions nested inside the tree. The normalized executable definition remains the immutable runtime contract; the gateway retains both raw creation output and its normalized hash. Repairs retain the original rejected output and, when possible, a lossless tree rendering of it. No graph topology or semantic condition is guessed from an invalid response.

## Execution and recovery

`ProgramInterpreter` persists a version 3 event journal and derives its exact control position by replay. Each activated node has a deterministic work identity. Issued attempts bind a request hash; only a matching receipt from the canonical receipt collection can settle them. Restoring an instance requires the same immutable definition and the recorded canonical receipts. Duplicate settlement fails. A continuing receipt records an ongoing checkpoint and keeps the issued instruction in place. Partial completion and failure either wait for changed dependencies or request expansion, according to the program.

Speech has one structural variant: none, already authored text, or a request to create text for a stated purpose. A creation request must receive concrete words before action dispatch. Creating words does not deliver them or establish their truth.

Starting a wait node starts its deadline; time spent on earlier sequence nodes does not consume it. Explicit interruption survives restart. An unchanged condition is not queried again. Repeated control flow at the same input and without committed progress stops model work and exposes a no-progress subscription reason.

Execution ending, milestones and long-term goal evidence remain separate fields. Reaching a terminal node does not mark the goal completed. A separately verified goal judgment updates the owner's private goal status and retains an inference evidence record referencing that judgment. This records the Agent's conclusion; task qualification still checks actual canonical world outcomes independently.

## Decision dependency boundary

`privateProgramResources` consumes an already authorized `AgentPerspectiveView`. It never reads canonical bindings or other Agents. Local resource versions change only when their values change; global revisions alone do not invalidate them. Empty unrelated history turns are excluded. Clock is an explicit resource, and waits expose their next deadline directly.

Mechanical expressions execute in code with finite-number checks. Semantic predicates use yes/no/unknown questions. A decision round contains only currently independent work from one owner. Duplicate uses of the same predicate share a question. Lossless partitions retain all required resources, and the generative comparison arm uses the same partition rule. A single inseparable overflow uses the explicit decision fallback.

`DecisionRuntime` keys reuse by the complete authorized batch, question and prompt versions, program hash, dependencies, model catalog, profile and pinned registry snapshot. Unpinned registry work is not cached. Cached results refer to original model invocations without creating another audit or increasing physical request counts. Before applying a result the interpreter rechecks its actual current input ticket.

Cache version 2 persists a stable ordering from the request revision, subject and invocation ordinal, with the cache key breaking ties. Eviction and snapshot order use those coordinates rather than HTTP completion time. Program selection uses stable definition ordering; world library entries, recorded decisions and model audits also have canonical ordering. Multi-owner bootstrap and step replay exercise delayed out-of-order responses through WorldHost and SQLite without another model call.

The private journal also reuses an already proved predicate when a later control node needs the same condition. Reuse binds the question version and every resource actually supplied in the original batch, including resources shared with other questions. A changed value or version invalidates it. The new journal entry references the original ticket; canonical replay verifies that link and the actual read set without another model invocation. Goal questions retain their additional authored-goal requirement and cannot reuse a weaker milestone answer.

## Verification and live evidence

The unit checks exercise admission, real gateway transport with only HTTP replaced, bounded repair, stale predicates, invalid entity references, arithmetic, private projection, partial completion, deadlines, speech, interruption, no-progress loops and replay without duplicate settlement.

`scripts/experiments/jev-native-smoke.ts` and `jev-program-smoke.ts` are live development diagnostics. They share one append-only CNY 100 budget after reserving the planning probes, use conservative budget conversion and peak tariffs, count rejected generations, and persist raw gateway evidence in the ignored benchmark directory. These diagnostics do not establish gameplay acceptance or architecture speedup.
