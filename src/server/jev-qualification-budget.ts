import path from "node:path";
import { randomUUID } from "node:crypto";
import { createJevLiveBudget } from "../engine/benchmarks/jev/live-budget";
import { createModelFetchResolver } from "../engine/models/model-network";

type Budget = ReturnType<typeof createJevLiveBudget>;
type Session = { root: string; budget: Budget; onExit: () => void };
const shared = globalThis as typeof globalThis & { livingWorldJevQualificationBudget?: Session };

/** Optional browser qualification uses the same capped ledger as CLI trials. */
export function qualificationModelFetchResolver(env: Record<string, string | undefined>,
  resolver = createModelFetchResolver(env)): ReturnType<typeof createModelFetchResolver> {
  if (!env.LIVINGWORLD_JEV_BUDGET_ROOT) return resolver;
  const root = path.resolve(env.LIVINGWORLD_JEV_BUDGET_ROOT);
  if (shared.livingWorldJevQualificationBudget && shared.livingWorldJevQualificationBudget.root !== root) {
    throw new Error("Stop the current qualification session before changing its budget ledger");
  }
  if (!shared.livingWorldJevQualificationBudget) {
    const budget = createJevLiveBudget(root);
    budget.beginTrial(`interactive-${process.pid}-${randomUUID()}`);
    const onExit = () => {
      // An interrupted HTTP request retains its reservation and lock for review.
      try { budget.close(); } catch { /* Pending work is intentionally not cleared. */ }
    };
    shared.livingWorldJevQualificationBudget = { root, budget, onExit };
    process.once("exit", onExit);
  }
  const budget = shared.livingWorldJevQualificationBudget.budget;
  return (id, account) => budget.transport(id, resolver(id, account) ?? fetch);
}

export async function closeQualificationBudget(): Promise<void> {
  const session = shared.livingWorldJevQualificationBudget;
  if (!session) return;
  await session.budget.drain(); session.budget.close();
  process.removeListener("exit", session.onExit);
  delete shared.livingWorldJevQualificationBudget;
}
