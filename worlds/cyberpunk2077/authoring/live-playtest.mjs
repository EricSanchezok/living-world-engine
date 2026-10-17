import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { LocalDatabase } from '../../../src/server/local-database.ts';
import { readDirectState } from '../../../src/engine/direct/state.ts';
import { replaySimulationState } from '../../../src/engine/runtime/transaction.ts';
import { liveCases } from './live-cases.mjs';

const args=process.argv.slice(2);
const option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const api=option('--api','http://127.0.0.1:3107');
const tag=option('--tag',new Date().toISOString().replace(/[:.]/g,'-'));
if(!/^[\w-]+$/.test(tag)) throw new Error('tag must contain only letters, digits, underscores and hyphens');
const resume=args.includes('--resume');
const continueAfterFailure=args.includes('--continue-after-failure');
const retryFailedStep=option('--retry-failed-step','');
if(retryFailedStep&&!resume)throw new Error('--retry-failed-step requires --resume');
if(continueAfterFailure&&!resume)throw new Error('--continue-after-failure requires --resume');
const selected=option('--roles','').split(',').filter(Boolean);
const cases=liveCases.filter(c=>!selected.length||selected.includes(c.role));
if(!cases.length||selected.some(id=>!liveCases.some(c=>c.role===id))) throw new Error('unknown role');
const concurrency=Number(option('--concurrency','2'));
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4) throw new Error('concurrency must be 1..4');
const root=path.resolve('worlds/cyberpunk2077/.acceptance/live-origins',tag);
fs.mkdirSync(root,{recursive:true});
const databasePath=path.resolve(option('--database','.livingworld-v23/livingworld.sqlite'));
const database=new LocalDatabase(databasePath,{readOnly:true});
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const roles=JSON.parse(fs.readFileSync('worlds/cyberpunk2077/authoring/playable-roles.json','utf8'));
const save=(file,data)=>fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function request(route,method='GET',body){
 let response;
 for(let attempt=0;;attempt++){
  try{response=await fetch(api+route,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(120000)});break;}
  catch(error){
   if(method!=='GET'||attempt>=2)throw error;
   fs.appendFileSync(path.join(root,'http-retries.ndjson'),JSON.stringify({at:new Date().toISOString(),route,attempt:attempt+1,error:String(error),cause:String(error.cause)})+'\n');
   await sleep(500*(attempt+1));
  }
 }
 const text=await response.text();
 if(!response.ok) throw new Error(`${method} ${route}: ${response.status}: ${text.slice(0,800)}`);
 return text?JSON.parse(text):null;
}
function concise(before,after){
 const records=after.history.filter(h=>h.revision>before.revision);
 const quantities=Object.values(after.truth.quantities).flatMap(q=>{const old=before.truth.quantities[q.id]?.amount??0;return q.amount!==old?[{holder:q.holderId,resource:q.definitionId,before:old,after:q.amount}]:[];});
 const facts=Object.values(after.truth.facts).filter(f=>JSON.stringify(f)!==JSON.stringify(before.truth.facts[f.id]));
 const meters=Object.values(after.truth.meters).flatMap(m=>{const old=before.truth.meters[m.id]?.current;return old!==m.current?[{entity:m.entityId,meter:m.definitionId,before:old,after:m.current}]:[];});
 const interactions=records.flatMap(h=>h.directEvent?.frames??[]).map(f=>({id:f.id,actor:f.actorId,kind:f.kind,target:f.targetEntityId,tool:f.toolEntityId,amount:f.amount,resource:f.quantityDefinitionId,utterance:f.utterance,expression:f.expression,request:f.proposal.rawText}));
 return {revision:after.revision,step:after.step,elapsedSeconds:after.truth.elapsedSeconds,quantities,meters,facts,interactions,
   outcomes:records.flatMap(h=>h.directEvent?.settlements??h.outcomes??[]),
   operations:records.flatMap(h=>h.operations),observations:records.flatMap(h=>h.observations??[])};
}
async function run(test){
 const dir=path.join(root,test.role);fs.mkdirSync(dir,{recursive:true});
 const sessionPath=path.join(dir,'session.json');
 let session,initial;
 if(fs.existsSync(sessionPath)){
  if(!resume)throw new Error(`existing session must be inspected before rerun: ${sessionPath}`);
  session=JSON.parse(fs.readFileSync(sessionPath,'utf8'));
  initial=JSON.parse(fs.readFileSync(path.join(dir,'initial-state.json'),'utf8'));
  session.recoveries??=[];session.recoveries.push({at:new Date().toISOString(),commit,previousStatus:session.status,previousReplayMatches:session.replayMatches??null,error:session.error??null});
  session.status='running';delete session.error;delete session.finishedAt;delete session.replayMatches;
 }else{
  const created=await request('/api/instances','POST',{worldId:'cyberpunk2077-night-city',title:`真实开场验收 ${tag} ${test.role}`,seed:20771017,start:{kind:'observer'}});
  const id=created.summary.id;
  const taken=await request(`/api/instances/${id}/control`,'PUT',{expectedRevision:0,target:{kind:'agent',agentId:test.role}});
  initial=database.readInstance(id).document.state;
  const role=roles.find(r=>r.id===test.role);
  session={commit,tag,role:test.role,instanceId:id,participantId:taken.conversation.participantId,worldHash:initial.worldHash,worldModels:readDirectState(initial.executionState,initial).models,agentModels:initial.agents[test.role].modelProfiles,startedAt:new Date().toISOString(),steps:[],status:'running'};
  save(path.join(dir,'initial-state.json'),initial);
  const amount=(holder)=>Object.values(initial.truth.quantities).find(q=>q.holderId===holder&&q.definitionId==='eurodollar')?.amount;
  session.initialChecks={cash:amount(test.role)===role.cash,placement:initial.truth.placements[test.role]===role.work,
   assets:role.assets.every(id=>initial.truth.entities[id]&&Object.values(initial.agents[test.role].bindings).some(b=>b.canonicalEntityIds.includes(id))),
   reciprocalContacts:role.contacts.every(id=>Object.values(initial.agents[id].bindings).some(b=>b.canonicalEntityIds.includes(test.role))&&Object.values(initial.agents[test.role].bindings).some(b=>b.canonicalEntityIds.includes(id)))};
 }
 const {instanceId:id,participantId}=session;
 save(sessionPath,session);
 try {
  if(Object.values(session.initialChecks).some(passed=>!passed)) throw new Error('initial resources or contacts differ from authored role');
  for(const [name,text] of test.steps){
   let prior=session.steps.find(step=>step.name===name);
   let retryOf;
   if(prior?.finishedAt&&prior.runStatus==='failed'&&retryFailedStep===name){
    if(prior.text!==text)throw new Error('retry must preserve the original natural-language action');
    const archivedName=`${name}-failed-${session.steps.filter(step=>step.name.startsWith(name+'-failed-')).length+1}`;
    for(const suffix of ['before-state','state','response','evidence']){
     const source=path.join(dir,`${name}-${suffix}.json`),target=path.join(dir,`${archivedName}-${suffix}.json`);
     if(fs.existsSync(source))fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
    }
    prior.originalName=name;prior.name=archivedName;retryOf=prior.submissionId;
    session.continuedAfterFailures??=[];session.continuedAfterFailures.push(archivedName);
    prior=undefined;
   }
   if(prior?.finishedAt){
    if(!['completed','awaiting-decision'].includes(prior.runStatus)){
     if(!continueAfterFailure)throw new Error(`inspect stopped ${name} before resuming`);
     session.continuedAfterFailures??=[];
     if(!session.continuedAfterFailures.includes(name))session.continuedAfterFailures.push(name);
    }
    continue;
   }
   if(prior&&prior.text!==text)throw new Error(`saved ${name} input differs; preserve it and use a new tag`);
   const detail=await request(`/api/instances/${id}`);
   const beforePath=path.join(dir,`${name}-before-state.json`);
   const savedBefore=prior&&!fs.existsSync(beforePath)?[initial,...fs.readdirSync(dir).filter(file=>file.endsWith('-state.json')).map(file=>JSON.parse(fs.readFileSync(path.join(dir,file),'utf8')))].find(state=>state.revision===prior.beforeRevision):null;
   const before=prior?(fs.existsSync(beforePath)?JSON.parse(fs.readFileSync(beforePath,'utf8')):savedBefore):database.readInstance(id).document.state;
   if(!before)throw new Error(`missing original state before ${name}`);
   const submissionId=prior?.submissionId??`live-${name}-${randomUUID()}`,started=Date.now();
   const entry=prior??{name,text,submissionId,startedAt:new Date().toISOString(),beforeRevision:before.revision,...(retryOf?{retryOf}:{})};
   if(!prior){session.steps.push(entry);save(beforePath,before);}
   save(sessionPath,session);
   console.log(JSON.stringify({role:test.role,action:name,status:prior?'resuming':'submitted',instanceId:id}));
   if(!detail.conversation.turns.some(turn=>turn.action?.submissionId===submissionId))
    await request(`/api/instances/${id}/participants/${participantId}/actions`,'POST',{expectedRevision:entry.beforeRevision,submissionId,text});
   let final, nextLog=Date.now()+30000;
   for(;;){
    final=await request(`/api/instances/${id}`);
    const turn=final.conversation.turns.find(t=>t.action?.submissionId===submissionId);
    const narrating=turn?.responses?.some(r=>['queued','generating'].includes(r.narrativeStatus));
    if(final.run&&!['queued','running','pausing'].includes(final.run.status)&&turn&&!['running','awaiting'].includes(turn.status)&&!narrating) break;
    if(Date.now()>nextLog){console.log(JSON.stringify({role:test.role,action:name,status:final.run?.status,revision:final.summary.revision,elapsedMs:Date.now()-started}));nextLog=Date.now()+30000;}
    if(Date.now()-started>600000){
     if(final.run&&['queued','running'].includes(final.run.status))await request(`/api/instances/${id}/run/pause`,'POST',{runId:final.run.id,generation:final.run.generation});
     throw new Error(`${name} exceeded 10 minutes; paused for inspection`);
    }
    await sleep(8000);
   }
   const document=database.readInstance(id).document;
   const after=document.state;
   Object.assign(entry,{finishedAt:new Date().toISOString(),elapsedMs:Date.now()-started,runStatus:final.run?.status,stopReason:final.run?.stopReason,afterRevision:after.revision});
   save(path.join(dir,`${name}-state.json`),after);save(path.join(dir,`${name}-response.json`),final);
   save(path.join(dir,`${name}-evidence.json`),concise(before,after));
   save(sessionPath,session);
   console.log(JSON.stringify({role:test.role,action:name,status:'settled',revision:after.revision,elapsedMs:entry.elapsedMs}));
   if(['failed','paused','debug-paused','budget-paused','preparation-invalidated'].includes(final.run?.status)) throw new Error(`run ended ${final.run.status}: ${final.run.stopReason}`);
  }
  const state=database.readInstance(id).document.state;
  session.replayMatches=isDeepStrictEqual(replaySimulationState(state),state);
  if(!session.replayMatches) throw new Error('canonical replay differs from saved state');
  session.status=session.continuedAfterFailures?.length?'completed-after-recovery':'completed';
 }catch(e){session.status='needs-inspection';session.error=e instanceof Error?e.message:String(e);}
 session.finishedAt=new Date().toISOString();save(sessionPath,session);
 console.log(JSON.stringify({role:test.role,status:session.status,error:session.error,replayMatches:session.replayMatches}));
 return session;
}
const queue=[...cases];
await Promise.all(Array.from({length:Math.min(concurrency,cases.length)},async()=>{for(;;){const next=queue.shift();if(!next)return;const result=await run(next);if(result.status==='needs-inspection')process.exitCode=1;const sessions=fs.readdirSync(root).map(role=>path.join(root,role,'session.json')).filter(file=>fs.existsSync(file)).map(file=>JSON.parse(fs.readFileSync(file,'utf8')));save(path.join(root,'sessions.json'),sessions);}}));
database.close();
