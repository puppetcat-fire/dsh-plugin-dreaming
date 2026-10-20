import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { normalizeConfig } from '../lib/config.js'
import { zonedParts } from '../lib/util.js'
import {
  computeCatchUp,
  computeNextRun,
  computePreviousRun,
  DreamScheduler,
  parseWallTime,
} from '../lib/scheduler.js'

const UTC = 'UTC'
const NY = 'America/New_York'
const BERLIN = 'Europe/Berlin'

function makeConfig(dream = {}) {
  return normalizeConfig({
    dream: {
      time: '03:30',
      timeZone: UTC,
      jitterMinutes: 0,
      catchUpHours: 18,
      ...dream,
    },
  }).config
}

function makeClock(start) {
  let now = start
  let nextId = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimer(fn, delay) {
      nextId += 1
      timers.set(nextId, { fn, at: now + delay })
      return nextId
    },
    clearTimer(handle) {
      timers.delete(handle)
    },
    pendingCount: () => timers.size,
    pendingDelay() {
      const timer = timers.values().next().value
      return timer === undefined ? null : timer.at - now
    },
    advance(ms) {
      now += ms
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(handle)
          timer.fn()
        }
      }
    },
  }
}

function makeStore({ lastRunAt = 0, runs = [] } = {}) {
  const store = {
    runs,
    state: { dream: { lastRunAt, lastRunId: null, nextRunAt: 0, consecutiveFailures: 0 } },
    calls: { schedule: [], dreams: [] },
    setDreamSchedule(patch) {
      store.calls.schedule.push(patch)
      const { failed, ...rest } = patch ?? {}
      Object.assign(store.state.dream, rest)
      // Mirror the real DreamStore: only an explicit boolean changes the failure streak.
      if (failed === true) {
        store.state.dream.consecutiveFailures = (store.state.dream.consecutiveFailures ?? 0) + 1
      } else if (failed === false) {
        store.state.dream.consecutiveFailures = 0
      }
    },
    appendDream(run) {
      store.calls.dreams.push(run)
      store.runs.push(run)
      return run
    },
    recentDreams(limit = 20) {
      return [...store.runs].reverse().slice(0, limit)
    },
  }
  return store
}

