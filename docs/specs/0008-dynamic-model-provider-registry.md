# Dynamic model-provider registry

Artifact-Version: 1
Status: Approved

## Intent

Living World Engine must add Zhipu API and Coding Plan, MiniMax API and Token Plan, Kimi API and Coding Plan, and MiMo API and Token Plan without extending a core provider union for every account. Existing DeepSeek, OpenAI, and xAI integrations remain supported. Model identities and capabilities evolve independently of the engine release, so deployments need an auditable dynamic catalog while provider endpoints, credentials, role bindings, strict output validation, scheduling, and failure semantics remain engine-owned.

The engine uses models.dev as its only remote metadata source. It does not query provider model lists, probe paid capabilities, accept remote credential destinations, switch providers after failure, persist API keys, or treat SuperGrok as xAI API access.

## Contract

`config/models.yaml` schema v3 separates provider accounts, protocol drivers, vendor dialects, profiles, model selectors, and normalized inference settings. Provider accounts own a trusted base URL, environment-variable name, channel, protocol, dialect, models.dev provider identifier, and concurrency. Adding another account for an existing dialect and protocol is configuration-only.

A profile selects either one exact model ID or the latest compatible model. Exact selection never changes the ID. Latest-compatible selection filters one models.dev provider by active status, text capability, optional family and simple include/exclude globs, structured-result capability, and every explicit inference requirement. Candidates are ordered by release date descending, last-updated date descending, then model ID ascending. Unsupported explicit inference fails before transport; `auto` omits that control. No call falls back to another model, account, channel, or provider.

The fixed source `https://models.dev/api.json` refreshes at most hourly with a ten-second timeout, ETag support, single-flight execution, strict normalization, and last-known-good retention. Normalized content-addressed snapshots live under `LIVINGWORLD_DATA_ROOT/model-registry/`; refresh timestamps do not affect the snapshot hash. Remote endpoint, package, and environment-variable fields never affect transport. Local configuration may override individual metadata fields or disable a model, and normalized metadata records field provenance. [Complete local definitions](0098-complete-local-model-metadata.md) allow exact selection of an unindexed model without making it eligible for automatic selection.

One execution captures one registry snapshot. All model work within that execution uses the same snapshot even if a refresh completes concurrently. A later interactive execution may resolve a newer compatible model. Benchmark and replay callers can require a historical snapshot hash; unavailable historical evidence fails explicitly.

Protocol drivers implement OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages. Vendor dialects compile normalized inference into provider fields and normalize usage and errors. Structured results use native strict JSON Schema, JSON object plus local Zod, or a forced tool call plus local Zod. A text-only JSON recovery path is not allowed. Every accepted value passes the request's local Zod schema.

Model execution audits identify the provider account, vendor channel, protocol, requested selector and inference, resolved model and inference, configuration hash, registry snapshot hash, model metadata hash, structured-output mode, and invocation evidence. Canonical state is SimulationState v15 inside WorldInstanceDocument v23; the default data root is `.livingworld-v23/`. Older state remains untouched and is not migrated or dual-read.

`GET /api/model-registry` returns source health, snapshot identity, credential presence, provider-account state, and profile resolution without returning credentials. `POST /api/model-registry/refresh` refreshes only the fixed source and is single-flight and rate-limited. Settings presents the same read-only diagnostics with an explicit refresh action, textual status, and accessible dynamic announcements. CLI status, refresh, and opt-in live smoke commands use the same application core.

Bundled worlds continue to select the existing DeepSeek deployment profiles. Every production profile assigned to a DeepSeek account selects the exact `deepseek-v4-flash` model and explicitly disables thinking; registry refreshes must not switch any of them to DeepSeek Pro or a reasoning mode. Missing credentials block only profiles that are actually activated.

## Plan

Introduce the models.dev snapshot store and selector, replace provider-specific catalog unions with account, driver, and dialect registries, implement every named account and structured-output strategy, then integrate execution-scoped snapshots, canonical audit versions, diagnostics, CLI commands, and settings UI. Remove the replaced adapter path rather than retaining parallel implementations.

## Verification

Exercise initial and conditional refresh, malformed and offline sources, immutable snapshots, local overrides, exact and latest selection, deterministic ties, incompatible explicit controls, concurrent refresh during multi-Agent work, every provider payload dialect, every structured-output strategy, retry and scheduling behavior, missing credentials, no fallback, sanitized diagnostics, keyboard operation, and status announcements.

Run `npm run check:fast`, `npm run build`, `node scripts/verify-decisions.mjs`, opt-in live smoke calls for available accounts, and `git diff --check`.

## Evidence

Implemented on 2026-08-28. `npm run check:fast` passes 43 unit test files and 281 tests, the schema v13 world fixture, workflow verification, and all six governance gates. `npm run build` produces the model-registry Route Handlers as dynamic server routes. Focused registry, provider-matrix, API, and settings tests cover 38 cases including 200/304, timeout, malformed and oversized responses, last-known-good fallback, single-flight and rate limiting, immutable snapshots, deterministic selection, explicit incompatibility, all 11 account transports, MiMo header authentication, Kimi identity/cache headers, 30-call execution snapshot consistency, 48-Agent scheduling, sanitized diagnostics, and accessible refresh state.

A metadata-only live `npm run models:status` refresh against the fixed models.dev URL resolved all 12 bundled Profiles across the 11 configured accounts from one content-addressed snapshot. Paid provider smoke calls remain opt-in and were not run as part of deterministic verification.
