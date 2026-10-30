/**
 * Transport for the plugin's cheap inline model calls.
 *
 * This module is deliberately boring: it resolves which model route to use and turns
 * `ctx.llm.stream(...)` into one bounded `{ text, usage, finish, latencyMs }` result.
 * It never creates sessions, never passes tools, and never touches a prompt body in a
 * log line above `debug`.
 *
 * Failure posture (ARCHITECTURE.md §11):
 * - every call is bounded by an AbortController that composes the caller's signal and a
 *   timeout; the timeout handle is always disposed;
 * - one retry is allowed for retryable transport failures, never for cancellation;
 * - the thrown errors are typed (`RouteUnavailable`, `StreamError`) so callers can
 *   classify without string matching.
 */

import { safeError, withTimeout } from './util.js'

/** Fallback budget when a caller forgets `timeoutMs` (all real callers pass one). */
const DEFAULT_TIMEOUT_MS = 30_000

/** Delay before the single retry. Small: this call should not add user-visible latency. */
const RETRY_DELAY_MS = 250

/** One retry, as specified by the module contract. */
const MAX_ATTEMPTS = 2

/**
 * The adapter rejected `reasoningEffort` for this exact model (`dsh-llm` validates explicit
 * efforts against the model's advertised list and never clamps them). It is a configuration
 * mismatch, not a transport failure, so an auxiliary call degrades to the inherited effort
 * instead of losing the probe/judge.
 */
const UNSUPPORTED_EFFORT_CODE = 'UNSUPPORTED_REASONING_EFFORT'

/** Provider-discovery probing is bounded: the first few advertised providers only. */
const MAX_PROVIDER_PROBES = 3

/** Error codes that indicate a transient adapter/transport failure. */
const RETRYABLE_CODES = new Set([
  'ABORT_ERR',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

/** HTTP statuses whose provider failures are worth one retry. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

/** Message fragments that indicate a transient failure on adapters without codes. */
const RETRYABLE_MESSAGE = /(?:network|fetch failed|socket hang up|timed? ?out|rate.?limit|overloaded|temporarily unavailable|too many requests)/i

/**
 * No usable model route could be resolved from config, session header, host default or
 * the adapter registry. Callers treat this as "probe/judge unavailable", never fatal.
 */
export class RouteUnavailable extends Error {
  constructor(message = 'no model route available', details = {}) {
    super(message)
    this.name = 'RouteUnavailable'
    this.code = 'DREAMING_ROUTE_UNAVAILABLE'
    this.details = details
  }
}

/**
 * A streaming call failed. `aborted` calls were cancelled by us or the caller and must
 * never be retried; `retryable` calls may be retried once by `streamText`.
 */
export class StreamError extends Error {
  constructor(message, { code = 'DREAMING_STREAM_FAILED', retryable = false, aborted = false, timeout = false, failure = null, cause = null } = {}) {
    super(message, cause === null ? undefined : { cause })
    this.name = 'StreamError'
    this.code = code
    this.retryable = Boolean(retryable)
    this.aborted = Boolean(aborted)
    this.timeout = Boolean(timeout)
    this.failure = failure
  }
}

/** Normalize a `{provider, model, reasoningEffort?, maxTokens?}` route candidate. */
export function normalizeRoute(route) {
  const source = route !== null && typeof route === 'object' ? route : {}
  const provider = typeof source.provider === 'string' ? source.provider.trim() : ''
  const model = typeof source.model === 'string' ? source.model.trim() : ''
  const reasoningEffort = typeof source.reasoningEffort === 'string' ? source.reasoningEffort.trim() : ''
  const maxTokens = Number.isFinite(source.maxTokens) && source.maxTokens > 0 ? Math.round(source.maxTokens) : 0
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(maxTokens > 0 ? { maxTokens } : {}),
  }
}

/** True when an error represents cancellation rather than failure. */
export function isAbortError(error) {
  if (error === null || error === undefined) return false
  if (error instanceof StreamError) return error.aborted
  return (
    error.name === 'AbortError' ||
    error.code === 'ABORT_ERR' ||
    error.code === 'DREAMING_ABORTED' ||
    error.aborted === true
  )
}

/** Conservative classification of a thrown adapter error as retryable. */
export function isRetryableError(error) {
  if (error === null || error === undefined) return false
  if (isAbortError(error)) return false
  const status = Number(error.status ?? error.statusCode ?? error.failure?.status)
  if (Number.isFinite(status) && RETRYABLE_STATUS.has(status)) return true
  for (const code of [error.code, error.cause?.code, error.failure?.code]) {
    if (typeof code === 'string' && RETRYABLE_CODES.has(code.toUpperCase())) return true
  }
  const message = typeof error.message === 'string' ? error.message : ''
  return RETRYABLE_MESSAGE.test(message)
}

/**
 * True when the adapter rejected the requested reasoning effort for this exact model. The
 * Harness reports it as a typed error code; an older host may only expose the message.
 */
function isUnsupportedEffort(error) {
  if (error === null || error === undefined) return false
  for (const candidate of [error, error.failure, error.cause]) {
    const code = candidate?.code
    if (typeof code === 'string' && code.toUpperCase() === UNSUPPORTED_EFFORT_CODE) return true
  }
  const message = typeof error.message === 'string' ? error.message : ''
  return /unsupported reasoning effort|does not support reasoning effort/i.test(message)
}

/** Read the model route recorded on a session's current request header, if any. */
function readSessionRoute(session) {
  try {
    const header = session?.requestHeader?.()
    const config = header?.config
    if (config !== null && typeof config === 'object') return normalizeRoute(config)
  } catch {
    // A disposed or fake session must not break route resolution.
  }
  return {}
}

/** Read the host's default model selection, if the optional service exists. */
function readDefaultSelection(ctx) {
  try {
    const service = optionalService(ctx, 'agentDefaultModel')
    if (service === null) return {}
    const selection = service.currentSelection?.()
    if (selection !== null && typeof selection === 'object') {
      return normalizeRoute({
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
      })
    }
  } catch {
    // Ignore: fall through to the advertised-provider path.
  }
  return {}
}

/**
 * Resolve the `agentDefaultModel` / `subagents` / `skills` style optional service, whether
 * the runtime exposes it as a ctx property or only through `ctx.get(name)`.
 */
function optionalService(ctx, name) {
  if (ctx === null || ctx === undefined) return null
  try {
    const direct = ctx[name]
    if (direct !== null && direct !== undefined) return direct
  } catch {
    // Some contexts throw on unknown property access.
  }
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(name) : undefined
    if (viaGet !== null && viaGet !== undefined) return viaGet
  } catch {
    // Optional service missing is normal.
  }
  return null
}

