import { z } from "zod";
import { resolutionPlanDraftSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { assertJsonValue } from "../../runtime/json";
import { ActionOwnedPlanCodec, decodePlanFactor } from "./action-owned-plan";
import { FlatTruthBatchCodec } from "./flat-truth-batch";
import { scoreRepairTail, type RepairTailKind } from "./repair-tail";

type Path = Array<string | number>;
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => v !== null && typeof v === "object" && !Array.isArray(v);
const pointer = (p: Path) => "/" + p.map(k => String(k).replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
const prefix = (p: Path, root: Path) => root.length <= p.length && root.every((k, i) => String(k) === String(p[i]));
function at(value: unknown, path: Path): unknown {
  let node = value;
  for (const key of path) {
    if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) throw new Error("repair path does not identify existing output");
    node = (node as ObjectValue)[key];
  }
  return node;
}
export interface TruthRepairTarget { path: Path; pointer: string; valueHash: string; reason: string }

/** Diagnose independent plans before aggregate decoding, so one invalid factor
 * cannot conceal other plans' schema/reference failures. A plan is the coupled
 * semantic repair unit; choosing a different difficulty may also change mode. */
export function observeOwnedPlanRepairUnits(wire: unknown, codec: ActionOwnedPlanCodec, contexts: readonly unknown[]): TruthRepairTarget[] {
  if (!object(wire) || Object.keys(wire).sort().join(",") !== "kind,plans,slots" || wire.kind !== "commit_plans" || !object(wire.plans) || contentHash(Object.keys(wire.plans).sort()) !== contentHash(codec.bindings.map(b => b.key).sort())) throw new Error("complete unambiguous owned plan map required");
  const slots = z.array(z.number().int().min(0).max(contexts.length - 1)).length(contexts.length).parse(wire.slots);
  if (new Set(slots).size !== contexts.length || codec.count !== contexts.length) throw new Error("ambiguous slot ownership cannot be patched");
  const targets: TruthRepairTarget[] = [];
  for (const binding of codec.bindings) {
    const plan = wire.plans[binding.key];
    if (!object(plan) || Object.hasOwn(plan, "slot") || Object.hasOwn(plan, "actionRef")) throw new Error("action-owned identity cannot be patched");
    const faults: string[] = [];
    try {
      const factors = z.array(z.unknown()).parse(plan.factors).map(factor => decodePlanFactor(factor, codec.allowConsistentConstants));
      resolutionPlanDraftSchema.parse({ ...plan, actionRef: binding.actionRef, factors });
    } catch (error) { faults.push(error instanceof Error ? error.message : String(error)); }
    const context = z.object({ referenceCatalog: z.object({ candidates: z.array(z.object({ handle: z.string() })) }) }).parse(contexts[binding.slot]);
    const allowed = new Set(context.referenceCatalog.candidates.map(c => c.handle));
    const visit = (value: unknown, path: Path, field = ""): void => {
      if (typeof value === "string" && (field === "ref" || /Refs?$/u.test(field)) && value.startsWith("ref:") && !allowed.has(value)) faults.push(`${pointer(path)}: Reference ${value} is outside original slot ${binding.slot}`);
      else if (Array.isArray(value)) value.forEach((item, i) => visit(item, [...path, i], field));
      else if (object(value)) Object.entries(value).forEach(([key, item]) => visit(item, [...path, key], key));
    };
    visit(plan, ["plans", binding.key]);
    if (faults.length) {
      const path: Path = ["plans", binding.key];
      targets.push({ path, pointer: pointer(path), valueHash: contentHash(plan), reason: faults.join("\n") });
    }
  }
  return targets;
}

/** Paths originate in validators, never in the repair model's discretion.
 * These maps trace existing canonical rows back to their exact wire owner. */
export function observeTruthRepairTargets(wire: unknown, codec: ActionOwnedPlanCodec | FlatTruthBatchCodec, kind: RepairTailKind, contexts: readonly unknown[]) {
  if (!object(wire)) throw new Error("parsed complete wire object required");
  const slots = z.array(z.number().int().min(0).max(contexts.length - 1)).length(contexts.length).parse(wire.slots);
  if (new Set(slots).size !== contexts.length) throw new Error("ambiguous slot ownership cannot be patched");
  const mappings: Array<{ canonical: Path; wire: Path }> = [];
  const faults: Array<{ path: Path; reason: string }> = [];
  if (codec instanceof ActionOwnedPlanCodec) {
    if (Object.keys(wire).sort().join(",") !== "kind,plans,slots" || wire.kind !== "commit_plans" || !object(wire.plans) || contentHash(Object.keys(wire.plans).sort()) !== contentHash(codec.bindings.map(b => b.key).sort())) throw new Error("ambiguous action ownership cannot be patched");
    const counts = new Map<number, number>();
    for (const [key, plan] of Object.entries(wire.plans)) {
      if (!object(plan) || Object.hasOwn(plan, "slot") || Object.hasOwn(plan, "actionRef") || !Array.isArray(plan.factors)) throw new Error("owned action shape cannot be patched safely");
      const binding = codec.bindings.find(b => b.key === key)!;
      const index = counts.get(binding.slot) ?? 0;counts.set(binding.slot, index + 1);
      mappings.push({ canonical: ["slots", slots.indexOf(binding.slot), "result", "plans", index], wire: ["plans", key] });
      if (object(plan) && Array.isArray(plan.factors)) plan.factors.forEach((factor, i) => {
        try { decodePlanFactor(factor, codec.allowConsistentConstants); }
        catch (error) { faults.push({ path: ["plans", key, "factors", i], reason: String(error) }); }
      });
    }
  } else {
    for (const [column, rows] of Object.entries(wire)) {
      if (column === "slots" || !Array.isArray(rows)) continue;
      const counts = new Map<number, number>();
      for (const [index, row] of rows.entries()) {
        if (!object(row) || !Number.isInteger(row.slot) || !slots.includes(row.slot as number)) throw new Error("ambiguous flat row ownership cannot be patched");
        const slot = row.slot as number, local = counts.get(slot) ?? 0;counts.set(slot, local + 1);
        mappings.push({ canonical: ["slots", slots.indexOf(slot), "result", column, local], wire: [column, index] });
      }
    }
  }
  const map = (path: Path): Path => {
    const match = mappings.find(m => prefix(path, m.canonical));
    if (!match) throw new Error("fault is outside a uniquely owned existing row; full repair required");
    return [...match.wire, ...path.slice(match.canonical.length)];
  };
  let decoded: ReturnType<FlatTruthBatchCodec["decode"]> | undefined;
  if (!faults.length) {
    try { decoded = codec.decode(wire); }
    catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      for (const issue of error.issues) {
        let path = map(issue.path.map(k => typeof k === "number" ? k : String(k)));
        // A source discriminant and its reference are one coupled choice.
        if (path.at(-1) === "kind" && object(at(wire, path.slice(0, -1))) && Object.hasOwn(at(wire, path.slice(0, -1)) as object, "ref")) path = path.slice(0, -1);
        try { at(wire, path); } catch { path = path.slice(0, -1);at(wire, path); }
        faults.push({ path, reason: `${issue.code}: ${issue.message}` });
      }
    }
  }
  if (decoded) {
    for (const [index, slot] of decoded.slots.entries()) {
      const context = z.object({ referenceCatalog: z.object({ candidates: z.array(z.object({ handle: z.string() })) }) }).parse(contexts[slot.slot]);
      const allowed = new Set(context.referenceCatalog.candidates.map(c => c.handle));
      const visit = (value: unknown, path: Path, field = ""): void => {
        if (typeof value === "string" && (field === "ref" || /Refs?$/u.test(field)) && value.startsWith("ref:") && !allowed.has(value)) faults.push({ path: map(path), reason: `Reference ${value} is outside original slot ${slot.slot}` });
        else if (Array.isArray(value)) value.forEach((item, i) => visit(item, [...path, i], field));
        else if (object(value)) Object.entries(value).forEach(([key, item]) => visit(item, [...path, key], key));
      };
      visit(slot.result, ["slots", index, "result"]);
    }
    if (!faults.length && !scoreRepairTail(JSON.stringify(decoded), kind, contexts).schemaCoverageReferences) throw new Error("action coverage cannot be patched by changing source-owned identity");
  }
  const unique = faults.sort((a, b) => a.path.length - b.path.length || pointer(a.path).localeCompare(pointer(b.path)))
    .filter((fault, index, all) => !all.slice(0, index).some(parent => prefix(fault.path, parent.path)));
  return unique.map(({ path, reason }): TruthRepairTarget => ({ path, pointer: pointer(path), valueHash: contentHash(at(wire, path)), reason }));
}

