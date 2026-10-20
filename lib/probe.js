/**
 * The probe: one cheap inline model call that predicts what a skill will actually deliver
 * for the current task. It runs concurrently with the skill load and never blocks it.
 *
 * Default backend is `inline` (a single `ctx.llm.stream` call). The optional `subagent`
 * backend is best-effort: any failure (missing service, activation error, timeout, empty
 * output) silently falls back to inline, so the product default is unaffected.
 *
 * Failure posture: `probeSkill` never rejects. Every failure is recorded on
 * `episode.probe.status` and logged at `warn`; `episode.prediction` stays `null`.
 */

import { CAPS } from './constants.js'
import {
  clamp,
  estimateTokens,
  parseJsonLoose,
  safeError,
  withTimeout,
} from './util.js'
import { resolveRoute, streamText } from './llm.js'
import { buildProbeInput, contentText, renderRequestText, validateProbe } from './prompts.js'

/** Rolling-window length for the per-hour probe cap. */
const HOUR_MS = 3_600_000

/** Local fallbacks only; the normalized plugin config is authoritative at runtime. */
const DEFAULT_TIMEOUT_MS = 25_000
const DEFAULT_MAX_PER_HOUR = 120
const DEFAULT_MIN_BODY_CHARS = 0

/** A fresh durable probe record (ARCHITECTURE.md §5.1). */
export function emptyProbeRecord(backend = 'inline') {
  return {
    backend: backend === 'subagent' ? 'subagent' : 'inline',
    model: null,
    status: 'pending',
    tokensIn: 0,
    tokensOut: 0,
    latencyMs: 0,
    error: null,
  }
}

/** True when past episodes showed a capability gap, so the probe should not be sampled away. */
export function hasKnownGap(skillState) {
  const counts = skillState?.counts
  if (counts === null || typeof counts !== 'object') return false
  if (Number(counts.boundaryGaps) > 0) return true
  if (Number(counts.misapplied) > 0) return true
  return false
}

/**
 * Bounded per-hour probe budget shared by every probe of this plugin instance.
 * @param {{maxPerHour?: number, now?: () => number}} [options]
 */
export function createProbeLimiter({ maxPerHour = DEFAULT_MAX_PER_HOUR, now = Date.now } = {}) {
  const limit = Math.max(1, Math.floor(Number(maxPerHour) || DEFAULT_MAX_PER_HOUR))
  let timestamps = []
  const prune = (time) => {
    timestamps = timestamps.filter((stamp) => stamp <= time && time - stamp < HOUR_MS)
  }
  return {
    /** @returns {boolean} true when a probe slot was granted */
    take() {
      const time = now()
      prune(time)
      if (timestamps.length >= limit) return false
      timestamps.push(time)
      return true
    },
    /** Current occupancy without consuming a slot. */
    count() {
      prune(now())
      return timestamps.length
    },
    reset() {
      timestamps = []
    },
    get limit() {
      return limit
    },
  }
}

/**
 * Decide whether this episode should be probed.
 *
 * @param {object} input
 * @param {object} input.config normalized config
 * @param {object} [input.skillMeta] episode skill metadata (uses `bodyChars`)
 * @param {object} [input.skillState] durable belief (uses gap counters)
 * @param {object} [input.limiter] probe limiter (consumed only when selected)
 * @param {() => number} [input.random] deterministic RNG for tests
 * @returns {{selected: boolean, reason: string, forced: boolean, sampled: boolean}}
 */
export function selectProbe({ config, skillMeta, skillState, limiter, random = Math.random } = {}) {
  const cfg = config?.probe ?? {}
  if (cfg.enabled === false) return { selected: false, reason: 'disabled', forced: false, sampled: false }
  const bodyChars = Number(skillMeta?.bodyChars) || 0
  const minBodyChars = Number.isFinite(cfg.minBodyChars) ? cfg.minBodyChars : DEFAULT_MIN_BODY_CHARS
  if (bodyChars < minBodyChars) return { selected: false, reason: 'body-too-small', forced: false, sampled: false }
  const forced = cfg.alwaysForGapSkills === true && hasKnownGap(skillState)
  if (!forced) {
    const sampleRate = clamp(cfg.sampleRate ?? 1, 0, 1, 1)
    if (random() >= sampleRate) return { selected: false, reason: 'sampled-out', forced: false, sampled: false }
  }
  if (limiter !== null && limiter !== undefined && typeof limiter.take === 'function') {
    if (!limiter.take()) return { selected: false, reason: 'hourly-cap', forced, sampled: false }
  }
  return {
    selected: true,
    reason: forced ? 'always-for-gap-skill' : 'sampled',
    forced,
    sampled: !forced,
  }
}

