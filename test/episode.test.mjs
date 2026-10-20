/**
 * Unit tests for lib/episode.js — EpisodeTracker lifecycle, trace collection, finalization,
 * cleanup and leak/failure posture. Run directly: `node test/episode.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { CAPS } from '../lib/constants.js'
import { DEFAULTS } from '../lib/config.js'
import { emptySkillState } from '../lib/stats.js'
import { EpisodeTracker } from '../lib/episode.js'

const silentLogger = () => {
  const lines = { debug: [], info: [], warn: [], error: [] }
  const push = (level) => (message) => lines[level].push(String(message))
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function waitFor(predicate, { timeout = 2000, interval = 10 } = {}) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    if (predicate()) return true
    await sleep(interval)
  }
  throw new Error('waitFor timed out')
}

function deepMerge(base, extra) {
  const out = JSON.parse(JSON.stringify(base))
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

function makeConfig(overrides = {}) {
  return deepMerge(DEFAULTS, overrides)
}

const probeReply = {
  fit: 0.7,
  confidence: 0.6,
  intent: 'produce a spreadsheet',
  expectedUse: ['create workbook'],
  successSignals: ['xlsx exists'],
  likelyPitfalls: ['no charts'],
  capabilityGap: '',
  cheaperAlternative: null,
  expectedValueTokens: 400,
}

const judgeReply = {
  score: 62,
  verdict: 'partial',
  predictionAccuracy: 0.7,
  capabilityGap: { present: false, claim: '', reality: '' },
  mismatches: [],
  rootCause: 'unknown',
  reusableRule: 'Keep using this skill for tables.',
  rework: false,
  recommendation: { descriptionEdit: null, bodyAddition: null, selectionRule: null },
}

function replyChunks(value, { inputTokens = 100, outputTokens = 30 } = {}) {
  return [
    { type: 'text-delta', index: 0, text: JSON.stringify(value) },
    { type: 'usage', usage: { inputTokens, outputTokens } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function makeSkillDefinition(overrides = {}) {
  return {
    name: 'office-xlsx',
    description: 'Build and edit Excel workbooks',
    whenToUse: 'When a spreadsheet is needed',
    source: 'user-dsh',
    provider: 'filesystem',
    path: join(homedir(), '.dsh', 'skills', 'office-xlsx', 'SKILL.md'),
    resourceBase: { kind: 'directory', path: join(homedir(), '.dsh', 'skills', 'office-xlsx') },
    content: `# office-xlsx\n${'workbook instructions '.repeat(20)}`,
    ...overrides,
  }
}

function createStore(initialSkills = []) {
  const skillMap = new Map()
  for (const skill of initialSkills) skillMap.set(skill.name, skill)
  const episodes = new Map()
  const totals = {}
  const calls = { ensureSkill: [], appendEpisode: [], updateEpisode: [], updateSkill: [], bumpTotals: [] }
  return {
    skills: skillMap,
    episodes,
    totals,
    calls,
    ensureSkill(args) {
      calls.ensureSkill.push(args)
      let skill = skillMap.get(args.name)
      if (skill === undefined) {
        skill = emptySkillState({ name: args.name, meta: args.meta })
        skillMap.set(args.name, skill)
      }
      skill.editable = Boolean(args.editable)
      return skill
    },
    getSkill(name) {
      return skillMap.get(name)
    },
    appendEpisode(record) {
      calls.appendEpisode.push(record)
      episodes.set(record.id, record)
      return record
    },
    updateEpisode(id, patch) {
      calls.updateEpisode.push({ id, patch })
      const current = episodes.get(id) ?? { id }
      const next = { ...current, ...patch, id }
      episodes.set(id, next)
      return next
    },
    updateSkill(name, mutator) {
      calls.updateSkill.push(name)
      const skill = skillMap.get(name)
      if (skill === undefined) return undefined
      mutator?.(skill)
      return skill
    },
    bumpTotals(patch) {
      calls.bumpTotals.push(patch)
      for (const [key, value] of Object.entries(patch ?? {})) totals[key] = (totals[key] ?? 0) + value
    },
    saveState() {},
  }
}

function createSession({ id = 'session-1', cwd = 'C:\\workspace', messages = [], events = [] } = {}) {
  return {
    id,
    header: { cwd },
    seq: events.length,
    deriveMessages: () => messages,
    snapshotEvents: (from = 0) => events.slice(from),
    requestHeader: () => ({ config: { provider: 'sess-provider', model: 'sess-model' } }),
  }
}

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function assistantMessage(text) {
  return { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] }
}

/** Fake ctx whose probe/judge replies are chosen by the system-prompt marker. */
function createCtx({ skillDefinition, skillsGet, probeChunks, judgeChunks, gate } = {}) {
  const calls = []
  const wd = {
    async ensure() {
      return 'C:\\workspace'
    },
    get() {
      return 'C:\\workspace'
    },
  }
  const ctx = {
    logger: silentLogger(),
    get(name) {
      if (name === 'workingDirectory') return wd
      return undefined
    },
    skills: {
      async get(name, options) {
        calls.push({ kind: 'skill', name, options })
        if (skillsGet !== undefined) return skillsGet(name, options)
        return skillDefinition ?? makeSkillDefinition({ name })
      },
    },
    llm: {
      async listProviders() {
        return [{ id: 'prov-1', name: 'Provider 1' }]
      },
      async listModels(provider) {
        return [{ provider, id: 'model-1', name: 'Model 1' }]
      },
      stream(options) {
        calls.push({ kind: 'llm', system: options.system })
        const system = options.system ?? ''
        const isProbe = system.includes('capability auditor')
        const chunks = isProbe ? (probeChunks ?? replyChunks(probeReply)) : (judgeChunks ?? replyChunks(judgeReply))
        return (async function* iterate() {
          if (isProbe && gate !== undefined) await (typeof gate === 'function' ? gate(options.signal) : gate)
          for (const chunk of chunks) yield chunk
        })()
      },
    },
  }
  ctx.calls = calls
  return ctx
}

