/**
 * Tiny wrapper around the optional `subagents` service for auxiliary calls (probe/judge).
 * Any problem returns `null` so the caller can fall back to its inline path; the activation
 * and timeout are always disposed.
 */
import { estimateTokens, safeError, withTimeout } from './util.js'

/** Resolve an optional service by property or `ctx.get(name)`. */
export function optionalService(ctx, name) {
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

/** Extract text from a subagent activation result (`output` or `structured`). */
function extractOutputText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((block) => (typeof block === 'string' ? block : block?.text ?? '')).join('\n')
  if (value !== null && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (Array.isArray(value.content)) return extractOutputText(value.content)
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * Run one prompt as a caller-delivered subagent. Returns null on any problem.
 *
 * @param {object} options
 * @param {object} options.ctx Harness context
 * @param {string} [options.provider] `subagents.startActivation` provider id
 * @param {string} options.label activation label
 * @param {string} options.promptText flattened system + messages
 * @param {object} [options.parent] parent agent for the activation
 * @param {string} [options.cwd] working directory
 * @param {number} options.timeoutMs hard deadline
 * @param {AbortSignal} [options.signal] caller cancellation
 * @param {object} [options.logger] logger
 * @returns {Promise<{text: string, usage: {inputTokens: number, outputTokens: number}, latencyMs: number, provider: string, model: string, backend: string}|null>}
 */
export async function runSubagentText({
  ctx,
  provider,
  label,
  promptText,
  parent,
  cwd,
  timeoutMs,
  signal,
  logger,
} = {}) {
  if (typeof promptText !== 'string' || promptText.length === 0) return null
  const subagents = optionalService(ctx, 'subagents')
  if (subagents === null || typeof subagents.startActivation !== 'function') return null
  const deadline = withTimeout(Math.max(1000, Number(timeoutMs) || 40_000), signal)
  const startedAt = Date.now()
  let activation = null
  try {
    activation = await subagents.startActivation({
      ...(typeof provider === 'string' && provider.length > 0 ? { provider } : {}),
      label,
      request: {
        ...(parent !== null && parent !== undefined ? { parent } : {}),
        prompt: [{ type: 'text', text: promptText }],
        ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
      },
      signal: deadline.signal,
      delivery: 'caller',
    })
    if (activation === null || activation === undefined || typeof activation.result?.then !== 'function') return null
    const result = await raceAbort(activation.result, deadline.signal)
    const text = extractOutputText(result?.output ?? result?.structured)
    if (text.trim().length === 0) return null
    return {
      text,
      usage: {
        inputTokens: estimateTokens(promptText.length),
        outputTokens: estimateTokens(text.length),
      },
      latencyMs: Math.max(0, Date.now() - startedAt),
      provider: 'subagent',
      model: typeof provider === 'string' && provider.length > 0 ? provider : 'caller-delivery',
      backend: 'subagent',
    }
  } catch (error) {
    logger?.debug?.(`dreaming: subagent ${label ?? 'call'} unavailable (${safeError(error).message}); using inline`)
    return null
  } finally {
    try {
      await activation?.dispose?.()
    } catch {
      // disposal is best effort
    }
    deadline.dispose()
  }
}
