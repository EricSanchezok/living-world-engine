import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { recordedContext } from "../../src/engine/benchmarks/step-efficiency/repair-tail";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { parseLosslessExperimentJson } from "../../src/engine/benchmarks/action-compilation/lossless-json";
import { CAUSAL_OBSERVATION_COVERAGE_INSTRUCTION, prepareCausalObservationCoverage } from "../../src/engine/mechanics/causal-observation-coverage";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { countDeepSeekContext } from "./deepseek-context-admission";
import { probeInferenceEvidence } from "./step-json-probe";

const ROOT=path.resolve(STEP_E2_PROTOCOL.root), TRIAL="review-e2-observation-coverage-01";
const SOURCE_BODY="8139593459399f99066bf96685fb673eeaedd473898b4b9a48b7d3166d99cdd7";
const bodySchema=z.object({model:z.literal("deepseek-v4-flash"),thinking:z.object({type:z.literal("disabled")}),
  max_tokens:z.literal(131072),messages:z.array(z.object({role:z.enum(["system","user"]),content:z.string()}))}).passthrough();

export async function prepareObservationCoverageProbe() {
  const recorded=JSON.parse(readFileSync(path.join(ROOT,"http/trajectory-e2-19-http-033/request.json"),"utf8"));
  if(recorded.bodyHash!==SOURCE_BODY || contentHash(recorded.body)!==SOURCE_BODY)throw new Error("recorded final review changed");
  const original=bodySchema.parse(recorded.body), userIndex=original.messages.findIndex(message=>message.role==="user");
  if(userIndex<0)throw new Error("user context missing");
  const originalMessage=original.messages[userIndex]!.content, source=recordedContext(originalMessage).value;
  const cases: Array<{id:string;expected:"supported"|"not-supported"|null;context:unknown;targetRef:string|null}>=[];
  for(const [pair,observer] of [["owner","ref:agent:master-corvin-hale"],["realization","ref:agent:autarch-elana"]] as const) {
    const base=prepareCausalObservationCoverage(source).context;
    const observation=base.state.candidate.observations.find(item=>item.observerRef===observer)!;
    const ownAction=base.state.actionSet.available.find(action=>action.actorRef===observer)!;
    const outcome=base.state.candidate.outcomes.find(item=>item.actionRef===ownAction.actionRef)!;
    outcome.summary=pair==="owner"?"Corvin 正准备前往会见 Causari，尚未提出请愿或取得任何回复。":"Elana 正准备向指挥官发送短笺，尚未发出或收到回复。";
    observation.summary=pair==="owner"?"我正准备去见 Causari，打算提出请愿，目前尚未取得任何回复。":"我正在准备向指挥官发送短笺，尚未发出，也没有收到回复。";
    observation.apparentClaims=pair==="owner"?[{subjectRef:"ref:local_entity:master-corvin-hale::self",predicate:"intends-to-propose",value:{kind:"text",value:"打算提出共同请愿"},description:"这是我的提议意图，尚未实现。"}]:[];
    base.referenceCatalog.candidates.find(entry=>entry.handle===outcome.outcomeRef)!.label=String(outcome.summary);
    Reflect.deleteProperty(base.task,"observationReviewWorklist");
    for(const negative of [false,true]) {
      const context=structuredClone(base), target=context.state.candidate.observations.find(item=>item.observerRef===observer)!;
      if(negative && pair==="owner") target.apparentClaims[0]!.subjectRef="ref:local_entity:master-corvin-hale::causari";
      if(negative && pair==="realization") target.summary="Rinisar 已收到我的短笺并送回书面答复，同意了全部补给要求和回报条款。";
      context.referenceCatalog.candidates.find(entry=>entry.handle===target.observationRef)!.label=String(target.summary);
      cases.push({id:`${pair}-${negative?"unsupported":"pending"}`,expected:negative?"not-supported":"supported",context,targetRef:target.observationRef});
    }
  }
  cases.push({id:"original-candidate",expected:null,context:source,targetRef:null});
  const prepared=[];
  for(const entry of cases) {
    const coverage=prepareCausalObservationCoverage(entry.context), body=structuredClone(original);
    const system=body.messages.find(message=>message.role==="system");if(!system)throw new Error("system missing");
    system.content+=`\n\n${CAUSAL_OBSERVATION_COVERAGE_INSTRUCTION}`;
    const boundary=recordedContext(originalMessage);
    const schemaStart=originalMessage.indexOf("\nJSON Schema: ",boundary.end);
    if(schemaStart<0)throw new Error("schema boundary missing");
    const schemaEnd=originalMessage.indexOf("\n",schemaStart+1);
    const suffix=schemaEnd<0?"":originalMessage.slice(schemaEnd);
    body.messages[userIndex]!.content=originalMessage.slice(0,boundary.start)+JSON.stringify(coverage.context)+
      originalMessage.slice(boundary.end,schemaStart)+"\nJSON Schema: "+JSON.stringify(z.toJSONSchema(coverage.schema,{target:"draft-07"}))+suffix;
    const admission=await countDeepSeekContext(body);
    prepared.push({...entry,coverage,body,admission});
  }
  const maximumRunNanoCny=5*(STEP_E2_PROTOCOL.inputTokenCeiling*STEP_E2_BUDGET.inputMissNanoCnyPerToken+
    STEP_E2_PROTOCOL.outputTokenCeiling*STEP_E2_BUDGET.outputNanoCnyPerToken);
  const manifest={trialId:TRIAL,sourceBodyHash:SOURCE_BODY,maximumRunNanoCny,maxHttp:5,
    controls:prepared.map(({id,expected,targetRef,context,body,admission})=>({id,expected,targetRef,contextHash:contentHash(context),bodyHash:contentHash(body),admission})),
    interpretation:"Four authored development controls score only designated observations; other judgments are not gold. Original candidate runs only after 4/4 valid first-response classifications. Full context preserved. No gameplay, runtime integration, held-out calibration or comparative-efficiency claim."};
  return {prepared,manifest};
}