function makeExec({ callId = 'call-1', name = 'skill', skillName = 'office-xlsx', signal, agent = { id: 'agent-1' } } = {}) {
  const controller = new AbortController()
  return {
    callId,
    name,
    arguments: { name: skillName },
    agent,
    signal: signal ?? controller.signal,
  }
}

test('onPreExecute: creates an episode, resolves metadata/task, journals it and starts the probe', async (t) => {
  const store = createStore()
  const ctx = createCtx()
  const tracker = new EpisodeTracker({ ctx, config: makeConfig(), store, logger: ctx.logger })
  t.after(() => tracker.dispose())
  const session = createSession({
    messages: [userMessage('make me a budget spreadsheet'), assistantMessage('sure, working on it')],
    events: [{ type: 'turn/start', data: { turn: 3 } }, { type: 'step/start', data: { turn: 3, step: 1 } }],
  })
  const exec = makeExec()
  const episode = await tracker.onPreExecute({ exec, session })
  assert.ok(episode)
  assert.equal(episode.skill, 'office-xlsx')
  assert.equal(episode.callId, 'call-1')
  assert.equal(episode.turn, 3)
  assert.equal(episode.step, 1)
  assert.equal(episode.state, 'recording')
  assert.equal(episode.skillMeta.description, 'Build and edit Excel workbooks')
  assert.ok(episode.skillMeta.bodyChars > 0)
  assert.equal(episode.task.userGoal, 'make me a budget spreadsheet')
  assert.equal(episode.task.cwd, 'C:\\workspace')
  assert.equal(store.calls.appendEpisode.length, 1)
  assert.equal(store.calls.ensureSkill.length, 1)
  assert.equal(store.calls.ensureSkill[0].editable, true, 'user-dsh skill inside ~/.dsh/skills is editable')
  assert.equal(tracker.openCount(), 1)
  assert.equal(tracker.isSkillBusy('office-xlsx'), true)
  assert.equal(tracker.isSkillBusy('other-skill'), false)

  const probeValue = await tracker.probePromiseFor('call-1')
  assert.equal(probeValue, episode)
  assert.equal(episode.probe.status, 'ok')
  assert.equal(episode.prediction.fit, 0.7)
  assert.deepEqual(await tracker.probePromiseFor('unknown-call'), undefined)
})

