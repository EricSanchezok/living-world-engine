import { expect, it } from "vitest";
import { contentHash } from "../../models/model-audit";
import { compactRepairDiagnosticDomains, expandRepairDiagnosticDomains } from "../repair-diagnostic-domains";

const domain = (suffix = "") => Array.from({ length: 24 }, (_, index) => ({
  kind: "fact", ref: `ref:fact:${index}${suffix}`, label: `Complete historical fact ${index}${suffix}`, slots: [1, 3],
}));
function fixture() {
  const old = domain(), other = domain("other");
  const plan = (values: unknown[]) => ({ invalidCauseSelection: { rejectedIndices: [0, 23, -1], rejectedDomain: values } });
  return {
    codec: "shared-json-v3-prefix-v1",
    shared: { state: { untouched: { repair: { rejectedDomain: old, second: { rejectedDomain: old } } } },
      task: { planCauseChoices: { choices: [{ kind: "action", ref: "ref:action:current", slots: [0] }] } },
      repair: { candidateBinding: { sourceContextHash: contentHash("old") },
        previousOutput: { plans: [plan(old), plan(old)], markerLikeData: { rejectedDomain: { sharedRejectedDomain: 0 } } },
        issues: [{ path: ["plans", 0], originalValue: plan(old) }] } },
    slots: [{ slot: 0, delta: { repair: { previousOutput: { plans: [plan(other)] },
      issues: [{ originalValue: plan(other), reason: "Keep the rejected source" }] } } }],
  };
}

type Pool = { sourceHash: string; domains: Array<{ hash: string; values: unknown[] }>; locations: Array<{ path: Array<string | number>; domain: number }> };

it("restores complete distinct historical domains and issues without changing current scope or source", () => {
  const source = fixture(), hash = contentHash(source);
  const compact = compactRepairDiagnosticDomains(source) as typeof source & { repairDiagnosticDomains: Pool };
  expect(compact.repairDiagnosticDomains.domains.map(row => row.values)).toEqual([domain(), domain("other")]);
  expect(compact.repairDiagnosticDomains.locations).toHaveLength(5);
  expect(compact.shared.state).toEqual(source.shared.state);
  expect(compact.shared.task).toEqual(source.shared.task);
  expect(compact.shared.repair.previousOutput.markerLikeData).toEqual(source.shared.repair.previousOutput.markerLikeData);
  expect(expandRepairDiagnosticDomains(compact)).toEqual(source);
  expect(contentHash(source)).toBe(hash);
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(source).length);
  // A narrowed repair retains all old rows and memberships even though only slot 0 remains.
  expect(compact.repairDiagnosticDomains.domains[0]!.values).toContainEqual({ kind: "fact", ref: "ref:fact:23", label: "Complete historical fact 23", slots: [1, 3] });
});

it("leaves unique, small and non-repair domains inline", () => {
  for (const source of [{ shared: { repair: { rejectedDomain: domain() } } },
    { shared: { repair: { a: { rejectedDomain: [] }, b: { rejectedDomain: [] } } } },
    { shared: { state: { repair: { a: { rejectedDomain: domain() }, b: { rejectedDomain: domain() } } } } }]) {
    expect(compactRepairDiagnosticDomains(source)).toBe(source);
    expect(expandRepairDiagnosticDomains(source)).toBe(source);
  }
});

it.each(["domain", "path", "duplicate", "missing", "reference", "source", "unregistered"])("rejects corrupted diagnostic evidence: %s", mode => {
  const value = structuredClone(compactRepairDiagnosticDomains(fixture())) as ReturnType<typeof fixture> & { repairDiagnosticDomains: Pool };
  const pool = value.repairDiagnosticDomains;
  if (mode === "domain") pool.domains[0]!.values.reverse();
  if (mode === "path") pool.locations[0]!.path = ["__proto__", "repair", "rejectedDomain"];
  if (mode === "duplicate") pool.locations.push(pool.locations[0]!);
  if (mode === "missing") pool.domains.pop();
  if (mode === "reference") pool.locations[0]!.domain = 1;
  if (mode === "source") value.shared.task.planCauseChoices.choices[0]!.ref = "ref:action:changed";
  if (mode === "unregistered") pool.locations.pop();
  expect(() => expandRepairDiagnosticDomains(value)).toThrow("binding changed");
});

it("refuses repeated encoding", () => {
  expect(() => compactRepairDiagnosticDomains(compactRepairDiagnosticDomains(fixture()))).toThrow("binding changed");
});
