import type { WorldDefinition } from "../runtime/world-definition";
import { contentHash } from "../models/model-audit";
import type { AgentActionProposal, CausalRef, D20CheckRequest, SimulationState } from "./model";
import type { ModelReferenceCatalog, ReferenceResolver } from "./model-context";
import type { ModelCheckRequestDraft } from "./llm-schemas";
import type { PromptValidationIssue } from "./prompts";

export interface PerceptionTarget {
  observerId: string;
  sourceActionId: string;
}

/** Preserve the scheduler's questions without treating them as perception evidence. */
export function projectPerceptionTargets(
  targets: readonly PerceptionTarget[],
  state: Readonly<SimulationState>,
  actions: readonly AgentActionProposal[],
  resolver: ReferenceResolver,
): Array<{ targetIndex: number; observerRef: string; sourceActionRef: string }> {
  const byAction = new Map(actions.map(action => [action.id, action]));
  const seen = new Set<string>();
  return targets.map((target, targetIndex) => {
    const observer = state.agents[target.observerId];
    if (!observer || state.truth.entities[observer.entityId]?.lifecycle !== "active") {
      throw new Error(`perception assignment has unknown or inactive observer ${target.observerId}`);
    }
    const action = byAction.get(target.sourceActionId);
    if (!action) throw new Error(`perception assignment has unknown source action ${target.sourceActionId}`);
    if (action.actorId === observer.id) throw new Error("perception assignment cannot react to the observer's own action");
    const key = JSON.stringify([observer.id, action.id]);
    if (seen.has(key)) throw new Error("perception assignment repeats an observer/action pair");
    seen.add(key);
    return { targetIndex, observerRef: resolver.handleFor("entity", observer.entityId), sourceActionRef: resolver.handleFor("action", action.id) };
  });
}

interface PerceptionReferenceInput {
  state: Readonly<SimulationState>;
  definition: WorldDefinition;
  actions: readonly AgentActionProposal[];
  checkRequests: readonly D20CheckRequest[];
}

