/**
 * EpisodeTracker — the bridge between Host events and the durable capability model.
 *
 * It owns:
 * - one in-memory episode per in-flight `skill` tool call (keyed by `callId`);
 * - one short post-load observation window per session, bounded by `turn/end`,
 *   `observe.maxTurnExtensionMs` and `observe.maxEvents`;
 * - a small concurrency queue for probes and judges (`run.maxConcurrent`);
 * - every timer and AbortController it creates, all of which are disposed.
 *
 * Lifecycle for one skill call:
 *   1. `onPreExecute({exec, session})` — synchronous skeleton registration, journal append,
 *      then an await of only the cheap enrichment (skill lookup + task snapshot). The probe
 *      is started inside but never awaited, so the skill call is not delayed by it.
 *   2. `onToolResult({exec, result, session})` — records the load outcome, cancels the
 *      "result never arrived" timer.
 *   3. `onSessionEvent(session, event)` — collects the bounded trace until `turn/end`
 *      (or a hard stop), then finalizes and judges via `judge.js`.
 *
 * Failure posture (ARCHITECTURE.md §11): no listener throws, every timer/controller has an
 * owner, and all fire-and-forget promises have `.catch(...)`.
 */

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { CAPS, DEFAULT_EDITABLE_SOURCES } from './constants.js'
import { DEFAULTS } from './config.js'
import { asString, estimateTokens, isInside, makeId, oneLine, safeError, truncate, withTimeout } from './util.js'
import { createProbeLimiter, emptyProbeRecord, probeSkill } from './probe.js'
import { computeEpisodeCost, emptyJudgeRecord, judgeEpisode } from './judge.js'
import { applyUnjudgedLoadToSkill } from './stats.js'
import { contentText } from './prompts.js'

/** Bound for the cheap skill-metadata lookup performed during pre-execute. */
const METADATA_TIMEOUT_MS = 1500

/** Only the tail of the session log is scanned to infer the current turn/step. */
const SESSION_TAIL_EVENTS = 40

/** User-role messages that describe runtime/instructions rather than the task. */
const META_USER_SOURCE_KINDS = new Set(['runtime-context', 'agent-instructions'])
const META_USER_PREFIXES = [
  'Current runtime context.',
  '<system-reminder>',
  'Time sampled while preparing',
  'Instructions from:',
  'You are the Team Lead named',
]

/** Tool brief length inside the trace (ARCHITECTURE.md §5.1 keeps toolSequence compact). */
const TOOL_BRIEF_CHARS = 120

/** Pending-call map bound, so a long turn cannot grow it without limit. */
const PENDING_CALLS_MAX = 32

/** Turn-end kinds that are stored verbatim; everything else maps onto the contract vocabulary. */
const STORED_TURN_END = new Set(['completed', 'aborted', 'error', 'max-tokens', 'interrupted'])

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

/** Deep-merge the (partial) runtime config over the documented defaults. */
function mergeConfig(base, override) {
  const out = cloneJson(base)
  if (override === null || override === undefined || typeof override !== 'object' || Array.isArray(override)) return out
  for (const [key, value] of Object.entries(override)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && out[key] !== null && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeConfig(out[key], value)
    } else if (Array.isArray(value)) {
      out[key] = [...value]
    } else {
      out[key] = value
    }
  }
  return out
}

function emptySkillMeta() {
  return {
    description: '',
    whenToUse: '',
    source: 'unknown',
    provider: 'unknown',
    path: '',
    resourceBase: null,
    bodyChars: 0,
    bodyTokens: 0,
  }
}

function emptyTrace() {
  return {
    observedMs: 0,
    turnEnd: 'unknown',
    assistantTexts: [],
    toolSequence: [],
    userMessages: [],
    skillReLoaded: false,
    finalAnswerChars: 0,
  }
}

function emptyTask() {
  return { userGoal: '', recentUser: [], recentAssistant: [], cwd: '', messageCount: 0 }
}

/** Contract-shaped record for the journal (internal `_` fields are deliberately excluded). */
function pickStoredEpisode(episode) {
  return {
    id: episode.id,
    sessionId: episode.sessionId ?? null,
    turn: episode.turn ?? 0,
    step: episode.step ?? 0,
    callId: episode.callId,
    skill: episode.skill,
    startedAt: episode.startedAt,
    endedAt: episode.endedAt ?? 0,
    state: episode.state,
    skillMeta: episode.skillMeta,
    task: episode.task,
    prediction: episode.prediction,
    probe: episode.probe,
    call: episode.call,
    trace: episode.trace,
    judge: episode.judge,
    cost: episode.cost,
    flags: episode.flags,
  }
}

/** Optional Host service that may be a ctx property or only reachable through `ctx.get`. */
function optionalService(ctx, name) {
  if (ctx === null || ctx === undefined) return null
  try {
    const direct = ctx[name]
    if (direct !== null && direct !== undefined) return direct
  } catch {
    // exotic contexts may throw on unknown property access
  }
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (viaGet !== null && viaGet !== undefined) return viaGet
  } catch {
    // optional service missing is normal
  }
  return null
}

function sessionKey(session) {
  const id = session?.id
  if (id === null || id === undefined) return null
  return String(id)
}

/**
 * Owning agent/session id used to namespace correlation keys.
 * Tool-call ids are provider-generated and not globally unique: two concurrent sessions
 * (main + subagent, or two subagents) can reuse the same id, so every correlation key must
 * carry the owner. Agent id wins because tool executions are stamped with their agent.
 */
