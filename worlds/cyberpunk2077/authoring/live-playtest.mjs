import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { LocalDatabase } from '../../../src/server/local-database.ts';
import { readDirectState } from '../../../src/engine/direct/state.ts';
import { directControlAfter } from '../../../src/engine/direct/canonical.ts';
import { replaySimulationState } from '../../../src/engine/runtime/transaction.ts';
import { directWorldAlgorithmRef } from '../../../src/engine/direct/algorithm.ts';
import { liveCases } from './live-cases.mjs';
import { naturalPlayCases } from './natural-play-cases.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return args[index + 1];
};
const api = option('--api', 'http://127.0.0.1:3107');
const tag = option('--tag', new Date().toISOString().replace(/[:.]/g, '-'));
if (!/^[\w-]+$/.test(tag)) throw new Error('tag must contain only letters, digits, underscores and hyphens');
const caseSet = option('--cases', 'regression');
const availableCases = { regression: liveCases, natural: naturalPlayCases }[caseSet];
if (!availableCases) throw new Error('--cases must be regression or natural');
const resume = args.includes('--resume');
const continueAfterFailure = args.includes('--continue-after-failure');
const retryFailedStep = option('--retry-failed-step', '');
if (retryFailedStep && !resume) throw new Error('--retry-failed-step requires --resume');
if (continueAfterFailure && !resume) throw new Error('--continue-after-failure requires --resume');
const selected = option('--roles', '').split(',').filter(Boolean);
const cases = availableCases.filter(test => !selected.length || selected.includes(test.role));
if (!cases.length || selected.some(id => !availableCases.some(test => test.role === id))) throw new Error('unknown role');
const concurrency = Number(option('--concurrency', '2'));
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error('concurrency must be 1..12');
const actionTimeoutMinutes = Number(option('--action-timeout-minutes', '30'));
if (!Number.isFinite(actionTimeoutMinutes) || actionTimeoutMinutes <= 0) throw new Error('action timeout must be positive minutes');
const actionTimeoutMs = actionTimeoutMinutes * 60000;
for (const test of cases) {
  const names = new Set();
  for (const [name, text] of test.steps) {
    if (!/^[\w-]+$/.test(name) || names.has(name) || typeof text !== 'string' || !text.trim()) throw new Error(`invalid step in ${test.role}`);
    names.add(name);
  }
}
const expectedAlgorithm = directWorldAlgorithmRef();
const plan = { caseSet, concurrency, actionTimeoutMinutes, instanceSchemaVersion: 33,
  algorithm: `${expectedAlgorithm.id}@${expectedAlgorithm.version}`, cases };

if (args.includes('--plan')) console.log(JSON.stringify(plan, null, 2));
else await main();