test('onPreExecute: probe runs concurrently and does not delay the skill call', async (t) => {
  let releaseGate
  const gate = new Promise((resolvePromise) => {
    releaseGate = resolvePromise
  })
  const store = createStore()
  const ctx = createCtx({ gate })
  const tracker = new EpisodeTracker({ ctx, config: makeConfig(), store, logger: ctx.logger })
  t.after(() => tracker.dispose())
  const session = createSession()
  const startedAt = Date.now()
  const episode = await tracker.onPreExecute({ exec: makeExec(), session })
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 500, `onPreExecute took ${elapsed}ms; it must not wait for the probe`)
  assert.equal(episode.probe.status, 'pending')
  assert.equal(tracker.openCount(), 1, 'the observation window may be open while the probe runs')
  releaseGate()
  await tracker.probePromiseFor('call-1')
  assert.equal(episode.probe.status, 'ok')
})

test('onPreExecute: ignores non-skill calls, missing call ids and duplicates', async (t) => {
  const ctx = createCtx()
  const tracker = new EpisodeTracker({ ctx, config: makeConfig(), store: createStore(), logger: ctx.logger })
  t.after(() => tracker.dispose())
  const session = createSession()
  assert.equal(await tracker.onPreExecute({ exec: makeExec({ callId: '' }), session }), undefined)
  assert.equal(await tracker.onPreExecute({ exec: { callId: 'c2', arguments: {} }, session }), undefined)
  assert.equal(await tracker.onPreExecute({ exec: null, session }), undefined)
  const first = await tracker.onPreExecute({ exec: makeExec(), session })
  const second = await tracker.onPreExecute({ exec: makeExec(), session })
  assert.equal(first, second)
  assert.equal(tracker.openCount(), 1)
})

test('onPreExecute: a failed skill lookup still yields a minimal episode', async (t) => {
  const ctx = createCtx({
    skillsGet: () => {
      throw new Error('catalog unavailable')
    },
  })
  const store = createStore()
  const tracker = new EpisodeTracker({ ctx, config: makeConfig(), store, logger: ctx.logger })
  t.after(() => tracker.dispose())
  const session = createSession()
  const episode = await tracker.onPreExecute({ exec: makeExec(), session })
  assert.equal(episode.skillMeta.description, '')
  assert.equal(episode.skillMeta.bodyChars, 0)
  assert.equal(store.calls.appendEpisode.length, 1)
  assert.equal(store.calls.ensureSkill.length, 1)
  await tracker.probePromiseFor('call-1')
  assert.ok(['ok', 'invalid', 'error'].includes(episode.probe.status))
})

test('onToolResult: records the load outcome and keeps the window observing', async (t) => {
  const ctx = createCtx()
  const store = createStore()
  const tracker = new EpisodeTracker({ ctx, config: makeConfig(), store, logger: ctx.logger })
  t.after(() => tracker.dispose())
  const session = createSession()
  const exec = makeExec()
  const episode = await tracker.onPreExecute({ exec, session })
  tracker.onToolResult({
    exec,
    result: { isError: false, content: [{ type: 'text', text: 'loaded skill body here' }] },
    session,
  })
  assert.equal(episode.state, 'observed')
  assert.equal(episode.call.isError, false)
  assert.ok(episode.call.contentChars > 0)
  assert.ok(episode.call.durationMs >= 0)
  assert.ok(store.calls.updateEpisode.some((call) => call.patch.call !== undefined))
  assert.equal(tracker.openCount(), 1, 'the observation window continues after the result')
})

