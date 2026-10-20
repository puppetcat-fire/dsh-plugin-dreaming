/**
 * Nightly dream scheduling in the user's local wall-clock time, DST-safe.
 *
 * The scheduler owns exactly one `setTimeout` and never uses `setInterval`: after each run it
 * recomputes the next wall-clock occurrence in the configured IANA zone and arms a single-shot
 * timer. Wall-clock → instant resolution is done by iterating `Intl.DateTimeFormat` offsets, which
 * handles the two DST edge cases explicitly:
 *
 * - **spring forward** — a skipped wall time (e.g. 02:30 in `America/New_York`) runs at the first
 *   existing wall time after the gap (03:00), never a day early and never twice;
 * - **fall back** — an ambiguous wall time (01:30 occurs twice) is treated as two occurrences; the
 *   next run picks the first one still in the future and a missed-run catch-up picks the last one
 *   that already happened.
 *
 * Failure posture: every timer callback and run promise has a `.catch`; a failing dream run is
 * journaled and the next occurrence is still armed. `stop()` clears the timer; `dispose()` also
 * aborts an in-flight run's signal.
 *
 * @module scheduler
 */

import { makeId, safeError, zonedParts } from './util.js'

/** Longest delay a single `setTimeout` can hold without overflow; longer waits are chained. */
const MAX_TIMER_MS = 2_147_000_000

/** Re-arm a little early is avoided: a fire before the target re-arms for the remainder. */
const TIMER_EARLY_TOLERANCE_MS = 500

/** Catch-up is spread over a short window so all clients do not fire at the same instant. */
const CATCH_UP_JITTER_MS = 120_000

/** Search horizon for the next occurrence. One skipped day is the worst realistic case. */
const MAX_DAY_SEARCH = 10

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/** @typedef {{ year:number, month:number, day:number, hour:number, minute:number, second?:number }} WallParts */

/**
 * Parse `HH:MM` into wall-clock parts.
 * @param {string} time
 * @returns {{ hour:number, minute:number }}
 * @throws {RangeError} when the string is not a valid 24h time
 */
export function parseWallTime(time) {
  if (typeof time !== 'string') throw new RangeError('dreaming: dream.time must be a string HH:MM')
  const match = TIME_PATTERN.exec(time.trim())
  if (match === null) throw new RangeError(`dreaming: dream.time "${time}" is not HH:MM`)
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

/** Add whole days to a wall-clock date without any timezone arithmetic. */
function addDays(parts, delta) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + delta))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function sameWall(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day
    && a.hour === b.hour && a.minute === b.minute
}

/**
 * Resolve a wall-clock time to an instant, using offset iteration around the target.
 * Returns `null` when that wall time does not exist on that date (spring-forward gap).
 */
function resolveExistingWall(wall, timeZone) {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0)
  let guess = target
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const parts = zonedParts(guess, timeZone)
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0)
    const next = target - (asUtc - guess)
    if (next === guess) break
    guess = next
  }
  const actual = zonedParts(guess, timeZone)
  return sameWall(actual, wall) ? guess : null
}

/**
 * All instants that display `wall` in `timeZone` (0 when the wall time is skipped, 2 during a
 * fall-back overlap, 1 normally), ordered ascending.
 */
function wallOccurrences(wall, timeZone) {
  const first = resolveExistingWall(wall, timeZone)
  if (first === null) return []
  let earliest = first
  for (let index = 0; index < 3; index += 1) {
    const previous = earliest - 3_600_000
    const parts = zonedParts(previous, timeZone)
    if (sameWall(parts, wall)) earliest = previous
    else break
  }
  const occurrences = [earliest]
  for (let index = 0; index < 3; index += 1) {
    const next = occurrences[occurrences.length - 1] + 3_600_000
    const parts = zonedParts(next, timeZone)
    if (sameWall(parts, wall)) occurrences.push(next)
    else break
  }
  return occurrences
}