async function main() {
  const command=process.argv[2];if(process.argv.length!==3 || !["prepare","run"].includes(command??""))throw new Error("usage: step-observation-coverage-probe.ts prepare|run");
  const {prepared,manifest}=await prepareObservationCoverageProbe();
  if(command==="prepare"){console.log(JSON.stringify(manifest,null,2));return;}
  if(execFileSync("git",["status","--porcelain"],{encoding:"utf8"}).trim())throw new Error("commit checked code before paid probe");
  const directory=path.join(ROOT,"runs",TRIAL), lock=path.join(ROOT,"writer.lock");
  if(existsSync(directory))throw new Error("frozen probe cannot restart");
  closeSync(openSync(lock,"wx"));
  const results:Array<Record<string,unknown>>=[];
  let status="preparing",failure:string|undefined,stopped=false,dispatches=0,budget:ExperimentBudget|undefined;
  const stop=()=>{stopped=true;};process.on("SIGINT",stop);process.on("SIGTERM",stop);
  const report=()=>writeFileSync(path.join(directory,"report.json"),JSON.stringify({...manifest,status,failure,dispatches,results,budget:budget?.summary},null,2));
  try {
    mkdirSync(directory,{recursive:true});
    budget=new ExperimentBudget(path.join(ROOT,"budget.jsonl"),STEP_E2_BUDGET);budget.assertRunCapacity("review",manifest.maximumRunNanoCny);
    const catalog=loadModelCatalog(path.join(ROOT,"variants/short-action-checkpoints-01/model-catalog.json")),account=catalog.account("deepseek-api");
    const credential=process.env[account.api_key_env];if(!credential)throw new Error("configured credential missing");
    const send=createModelFetchResolver(process.env)("deepseek-api",account)??fetch;
    const transport=new FirstPassExperimentTransport(budget,{root:ROOT,baseUrl:account.base_url,
      fetch:async(input,init)=>{dispatches++;report();return send(input,init);},
      inputTokenCeiling:STEP_E2_PROTOCOL.inputTokenCeiling,outputTokenCeiling:STEP_E2_PROTOCOL.outputTokenCeiling,
      trialPattern:new RegExp(`^${TRIAL}$`,"u"),requireThinkingDisabled:true,
      priceBinding:{accountId:"deepseek-api",modelId:STEP_E2_PROTOCOL.model,priceId:"flash"}});
    writeFileSync(path.join(directory,"manifest.json"),JSON.stringify({...manifest,commit:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim()},null,2),{flag:"wx"});
    writeFileSync(path.join(directory,"bodies.json.gz"),gzipSync(JSON.stringify(prepared.map(item=>item.body))),{flag:"wx"});
    transport.beginTrial(TRIAL,"review");status="running";report();
    for(const item of prepared) {
      if(stopped||dispatches>=5)throw new Error("probe stopped before dispatch");
      if(item.expected===null && results.some(row=>row.correct!==true)){status="controls-failed";break;}
      const response=await transport.fetch(`${account.base_url.replace(/\/$/u,"")}/chat/completions`,{method:"POST",
        headers:{Authorization:`Bearer ${credential}`,"Content-Type":"application/json"},body:JSON.stringify(item.body)});
      if(!response.ok)throw new Error(`provider HTTP ${response.status}`);
      const raw=await response.json();const inference=probeInferenceEvidence(raw,"B");if(!inference.inferenceValid)throw new Error("model/thinking response mismatch");
      try {
        const parsed=parseLosslessExperimentJson(raw.choices[0].message.content),coverage=item.coverage.validate(parsed.value);
        const check=coverage.checks.find(check=>check.observationRef===item.targetRef);
        if(item.targetRef && !check)throw new Error("designated observation check missing");
        const correct=item.expected===null?null:item.expected==="supported"?check?.verdict==="supported":check?.verdict!=="supported";
        results.push({id:item.id,correct,coverage,inference});
      }catch(error){results.push({id:item.id,correct:false,error:String(error),inference});}
      report();
    }
    if(status==="running")status="completed";
  }catch(error){status="stopped";failure=String(error);process.exitCode=1;}
  finally{report();process.off("SIGINT",stop);process.off("SIGTERM",stop);unlinkSync(lock);}
  console.log(JSON.stringify({trialId:TRIAL,status,failure,dispatches,results:results.map(({id,correct,error})=>({id,correct,error}))}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error);process.exitCode=1;});
