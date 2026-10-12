import { describe, expect, it } from "vitest";
import { programFixture } from "../../testing/program";
import { admitProgram, bindProgram } from "../definition";
import { encodeProgramDraft, lowerProgramDraft, programDraftSchema } from "../creation-codec";

describe("structured behavior creation codec", () => {
  it("uses one semantic proposition so an interrupt cannot have a contradictory second question", () => {
    const f = programFixture(), draft = encodeProgramDraft(f.definition, f.parameters);
    draft.interrupts = [{ description: "The goal is no longer active.", reads: ["task"], sourceIds: ["goal:delivery"],
      test: { kind: "semantic" }, unknown: "wait" }];
    const result = lowerProgramDraft(draft, "agent-a");
    expect(result.definition.predicates.find(predicate => predicate.id === result.definition.interrupts[0])).toMatchObject({
      description: "The goal is no longer active.", test: { kind: "semantic", instructions: "The goal is no longer active." },
    });
    const conflicting = structuredClone(draft) as unknown as { interrupts: Array<{ test: Record<string, unknown> }> };
    conflicting.interrupts[0]!.test.instructions = "The goal is still active.";
    expect(programDraftSchema([...f.entities]).safeParse(conflicting).success).toBe(false);
  });
  it("derives node identities, condition identities and read closure without changing the authored acts", () => {
    const f = programFixture(), draft = encodeProgramDraft(f.definition, f.parameters);
    draft.dependencies = [];
    const lowered = lowerProgramDraft(draft, "agent-a"), program = admitProgram(lowered.definition, f.admission);
    expect(bindProgram(program, lowered.parameters, f.entities)).toEqual(f.parameters);
    expect(program.definition.nodes.filter(node => node.kind === "attempt").map(node => node.intent))
      .toEqual(f.definition.nodes.filter(node => node.kind === "attempt").map(node => node.intent));
    expect(program.definition.reads).toEqual(["contact", "self", "task"]);
    expect(program.definition.predicates).toHaveLength(3);
    expect(new Set(program.definition.nodes.map(node => node.id)).size).toBe(program.definition.nodes.length);
  });
  it("gives repeated nested leaves distinct parents and interns the same concrete condition", () => {
    const f = programFixture(), draft = encodeProgramDraft(f.definition, f.parameters);
    const accepted = draft.milestones[0]!.condition;
    draft.body = { kind: "branch", condition: accepted,
      yes: { kind: "wait", condition: accepted, deadlineSeconds: null }, no: { kind: "finish" } };
    const lowered = lowerProgramDraft(draft, "agent-a");
    expect(() => admitProgram(lowered.definition, f.admission)).not.toThrow();
    expect(lowered.definition.nodes.filter(node => node.kind === "wait" || node.kind === "branch")
      .map(node => node.predicateId)).toEqual([lowered.definition.milestones[0]!.predicateId, lowered.definition.milestones[0]!.predicateId]);
  });
  it("rejects unknown entity values at the wire boundary and rejects unprovided resource authority", () => {
    const f = programFixture(), draft = encodeProgramDraft(f.definition, f.parameters);
    draft.parameters.recipient!.value = "not-a-known-entity";
    expect(() => programDraftSchema([...f.entities]).parse(draft)).toThrow();
    draft.parameters.recipient!.value = "local:recipient";
    draft.start.reads.push("another-agent:hidden");
    expect(() => admitProgram(lowerProgramDraft(draft, "agent-a").definition, f.admission)).toThrow();
  });
  it("binds nested wire references to the exact authorized resource, source and goal catalogs", () => {
    const f = programFixture(), draft = encodeProgramDraft(f.definition, f.parameters);
    const schema = programDraftSchema([...f.entities], { resources: [...f.admission.resources], sources: [...f.admission.sources.keys()], goals: [...f.admission.goalIds] });
    expect(() => schema.parse(draft)).not.toThrow();
    draft.body = { kind: "wait", condition: { ...draft.start, reads: ["self.location"] }, deadlineSeconds: null };
    expect(() => schema.parse(draft)).toThrow();
    draft.body = { kind: "wait", condition: { ...draft.start, sourceIds: ["foreign-source"] }, deadlineSeconds: null };
    expect(() => schema.parse(draft)).toThrow();
  });
});
