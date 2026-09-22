import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { defineAlgorithmRef } from "../../algorithms/composition";
import type { ActionCompilationCapability, TruthCandidateSession } from "../../algorithms/roles";
import type { AgentActionProposal, SimulationState } from "../../contracts/model";
import { contentHash } from "../../models/model-audit";
import { ModelOutputError, type StructuredModelProvider } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import type { AlgorithmExecutionState } from "../../runtime/execution-state";
import type { JsonObject } from "../../runtime/json";
import { WORLD_EXECUTION_CONTRACT_VERSION, type WorldExecutionAlgorithmRegistry } from "../../runtime/execution";
import { authoredCapabilities, bindInteractionProgram, currentInteractionParts, executeInteractionComponent,
  interactionProgramSchema, type BoundInteractionProgram } from "./executable-interaction";
import { createIncrementalPlayerAlgorithm, incrementalPlayerAlgorithmRef } from "./incremental-player-algorithm";

const instruction = loadPromptAsset("shared/executable-interaction.md");
export const EXECUTABLE_INTERACTION_VERSION = `authored-interaction-v1@${contentHash({ instruction,
  schema: z.toJSONSchema(interactionProgramSchema, { target: "draft-07" }) }).slice(0, 16)}`;
const storageKey = "executableInteractions";
type Bindings = Record<string, BoundInteractionProgram>;
export function executablePlayerAlgorithmRef() {
  const base = incrementalPlayerAlgorithmRef();
  return defineAlgorithmRef({ ...base, id: "executable-player-diagnostic", version: "3",
    config: { ...base.config, executableInteraction: EXECUTABLE_INTERACTION_VERSION } });
}

export function interactionCompilerSources(state: Readonly<SimulationState>, actions: readonly AgentActionProposal[]) {
  const capabilities = authoredCapabilities(state);
  return actions.map(action => ({ actionId: action.id, actorId: action.actorId,
    actorEntityId: state.agents[action.actorId].entityId, goal: action.goal, means: action.means,
    parts: currentInteractionParts(action),
    targetBindings: action.targetIds.map(localId => ({ localId,
      canonicalEntityIds: state.agents[action.actorId].bindings[localId]?.canonicalEntityIds ?? [] })),
    capabilities: capabilities.filter(c => c.capability.actorEntityId === state.agents[action.actorId].entityId),
  }));
}

/** One physical request still owns ordinary compilation and the proposed program. */
export function executableActionCompiler(base: ActionCompilationCapability, bindings: () => Bindings): ActionCompilationCapability {
  return async (provider, state, actions, scope, profileId, maxSlots, recovery, symbols) => {
    const byId = new Map(actions.map(a => [a.id, a]));
    const joint: StructuredModelProvider = { catalog: provider.catalog,
      availableProfileSummaries: role => provider.availableProfileSummaries(role),
      assertProfilesAvailable: profiles => provider.assertProfilesAvailable(profiles),
      async generateStructured(request) {
        if (request.role !== "action-compilation") return provider.generateStructured(request);
        const members = request.boundActionIds?.map(id => byId.get(id));
        if (!members?.length || members.some(a => !a)) throw new Error("joint compilation lost physical source membership");
        const actual = members as AgentActionProposal[];
        const schema = z.strictObject({ ordinary: request.schema, programs: z.array(interactionProgramSchema) });
        const programJson = z.toJSONSchema(z.array(interactionProgramSchema), { target: "draft-07" });
        const wireJsonSchema = request.wireJsonSchema ? { type: "object", additionalProperties: false,
          required: ["ordinary", "programs"], properties: { ordinary: request.wireJsonSchema, programs: programJson } } : undefined;
        let generated;
        const system = `${request.system}\n\n${instruction}`;
        try {
          generated = await provider.generateStructured({ ...request, schema, wireJsonSchema,
            schemaName: `${request.schemaName}_executable`, promptVersion: `${request.promptVersion}/${EXECUTABLE_INTERACTION_VERSION}`,
            system, context: { ...(request.context as object),
              executableInteraction: { version: EXECUTABLE_INTERACTION_VERSION, sources: interactionCompilerSources(state, actual) } },
            preprocessOutput: raw => {
              const envelope = raw as { ordinary?: unknown; programs?: unknown };
              const original = request.preprocessOutput?.(envelope?.ordinary) ?? { value: envelope?.ordinary, symbolRepairs: [] };
              return { value: { ordinary: original.value, programs: envelope?.programs }, symbolRepairs: original.symbolRepairs };
            },
          });
        } catch (error) {
          if (!(error instanceof ModelOutputError)) throw error;
          const raw = error.rawValue as { ordinary?: unknown } | undefined;
          throw new ModelOutputError(error.message, error.audit, { cause: error, rawValue: raw?.ordinary });
        }
        const records: Array<{ actionId: string; admitted: boolean; reason?: string; program?: unknown }> = [];
        const ids = generated.value.programs.map(p => p.actionId);
        const complete = contentHash([...ids].sort()) === contentHash(actual.map(a => a.id).sort());
        for (const action of actual) {
          delete bindings()[action.id];
          try {
            if (!complete) throw new Error("program batch membership mismatch");
            const bound = bindInteractionProgram(state, action, generated.value.programs.find(p => p.actionId === action.id));
            bindings()[action.id] = bound;
            records.push({ actionId: action.id, admitted: true, program: bound });
          } catch (error) { records.push({ actionId: action.id, admitted: false, reason: String(error) }); }
        }
        scope.observer?.emit({ event: "algorithm.executable_interaction.compiled", correlation: request.correlation,
          counts: { actions: actual.length, rejectedPrograms: records.filter(r => !r.admitted).length },
          attributes: { reason: records.filter(r => !r.admitted).map(r => `${r.actionId}: ${r.reason}`).join("; ") } });
        return { value: generated.value.ordinary, audit: generated.audit };
      },
    };
    return base(joint, state, actions, scope, profileId, maxSlots, recovery, symbols);
  };
}

