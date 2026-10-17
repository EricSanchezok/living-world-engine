<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AGENTS.md

Computable Worlds is the research direction; this repository's current implementation is Living World Engine, a script-driven open-world AI game framework. Read [decision 0004](docs/decisions/0004-game-first-principles.md) for its first principles and [the architecture map](docs/architecture.md) before changing structure. Treat the implementation as an evolving experiment, not as the definition of the research object.

## Repository governance

The governance layer is managed by repo-seed; product code remains repository-owned. [`.repo-seed/manifest.json`](.repo-seed/manifest.json) is authoritative for managed files, capabilities, governance paths, external sources, and the installed repo-seed version.

Route governance work explicitly: use `repo-review` for change review, `repo-decisions` for durable choices with meaningful alternatives, `repo-governance` when risk signals change, and the global `repo-seed` skill only for seeding, upgrades, or upstream repair. Ordinary implementation follows this file and the linked project documents.

## Repository layout

```
src/          Application and engine: app/ (Next.js UI and Route Handlers), script/ (world contracts), engine/ (Truth Engine runtime), server/ (WorldHost, persistence, and import)
docs/         Reference material: architecture, game-design product specifications, Specs, decisions, postmortems, and research
.agents/      Resident repo-review, repo-decisions, and repo-governance skills
scripts/      Governance gates and world tooling
```

## Commands

```sh
npm run dev                                      # Local open-world workbench
npm run build                                    # Production build
npm run lint                                     # ESLint
npm test                                         # Vitest unit/integration projects
npm run world:validate -- <world-directory>      # Validate a schema v9 world
npm run world:import -- <zip> [--replace]        # Import through the shared web/CLI core
node scripts/run-gates.mjs                       # Manifest-selected governance gates
npm run debug:doctor                              # Check Ledger and debug-index integrity
npm run debug -- find --invocation <public-id>    # Locate durable evidence by public invocation ID
```

Run the checks relevant to the touched surface while working; run `npm run check:fast` before committing. For any bug or unexpected behavior, start with `npm run debug:doctor` and follow [docs/debugging.md](docs/debugging.md) plus the [debugging skill](.agents/skills/debugging/SKILL.md). CI owns the exhaustive browser matrix.

### Local startup acceptance

When starting the local workbench for interactive testing, treat startup as an end-to-end check rather than only launching `next dev`:

