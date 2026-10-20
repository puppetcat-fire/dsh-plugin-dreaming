/**
 * Unit tests for lib/prompts.js — bounded builders, descriptors and coercing validators.
 * Run directly: `node test/prompts.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { CAPS, ROOT_CAUSES, VERDICTS } from '../lib/constants.js'
import { DEFAULTS } from '../lib/config.js'
import {
  DREAM_SCHEMA,
  JUDGE_RETRY_REMINDER,
  JUDGE_SCHEMA,
  PROBE_SCHEMA,
  buildDreamInput,
  buildJudgeInput,
  buildProbeInput,
  compactCase,
  promptTokenEstimate,
  renderRequestText,
  renderTraceText,
  validateDream,
  validateJudge,
  validateProbe,
  verdictFromScore,
} from '../lib/prompts.js'

function config(overrides = {}) {
  const base = JSON.parse(JSON.stringify(DEFAULTS))
  return { ...base, ...overrides, observe: { ...base.observe, ...(overrides.observe ?? {}) } }
}

function promptChars(prompt) {
  let total = prompt.system.length
  for (const message of prompt.messages) {
    for (const block of message.content) total += block.text.length
  }
  return total
}

function promptText(prompt) {
  return [prompt.system, ...prompt.messages.flatMap((message) => message.content.map((block) => block.text))].join('\n')
}

const bigSkillBody = `# Skill\n${'Long capability text with many details. '.repeat(400)}`
const bigTask = {
  userGoal: `goal ${'x'.repeat(5000)}`,
  recentUser: Array.from({ length: 8 }, () => `user ${'y'.repeat(2000)}`),
  recentAssistant: Array.from({ length: 8 }, () => `assistant ${'z'.repeat(2000)}`),
  cwd: 'C:\\workspace',
  messageCount: 40,
}

test('buildProbeInput: emits the required sections and one user text block', () => {
  const prompt = buildProbeInput({
    skillMeta: {
      name: 'office-xlsx',
      description: 'Build and edit Excel workbooks',
      whenToUse: 'When a spreadsheet must be produced or modified',
      bodyChars: 120,
      content: 'Use openpyxl to read and write xlsx files.',
    },
    task: { userGoal: 'create a budget spreadsheet', recentUser: ['make me a budget'], recentAssistant: ['sure'], cwd: 'C:\\w', messageCount: 3 },
    learned: { learned: { whenNotToUse: ['Do not use for CSV'] }, counts: { loads: 4, judged: 3 } },
    config: config(),
  })
  assert.equal(typeof prompt.system, 'string')
  assert.equal(prompt.messages.length, 1)
  assert.equal(prompt.messages[0].role, 'user')
  assert.equal(prompt.messages[0].content[0].type, 'text')
  const text = promptText(prompt)
  assert.match(text, /<skill>/)
  assert.match(text, /office-xlsx/)
  assert.match(text, /<task>/)
  assert.match(text, /<learned>/)
  assert.match(text, /<recent>/)
  assert.match(prompt.system, /JSON/)
  assert.equal(prompt.truncated, false)
})

test('buildProbeInput: stays under CAPS.probeInputChars for adversarial oversized input', () => {
  const prompt = buildProbeInput({
    skillMeta: { name: 'huge', description: 'd'.repeat(10000), whenToUse: 'w'.repeat(5000), bodyChars: 999999, content: bigSkillBody },
    task: bigTask,
    learned: {
      learned: {
        whenNotToUse: Array.from({ length: 20 }, () => 'n'.repeat(500)),
        preconditions: Array.from({ length: 20 }, () => 'p'.repeat(500)),
      },
      counts: { loads: 1, judged: 1 },
    },
    config: config(),
  })
  assert.ok(promptChars(prompt) <= CAPS.probeInputChars, `probe prompt ${promptChars(prompt)} > ${CAPS.probeInputChars}`)
  assert.equal(prompt.truncated, true)
})

test('buildProbeInput: body excerpt is capped at CAPS.skillBodyCharsForProbe', () => {
  const prompt = buildProbeInput({ skillMeta: { name: 's', description: 'd', content: bigSkillBody }, task: {}, learned: {} })
  const text = promptText(prompt)
  const start = text.indexOf('body_excerpt:\n') + 'body_excerpt:\n'.length
  const end = text.indexOf('</skill>')
  const excerpt = text.slice(start, end)
  assert.ok(excerpt.length <= CAPS.skillBodyCharsForProbe + 2, `excerpt ${excerpt.length}`)
  assert.ok(excerpt.length > 0)
})

const giantTrace = {
  observedMs: 123456,
  turnEnd: 'completed',
  assistantTexts: Array.from({ length: 4 }, () => 'a'.repeat(2000)),
  toolSequence: Array.from({ length: 60 }, (_, index) => ({ name: `tool-${index}`, ok: index % 2 === 0, brief: 'b'.repeat(500) })),
  userMessages: Array.from({ length: 3 }, () => 'u'.repeat(2000)),
  skillReLoaded: true,
  finalAnswerChars: 1234,
}

test('buildJudgeInput: bounded under CAPS.judgeInputChars with a giant trace and prediction', () => {
  const episode = {
    skill: 'office-xlsx',
    skillMeta: { name: 'office-xlsx', description: 'd'.repeat(4000), whenToUse: 'w'.repeat(2000), bodyChars: 4200 },
    prediction: {
      fit: 0.4,
      confidence: 0.5,
      intent: 'i'.repeat(3000),
      expectedUse: Array.from({ length: 10 }, () => 'e'.repeat(800)),
      likelyPitfalls: Array.from({ length: 10 }, () => 'p'.repeat(800)),
      capabilityGap: 'g'.repeat(2000),
      cheaperAlternative: 'c'.repeat(1000),
      expectedValueTokens: 500,
    },
    trace: giantTrace,
    call: { isError: false, durationMs: 44, contentChars: 4300 },
  }
  const prompt = buildJudgeInput({ episode, config: config() })
  assert.ok(promptChars(prompt) <= CAPS.judgeInputChars, `judge prompt ${promptChars(prompt)} > ${CAPS.judgeInputChars}`)
  assert.equal(prompt.truncated, true)
  const text = promptText(prompt)
  assert.match(text, /<prediction>/)
  assert.match(text, /<observed>/)
  assert.match(text, /<instruction>/)
})

test('buildJudgeInput: explains the semantic of a missing prediction', () => {
  const prompt = buildJudgeInput({
    episode: { skill: 's', skillMeta: { name: 's', description: 'd', bodyChars: 10 }, prediction: null, trace: { turnEnd: 'completed' } },
    config: config(),
  })
  assert.match(promptText(prompt), /prediction is absent/i)
  assert.equal(prompt.truncated, false)
})

test('renderTraceText: respects the maxTraceChars bound and includes tool sequence', () => {
  const text = renderTraceText(giantTrace, 500)
  assert.ok(text.length <= 500, `trace text ${text.length}`)
  const full = renderTraceText(giantTrace, 12000)
  assert.ok(full.length <= 12000)
  assert.match(full, /tool_sequence:/)
  assert.match(full, /turn_end: completed/)
  assert.match(full, /skill_reloaded: true/)
})

test('buildDreamInput: bounded under CAPS.dreamInputChars and truncates oversized skill files', () => {
  const cases = Array.from({ length: 20 }, (_, index) => ({
    id: `ep_${index}`,
    skill: 'office-xlsx',
    prediction: { fit: 0.3, confidence: 0.6, intent: 'i'.repeat(500), expectedUse: ['x'.repeat(300)], likelyPitfalls: ['p'.repeat(300)], expectedValueTokens: 100 },
    trace: { turnEnd: 'completed', assistantTexts: ['a'.repeat(400)], toolSequence: Array.from({ length: 10 }, () => ({ name: 'tool', ok: false, brief: 'b'.repeat(200) })) },
    judge: { status: 'ok', score: 30, verdict: 'misapplied', capabilityGap: { present: true, claim: 'c'.repeat(300), reality: 'r'.repeat(300) }, rootCause: 'description', reusableRule: 'rule', rework: true },
  }))
  const prompt = buildDreamInput({
    skillState: { name: 'office-xlsx', description: 'd'.repeat(3000), whenToUse: 'w'.repeat(1000), source: 'user-dsh', learned: { whenNotToUse: ['n'] } },
    cases,
    skillFile: `---\nname: x\n---\n${'body '.repeat(40000)}`,
  })
  assert.ok(promptChars(prompt) <= CAPS.dreamInputChars, `dream prompt ${promptChars(prompt)} > ${CAPS.dreamInputChars}`)
  assert.equal(prompt.truncated, true)
  const text = promptText(prompt)
  assert.match(text, /<current_skill_md>/)
  assert.match(text, /<cases>/)
  assert.match(text, /<learned>/)
})

test('renderRequestText flattens system + messages for the optional subagent backend', () => {
  const prompt = buildProbeInput({ skillMeta: { name: 's', description: 'd', content: 'body' }, task: {}, learned: {} })
  const text = renderRequestText(prompt)
  assert.ok(text.startsWith(prompt.system))
  assert.match(text, /<skill>/)
})

test('descriptors cover the documented output vocabularies', () => {
  assert.equal(PROBE_SCHEMA.type, 'object')
  assert.deepEqual(JUDGE_SCHEMA.properties.verdict.enum, VERDICTS)
  assert.deepEqual(JUDGE_SCHEMA.properties.rootCause.enum, ROOT_CAUSES)
  assert.equal(DREAM_SCHEMA.type, 'object')
  assert.equal(typeof JUDGE_RETRY_REMINDER, 'string')
  assert.ok(promptTokenEstimate(buildProbeInput({ skillMeta: { name: 's', description: 'd' } })) > 0)
})

test('verdictFromScore maps the documented score bands', () => {
  assert.equal(verdictFromScore(95), 'matched')
  assert.equal(verdictFromScore(70), 'partial')
  assert.equal(verdictFromScore(40), 'missed')
  assert.equal(verdictFromScore(10), 'misapplied')
})

test('validateProbe: non-object input yields conservative defaults and issues (never throws)', () => {
  for (const input of [null, undefined, 'nope', 42, [], true]) {
    const result = validateProbe(input)
    assert.equal(result.value.fit, 0.5)
    assert.equal(result.value.confidence, 0.1)
    assert.deepEqual(result.value.expectedUse, [])
    assert.ok(result.issues.length > 0)
  }
})

test('validateProbe: coerces, clamps, caps arrays and drops unknown keys', () => {
  const result = validateProbe({
    fit: '0.9',
    confidence: 5,
    intent: '  do   the   thing ',
    expectedUse: Array.from({ length: 9 }, (_, index) => `use ${index}`),
    successSignals: 'not-an-array',
    likelyPitfalls: ['a', 42, 'b'],
    capabilityGap: 7,
    cheaperAlternative: '',
    expectedValueTokens: -5,
    unknownKey: 'drop me',
    another: [1, 2],
  })
  assert.equal(result.value.fit, 0.9)
  assert.equal(result.value.confidence, 1)
  assert.equal(result.value.intent, 'do the thing')
  assert.equal(result.value.expectedUse.length, 6)
  assert.deepEqual(result.value.successSignals, [])
  assert.deepEqual(result.value.likelyPitfalls, ['a', 'b'])
  assert.equal(result.value.capabilityGap, '7')
  assert.equal(result.value.cheaperAlternative, null)
  assert.equal(result.value.expectedValueTokens, 0)
  assert.equal('unknownKey' in result.value, false)
  assert.ok(result.issues.some((issue) => issue.includes('unknown keys')))
  assert.ok(result.issues.some((issue) => issue.includes('fit')))
})

test('validateProbe: clamps out-of-range numbers instead of rejecting', () => {
  const result = validateProbe({ fit: 12, confidence: -3, intent: 'x', expectedUse: ['y'], expectedValueTokens: 9e9 })
  assert.equal(result.value.fit, 1)
  assert.equal(result.value.confidence, 0)
  assert.equal(result.value.expectedValueTokens, 200000)
})

test('validateJudge: derives the verdict from the score when missing/invalid', () => {
  const high = validateJudge({ score: 92, capabilityGap: { present: false } })
  assert.equal(high.value.verdict, 'matched')
  assert.ok(high.issues.some((issue) => issue.includes('verdict')))
  const weird = validateJudge({ score: 20, verdict: 'banana' })
  assert.equal(weird.value.verdict, 'misapplied')
  assert.ok(VERDICTS.includes(weird.value.verdict))
})

test('validateJudge: clamps score, normalizes gap/mismatches/recommendation and rework aliases', () => {
  const result = validateJudge({
    score: 150,
    verdict: 'partial',
    predictionAccuracy: 2,
    capabilityGap: { present: 'true', claim: 'c', reality: 'r' },
    mismatches: Array.from({ length: 9 }, () => ({ expected: 'e', observed: 'o', cause: 'c' })),
    rootCause: 'banana',
    reusableRule: 'r'.repeat(900),
    reworkHappened: true,
    recommendation: { descriptionEdit: 'd'.repeat(900), bodyAddition: 'b'.repeat(5000), selectionRule: null },
    unknown: 1,
  })
  assert.equal(result.value.score, 100)
  assert.equal(result.value.verdict, 'partial')
  assert.equal(result.value.predictionAccuracy, 1)
  assert.equal(result.value.capabilityGap.present, true)
  assert.equal(result.value.mismatches.length, 5)
  assert.equal(result.value.rootCause, 'unknown')
  assert.ok(result.value.reusableRule.length <= 300)
  assert.equal(result.value.rework, true)
  assert.ok(result.value.recommendation.descriptionEdit.length <= CAPS.descriptionMaxChars)
  assert.ok(result.value.recommendation.bodyAddition.length <= CAPS.bodySectionMaxChars)
  assert.equal(result.value.recommendation.selectionRule, null)
})

test('validateJudge: non-object input returns a safe partial verdict', () => {
  const result = validateJudge(null)
  assert.equal(result.value.verdict, 'partial')
  assert.equal(result.value.score, 50)
  assert.ok(result.issues.length > 0)
})

test('validateDream: accepts string/object edit forms and caps learned lists', () => {
  const result = validateDream({
    confidence: 0.8,
    diagnosis: 'The description overclaims.',
    descriptionEdit: 'Build and edit Excel workbooks, including formulas and formatting, but not CSV conversion.',
    bodyAddition: '## Boundaries\n- Not for CSV.',
    selectionRule: 'Use only when a real xlsx file is the deliverable.',
    rules: {
      whenNotToUse: Array.from({ length: 10 }, (_, index) => `not ${index}`),
      preconditions: ['a real workbook is needed'],
    },
    notes: Array.from({ length: 12 }, (_, index) => ({ text: `note ${index}`, confidence: 1.5 })),
  })
  assert.equal(result.value.confidence, 0.8)
  assert.ok(result.value.descriptionEdit.length >= CAPS.descriptionMinChars)
  assert.equal(result.value.learned.whenNotToUse.length, CAPS.learnedLinesPerList)
  assert.deepEqual(result.value.learned.preconditions, ['a real workbook is needed'])
  assert.equal(result.value.notes.length, CAPS.notesPerSkill)
  assert.equal(result.value.notes[0].confidence, 1)
})

test('validateDream: drops too-short descriptions and non-JSON-safe values', () => {
  const short = validateDream({ confidence: 2, diagnosis: 'x', descriptionEdit: 'too short', bodyAddition: { section: 'body' } })
  assert.equal(short.value.descriptionEdit, null)
  assert.equal(short.value.confidence, 1)
  assert.equal(short.value.bodyAddition, 'body')
  assert.ok(short.issues.some((issue) => issue.includes('descriptionEdit')))
})

test('validators never throw for adversarial values', () => {
  const values = [
    null,
    undefined,
    0,
    -1,
    NaN,
    Infinity,
    '',
    '{}',
    [],
    [{}],
    { fit: Symbol('x') },
    { score: { nested: true } },
    { descriptionEdit: 12345 },
    { learned: 'nope' },
    { capabilityGap: [] },
    { recommendation: 'nope' },
    Object.create(null),
  ]
  for (const value of values) {
    assert.doesNotThrow(() => validateProbe(value))
    assert.doesNotThrow(() => validateJudge(value))
    assert.doesNotThrow(() => validateDream(value))
  }
})

test('compactCase keeps only bounded evidence fields', () => {
  const compact = compactCase({
    id: 'ep_1',
    skill: 's',
    prediction: { fit: 0.2, confidence: 0.3, intent: 'i', expectedUse: ['a', 'b'], likelyPitfalls: ['p'], capabilityGap: 'g', cheaperAlternative: null, expectedValueTokens: 10 },
    trace: { turnEnd: 'completed', observedMs: 5, assistantTexts: ['a'.repeat(1000)], userMessages: ['u'], toolSequence: Array.from({ length: 30 }, () => ({ name: 't', ok: true, brief: 'x' })), skillReLoaded: false },
    judge: { status: 'ok', score: 12, verdict: 'misapplied', capabilityGap: { present: true }, rootCause: 'description', reusableRule: 'r'.repeat(1000), rework: true },
  })
  assert.equal(compact.id, undefined)
  assert.equal(compact.trace.assistantTexts[0].length <= 300, true)
  assert.ok(compact.trace.toolSequence.length <= 10)
  assert.equal(compact.judge.rework, true)
  assert.ok(compact.judge.reusableRule.length <= 300)
})
