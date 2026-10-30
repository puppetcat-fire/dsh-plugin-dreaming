/**
 * Unit tests for lib/judge.js — validation/retry, cost semantics, store folding and failure
 * containment. Run directly: `node test/judge.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { CAPS } from '../lib/constants.js'
import { DEFAULTS } from '../lib/config.js'
import { emptySkillState } from '../lib/stats.js'
import { applyEpisodeToSkill } from '../lib/stats.js'
import { buildGuidanceFindings, computeEpisodeCost, emptyJudgeRecord, estimateTraceTokens, judgeEpisode } from '../lib/judge.js'

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
  const totals = {}
  const calls = { updateEpisode: [], updateSkill: [], bumpTotals: [], saveState: 0 }
  return {
    skills: skillMap,
    episodes,
    totals,
    calls,
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
    saveState() {
      calls.saveState += 1
    },
  }
}

function makeReply(value, { inputTokens = 300, outputTokens = 120, finish = 'stop' } = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'usage', usage: { inputTokens, outputTokens } },
    { type: 'finish', reason: { kind: finish } },
  ]
}

function createCtx({ handler } = {}) {
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
  }
  ctx.calls = calls
  return ctx
}

const validJudgeReply = {
  score: 34,
  verdict: 'misapplied',
  predictionAccuracy: 0.3,
  capabilityGap: { present: true, claim: 'claims charting support', reality: 'no chart was produced' },
  mismatches: [{ expected: 'a chart', observed: 'a table only', cause: 'description overclaims charting' }],
  rootCause: 'description',
  reusableRule: 'Use this skill only for tabular worksheet files.',
  rework: true,
  recommendation: {
    descriptionEdit: 'Build and edit tabular Excel worksheets with formulas; charting is not supported.',
    bodyAddition: '## Boundaries\n- Tabular worksheets only.',
    selectionRule: 'Use for xlsx tables, not charts.',
  },
}

function makeEpisode(overrides = {}) {
  const base = {
    id: 'ep_judge_test',
    sessionId: 'session-1',
    callId: 'call-1',
    skill: 'office-xlsx',
    startedAt: 1_000,
    endedAt: 0,
    state: 'observed',
    skillMeta: {
      name: 'office-xlsx',
      description: 'Build and edit Excel workbooks including charts',
      whenToUse: 'When a spreadsheet is needed',
      source: 'user-dsh',
      provider: 'filesystem',
      path: 'C:\\Users\\me\\.dsh\\skills\\office-xlsx\\SKILL.md',
      resourceBase: null,
      bodyChars: 4200,
      bodyTokens: 1200,
    },
    task: { userGoal: 'make a chart workbook', recentUser: [], recentAssistant: [], cwd: 'C:\\workspace', messageCount: 4 },
    prediction: {
      fit: 0.72,
      confidence: 0.6,
      intent: 'produce a workbook with a chart',
      expectedUse: ['create workbook', 'add chart'],
      successSignals: ['a chart exists'],
      likelyPitfalls: ['charting may be missing'],
      capabilityGap: 'chart claim may be false',
      cheaperAlternative: 'use a markdown table',
      expectedValueTokens: 800,
    },
    probe: { backend: 'inline', model: 'prov-1/model-1', status: 'ok', tokensIn: 1500, tokensOut: 300, latencyMs: 2100, error: null },
    call: { isError: false, durationMs: 40, contentChars: 4300 },
    trace: {
      observedMs: 42000,
      turnEnd: 'completed',
      assistantTexts: ['I created the worksheet.', 'Done — the table is ready.'],
      toolSequence: [
        { name: 'write', ok: true, brief: 'wrote sheet.xlsx' },
        { name: 'write', ok: true, brief: 'rewrote sheet.xlsx without charts' },
      ],
      userMessages: ['where is the chart?'],
      skillReLoaded: false,
      finalAnswerChars: 800,
    },
    judge: null,
    cost: null,
    flags: { sampled: false, truncated: false, dreamIds: [] },
  }
  return { ...base, ...overrides, flags: { ...base.flags, ...(overrides.flags ?? {}) } }
}

test('judgeEpisode: success fills judge/cost, marks judged and folds into the skill belief', async () => {
  const store = createStore([emptySkillState({ name: 'office-xlsx', meta: { description: 'old' } })])
  const ctx = createCtx({ handler: () => makeReply(validJudgeReply) })
  const episode = makeEpisode()
  const result = await judgeEpisode({ ctx, config: makeConfig(), store, episode, session: undefined })
  assert.equal(result, episode)
  assert.equal(episode.state, 'judged')
  assert.equal(episode.judge.status, 'ok')
  assert.equal(episode.judge.score, 34)
  assert.equal(episode.judge.verdict, 'misapplied')
  assert.equal(episode.judge.rootCause, 'description')
  assert.equal(episode.judge.tokensIn, 300)
  assert.equal(episode.judge.tokensOut, 120)
  assert.equal(episode.judge.model, 'prov-1/model-1')

  // Cost semantics: skillLoad (1200) + measured rework.
  assert.equal(episode.cost.skillLoad, 1200)
  assert.equal(episode.cost.probe, 1800)
  assert.equal(episode.cost.judge, 420)
  const expectedRework = estimateTraceTokens(episode.trace)
  assert.ok(expectedRework > 0)
  assert.equal(episode.cost.reworkEstimate, expectedRework)
  assert.equal(episode.cost.wastedEstimate, 1200 + expectedRework)

  const skill = store.getSkill('office-xlsx')
  assert.equal(skill.counts.judged, 1)
  assert.equal(skill.counts.misapplied, 1)
  assert.equal(skill.counts.boundaryGaps, 1)
  assert.equal(skill.counts.loads, 1)
  assert.equal(skill.fitHistory.length, 1)
  assert.equal(skill.fitHistory[0].verdict, 'misapplied')
  assert.equal(store.totals.judged, 1)
  assert.equal(store.totals.wastedTokens, episode.cost.wastedEstimate)
  assert.ok(store.calls.updateEpisode.some((call) => call.patch.state === 'judged'))
  assert.equal(store.episodes.get(episode.id).state, 'judged')
  assert.equal(ctx.calls[0].temperature, 0.1)
  assert.ok(ctx.calls[0].maxTokens <= CAPS.judgeMaxTokens)
})

test('judgeEpisode: no-op when judging is disabled', async () => {
  const store = createStore([emptySkillState({ name: 'office-xlsx' })])
  const ctx = createCtx({ handler: () => assert.fail('model must not be called') })
  const episode = makeEpisode()
  await judgeEpisode({ ctx, config: makeConfig({ judge: { enabled: false } }), store, episode })
  assert.equal(episode.judge.status, 'skipped')
  assert.equal(episode.state, 'observed')
  assert.equal(store.getSkill('office-xlsx').counts.judged, 0)
  assert.equal(ctx.calls.length, 0)
  assert.equal(store.calls.updateSkill.length, 0)
})

test('judgeEpisode: no prediction + judgeWithoutProbe=false is skipped; true still judges', async () => {
  const noPrediction = makeEpisode({ prediction: null })
  const skipStore = createStore([emptySkillState({ name: 'office-xlsx' })])
  const skipCtx = createCtx({ handler: () => makeReply(validJudgeReply) })
  await judgeEpisode({ ctx: skipCtx, config: makeConfig({ judge: { judgeWithoutProbe: false } }), store: skipStore, episode: noPrediction })
  assert.equal(noPrediction.judge.status, 'skipped')
  assert.equal(skipCtx.calls.length, 0)

  const judged = makeEpisode({ prediction: null })
  const store = createStore([emptySkillState({ name: 'office-xlsx' })])
  const ctx = createCtx({ handler: () => makeReply({ ...validJudgeReply, predictionAccuracy: 0.5 }) })
  await judgeEpisode({ ctx, config: makeConfig({ judge: { judgeWithoutProbe: true } }), store, episode: judged })
  assert.equal(judged.judge.status, 'ok')
  assert.equal(judged.judge.predictionAccuracy, 0.5)
  assert.equal(ctx.calls.length, 1)
})

test('judgeEpisode: invalid JSON retries once with a reminder, then succeeds', async () => {
  let calls = 0
  const ctx = createCtx({
    handler: () => {
      calls += 1
      return calls === 1 ? makeReply('this is not json') : makeReply(validJudgeReply)
    },
  })
  const store = createStore([emptySkillState({ name: 'office-xlsx' })])
  const episode = makeEpisode()
  await judgeEpisode({ ctx, config: makeConfig({ judge: { retryInvalidOnce: true } }), store, episode })
  assert.equal(calls, 2)
  assert.equal(episode.judge.status, 'ok')
  assert.equal(episode.judge.tokensIn, 600)
  assert.equal(episode.judge.tokensOut, 240)
  const retryMessages = ctx.calls[1].messages
  assert.ok(retryMessages.length >= 2)
  const lastText = retryMessages[retryMessages.length - 1].content.map((block) => block.text).join(' ')
  assert.match(lastText, /ONLY one JSON object/)
})

test('judgeEpisode: two invalid replies record status invalid and do not judge the skill', async () => {
  const ctx = createCtx({ handler: () => makeReply('still not json') })
  const store = createStore([emptySkillState({ name: 'office-xlsx' })])
  const episode = makeEpisode()
  await judgeEpisode({ ctx, config: makeConfig({ judge: { retryInvalidOnce: true } }), store, episode })
  assert.equal(ctx.calls.length, 2)
  assert.equal(episode.judge.status, 'invalid')
  assert.equal(episode.state, 'observed')
  assert.equal(store.getSkill('office-xlsx').counts.judged, 0)
  assert.ok(store.calls.updateEpisode.some((call) => call.patch.judge?.status === 'invalid'))
})

test('judgeEpisode: retryInvalidOnce=false makes a single attempt', async () => {
  const ctx = createCtx({ handler: () => makeReply('nope') })
  const episode = makeEpisode()
  await judgeEpisode({ ctx, config: makeConfig({ judge: { retryInvalidOnce: false } }), store: null, episode })
  assert.equal(ctx.calls.length, 1)
  assert.equal(episode.judge.status, 'invalid')
})

test('judgeEpisode: adapter failure records status error and never rejects', async () => {
  const ctx = createCtx({
    handler: () => {
      const error = new Error('adapter down')
      error.code = 'LLM_INVALID_REQUEST'
      throw error
    },
  })
  const store = createStore([emptySkillState({ name: 'office-xlsx' })])
  const episode = makeEpisode()
  await assert.doesNotReject(() => judgeEpisode({ ctx, config: makeConfig(), store, episode }))
  assert.equal(episode.judge.status, 'error')
  assert.match(episode.judge.error, /adapter down/)
  assert.equal(episode.state, 'observed')
  assert.equal(store.getSkill('office-xlsx').counts.judged, 0)
})

test('judgeEpisode: missing llm route is contained as an error', async () => {
  const ctx = { logger: silentLogger(), get: () => undefined }
  const episode = makeEpisode()
  await judgeEpisode({ ctx, config: makeConfig(), store: null, episode })
  assert.equal(episode.judge.status, 'error')
})

test('computeEpisodeCost: conservative semantics for matched, missed, no-rework and missing body size', () => {
  const matched = makeEpisode({
    judge: { status: 'ok', verdict: 'matched', score: 92, rework: false },
    cost: null,
  })
  const matchedCost = computeEpisodeCost(matched)
  assert.equal(matchedCost.skillLoad, 1200)
  assert.equal(matchedCost.reworkEstimate, 0)
  assert.equal(matchedCost.wastedEstimate, 0)

  const misapplied = makeEpisode({ judge: { status: 'ok', verdict: 'misapplied', rework: false } })
  assert.equal(computeEpisodeCost(misapplied).wastedEstimate, 1200)

  const missed = makeEpisode({ judge: { status: 'ok', verdict: 'missed', rework: false } })
  assert.equal(computeEpisodeCost(missed).wastedEstimate, 1200, 'a missed load wasted the skill body')

  const missedWithRework = makeEpisode({ judge: { status: 'ok', verdict: 'missed', rework: true } })
  assert.equal(
    computeEpisodeCost(missedWithRework).wastedEstimate,
    1200 + estimateTraceTokens(missedWithRework.trace),
  )

  const unknownBody = makeEpisode({
    skillMeta: { ...makeEpisode().skillMeta, bodyChars: 0, bodyTokens: 0 },
    judge: { status: 'ok', verdict: 'misapplied', rework: false },
  })
  assert.equal(computeEpisodeCost(unknownBody).skillLoad, 0, 'missing body size yields 0, never a guess')
  assert.equal(computeEpisodeCost(unknownBody).wastedEstimate, 0)

  const partialNoRework = makeEpisode({ judge: { status: 'ok', verdict: 'partial', rework: false } })
  assert.equal(computeEpisodeCost(partialNoRework).wastedEstimate, 0, 'a partial match keeps its load cost')

  const partialWithRework = makeEpisode({ judge: { status: 'ok', verdict: 'partial', rework: true } })
  const partialCost = computeEpisodeCost(partialWithRework)
  assert.equal(partialCost.wastedEstimate, partialCost.reworkEstimate)
})

test('judgeEpisode: giant trace is bounded and flagged truncated', async () => {
  const giantTrace = {
    observedMs: 10_000,
    turnEnd: 'completed',
    assistantTexts: Array.from({ length: 4 }, () => 'a'.repeat(2000)),
    toolSequence: Array.from({ length: 200 }, (_, index) => ({ name: `tool-${index}`, ok: index % 2 === 0, brief: 'b'.repeat(400) })),
    userMessages: Array.from({ length: 3 }, () => 'u'.repeat(1000)),
    skillReLoaded: true,
    finalAnswerChars: 4000,
  }
  const ctx = createCtx({ handler: () => makeReply(validJudgeReply) })
  const episode = makeEpisode({ trace: giantTrace })
  await judgeEpisode({ ctx, config: makeConfig(), store: null, episode })
  assert.equal(episode.judge.status, 'ok')
  assert.ok(episode.trace.toolSequence.length <= CAPS.traceToolItems)
  assert.ok(episode.trace.assistantTexts.length <= CAPS.traceAssistantItems)
  assert.equal(episode.flags.truncated, true)
  const sent = ctx.calls[0]
  let chars = sent.system.length
  for (const message of sent.messages) for (const block of message.content) chars += block.text.length
  assert.ok(chars <= CAPS.judgeInputChars, `judge prompt ${chars} > ${CAPS.judgeInputChars}`)
})

test('judgeEpisode: guidance.mergeLearnings receives findings; a throwing overlay is contained', async () => {
  const store = createStore([emptySkillState({ name: 'office-xlsx' })])
  let findings = null
  const guidance = {
    mergeLearnings(skill, received, options) {
      findings = { received, options }
      skill.learned.whenNotToUse.push('charts are not supported')
      return skill
    },
  }
  const episode = makeEpisode()
  await judgeEpisode({ ctx: createCtx({ handler: () => makeReply(validJudgeReply) }), config: makeConfig(), store, episode, guidance })
  assert.equal(episode.judge.status, 'ok')
  assert.ok(findings)
  assert.equal(findings.options.maxNotes, CAPS.notesPerSkill)
  assert.ok(findings.received.whenNotToUse.length >= 1)
  assert.ok(store.getSkill('office-xlsx').learned.whenNotToUse.includes('charts are not supported'))

  const throwingEpisode = makeEpisode({ id: 'ep_guidance_fail' })
  const throwingStore = createStore([emptySkillState({ name: 'office-xlsx' })])
  const throwingGuidance = {
    mergeLearnings() {
      throw new Error('overlay exploded')
    },
  }
  await judgeEpisode({
    ctx: createCtx({ handler: () => makeReply(validJudgeReply) }),
    config: makeConfig(),
    store: throwingStore,
    episode: throwingEpisode,
    guidance: throwingGuidance,
  })
  assert.equal(throwingEpisode.judge.status, 'ok', 'a guidance failure must not fail the judge')
})

test('judgeEpisode: works without a store (in-memory only)', async () => {
  const episode = makeEpisode()
  await judgeEpisode({ ctx: createCtx({ handler: () => makeReply(validJudgeReply) }), config: makeConfig(), store: null, episode })
  assert.equal(episode.judge.status, 'ok')
  assert.equal(episode.state, 'judged')
  assert.ok(episode.cost.wastedEstimate > 0)
})

test('judgeEpisode: hostile store methods cannot cause a rejection', async () => {
  const store = {
    updateEpisode() {
      throw new Error('disk full')
    },
    updateSkill() {
      throw new Error('state corrupt')
    },
    bumpTotals() {
      throw new Error('totals corrupt')
    },
    saveState() {
      throw new Error('save failed')
    },
    getSkill() {
      throw new Error('index corrupt')
    },
  }
  const episode = makeEpisode()
  await assert.doesNotReject(() => judgeEpisode({ ctx: createCtx({ handler: () => makeReply(validJudgeReply) }), config: makeConfig(), store, episode }))
  assert.equal(episode.judge.status, 'ok')
})

test('emptyJudgeRecord is a pending record; applyEpisodeToSkill accepts the judged episode shape', () => {
  const record = emptyJudgeRecord()
  assert.equal(record.status, 'pending')
  const skill = emptySkillState({ name: 'office-xlsx' })
  const episode = makeEpisode({ judge: { status: 'ok', verdict: 'matched', score: 90 }, state: 'judged', cost: { wastedEstimate: 0 } })
  applyEpisodeToSkill(skill, episode)
  assert.equal(skill.counts.judged, 1)
  assert.equal(skill.metrics.meanScore, 90)
})

test('guidance findings phrase capability gaps as boundaries, not as claims', () => {
  const findings = buildGuidanceFindings({
    id: 'ep_x',
    prediction: { cheaperAlternative: 'Answer directly.' },
    judge: {
      status: 'ok',
      score: 20,
      verdict: 'misapplied',
      capabilityGap: { present: true, claim: 'Analyze any dataset and produce charts.', reality: 'Prints one line.' },
      mismatches: [{ cause: 'description' }],
      recommendation: { selectionRule: 'Do not select this skill for data analysis.', bodyAddition: 'State the limitation.' },
      reusableRule: 'Trust the body over the description.',
    },
  })
  assert.equal(findings.whenNotToUse.some((line) => line.startsWith('Do not rely on this skill for:')), true)
  assert.equal(findings.whenNotToUse.some((line) => line.startsWith('Do not select this skill')), true)
  assert.equal(findings.actualScope.some((line) => line.includes('Prints one line.')), true)
  assert.equal(findings.whenToUse.length, 0)
  assert.ok(findings.notes.length >= 1)
})
