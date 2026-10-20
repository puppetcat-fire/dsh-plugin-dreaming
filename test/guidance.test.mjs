import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { CAPS } from '../lib/constants.js'
import {
  emptyLearned,
  mergeLearnings,
  renderPromptSection,
  renderSkillAnnotation,
  sanitizeText,
} from '../lib/guidance.js'

function skill(name, overrides = {}) {
  return {
    name,
    description: `${name} description`,
    lastUsedAt: 1000,
    counts: { loads: 5, judged: 4, matched: 2, partial: 1, missed: 1, misapplied: 0 },
    metrics: { consciousness: 60, fitAccuracy: 0.7, wasteRate: 0.2, confidence: 'medium' },
    learned: emptyLearned(),
    ...overrides,
  }
}

test('mergeLearnings dedupes normalized text and keeps the newest entry', () => {
  const state = skill('a')
  mergeLearnings(state, { whenNotToUse: ['Do not use for PDFs'] })
  mergeLearnings(state, { whenNotToUse: ['do not   use for pdfs.', 'Never for scans'] })
  assert.deepEqual(state.learned.whenNotToUse, ['do not use for pdfs.', 'Never for scans'])
  assert.equal(state.learned.whenNotToUse.length, 2)
})

test('mergeLearnings maps judge-style rules and caps each list', () => {
  const state = skill('a')
  const rules = []
  for (let index = 0; index < 20; index += 1) {
    rules.push({ kind: 'precondition', text: `precondition ${index}`, confidence: 0.8 })
  }
  mergeLearnings(state, { rules }, { maxLines: 3 })
  assert.equal(state.learned.preconditions.length, 3)
  // The dreamer's listing order is its priority order; keep it.
  assert.deepEqual(state.learned.preconditions[0], 'precondition 0')
})

test('mergeLearnings caps notes, stores evidence, and prefers the higher confidence duplicate', () => {
  const state = skill('a')
  mergeLearnings(
    state,
    {
      notes: [
        { text: 'description overclaims export support', confidence: 0.5, evidence: ['ep_1'], dreamId: 'dream_1' },
      ],
    },
    { now: () => 42 },
  )
  assert.equal(state.learned.notes.length, 1)
  assert.equal(state.learned.notes[0].confidence, 0.5)
  assert.deepEqual(state.learned.notes[0].evidence, ['ep_1'])
  assert.equal(state.learned.notes[0].createdAt, 42)

  mergeLearnings(
    state,
    { notes: [{ text: 'Description overclaims export support', confidence: 0.9, evidence: ['ep_2'] }] },
    { now: () => 43 },
  )
  assert.equal(state.learned.notes.length, 1)
  assert.equal(state.learned.notes[0].confidence, 0.9)
  assert.deepEqual(state.learned.notes[0].evidence, ['ep_2'])

  mergeLearnings(state, { notes: [{ text: 'Description overclaims export support', confidence: 0.2 }] })
  assert.equal(state.learned.notes[0].confidence, 0.9, 'weaker duplicate must not overwrite')

  const many = Array.from({ length: 12 }, (_, index) => ({ text: `note ${index}`, confidence: 0.7 }))
  mergeLearnings(state, { notes: many }, { maxNotes: CAPS.notesPerSkill })
  assert.equal(state.learned.notes.length, CAPS.notesPerSkill)
})

test('mergeLearnings is defensive about bad input', () => {
  assert.equal(mergeLearnings(null, { whenNotToUse: ['x'] }), null)
  const state = skill('a')
  state.learned = null
  mergeLearnings(state, undefined)
  assert.deepEqual(state.learned.whenNotToUse, [])
  mergeLearnings(state, { rules: 'not-an-array', unknownKind: ['x'] })
  assert.deepEqual(state.learned.whenToUse, [])
})

test('sanitizeText removes control characters and collapses whitespace', () => {
  const dirty = 'line1\u0000\u0007\u001b[31m\r\nline2\u009b\t tab'
  assert.equal(sanitizeText(dirty), 'line1 [31m line2 tab')
  const multiline = sanitizeText('a\n\n\n\nb', { multiline: true })
  assert.equal(multiline, 'a\n\nb')
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(sanitizeText(dirty)))
})

test('renderPromptSection omits itself when there is nothing useful', () => {
  assert.equal(renderPromptSection(null, [], {}), '')
  assert.equal(renderPromptSection(null, [], { prompt: { awarenessSection: false } }), '')
  assert.equal(renderPromptSection(null, [skill('a')], { enabled: false }), '')
  // judged < minJudgedForSection
  const fresh = skill('fresh', { counts: { loads: 1, judged: 1 } })
  assert.equal(renderPromptSection(null, [fresh], {}), '')
  // healthy skill above the alert thresholds
  const healthy = skill('healthy', { metrics: { consciousness: 95, fitAccuracy: 0.95, wasteRate: 0.01 } })
  assert.equal(renderPromptSection(null, [healthy], {}), '')
})