1. Confirm the bundled script exists at `worlds/blackmarsh/world/` and contains `script.yaml`, `laws.yaml`, `mechanics.yaml`, and `participation.yaml`; run `npm run world:validate -- worlds/blackmarsh/world` before starting when the world files or loader changed.
2. Use the default `.livingworld-v35/` data root unless the task explicitly selects another one. If an instance pins an execution algorithm Composition that is no longer registered, treat that local test instance as an obsolete save: preserve a timestamped backup if useful, then remove the stale instance rather than migrating or silently changing its producer.
3. After source or route changes, move the generated `.next/` directory aside (or otherwise clear the development cache) before restarting so stale route/compiler output cannot mask the current source.
4. Start `npm run dev` and verify all of `GET /`, `GET /api/worlds`, and `GET /api/instances` return HTTP 200. A successful root-page response alone is not evidence that the world runtime is usable.
5. Before handing the browser back to the user, confirm `/api/worlds` lists the bundled world and `/api/instances` is readable. Report any cleanup (including deleted instance IDs) and keep the service process running for the test.
6. When a bundled world's model profile changes, treat its persisted catalog and instances as immutable snapshots: validate the source, clear or replace the test data root, restart, and verify a newly created instance's Inspector account/profile before running steps. Follow the detailed [profile-switch checklist](docs/development.md#switching-model-profiles).

## Governance loop (hard rules)

1. A risk-boundary change starts from an Approved spec in [docs/specs/](docs/specs/README.md); routine changes are exempt.
2. Record a decision in [docs/decisions/](docs/decisions/README.md) only when a change chooses among meaningful alternatives whose rationale may be revisited.
3. A subtle, systemic, or costly escaped failure earns a [postmortem](docs/postmortems/README.md) linked to a permanent guardrail.
4. Complete each independently verifiable work unit with the relevant checks and an immediate local commit containing only that unit. Stop without committing when checks fail or unrelated changes cannot be separated safely.
5. Re-running repo-seed is the only upgrade path for seeded governance. Never hand-edit seeded files merely to match upstream.

## Security rules

- Authorization to modify or build includes authorization for the gated local commit required above unless the user says not to commit or asks only for review or diagnosis.
- Never push without explicit user authorization; a local commit is a recovery checkpoint, not publication.
- Ask before modifying paths outside the seeded surface: AGENTS.md, CLAUDE.md, docs/, scripts/, .agents/skills/, .github/, CONTRIBUTING.md, LICENSE, .editorconfig, .gitattributes, and .repo-seed/.
- Never read `.env` files or other secrets.

## Product invariants

- **Script-driven generality:** lore, characters, and mechanics belong to world scripts; never hard-code one game's behavior into the framework.
- **Open semantics, strict commits:** players and Agents may propose arbitrary natural-language actions; the Truth Engine jointly adjudicates semantics, while the transaction kernel owns schema, references, quantities, conservation, random commitments, causality, and atomicity. Player text is never a state delta.
- **Cognitive isolation:** canonical truth, each Agent's beliefs, and player knowledge are separate states. AgentMind and ordinary clients never receive canonical identity bindings or another subject's hidden cognition; the only exception is the trusted local read-only inspector in [0055](docs/decisions/0055-trusted-world-evolution-inspector.md).
- **Server-only engine:** filesystem access, YAML, and API keys keep the engine on the server. Browsers use `src/app/api/**/route.ts`; never move engine execution into client code.
- **Forward-only development:** breaking state, save, and behavior changes land directly. Delete old saves, fixtures, and compatibility paths instead of adding migrations or dual tracks.
- **One clean implementation:** replacement removes the old path; do not retain redundant implementations.
- **Algorithm optimization:** reduce observed failure causes before reducing context, batch cardinality, or semantic freedom; prefer prompt/schema/layout fixes, lossless context reuse, caching, parallelism, provider capabilities, deterministic validation, and targeted repair.
- **Batch-cost discipline:** lowering batch size or increasing LLM calls is an emergency fallback, never the first optimization; quantify token, latency, and call-count impact, pin any chosen tuning, and compare initial rejection, repair recovery, and terminal failure separately.
- **Local transparency:** local-only operation keeps model context, request/response evidence, and Inspector data transparent to the local operator; do not add privacy redaction, anonymization, or hidden-data layers merely to protect data that never leaves the user's machine.
- **Gameplay perspective:** canonical truth, Agent beliefs, and player knowledge remain distinct game states where the world contract requires it; this is a semantic rule, not a reason to redact or obscure local data from trusted inspection.
- **Frontend color discipline:** components consume only `--cg-*` CSS variables declared by the root theme; component rules never hard-code colors.

## Documentation and research

Follow [docs/AGENTS.md](docs/AGENTS.md): one home per fact, tutorial versus reference separation, current-state prose, and relative links. English is the working language for new governance artifacts; existing product and historical records remain valid in their original language. Code identifiers and comments are English.

Research is managed in Scholens project **Computable Worlds** ([web](https://scholens.sanchezcloud.net/projects/26668cf0-6489-4657-9b33-c1aba2b14a1b), `26668cf0-6489-4657-9b33-c1aba2b14a1b`, `scholens://projects/26668cf0-6489-4657-9b33-c1aba2b14a1b`). Search that project before adding evidence and store new literature there. The current paper direction studies whether executable world trajectories improve existing models on Interactive and Persistent World tasks; do not infer the research claim from any single shipped engine design.

## Testing

Follow [docs/testing.md](docs/testing.md): exercise real entry paths, verify the world rather than model self-report, and replace only expensive or nondeterministic boundaries.

## Skills

- [`.agents/skills/repo-review`](.agents/skills/repo-review/SKILL.md) — project-specific semantic review policy.
- [`.agents/skills/repo-decisions`](.agents/skills/repo-decisions/SKILL.md) — durable MADR procedure.
- [`.agents/skills/repo-governance`](.agents/skills/repo-governance/SKILL.md) — progressive capability assessment and authorization.
- [`.agents/skills/debugging`](.agents/skills/debugging/SKILL.md) — evidence-first local debugging with the shared Ledger/CLI query path.