/**
 * Resolve the scheduled wall time on one civil date. During a spring-forward gap the first
 * existing wall time after the gap is used (03:00 for a skipped 02:30).
 */
function resolveWallOnDate(date, hour, minute, timeZone) {
  const wall = { ...date, hour, minute }
  const direct = wallOccurrences(wall, timeZone)
  if (direct.length > 0) return direct
  for (let extra = 1; extra <= 180; extra += 1) {
    const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day, hour, minute + extra, 0))
    const shiftedWall = {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
    }
    // Never cross into the next civil day: the day loop handles that.
    if (shiftedWall.day !== date.day || shiftedWall.month !== date.month || shiftedWall.year !== date.year) {
      return []
    }
    const occurrences = wallOccurrences(shiftedWall, timeZone)
    if (occurrences.length > 0) return occurrences
  }
  return []
}

/**
 * Next scheduled dream occurrence strictly after `from`.
 *
 * @param {object} args
 * @param {string} args.time wall clock `HH:MM`
 * @param {string} [args.timeZone] IANA zone; empty/undefined uses the process zone
 * @param {number} [args.from] epoch ms to search from (default: now)
 * @param {number} [args.catchUpHours] accepted for API symmetry; catch-up is `computeCatchUp`
 * @returns {number} epoch ms of the next occurrence
 * @throws {RangeError} invalid time or time zone
 */
export function computeNextRun({ time, timeZone, from = Date.now(), catchUpHours } = {}) {
  void catchUpHours
  const { hour, minute } = parseWallTime(time)
  const fromMs = Number.isFinite(from) ? from : Date.now()
  assertZone(timeZone)
  const today = zonedParts(fromMs, timeZone)
  for (let dayOffset = 0; dayOffset <= MAX_DAY_SEARCH; dayOffset += 1) {
    const date = addDays(today, dayOffset)
    const occurrences = resolveWallOnDate(date, hour, minute, timeZone)
    for (const occurrence of occurrences) {
      if (occurrence > fromMs) return occurrence
    }
  }
  // A scheduling horizon beyond ten days is a bug, but never return a past/invalid instant.
  throw new RangeError('dreaming: could not resolve the next dream occurrence')
}

/**
 * Most recent scheduled occurrence at or before `from`.
 *
 * @param {object} args
 * @param {string} args.time `HH:MM`
 * @param {string} [args.timeZone]
 * @param {number} [args.from]
 * @returns {number|null} epoch ms or null when it cannot be resolved
 */