test('full lifecycle: collects a bounded trace, finalizes at turn/end and judges', async (t) => {
  const ctx = createCtx()
  const store = createStore()
  const tracker = new EpisodeTracker({ ctx, config: makeConfig(), store, logger: ctx.logger })
  t.after(() => tracker.dispose())
  const session = createSession({
    messages: [userMessage('make a chart workbook')],
    events: [{ type: 'turn/start', data: { turn: 2 } }],
  })
  const exec = makeExec()
  const episode = await tracker.onPreExecute({ exec, session })
  tracker.onToolResult({
    exec,
    result: { isError: false, content: [{ type: 'text', text: 'skill loaded' }] },
    session,
  })

  const emit = (event) => tracker.onSessionEvent(session, event)
  emit({ type: 'tool/call', data: { turn: 2, step: 1, callId: 'call-1', name: 'skill', arguments: '{"name":"office-xlsx"}' } })
  emit({ type: 'tool/call', data: { turn: 2, step: 1, callId: 'call-2', name: 'write', arguments: '{"path":"sheet.xlsx"}' } })
  emit({
    type: 'tool/result',
    data: { turn: 2, step: 1, message: { role: 'tool', toolCallId: 'call-2', isError: false, content: [{ type: 'text', text: 'wrote sheet.xlsx' }] } },
  })
  emit({ type: 'assistant/message', data: { turn: 2, step: 2, message: assistantMessage('I created the table.') } })
  emit({ type: 'user/message', data: userMessage('where is the chart?') })
  emit({ type: 'user/message', data: userMessage('add a chart') })
  emit({ type: 'user/message', data: userMessage('add a chart please') })
  emit({ type: 'user/message', data: userMessage('add a chart now') })
  emit({ type: 'tool/call', data: { turn: 2, step: 3, callId: 'call-9', name: 'skill', arguments: '{"name":"office-xlsx"}' } })
  emit({ type: 'assistant/message', data: { turn: 2, step: 3, message: assistantMessage('Done — the table is ready.') } })
  emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })

  await waitFor(() => episode._finalized === true && episode.state === 'judged')
  assert.equal(episode.trace.turnEnd, 'completed')
  assert.ok(episode.trace.observedMs >= 0)
  assert.equal(episode.trace.assistantTexts.length, 2)
  assert.equal(episode.trace.userMessages.length, CAPS.traceUserItems)
  assert.ok(episode.trace.userMessages.includes('add a chart now'))
  const writeEntry = episode.trace.toolSequence.find((item) => item.name === 'write')
  assert.equal(writeEntry.ok, true)
  assert.equal(episode.trace.skillReLoaded, true)
  assert.ok(episode.trace.finalAnswerChars > 0)
  assert.equal(
    episode.trace.toolSequence.filter((item) => item.name === 'skill').length,
    1,
    'only the reload call appears; the load itself is the episode',
  )

  assert.equal(episode.judge.status, 'ok')
  assert.equal(episode.judge.score, 62)
  assert.equal(episode.cost.skillLoad > 0, true)
  assert.equal(tracker.openCount(), 0)
  assert.equal(tracker.isSkillBusy('office-xlsx'), false)
  assert.ok(store.calls.updateEpisode.some((call) => call.patch.state === 'judged'))
  const skill = store.getSkill('office-xlsx')
  assert.equal(skill.counts.judged, 1)
  assert.equal(store.totals.judged, 1)
  await waitFor(() => tracker.diagnostics().timers === 0)
  assert.equal(tracker.diagnostics().windows, 0)
})

test('turn/end reason is mapped into the trace vocabulary', async (t) => {
  const ctx = createCtx()
  const store = createStore()
  const tracker = new EpisodeTracker({ ctx, config: makeConfig(), store, logger: ctx.logger })
  t.after(() => tracker.dispose())
  const session = createSession({ events: [{ type: 'turn/start', data: { turn: 1 } }] })
  const episode = await tracker.onPreExecute({ exec: makeExec(), session })
  tracker.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await waitFor(() => episode._finalized === true)
  assert.equal(episode.trace.turnEnd, 'aborted')
})

test('maxEvents stops the observation window with turnEnd=timeout', async (t) => {
  const ctx = createCtx()
  const store = createStore()
  const tracker = new EpisodeTracker({
    ctx,
    config: makeConfig({ observe: { maxEvents: 3 } }),
    store,
    logger: ctx.logger,
  })
  t.after(() => tracker.dispose())
  const session = createSession({ events: [{ type: 'turn/start', data: { turn: 1 } }] })
  const episode = await tracker.onPreExecute({ exec: makeExec(), session })
  const emit = (event) => tracker.onSessionEvent(session, event)
  emit({ type: 'assistant/message', data: { turn: 1, step: 1, message: assistantMessage('one') } })
  emit({ type: 'assistant/message', data: { turn: 1, step: 1, message: assistantMessage('two') } })
  emit({ type: 'assistant/message', data: { turn: 1, step: 1, message: assistantMessage('three') } })
  await waitFor(() => episode._finalized === true)
  assert.equal(episode.trace.turnEnd, 'timeout')
})