test('renderPromptSection renders a capped, sorted, control-free block', () => {
  const skills = []
  for (let index = 0; index < 12; index += 1) {
    skills.push(
      skill(`skill-${index}\u001b[2J`, {
        lastUsedAt: index,
        counts: { loads: index + 1, judged: 4 },
        metrics: { consciousness: 40 + index, fitAccuracy: 0.5, wasteRate: 0.2 },
      }),
    )
  }
  skills[0].learned.whenNotToUse.push('never for binary files')
  const text = renderPromptSection(
    { consciousness: 55, judged: 30, wasteRate: 0.15 },
    skills,
    { prompt: { maxSkills: 40, minJudgedForSection: 2 } },
  )
  assert.ok(text.length > 0)
  assert.ok(text.length <= CAPS.promptSectionChars, `section too long: ${text.length}`)
  assert.ok(text.includes('skill-awareness'))
  assert.ok(text.includes('not instructions'))
  assert.ok(text.includes('overall: consciousness 55/100'))
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(text))
  const skillLines = text.split('\n').filter((line) => line.startsWith('- '))
  assert.ok(skillLines.length <= 8, 'hard §7 cap of 8 skill lines')
  assert.ok(skillLines.every((line) => line.length <= 160), 'each line <= 160 chars')
  assert.ok(skillLines[0].includes('skill-11'), 'sorted by usage, highest first')
  // deterministic across calls and map input
  assert.equal(text, renderPromptSection(
    { consciousness: 55, judged: 30, wasteRate: 0.15 },
    Object.fromEntries(skills.map((entry) => [entry.name, entry])),
    { prompt: { maxSkills: 40, minJudgedForSection: 2 } },
  ))
})

test('renderPromptSection collapses to an overall-only block when skills exceed the cap', () => {
  const skills = []
  for (let index = 0; index < 8; index += 1) {
    skills.push(skill(`s${index}`, { metrics: { consciousness: 30, fitAccuracy: 0.2, wasteRate: 0.5 } }))
  }
  // Force the section budget to be exceeded by making every line long.
  for (const entry of skills) entry.learned.whenNotToUse.push('x'.repeat(200))
  const text = renderPromptSection({ consciousness: 40, judged: 8, wasteRate: 0.5 }, skills, {})
  assert.ok(text.length <= CAPS.promptSectionChars)
})

test('renderSkillAnnotation is empty for a skill with no history and no probe', () => {
  assert.equal(renderSkillAnnotation({}), '')
  assert.equal(renderSkillAnnotation({ skillState: skill('a', { counts: { judged: 0, loads: 0 }, metrics: {} }) }), '')
  assert.equal(renderSkillAnnotation({ skillState: skill('a'), config: { prompt: { annotateSkillResult: false } } }), '')
  assert.equal(renderSkillAnnotation({ skillState: skill('a'), config: { enabled: false } }), '')
})

test('renderSkillAnnotation includes history, expectation and learned notes', () => {
  const state = skill('office-xlsx')
  state.learned.whenNotToUse.push('Never for PDF conversion')
  state.learned.preconditions.push('Workbook must exist')
  const prediction = {
    fit: 0.72,
    confidence: 0.6,
    expectedUse: ['read cells', 'write formulas'],
    likelyPitfalls: ['merged cells are skipped'],
    capabilityGap: 'cannot render to PDF',
    cheaperAlternative: 'use office-pdf',
  }
  const text = renderSkillAnnotation({ skillState: state, prediction })
  assert.ok(text.includes('consciousness 60/100'))
  assert.ok(text.includes('expected fit for this task: 0.72'))
  assert.ok(text.includes('expected use: read cells; write formulas'))
  assert.ok(text.includes('likely pitfalls: merged cells are skipped'))
  assert.ok(text.includes('cheaper alternative: use office-pdf'))
  assert.ok(text.includes('not for: Never for PDF conversion'))
  assert.ok(text.includes('preconditions: Workbook must exist'))
  assert.ok(text.length <= CAPS.skillAnnotationChars)
})

test('renderSkillAnnotation honors config caps and strips control characters', () => {
  const state = skill('a')
  for (let index = 0; index < 8; index += 1) state.learned.knownFailures.push(`failure ${index}`)
  const prediction = {
    fit: 0.4,
    expectedUse: ['one', 'two', 'three'],
    likelyPitfalls: ['p1', 'p2'],
    capabilityGap: 'gap\u0007here',
    cheaperAlternative: 'cheap\u001bpath',
  }
  const text = renderSkillAnnotation({
    skillState: state,
    prediction,
    config: { prompt: { annotationMaxChars: 260 } },
  })
  assert.ok(text.length <= 260, `annotation too long: ${text.length}`)
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(text))
  assert.ok(text.startsWith('[dreaming]'))
})
