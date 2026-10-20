import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyEpisodeToSkill,
  applyUnjudgedLoadToSkill,
  computeOverall,
  computeSkillMetrics,
  emptySkillState,
  estimateWasteAvoided,
  renderSkillLine,
  skillLoadTokens,
  VERDICT_SUCCESS,
} from '../lib/stats.js'

function judgedEpisode(overrides = {}) {
  return {
    id: overrides.id ?? 'ep_1',
    skill: 'office-xlsx',
    startedAt: 1000,
    endedAt: 2000,
    state: 'judged',
    prediction: { fit: 0.8, confidence: 0.6 },
    skillMeta: { description: 'Spreadsheet work', bodyChars: 3500, source: 'user-dsh', path: 'C:\\skills\\xlsx\\SKILL.md' },
    probe: { status: 'ok', tokensIn: 100, tokensOut: 50 },
    judge: {
      status: 'ok',
      score: 80,
      verdict: 'matched',
      capabilityGap: { present: false },
      tokensIn: 200,
      tokensOut: 80,
      ...overrides.judge,
    },
    cost: { probe: 150, judge: 280, skillLoad: 1000, wastedEstimate: 0 },
    ...overrides.extra,
  }
}

test('empty skill starts at zero with low confidence', () => {
  const skill = emptySkillState({ name: 'x', now: 5 })
  assert.equal(skill.metrics.consciousness, 0)
  assert.equal(skill.metrics.confidence, 'low')
  assert.equal(skill.counts.loads, 0)
  assert.equal(skill.firstSeenAt, 5)
})

test('a single good episode produces sane metrics', () => {
  const skill = emptySkillState({ name: 'office-xlsx', now: 0 })
  applyEpisodeToSkill(skill, judgedEpisode(), { now: 3000 })
  assert.equal(skill.counts.loads, 1)
  assert.equal(skill.counts.judged, 1)
  assert.equal(skill.counts.matched, 1)
  assert.equal(skill.fitHistory.length, 1)
  assert.equal(skill.metrics.confidence, 'low')
  assert.ok(skill.metrics.consciousness > 60)
  assert.equal(skill.metrics.fitAccuracy, 1)
  assert.equal(skill.metrics.precision, 1)
  assert.equal(skill.metrics.boundaryAccuracy, 1)
  assert.equal(skill.cost.skillLoad, skillLoadTokens(3500))
  assert.equal(skill.lastUsedAt, 2000)
})

test('misapplied loads lower precision and waste rate', () => {
  const skill = emptySkillState({ name: 'x' })
  applyEpisodeToSkill(
    skill,
    judgedEpisode({
      judge: { verdict: 'misapplied', score: 20, capabilityGap: { present: true } },
      extra: { cost: { skillLoad: 1200, wastedEstimate: 1200 } },
    }),
  )
  assert.equal(skill.counts.misapplied, 1)
  assert.equal(skill.counts.boundaryGaps, 1)
  assert.equal(skill.metrics.precision, 0)
  assert.equal(skill.metrics.boundaryAccuracy, 0)
  assert.ok(skill.metrics.wasteRate > 0)
})

test('calibration is 1 - Brier and clamps', () => {
  const skill = emptySkillState({ name: 'x' })
  // fit 1.0, success 0.5 -> squared error 0.25 -> accuracy 0.75
  skill.fitHistory = [
    { t: 1, fit: 1, success: 0.5 },
    { t: 2, fit: 0, success: 0.5 },
  ]
  const metrics = computeSkillMetrics(skill)
  assert.equal(metrics.fitAccuracy, 0.75)
})

test('too few samples keep confidence low; ten judged reach high', () => {
  const skill = emptySkillState({ name: 'x' })
  for (let index = 0; index < 10; index += 1) {
    applyEpisodeToSkill(skill, judgedEpisode({ id: `ep_${index}` }))
  }
  assert.equal(skill.counts.judged, 10)
  assert.equal(skill.metrics.confidence, 'high')
})

