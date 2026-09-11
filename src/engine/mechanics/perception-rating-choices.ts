import { loadPromptAsset } from "../prompts";
import { z } from "zod";
import { checkRequestSchema, perceptionDirectiveSchema } from "../contracts/llm-schemas";
import type { ModelReferenceCatalog } from "../contracts/model-context";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../models/model-provider";

const instruction = loadPromptAsset("shared/perception-rating-choices.md");

export const PERCEPTION_RATING_CHOICES = `bound-perception-ratings-v1@${contentHash(instruction).slice(0, 16)}`;
type ObjectValue = Record<string, unknown>;
type Directive = z.infer<typeof perceptionDirectiveSchema>;
interface RatingChoice { key: string; actorRef: string; ratingRef: string; value: number }
interface ObserverChoice { key: string; actorRef: string; ratingRef: null }

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelConfigurationError("perception choice context is not an object");
  return value as ObjectValue;
}

/** Encode legal tuples, never infer a model's intended owner, aptitude or difficulty. */
export class PerceptionRatingChoiceCodec {
  readonly context: ObjectValue;
  readonly schema;
  readonly bindingHash: string;
  private readonly originalHash: string;
  private readonly encodedHash: string;
  private readonly observers = new Map<string, ObserverChoice | RatingChoice>();
  private readonly opposed = new Map<string, RatingChoice>();

  constructor(private readonly originalContext: unknown) {
    this.originalHash = contentHash(originalContext);
    const context = structuredClone(object(originalContext));
    if (Object.hasOwn(context, "perceptionRatingChoices")) throw new ModelConfigurationError("perception choices already applied");
    const state = object(context.state), truth = object(state.canonicalTruth);
    const entities = object(truth.entities), ratings = object(truth.ratings);
    const catalog = context.referenceCatalog as ModelReferenceCatalog;
    if (!Array.isArray(catalog?.candidates)) throw new ModelConfigurationError("perception choices require a reference catalog");
    const candidates = new Map(catalog.candidates.map(row => [row.handle, row]));
    if (candidates.size !== catalog.candidates.length) throw new ModelConfigurationError("duplicate perception choice handles");
    const unmodifiedObservers: ObserverChoice[] = [];
    const ownedRatings: RatingChoice[] = [];
    for (const [index, row] of catalog.candidates.filter(row => row.kind === "entity").sort((a, b) => a.handle.localeCompare(b.handle)).entries()) {
      const entity = object(entities[row.handle]);
      if (entity.lifecycle !== "active" || !row.allowedUses.includes("actor")) continue;
      const choice: ObserverChoice = { key: `unmodified_${index.toString(36)}`, actorRef: row.handle, ratingRef: null };
      unmodifiedObservers.push(choice);
      this.observers.set(choice.key, choice);
    }
    for (const [index, row] of catalog.candidates.filter(row => row.kind === "rating").sort((a, b) => a.handle.localeCompare(b.handle)).entries()) {
      const rating = object(ratings[row.handle]);
      if (typeof rating.entityRef !== "string" || typeof rating.value !== "number" || !Number.isFinite(rating.value)) {
        throw new ModelConfigurationError("perception Rating lacks displayed owner/value");
      }
      const owner = candidates.get(rating.entityRef), entity = object(entities[rating.entityRef]);
      if (owner?.kind !== "entity") throw new ModelConfigurationError("perception Rating owner is absent from catalog");
      const choice: RatingChoice = { key: `aptitude_${index.toString(36)}`, actorRef: rating.entityRef, ratingRef: row.handle, value: rating.value };
      ownedRatings.push(choice);
      if (entity.lifecycle === "active" && owner.allowedUses.includes("actor") && row.allowedUses.includes("modifier")) {
        this.observers.set(choice.key, choice);
      }
      if (owner.allowedUses.includes("target") && row.allowedUses.includes("source")) this.opposed.set(choice.key, choice);
    }
    const selector = (keys: string[]) => keys.length ? z.enum(keys) : z.never();
    const fields = checkRequestSchema.shape;
    const wireCheck = checkRequestSchema.omit({ actorRef: true, ratingRef: true, difficulty: true }).extend({
      observerChoice: selector([...this.observers.keys()]),
      difficulty: z.discriminatedUnion("kind", [fields.difficulty.options[0], z.strictObject({
        kind: z.literal("opposed"), opposedChoice: selector([...this.opposed.keys()]),
      })]),
    });
    this.schema = z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("request_checks"), requests: z.array(wireCheck).min(1) }),
      perceptionDirectiveSchema.options[1],
    ]);
    this.bindingHash = contentHash({ version: PERCEPTION_RATING_CHOICES, sourceState: state, unmodifiedObservers, ownedRatings });
    context.perceptionRatingChoices = { version: PERCEPTION_RATING_CHOICES, bindingHash: this.bindingHash,
      unmodifiedObservers, ownedRatings,
      observerKeys: [...this.observers.keys()], opposedKeys: [...this.opposed.keys()] };
    this.context = context;
    this.encodedHash = contentHash(context);
  }

  private assertBinding(bindingHash: string) {
    if (bindingHash !== this.bindingHash || contentHash(this.originalContext) !== this.originalHash || contentHash(this.context) !== this.encodedHash) {
      throw new ModelConfigurationError("perception choice state/context binding changed");
    }
  }

  restoreContext(): unknown {
    const result = structuredClone(this.context);
    delete result.perceptionRatingChoices;
    return result;
  }

  decodeOutput(value: unknown, bindingHash = this.bindingHash): Directive {
    this.assertBinding(bindingHash);
    const wire = this.schema.parse(value);
    if (wire.kind === "done") return wire;
    return perceptionDirectiveSchema.parse({ kind: wire.kind, requests: wire.requests.map(check => {
      const { observerChoice, difficulty, ...rest } = check;
      const observer = this.observers.get(observerChoice)!;
      const opposition = difficulty.kind === "opposed" ? this.opposed.get(difficulty.opposedChoice)! : null;
      return { ...rest, actorRef: observer.actorRef, ratingRef: observer.ratingRef,
        difficulty: opposition ? { kind: "opposed", targetRef: opposition.actorRef, ratingRef: opposition.ratingRef,
          source: { kind: "rating", ref: opposition.ratingRef } } : difficulty };
    }) });
  }

  encodeOutput(value: unknown): unknown {
    this.assertBinding(this.bindingHash);
    const canonical = perceptionDirectiveSchema.parse(value);
    if (canonical.kind === "done") return canonical;
    return this.schema.parse({ kind: canonical.kind, requests: canonical.requests.map(check => {
      const { actorRef, ratingRef, difficulty, ...rest } = check;
      const observer = [...this.observers.values()].find(row => row.actorRef === actorRef && row.ratingRef === ratingRef);
      const opposition = difficulty.kind === "opposed" ? [...this.opposed.values()].find(row =>
        row.actorRef === difficulty.targetRef && row.ratingRef === difficulty.ratingRef &&
        difficulty.source.kind === "rating" && difficulty.source.ref === row.ratingRef) : null;
      return { ...rest, observerChoice: observer?.key,
        difficulty: difficulty.kind === "opposed" ? { kind: "opposed", opposedChoice: opposition?.key } : difficulty };
    }) });
  }
}

