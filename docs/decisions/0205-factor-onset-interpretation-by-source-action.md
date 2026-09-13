# Factor Onset Interpretation by Source Action

## Status
Accepted
Class: testing

## Context and Problem Statement

Action compilation plans duration and interaction dependencies, while perception interprets each assigned observer/source pair from complete world evidence. A compound action combines current attempts, later delivery, conditional steps and private goals. Repeating its interpretation for different observers can produce incompatible source roles or onsets. A local-identity codec enforces ownership but cannot establish semantic denotation or temporal meaning.

## Decision Drivers

- Test a shared semantic intermediate before changing the execution pipeline.
- Preserve complete context, open actions and uncertainty.
- Bind generated frames to existing sources without treating extraction as world truth.
- Keep added inference cost visible and require complete-player qualification.

## Considered Options

- Continue observer-level semantic drafts and reference constraints.
- Introduce source frames directly into production action compilation.
- Screen one source-level frame per distinct action before designing observer projection.

## Decision Outcome

Select the isolated [source-frame screen](../specs/0159-source-onset-frame-screen.md). The model interprets the common action onset and first receiving parties once, with exact source excerpts and explicit deferred/private information. The engine checks source identity and quote membership without inferring perception. The control remains the existing observer-level draft. No production composition adopts the frame or an extra model stage.

## Pros and Cons of the Options

Observer-level drafts preserve the complete question but repeat source interpretation and allow different accounts of the same action. Additional reference constraints address only some failure causes.

Production integration could reuse a frame across observers and potentially overlap its production with existing preparation, but adds unqualified semantic authority and may increase calls or latency. It requires evidence about frame quality and later observer projection first.

An isolated source-level screen tests that prerequisite with one response per arm. It changes the output task and cannot establish a deployable speedup or prove a downstream observer result. Exact excerpts prevent invented source quotations but not incorrect interpretation.

## Links

- [Observer semantic drafts](0198-screen-semantic-drafts-before-report-materialization.md)
- [Observer-local symbols](0204-bind-perception-identities-to-observer-symbols.md)
- [Document-Level Event Argument Extraction by Conditional Generation](https://aclanthology.org/2021.naacl-main.69/) motivates event-centered argument structure with document context. Its trained extraction model and dataset scores do not establish correct hypothetical action onsets, information flow or hosted-model performance in this engine.
