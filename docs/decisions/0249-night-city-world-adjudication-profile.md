# Night City world adjudication profile

## Status

Accepted
Class: bug-fix

## Context and Problem Statement

Night City includes institutional permissions, shared funds and bounded payment-service Agents. A valid recorded procurement payment was repeatedly rejected by the native world evaluator even though its diagnostic answers recognized the balance and purchasing mandate. The same complete decision batch was accepted by the existing language-model decision profile. Wording and evidence-layout probes did not resolve the native rejection.

## Decision Drivers

- Execute authorized business actions without bypassing semantic adjudication.
- Preserve ownership, consent, limits and duplicate-payment restrictions.
- Keep world-specific configuration in the world package.
- Account for the cost of the selected model rather than adding silent retries.

## Considered Options

- Retain native world judgments with revised transfer instructions or evidence layout.
- Add an extra language-model review after a rejected payment.
- Select the existing language-model decision profile for this world's adjudication independently of each Agent's capability bindings.

## Decision Outcome

Night City's manifest selects `decision-deepseek-long` for world decisions. Authored Agents declare `decision-jev`, `creation-deepseek` and `decision-deepseek-long` as their decision, creation and fallback bindings. The direct runtime's coherent autonomous action reader uses the actor's creation binding under [decision 0247](0247-coherent-autonomous-action-reading.md); a declared decision Profile does not imply every private action uses that Profile. The implementation uses the existing world-versus-Agent capability bindings, with no framework branch for a franchise, account kind or successful payment.

Each world judgment still receives the complete applicable action batch and authoritative local evidence. This choice neither divides the batch nor adds a second judgment after every rejection. Permission remains a semantic judgment and committed quantities remain kernel-owned. The source package and newly created instances pin this choice; existing instances keep their original world snapshot.

## Pros and Cons of the Options

- Revised native prompts retain lower latency, but the recorded positive payment remained rejected across the tested alternatives.
- A review after rejection can recover some valid payments, but adds calls and requires a new policy for reconciling contradictory semantic decisions. A refusal is not in itself an engine error.
- A world-owned language profile uses existing contracts and passed the recorded positive and over-limit probes. It incurs longer generation and substantial reasoning output. The evidence does not establish universal correctness, and live trajectories must verify actual state rather than model claims.

## Links

- [Live acceptance evidence](../../worlds/cyberpunk2077/live-verification.md)
- [World authoring and model bindings](../../worlds/cyberpunk2077/authoring/README.md)
- [Authored world lives](0248-authored-world-lives-through-agent-takeover.md)
- [Direct runtime model responsibilities](../game-design/direct-runtime.md#model-responsibilities)
