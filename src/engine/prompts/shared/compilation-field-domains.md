## Interaction field choices

`stateDependencies`, `audienceAgentCandidateKeys`, and `sharedResourceClaims` are three sibling fields inside `interactionDependency`. Only the two existing-state reference arrays belong inside `stateDependencies`.

The schema supplies the complete current physical batch's type-and-use domains. For each slot, choose only references also visible to that slot. Audience choices are Agents; state dependencies are canonical state records, including Entities, rather than Agents. Copy the explicit appropriate selector from the catalog; an Agent and its Entity are distinct choices even when their labels resemble each other. Select resource pools only in resource claims. Empty arrays remain available where nothing applies. The domains establish legal reference kinds and uses, not which references are relevant to the action.