async function main() {
  const root = path.resolve('worlds/cyberpunk2077/.acceptance/live-origins', tag);
  fs.mkdirSync(root, { recursive: true });
  const databasePath = path.resolve(option('--database', '.livingworld-v23/livingworld.sqlite'));
  const database = new LocalDatabase(databasePath, { readOnly: true });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const roles = JSON.parse(fs.readFileSync('worlds/cyberpunk2077/authoring/playable-roles.json', 'utf8'));
  const save = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  const log = value => console.log(JSON.stringify(value));
  const hashCase = test => createHash('sha256').update(JSON.stringify(test)).digest('hex');
  save(path.join(root, `plan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), { ...plan, commit, api, databasePath, resume });

  async function request(route, method = 'GET', body) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(api + route, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
          // Takeover includes a real arrival call and its bounded format repair;
          // allow provider/queue time without retrying a potentially committed mutation.
          body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(method === 'GET' ? 120000 : 1200000) });
        const text = await response.text();
        if (!response.ok) throw Object.assign(new Error(`${method} ${route}: ${response.status}: ${text.slice(0, 800)}`), { status: response.status });
        return text ? JSON.parse(text) : null;
      } catch (error) {
        const transient = !error.status && !(error instanceof SyntaxError) || [429, 502, 503, 504].includes(error.status);
        if (method !== 'GET' || !transient || attempt >= 2) throw error;
        fs.appendFileSync(path.join(root, 'http-retries.ndjson'), JSON.stringify({ at: new Date().toISOString(), route,
          attempt: attempt + 1, error: String(error), cause: String(error.cause) }) + '\n');
        await sleep(500 * (attempt + 1));
      }
    }
  }

  function readInstance(id) {
    const document = database.readInstance(id).document;
    if (document.schemaVersion !== 33 || !document.agentMemories || !isDeepStrictEqual(document.executionAlgorithm, expectedAlgorithm)) {
      throw new Error(`instance ${id} must be freshly created with schema 33 and ${expectedAlgorithm.id}@${expectedAlgorithm.version}`);
    }
    return document;
  }

  function saveVisible(dir, name, detail, submissionId) {
    const visible = visibleTranscript(detail, submissionId);
    save(path.join(dir, `${name}-visible.json`), visible);
    fs.writeFileSync(path.join(dir, `${name}-visible.md`), renderTranscript(visible));
    fs.writeFileSync(path.join(dir, 'visible-transcript.md'), renderTranscript(visibleTranscript(detail)));
  }

  function capture(dir, name, before, document, detail, submissionId) {
    save(path.join(dir, `${name}-state.json`), document.state);
    const evidence = before ? concise(before, document.state) : null;
    if (evidence) save(path.join(dir, `${name}-evidence.json`), evidence);
    if (detail) {
      save(path.join(dir, `${name}-response.json`), detail);
      saveVisible(dir, name, detail, submissionId);
    }
    return evidence;
  }

  async function run(test) {
    const dir = path.join(root, test.role);
    fs.mkdirSync(dir, { recursive: true });
    const sessionPath = path.join(dir, 'session.json');
    let session, initial, activeEntry, activeBefore, latestDetail, monitor;
    try {
      if (fs.existsSync(sessionPath)) {
        if (!resume) throw new Error(`existing session must be inspected before rerun: ${sessionPath}`);
        const saved = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        if (saved.caseSet !== caseSet || saved.caseHash !== hashCase(test)) throw new Error('saved case differs; preserve it and use a new tag');
        if (!saved.instanceId || !saved.participantId) throw new Error('startup was interrupted; inspect the retained instance before starting a separate case');
        readInstance(saved.instanceId);
        session = saved;
        initial = JSON.parse(fs.readFileSync(path.join(dir, 'initial-state.json'), 'utf8'));
        session.recoveries ??= [];
        session.recoveries.push({ at: new Date().toISOString(), commit, previousStatus: session.status,
          previousReplayMatches: session.replayMatches ?? null, error: session.error ?? null });
        session.status = 'running';
        delete session.error;
        delete session.finishedAt;
        delete session.replayMatches;
      } else {
        session = { commit, tag, caseSet, caseHash: hashCase(test), role: test.role, startedAt: new Date().toISOString(), steps: [], status: 'starting' };
        save(sessionPath, session);
        const created = await request('/api/instances', 'POST', { worldId: 'cyberpunk2077-night-city',
          title: `${caseSet === 'natural' ? '夜之城自然游玩' : '真实开场验收'} ${tag} ${test.role}`, seed: 20771017, start: { kind: 'observer' } });
        const id = created.summary.id;
        session.instanceId = id;
        save(sessionPath, session);
        readInstance(id);
        latestDetail = await request(`/api/instances/${id}/control`, 'PUT', { expectedRevision: created.summary.revision, target: { kind: 'agent', agentId: test.role } });
        session.participantId = latestDetail.conversation.participantId;
        const document = readInstance(id);
        initial = document.state;
        const role = roles.find(item => item.id === test.role);
        if (!role) throw new Error(`authored role is missing: ${test.role}`);
        Object.assign(session, { worldHash: initial.worldHash, worldVersion: document.world.manifestVersion, instanceSchemaVersion: document.schemaVersion,
          executionAlgorithm: document.executionAlgorithm, worldModels: readDirectState(initial.executionState, initial).models,
          agentModels: initial.agents[test.role].modelProfiles, status: 'running' });
        save(path.join(dir, 'initial-state.json'), initial);
        save(path.join(dir, 'opening-response.json'), latestDetail);
        saveVisible(dir, 'opening', latestDetail);
        const amount = holder => Object.values(initial.truth.quantities).find(quantity => quantity.holderId === holder && quantity.definitionId === 'eurodollar')?.amount;
        session.initialChecks = { cash: amount(test.role) === role.cash, placement: initial.truth.placements[test.role] === role.work,
          arrival: latestDetail.conversation.turns.some(turn => !turn.action && turn.response?.generated === true),
          assets: role.assets.every(id => initial.truth.entities[id] && Object.values(initial.agents[test.role].bindings).some(binding => binding.canonicalEntityIds.includes(id))),
          reciprocalContacts: role.contacts.every(id => Object.values(initial.agents[id].bindings).some(binding => binding.canonicalEntityIds.includes(test.role)) &&
            Object.values(initial.agents[test.role].bindings).some(binding => binding.canonicalEntityIds.includes(id))) };
      }
      const { instanceId: id, participantId } = session;
      save(sessionPath, session);
      if (Object.values(session.initialChecks).some(passed => !passed)) throw new Error('initial resources, contacts or generated arrival need inspection');
      for (const [name, text] of test.steps) {
        let prior = session.steps.find(step => step.name === name), retryOf;
        if (prior?.finishedAt && (prior.runStatus === 'failed' || prior.localFailures?.length || prior.narrativeFallbacks?.length) && retryFailedStep === name) {
          if (prior.text !== text) throw new Error('retry must preserve the original natural-language action');
          const archivedName = `${name}-failed-${session.steps.filter(step => step.name.startsWith(name + '-failed-')).length + 1}`;
          for (const suffix of ['before-state.json', 'state.json', 'response.json', 'evidence.json', 'visible.json', 'visible.md']) {
            const source = path.join(dir, `${name}-${suffix}`), target = path.join(dir, `${archivedName}-${suffix}`);
            if (fs.existsSync(source)) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
          }
          prior.originalName = name;
          prior.name = archivedName;
          retryOf = prior.submissionId;
          session.continuedAfterFailures ??= [];
          session.continuedAfterFailures.push(archivedName);
          prior = undefined;
        }
        if (prior?.finishedAt) {
          if (!['completed', 'awaiting-decision'].includes(prior.runStatus) || prior.localFailures?.length || prior.narrativeFallbacks?.length) {
            if (!continueAfterFailure) throw new Error(`inspect stopped ${name} before resuming`);
            session.continuedAfterFailures ??= [];
            if (!session.continuedAfterFailures.includes(name)) session.continuedAfterFailures.push(name);
          }
          continue;
        }
        if (prior && prior.text !== text) throw new Error(`saved ${name} input differs; preserve it and use a new tag`);
        latestDetail = await request(`/api/instances/${id}`);
        const beforePath = path.join(dir, `${name}-before-state.json`);
        const before = prior ? JSON.parse(fs.readFileSync(beforePath, 'utf8')) : readInstance(id).state;
        const submissionId = prior?.submissionId ?? `live-${name}-${randomUUID()}`;
        const entry = prior ?? { name, text, submissionId, startedAt: new Date().toISOString(), beforeRevision: before.revision, ...(retryOf ? { retryOf } : {}) };
        activeEntry = entry;
        activeBefore = before;
        if (!prior) { session.steps.push(entry); save(beforePath, before); }
        monitor = { startedAt: new Date().toISOString(), actionTimeoutMs, status: 'monitoring' };
        entry.monitors ??= [];
        entry.monitors.push(monitor);
        save(sessionPath, session);
        log({ role: test.role, action: name, status: prior ? 'resuming' : 'submitted', instanceId: id });
        if (!latestDetail.conversation.turns.some(turn => turn.action?.submissionId === submissionId)) {
          // The exact submission is retained before sending; POST is never automatically retried.
          await request(`/api/instances/${id}/participants/${participantId}/actions`, 'POST', { expectedRevision: entry.beforeRevision, submissionId, text });
        }
        const started = Date.now();
        let nextLog = started + 30000;
        for (;;) {
          latestDetail = await request(`/api/instances/${id}`);
          const turn = latestDetail.conversation.turns.find(item => item.action?.submissionId === submissionId);
          const narrating = responsesOf(turn).some(response => ['queued', 'generating'].includes(response.narrativeStatus));
          if (latestDetail.run && !['queued', 'running', 'pausing'].includes(latestDetail.run.status) && turn && !['running', 'awaiting'].includes(turn.status) && !narrating) break;
          if (Date.now() > nextLog) {
            log({ role: test.role, action: name, status: latestDetail.run?.status, revision: latestDetail.summary.revision, elapsedMs: Date.now() - started });
            nextLog = Date.now() + 30000;
          }
          if (Date.now() - started > actionTimeoutMs) {
            if (latestDetail.run && ['queued', 'running'].includes(latestDetail.run.status)) {
              await request(`/api/instances/${id}/run/pause`, 'POST', { runId: latestDetail.run.id, generation: latestDetail.run.generation });
              monitor.pauseRequested = true;
            }
            throw new Error(`${name} exceeded ${actionTimeoutMinutes} minutes; inspect the retained run before resuming`);
          }
          await sleep(8000);
        }
        const document = readInstance(id);
        Object.assign(monitor, { finishedAt: new Date().toISOString(), elapsedMs: Date.now() - started, status: 'settled' });
        Object.assign(entry, { finishedAt: new Date().toISOString(), elapsedMs: Date.now() - Date.parse(entry.startedAt),
          runStatus: latestDetail.run?.status, stopReason: latestDetail.run?.stopReason, afterRevision: document.state.revision });
        const evidence = capture(dir, name, before, document, latestDetail, submissionId);
        entry.localFailures = evidence.localFailures;
        entry.narrativeFallbacks = latestDetail.conversation.turns.filter(turn => turn.action?.submissionId === submissionId)
          .flatMap(turn => responsesOf(turn).filter(response => response.narrativeStatus === 'fallback'));
        save(sessionPath, session);
        log({ role: test.role, action: name, status: 'settled', revision: document.state.revision, elapsedMs: entry.elapsedMs });
        if (!['completed', 'awaiting-decision'].includes(latestDetail.run?.status)) throw new Error(`run ended ${latestDetail.run?.status}: ${latestDetail.run?.stopReason}`);
        if (entry.localFailures.length) throw new Error(`${name} contains ${entry.localFailures.length} local model failures; inspect the recorded evidence`);
        if (entry.narrativeFallbacks.length) throw new Error(`${name} contains narrative fallback; inspect the recorded evidence`);
        activeEntry = undefined;
        activeBefore = undefined;
        monitor = undefined;
      }
      const state = readInstance(id).state;
      session.replayMatches = isDeepStrictEqual(replaySimulationState(state), state);
      if (!session.replayMatches) throw new Error('canonical replay differs from saved state');
      const recovered = session.continuedAfterFailures?.length || session.failures?.length || session.steps.some(step => step.failures?.length);
      session.status = recovered ? 'completed-after-recovery' : 'completed';
    } catch (error) {
      // A refused rerun must not overwrite the original session or its evidence.
      if (!session) {
        log({ role: test.role, status: 'needs-inspection', error: String(error) });
        return { role: test.role, status: 'needs-inspection' };
      }
      const failure = { at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error),
        runStatus: latestDetail?.run?.status, revision: latestDetail?.summary?.revision };
      session.status = 'needs-inspection';
      session.error = failure.error;
      const failures = activeEntry ? activeEntry.failures ??= [] : session.failures ??= [];
      failures.push(failure);
      if (monitor) Object.assign(monitor, { status: 'failed', finishedAt: failure.at, elapsedMs: Date.now() - Date.parse(monitor.startedAt), error: failure.error });
      if (session.instanceId) {
        try {
          const document = readInstance(session.instanceId);
          capture(dir, `${activeEntry?.name ?? 'startup'}-failure-${failures.length}`, activeBefore, document, latestDetail, activeEntry?.submissionId);
          session.replayMatches = isDeepStrictEqual(replaySimulationState(document.state), document.state);
          if (!session.replayMatches) failure.replayError = 'canonical replay differs from saved state';
        } catch (captureError) { failure.captureError = String(captureError); }
      }
    }
    session.finishedAt = new Date().toISOString();
    save(sessionPath, session);
    log({ role: test.role, status: session.status, error: session.error, replayMatches: session.replayMatches });
    return session;
  }

  try {
    const queue = [...cases];
    await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        const result = await run(next);
        // Recovery is reviewable evidence, never a clean first-pass exit.
        if (result.status !== 'completed') process.exitCode = 1;
        const sessions = fs.readdirSync(root).map(role => path.join(root, role, 'session.json')).filter(file => fs.existsSync(file))
          .map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
        save(path.join(root, 'sessions.json'), sessions);
      }
    }));
  } finally { database.close(); }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function responsesOf(turn) { return turn?.responses ?? (turn?.response ? [turn.response] : []); }
function visibleTranscript(detail, submissionId) {
  return { instanceId: detail.summary.id, revision: detail.summary.revision, runStatus: detail.run?.status,
    turns: detail.conversation.turns.filter(turn => !submissionId || turn.action?.submissionId === submissionId).map(turn => ({
      id: turn.id, status: turn.status, createdAt: turn.createdAt, player: turn.action ?? null,
      responses: responsesOf(turn).map(response => ({ id: response.id, revision: response.revision, step: response.step,
        worldTimeSeconds: response.worldTimeSeconds, narrativeStatus: response.narrativeStatus, text: response.text })),
    })) };
}
function renderTranscript(visible) {
  const paragraphs = [`# 玩家可见游玩记录\n\n实例：${visible.instanceId} · 修订：${visible.revision} · 运行：${visible.runStatus ?? '尚未运行'}`];
  for (const turn of visible.turns) {
    if (turn.player) paragraphs.push(`## 玩家\n\n${turn.player.text}`);
    for (const response of turn.responses) paragraphs.push(`## 世界 · 修订 ${response.revision}\n\n${response.text}`);
  }
  return paragraphs.join('\n\n') + '\n';
}
function concise(before, after) {
  const records = after.history.filter(history => history.revision > before.revision);
  const localFailures = [];
  let control = readDirectState(before.executionState, before);
  for (const record of records) {
    const next = directControlAfter(control, record.directEvent);
    for (const [agentId, intent] of Object.entries(next.intents)) {
      if (intent.failure && !isDeepStrictEqual(intent.failure, control.intents[agentId]?.failure)) {
        localFailures.push({ agentId, revision: record.revision, ...intent.failure });
      }
    }
    control = next;
  }
  const quantities = [...new Set([...Object.keys(before.truth.quantities), ...Object.keys(after.truth.quantities)])].flatMap(id => {
    const previous = before.truth.quantities[id], current = after.truth.quantities[id], quantity = current ?? previous;
    const old = previous?.amount ?? 0, amount = current?.amount ?? 0;
    return amount !== old ? [{ holder: quantity.holderId, resource: quantity.definitionId, before: old, after: amount }] : [];
  });
  const facts = Object.values(after.truth.facts).filter(fact => JSON.stringify(fact) !== JSON.stringify(before.truth.facts[fact.id]));
  const meters = Object.values(after.truth.meters).flatMap(meter => {
    const old = before.truth.meters[meter.id]?.current;
    return old !== meter.current ? [{ entity: meter.entityId, meter: meter.definitionId, before: old, after: meter.current }] : [];
  });
  const interactions = records.flatMap(history => history.directEvent?.frames ?? []).map(frame => ({ id: frame.id, actor: frame.actorId,
    kind: frame.kind, target: frame.targetEntityId, tool: frame.toolEntityId, amount: frame.amount, resource: frame.quantityDefinitionId,
    utterance: frame.utterance, expression: frame.expression, request: frame.proposal.rawText }));
  return { revision: after.revision, step: after.step, elapsedSeconds: after.truth.elapsedSeconds, localFailures, quantities, meters, facts, interactions,
    outcomes: records.flatMap(history => history.directEvent?.settlements ?? history.outcomes ?? []),
    operations: records.flatMap(history => history.operations), observations: records.flatMap(history => history.observations ?? []) };
}