test('maxTurnExtensionMs is a hard stop when the turn never ends', async (t) => {
  const ctx = createCtx()
  const store = createStore()
  const tracker = new EpisodeTracker({
    ctx,
    config: makeConfig({ observe: { maxTurnExtensionMs: 60 } }),
    store,
    logger: ctx.logger,
  })
  t.after(() => tracker.dispose())
  const session = createSession({ events: [{ type: 'turn/start', data: { turn: 1 } }] })
  const episode = await tracker.onPreExecute({ exec: makeExec(), session })
  await waitFor(() => episode._finalized === true, { timeout: 3000 })
  assert.equal(episode.trace.turnEnd, 'timeout')
  assert.equal(tracker.openCount(), 0)
})

test('a missing tool result is bounded by flushGraceMs and does not leak the window', async (t) => {
  const ctx = createCtx()
  const store = createStore()
  const tracker = new EpisodeTracker({
    ctx,
    config: makeConfig({ observe: { flushGraceMs: 40 } }),
    store,
    logger: ctx.logger,
  })
  t.after(() => tracker.dispose())
  const session = createSession({ events: [{ type: 'turn/start', data: { turn: 1 } }] })
  const episode = await tracker.onPreExecute({ exec: makeExec(), session })
  await waitFor(() => episode._finalized === true, { timeout: 3000 })
  assert.equal(episode.flags.loadResultMissing, true)
  assert.equal(tracker.openCount(), 0)
})

test('onSessionGone finalizes open windows as failed and is idempotent', async (t) => {
  const ctx = createCtx()
  const store = createStore()
  const tracker = new EpisodeTracker({ ctx, config: makeConfig(), store, logger: ctx.logger })
  t.after(() => tracker.dispose())
  const session = createSession({ id: 'session-gone', events: [{ type: 'turn/start', data: { turn: 1 } }] })
  const episode = await tracker.onPreExecute({ exec: makeExec({ callId: 'call-gone' }), session })
  tracker.onSessionGone('session-gone')
  await waitFor(() => episode._finalized === true)
  assert.equal(episode.state, 'failed')
  assert.equal(episode.flags.sessionGone, true)
  assert.equal(tracker.openCount(), 0)
  assert.doesNotThrow(() => tracker.onSessionGone('session-gone'))
  assert.doesNotThrow(() => tracker.onSessionGone(undefined))
})

test('dispose clears every timer/controller, marks open episodes failed and ignores later events', async (t) => {
  const abortAwareGate = (signal) =>
    new Promise((resolvePromise, rejectPromise) => {
      signal.addEventListener(
        'abort',
        () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          rejectPromise(error)
        },
        { once: true },
      )
    })
  const ctx = createCtx({ gate: abortAwareGate })
  const store = createStore()
  const tracker = new EpisodeTracker({ ctx, config: makeConfig(), store, logger: ctx.logger })
  const session = createSession()
  const episode = await tracker.onPreExecute({ exec: makeExec(), session })
  assert.ok(tracker.diagnostics().timers > 0)
  tracker.dispose()
  assert.equal(tracker.openCount(), 0)
  const diagnostics = tracker.diagnostics()
  assert.equal(diagnostics.timers, 0)
  assert.equal(diagnostics.windows, 0)
  assert.equal(diagnostics.controllers, 0)
  assert.equal(episode.state, 'failed')
  assert.equal(episode.flags.disposed, true)
  assert.ok(store.calls.updateEpisode.some((call) => call.patch.state === 'failed'))
  // Everything after disposal is a no-op and must not throw.
  assert.doesNotThrow(() => tracker.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }))
  assert.doesNotThrow(() => tracker.onToolResult({ exec: makeExec(), result: { isError: false, content: [] } }))
  assert.doesNotThrow(() => tracker.dispose())
  assert.equal(await tracker.probePromiseFor('call-1'), undefined)
})