/** Last-resort route: the first model advertised by the first registered providers. */
async function readAdvertisedRoute(ctx) {
  const llm = ctx?.llm
  if (llm === null || llm === undefined || typeof llm.listProviders !== 'function') return {}
  let providers = []
  try {
    providers = (await Promise.resolve(llm.listProviders())) ?? []
  } catch {
    return {}
  }
  if (!Array.isArray(providers)) return {}
  let checked = 0
  for (const providerInfo of providers) {
    if (checked >= MAX_PROVIDER_PROBES) break
    checked += 1
    const provider = typeof providerInfo === 'string' ? providerInfo : providerInfo?.id
    if (typeof provider !== 'string' || provider.trim().length === 0) continue
    try {
      const models = (await Promise.resolve(llm.listModels(provider))) ?? []
      if (!Array.isArray(models)) continue
      const model = models.find((candidate) => typeof candidate?.id === 'string' && candidate.id.length > 0)
      if (model !== undefined) return { provider: provider.trim(), model: model.id }
    } catch {
      // Try the next provider (bounded by MAX_PROVIDER_PROBES).
    }
  }
  return {}
}

/**
 * Resolve the model route for one cheap call.
 *
 * Precedence (ARCHITECTURE.md §6): plugin config override → triggering session request
 * header → host default selection → first advertised provider/model. Fields merge
 * independently, so a config that only overrides `model` keeps the session's provider.
 *
 * @param {object} ctx Harness context (may be a fake in unit tests)
 * @param {object} [session] trigger session, if any
 * @param {object} [cfg] route override, normally `config.probe.model` or `config.judge.model`
 * @returns {Promise<{provider: string, model: string, reasoningEffort?: string, maxTokens?: number}>}
 * @throws {RouteUnavailable} when no provider/model pair can be found
 */