export function computePreviousRun({ time, timeZone, from = Date.now() } = {}) {
  try {
    const { hour, minute } = parseWallTime(time)
    const fromMs = Number.isFinite(from) ? from : Date.now()
    assertZone(timeZone)
    const today = zonedParts(fromMs, timeZone)
    for (let dayOffset = 0; dayOffset >= -3; dayOffset -= 1) {
      const date = addDays(today, dayOffset)
      const occurrences = resolveWallOnDate(date, hour, minute, timeZone)
      for (let index = occurrences.length - 1; index >= 0; index -= 1) {
        if (occurrences[index] <= fromMs) return occurrences[index]
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Catch-up decision: a scheduled occurrence that has passed within `catchUpHours` and was never
 * run should fire once shortly after boot instead of waiting another day.
 *
 * @param {object} args
 * @param {string} args.time
 * @param {string} [args.timeZone]
 * @param {number} [args.from]
 * @param {number} [args.catchUpHours]
 * @returns {{ dueAt: number, missedAt: number }|null}
 */
export function computeCatchUp({ time, timeZone, from = Date.now(), catchUpHours = 0 } = {}) {
  const windowHours = typeof catchUpHours === 'number' && Number.isFinite(catchUpHours) ? catchUpHours : 0
  if (windowHours <= 0) return null
  const fromMs = Number.isFinite(from) ? from : Date.now()
  const missedAt = computePreviousRun({ time, timeZone, from: fromMs })
  if (missedAt === null) return null
  if (fromMs - missedAt > windowHours * 3_600_000) return null
  return { dueAt: fromMs, missedAt }
}

function assertZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
  } catch {
    throw new RangeError(`dreaming: "${timeZone}" is not a valid IANA time zone`)
  }
}

function noopLogger() {
  const noop = () => {}
  return { info: noop, warn: noop, error: noop, debug: noop }
}

/**
 * One-shot nightly scheduler with catch-up, jitter, persistence and error containment.
 *
 * The injected `run` callback is owned by `index.js` (it wraps `DreamEngine.run`) and has the shape
 * `(reason: 'schedule'|'catch-up'|'manual', { signal }) => Promise<runRecord>`. Every result is
 * journaled by the engine; the scheduler only adds skipped/failed records for cases the engine
 * cannot see (missed catch-up window, callback crash).
 */
export class DreamScheduler {
  /**
   * @param {object} options
   * @param {object} options.store `DreamStore` (uses `state.dream`, `setDreamSchedule`, `appendDream`, `recentDreams`)
   * @param {object} options.config normalized plugin config
   * @param {(reason: string, context: { signal: AbortSignal }) => Promise<object>} options.run
   * @param {object} [options.logger]
   * @param {() => number} [options.now]
   * @param {(fn: Function, delay: number) => any} [options.setTimer]
   * @param {(handle: any) => void} [options.clearTimer]
   * @param {() => number} [options.random]
   */
  constructor({
    store,
    config,
    run,
    logger,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    random = Math.random,
  } = {}) {
    this.store = store
    this.config = config ?? {}
    this.run = run
    this.logger = logger ?? noopLogger()
    this.now = now
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.random = typeof random === 'function' ? random : Math.random
    this._timer = null
    this._nextRunAt = 0
    this._active = null
    this._stopped = false
    this._disposed = false
    this._generation = 0
    this._runController = null
    this._pendingOutcome = null
  }

  /** @returns {'schedule'|'catch-up'|'manual'} the trigger that armed the current timer */
  get lastTrigger() {
    return this._lastTrigger ?? 'schedule'
  }

  /** @returns {number} epoch ms of the planned fire (including jitter), 0 when not armed */
  nextRunAt() {
    return this._nextRunAt
  }

  /** @returns {boolean} true while a dream run is executing */
  isRunning() {
    return this._active !== null
  }

  /** Whether the scheduler currently owns a pending one-shot timer. */
  hasTimer() {
    return this._timer !== null
  }

  /**
   * Arm (or re-arm) the scheduler. Idempotent: an existing timer is cleared first.
   * Disabled dreaming leaves the scheduler inert but keeps manual `runNow` usable.
   */
  start() {
    try {
      this._stopped = false
      this._generation += 1
      this._clearTimer()
      this._nextRunAt = 0
      const dream = this._dreamConfig()
      if (this.config?.enabled === false || dream.enabled === false) {
        this._persistNextRun(0)
        this.logger.info?.('dreaming: nightly scheduling disabled')
        return
      }
      const from = this.now()
      const lastRunAt = typeof this.store?.state?.dream?.lastRunAt === 'number'
        ? this.store.state.dream.lastRunAt
        : 0
      // A brand-new profile must not treat occurrences from before it installed dreaming as
      // "missed": only a scheduled time at or after the state file's creation is eligible.
      const installedAt = typeof this.store?.state?.createdAt === 'number'
        ? this.store.state.createdAt
        : 0
      const previous = computePreviousRun({
        time: dream.time,
        timeZone: dream.timeZone || undefined,
        from,
      })
      if (previous !== null && previous > lastRunAt && previous >= installedAt) {
        const windowHours = dream.catchUpHours ?? 0
        if (windowHours > 0 && from - previous <= windowHours * 3_600_000) {
          const jitter = Math.floor(this.random() * CATCH_UP_JITTER_MS)
          const dueAt = from + jitter
          this._lastTrigger = 'catch-up'
          this._armAt(dueAt)
          this.logger.info?.(`dreaming: catch-up dream armed (missed occurrence ${new Date(previous).toISOString()})`)
          return
        }
        if (windowHours > 0) {
          this._journalMissed(previous)
        }
      }
      this._lastTrigger = 'schedule'
      this._planNext(from)
    } catch (error) {
      this.logger.warn?.(`dreaming: scheduler start failed: ${safeError(error).message}`)
      this._nextRunAt = 0
    }
  }

  /** Stop scheduled runs and clear the timer. An in-flight run is left to finish. */
  stop() {
    this._stopped = true
    this._generation += 1
    this._clearTimer()
    this.logger.debug?.('dreaming: nightly scheduler stopped')
  }

  /** Full disposal: stop the timer and abort an in-flight run. */
  dispose() {
    this._disposed = true
    this.stop()
    try {
      this._runController?.abort(new Error('dreaming: scheduler disposed'))
    } catch {
      // nothing to do
    }
    this._runController = null
  }

  /**
   * Run a dream now (manual trigger / dashboard action). Never overlaps a scheduled run and never
   * throws; a skipped result is a normal return value.
   *
   * @param {string} [reason]
   * @returns {Promise<object>}
   */
  async runNow(reason = 'manual') {
    try {
      if (this._disposed) return { status: 'skipped', reason: 'disposed' }
      if (typeof this.run !== 'function') return { status: 'skipped', reason: 'no-run-handler' }
      if (this._active !== null) return { status: 'skipped', reason: 'already-running' }
      return await this._fire(reason === 'schedule' ? 'manual' : reason)
    } catch (error) {
      this.logger.warn?.(`dreaming: manual dream failed: ${safeError(error).message}`)
      return { status: 'failed', error: safeError(error) }
    }
  }

  // -------------------------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------------------------

  _dreamConfig() {
    return this.config?.dream ?? {}
  }

  _clearTimer() {
    if (this._timer !== null) {
      try {
        this.clearTimer(this._timer)
      } catch {
        // best effort
      }
      this._timer = null
    }
  }

  _planNext(from = this.now()) {
    if (this._stopped || this._disposed) return
    const dream = this._dreamConfig()
    const next = computeNextRun({
      time: dream.time,
      timeZone: dream.timeZone || undefined,
      from,
    })
    const jitterMinutes = typeof dream.jitterMinutes === 'number' ? dream.jitterMinutes : 0
    const jitter = Math.max(0, Math.floor(this.random() * jitterMinutes * 60_000))
    this._armAt(next + jitter)
  }

  _armAt(at) {
    if (this._stopped || this._disposed) return
    this._clearTimer()
    const target = Number.isFinite(at) && at > 0 ? at : this.now()
    this._nextRunAt = target
    this._persistNextRun(target)
    const generation = this._generation
    const delay = Math.max(0, target - this.now())
    const wait = Math.min(delay, MAX_TIMER_MS)
    this._timer = this.setTimer(() => {
      this._timer = null
      if (this._stopped || this._disposed || generation !== this._generation) return
      if (this._nextRunAt - this.now() > TIMER_EARLY_TOLERANCE_MS) {
        // The platform timer fired early or a long delay was clamped: arm the remainder.
        this._armAt(this._nextRunAt)
        return
      }
      this._onTimer()
    }, Math.max(0, wait))
  }

  _onTimer() {
    if (this._stopped || this._disposed) return
    if (this._active !== null) {
      // Should not happen (the timer is re-armed only after a run), but never overlap.
      this.logger.warn?.('dreaming: scheduled dream skipped because a run is active')
      this._planNext()
      return
    }
    void this._fire(this._lastTrigger ?? 'schedule').catch((error) => {
      this.logger.warn?.(`dreaming: scheduled dream crashed: ${safeError(error).message}`)
      if (!this._stopped && !this._disposed) this._planNext()
    })
  }

  _fire(reason) {
    if (this._stopped || this._disposed) return Promise.resolve({ status: 'skipped', reason: 'stopped' })
    if (this._active !== null) return Promise.resolve({ status: 'skipped', reason: 'already-running' })
    const promise = this._invoke(reason)
    this._active = promise
    return promise
  }

  async _invoke(reason) {
    const controller = new AbortController()
    this._runController = controller
    const startedAt = this.now()
    try {
      if (typeof this.run !== 'function') throw new Error('dreaming: scheduler has no run handler')
      const result = await this.run(reason, { signal: controller.signal })
      if (result?.status === 'failed') this._pendingOutcome = 'failed'
      else if (result?.status === 'ok' || result?.status === 'partial') this._pendingOutcome = 'ok'
      return result
    } catch (error) {
      const failure = safeError(error)
      this.logger.warn?.(`dreaming: dream run failed (${reason}): ${failure.message}`)
      if (reason === 'manual') {
        try {
          this.store?.setDreamSchedule?.({ failed: true })
        } catch {
          // store problems must not cascade
        }
      } else {
        // Carried into the re-arm persist so the failure streak is not lost (DreamStore only
        // changes `consecutiveFailures` when `failed` is an explicit boolean).
        this._pendingOutcome = 'failed'
      }
      const record = {
        id: makeId('dream'),
        trigger: reason === 'manual' ? 'manual' : 'schedule',
        startedAt,
        endedAt: this.now(),
        status: 'failed',
        mode: 'inline',
        before: null,
        afterEstimate: null,
        cases: 0,
        skills: [],
        tokens: { in: 0, out: 0 },
        error: failure,
      }
      try {
        this.store?.appendDream?.(record)
      } catch {
        // journaling is best effort
      }
      return record
    } finally {
      this._runController = null
      this._active = null
      if (reason === 'manual') {
        // Manual runs have no re-arm persist, so they own their failure/success accounting here.
        if (this._pendingOutcome === 'failed') {
          this._pendingOutcome = null
          try {
            this.store?.setDreamSchedule?.({ failed: true })
          } catch {
            // best effort
          }
        } else if (this._pendingOutcome === 'ok') {
          this._pendingOutcome = null
          try {
            this.store?.setDreamSchedule?.({ failed: false })
          } catch {
            // best effort
          }
        }
      } else if (!this._stopped && !this._disposed) {
        try {
          this._planNext()
        } catch (error) {
          this.logger.warn?.(`dreaming: failed to plan the next dream: ${safeError(error).message}`)
        }
      }
    }
  }

  _persistNextRun(nextRunAt) {
    try {
      const patch = { nextRunAt }
      if (this._pendingOutcome === 'failed') patch.failed = true
      else if (this._pendingOutcome === 'ok') patch.failed = false
      this._pendingOutcome = null
      this.store?.setDreamSchedule?.(patch)
    } catch (error) {
      this.logger.warn?.(`dreaming: could not persist nextRunAt: ${safeError(error).message}`)
    }
  }

  _journalMissed(missedAt) {
    try {
      const recent = typeof this.store?.recentDreams === 'function' ? this.store.recentDreams(20) : []
      const already = recent.some((run) => run?.status === 'skipped' && run?.missedAt === missedAt)
      if (already) return
      const record = {
        id: makeId('dream'),
        trigger: 'schedule',
        startedAt: missedAt,
        endedAt: missedAt,
        status: 'skipped',
        mode: 'inline',
        before: null,
        afterEstimate: null,
        cases: 0,
        skills: [],
        tokens: { in: 0, out: 0 },
        error: null,
        missedAt,
        reason: 'missed-catch-up-window',
      }
      this.store?.appendDream?.(record)
      this.logger.info?.(`dreaming: skipped a missed dream outside the catch-up window (${new Date(missedAt).toISOString()})`)
    } catch (error) {
      this.logger.warn?.(`dreaming: could not journal a missed dream: ${safeError(error).message}`)
    }
  }
}

/** Re-exported for tests/UI that want the plugin's hard cap. */
export const MAX_SCHEDULE_DELAY_MS = MAX_TIMER_MS