test('no unhandled rejection escapes when the store and the model both fail', async () => {
  const rejections = []
  const onRejection = (reason) => rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  try {
    const hostileStore = {
      ensureSkill() {
        throw new Error('ensure failed')
      },
      getSkill() {
        throw new Error('lookup failed')
      },
      appendEpisode() {
        throw new Error('append failed')
      },
      updateEpisode() {
        throw new Error('update failed')
      },
      updateSkill() {
        throw new Error('skill update failed')
      },
      bumpTotals() {
        throw new Error('totals failed')
      },
      saveState() {
        throw new Error('save failed')
      },
    }
    const ctx = createCtx({
      skillsGet: () => {
        throw new Error('skills down')
      },
      probeChunks: [
        { type: 'text-delta', index: 0, text: 'not json' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      judgeChunks: [
        { type: 'text-delta', index: 0, text: 'also not json' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    })
    const tracker = new EpisodeTracker({ ctx, config: makeConfig(), store: hostileStore, logger: ctx.logger })
    const session = createSession({ events: [{ type: 'turn/start', data: { turn: 1 } }] })
    const episode = await tracker.onPreExecute({ exec: makeExec({ callId: 'call-hostile' }), session })
    tracker.onToolResult({ exec: makeExec({ callId: 'call-hostile' }), result: { isError: true, content: [] }, session })
    tracker.onSessionEvent(session, { type: 'assistant/message', data: { turn: 1, step: 1, message: assistantMessage('hm') } })
    tracker.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
    await waitFor(() => episode._finalized === true, { timeout: 3000 })
    await sleep(60)
    tracker.dispose()
    assert.deepEqual(rejections, [])
  } finally {
    process.removeListener('unhandledRejection', onRejection)
  }
})

test('workingDirectory absence degrades to session.header.cwd', async (t) => {
  const ctx = createCtx()
  ctx.get = () => undefined
  const store = createStore()
  const tracker = new EpisodeTracker({ ctx, config: makeConfig(), store, logger: ctx.logger })
  t.after(() => tracker.dispose())
  const session = createSession({ cwd: 'D:\\project' })
  const episode = await tracker.onPreExecute({ exec: makeExec(), session })
  assert.equal(episode.task.cwd, 'D:\\project')
})

test('editable flag is false for project sources or paths outside user skill roots', async (t) => {
  const store = createStore()
  const ctx = createCtx({
    skillDefinition: makeSkillDefinition({ source: 'project-dsh', path: 'C:\\repo\\.dsh\\skills\\s\\SKILL.md' }),
  })
  const tracker = new EpisodeTracker({ ctx, config: makeConfig(), store, logger: ctx.logger })
  t.after(() => tracker.dispose())
  const session = createSession()
  await tracker.onPreExecute({ exec: makeExec({ skillName: 'project-skill' }), session })
  assert.equal(store.calls.ensureSkill[0].editable, false)

  const outsideStore = createStore()
  const outsideCtx = createCtx({ skillDefinition: makeSkillDefinition({ path: 'C:\\other\\place\\SKILL.md' }) })
  const outsideTracker = new EpisodeTracker({ ctx: outsideCtx, config: makeConfig(), store: outsideStore, logger: outsideCtx.logger })
  t.after(() => outsideTracker.dispose())
  await outsideTracker.onPreExecute({ exec: makeExec({ callId: 'call-outside', skillName: 'outside-skill' }), session })
  assert.equal(outsideStore.calls.ensureSkill[0].editable, false)
})

test('duplicate finalize is a no-op and the journal is not rewritten twice', async (t) => {
  const ctx = createCtx()
  const store = createStore()
  const tracker = new EpisodeTracker({ ctx, config: makeConfig(), store, logger: ctx.logger })
  t.after(() => tracker.dispose())
  const session = createSession({ events: [{ type: 'turn/start', data: { turn: 1 } }] })
  const episode = await tracker.onPreExecute({ exec: makeExec(), session })
  await tracker.finalize(episode, { turnEnd: 'completed' })
  const judgedWrites = store.calls.updateEpisode.filter((call) => call.patch.state === 'judged').length
  await tracker.finalize(episode, { turnEnd: 'completed' })
  const judgedWritesAfter = store.calls.updateEpisode.filter((call) => call.patch.state === 'judged').length
  assert.equal(judgedWritesAfter, judgedWrites, 'a second finalize must not append another judged snapshot')
})

// ---------------------------------------------------------------------------------------------
// correlation namespacing: provider call ids are not globally unique
// ---------------------------------------------------------------------------------------------

/** Two concurrent sessions that reuse the exact same provider-generated call id. */
async function openDuplicateCallId(t) {
  const ctx = createCtx()
  const store = createStore()
  const tracker = new EpisodeTracker({ ctx, config: makeConfig(), store, logger: ctx.logger })
  t.after(() => tracker.dispose())
  const sessionA = createSession({ id: 'session-A' })
  const sessionB = createSession({ id: 'session-B' })
  const execA = makeExec({ callId: 'shared-call', skillName: 'office-xlsx', agent: { id: 'agent-A' } })
  const execB = makeExec({ callId: 'shared-call', skillName: 'demo-skill', agent: { id: 'agent-B' } })
  const episodeA = await tracker.onPreExecute({ exec: execA, session: sessionA })
  const episodeB = await tracker.onPreExecute({ exec: execB, session: sessionB })
  return { ctx, store, tracker, sessionA, sessionB, execA, execB, episodeA, episodeB }
}

test('two sessions reusing one callId produce two independent episodes and probe promises', async (t) => {
  const { tracker, episodeA, episodeB } = await openDuplicateCallId(t)
  assert.notEqual(episodeA, episodeB)
  assert.notEqual(episodeA.id, episodeB.id)
  assert.equal(episodeA.skill, 'office-xlsx')
  assert.equal(episodeB.skill, 'demo-skill')
  assert.equal(tracker.openCount(), 2)

  const [valueA, valueB] = await Promise.all([
    tracker.probePromiseFor('shared-call', 'agent-A'),
    tracker.probePromiseFor('shared-call', 'agent-B'),
  ])
  assert.equal(valueA, episodeA, 'agent-A must resolve its own episode')
  assert.equal(valueB, episodeB, 'agent-B must resolve its own episode')
  assert.equal(episodeA.probe.status, 'ok')
  assert.equal(episodeB.probe.status, 'ok')
  // Session ids are accepted as owners too.
  assert.equal(await tracker.probePromiseFor('shared-call', 'session-A'), episodeA)
})

test('probePromiseFor: wrong or absent owner never returns another session promise', async (t) => {
  const { tracker, episodeA } = await openDuplicateCallId(t)
  assert.equal(await tracker.probePromiseFor('shared-call'), undefined, 'ambiguous single-argument lookups resolve undefined')
  assert.equal(await tracker.probePromiseFor('shared-call', 'agent-C'), undefined, 'a wrong owner resolves undefined')
  assert.equal(await tracker.probePromiseFor('shared-call', ''), undefined, 'an empty owner is treated as ambiguous')
  assert.equal(await tracker.probePromiseFor('shared-call', 'agent-A'), episodeA)
})

test('onToolResult for one session does not touch another session that reused the callId', async (t) => {
  const { tracker, sessionA, sessionB, execA, execB, episodeA, episodeB } = await openDuplicateCallId(t)

  tracker.onToolResult({
    exec: execB,
    result: { isError: false, content: [{ type: 'text', text: 'B loaded its skill' }] },
    session: sessionB,
  })
  assert.equal(episodeB.call.isError, false, 'session B result is recorded on B')
  assert.deepEqual(episodeA.call, null, "session A's call stays untouched")
  assert.equal(tracker.openCount(), 2, 'both observation windows remain open')

  // A result executed without an agent id must not be guessed onto either window either.
  tracker.onToolResult({
    exec: { callId: 'shared-call', name: 'skill', arguments: { name: 'office-xlsx' }, signal: new AbortController().signal },
    result: { isError: true, content: [] },
  })
  assert.deepEqual(episodeA.call, null)

  // Ending session B finalizes only B; A keeps observing.
  tracker.onSessionEvent(sessionB, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await waitFor(() => episodeB._finalized === true)
  assert.equal(episodeA._finalized, undefined, "session A's window is still open")
  assert.equal(tracker.openCount(), 1)
  assert.equal(tracker.isSkillBusy('office-xlsx'), true)

  // A's own load result still correlates after B finalized.
  tracker.onToolResult({
    exec: execA,
    result: { isError: false, content: [{ type: 'text', text: 'A loaded its skill' }] },
    session: sessionA,
  })
  assert.equal(episodeA.call.isError, false)
  tracker.onSessionEvent(sessionA, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await waitFor(() => episodeA._finalized === true)
  assert.equal(tracker.openCount(), 0)
})
