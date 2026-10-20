import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DreamStore, stateDigest } from '../lib/store.js'

function tempStore(prefix = 'dreaming-store-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const store = new DreamStore({ dir, logger: quietLogger() })
  const opened = store.open()
  return { dir, store, opened }
}

function quietLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} }
}

function episode(id, overrides = {}) {
  const now = Date.now()
  return {
    id,
    skill: overrides.skill ?? 'office-xlsx',
    sessionId: 's1',
    startedAt: overrides.startedAt ?? now,
    endedAt: overrides.endedAt ?? now + 100,
    state: overrides.state ?? 'judged',
    skillMeta: { description: 'xlsx', bodyChars: 3000, source: 'user-dsh', path: 'C:\\skills\\x\\SKILL.md' },
    prediction: { fit: 0.7 },
    probe: { status: 'ok', tokensIn: 100, tokensOut: 50 },
    judge: { status: 'ok', score: 80, verdict: 'matched', capabilityGap: { present: false }, tokensIn: 200, tokensOut: 60 },
    cost: { probe: 150, judge: 260, skillLoad: 900, wastedEstimate: 0 },
  }
}

test('open creates the data directory and reports ready', () => {
  const { dir, store, opened } = tempStore()
  try {
    assert.equal(opened.ready, true)
    assert.equal(store.health().episodes, 0)
    const health = store.health()
    assert.match(health.dir, /dreaming-store-/)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('episodes persist, reload and keep the newest snapshot', () => {
  const { dir, store } = tempStore()
  try {
    store.appendEpisode(episode('ep_1'))
    const updatedEndedAt = Date.now() + 250
    store.updateEpisode('ep_1', {
      state: 'judged',
      judge: { status: 'ok', score: 66, verdict: 'partial', capabilityGap: { present: true } },
      endedAt: updatedEndedAt,
    })
    store.appendEpisode(episode('ep_2'))
    assert.equal(store.health().episodes, 2)

    const reopened = new DreamStore({ dir, logger: quietLogger() })
    assert.equal(reopened.open().ready, true)
    assert.equal(reopened.getEpisode('ep_1').judge.score, 66)
    assert.equal(reopened.getEpisode('ep_1').endedAt, updatedEndedAt)
    assert.equal(reopened.getEpisode('ep_2').judge.score, 80)
    const mismatched = reopened.recentEpisodes({ mismatchedOnly: true })
    assert.equal(mismatched.length, 1)
    assert.equal(mismatched[0].id, 'ep_1')
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a recording episode left by a crash is marked abandoned on open', () => {
  const { dir, store } = tempStore()
  try {
    store.appendEpisode(episode('ep_open', { state: 'recording', endedAt: undefined }))
    store.close()
    const reopened = new DreamStore({ dir, logger: quietLogger() })
    reopened.open()
    assert.equal(reopened.getEpisode('ep_open').state, 'abandoned')
    assert.equal(reopened.getEpisode('ep_open').flags.abandoned, true)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill beliefs persist and update metrics', () => {
  const { dir, store } = tempStore()
  try {
    const skill = store.ensureSkill({ name: 'office-xlsx', meta: { description: 'd' }, editable: true })
    assert.equal(skill.counts.loads, 0)
    store.updateSkill('office-xlsx', (current) => {
      current.counts.loads = 2
      current.counts.judged = 2
      current.counts.misapplied = 1
      current.fitHistory.push({ t: 1, fit: 0.8, success: 0.2 })
    })
    assert.ok(store.getSkill('office-xlsx').metrics.consciousness > 0)
    assert.equal(store.getSkill('office-xlsx').editable, true)

    const reopened = new DreamStore({ dir, logger: quietLogger() })
    reopened.open()
    assert.equal(reopened.getSkill('office-xlsx').counts.loads, 2)
    assert.ok(reopened.getSkill('office-xlsx').metrics.fitAccuracy > 0)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dreams and edits are capped and ordered newest-first', () => {
  const { dir, store } = tempStore()
  try {
    for (let index = 0; index < 60; index += 1) store.appendDream({ id: `d${index}`, startedAt: index })
    assert.equal(store.recentDreams(100).length, 50)
    assert.equal(store.recentDreams(1)[0].id, 'd59')

    for (let index = 0; index < 510; index += 1) store.addEdit({ id: `e${index}`, dreamId: 'd1', skill: 's' })
    assert.equal(store.recentEdits(1000).length, 500)
    store.markEdit('e509', 'reverted')
    assert.equal(store.getEdit('e509').status, 'reverted')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt state file is quarantined and replaced, never crashing open', () => {
  const { dir, store } = tempStore()
  store.close()
  try {
    writeFileSync(join(dir, 'state.json'), '{ not json', 'utf8')
    const reopened = new DreamStore({ dir, logger: quietLogger() })
    const opened = reopened.open()
    assert.equal(opened.ready, true)
    assert.equal(Object.keys(reopened.allSkills()).length, 0)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('journal compaction keeps only the newest snapshot per episode', () => {
  const { dir, store } = tempStore()
  try {
    for (let index = 0; index < 5; index += 1) store.appendEpisode(episode(`ep_${index}`))
    for (let index = 0; index < 5; index += 1) store.updateEpisode(`ep_${index}`, { endedAt: Date.now() + 100 + index })
    store._compactEpisodes(true)
    const lines = readFileSync(join(dir, 'episodes.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 5)
    const reopened = new DreamStore({ dir, logger: quietLogger() })
    reopened.open()
    assert.equal(reopened.health().episodes, 5)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prune drops old episodes and least-recently-used skills', () => {
  const { dir, store } = tempStore()
  try {
    store.limits.retainDays = 1
    store.limits.maxSkills = 1
    const old = Date.now() - 5 * 24 * 60 * 60 * 1000
    store.appendEpisode(episode('ep_old', { startedAt: old, endedAt: old + 1 }))
    store.appendEpisode(episode('ep_new', { startedAt: Date.now(), endedAt: Date.now() }))
    store.ensureSkill({ name: 'old-skill' })
    store.ensureSkill({ name: 'new-skill' })
    store.getSkill('old-skill').lastUsedAt = old
    store.getSkill('new-skill').lastUsedAt = Date.now()
    const result = store.prune()
    assert.equal(result.episodes, 1)
    const names = Object.keys(store.state.skills)
    assert.deepEqual(names, ['new-skill'])
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('totals accumulate and the state digest changes on relevant updates', () => {
  const { dir, store } = tempStore()
  try {
    const before = stateDigest(store.state)
    store.bumpTotals({ probeTokens: 10, judgeTokens: 5 })
    assert.equal(store.state.totals.probeTokens, 10)
    store.ensureSkill({ name: 'x', meta: { description: 'd' } })
    store.updateSkill('x', (skill) => {
      skill.counts.judged = 3
      skill.counts.loads = 3
      skill.metrics.consciousness = 50
    })
    assert.notEqual(stateDigest(store.state), before)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('open prunes stale episodes even when no dream ever runs', () => {
  const { dir, store } = tempStore()
  store.close()
  try {
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000
    const rows = [
      episode('ep_old_1', { startedAt: old, endedAt: old + 1 }),
      episode('ep_old_2', { startedAt: old + 2, endedAt: old + 3 }),
      episode('ep_new', { startedAt: Date.now(), endedAt: Date.now() }),
    ]
    writeFileSync(join(dir, 'episodes.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8')
    const reopened = new DreamStore({ dir, logger: quietLogger(), limits: { retainDays: 1 } })
    const opened = reopened.open()
    assert.equal(opened.ready, true)
    assert.equal(reopened.health().episodes, 1)
    assert.equal(reopened.getEpisode('ep_new') !== undefined, true)
    reopened.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('append-time eviction keeps the episode map bounded without a dream', () => {
  const { dir, store } = tempStore()
  try {
    store.limits.maxEpisodes = 10
    const start = Date.now()
    // Hysteresis is max(50, 25% of max), so 70 new episodes cross the band once.
    for (let index = 0; index < 70; index += 1) {
      store.appendEpisode(episode(`ep_${index}`, { startedAt: start + index, endedAt: start + index }))
    }
    assert.ok(store.episodes.size <= 60, `expected bounded map, got ${store.episodes.size}`)
    assert.ok(store.episodes.size >= 10)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('setDreamSchedule records failure streaks', () => {
  const { dir, store } = tempStore()
  try {
    store.setDreamSchedule({ lastRunAt: 10, lastRunId: 'd1', nextRunAt: 20 })
    assert.equal(store.state.dream.nextRunAt, 20)
    assert.equal(store.state.dream.consecutiveFailures, 0)
    store.setDreamSchedule({ failed: true })
    store.setDreamSchedule({ failed: true })
    assert.equal(store.state.dream.consecutiveFailures, 2)
    store.setDreamSchedule({ nextRunAt: 30 })
    assert.equal(store.state.dream.consecutiveFailures, 2, 're-arming does not reset the streak')
    store.setDreamSchedule({ failed: false })
    assert.equal(store.state.dream.consecutiveFailures, 0)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
