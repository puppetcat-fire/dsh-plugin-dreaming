/**
 * Unit tests for lib/probe.js — sampling, caps, inline parsing, failure containment and the
 * optional (fallback-only) subagent backend.
 * Run directly: `node test/probe.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { CAPS } from '../lib/constants.js'
import { DEFAULTS } from '../lib/config.js'
import { emptySkillState } from '../lib/stats.js'
import { createProbeLimiter, emptyProbeRecord, hasKnownGap, probeSkill, selectProbe } from '../lib/probe.js'

const silentLogger = () => {
  const lines = { debug: [], info: [], warn: [], error: [] }
  const push = (level) => (message) => lines[level].push(String(message))
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
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

function createStore(skills = []) {
  const skillMap = new Map()
  for (const skill of skills) skillMap.set(skill.name, skill)
  const episodes = new Map()
  return {
    skills: skillMap,
    episodes,
    ensureSkill({ name, meta, editable }) {
      let skill = skillMap.get(name)
      if (skill === undefined) {
        skill = emptySkillState({ name, meta })
        skillMap.set(name, skill)
      }
      skill.editable = Boolean(editable)
      return skill
    },
    getSkill(name) {
      return skillMap.get(name)
    },
    appendEpisode(record) {
      episodes.set(record.id, record)
      return record
    },
    updateEpisode(id, patch) {
      const current = episodes.get(id)
      if (current === undefined) return undefined
      const next = { ...current, ...patch, id }
      episodes.set(id, next)
      return next
    },
    updateSkill(name, mutator) {
      const skill = skillMap.get(name)
      if (skill === undefined) return undefined
      mutator?.(skill)
      return skill
    },
    bumpTotals() {},
  }
}

function makeReply(value, { inputTokens = 120, outputTokens = 30 } = {}) {
  return [
    { type: 'text-delta', index: 0, text: JSON.stringify(value) },
    { type: 'usage', usage: { inputTokens, outputTokens } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function createCtx({ handler, subagents } = {}) {
  const calls = []
  const ctx = {
    logger: silentLogger(),
    get: () => undefined,
    llm: {
      async listProviders() {
        return [{ id: 'prov-1', name: 'Provider 1' }]
      },
      async listModels(provider) {
        return [{ provider, id: 'model-1', name: 'Model 1' }]
      },
      stream(options) {
        calls.push(options)
        const items = handler(options, calls.length - 1)
        return (async function* iterate() {
          for (const item of items) yield item
        })()
      },
    },
    ...(subagents !== undefined ? { subagents } : {}),
  }
  ctx.calls = calls
  return ctx
}

function makeEpisode(overrides = {}) {
  const base = {
    id: 'ep_probe_test',
    sessionId: 'session-1',
    callId: 'call-1',
    skill: 'office-xlsx',
    startedAt: Date.now(),
    endedAt: 0,
    state: 'recording',
    skillMeta: {
      name: 'office-xlsx',
      description: 'Build and edit Excel workbooks',
      whenToUse: 'When a spreadsheet is needed',
      source: 'user-dsh',
      provider: 'filesystem',
      path: 'C:\\Users\\me\\.dsh\\skills\\office-xlsx\\SKILL.md',
      resourceBase: null,
      bodyChars: 4200,
      bodyTokens: 1200,
    },
    task: {
      userGoal: 'make a budget spreadsheet',
      recentUser: ['make a budget spreadsheet'],
      recentAssistant: ['sure'],
      cwd: 'C:\\workspace',
      messageCount: 3,
    },
    prediction: null,
    probe: emptyProbeRecord('inline'),
    call: null,
    trace: { observedMs: 0, turnEnd: 'unknown', assistantTexts: [], toolSequence: [], userMessages: [], skillReLoaded: false, finalAnswerChars: 0 },
    judge: null,
    cost: null,
    flags: { sampled: false, truncated: false, dreamIds: [] },
  }
  return { ...base, ...overrides, flags: { ...base.flags, ...(overrides.flags ?? {}) } }
}

const validProbe = {
  fit: 0.78,
  confidence: 0.62,
  intent: 'produce a spreadsheet with a budget table',
  expectedUse: ['create workbook', 'apply formatting'],
  successSignals: ['a valid xlsx exists'],
  likelyPitfalls: ['may not compute formulas'],
  capabilityGap: 'claims charting support that may be missing',
  cheaperAlternative: 'write a CSV instead',
  expectedValueTokens: 700,
}

function promptChars(options) {
  let total = typeof options.system === 'string' ? options.system.length : 0
  for (const message of options.messages ?? []) {
    for (const block of message.content ?? []) total += block.text?.length ?? 0
  }
  return total
}

test('selectProbe: disabled, sampled-out and body-too-small are skipped', () => {
  const skillMeta = { bodyChars: 4000 }
  assert.equal(selectProbe({ config: makeConfig({ probe: { enabled: false } }), skillMeta }).selected, false)
  assert.equal(selectProbe({ config: makeConfig({ probe: { sampleRate: 0, alwaysForGapSkills: false } }), skillMeta }).selected, false)
  const tiny = selectProbe({ config: makeConfig({ probe: { minBodyChars: 100 } }), skillMeta: { bodyChars: 50 } })
  assert.equal(tiny.selected, false)
  assert.equal(tiny.reason, 'body-too-small')
})

test('selectProbe: known-gap skills are forced when alwaysForGapSkills is on', () => {
  const gapSkill = { counts: { boundaryGaps: 2, misapplied: 0 } }
  assert.equal(hasKnownGap(gapSkill), true)
  const decision = selectProbe({
    config: makeConfig({ probe: { sampleRate: 0, alwaysForGapSkills: true } }),
    skillMeta: { bodyChars: 4000 },
    skillState: gapSkill,
    random: () => 1,
  })
  assert.equal(decision.selected, true)
  assert.equal(decision.forced, true)
  assert.equal(decision.sampled, false)
})

test('selectProbe: does not consume a limiter slot when the episode is skipped', () => {
  let takes = 0
  const limiter = { take: () => { takes += 1; return true } }
  const decision = selectProbe({ config: makeConfig({ probe: { sampleRate: 0, alwaysForGapSkills: false } }), skillMeta: { bodyChars: 100 }, limiter })
  assert.equal(decision.selected, false)
  assert.equal(takes, 0)
})

test('createProbeLimiter: enforces the rolling per-hour cap', () => {
  let clock = 1_000_000
  const limiter = createProbeLimiter({ maxPerHour: 2, now: () => clock })
  assert.equal(limiter.take(), true)
  assert.equal(limiter.take(), true)
  assert.equal(limiter.take(), false)
  assert.equal(limiter.count(), 2)
  clock += 3_600_001
  assert.equal(limiter.take(), true, 'old stamps are pruned after an hour')
})

test('probeSkill: success fills prediction and probe usage; request is bounded', async () => {
  const store = createStore()
  const config = makeConfig({ probe: { model: { provider: 'probe-p', model: 'probe-m', maxTokens: 20_000 } } })
  const ctx = createCtx({ handler: () => makeReply(validProbe) })
  const episode = makeEpisode()
  const result = await probeSkill({ ctx, config, store, episode, session: undefined, skillBody: '# skill body' })
  assert.equal(result, episode)
  assert.equal(episode.probe.status, 'ok')
  assert.equal(episode.probe.backend, 'inline')
  assert.equal(episode.probe.model, 'probe-p/probe-m')
  assert.equal(episode.probe.tokensIn, 120)
  assert.equal(episode.probe.tokensOut, 30)
  assert.ok(episode.probe.latencyMs >= 0)
  assert.equal(episode.prediction.fit, 0.78)
  assert.equal(episode.prediction.cheaperAlternative, 'write a CSV instead')
  assert.ok(episode._probePromise, 'the promise is attached to the episode')
  assert.deepEqual(await episode._probePromise, episode)
  const sent = ctx.calls[0]
  assert.equal(sent.provider, 'probe-p')
  assert.equal(sent.model, 'probe-m')
  assert.ok(sent.maxTokens <= CAPS.probeMaxTokens, `probe maxTokens ${sent.maxTokens} must be capped`)
  assert.ok(promptChars(sent) <= CAPS.probeInputChars)
  assert.equal(sent.temperature, config.probe.temperature)
})

test('probeSkill: disabled config records a skipped probe and calls no model', async () => {
  const ctx = createCtx({ handler: () => assert.fail('model must not be called') })
  const episode = makeEpisode()
  await probeSkill({ ctx, config: makeConfig({ probe: { enabled: false } }), store: createStore(), episode })
  assert.equal(episode.probe.status, 'skipped')
  assert.equal(episode.prediction, null)
  assert.equal(ctx.calls.length, 0)
})

test('probeSkill: sampleRate 0 skips a healthy skill without calling the model', async () => {
  const ctx = createCtx({ handler: () => assert.fail('model must not be called') })
  const episode = makeEpisode()
  await probeSkill({
    ctx,
    config: makeConfig({ probe: { sampleRate: 0, alwaysForGapSkills: false } }),
    store: createStore([emptySkillState({ name: 'office-xlsx' })]),
    episode,
    random: () => 0.99,
  })
  assert.equal(episode.probe.status, 'skipped')
  assert.equal(ctx.calls.length, 0)
})

test('probeSkill: a known-gap skill is probed even with sampleRate 0', async () => {
  const skill = emptySkillState({ name: 'office-xlsx' })
  skill.counts.misapplied = 2
  const ctx = createCtx({ handler: () => makeReply(validProbe) })
  const episode = makeEpisode()
  await probeSkill({
    ctx,
    config: makeConfig({ probe: { sampleRate: 0, alwaysForGapSkills: true } }),
    store: createStore([skill]),
    episode,
    random: () => 0.99,
  })
  assert.equal(episode.probe.status, 'ok')
  assert.equal(episode.flags.sampled, false, 'forced probes are not marked as sampled')
  assert.equal(ctx.calls.length, 1)
})

test('probeSkill: per-hour cap turns later probes into skipped', async () => {
  const limiter = createProbeLimiter({ maxPerHour: 1 })
  const ctx = createCtx({ handler: () => makeReply(validProbe) })
  const first = makeEpisode({ id: 'ep_1', callId: 'call-1' })
  const second = makeEpisode({ id: 'ep_2', callId: 'call-2' })
  await probeSkill({ ctx, config: makeConfig(), store: createStore(), episode: first, limiter })
  await probeSkill({ ctx, config: makeConfig(), store: createStore(), episode: second, limiter })
  assert.equal(first.probe.status, 'ok')
  assert.equal(second.probe.status, 'skipped')
  assert.equal(ctx.calls.length, 1)
})

test('probeSkill: invalid JSON records status invalid without rejecting', async () => {
  const ctx = createCtx({ handler: () => [{ type: 'text-delta', index: 0, text: 'not json at all' }, { type: 'finish', reason: { kind: 'stop' } }] })
  const episode = makeEpisode()
  await probeSkill({ ctx, config: makeConfig(), store: createStore(), episode })
  assert.equal(episode.probe.status, 'invalid')
  assert.equal(episode.prediction, null)
  assert.equal(episode.probe.error, 'invalid-json')
})

test('probeSkill: adapter failure records status error and never rejects', async () => {
  const ctx = createCtx({
    handler: () => {
      const error = new Error('adapter exploded')
      error.code = 'LLM_INVALID_REQUEST'
      throw error
    },
  })
  const episode = makeEpisode()
  await assert.doesNotReject(() => probeSkill({ ctx, config: makeConfig(), store: createStore(), episode }))
  assert.equal(episode.probe.status, 'error')
  assert.match(episode.probe.error, /adapter exploded/)
  assert.equal(episode.prediction, null)
})

test('probeSkill: missing llm service is contained', async () => {
  const ctx = { logger: silentLogger(), get: () => undefined }
  const episode = makeEpisode()
  await probeSkill({ ctx, config: makeConfig(), store: createStore(), episode })
  assert.equal(episode.probe.status, 'error')
  assert.ok(episode.probe.error.length > 0)
})

test('probeSkill: hostile store.getSkill cannot break the probe', async () => {
  const store = {
    getSkill() {
      throw new Error('store unavailable')
    },
  }
  const ctx = createCtx({ handler: () => makeReply(validProbe) })
  const episode = makeEpisode()
  await probeSkill({ ctx, config: makeConfig(), store, episode })
  assert.equal(episode.probe.status, 'ok')
})

test('probeSkill: subagent mode falls back to inline when the service is missing', async () => {
  const ctx = createCtx({ handler: () => makeReply(validProbe) })
  const episode = makeEpisode()
  await probeSkill({ ctx, config: makeConfig({ probe: { mode: 'subagent' } }), store: createStore(), episode })
  assert.equal(episode.probe.backend, 'inline')
  assert.equal(episode.probe.status, 'ok')
  assert.equal(ctx.calls.length, 1)
})

test('probeSkill: subagent backend parses caller-delivery output and disposes the activation', async () => {
  let disposed = 0
  let inlineCalls = 0
  const ctx = createCtx({
    handler: () => {
      inlineCalls += 1
      return makeReply(validProbe)
    },
    subagents: {
      async startActivation(request) {
        assert.equal(request.delivery, 'caller')
        assert.equal(request.provider, 'spawn')
        assert.equal(request.request.cwd, 'C:\\workspace')
        assert.equal(Array.isArray(request.request.prompt), true)
        return {
          childId: 'child-1',
          result: Promise.resolve({ output: [{ type: 'text', text: JSON.stringify(validProbe) }], stopReason: 'stop' }),
          dispose: async () => {
            disposed += 1
          },
        }
      },
    },
  })
  const episode = makeEpisode()
  episode.agent = { id: 'agent-1' }
  await probeSkill({ ctx, config: makeConfig({ probe: { mode: 'subagent' } }), store: createStore(), episode })
  assert.equal(episode.probe.status, 'ok')
  assert.equal(episode.probe.backend, 'subagent')
  assert.equal(inlineCalls, 0)
  assert.equal(disposed, 1)
  assert.equal(episode.prediction.fit, 0.78)
})

test('probeSkill: subagent failure falls back to inline and still disposes', async () => {
  let disposed = 0
  const ctx = createCtx({
    handler: () => makeReply(validProbe),
    subagents: {
      async startActivation() {
        return {
          childId: 'child-fail',
          result: Promise.reject(new Error('child exploded')),
          dispose: async () => {
            disposed += 1
          },
        }
      },
    },
  })
  const episode = makeEpisode()
  await probeSkill({ ctx, config: makeConfig({ probe: { mode: 'subagent' } }), store: createStore(), episode })
  assert.equal(disposed, 1)
  assert.equal(episode.probe.backend, 'inline', 'fallback is recorded as the actual backend')
  assert.equal(episode.probe.status, 'ok')
  assert.equal(ctx.calls.length, 1)
})

test('probeSkill: subagent that never resolves times out and falls back to inline', async () => {
  const ctx = createCtx({
    handler: () => makeReply(validProbe),
    subagents: {
      async startActivation() {
        return { childId: 'child-hang', result: new Promise(() => {}), dispose: async () => {} }
      },
    },
  })
  const episode = makeEpisode()
  const startedAt = Date.now()
  await probeSkill({
    ctx,
    config: makeConfig({ probe: { mode: 'subagent', timeoutMs: 60 } }),
    store: createStore(),
    episode,
  })
  assert.ok(Date.now() - startedAt < 3000)
  assert.equal(episode.probe.status, 'ok')
  assert.equal(episode.probe.backend, 'inline')
})

test('probeSkill: cancelled signal records an error instead of hanging', async () => {
  const controller = new AbortController()
  const ctx = createCtx({
    handler: (options) =>
      (async function* iterate() {
        await new Promise((resolvePromise) => {
          options.signal.addEventListener('abort', resolvePromise, { once: true })
        })
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      })(),
  })
  setTimeout(() => controller.abort(new Error('dispose')), 10)
  const episode = makeEpisode()
  await probeSkill({ ctx, config: makeConfig(), store: createStore(), episode, signal: controller.signal })
  assert.equal(episode.probe.status, 'error')
})

test('probePromiseFor semantics: probeSkill promise resolves to the episode (never rejects)', async () => {
  const ctx = createCtx({ handler: () => makeReply(validProbe) })
  const episode = makeEpisode()
  const promise = probeSkill({ ctx, config: makeConfig(), store: createStore(), episode })
  const value = await promise
  assert.equal(value, episode)
  assert.equal(episode.probe.status, 'ok')
  assert.deepEqual(await Promise.all([promise, promise]), [episode, episode])
})

test('probeSkill: text truncated flag is set when the prompt had to shrink the body', async () => {
  const ctx = createCtx({ handler: () => makeReply(validProbe) })
  const episode = makeEpisode({
    skillMeta: { ...makeEpisode().skillMeta, bodyChars: 500_000 },
  })
  await probeSkill({ ctx, config: makeConfig(), store: createStore(), episode, skillBody: 'x'.repeat(200_000) })
  assert.equal(episode.flags.truncated, true)
})
