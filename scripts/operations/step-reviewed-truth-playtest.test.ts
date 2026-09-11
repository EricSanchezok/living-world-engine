import { expect, it } from "vitest";
import { assertReviewedTruthRoot } from "./step-reviewed-truth-playtest";

it.each([{ slots: 12, actions: 38 }, { slots: 8, actions: 10 }])("requires all source plans with unique identities before gameplay: %j", scope => {
  const manifest = { ...scope, sourceHash: "source", initialPhysicalRequestHash: "request" };
  let id = 0;
  const rows = Array.from({ length: scope.slots }, (_, slot) => ({ slot, verdict: "accept", plans:
    Array.from({ length: slot === 0 ? scope.actions - scope.slots + 1 : 1 }, () => ({ planRef: `ref:plan:${++id}`, actionRef: `ref:action:${id}` })) }));
  const report = { ...manifest, status: "completed", verdict: "accept", rows };
  expect(() => assertReviewedTruthRoot(report, manifest)).not.toThrow();
  for (const change of [{ sourceHash: "different" }, { verdict: "unknown" }, { status: "stopped" }, { rows: rows.slice(1) },
    { rows: rows.map(row => ({ ...row, verdict: "reject" })) },
    { rows: rows.map(row => ({ ...row, plans: row.plans.map(plan => ({ ...plan, actionRef: "ref:action:duplicate" })) })) }]) {
    expect(() => assertReviewedTruthRoot({ ...report, ...change }, manifest)).toThrow("has not passed");
  }
});
