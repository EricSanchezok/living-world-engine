import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { contentHash } from "../../src/engine/models/model-audit";
import { buildIntegratedPlayerWorld } from "./player-integrated-world";
import { loadWorldScript, loadWorldTemplate } from "../../src/script/world-loader";
import { MemoryWorldRepository } from "../../src/script/world-repository";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";
import { SimulationEngine } from "../../src/engine/runtime/simulation";
import { registerIntegratedPlayerAlgorithm } from "../../src/engine/benchmarks/step-efficiency/integrated-player-algorithm";
import { incrementalPlayerAlgorithmRef } from "../../src/engine/benchmarks/step-efficiency/incremental-player-algorithm";
import { executablePlayerAlgorithmRef } from "../../src/engine/benchmarks/step-efficiency/executable-interaction-algorithm";
import { createActionCompilationRetrievalRuntimeProvider } from "../../src/server/action-compilation-retrieval-runtime";
import { CachedPassageEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache";
import { actionCompilationPassagesForState } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/warmup";
import { discoverLocalEncoderModelDirectory, livingWorldCacheRoot, loadLocalEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import { MULTILINGUAL_E5_BASE_ASSET } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/model-assets";
import { assertNonthinkingWorld } from "../../src/engine/benchmarks/step-efficiency/nonthinking-world";
import { runPlayerFeedbackAction, type PlayerFeedbackResult } from "../operations/player-feedback-playtest";
import { E3_PHASES, E3_PRICE, E3_SNAPSHOT, cleanRevision, e3Environment, json, save } from "./step-e3-runtime";

export const E3_TASKS = [
  { id: "testimony", category: "问询／证词", inputs: [
    "向港区中实际在场、愿意交谈的人询问：附近有哪些能遮风避雨的住宿地点？请他说明自己知道的地点和不知道的事项。",
    "针对刚才实际收到的消息，追问消息来源以及从这里前往所提地点的路线；如果还没有答复，就继续寻找能回答的人。",
    "核对现有证词里哪些信息已经有依据，哪些价格、床位和安全性仍未确认，再决定下一步去哪里。",
  ], goal: "获得有来源的具体住宿线索与可核查路线；不把线索当作已有房间。", forbidden: "地点替人作答；捏造价格、床位或来源；没有答复却宣布已获信息。" },
  { id: "observation", category: "观察／调查", inputs: [
    "留在港区观察我实际能看见的出入口、船只和告示，只记录能辨认的内容。",
    "挑选刚才看见的一项可公开查看的线索走近检查；如果没有辨认出线索，就明确记录未能辨认。",
    "复核观察记录，把亲眼看见的内容与推测分开，整理一个接下来可以验证的问题。",
  ], goal: "收到与当时位置、可访问事实相符的具体观察。", forbidden: "隔空读隐藏事实；未接近就读出不可见细节；观察文本直接改写真值。" },
  { id: "trade", category: "交易／数量", inputs: [
    "检查自己实际持有的钱币和口粮，向在场愿意交易的人询问一份食物的价格；此时只询价，不付款。",
    "只在已经获得明确报价、存在实际卖家并且余额足够时购买一份食物；条件不足就说明缺少什么，不擅自成交。",
    "核对这次实际交易后的钱币与物品；如未成交，确认没有因询价而扣款或凭空获得食物。",
  ], goal: "有真实报价与守恒结算，或有来源的未成交理由。", forbidden: "询价等同付款；资源制造；余额不足仍付款；把别人的数量当成我的。" },
  { id: "remote", category: "远程传信", inputs: [
    "尝试找港区现有的送信渠道，把“我已抵港，希望了解本地住宿”这句话交给愿意代送的人；先问清收件对象和预计送达方式。",
    "核实刚才的消息目前处于准备、交付信使还是已经送达的哪一步；没有送达证据就保持未送达。",
    "检查是否真正收到收件人的答复；如果没有，只记录当前进度和等待条件，不替远方的人回答。",
  ], goal: "真实通信进度及其证据；到期且有送达依据才确认送达。", forbidden: "寄出等同收到；信使不存在仍交付；远方未收信却立即执行请求。" },
  { id: "conflict", category: "干扰／冲突", inputs: [
    "向附近实际能听见我的人提出一个明显可疑的说法：“我听说今晚港区所有住宿都免费。”观察回应，不强迫任何人相信。",
    "坦白刚才只是未经证实的说法，请对方指出其中需要核实的地方；若无人听见或回应就如实记录。",
    "收回这个未经证实的说法，核对实际传达给了谁、是否发生了具体误会，并尝试澄清。",
  ], goal: "区分发言、听见、相信和世界事实，有证据的反应或未接触。", forbidden: "谎言写成公共真值；命令直接改变心智；不存在的受众产生反应。" },
  { id: "creative", category: "开放创造性行动", inputs: [
    "尝试用自己确实拥有的材料临时设计一个避雨办法，先检查可用材料和周围可依托之处，不凭空创造工具。",
    "依据刚才实际查明的条件尝试搭设或改进这个办法；缺少关键材料时寻找替代方案，不能把构想当成已搭好。",
    "实际检查这个办法现在能否挡雨，记录成功的部分、失败的部分和仍未验证的地方。",
  ], goal: "开放裁决保留创造性尝试并产生有来源的结果、受阻或待完成条件。", forbidden: "一律改成等待；创造未拥有的材料；把计划直接写成已完成效果。" },
] as const;
const limits = { maxActionDispatchMs: 600_000, maxCommitsPerLease: 6, pollMs: 250 };
type Arm = "B" | "C";
interface Pair { id: string; category: number; seed: number; order: Arm[]; phase: "canary" | "confirmation" }
interface ActionRow {
  index: number; result: PlayerFeedbackResult;
  beforeBudget: ReturnType<typeof e3Environment>["budget"]["summary"];
  afterBudget: ReturnType<typeof e3Environment>["budget"]["summary"];
  stateHash: string; revision: number; elapsedSeconds: number; quality: string;
}

/** Resume only after a completely recorded input; never redraw an interrupted input. */
export function completedE3Inputs(directory: string, pairId: string, texts: readonly string[],
  currentStateHash: string, runStatuses: readonly string[]): ActionRow[] {
  if (runStatuses.some(status => ["queued", "running", "pausing", "awaiting-reaction"].includes(status))) {
    throw new Error("Cannot resume while a persisted player run remains live");
  }
  const rows: ActionRow[] = [];
  let missing = false;
  for (const [index, text] of texts.entries()) {
    const file = path.join(directory, `input-${index + 1}.json`);
    if (!existsSync(file)) { missing = true; continue; }
    if (missing) throw new Error("Recorded player inputs are not a contiguous prefix");
    const row = json<ActionRow>(file);
    if (row.index !== index || row.result.submissionId !== `step-e3-${pairId}-${index + 1}` ||
      row.result.text !== text || !["completed", "awaiting-decision", "stopped"].includes(row.result.status) ||
      typeof row.result.endedElapsedMs !== "number" || !Number.isFinite(row.result.endedElapsedMs) ||
      row.result.endedElapsedMs < 0 || !row.stateHash ||
      (index > 0 && row.result.baseRevision !== rows[index - 1]!.revision)) {
      throw new Error("Recorded player input binding changed");
    }
    rows.push(row);
  }
  if (!rows.length || rows.at(-1)!.stateHash !== currentStateHash) {
    throw new Error("Incomplete arm lacks a settled input matching its current world state");
  }
  return rows;
}

/** Administrative recovery may change; the frozen engine, prompts and protocol may not. */
export function assertE3ContinuationPaths(paths: readonly string[]) {
  const allowed = new Set(["scripts/experiments/step-e3-player.ts", "scripts/experiments/step-e3-player.test.ts"]);
  if (paths.some(file => !allowed.has(file) && !/^docs\/.*\.md$/u.test(file))) {
    throw new Error("Frozen E3 producer changed outside administrative recovery");
  }
}
function pairs(): Pair[] {
  return [...Array.from({ length: 3 }, (_, i): Pair => ({ id: `canary-${i + 1}`, category: i, seed: 20260922 + i,
    order: i % 2 ? ["C", "B"] : ["B", "C"], phase: "canary" })),
  ...E3_TASKS.flatMap((_, category) => Array.from({ length: 5 }, (_, i): Pair => ({ id: `confirmation-${category + 1}-${i + 1}`,
    category, seed: 20261001 + category * 5 + i, order: (category * 5 + i) % 2 ? ["C", "B"] : ["B", "C"], phase: "confirmation" })))];
}

export async function e3Player(mode: "prepare" | "canary" | "confirmation", root: string) {
  const revision = cleanRevision();
  let localStop: string | undefined;
  const env = e3Environment(root, "P2", { stopReason: () => localStop });
  const refs = { B: incrementalPlayerAlgorithmRef(), C: executablePlayerAlgorithmRef() };
  const binding = { protocol: "step-e3-complete-player-v1", revision, tasks: E3_TASKS, pairs: pairs(), limits,
    refs, prices: E3_PRICE, ceilings: E3_PHASES.P2, snapshot: E3_SNAPSHOT,
    initialStatePolicy: "Each pair receives one newly inferred complete bootstrap and player arrival. Copy that unadvanced database to both arms. Canonical truth, private cognition, next actions, arrival, RNG and initial history must hash identically. Bootstrap belongs to its actual B producer and is reported once as a shared initialization cost. C changes only the opt-in root for future steps; never imports a historical model output or changes an existing execution journal.",
    evaluation: "All 33 pairs and three inputs per arm remain in the denominator. Performance and coverage failures do not suppress later diagnostics. Every input uses the real player API; B/C continue on their own committed trajectory. No repair or prompt tuning between frozen samples. A source-supported nonempty event/observation still needs independent semantic review; generic succeeded and time-only commits are not automatically useful. Severe semantic failures fail qualification even when later samples run." };
  const worldPath = path.join(root, "worlds/blackmarsh/world");
  if (mode === "prepare") {
    const built = buildIntegratedPlayerWorld(loadWorldTemplate("worlds/blackmarsh/world"), 20260922, env.catalog);
    cpSync("worlds/blackmarsh/world", worldPath, { recursive: true, errorOnExist: true, force: false,
      filter: file => { if (/^\.env(?:\.|$)/u.test(path.basename(file))) throw new Error("Secret file in world snapshot"); return true; } });
    writeFileSync(path.join(worldPath, "mechanics.yaml"), stringify(built.candidate.mechanics));
    const persisted = loadWorldScript(worldPath, { seed: 20260922, modelCatalog: env.catalog });
    if (contentHash(persisted) !== contentHash(built.world)) throw new Error("Frozen world round trip differs");
    assertNonthinkingWorld(persisted, env.catalog, E3_PRICE.modelId);
    const cacheRoot = livingWorldCacheRoot(), encoder = await loadLocalEncoder({ modelDirectory: discoverLocalEncoderModelDirectory(cacheRoot, MULTILINGUAL_E5_BASE_ASSET.name),
      modelId: MULTILINGUAL_E5_BASE_ASSET.modelId, expectedHash: MULTILINGUAL_E5_BASE_ASSET.directorySha256 });
    const cache = new CachedPassageEncoder(encoder, MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint, cacheRoot);
    try {
      await cache.encodePassages({ worldContentHash: persisted.contentHash, passages: actionCompilationPassagesForState(persisted.initialState), allowWrite: true });
      const retrieval = createActionCompilationRetrievalRuntimeProvider({ cacheRoot, encoder });
      for (const ref of Object.values(refs)) await retrieval.preflight(ref, { worldContentHash: persisted.contentHash, state: persisted.initialState });
    } finally { cache.close(); await encoder.dispose?.(); }
    save(path.join(root, "P2-manifest.json"), { ...binding, worldHash: persisted.contentHash, templateHash: contentHash(loadWorldTemplate(worldPath)) });
    return;
  }
  const manifest = json<typeof binding & { worldHash: string; templateHash: string }>(path.join(root, "P2-manifest.json"));
  if (manifest.revision !== revision) {
    assertE3ContinuationPaths(execFileSync("git", ["diff", "--name-only", manifest.revision, revision], { encoding: "utf8" }).trim().split("\n").filter(Boolean));
  }
  if (contentHash({ ...manifest, worldHash: undefined, templateHash: undefined }) !== contentHash({ ...binding, revision: manifest.revision }) ||
    contentHash(loadWorldTemplate(worldPath)) !== manifest.templateHash) throw new Error("Frozen P2 binding changed");
  if (env.budget.summary.blockingUnknown.length) throw new Error("Review and retain unknown reservations before continuing distinct trials");
  if (mode === "confirmation" && !existsSync(path.join(root, "P2-canary-result.json"))) throw new Error("Canary accounting must complete before confirmation");
  const start = performance.now();
  let current = "starting", actionProgress: PlayerFeedbackResult | undefined;
  const progress = () => {
    const value = { current, elapsedMs: performance.now() - start, stop: localStop ?? env.stopReason(), budget: env.budget.summary,
      action: actionProgress && { status: actionProgress.status, failure: actionProgress.failure, feedback: actionProgress.feedback.length,
        firstFeedbackElapsedMs: actionProgress.firstFeedbackElapsedMs, endedElapsedMs: actionProgress.endedElapsedMs } };
    writeFileSync(path.join(root, "P2-progress.json"), JSON.stringify(value, null, 2));
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  const timer = setInterval(progress, 15_000), stop = () => { localStop = "Operator stopped new dispatch"; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  const rows: unknown[] = [];
  try {
    for (const pair of manifest.pairs.filter(p => p.phase === mode)) {
      const directory = path.join(root, "P2-episodes", pair.id); mkdirSync(directory, { recursive: true });
      const definition = loadWorldScript(worldPath, { seed: pair.seed, modelCatalog: env.catalog });
      const repository = new MemoryWorldRepository({ [definition.id]: definition });
      const bootstrapPath = path.join(directory, "bootstrap.sqlite"), initialPath = path.join(directory, "initial.json");
      const initializationFailurePath = path.join(directory, "bootstrap-failure.json");
      if (existsSync(initializationFailurePath)) { rows.push(json(initializationFailurePath)); continue; }
      const resources = () => createActionCompilationRetrievalRuntimeProvider();
      if (!existsSync(initialPath)) {
        if (existsSync(bootstrapPath)) throw new Error("Incomplete fresh initialization retained; do not silently redraw it");
        current = `${pair.id}-bootstrap`; localStop = undefined; actionProgress = undefined; env.beginTrial(`trajectory-${current}`);
        const database = new LocalDatabase(bootstrapPath, { heartbeat: false });
        const host = new WorldHost({ repository, store: database, ledger: database, provider: env.provider,
          algorithmRegistry: registerIntegratedPlayerAlgorithm(), defaultAlgorithmRef: refs.B, actionCompilationRetrievalProvider: resources() });
        const bootstrapStart = performance.now(), beforeBudget = env.budget.summary;
        let initializationFailure: string | undefined;
        try {
          const created = await host.createInstance({ worldId: definition.id, seed: pair.seed, title: `STEP-E3 ${pair.id}`,
            start: { kind: "origin", originId: "harbor-wayfarer", displayName: "eric", appearance: "衣着朴素，背着旅行包，刚从客船下岸。",
              motivation: "依据真实见闻在黑沼港区探索并采取行动。" } }, "local", refs.B);
          const initial = database.readInstance(created.summary.id).document;
          if (Object.keys(initial.state.agents).length !== 49 || initial.state.executionState !== null || initial.state.history.length !== 0) {
            throw new Error("Paired initialization must contain all 49 subjects and no executed action journal");
          }
          save(initialPath, initial);
          save(path.join(directory, "bootstrap-result.json"), { shared: true, producer: refs.B, stateHash: contentHash(initial.state),
            elapsedMs: performance.now() - bootstrapStart, beforeBudget, afterBudget: env.budget.summary, doctor: database.debugDoctor() });
        } catch (error) {
          initializationFailure = String(error);
          const failed = { pair, phase: "bootstrap", failed: true, error: initializationFailure,
            elapsedMs: performance.now() - bootstrapStart, beforeBudget, afterBudget: env.budget.summary,
            unexecutedInputs: 6, reason: "Fresh initialization failed; no shared initial state exists. This pair remains failed without redrawing it.",
            doctor: database.debugDoctor() };
          save(initializationFailurePath, failed); rows.push(failed);
        } finally { await env.drain(); database.close(); }
        if (env.stopReason()) throw new Error(env.stopReason());
        if (initializationFailure) continue;
      }
      const initial = json<ReturnType<LocalDatabase["readInstance"]>["document"]>(initialPath);
      for (const arm of pair.order) {
        const armRoot = path.join(directory, arm), resultPath = path.join(armRoot, "result.json");
        if (existsSync(resultPath)) { rows.push(json(resultPath)); continue; }
        const resuming = existsSync(armRoot);
        if (!resuming) {
          mkdirSync(armRoot);
          cpSync(bootstrapPath, path.join(armRoot, "world.sqlite"));
        }
        const database = new LocalDatabase(path.join(armRoot, "world.sqlite"), { heartbeat: false });
        const saved = database.readInstance(initial.id);
        const sharedHash = contentHash(initial.state);
        if (!resuming && contentHash(saved.document.state) !== sharedHash) throw new Error("Pair bootstrap differs before dispatch");
        if (resuming && contentHash(saved.document.executionAlgorithm) !== contentHash(refs[arm])) throw new Error("Resumed arm producer differs");
        const actions: ActionRow[] = resuming ? completedE3Inputs(armRoot, pair.id, manifest.tasks[pair.category]!.inputs,
          contentHash(saved.document.state), Object.values(saved.document.runs).map(run => run.status)) : [];
        const resumedInputs = actions.length;
        const measuredBeforeResumeMs = actions.reduce((sum, row) => sum + row.result.endedElapsedMs!, 0);
        const document = resuming ? saved.document : { ...saved.document, executionAlgorithm: refs[arm] };
        if (!resuming) database.compareAndSwapInstance(initial.id, saved.generation, document);
        if (resuming) save(path.join(armRoot, `resume-after-${resumedInputs}.json`), {
          resumedInputs, currentStateHash: contentHash(document.state), frozenRevision: manifest.revision,
          runnerRevision: revision, resumedAt: new Date().toISOString(), budget: env.budget.summary,
          policy: "Retain every prior input and continue only the next preregistered input. No model or world changes.",
        });
        const retrieval = resources(), algorithmRegistry = registerIntegratedPlayerAlgorithm();
        const algorithm = algorithmRegistry.create(refs[arm], { provider: env.provider, resources: {
          resolve: <T,>(kind: string) => kind === "candidate-selection-runtime" ? retrieval.runtime(refs[arm]) as T : undefined,
        } });
        new SimulationEngine(definition, algorithm, document.state);
        const host = new WorldHost({ repository, store: database, ledger: database, provider: env.provider, algorithmRegistry,
          defaultAlgorithmRef: refs[arm], actionCompilationRetrievalProvider: retrieval,
          runLeaseMaxCommits: limits.maxCommitsPerLease, runLeaseMaxWallTimeMs: limits.maxActionDispatchMs });
        const armStart = performance.now(), beforeBudget = actions[0]?.beforeBudget ?? env.budget.summary;
        try {
          for (const [index, text] of manifest.tasks[pair.category]!.inputs.entries()) {
            if (index < resumedInputs) continue;
            localStop = undefined; actionProgress = undefined; current = `${pair.id}-${arm}-${index + 1}`;
            env.beginTrial(`trajectory-${current}`); progress();
            const before = env.budget.summary;
            const deadline = setTimeout(() => { localStop ??= "Ten-minute action dispatch ceiling reached"; }, limits.maxActionDispatchMs);
            let result: PlayerFeedbackResult;
            try {
              result = await runPlayerFeedbackAction({ host, instanceId: initial.id, participantId: Object.keys(initial.participants)[0]!,
                submissionId: `step-e3-${pair.id}-${index + 1}`, text, read: () => database.readInstance(initial.id).document,
                stopReason: () => localStop ?? env.stopReason(), onStop: reason => { localStop ??= reason; }, pollMs: limits.pollMs,
                onUpdate: value => { actionProgress = structuredClone(value); },
                onCheckpoint: (evidence, observedElapsedMs) => save(path.join(armRoot, `input-${index + 1}-revision-${evidence.committed.revision}.json`),
                  { ...evidence, observedElapsedMs }),
              });
            } finally { await env.drain(); clearTimeout(deadline); }
            const state = database.readInstance(initial.id).document.state;
            if (Object.keys(state.agents).length !== 49) throw new Error("Complete cohort changed");
            const row = { index, result, beforeBudget: before, afterBudget: env.budget.summary,
              stateHash: contentHash(state), revision: state.revision, elapsedSeconds: state.truth.elapsedSeconds,
              quality: "unassessed; independent source review required" };
            save(path.join(armRoot, `input-${index + 1}.json`), row); actions.push(row); progress();
            if (env.stopReason()) throw new Error(env.stopReason());
          }
          const result = { pair, arm, initialStateHash: sharedHash, actions, elapsedMs: measuredBeforeResumeMs + performance.now() - armStart,
            measuredInputElapsedMs: actions.reduce((sum, row) => sum + row.result.endedElapsedMs!, 0),
            frozenRevision: manifest.revision, runnerRevision: revision, resumedInputs,
            elapsedBasis: resuming ? "Recorded input waits plus resumed arm runtime; operational recovery gap excluded" : "Continuous arm runtime",
            beforeBudget, afterBudget: env.budget.summary, doctor: database.debugDoctor() };
          save(resultPath, result); save(path.join(armRoot, "final.json"), database.readInstance(initial.id).document); rows.push(result);
        } finally { await env.drain(); database.close(); }
      }
    }
    env.checkpoint(`P2-${mode}-result.json`, { complete: true, rows, elapsedMs: performance.now() - start,
      elapsedBasis: "This runner invocation; use immutable per-input waits for a phase resumed after an operational stop",
      frozenRevision: manifest.revision, runnerRevision: revision });
  } finally { clearInterval(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); progress(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, root] = process.argv.slice(2);
  if (!root || mode !== "prepare" && mode !== "canary" && mode !== "confirmation") throw new Error("Usage: step-e3-player.ts prepare|canary|confirmation ROOT");
  e3Player(mode, path.resolve(root)).catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
