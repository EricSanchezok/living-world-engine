import { expect, it } from "vitest";
import { resolutionPlanCommitDirectiveSchema } from "../../src/engine/contracts/llm-schemas";
import { factorSharedBatchContexts } from "../../src/engine/mechanics/shared-batch-context";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { assertCheckRepairDelta, checkFeedbackDecision } from "./step-check-feedback-probe";

const rows = () => [{ rootId: "007", complete: true, retainedFromHistoricalFirstResponse: 7, newHttp: 0, unknownUsageRequests: 0 },
  { rootId: "041", complete: true, retainedFromHistoricalFirstResponse: 29, newHttp: 1, unknownUsageRequests: 0 }];
it("requires the uncharged control, exact initial retention and bounded known repair HTTP", () => {
  expect(checkFeedbackDecision(rows(), false)).toBe("eligible-for-source-semantic-review");
  const failed = rows(); failed[1]!.complete = false;
  expect(checkFeedbackDecision(failed, false)).toBe("failed");
  expect(checkFeedbackDecision(rows(), true)).toBe("inconclusive");
  for (const patch of [{newHttp:3},{newHttp:0},{unknownUsageRequests:1},{retainedFromHistoricalFirstResponse:30}]) {
    const changed = rows(); changed[1] = {...changed[1]!,...patch};
    expect(checkFeedbackDecision(changed,false)).toBe("inconclusive");
  }
  const chargedControl=rows();chargedControl[0]!.newHttp=1;
  expect(checkFeedbackDecision(chargedControl,false)).toBe("inconclusive");
});

it("allows only the exact missing-stakes diagnostic additions while preserving full source and existing output", () => {
  const contexts = [6,4].map(index => ({ state: { facts:["source fact"], previousOutput:{mode:"check",primaryEffect:null,threatenedEffect:null} },
    task: { constraints:[`plan p${index} requires a non-none primary effect`] }, repair:{issues:[{code:"Error",class:"semantic",path:["plans",index],
      originalValue:null,allowedHandles:[],reason:`plan p${index} requires a non-none primary effect`}]}}));
  const evidence = (values: unknown[]) => admissionRequestEvidence({profileId:"truth-engine",workloadId:"world",batchId:"step",role:"truth-resolution",subjectId:"batch",
    schemaName:"truth_resolution_plan_commit_batch",schema:resolutionPlanCommitDirectiveSchema,promptVersion:"test",system:"test",userPrompt:"test",context:{state:factorSharedBatchContexts(values,"shared-json-v3")}});
  const old=evidence(contexts), corrected=structuredClone(contexts);
  for(const value of corrected){const issue=value.repair.issues[0]!, reason=issue.reason.replace("requires a non-none primary effect","has no failure threat");
    value.repair.issues=[{...issue,code:"resolution_check_primary_effect",path:[...issue.path,"primaryEffect"]},{...issue,code:"resolution_check_threatened_effect",path:[...issue.path,"threatenedEffect"],reason}];
    value.task.constraints.push(reason);}
  expect(()=>assertCheckRepairDelta(old,evidence(corrected))).not.toThrow();
  corrected[0]!.state.facts.push("new fact");
  expect(()=>assertCheckRepairDelta(old,evidence(corrected))).toThrow("beyond the exact");
  corrected[0]!.state.facts.pop();corrected[0]!.repair.issues.pop();
  expect(()=>assertCheckRepairDelta(old,evidence(corrected))).toThrow("beyond the exact");
  expect(()=>assertCheckRepairDelta(old,{...evidence(contexts),promptVersion:"different"})).toThrow("metadata");
});