test('episode folding is idempotent', () => {
  const skill = emptySkillState({ name: 'x' })
  const episode = judgedEpisode()
  applyEpisodeToSkill(skill, episode)
  const first = JSON.parse(JSON.stringify(skill))
  applyEpisodeToSkill(skill, episode)
  assert.equal(skill.counts.loads, 2)
  assert.equal(skill.fitHistory.length, 1, 'identical evidence is not double-counted')
  assert.equal(first.metrics.consciousness, skill.metrics.consciousness)
})

test('overall is weighted by judged count and reports totals', () => {
  const good = emptySkillState({ name: 'good' })
  for (let index = 0; index < 5; index += 1) {
    applyEpisodeToSkill(good, judgedEpisode({ id: `g${index}` }))
  }
  const bad = emptySkillState({ name: 'bad' })
  applyEpisodeToSkill(bad, judgedEpisode({ id: 'b1', judge: { verdict: 'misapplied', score: 0, capabilityGap: { present: true } } }))
  const state = {
    skills: { good, bad },
    totals: { episodes: 6, judged: 6, probeTokens: 10, judgeTokens: 20, dreamTokens: 0, skillLoadTokens: 0, wastedTokens: 0 },
  }
  const overall = computeOverall(state)
  assert.equal(overall.judged, 6)
  assert.equal(overall.skillsTracked, 2)
  assert.ok(overall.consciousness > 40 && overall.consciousness < 100)
  assert.equal(overall.worstSkill, 'bad')
  assert.ok(overall.probeTokens >= 10)
})

test('waste avoided is an estimate and stays zero without edits', () => {
  const skill = emptySkillState({ name: 'x' })
  applyEpisodeToSkill(skill, judgedEpisode())
  assert.equal(estimateWasteAvoided({ skills: { x: skill } }), 0)
  skill.appliedEdits = [{ editId: 'e1', appliedAt: 500 }]
  skill.fitHistory = [
    { t: 100, fit: 0.8, success: 0.4 },
    { t: 200, fit: 0.8, success: 0.4 },
    { t: 600, fit: 0.9, success: 0.95 },
    { t: 700, fit: 0.9, success: 0.95 },
  ]
  assert.ok(estimateWasteAvoided({ skills: { x: skill } }) > 0)
})

test('skill line renders consciousness and waste', () => {
  const skill = emptySkillState({ name: 'office-xlsx' })
  applyEpisodeToSkill(skill, judgedEpisode())
  const line = renderSkillLine(skill)
  assert.match(line, /office-xlsx/)
  assert.match(line, /意识强度/)
})

test('verdict success mapping is intentional', () => {
  assert.equal(VERDICT_SUCCESS.matched, 1)
  assert.equal(VERDICT_SUCCESS.partial, 0.6)
  assert.equal(VERDICT_SUCCESS.missed, 0.25)
  assert.equal(VERDICT_SUCCESS.misapplied, 0)
})

test('unjudged loads still count toward loads, failure rate and token cost', () => {
  const skill = emptySkillState({ name: 'x' })
  const observed = {
    id: 'ep_o',
    skill: 'x',
    state: 'observed',
    endedAt: 500,
    skillMeta: { bodyChars: 2100, description: 'd', source: 'user-dsh' },
    probe: { status: 'ok', tokensIn: 10, tokensOut: 5 },
  }
  const failed = { ...observed, id: 'ep_f', state: 'failed', endedAt: 600 }
  applyUnjudgedLoadToSkill(skill, observed, { now: 700 })
  applyUnjudgedLoadToSkill(skill, failed, { now: 700 })
  assert.equal(skill.counts.loads, 2)
  assert.equal(skill.counts.judged, 0)
  assert.equal(skill.counts.failed, 1)
  assert.equal(skill.cost.skillLoad, skillLoadTokens(2100) * 2)
  assert.equal(skill.lastUsedAt, 600)
  // Unjudged loads count as loads and cost, but they cannot make "precision" look better.
  assert.equal(skill.metrics.precision, 0)
  assert.equal(skill.metrics.consciousness, 0)
})
