import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import YAML from "yaml";
import AdmZip from "adm-zip";
import { createAuthoringModel, worldProfiles } from "./model.mjs";
import { authorCity } from "./city.mjs";
import { authorCast } from "./cast.mjs";
import { authorOrigins } from "./origins.mjs";
import { authorContinuations } from "./continuations.mjs";
import { authorServices } from "./services.mjs";
import { authorRules } from "./rules.mjs";
import { authorAccounts } from "./accounts.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
export function buildModel() {
  const model=createAuthoringModel();
  authorCity(model); authorCast(model); authorOrigins(model); authorContinuations(model); authorServices(model); authorAccounts(model);
  return model;
}
export function renderWorld() {
  const model=buildModel(), {laws,mechanics}=authorRules(model);
  const manifest={schema_version:19,id:"cyberpunk2077-night-city",name:"赛博朋克 2077：夜之城众生",version:"1.2.0",
    description:"忠于《赛博朋克 2077》与《往日之影》背景的中文同人开放世界。开篇在救人行动前，十二种原创成年身份拥有实际资产、人脉与独立生活。选择身份直接开局，或以观察者进入；未来由实际行动产生。",
    runtime_defaults:{max_autonomous_span_seconds:300,realtime_interval_ms:300000,action_window_ms:60000},model_profiles:worldProfiles,
    narrative:{language:"zh-CN",style:"中文第二人称，具体可感的城市小说。让技术、贫富、职业与人情从现场细节和对白显露；语气依人物而异。只叙述当前视角能知道的内容，日常简洁，重要交谈充分展开。",expansion:false}};
  const participation={origins:model.origins.map(role=>{
    const actor=model.get(role.id);
    return {kind:"existing",id:role.id,agent_id:role.id,title:role.title,
      fantasy:role.opening,description:actor.description,
      default_goal:actor.agent.character.goals[0].description,
      relationship_hooks:role.contacts.map(contact=>{
        const attitude=actor.agent.character.attitudes.find(entry=>entry.subject_id===`known-${contact}`);
        return `${model.get(contact).name}：${attitude.description}`;
      }),risks:[],fallback_arrival:`你是${actor.name}，此刻在${model.get(role.work).name}。${role.opening}`};
  })};
  const files=new Map([["script.yaml",manifest],["laws.yaml",laws],["mechanics.yaml",mechanics],
    ["participation.yaml",participation],
    ...[...model.entities.values()].sort((a,b)=>a.id.localeCompare(b.id,"en")).map(e=>[`entities/${e.id}.yaml`,e])]
    .map(([name,data])=>[name,YAML.stringify(data,{lineWidth:0})]));
  const counts={entities:model.entities.size,agents:[...model.entities.values()].filter(e=>e.agent).length,
    people:[...model.entities.values()].filter(e=>e.agent&&e.kind==="person").length,
    automatedServices:[...model.entities.values()].filter(e=>e.agent&&e.kind==="account").length,
    canonAgents:[...model.entities.values()].filter(e=>e.agent&&model.provenance[e.id].source!=="original").length,
    places:[...model.entities.values()].filter(e=>["city","district","neighborhood","place","property"].includes(e.kind)).length,
    organizations:[...model.entities.values()].filter(e=>e.kind==="organization").length,
    contracts:[...model.entities.values()].filter(e=>e.kind==="contract").length,
    playableRoles:model.origins.length,facts:[...model.entities.values()].reduce((n,e)=>n+e.facts.length,0),
    relationshipPairs:Object.values(model.provenance).filter(p=>p.kind==="relationship").length,
    beliefClaims:[...model.entities.values()].reduce((n,e)=>n+(e.agent?.belief.claims.length??0),0)};
  return {model,files,counts};
}
export function worldArchive(files) {
  const zip=new AdmZip();
  for(const [name,text] of files) {
    zip.addFile(name,Buffer.from(text));
    zip.getEntry(name).header.time=new Date("2026-10-17T00:00:00Z");
  }
  return zip.toBuffer();
}
export function build({check=false}={}) {
  const {model,files,counts}=renderWorld();
  const runtimeDigest=createHash("sha256");
  for(const [name,text] of files) runtimeDigest.update(name).update("\0").update(text);
  const report={worldId:"cyberpunk2077-night-city",version:"1.2.0",schemaVersion:19,
    start:"2077, after V and Jackie's six-month montage, before The Rescue; authored simultaneous staging",
    counts,runtimeSha256:runtimeDigest.digest("hex"),narrativeExpansion:false};
  const outputs=new Map([...files].map(([name,text])=>[`world/${name}`,text]));
  outputs.set("authoring/coverage.json",`${JSON.stringify(report,null,2)}\n`);
  outputs.set("authoring/provenance.json",`${JSON.stringify(model.provenance,null,2)}\n`);
  outputs.set("authoring/playable-roles.json",`${JSON.stringify(model.origins,null,2)}\n`);
  const overview=["# 十二种可选身份","","本页由 authoring/build.mjs 从运行初值生成。在新游戏中选择身份即可直接进入，也可先观察世界再接管。金额为个人现金；共同账户、岗位授权和设备归属见各实体。姓名是已经存在的角色姓名，直接开局保留其原有生活与认知。","",
    "| 身份 | 个人现金 | 联系人 | 开场 | 可尝试的行动 |","|---|---:|---|---|---|"];
  for(const r of model.origins) overview.push(`| ${model.get(r.id).name} | ${r.cash} €$ | ${r.contacts.map(id=>model.get(id).name).join("、")} | ${r.opening} | ${r.options.join("；")} |`);
  overview.push("","可自由拒绝开场、返回自己的住所或寻找别的工作。表中的行动只是例子；直接用自然语言提出行动即可。","");
  outputs.set("roles.md",overview.join("\n"));
  const errors=[];
  for(const [name,text] of outputs) {
    const filename=path.join(root,name);
    if(check) {if(!fs.existsSync(filename)||fs.readFileSync(filename,"utf8")!==text) errors.push(name);}
    else {fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,text);}
  }
  const worldDirectory=path.join(root,"world");
  if(fs.existsSync(worldDirectory)) for(const relative of fs.readdirSync(worldDirectory,{recursive:true})) {
    const name=String(relative), filename=path.join(worldDirectory,name);
    if(fs.statSync(filename).isFile()&&!files.has(name)) {
      if(check) errors.push(`unexpected world file: ${name}`);
      else throw new Error(`Refusing to remove unowned file: ${filename}`);
    }
  }
  if(errors.length) throw new Error(`Generated world differs: ${errors.join(", ")}`);
  if(!check) {fs.mkdirSync(path.join(root,"dist"),{recursive:true});fs.writeFileSync(path.join(root,"dist/cyberpunk2077-night-city.zip"),worldArchive(files));}
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(JSON.stringify(build({check:process.argv.includes("--check")}),null,2));