function ownerIdOf(exec, session) {
  const agentId = exec?.agent?.id
  if (agentId !== null && agentId !== undefined) return String(agentId)
  const id = session?.id
  if (id !== null && id !== undefined) return String(id)
  return ''
}

const WINDOW_KEY_SEPARATOR = '\u0000'

/** Composite correlation key: `<ownerId>\\u0000<callId>`. */
function windowKeyFromParts(ownerId, callId) {
  const owner = ownerId === null || ownerId === undefined ? '' : String(ownerId)
  const call = callId === null || callId === undefined ? '' : String(callId)
  return `${owner}${WINDOW_KEY_SEPARATOR}${call}`
}

/** Composite correlation key derived from the Host execution and/or its session. */
function windowKey(exec, session) {
  return windowKeyFromParts(ownerIdOf(exec, session), exec?.callId)
}

function contentCharsOf(content) {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) return contentText(content).length
  if (content !== null && typeof content === 'object') return contentText(content.content ?? content).length
  return 0
}

function pushBounded(items, value, maxItems) {
  items.push(value)
  while (items.length > maxItems) items.shift()
  return items
}

function mapTurnEnd(reason) {
  const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
  if (STORED_TURN_END.has(kind)) return kind
  if (kind === 'forked' || kind === 'blocked') return 'aborted'
  return 'completed'
}