export async function resolveRoute(ctx, session, cfg) {
  const override = normalizeRoute(cfg)
  // A complete plugin override wins outright and avoids any provider discovery I/O.
  if (override.provider.length > 0 && override.model.length > 0) return override
  const header = readSessionRoute(session)
  const selection = readDefaultSelection(ctx)
  const knownProvider = override.provider || header.provider || selection.provider || ''
  const knownModel = override.model || header.model || selection.model || ''
  if (knownProvider.length > 0 && knownModel.length > 0) {
    return composeRoute(override, header, selection, {})
  }
  const advertised = await readAdvertisedRoute(ctx)
  const provider = knownProvider || advertised.provider || ''
  const model = knownModel || advertised.model || ''
  if (provider.length === 0 || model.length === 0) {
    throw new RouteUnavailable('no model route available for dreaming', {
      hasOverride: Boolean(override.provider || override.model),
      hasSessionHeader: Boolean(header.provider || header.model),
      hasHostDefault: Boolean(selection.provider || selection.model),
      hasAdvertised: Boolean(advertised.provider || advertised.model),
    })
  }
  return composeRoute(override, header, selection, advertised)
}

/** Merge the independently-provided route fields with documented precedence. */
function composeRoute(override, header, selection, advertised) {
  const provider = override.provider || header.provider || selection.provider || advertised.provider || ''
  const model = override.model || header.model || selection.model || advertised.model || ''
  const reasoningEffort =
    override.reasoningEffort || header.reasoningEffort || selection.reasoningEffort || advertised.reasoningEffort || ''
  const maxTokens = override.maxTokens || header.maxTokens || selection.maxTokens || advertised.maxTokens || 0
  if (provider.length === 0 || model.length === 0) {
    throw new RouteUnavailable('no model route available for dreaming', { provider, model })
  }
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(maxTokens > 0 ? { maxTokens } : {}),
  }
}

/** Reject as soon as `signal` aborts; disposed by the caller in a `finally`. */
function abortWatcher(signal) {
  let listener = null
  const promise = new Promise((_resolve, rejectPromise) => {
    const onAbort = () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      error.cause = signal.reason
      rejectPromise(error)
    }
    listener = onAbort
    if (signal.aborted) onAbort()
    else signal.addEventListener?.('abort', onAbort, { once: true })
  })
  // The race below always consumes this promise; this keeps a late rejection handled.
  promise.catch(() => {})
  return {
    promise,
    dispose() {
      if (listener !== null) {
        try {
          signal.removeEventListener?.('abort', listener)
        } catch {
          // ignore
        }
        listener = null
      }
    },
  }
}

/**
 * Drain an async iterable of StreamChunks into text/usage/finish.
 * The iteration is raced against the abort signal so a non-cooperative adapter cannot keep
 * this call (and its queue slot) alive forever after cancellation or timeout.
 */
async function collectStream(iterable, { includeReasoning, signal }) {
  const iterator = iterable !== null && iterable !== undefined && typeof iterable[Symbol.asyncIterator] === 'function'
    ? iterable[Symbol.asyncIterator]()
    : { next: async () => ({ done: true }) }
  let text = ''
  let reasoning = ''
  let usage = { inputTokens: 0, outputTokens: 0 }
  let finish = null
  const ingest = (chunk) => {
    if (chunk === null || typeof chunk !== 'object') return
    switch (chunk.type) {
      case 'text-delta':
        if (typeof chunk.text === 'string') text += chunk.text
        break
      case 'reasoning-delta':
        if (includeReasoning && typeof chunk.text === 'string') reasoning += chunk.text
        break
      case 'usage':
        if (chunk.usage !== null && typeof chunk.usage === 'object') usage = normalizeUsage(chunk.usage)
        break
      case 'finish':
        finish = chunk.reason ?? { kind: 'stop' }
        if (chunk.usage !== null && typeof chunk.usage === 'object') usage = normalizeUsage(chunk.usage)
        break
      default:
        // Unknown chunk kinds are ignored on purpose: adapters may add new deltas.
        break
    }
  }
  const consume = (async () => {
    for (;;) {
      const step = await iterator.next()
      if (step === null || step === undefined || step.done === true) break
      ingest(step.value)
    }
    return { text, reasoning, usage, finish: finish ?? { kind: 'stop' } }
  })()
  if (signal === undefined || signal === null) return consume
  const watcher = abortWatcher(signal)
  try {
    return await Promise.race([consume, watcher.promise])
  } finally {
    watcher.dispose()
    if (signal.aborted && typeof iterator.return === 'function') {
      try {
        const closing = iterator.return()
        if (closing !== null && closing !== undefined && typeof closing.catch === 'function') closing.catch(() => {})
      } catch {
        // The adapter's cleanup is best effort.
      }
    }
  }
}