/** Validate deterministic relations without choosing the check's meaning or evidence. */
export function perceptionDraftRelationIssues(
  drafts: readonly ModelCheckRequestDraft[],
  input: PerceptionReferenceInput & { perceptionTargets?: readonly PerceptionTarget[] },
  resolver: ReferenceResolver,
): PromptValidationIssue[] {
  const targets = input.perceptionTargets === undefined ? undefined
    : projectPerceptionTargets(input.perceptionTargets, input.state, input.actions, resolver);
  const actionsByObserver = new Map<string, Set<string>>();
  for (const target of targets ?? []) {
    const actions = actionsByObserver.get(target.observerRef) ?? new Set<string>();
    actions.add(target.sourceActionRef);
    actionsByObserver.set(target.observerRef, actions);
  }
  const ratingOwners = new Map<string, string>(Object.values(input.state.truth.ratings).map(rating =>
    [resolver.handleFor("rating", rating.id), resolver.handleFor("entity", rating.entityId)]));
  const ownedRatings = (owner: unknown) => [...ratingOwners].filter(([, entity]) => entity === owner).map(([ref]) => ref).sort();
  const issues: PromptValidationIssue[] = [];
  const proposals = new Set<string>();
  for (const [index, draft] of drafts.entries()) {
    const issue = (code: string, path: Array<string | number>, value: unknown, allowedHandles: string[], message: string) => {
      issues.push({ code, class: "semantic", path: ["requests", index, ...path], originalValue: value, allowedHandles,
        message: `Check ${draft.proposalKey}: ${message} Preserve the intended observer, source event and stakes; do not invent identities or change the check meaning to pass validation.` });
    };
    if (proposals.has(draft.proposalKey)) issue("perception.duplicate_proposal", ["proposalKey"], draft.proposalKey, [], "duplicate check proposalKey");
    proposals.add(draft.proposalKey);
    if (targets !== undefined) {
      const assigned = typeof draft.actorRef === "string" ? actionsByObserver.get(draft.actorRef) : undefined;
      if (!assigned) {
        issue("perception.unassigned_observer", ["actorRef"], draft.actorRef, [...actionsByObserver.keys()],
          "observer has no assigned perception task. The assignment is a question, not proof that any check is needed.");
      } else if (!draft.causes.some(cause => cause.kind === "action" && typeof cause.ref === "string" && assigned.has(cause.ref))) {
        issue("perception.unassigned_action", ["causes"], draft.causes, [...assigned],
          "check must cite a source action assigned to this observer; additional causal evidence may remain.");
      }
    }
    if (draft.ratingRef !== null && ratingOwners.get(String(draft.ratingRef)) !== draft.actorRef) {
      issue("perception.actor_rating_owner", ["ratingRef"], draft.ratingRef, ownedRatings(draft.actorRef),
        `actor rating is not owned by the actor ${String(draft.actorRef)}. Select an appropriate owned Rating, or explicitly choose null only when no aptitude applies.`);
    }
    if (draft.difficulty.kind === "opposed") {
      const difficulty = draft.difficulty;
      if (ratingOwners.get(String(difficulty.ratingRef)) !== difficulty.targetRef) {
        issue("perception.opposed_rating_owner", ["difficulty", "ratingRef"], difficulty.ratingRef, ownedRatings(difficulty.targetRef),
          `invalid opposed rating: it must belong to the selected opposing entity ${String(difficulty.targetRef)}.`);
      }
      if (difficulty.source.kind !== "rating" || difficulty.source.ref !== difficulty.ratingRef) {
        const sourceHandles = ratingOwners.get(String(difficulty.ratingRef)) === difficulty.targetRef
          ? [String(difficulty.ratingRef)] : ownedRatings(difficulty.targetRef);
        issue("perception.opposed_rating_source", ["difficulty", "source"], difficulty.source, sourceHandles,
          "opposed difficulty does not cite its rating as the identical Rating source.");
      }
    }
    if (draft.ratingRef !== null && draft.difficulty.source.kind === "rating" && draft.difficulty.source.ref === draft.ratingRef) {
      issue("perception.reused_rating", ["difficulty", "source"], draft.difficulty.source, [],
        "the same Rating occupies more than one mechanical role: observer aptitude and difficulty. Select independently supported evidence.");
    }
  }
  return issues;
}

export function perceptionCauseScope(input: PerceptionReferenceInput): Record<CausalRef["kind"], Set<string>> {
  return {
    action: new Set(input.actions.map(action => action.id)),
    check: new Set(input.checkRequests.map(check => check.id)),
    random: new Set(),
    event: new Set(input.state.truth.events.map(event => event.id)),
    fact: new Set(Object.keys(input.state.truth.facts)),
    law: new Set(input.definition.laws.map(law => law.id)),
    mechanic: new Set(),
  };
}

/** Keep all context rows while advertising only executable perception field uses. */
export function perceptionReferenceCatalog(
  resolver: ReferenceResolver,
  input: PerceptionReferenceInput,
): ModelReferenceCatalog {
  const causes = perceptionCauseScope(input);
  const candidates = resolver.catalog.candidates.map(candidate => {
    const { kind, engineId } = resolver.resolve(candidate.handle);
    return { ...candidate, allowedUses: candidate.allowedUses.filter(use => {
      if (use === "actor") return kind === "entity" && input.state.truth.entities[engineId]?.lifecycle === "active";
      if (use === "target") return kind === "local_entity" || kind === "entity" && Boolean(input.state.truth.entities[engineId]);
      if (use === "modifier") return kind === "rating" && Boolean(input.state.truth.ratings[engineId]);
      if (use === "cause") return causes[kind as CausalRef["kind"]]?.has(engineId) ?? false;
      if (use === "distribution") return false;
      return true;
    }) };
  });
  return { ...resolver.catalog, hash: contentHash(candidates), candidates };
}