function readBindings(state: AlgorithmExecutionState | null): Bindings {
  const raw = state?.data[storageKey];
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid persisted executable bindings");
  return structuredClone(raw) as unknown as Bindings;
}
function writeBindings(state: AlgorithmExecutionState | null, bindings: Bindings): AlgorithmExecutionState {
  if (!state) throw new Error("executable diagnostic requires its intention execution journal");
  return { ...state, data: { ...state.data, [storageKey]: structuredClone(bindings) as unknown as JsonObject } };
}
function intentState(state: AlgorithmExecutionState | null): AlgorithmExecutionState | null {
  return state ? { ...state, data: Object.fromEntries(Object.entries(state.data).filter(([key]) => key !== storageKey)) } : null;
}

export function registerExecutablePlayerAlgorithm(registry: WorldExecutionAlgorithmRegistry) {
  const ref = executablePlayerAlgorithmRef();
  registry.registerDefinition({ role: "world-execution", id: ref.id, version: ref.version,
    contractVersion: WORLD_EXECUTION_CONTRACT_VERSION, maturity: "diagnostic",
    configSchema: z.custom(value => contentHash(value) === contentHash(ref.config)),
    children: Object.entries(ref.children).map(([name, child]) => ({ name, role: child.role })),
    create: context => {
      if (contentHash(context.ref.children) !== contentHash(ref.children)) throw new Error("executable diagnostic foundation changed");
      const local = new AsyncLocalStorage<{ bindings: Bindings }>();
      const current = () => {
        const run = local.getStore();
        if (!run) throw new Error("executable compilation lacks its preparation scope");
        return run.bindings;
      };
      const base = createIncrementalPlayerAlgorithm(context, components => {
        const truth = components.truthResolution, select = components.selectActions!;
        return { ...components,
          agentCognition: { thinkBatch: (state, ...args) => components.agentCognition.thinkBatch({ ...state,
            executionState: intentState(state.executionState) }, ...args) },
          selectActions: (input, actions, executionState, executionContext) => {
            return select(input, actions, intentState(executionState), executionContext);
          },
          actionCompilation: executableActionCompiler(components.actionCompilation, current),
          truthResolution: { candidateRepairLimit: truth.candidateRepairLimit,
            resolve: (input, scope) => truth.resolve(input, scope),
            reviewCandidate: (...args) => truth.reviewCandidate(...args),
            async *prepare(input, scope): TruthCandidateSession {
              let stage;
              try { stage = executeInteractionComponent(input, current(), context.services.rulePackages); }
              catch (error) {
                scope.observer?.emit({ event: "algorithm.executable_interaction.fallback", correlation: scope.correlation,
                  counts: { actions: input.initialActions.length }, attributes: { reason: String(error) } });
                return yield* truth.prepare(input, scope);
              }
              if (input.orderedRandom) stage.resolution.rng = await input.orderedRandom.finish(stage.resolution.rng);
              scope.observer?.emit({ event: "algorithm.executable_interaction.executed", correlation: scope.correlation,
                counts: { actions: input.initialActions.length } });
              const feedback = yield stage;
              if (feedback?.kind === "finish") return stage.resolution;
              if (!feedback) throw new Error("executable candidate requires explicit review feedback");
              scope.observer?.emit({ event: "algorithm.executable_interaction.rejected", correlation: scope.correlation,
                counts: { actions: input.initialActions.length }, attributes: { reason: String(feedback.error) } });
              // Later components may already own the stream. Ordinary repair
              // remains available, but newly requested randomness fails the
              // atomic step rather than drawing out of canonical order.
              return yield* truth.prepare({ ...input, state: { ...input.state, truth: { ...input.state.truth,
                rng: stage.resolution.rng } }, orderedRandom: input.orderedRandom ? {
                  acquire: async () => { throw new Error("rejected executable component requires a new ordered random boundary"); },
                  finish: async rng => {
                    if (contentHash(rng) !== contentHash(stage.resolution.rng)) throw new Error("executable repair changed the closed random stream");
                    return structuredClone(rng);
                  },
                } : undefined }, scope);
            },
          },
        };
      });
      return { manifest: base.manifest, bootstrap: (input, scope) => base.bootstrap(input, scope),
        prepareStep: async (input, scope) => {
          const retained = new Set(Object.values(input.state.truth.activities).filter(a => a.status === "active" || a.status === "paused")
            .map(a => a.sourceActionId));
          const bindings = Object.fromEntries(Object.entries(readBindings(input.state.executionState)).filter(([id]) => retained.has(id)));
          return local.run({ bindings }, async () => {
            const prepared = await base.prepareStep(input, scope);
            return { ...prepared, executionState: writeBindings(prepared.executionState, bindings) };
          });
        },
        // Reaction compilation can replace bindings for this completion only.
        // The preparation's execution journal is already frozen by the kernel.
        completeStep: (input, preparation, reactions, scope) => local.run({ bindings: readBindings(preparation.executionState) },
          () => base.completeStep(input, preparation, reactions, scope)),
      };
    },
  });
  return registry;
}