async function flush() {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------------------------------------
// wall-clock math
// ---------------------------------------------------------------------------------------------

test('parseWallTime validates HH:MM and throws for anything else', () => {
  assert.deepEqual(parseWallTime('03:30'), { hour: 3, minute: 30 })
  assert.deepEqual(parseWallTime('23:59'), { hour: 23, minute: 59 })
  for (const bad of ['3:30', '24:00', '03:60', '0330', '', null, 330]) {
    assert.throws(() => parseWallTime(bad), RangeError)
  }
})

test('computeNextRun returns the next occurrence strictly after from (UTC)', () => {
  const from = Date.UTC(2026, 0, 1, 1, 0)
  assert.equal(
    computeNextRun({ time: '03:30', timeZone: UTC, from }),
    Date.UTC(2026, 0, 1, 3, 30),
  )
  assert.equal(
    computeNextRun({ time: '03:30', timeZone: UTC, from: Date.UTC(2026, 0, 1, 4, 0) }),
    Date.UTC(2026, 0, 2, 3, 30),
  )
  // Exactly at the occurrence -> the next day, never "now".
  assert.equal(
    computeNextRun({ time: '03:30', timeZone: UTC, from: Date.UTC(2026, 0, 1, 3, 30) }),
    Date.UTC(2026, 0, 2, 3, 30),
  )
  assert.throws(() => computeNextRun({ time: 'xx:yy', timeZone: UTC, from }), RangeError)
  assert.throws(() => computeNextRun({ time: '03:30', timeZone: 'Not/AZone', from }), RangeError)
})

test('computeNextRun uses the process zone when timeZone is empty', () => {
  const from = Date.now()
  const next = computeNextRun({ time: '03:30', from })
  assert.ok(next > from)
  assert.ok(next - from <= 24 * 3_600_000 + 3_600_000)
  const parts = zonedParts(next, undefined)
  assert.equal(parts.hour, 3)
  assert.equal(parts.minute, 30)
})

test('computeNextRun is DST-safe across the US spring-forward gap', () => {
  // 2026-03-08: 02:00 EST -> 03:00 EDT. 02:30 does not exist and must run at 03:00 EDT.
  const gap = computeNextRun({
    time: '02:30',
    timeZone: NY,
    from: Date.UTC(2026, 2, 8, 5, 0), // 00:00 EST
  })
  assert.equal(gap, Date.UTC(2026, 2, 8, 7, 0), '03:00 EDT = 07:00Z')
  // A normal time on the same day still lands on the wall clock.
  const normal = computeNextRun({
    time: '03:30',
    timeZone: NY,
    from: Date.UTC(2026, 2, 8, 6, 0), // 01:00 EST
  })
  assert.equal(normal, Date.UTC(2026, 2, 8, 7, 30))
  // The day after the transition is a plain 03:30 EDT.
  assert.equal(
    computeNextRun({ time: '03:30', timeZone: NY, from: Date.UTC(2026, 2, 9, 0, 0) }),
    Date.UTC(2026, 2, 9, 7, 30),
  )
})

test('computeNextRun is DST-safe across the European spring-forward gap', () => {
  // 2026-03-29: 02:00 CET -> 03:00 CEST.
  const next = computeNextRun({
    time: '02:30',
    timeZone: BERLIN,
    from: Date.UTC(2026, 2, 29, 0, 0), // 01:00 CET
  })
  assert.equal(next, Date.UTC(2026, 2, 29, 1, 0), '03:00 CEST = 01:00Z')
})

test('computeNextRun handles both occurrences of an ambiguous fall-back wall time', () => {
  // 2026-11-01: 01:30 occurs at 05:30Z (EDT) and 06:30Z (EST).
  const before = computeNextRun({ time: '01:30', timeZone: NY, from: Date.UTC(2026, 10, 1, 4, 0) })
  assert.equal(before, Date.UTC(2026, 10, 1, 5, 30), 'first occurrence')
  const between = computeNextRun({ time: '01:30', timeZone: NY, from: Date.UTC(2026, 10, 1, 5, 45) })
  assert.equal(between, Date.UTC(2026, 10, 1, 6, 30), 'second occurrence')
  const after = computeNextRun({ time: '01:30', timeZone: NY, from: Date.UTC(2026, 10, 1, 6, 45) })
  assert.equal(after, Date.UTC(2026, 10, 2, 6, 30), 'next day, now EST')
})

test('computePreviousRun finds the most recent occurrence, including the later ambiguous one', () => {
  assert.equal(
    computePreviousRun({ time: '03:30', timeZone: UTC, from: Date.UTC(2026, 0, 1, 5, 0) }),
    Date.UTC(2026, 0, 1, 3, 30),
  )
  assert.equal(
    computePreviousRun({ time: '03:30', timeZone: UTC, from: Date.UTC(2026, 0, 1, 2, 0) }),
    Date.UTC(2025, 11, 31, 3, 30),
  )
  assert.equal(
    computePreviousRun({ time: '01:30', timeZone: NY, from: Date.UTC(2026, 10, 1, 6, 45) }),
    Date.UTC(2026, 10, 1, 6, 30),
    'the EST occurrence is the most recent',
  )
  assert.equal(computePreviousRun({ time: 'bad', timeZone: UTC }), null)
})

test('computeCatchUp only fires inside the configured window and after the last run', () => {
  const from = Date.UTC(2026, 0, 1, 10, 0)
  const catchUp = computeCatchUp({ time: '03:30', timeZone: UTC, from, catchUpHours: 18 })
  assert.deepEqual(catchUp, { dueAt: from, missedAt: Date.UTC(2026, 0, 1, 3, 30) })
  assert.equal(computeCatchUp({ time: '03:30', timeZone: UTC, from, catchUpHours: 0 }), null)
  assert.equal(
    computeCatchUp({ time: '03:30', timeZone: UTC, from: Date.UTC(2026, 0, 1, 22, 0), catchUpHours: 18 }),
    null,
    '18.5h late is outside the window',
  )
})

// ---------------------------------------------------------------------------------------------
// DreamScheduler lifecycle
// ---------------------------------------------------------------------------------------------

test('start arms one one-shot timer at the next occurrence and persists it', () => {
  const start = Date.UTC(2026, 0, 1, 10, 0)
  const clock = makeClock(start)
  const store = makeStore({ lastRunAt: Date.UTC(2026, 0, 1, 3, 30) })
  const runs = []
  const scheduler = new DreamScheduler({
    store,
    config: makeConfig(),
    logger: {},
    run: async (reason) => {
      runs.push(reason)
      return { id: 'dream_1', trigger: reason, status: 'ok' }
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0,
  })
  scheduler.start()
  const expected = Date.UTC(2026, 0, 2, 3, 30)
  assert.equal(scheduler.nextRunAt(), expected)
  assert.equal(scheduler.hasTimer(), true)
  assert.equal(clock.pendingCount(), 1)
  assert.equal(clock.pendingDelay(), expected - start)
  assert.deepEqual(store.calls.schedule.at(-1), { nextRunAt: expected })

  clock.advance(expected - start)
  return flush().then(() => {
    assert.deepEqual(runs, ['schedule'])
    assert.equal(scheduler.isRunning(), false)
    // Re-armed for the following day, still exactly one timer.
    assert.equal(clock.pendingCount(), 1)
    assert.equal(scheduler.nextRunAt(), Date.UTC(2026, 0, 3, 3, 30))
    assert.equal(store.state.dream.nextRunAt, Date.UTC(2026, 0, 3, 3, 30))
  })
})

test('jitter shifts the planned fire time but not the wall clock', () => {
  const start = Date.UTC(2026, 0, 1, 10, 0)
  const clock = makeClock(start)
  const store = makeStore({ lastRunAt: Date.UTC(2026, 0, 1, 3, 30) })
  const scheduler = new DreamScheduler({
    store,
    config: makeConfig({ jitterMinutes: 10 }),
    run: async () => ({ status: 'ok' }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
  })
  scheduler.start()
  assert.equal(scheduler.nextRunAt(), Date.UTC(2026, 0, 2, 3, 30) + 5 * 60_000)
})

test('stop clears the timer and a fired timer after stop does nothing', async () => {
  const start = Date.UTC(2026, 0, 1, 10, 0)
  const clock = makeClock(start)
  const store = makeStore({ lastRunAt: Date.UTC(2026, 0, 1, 3, 30) })
  const runs = []
  const scheduler = new DreamScheduler({
    store,
    config: makeConfig(),
    run: async (reason) => {
      runs.push(reason)
      return { status: 'ok' }
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0,
  })
  scheduler.start()
  assert.equal(clock.pendingCount(), 1)
  scheduler.stop()
  assert.equal(clock.pendingCount(), 0)
  assert.equal(scheduler.hasTimer(), false)
  clock.advance(48 * 3_600_000)
  await flush()
  assert.deepEqual(runs, [])
  assert.deepEqual(await scheduler.runNow(), { status: 'skipped', reason: 'stopped' })
})

test('disabled dreaming arms nothing and persists nextRunAt 0', () => {
  const clock = makeClock(Date.UTC(2026, 0, 1, 10, 0))
  const store = makeStore()
  const scheduler = new DreamScheduler({
    store,
    config: makeConfig({ enabled: false }),
    run: async () => ({ status: 'ok' }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0,
  })
  scheduler.start()
  assert.equal(clock.pendingCount(), 0)
  assert.equal(scheduler.nextRunAt(), 0)
  assert.deepEqual(store.calls.schedule.at(-1), { nextRunAt: 0 })
})

test('catch-up fires once shortly after start when the last occurrence was missed', async () => {
  const clock = makeClock(Date.UTC(2026, 0, 1, 9, 0))
  const store = makeStore({ lastRunAt: 0 })
  const runs = []
  const scheduler = new DreamScheduler({
    store,
    config: makeConfig(),
    run: async (reason) => {
      runs.push(reason)
      return { status: 'ok' }
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
  })
  scheduler.start()
  // Missed today's 03:30, jitter 0-120s -> 60s with random 0.5.
  assert.equal(scheduler.nextRunAt(), Date.UTC(2026, 0, 1, 9, 0) + 60_000)
  assert.equal(scheduler.lastTrigger, 'catch-up')
  clock.advance(60_000)
  await flush()
  assert.deepEqual(runs, ['catch-up'])
  // After the catch-up run the normal nightly schedule is armed again.
  assert.equal(clock.pendingCount(), 1)
  assert.equal(scheduler.nextRunAt(), Date.UTC(2026, 0, 2, 3, 30))
})

test('a run already recorded does not trigger catch-up', () => {
  const clock = makeClock(Date.UTC(2026, 0, 1, 9, 0))
  const store = makeStore({ lastRunAt: Date.UTC(2026, 0, 1, 3, 30) })
  const scheduler = new DreamScheduler({
    store,
    config: makeConfig(),
    run: async () => ({ status: 'ok' }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
  })
  scheduler.start()
  assert.equal(scheduler.lastTrigger, 'schedule')
  assert.equal(scheduler.nextRunAt(), Date.UTC(2026, 0, 2, 3, 30))
})

test('a missed run outside the catch-up window is journaled once and not replayed', () => {
  const clock = makeClock(Date.UTC(2026, 0, 2, 23, 0))
  const store = makeStore({ lastRunAt: 0 })
  const scheduler = new DreamScheduler({
    store,
    config: makeConfig(),
    run: async () => ({ status: 'ok' }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0,
  })
  scheduler.start()
  const skipped = store.calls.dreams.filter((run) => run.status === 'skipped')
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].reason, 'missed-catch-up-window')
  assert.equal(skipped[0].missedAt, Date.UTC(2026, 0, 2, 3, 30))
  assert.equal(scheduler.nextRunAt(), Date.UTC(2026, 0, 3, 3, 30))

  // A second boot must not journal the same missed occurrence twice.
  scheduler.start()
  assert.equal(store.calls.dreams.filter((run) => run.status === 'skipped').length, 1)
})

test('runs never overlap; manual runNow is skipped while a run is active', async () => {
  const start = Date.UTC(2026, 0, 1, 10, 0)
  const clock = makeClock(start)
  const store = makeStore({ lastRunAt: Date.UTC(2026, 0, 1, 3, 30) })
  let resolveRun
  const calls = []
  const scheduler = new DreamScheduler({
    store,
    config: makeConfig(),
    run: (reason) => {
      calls.push(reason)
      return new Promise((resolve) => {
        resolveRun = resolve
      })
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0,
  })
  scheduler.start()
  clock.advance(Date.UTC(2026, 0, 2, 3, 30) - start)
  await flush()
  assert.deepEqual(calls, ['schedule'])
  assert.equal(scheduler.isRunning(), true)
  assert.deepEqual(await scheduler.runNow('manual'), { status: 'skipped', reason: 'already-running' })
  resolveRun({ status: 'ok' })
  await flush()
  assert.equal(scheduler.isRunning(), false)
  assert.equal(clock.pendingCount(), 1, 'next occurrence armed after completion')
  assert.deepEqual(calls, ['schedule'])
})

test('run errors are contained, journaled as failed and the next occurrence is still armed', async () => {
  const start = Date.UTC(2026, 0, 1, 10, 0)
  const clock = makeClock(start)
  const store = makeStore({ lastRunAt: Date.UTC(2026, 0, 1, 3, 30) })
  const scheduler = new DreamScheduler({
    store,
    config: makeConfig(),
    logger: {},
    run: async () => {
      throw new Error('boom')
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0,
  })
  scheduler.start()
  clock.advance(Date.UTC(2026, 0, 2, 3, 30) - start)
  await flush()
  assert.equal(store.calls.dreams.length, 1)
  assert.equal(store.calls.dreams[0].status, 'failed')
  assert.equal(store.calls.dreams[0].error.message, 'boom')
  assert.equal(store.state.dream.consecutiveFailures, 1)
  assert.equal(clock.pendingCount(), 1)
  assert.equal(scheduler.nextRunAt(), Date.UTC(2026, 0, 3, 3, 30))

  const manual = await scheduler.runNow('manual')
  assert.equal(manual.status, 'failed')
  assert.equal(manual.error.message, 'boom')
  assert.equal(store.state.dream.consecutiveFailures, 2, 'manual failure also counts once')
})

test('failure streak survives re-arm and an explicit successful run resets it', async () => {
  const start = Date.UTC(2026, 0, 1, 10, 0)
  const clock = makeClock(start)
  const store = makeStore({ lastRunAt: Date.UTC(2026, 0, 1, 3, 30) })
  let shouldFail = true
  const scheduler = new DreamScheduler({
    store,
    config: makeConfig(),
    logger: {},
    run: async () => {
      if (shouldFail) throw new Error('boom')
      return { status: 'ok' }
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0,
  })
  scheduler.start()
  clock.advance(Date.UTC(2026, 0, 2, 3, 30) - start)
  await flush()
  assert.equal(store.state.dream.consecutiveFailures, 1, 'failure increments on re-arm')
  assert.equal(scheduler.nextRunAt(), Date.UTC(2026, 0, 3, 3, 30))

  shouldFail = false
  clock.advance(24 * 3_600_000)
  await flush()
  assert.equal(store.state.dream.consecutiveFailures, 0, 'successful run resets the streak')
  assert.equal(store.calls.schedule.at(-1).failed, false)
  assert.equal(store.calls.schedule.at(-2).failed, true, 'the failed re-arm carried failed:true')
})

test('runNow returns the run record for a manual dream and works when scheduling is disabled', async () => {
  const clock = makeClock(Date.UTC(2026, 0, 1, 10, 0))
  const store = makeStore()
  const scheduler = new DreamScheduler({
    store,
    config: makeConfig({ enabled: false }),
    run: async (reason) => ({ id: 'dream_manual', trigger: reason, status: 'ok' }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0,
  })
  scheduler.start()
  store.state.dream.consecutiveFailures = 2
  const result = await scheduler.runNow()
  assert.equal(result.id, 'dream_manual')
  assert.equal(result.trigger, 'manual')
  assert.equal(store.state.dream.consecutiveFailures, 0, 'manual success resets the streak')
  assert.deepEqual(store.calls.schedule.at(-1), { failed: false })
  // A manual run does not consume the schedule slot.
  assert.equal(scheduler.nextRunAt(), 0)
})

test('long delays are chained instead of overflowing a single setTimeout', () => {
  const start = Date.UTC(2026, 0, 1, 10, 0)
  const clock = makeClock(start)
  const store = makeStore({ lastRunAt: Date.UTC(2026, 0, 1, 3, 30) })
  const scheduler = new DreamScheduler({
    store,
    config: makeConfig(),
    run: async () => ({ status: 'ok' }),
    now: clock.now,
    setTimer: (fn, delay) => {
      // Simulate a platform that clamps a huge delay by firing early.
      return clock.setTimer(fn, Math.min(delay, 1_000))
    },
    clearTimer: clock.clearTimer,
    random: () => 0,
  })
  scheduler.start()
  // The stub fires after 1s, which is early -> the scheduler chains the remainder.
  clock.advance(1_000)
  assert.equal(clock.pendingCount(), 1)
  assert.ok(scheduler.nextRunAt() > clock.now())
})

// ---------------------------------------------------------------------------------------------
// install-age guard for catch-up
// ---------------------------------------------------------------------------------------------

test('a fresh install does not catch up on an occurrence from before it existed', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0)
  const clock = makeClock(now)
  const store = makeStore({ lastRunAt: 0 })
  store.state.createdAt = now - 60_000
  const scheduler = new DreamScheduler({
    store,
    config: makeConfig({ time: '03:30' }),
    run: async () => ({ status: 'ok' }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0,
  })
  try {
    scheduler.start()
    const delay = clock.pendingDelay()
    assert.ok(delay > 15 * 3_600_000, `expected the next day schedule, got ${delay}`)
    assert.ok(store.state.dream.nextRunAt > now + 15 * 3_600_000)
    assert.equal(store.calls.dreams.length, 0)
  } finally {
    scheduler.dispose()
  }
})

test('an existing install still catches up a missed occurrence inside the window', () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0)
  const clock = makeClock(now)
  const store = makeStore({ lastRunAt: now - 2 * 24 * 3_600_000 })
  store.state.createdAt = now - 5 * 24 * 3_600_000
  const scheduler = new DreamScheduler({
    store,
    config: makeConfig({ time: '03:30', catchUpHours: 18 }),
    run: async () => ({ status: 'ok' }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0,
  })
  try {
    scheduler.start()
    const delay = clock.pendingDelay()
    assert.ok(delay !== null && delay <= 5_000, `expected an immediate catch-up, got ${delay}`)
  } finally {
    scheduler.dispose()
  }
})