function normalizeUsage(usage) {
  return {
    inputTokens: Number.isFinite(usage.inputTokens) ? Math.max(0, Math.round(usage.inputTokens)) : 0,
    outputTokens: Number.isFinite(usage.outputTokens) ? Math.max(0, Math.round(usage.outputTokens)) : 0,
    ...(Number.isFinite(usage.cacheReadTokens) ? { cacheReadTokens: Math.max(0, Math.round(usage.cacheReadTokens)) } : {}),
  }
}

/** Character count of a prompt, for debug logging only (never the content). */
function promptChars(system, messages) {
  let total = typeof system === 'string' ? system.length : 0
  if (Array.isArray(messages)) {
    for (const message of messages) total += estimateMessageChars(message)
  }
  return total
}

function estimateMessageChars(message) {
  if (message === null || typeof message !== 'object') return 0
  const content = message.content
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (typeof block === 'string') total += block.length
    else if (typeof block?.text === 'string') total += block.text.length
  }
  return total
}

/** Build the terminal StreamError for an adapter `finish` chunk. */
function finishError(finish) {
  const failure = finish?.failure ?? null
  if (finish?.kind === 'aborted') {
    return new StreamError('llm stream aborted', {
      code: 'DREAMING_ABORTED',
      aborted: true,
      failure,
    })
  }
  const status = Number(failure?.status)
  const retryable =
    (Number.isFinite(status) && RETRYABLE_STATUS.has(status)) ||
    isRetryableError({ code: failure?.code, message: failure?.message ?? '' })
  return new StreamError(failure?.message ?? 'llm adapter reported an error finish', {
    code: typeof failure?.code === 'string' && failure.code.length > 0 ? failure.code : 'DREAMING_STREAM_ERROR',
    retryable,
    failure,
  })
}

function abortError(reason) {
  return new StreamError('llm call cancelled', {
    code: 'DREAMING_ABORTED',
    aborted: true,
    cause: reason instanceof Error ? reason : null,
  })
}

function timeoutError(timeoutMs) {
  return new StreamError(`llm call timed out after ${timeoutMs}ms`, {
    code: 'DREAMING_TIMEOUT',
    retryable: true,
    timeout: true,
  })
}

/** Re-classify any thrown value once, so retry logic sees one error vocabulary. */
function classifyError(error, { callerSignal, deadlineSignal, timeoutMs }) {
  if (error instanceof StreamError) return error
  if (isAbortError(error)) {
    if (callerSignal?.aborted) return abortError(callerSignal.reason)
    if (deadlineSignal?.aborted) return timeoutError(timeoutMs)
    return abortError(error)
  }
  if (callerSignal?.aborted) return abortError(callerSignal.reason)
  if (deadlineSignal?.aborted) return timeoutError(timeoutMs)
  return new StreamError(`llm stream failed: ${safeError(error).message}`, {
    code: 'DREAMING_STREAM_FAILED',
    retryable: isRetryableError(error),
    failure: error?.failure ?? null,
    cause: error,
  })
}

/** Abortable sleep used between the single retry attempt. */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      reject(abortError(signal?.reason))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * Run one bounded, low-temperature text completion through `ctx.llm.stream`.
 *
 * A `reasoningEffort` the exact model rejects is dropped once and the call is retried with the
 * inherited effort, so a config that lowers effort for latency never turns into a failed probe.
 *
 * @param {object} ctx Harness context (fake-friendly)
 * @param {object} options
 * @param {{provider: string, model: string, reasoningEffort?: string}} options.route resolved route
 * @param {string} [options.system] system prompt
 * @param {Array<object>} options.messages request messages (ContentBlock form)
 * @param {number} [options.temperature] sampler temperature
 * @param {number} [options.maxTokens] hard output cap
 * @param {number} [options.timeoutMs] total deadline per attempt
 * @param {AbortSignal} [options.signal] caller cancellation
 * @param {string} [options.purpose] label used only for logging (`probe`, `judge`, ...)
 * @param {object} [options.logger] logger override (defaults to `ctx.logger`)
 * @param {boolean} [options.includeReasoning] keep reasoning deltas in the result
 * @returns {Promise<{text: string, reasoning: string, usage: {inputTokens: number, outputTokens: number}, finish: object, finishKind: string, latencyMs: number, provider: string, model: string}>}
 * @throws {RouteUnavailable} when the route is incomplete
 * @throws {StreamError} on adapter failure, timeout or cancellation
 */