/** Apply only explicitly requested existing-subtree replacements. Every other
 * byte-equivalent JSON value stays untouched, including valid sibling actions. */
export function applyTruthReplacements(wire: unknown, targets: readonly TruthRepairTarget[], reply: unknown) {
  assertJsonValue(wire, "repair source");assertJsonValue(reply, "repair reply");
  if (!targets.length || new Set(targets.map(t => t.pointer)).size !== targets.length || targets.some((t, i) =>
    !t.path.length || t.pointer !== pointer(t.path) || targets.some((other, j) => i !== j && prefix(t.path, other.path)))) throw new Error("repair target set is ambiguous");
  const parsed = z.strictObject({ replacements: z.array(z.strictObject({ path: z.string(), value: z.json() })).length(targets.length) }).parse(reply);
  if (new Set(parsed.replacements.map(p => p.path)).size !== targets.length || parsed.replacements.some(p => !targets.some(t => t.pointer === p.path))) throw new Error("repair attempted an unrequested or duplicate path");
  const result = structuredClone(wire);
  for (const target of targets) {
    if (contentHash(at(wire, target.path)) !== target.valueHash) throw new Error("repair source snapshot changed");
    const parent = at(result, target.path.slice(0, -1));
    const replacement = parsed.replacements.find(p => p.path === target.pointer)!;
    Object.defineProperty(parent, target.path.at(-1)!, { value: structuredClone(replacement.value), enumerable: true, writable: true, configurable: true });
  }
  return result;
}
