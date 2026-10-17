import type { ExecutionStageKey } from "../engine/runtime/stages";
import type { PublicWorldProgress } from "../shared/world-api";
import type { WorldInstanceDocument, WorldRunRecord } from "./world-instance-types";

type Stage = PublicWorldProgress["stage"];
type Owner = { kind: "run"; runId: string; generation: number; revision: number } |
  { kind: "reply"; beatId: string; participantId: string };
type Work = { owner: Owner; progress: PublicWorldProgress };

const executionProgress: Record<ExecutionStageKey, Stage> = {
  "input-roster": "preparing",
  "action-compilation": "interpreting",
  "direct-action": "interpreting",
  "grounding-resource-admission": "resolving",
  "direct-adjudication": "resolving",
  "reaction-perception": "reacting",
  "temporal-dependency": "settling",
  "truth-resolution": "resolving",
  "direct-settlement": "settling",
  "transition-causal-verification": "checking",
  "observation-agent-mind": "reacting",
  "canonical-validation": "checking",
  "atomic-commit": "saving",
};

/** Ephemeral presentation of owned work; saved runs and the outbox remain authoritative. */
export class WorldProgress {
  private readonly active = new Map<string, Set<Work>>();

  constructor(private readonly now: () => Date, private readonly changed: (id: string) => void) {}

  start(instanceId: string, owner: Owner, stage: Stage) {
    const work: Work = { owner, progress: { stage, startedAt: this.now().toISOString() } };
    const entries = this.active.get(instanceId) ?? new Set<Work>();
    entries.add(work);
    this.active.set(instanceId, entries);
    this.changed(instanceId);
    const set = (next: Stage) => {
      if (!entries.has(work) || work.progress.stage === next) return;
      work.progress = { stage: next, startedAt: this.now().toISOString() };
      this.changed(instanceId);
    };
    return {
      set,
      stage: (key: ExecutionStageKey) => set(executionProgress[key]),
      finish: () => {
        if (!entries.delete(work)) return;
        if (!entries.size) this.active.delete(instanceId);
        this.changed(instanceId);
      },
    };
  }

  clear(instanceId: string) {
    this.active.get(instanceId)?.clear();
    this.active.delete(instanceId);
  }

  project(document: WorldInstanceDocument, run: WorldRunRecord | undefined, participantId?: string): PublicWorldProgress | null {
    const entries = [...this.active.get(document.id) ?? []];
    if (run && ["queued", "running", "pausing"].includes(run.status)) {
      const work = entries.find(({ owner }) => owner.kind === "run" && owner.runId === run.id &&
        owner.generation === run.generation && owner.revision === document.state.revision);
      return work ? { ...work.progress } : { stage: "preparing", startedAt: run.updatedAt };
    }
    if (!participantId) return null;
    const pending = document.narratives.filter(beat => beat.participantId === participantId &&
      ["queued", "generating"].includes(beat.status));
    const work = entries.find(({ owner }) => owner.kind === "reply" && owner.participantId === participantId &&
      pending.some(beat => beat.id === owner.beatId));
    if (work) return { ...work.progress };
    return pending.length ? { stage: "reply-pending", startedAt: pending[0]!.createdAt } : null;
  }
}