function parseToolArguments(raw) {
  if (raw !== null && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function briefArguments(raw) {
  const parsed = parseToolArguments(raw)
  if (parsed === null) return typeof raw === 'string' ? raw : ''
  try {
    return JSON.stringify(parsed)
  } catch {
    return ''
  }
}

/** Infer the current turn/step from the session log tail; never throws. */
function inferTurnStep(session) {
  let turn = 0
  let step = 0
  try {
    const seq = Number(session?.seq)
    const from = Number.isFinite(seq) ? Math.max(0, seq - SESSION_TAIL_EVENTS) : 0
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents(from) : []
    for (const event of Array.isArray(events) ? events : []) {
      const data = event?.data
      if (data === null || typeof data !== 'object') continue
      if (Number.isFinite(data.turn)) turn = data.turn
      if (Number.isFinite(data.step)) step = data.step
    }
  } catch {
    // A fake or disposed session still produces a usable episode.
  }
  return { turn, step }
}

/** True for a user-role message that is DSH metadata, not the user's request. */
function isMetaUserMessage(message, text) {
  const kind = message?.source?.kind
  if (typeof kind === 'string' && META_USER_SOURCE_KINDS.has(kind)) return true
  const trimmed = text.trimStart()
  return META_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

/** Compact, bounded task pack from the session's derived messages. */
function buildTaskPack(session) {
  const pack = emptyTask()
  pack.cwd = asString(session?.header?.cwd)
  let messages = []
  try {
    messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : []
  } catch {
    messages = []
  }
  if (!Array.isArray(messages)) messages = []
  pack.messageCount = messages.length
  // Scan the whole derivation: the real request often sits before later metadata messages, so a
  // tail slice would drop it. Metadata injected as role=user is skipped by source kind/known prefixes.
  const userTexts = []
  const assistantTexts = []
  for (const message of messages) {
    const text = contentText(message?.content)
    if (text.length === 0) continue
    if (message?.role === 'user') {
      if (isMetaUserMessage(message, text)) continue
      userTexts.push(text)
      if (userTexts.length > 3) userTexts.shift()
    } else if (message?.role === 'assistant') {
      assistantTexts.push(text)
      if (assistantTexts.length > 3) assistantTexts.shift()
    }
  }
  const lastUser = userTexts.length > 0 ? userTexts[userTexts.length - 1] : ''
  pack.userGoal = truncate(oneLine(lastUser, 2000), CAPS.taskUserGoalChars)
  pack.recentUser = userTexts.slice(-3).map((text) => truncate(oneLine(text, 600), CAPS.taskMessageChars))
  pack.recentAssistant = assistantTexts.slice(-3).map((text) => truncate(oneLine(text, 600), CAPS.taskMessageChars))
  return pack
}

/** Skill sources the dreamer may edit: source must be allowed AND the path inside a user root. */
function isSkillEditable(meta, config, env = process.env) {
  const sources = Array.isArray(config?.dream?.editableSources) && config.dream.editableSources.length > 0
    ? config.dream.editableSources
    : DEFAULT_EDITABLE_SOURCES
  if (!sources.includes(meta?.source)) return false
  const path = typeof meta?.path === 'string' ? meta.path : ''
  if (path.length === 0) return false
  try {
    const target = resolve(path)
    const home = homedir()
    const dshHome = asString(env?.DSH_HOME).trim() || resolve(home, '.dsh')
    const roots = [resolve(dshHome, 'skills'), resolve(home, '.agents', 'skills')]
    return roots.some((root) => isInside(root, target))
  } catch {
    return false
  }
}

/** Small FIFO queue bounded by `maxConcurrent` in-flight tasks. */
function createTaskQueue(maxConcurrent) {
  const max = Math.max(1, Math.floor(Number(maxConcurrent) || 2))
  let active = 0
  let closed = false
  const waiting = []
  const pump = () => {
    while (!closed && active < max && waiting.length > 0) {
      const job = waiting.shift()
      active += 1
      const settle = () => {
        active -= 1
        pump()
      }
      Promise.resolve()
        .then(job.task)
        .then(
          (value) => {
            settle()
            job.resolve(value)
          },
          (error) => {
            settle()
            job.reject(error)
          },
        )
    }
  }
  return {
    run(task) {
      return new Promise((resolvePromise, rejectPromise) => {
        if (closed) {
          // A disposed tracker must not start new model calls; resolve as a no-op.
          resolvePromise(undefined)
          return
        }
        waiting.push({ task, resolve: resolvePromise, reject: rejectPromise })
        pump()
      })
    },
    close() {
      closed = true
      for (const job of waiting.splice(0)) job.resolve(undefined)
    },
    get active() {
      return active
    },
    get pending() {
      return waiting.length
    },
  }
}

export class EpisodeTracker {
  /**
   * @param {object} options
   * @param {object} options.ctx Harness context (must expose optional `skills`, `workingDirectory`, `llm`, `subagents`)
   * @param {object} options.config normalized plugin config
   * @param {object} [options.store] DreamStore
   * @param {object} [options.logger] Cordis logger
   * @param {object} [options.guidance] guidance module with `mergeLearnings` (optional)
   * @param {() => number} [options.now] clock override (tests)
   * @param {() => number} [options.random] RNG override (tests)
   */
  constructor({ ctx, config, store, logger, guidance, now = Date.now, random = Math.random } = {}) {
    this.ctx = ctx ?? {}
    this.config = mergeConfig(DEFAULTS, config)
    this.store = store ?? null
    this.logger = logger ?? ctx?.logger ?? null
    this.guidance = guidance ?? null
    this.now = typeof now === 'function' ? now : Date.now
    this.random = typeof random === 'function' ? random : Math.random
    this.windows = new Map()
    this.sessions = new Map()
    this.probes = new Map()
    this.controllers = new Set()
    this.timers = new Set()
    this.bodies = new WeakMap()
    this.queue = createTaskQueue(this.config.run?.maxConcurrent ?? 2)
    this.limiter = createProbeLimiter({ maxPerHour: this.config.probe?.maxPerHour ?? 120, now: this.now })
    this.disposed = false
  }

  /** Number of skill calls currently being observed. */
  openCount() {
    let count = 0
    for (const window of this.windows.values()) if (!window.closed) count += 1
    return count
  }

  /** Whether a skill has a call in flight (used by the dreamer before editing a file). */
  isSkillBusy(name) {
    if (typeof name !== 'string' || name.length === 0) return false
    for (const window of this.windows.values()) {
      if (!window.closed && window.episode?.skill === name) return true
    }
    return false
  }

  /**
   * Probe promise for one call, raced by `tools/post-execute` against
   * `probe.attachDeadlineMs`. Resolves the episode record (never rejects).
   *
   * Call ids are provider-generated and not globally unique, so the preferred form carries
   * the owning agent/session id:
   *   `probePromiseFor(callId, agentIdOrSessionId)`.
   * The legacy single-argument form resolves `undefined` when the raw call id is ambiguous
   * (two concurrent sessions used it), never another session's promise.
   *
   * @param {string} callId provider tool-call id
   * @param {string} [agentIdOrSessionId] owner id (`exec.agent?.id` preferred)
   * @returns {Promise<object|undefined>}
   */
  probePromiseFor(callId, agentIdOrSessionId) {
    const rawCallId = callId !== null && callId !== undefined ? String(callId) : ''
    if (rawCallId.length === 0) return Promise.resolve(undefined)
    const owner = agentIdOrSessionId !== null && agentIdOrSessionId !== undefined ? String(agentIdOrSessionId) : ''
    if (owner.length > 0) {
      const exactKey = windowKeyFromParts(owner, rawCallId)
      const exactPromise = this.probes.get(exactKey)
      if (exactPromise !== undefined) return exactPromise
      const exactWindow = this.windows.get(exactKey)
      if (exactWindow?.episode?._probePromise !== undefined) return exactWindow.episode._probePromise
      // The caller may pass either the agent id or the session id; accept the session id of
      // an exactly-one owning window, but never guess between concurrent owners.
      const candidates = []
      for (const window of this.windows.values()) {
        if (window.closed) continue
        if (window.episode?.callId !== rawCallId) continue
        if (!this._windowBelongsTo(window, owner)) continue
        candidates.push(window)
      }
      if (candidates.length === 1) {
        const candidate = candidates[0]
        const promise = candidate.episode?._probePromise ?? this.probes.get(candidate.key)
        if (promise !== undefined) return promise
      }
      return Promise.resolve(undefined)
    }
    // Legacy single-argument call: only an unambiguous raw-call-id match is safe.
    const candidates = []
    for (const [key, promise] of this.probes) {
      const window = this.windows.get(key)
      if (window?.episode?.callId === rawCallId) candidates.push(promise)
    }
    if (candidates.length === 0) {
      for (const window of this.windows.values()) {
        if (window.closed) continue
        if (window.episode?.callId === rawCallId && window.episode?._probePromise !== undefined) {
          candidates.push(window.episode._probePromise)
        }
      }
    }
    return candidates.length === 1 ? candidates[0] : Promise.resolve(undefined)
  }

  /** True when `owner` is the window's owning agent id or its session id. */
  _windowBelongsTo(window, owner) {
    if (window === null || window === undefined) return false
    if (window.ownerId !== undefined && window.ownerId !== null && window.ownerId.length > 0 && String(window.ownerId) === owner) return true
    return window.sessionId !== null && window.sessionId !== undefined && String(window.sessionId) === owner
  }

  /** Diagnostics for tests and `GET health`; never contains prompt or skill bodies. */
  diagnostics() {
    return {
      open: this.openCount(),
      windows: this.windows.size,
      sessions: this.sessions.size,
      timers: this.timers.size,
      controllers: this.controllers.size,
      probes: this.probes.size,
      queued: this.queue.pending,
      active: this.queue.active,
      disposed: this.disposed,
    }
  }

  /**
   * Open an episode for a pending skill call. Fast path: registers everything synchronously,
   * then awaits only skill metadata + task snapshot. The probe starts here but is not awaited.
   * @returns {Promise<object|undefined>} the episode record (undefined for non-skill calls)
   */
  async onPreExecute({ exec, session } = {}) {
    try {
      if (this.disposed || exec === null || exec === undefined) return undefined
      const name = typeof exec.arguments?.name === 'string' ? exec.arguments.name.trim() : ''
      if (name.length === 0) return undefined
      const callId = exec.callId !== null && exec.callId !== undefined ? String(exec.callId) : ''
      if (callId.length === 0) return undefined
      const correlationKey = windowKey(exec, session)
      const existing = this.windows.get(correlationKey)
      if (existing !== undefined && !existing.closed) return existing.episode
      const episode = this._createEpisode({ exec, session, name, callId })
      episode._windowKey = correlationKey
      const window = this._registerWindow(episode, exec, session, correlationKey)
      episode._session = session ?? null
      episode._agent = exec.agent ?? null
      episode._controller = window.controller
      const enrichment = this._enrich(episode, { exec, session, window })
      episode._enrichPromise = enrichment.catch((error) => {
        this._log('warn', `dreaming: episode enrichment failed for ${name}: ${safeError(error).message}`)
        return undefined
      })
      await episode._enrichPromise
      return episode
    } catch (error) {
      this._log('warn', `dreaming: onPreExecute failed: ${safeError(error).message}`)
      return undefined
    }
  }

  /**
   * Contract alias for `onPreExecute` (ARCHITECTURE.md §6). Accepts a bare `sessionId`
   * when the caller has no Session object; the task pack then stays minimal.
   * @returns {Promise<object|undefined>}
   */
  async begin({ exec, session = undefined, sessionId = undefined } = {}) {
    const usableSession = session ?? (sessionId !== null && sessionId !== undefined ? { id: sessionId, header: {} } : undefined)
    return this.onPreExecute({ exec, session: usableSession })
  }

  /**
   * Record the skill load outcome and cancel the "result never arrived" timer.
   * Matches by the composite owner+callId key; a unique raw-callId match is accepted only
   * when the owner id is missing from the result execution.
   */
  onToolResult({ exec, result, session } = {}) {
    try {
      if (this.disposed || exec === null || exec === undefined) return
      const window = this._findWindow(exec, session)
      if (window === undefined || window.closed) return
      this._clearTimer(window.loadTimer)
      window.loadTimer = null
      const episode = window.episode
      episode.call = {
        isError: result?.isError === true,
        durationMs: Math.max(0, this.now() - episode.startedAt),
        contentChars: contentCharsOf(result?.content),
      }
      if (episode.state === 'recording') episode.state = 'observed'
      this._persist(episode, { call: episode.call, state: episode.state })
    } catch (error) {
      this._log('warn', `dreaming: onToolResult failed: ${safeError(error).message}`)
    }
  }

  /**
   * Locate the observation window for one execution. The exact owner+callId key wins; when
   * the owner id is unavailable (or the result execution omits the agent), fall back to a
   * raw-callId match only if it is unique. Ambiguous matches are ignored: attaching a result
   * to the wrong session would corrupt that skill's belief.
   */
  _findWindow(exec, session) {
    const correlations = new Map()
    const exactKey = windowKey(exec, session)
    const exact = this.windows.get(exactKey)
    if (exact !== undefined && !exact.closed) return exact
    const rawCallId = exec?.callId !== null && exec?.callId !== undefined ? String(exec.callId) : ''
    if (rawCallId.length === 0) return undefined
    for (const window of this.windows.values()) {
      if (window.closed) continue
      if (window.episode?.callId === rawCallId) correlations.set(window.key, window)
    }
    if (correlations.size === 1) return correlations.values().next().value
    return undefined
  }

  /** Append one session event to every open observation window of that session. */
  onSessionEvent(session, event) {
    try {
      if (this.disposed) return
      const key = sessionKey(session)
      if (key === null) return
      const windowKeys = this.sessions.get(key)
      if (windowKeys === undefined || windowKeys.size === 0) return
      for (const correlationKey of [...windowKeys]) {
        const window = this.windows.get(correlationKey)
        if (window === undefined || window.closed) continue
        try {
          this._collectEvent(window, event)
        } catch (error) {
          this._log('warn', `dreaming: trace collection failed for ${window.episode?.id}: ${safeError(error).message}`)
          this._finish(window, 'error')
        }
      }
    } catch (error) {
      this._log('warn', `dreaming: onSessionEvent failed: ${safeError(error).message}`)
    }
  }

  /** The session was disposed: finalize its open windows as aborted and forget the session. */
  onSessionGone(sessionId) {
    try {
      if (this.disposed) return
      const key = sessionId !== null && sessionId !== undefined ? String(sessionId) : null
      if (key === null) return
      const windowKeys = this.sessions.get(key)
      if (windowKeys === undefined) return
      for (const correlationKey of [...windowKeys]) {
        const window = this.windows.get(correlationKey)
        if (window === undefined || window.closed) continue
        window.episode.flags = { ...(window.episode.flags ?? {}), sessionGone: true }
        this._finish(window, 'aborted')
      }
      this.sessions.delete(key)
    } catch (error) {
      this._log('warn', `dreaming: onSessionGone failed: ${safeError(error).message}`)
    }
  }

  /**
   * Freeze the trace, judge, persist and release every resource. Never throws.
   * Safe to call twice for the same episode.
   */
  async finalize(episode, { turnEnd = undefined, session = null, controller = null } = {}) {
    if (episode === null || episode === undefined || typeof episode !== 'object') return episode
    if (episode._finalized === true) return episode
    episode._finalized = true
    try {
      // A fast turn can end before enrichment settles; judge only on complete metadata.
      if (episode._enrichPromise !== undefined) await Promise.resolve(episode._enrichPromise).catch(() => undefined)
      await this._awaitProbe(episode)
      episode.endedAt = episode.endedAt || this.now()
      if (episode.trace !== null && typeof episode.trace === 'object') {
        if (episode.trace.turnEnd === 'unknown' && typeof turnEnd === 'string') episode.trace.turnEnd = turnEnd
        if (!Number.isFinite(episode.trace.observedMs) || episode.trace.observedMs <= 0) {
          episode.trace.observedMs = Math.max(0, episode.endedAt - episode.startedAt)
        }
      }
      if (this.disposed || episode.flags?.disposed === true || episode.flags?.sessionGone === true) {
        episode.state = 'failed'
        episode.judge = { ...(episode.judge ?? emptyJudgeRecord()), status: 'error', error: episode.judge?.error ?? 'aborted' }
        episode.cost = computeEpisodeCost(episode)
        this._recordUnjudgedLoad(episode)
        this._persistEpisode(episode)
        return episode
      }
      const result = await judgeEpisode({
        ctx: this.ctx,
        config: this.config,
        store: this.store,
        episode,
        session,
        signal: controller?.signal,
        logger: this.logger,
        guidance: this.guidance,
      })
      if (result === null || typeof result !== 'object') {
        this._recordUnjudgedLoad(episode)
        return episode
      }
      if (episode.state !== 'judged') {
        episode.cost = computeEpisodeCost(episode)
        if (episode.state === 'recording') episode.state = 'observed'
        this._recordUnjudgedLoad(episode)
        this._persistEpisode(episode)
        // judgeEpisode persists token totals for invalid/error verdicts; skipped probes still
        // spent tokens, which the episode's own journal must account for exactly once.
        if (episode._totalsBumped !== true) this._bumpUnjudgedTotals(episode)
      }
      return episode
    } catch (error) {
      this._log('warn', `dreaming: finalize failed for ${episode?.id}: ${safeError(error).message}`)
      try {
        episode.state = 'failed'
        episode.flags = { ...(episode.flags ?? {}), finalizeError: true }
        episode.cost = episode.cost ?? computeEpisodeCost(episode)
        this._recordUnjudgedLoad(episode)
        this._persistEpisode(episode)
      } catch {
        // best effort only
      }
      return episode
    } finally {
      this._cleanupEpisode(episode)
    }
  }

  /**
   * Count one load for an episode that will not get a judged skill update. Guarded by
   * `episode._loadCounted` and by `state === 'judged'` so judged and unjudged paths never
   * double-count. Never throws.
   */
  _recordUnjudgedLoad(episode) {
    if (episode === null || episode === undefined) return
    if (episode.state === 'judged' || episode._loadCounted === true) return
    try {
      const updated = this.store?.updateSkill?.(episode.skill, (skill) =>
        applyUnjudgedLoadToSkill(skill, episode, { now: this.now() }),
      )
      if (updated !== undefined) episode._loadCounted = true
      else if (typeof this.store?.saveState === 'function') this.store.saveState()
    } catch (error) {
      this._log('warn', `dreaming: failed to count unjudged load for ${episode?.id}: ${safeError(error).message}`)
    }
  }

  /**
   * Release everything: clear timers, abort in-flight model calls, mark open episodes failed.
   * Never throws and never awaits (the Host effect disposer may be synchronous).
   */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    try {
      for (const window of [...this.windows.values()]) {
        const episode = window.episode
        window.closed = true
        this._clearTimer(window.observationTimer)
        this._clearTimer(window.loadTimer)
        window.observationTimer = null
        window.loadTimer = null
        window.detach?.()
        try {
          episode.flags = { ...(episode.flags ?? {}), disposed: true }
          episode.state = 'failed'
          episode.endedAt = episode.endedAt || this.now()
          episode.judge = { ...(episode.judge ?? emptyJudgeRecord()), status: 'error', error: episode.judge?.error ?? 'disposed' }
          if (episode.probe?.status === 'pending') episode.probe = { ...episode.probe, status: 'skipped' }
          episode.cost = computeEpisodeCost(episode)
          this._recordUnjudgedLoad(episode)
          this._persistEpisode(episode)
        } catch {
          // best effort; dispose must not throw
        }
      }
      this.windows.clear()
      this.sessions.clear()
      this.probes.clear()
      for (const controller of this.controllers) {
        try {
          controller.abort(new Error('dreaming tracker disposed'))
        } catch {
          // already aborted or unusable
        }
      }
      this.controllers.clear()
      for (const timer of this.timers) clearTimeout(timer)
      this.timers.clear()
      this.queue.close()
    } catch (error) {
      try {
        this._log('warn', `dreaming: dispose failed: ${safeError(error).message}`)
      } catch {
        // absolutely nothing may escape a disposer
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------------------------

  _createEpisode({ exec, session, name, callId }) {
    const { turn, step } = inferTurnStep(session)
    const episode = {
      id: makeId('ep'),
      sessionId: sessionKey(session),
      turn,
      step,
      callId,
      skill: name,
      startedAt: this.now(),
      endedAt: 0,
      state: 'recording',
      skillMeta: emptySkillMeta(),
      task: buildTaskPack(session),
      prediction: null,
      probe: emptyProbeRecord(this.config.probe?.mode),
      call: null,
      trace: emptyTrace(),
      judge: null,
      cost: null,
      flags: { sampled: false, truncated: false, dreamIds: [] },
    }
    try {
      this.store?.appendEpisode?.(pickStoredEpisode(episode))
    } catch (error) {
      this._log('debug', `dreaming: failed to append episode ${episode.id}: ${safeError(error).message}`)
    }
    void exec
    return episode
  }

  _registerWindow(episode, exec, session, correlationKey = windowKey(exec, session)) {
    const controller = new AbortController()
    const parent = exec?.signal
    let detach = () => {}
    try {
      if (parent?.aborted === true) controller.abort(parent.reason)
      else if (parent !== null && parent !== undefined && typeof parent.addEventListener === 'function') {
        const onAbort = () => {
          try {
            controller.abort(parent.reason)
          } catch {
            // ignore
          }
        }
        parent.addEventListener('abort', onAbort, { once: true })
        detach = () => {
          try {
            parent.removeEventListener('abort', onAbort)
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // A fake/edge signal still yields a usable controller.
    }
    const window = {
      episode,
      session,
      sessionId: sessionKey(session),
      ownerId: ownerIdOf(exec, session),
      key: correlationKey,
      closed: false,
      events: 0,
      trace: episode.trace,
      pendingCalls: new Map(),
      controller,
      detach,
      observationTimer: null,
      loadTimer: null,
    }
    this.windows.set(correlationKey, window)
    if (window.sessionId !== null) {
      if (!this.sessions.has(window.sessionId)) this.sessions.set(window.sessionId, new Set())
      this.sessions.get(window.sessionId).add(correlationKey)
    }
    this.controllers.add(controller)
    const observeConfig = this.config.observe ?? {}
    window.observationTimer = this._setTimer(() => this._finish(window, 'timeout'), observeConfig.maxTurnExtensionMs ?? 600_000)
    window.loadTimer = this._setTimer(() => {
      if (window.closed) return
      window.episode.flags = { ...(window.episode.flags ?? {}), loadResultMissing: true }
      this._finish(window, 'timeout')
    }, observeConfig.flushGraceMs ?? 8_000)
    return window
  }

  async _enrich(episode, { exec, session, window }) {
    const cwd = await this._resolveCwd(exec, session, window.controller.signal)
    const meta = await this._resolveSkillMeta(episode.skill, exec, session, cwd, window.controller.signal)
    episode.skillMeta = meta.summary
    if (meta.body.length > 0) this.bodies.set(episode, meta.body)
    if (typeof cwd === 'string' && cwd.length > 0) episode.task = { ...(episode.task ?? emptyTask()), cwd }
    try {
      this.store?.ensureSkill?.({
        name: episode.skill,
        meta: meta.summary,
        editable: isSkillEditable(meta.summary, this.config),
      })
    } catch (error) {
      this._log('warn', `dreaming: failed to ensure skill belief ${episode.skill}: ${safeError(error).message}`)
    }
    this._persist(episode, { skillMeta: episode.skillMeta, task: episode.task })
    if (!window.closed && !this.disposed) this._startProbe(episode, session, window)
    return episode
  }

  _startProbe(episode, session, window) {
    const skillBody = this.bodies.get(episode) ?? ''
    const task = () => {
      if (this.disposed) return Promise.resolve(episode)
      return probeSkill({
        ctx: this.ctx,
        config: this.config,
        store: this.store,
        episode,
        session,
        signal: window.controller.signal,
        logger: this.logger,
        limiter: this.limiter,
        skillBody,
        random: this.random,
      })
    }
    const probePromise = this.queue
      .run(task)
      .then(
        (value) => {
          this._persistProbeResult(episode)
          return value ?? episode
        },
        (error) => {
          this._log('warn', `dreaming: probe task failed for ${episode.skill}: ${safeError(error).message}`)
          return episode
        },
      )
      .catch((error) => {
        this._log('warn', `dreaming: probe wrapper failed for ${episode.skill}: ${safeError(error).message}`)
        return episode
      })
    episode._probePromise = probePromise
    this.probes.set(window.key ?? windowKeyFromParts(episode._agent?.id ?? episode.sessionId, episode.callId), probePromise)
  }

  _persistProbeResult(episode) {
    if (this.disposed || episode?._finalized === true) return
    this._persist(episode, { prediction: episode.prediction, probe: episode.probe, flags: episode.flags })
  }

  async _resolveSkillMeta(name, exec, session, cwd, signal) {
    const fallback = { summary: { ...emptySkillMeta(), name }, body: '' }
    const skills = optionalService(this.ctx, 'skills')
    if (skills === null || typeof skills.get !== 'function') return fallback
    const deadline = withTimeout(METADATA_TIMEOUT_MS, signal)
    try {
      const definition = await Promise.resolve(
        skills.get(name, {
          ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
          scope: exec?.agent,
          signal: deadline.signal,
        }),
      )
      if (definition === null || definition === undefined || typeof definition !== 'object') return fallback
      const content = typeof definition.content === 'string' ? definition.content : ''
      const summary = {
        name: typeof definition.name === 'string' && definition.name.length > 0 ? definition.name : name,
        description: asString(definition.description),
        whenToUse: asString(definition.whenToUse),
        source: asString(definition.source, 'unknown') || 'unknown',
        provider: asString(definition.provider, 'unknown') || 'unknown',
        path: asString(definition.path),
        resourceBase: definition.resourceBase ?? null,
        bodyChars: content.length,
        bodyTokens: content.length > 0 ? estimateTokens(content.length) : 0,
      }
      return { summary, body: content }
    } catch (error) {
      this._log('debug', `dreaming: skill lookup failed for ${name}: ${safeError(error).message}`)
      void session
      return fallback
    } finally {
      deadline.dispose()
    }
  }

  async _resolveCwd(exec, session, signal) {
    try {
      const workingDirectory = optionalService(this.ctx, 'workingDirectory')
      if (workingDirectory !== null) {
        const agent = exec?.agent
        if (agent !== null && agent !== undefined && typeof workingDirectory.ensure === 'function') {
          const deadline = withTimeout(METADATA_TIMEOUT_MS, signal)
          try {
            const dir = await Promise.resolve(workingDirectory.ensure(agent, deadline.signal))
            if (typeof dir === 'string' && dir.length > 0) return dir
          } catch {
            // fall through to the committed directory
          } finally {
            deadline.dispose()
          }
        }
        if (typeof workingDirectory.get === 'function') {
          try {
            const dir = workingDirectory.get(session)
            if (typeof dir === 'string' && dir.length > 0) return dir
          } catch {
            // fall through to the session header
          }
        }
      }
      return asString(session?.header?.cwd)
    } catch {
      return asString(session?.header?.cwd)
    }
  }

  _collectEvent(window, event) {
    const type = typeof event?.type === 'string' ? event.type : ''
    const data = event?.data !== null && typeof event?.data === 'object' ? event.data : {}
    const episode = window.episode
    if (type === 'turn/start') {
      if (Number.isFinite(data.turn)) episode.turn = data.turn
      return
    }
    if (type === 'step/start' || type === 'step/end') {
      if (Number.isFinite(data.step)) episode.step = data.step
      return
    }
    if (type === 'turn/end') {
      const eventTurn = Number.isFinite(data.turn) ? data.turn : episode.turn
      if (episode.turn === 0 || eventTurn >= episode.turn) this._finish(window, mapTurnEnd(data.reason))
      return
    }
    if (type === 'user/message') {
      const text = contentText(data.content ?? data.message?.content)
      if (text.length > 0) {
        pushBounded(window.trace.userMessages, oneLine(text, CAPS.taskMessageChars * 2), CAPS.traceUserItems)
        window.events += 1
      }
    } else if (type === 'assistant/message') {
      const text = contentText(data.message?.content ?? data.content)
      if (text.length > 0) {
        const line = truncate(oneLine(text, 2000), CAPS.traceAssistantChars)
        pushBounded(window.trace.assistantTexts, line, CAPS.traceAssistantItems)
        window.trace.finalAnswerChars = line.length
        window.events += 1
      }
    } else if (type === 'tool/call') {
      this._recordToolCall(window, data)
    } else if (type === 'tool/result') {
      this._recordToolResult(window, data)
    }
    const maxEvents = this.config.observe?.maxEvents ?? 240
    if (window.events >= maxEvents) this._finish(window, 'timeout')
  }

  _recordToolCall(window, data) {
    const episode = window.episode
    const callId = data.callId !== null && data.callId !== undefined ? String(data.callId) : ''
    if (callId.length > 0 && callId === episode.callId) return
    const name = typeof data.name === 'string' && data.name.length > 0 ? data.name : 'tool'
    const entry = { name, ok: null, brief: truncate(oneLine(briefArguments(data.arguments), TOOL_BRIEF_CHARS), TOOL_BRIEF_CHARS) }
    pushBounded(window.trace.toolSequence, entry, CAPS.traceToolItems)
    if (callId.length > 0) {
      window.pendingCalls.set(callId, entry)
      while (window.pendingCalls.size > PENDING_CALLS_MAX) {
        const oldest = window.pendingCalls.keys().next().value
        window.pendingCalls.delete(oldest)
      }
    }
    if (name === 'skill') {
      const args = parseToolArguments(data.arguments)
      if (args !== null && args.name === episode.skill) window.trace.skillReLoaded = true
    }
    window.events += 1
  }

  _recordToolResult(window, data) {
    const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
    const callId = message.toolCallId !== null && message.toolCallId !== undefined
      ? String(message.toolCallId)
      : data.callId !== null && data.callId !== undefined
        ? String(data.callId)
        : ''
    if (callId.length > 0 && callId === window.episode.callId) return
    const isError = data.error !== null && data.error !== undefined ? true : message.isError === true
    const resultText = contentText(message.content)
    const pending = callId.length > 0 ? window.pendingCalls.get(callId) : undefined
    if (pending !== undefined) {
      pending.ok = !isError
      if (pending.brief.length === 0 && resultText.length > 0) pending.brief = truncate(oneLine(resultText, TOOL_BRIEF_CHARS), TOOL_BRIEF_CHARS)
      window.pendingCalls.delete(callId)
    } else {
      pushBounded(
        window.trace.toolSequence,
        { name: 'tool', ok: !isError, brief: truncate(oneLine(resultText, TOOL_BRIEF_CHARS), TOOL_BRIEF_CHARS) },
        CAPS.traceToolItems,
      )
    }
    window.events += 1
  }

  _finish(window, turnEnd) {
    if (window === null || window === undefined || window.closed) return
    window.closed = true
    const episode = window.episode
    this._clearTimer(window.observationTimer)
    this._clearTimer(window.loadTimer)
    window.observationTimer = null
    window.loadTimer = null
    if (episode.trace !== null && typeof episode.trace === 'object') {
      episode.trace.turnEnd = turnEnd
      episode.trace.observedMs = Math.max(0, this.now() - episode.startedAt)
      if (episode.trace.finalAnswerChars === 0 && episode.trace.assistantTexts.length > 0) {
        episode.trace.finalAnswerChars = episode.trace.assistantTexts[episode.trace.assistantTexts.length - 1].length
      }
    }
    this._removeWindow(window)
    const promise = this.queue.run(() =>
      this.finalize(episode, { turnEnd, session: window.session, controller: window.controller }),
    )
    promise.catch((error) => {
      this._log('warn', `dreaming: finalize task failed for ${episode?.id}: ${safeError(error).message}`)
    })
  }

  async _awaitProbe(episode) {
    const promise = episode?._probePromise
    if (promise === undefined || promise === null) return
    // Finalize runs after the turn, not on the skill-call path: waiting for the probe here is
    // free for the user and gives the judge the prediction it is meant to compare against.
    const deadlineMs = Math.max(0, Number(this.config.probe?.timeoutMs) || 25000)
    if (deadlineMs === 0) return
    let timer = null
    try {
      await Promise.race([
        promise,
        new Promise((resolvePromise) => {
          timer = setTimeout(resolvePromise, deadlineMs)
          if (typeof timer.unref === 'function') timer.unref()
        }),
      ])
    } catch {
      // probeSkill never rejects; this is belt-and-braces
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  _removeWindow(window) {
    const correlationKey = window.key ?? windowKeyFromParts(ownerIdOf(null, window.session), window.episode?.callId)
    this.windows.delete(correlationKey)
    const sessionId = window.sessionId
    if (sessionId !== null) {
      const keys = this.sessions.get(sessionId)
      if (keys !== undefined) {
        keys.delete(correlationKey)
        if (keys.size === 0) this.sessions.delete(sessionId)
      }
    }
    try {
      window.detach?.()
    } catch {
      // ignore
    }
    window.detach = () => {}
  }

  _cleanupEpisode(episode) {
    try {
      const correlationKey = episode?._windowKey
      if (correlationKey !== undefined && correlationKey !== null) this.probes.delete(correlationKey)
      const sessionId = sessionKey(episode?._session)
      if (sessionId !== null && correlationKey !== undefined && correlationKey !== null) {
        const keys = this.sessions.get(sessionId)
        if (keys !== undefined) {
          keys.delete(correlationKey)
          if (keys.size === 0) this.sessions.delete(sessionId)
        }
      }
      const controller = episode?._controller
      if (controller !== null && controller !== undefined) {
        try {
          controller.abort(new Error('episode finalized'))
        } catch {
          // ignore
        }
        this.controllers.delete(controller)
      }
      if (episode !== null && episode !== undefined && this.bodies !== null) {
        try {
          this.bodies.delete(episode)
        } catch {
          // ignore
        }
      }
      episode._session = null
      episode._agent = null
      episode._controller = null
    } catch {
      // cleanup is best effort
    }
  }

  _bumpUnjudgedTotals(episode) {
    try {
      this.store?.bumpTotals?.({ probeTokens: Math.max(0, Number(episode?.cost?.probe) || 0) })
      if (typeof this.store?.saveState === 'function') this.store.saveState()
    } catch (error) {
      this._log('debug', `dreaming: failed to persist unjudged totals: ${safeError(error).message}`)
    }
  }

  _persistEpisode(episode) {
    this._persist(episode, {
      state: episode.state,
      skillMeta: episode.skillMeta,
      task: episode.task,
      prediction: episode.prediction,
      probe: episode.probe,
      call: episode.call,
      trace: episode.trace,
      judge: episode.judge,
      cost: episode.cost,
      flags: episode.flags,
      endedAt: episode.endedAt,
    })
  }

  _persist(episode, patch) {
    if (this.store === null || typeof this.store.updateEpisode !== 'function') return
    try {
      this.store.updateEpisode(episode.id, { flags: episode.flags, ...patch })
    } catch (error) {
      this._log('debug', `dreaming: failed to persist episode ${episode?.id}: ${safeError(error).message}`)
    }
  }

  _setTimer(fn, ms) {
    const delayMs = Math.max(1, Number.isFinite(Number(ms)) ? Number(ms) : 1)
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      try {
        fn()
      } catch (error) {
        this._log('warn', `dreaming: timer callback failed: ${safeError(error).message}`)
      }
    }, delayMs)
    if (typeof timer.unref === 'function') timer.unref()
    this.timers.add(timer)
    return timer
  }

  _clearTimer(timer) {
    if (timer === null || timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(timer)
  }

  _log(level, message) {
    try {
      const logger = this.logger ?? this.ctx?.logger
      const fn = logger?.[level]
      if (typeof fn === 'function') fn.call(logger, message)
    } catch {
      // logging must never throw
    }
  }
}
