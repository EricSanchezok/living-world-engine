import { expect, it } from "vitest";
import { z } from "zod";
import { canonicalize } from "../models/model-audit";
import { composeJsonObjectPrompt, structuredPromptBytes } from ".";
import { PHYSICAL_BATCH_REPAIR_NOTICE, repairPromptLayout } from "./repair-layout";
import { logicalRepairContext, LOGICAL_CANDIDATE_REPAIR_NOTICE } from "./logical-repair-context";

it("keeps an initial request as the exact repair prefix and retains every feedback byte", () => {
  const original = { z: ["complete action", "second action"], a: { state: "unchanged" } };
  const feedback = { expectedSlots: [0, 1], previousOutput: '{"slots": [', issues: [{ message: "Missing slot 1; do not omit source constraints" }] };
  const base = JSON.stringify(canonicalize(original));
  const full = JSON.stringify(canonicalize({ ...original, batchRepair: feedback }));
  const layout = repairPromptLayout(`Task\n\n${PHYSICAL_BATCH_REPAIR_NOTICE}`, full, "tail-v1");
  const render = (userPrompt: string, contextJson: string) => composeJsonObjectPrompt({ userPrompt, contextJson, discriminator: "Explicit kind", schemaJson: '{"type":"object"}', exampleJson: "{}" });
  expect(render(layout.userPrompt, layout.contextJson) + layout.tail).toBe(`${render("Task", base)}\n\n${PHYSICAL_BATCH_REPAIR_NOTICE}\n\n${JSON.stringify({ batchRepair: canonicalize(feedback) })}`);
  const measured = structuredPromptBytes({ system: "System", userPrompt: `Task\n\n${PHYSICAL_BATCH_REPAIR_NOTICE}`, context: { ...original, batchRepair: feedback }, schema: z.object({}), repairContextPlacement: "tail-v1" });
  expect(measured.contextJson).toBe(full);
  expect(measured.userMessage).toContain(layout.tail);
  expect(measured.requestUtf8Bytes).toBeGreaterThan(Buffer.byteLength(full));
});

it("rejects missing or misplaced physical feedback and preserves default rendering", () => {
  expect(repairPromptLayout("Task", '{"a":1}')).toEqual({ userPrompt: "Task", contextJson: '{"a":1}', tail: "" });
  expect(() => repairPromptLayout("Task", '{"batchRepair":{}}', "tail-v1")).toThrow(/instruction/u);
  expect(() => repairPromptLayout(`Task\n\n${PHYSICAL_BATCH_REPAIR_NOTICE}`, "{}", "tail-v1")).toThrow(/feedback/u);
});

it("preserves adapter instructions after the unique physical repair paragraph", () => {
  const task = "Keep both complete source actions.", adapter = "Decode every original catalog field and preserve its order.";
  const full = JSON.stringify({ state: { actions: ["first", "second"] }, batchRepair: { expectedSlots: [0, 1], issues: ["bad slots"] } });
  const result = repairPromptLayout(`${task}\n\n${PHYSICAL_BATCH_REPAIR_NOTICE}\n\n${adapter}`, full, "tail-v1");
  expect(result.userPrompt).toBe(`${task}\n\n${adapter}`);
  expect(JSON.parse(result.contextJson)).toEqual({ state: { actions: ["first", "second"] } });
  expect(result.tail).toBe(`\n\n${PHYSICAL_BATCH_REPAIR_NOTICE}\n\n${JSON.stringify({ batchRepair: { expectedSlots: [0, 1], issues: ["bad slots"] } })}`);
  for (const invalid of [`${task} ${PHYSICAL_BATCH_REPAIR_NOTICE}`, `${task}\n\n${PHYSICAL_BATCH_REPAIR_NOTICE} continuation`,
    `${task}\n\n${PHYSICAL_BATCH_REPAIR_NOTICE}\n\n${PHYSICAL_BATCH_REPAIR_NOTICE}`]) {
    expect(() => repairPromptLayout(invalid, full, "tail-v1")).toThrow("instruction mismatch");
  }
});

it("relocates only bound logical feedback and its notice, rejecting mixed or incomplete ownership", () => {
  const source = { task: { constraints: ["Keep two complete actions"] }, state: { actions: ["first", "second"] }, repair: { issues: ["missing field"] } };
  const context = logicalRepairContext(source, { attempt: 1, scope: "step", targetIds: [], issues: [], previousOutput: { outcomes: [] } }, "source-hash", "truth_transition");
  const layout = repairPromptLayout("Task", JSON.stringify(context), "logical-tail-v1");
  const restored = JSON.parse(layout.contextJson);
  Object.assign(restored, JSON.parse(layout.tail.slice(layout.tail.lastIndexOf("\n\n") + 2)));
  restored.task.constraints.push(LOGICAL_CANDIDATE_REPAIR_NOTICE);
  expect(restored).toEqual(context);
  for (const broken of [source, { ...restored, batchRepair: {} }, { ...restored, repair: null },
    { ...restored, task: { constraints: [LOGICAL_CANDIDATE_REPAIR_NOTICE, LOGICAL_CANDIDATE_REPAIR_NOTICE] } }]) {
    expect(() => repairPromptLayout("Task", JSON.stringify(broken), "logical-tail-v1")).toThrow(/logical repair feedback/u);
  }
});