export function perceptionRatingChoiceRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.schemaName !== "truth_perception_directive" || request.role !== "truth-perception") return request;
  if (request.wireJsonSchema || request.preprocessOutput) throw new ModelConfigurationError("perception choices cannot replace an existing wire codec");
  const codec = new PerceptionRatingChoiceCodec(request.context);
  if (contentHash(codec.restoreContext()) !== contentHash(request.context)) throw new ModelConfigurationError("perception choice context did not round trip");
  const system = [request.system, instruction].join("\n\n");
  return { ...request, context: codec.context, system,
    promptVersion: `${request.promptVersion}/${PERCEPTION_RATING_CHOICES}`,
    wireJsonSchema: z.toJSONSchema(codec.schema, { target: "draft-07" }), jsonExamplePolicy: "omit",
    preprocessOutput: raw => ({ value: codec.decodeOutput(raw), symbolRepairs: [] }) };
}

export function perceptionRatingChoiceProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return { catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids),
    ...(inner.modelRegistryDiagnostics ? { modelRegistryDiagnostics: () => inner.modelRegistryDiagnostics!() } : {}),
    ...(inner.refreshModelRegistry ? { refreshModelRegistry: () => inner.refreshModelRegistry!() } : {}),
    generateStructured: request => inner.generateStructured(perceptionRatingChoiceRequest(request)) };
}