export async function streamText(ctx, options = {}) {
  const { route, system, messages, includeReasoning = false, purpose = 'llm' } = options
  const logger = options.logger ?? ctx?.logger
  const routeValue = normalizeRoute(route)
  if (routeValue.provider.length === 0 || routeValue.model.length === 0) {
    throw new RouteUnavailable('streamText requires a resolved provider and model')
  }
  if (ctx?.llm === null || ctx?.llm === undefined || typeof ctx.llm.stream !== 'function') {
    throw new RouteUnavailable('ctx.llm.stream is unavailable')
  }
  const temperature = Number.isFinite(options.temperature) ? options.temperature : undefined
  const maxTokens = Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? Math.round(options.maxTokens) : undefined
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const callerSignal = options.signal
  const chars = promptChars(system, messages)

  let lastError = null
  let activeRoute = routeValue
  let effortFallbackUsed = false
  let attempt = 0
  while (attempt < MAX_ATTEMPTS) {
    attempt += 1
    if (callerSignal?.aborted === true) throw abortError(callerSignal.reason)
    if (typeof ctx.llm.stream !== 'function') throw new RouteUnavailable('ctx.llm.stream is unavailable')
    const deadline = withTimeout(timeoutMs, callerSignal)
    const startedAt = Date.now()
    try {
      const iterable = ctx.llm.stream({
        provider: activeRoute.provider,
        model: activeRoute.model,
        ...(activeRoute.reasoningEffort ? { reasoningEffort: activeRoute.reasoningEffort } : {}),
        ...(system !== undefined ? { system } : {}),
        messages,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        signal: deadline.signal,
      })
      const stream = await collectStream(iterable, { includeReasoning, signal: deadline.signal })
      const latencyMs = Math.max(0, Date.now() - startedAt)
      const finishKind = typeof stream.finish?.kind === 'string' ? stream.finish.kind : 'stop'
      if (finishKind === 'error' || finishKind === 'aborted') throw finishError(stream.finish)
      const effortLabel = activeRoute.reasoningEffort ? ` effort=${activeRoute.reasoningEffort}` : ''
      logger?.debug?.(
        `dreaming: ${purpose} call ok ${activeRoute.provider}/${activeRoute.model}${effortLabel} ` +
          `in=${stream.usage.inputTokens} out=${stream.usage.outputTokens} ${latencyMs}ms promptChars=${chars}`,
      )
      return {
        text: stream.text,
        reasoning: stream.reasoning,
        usage: { inputTokens: stream.usage.inputTokens, outputTokens: stream.usage.outputTokens },
        finish: stream.finish,
        finishKind,
        latencyMs,
        provider: activeRoute.provider,
        model: activeRoute.model,
      }
    } catch (error) {
      lastError = classifyError(error, {
        callerSignal,
        deadlineSignal: deadline.signal,
        timeoutMs,
      })
      // A rejected effort is a route/capability mismatch, not a transport attempt: drop it and
      // try the inherited effort once. This keeps an auxiliary call alive on models that reason
      // less (or not at all) instead of turning a probe into "no annotation".
      if (!effortFallbackUsed && activeRoute.reasoningEffort && (isUnsupportedEffort(error) || isUnsupportedEffort(lastError))) {
        effortFallbackUsed = true
        const { reasoningEffort: _rejected, ...inheritedRoute } = activeRoute
        activeRoute = inheritedRoute
        attempt -= 1
        logger?.debug?.(
          `dreaming: ${purpose} route ${routeValue.provider}/${routeValue.model} rejected reasoningEffort ` +
            `"${routeValue.reasoningEffort}"; retrying with the inherited effort`,
        )
        continue
      }
      const retryable = lastError.retryable && !lastError.aborted && attempt < MAX_ATTEMPTS
      if (!retryable) {
        logger?.warn?.(
          `dreaming: ${purpose} call failed (${lastError.code}) after ${attempt} attempt(s): ${safeError(lastError).message}`,
        )
        throw lastError
      }
      logger?.debug?.(
        `dreaming: ${purpose} call failed (${lastError.code}); retrying once after ${RETRY_DELAY_MS}ms`,
      )
      await delay(RETRY_DELAY_MS, callerSignal)
    } finally {
      deadline.dispose()
    }
  }
  throw lastError ?? new StreamError('llm call failed', { code: 'DREAMING_STREAM_FAILED' })
}

/** Test/diagnostics hook: the module's retry budget. */
export const LLM_RETRY = Object.freeze({ maxAttempts: MAX_ATTEMPTS, retryDelayMs: RETRY_DELAY_MS, defaultTimeoutMs: DEFAULT_TIMEOUT_MS })