/** Resolve a probe route with the output cap clamped to the hard probe budget. */
async function resolveProbeRoute(ctx, session, cfg) {
  const route = await resolveRoute(ctx, session, cfg?.model)
  const configured = Number(route.maxTokens)
  const maxTokens = Number.isFinite(configured) && configured > 0 ? Math.min(configured, CAPS.probeMaxTokens) : CAPS.probeMaxTokens
  return { ...route, maxTokens }
}

function optionalService(ctx, name) {
  if (ctx === null || ctx === undefined) return null
  try {
    const direct = ctx[name]
    if (direct !== null && direct !== undefined) return direct
  } catch {
    // ignore property access failures on exotic contexts
  }
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (viaGet !== null && viaGet !== undefined) return viaGet
  } catch {
    // optional service missing is normal
  }
  return null
}

/** Race a promise against an AbortSignal, cleaning every listener/timer behind it. */
function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      signal?.removeEventListener?.('abort', onAbort)
      reject(new Error('aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        signal?.removeEventListener?.('abort', onAbort)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        signal?.removeEventListener?.('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** Extract assistant text from an activation result's output/structured value. */
function extractOutputText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return contentText(value)
  if (value !== null && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (Array.isArray(value.content)) return contentText(value.content)
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * Optional expensive backend. Returns `null` on ANY problem so the caller falls back to
 * the inline path. Always disposes the activation and the timeout handle.
 */
async function runSubagentProbe({ ctx, config, episode, session, prompt, signal, logger }) {
  const subagents = optionalService(ctx, 'subagents')
  if (subagents === null || typeof subagents.startActivation !== 'function') return null
  const cfg = config?.probe ?? {}
  const timeoutMs = clamp(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, 180000, DEFAULT_TIMEOUT_MS)
  const deadline = withTimeout(timeoutMs, signal)
  const startedAt = Date.now()
  let activation = null
  try {
    const promptText = renderRequestText(prompt)
    if (promptText.length === 0) return null
    const parent = episode?._agent ?? episode?.agent ?? session?.agent
    const cwd = typeof episode?.task?.cwd === 'string' && episode.task.cwd.length > 0 ? episode.task.cwd : undefined
    activation = await subagents.startActivation({
      ...(typeof cfg.subagentProvider === 'string' && cfg.subagentProvider.length > 0
        ? { provider: cfg.subagentProvider }
        : {}),
      label: 'dreaming probe',
      request: {
        ...(parent !== null && parent !== undefined ? { parent } : {}),
        prompt: [{ type: 'text', text: promptText }],
        ...(cwd ? { cwd } : {}),
      },
      signal: deadline.signal,
      delivery: 'caller',
    })
    if (activation === null || activation === undefined || typeof activation.result?.then !== 'function') return null
    const result = await raceAbort(activation.result, deadline.signal)
    const outputText = extractOutputText(result?.output ?? result?.structured)
    if (outputText.trim().length === 0) return null
    return {
      text: outputText,
      usage: {
        inputTokens: estimateTokens(promptText.length),
        outputTokens: estimateTokens(outputText.length),
      },
      latencyMs: Math.max(0, Date.now() - startedAt),
      provider: 'subagent',
      model: typeof cfg.subagentProvider === 'string' && cfg.subagentProvider.length > 0 ? cfg.subagentProvider : 'caller-delivery',
    }
  } catch (error) {
    logger?.debug?.(`dreaming: subagent probe unavailable (${safeError(error).message}); using inline probe`)
    return null
  } finally {
    try {
      await activation?.dispose?.()
    } catch {
      // disposal is best effort; a failed dispose must not reach the caller
    }
    deadline.dispose()
  }
}

/** Run the default inline probe call. */
async function runInlineProbe({ ctx, route, prompt, config, signal, logger }) {
  const cfg = config?.probe ?? {}
  const temperature = clamp(cfg.temperature ?? 0.2, 0, 1, 0.2)
  const timeoutMs = clamp(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, 180000, DEFAULT_TIMEOUT_MS)
  const result = await streamText(ctx, {
    route,
    system: prompt.system,
    messages: prompt.messages,
    temperature,
    maxTokens: route.maxTokens,
    timeoutMs,
    signal,
    purpose: 'probe',
    logger,
  })
  return {
    text: result.text,
    usage: result.usage,
    latencyMs: result.latencyMs,
    provider: result.provider,
    model: result.model,
  }
}

async function runProbe({ ctx, config, store, episode, session, signal, logger, limiter, skillBody, random }) {
  if (episode === null || episode === undefined || typeof episode !== 'object') return episode
  const cfg = config?.probe ?? {}
  const log = logger ?? ctx?.logger
  if (episode.probe === null || episode.probe === undefined) episode.probe = emptyProbeRecord(cfg.mode)
  if (episode.flags === null || episode.flags === undefined) episode.flags = { sampled: false, truncated: false, dreamIds: [] }
  try {
    if (!episode.skill) {
      episode.probe.status = 'skipped'
      episode.probe.error = 'no-skill'
      return episode
    }
    let skillState = null
    try {
      skillState = typeof store?.getSkill === 'function' ? store.getSkill(episode.skill) : null
    } catch {
      skillState = null
    }
    const decision = selectProbe({ config, skillMeta: episode.skillMeta, skillState, limiter, random })
    if (!decision.selected) {
      episode.probe.status = 'skipped'
      episode.flags.sampled = false
      log?.debug?.(`dreaming: probe skipped (${decision.reason}) skill=${episode.skill}`)
      return episode
    }
    episode.flags.sampled = decision.sampled === true
    const route = await resolveProbeRoute(ctx, session, cfg)
    episode.probe.model = `${route.provider}/${route.model}`
    const prompt = buildProbeInput({
      skillMeta: { ...(episode.skillMeta ?? {}), content: typeof skillBody === 'string' ? skillBody : '' },
      task: episode.task ?? {},
      learned: skillState ?? {},
      config,
    })
    if (prompt.truncated === true) episode.flags.truncated = true

    let result = null
    if (cfg.mode === 'subagent') {
      result = await runSubagentProbe({ ctx, config, episode, session, prompt, signal, logger: log })
      if (result !== null) episode.probe.backend = 'subagent'
    }
    if (result === null) {
      result = await runInlineProbe({ ctx, route, prompt, config, signal, logger: log })
      episode.probe.backend = 'inline'
    }

    episode.probe.tokensIn = result.usage.inputTokens
    episode.probe.tokensOut = result.usage.outputTokens
    episode.probe.latencyMs = result.latencyMs
    if (typeof result.model === 'string') episode.probe.model = result.provider === 'subagent' ? result.model : `${result.provider}/${result.model}`

    const parsed = parseJsonLoose(result.text)
    if (parsed === undefined) {
      episode.probe.status = 'invalid'
      episode.probe.error = 'invalid-json'
      log?.warn?.(`dreaming: probe for ${episode.skill} returned no parseable JSON (${result.text.length} chars)`)
      return episode
    }
    const { value, issues } = validateProbe(parsed)
    episode.prediction = value
    episode.probe.status = 'ok'
    episode.probe.error = null
    if (issues.length > 0) log?.debug?.(`dreaming: probe for ${episode.skill} coerced ${issues.length} field(s)`)
    log?.debug?.(
      `dreaming: probe ok skill=${episode.skill} fit=${value.fit} confidence=${value.confidence} ` +
        `in=${result.usage.inputTokens} out=${result.usage.outputTokens} ${result.latencyMs}ms`,
    )
    return episode
  } catch (error) {
    const failure = safeError(error)
    episode.probe = {
      ...(episode.probe ?? emptyProbeRecord(cfg.mode)),
      status: 'error',
      error: failure.message || failure.name,
    }
    episode.prediction = null
    log?.warn?.(`dreaming: probe for ${episode.skill ?? 'unknown'} failed: ${failure.message}`)
    return episode
  }
}

/**
 * Probe one skill load. Never rejects; returns the same episode with `probe` (and
 * `prediction` on success) updated, and stores the promise as `episode._probePromise`.
 *
 * @param {object} options
 * @param {object} options.ctx Harness context (fake-friendly)
 * @param {object} options.config normalized config
 * @param {object} [options.store] durable store (read for known-gap sampling)
 * @param {object} options.episode episode record being observed
 * @param {object} [options.session] triggering session (request-header route)
 * @param {AbortSignal} [options.signal] cancellation from the observation window
 * @param {object} [options.logger] logger override
 * @param {object} [options.limiter] shared per-hour limiter
 * @param {string} [options.skillBody] skill body for the probe's excerpt
 * @param {() => number} [options.random] deterministic RNG for tests
 * @returns {Promise<object>} the episode record
 */
export function probeSkill(options = {}) {
  const episode = options?.episode
  const promise = runProbe(options).catch((error) => {
    // Defensive outer catch: recording a failure must never become a rejection.
    try {
      if (episode !== null && episode !== undefined && typeof episode === 'object') {
        episode.probe = {
          ...(episode.probe ?? emptyProbeRecord()),
          status: 'error',
          error: safeError(error).message,
        }
        episode.prediction = null
      }
    } catch {
      // ignore
    }
    try {
      options?.logger?.warn?.(`dreaming: probe wrapper failed: ${safeError(error).message}`)
    } catch {
      // ignore
    }
    return episode
  })
  if (episode !== null && episode !== undefined && typeof episode === 'object') {
    episode._probePromise = promise
  }
  return promise
}
