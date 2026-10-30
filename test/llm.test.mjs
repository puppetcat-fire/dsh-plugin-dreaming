/**
 * Unit tests for lib/llm.js — route resolution, chunk collection, retry and timeout.
 * Run directly: `node test/llm.test.mjs`
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LLM_RETRY,
  RouteUnavailable,
  StreamError,
  isRetryableError,
  normalizeRoute,
  resolveRoute,
  streamText,
} from '../lib/llm.js'

const silentLogger = () => {
  const lines = { debug: [], info: [], warn: [], error: [] }
  const push = (level) => (message) => lines[level].push(String(message))
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

/** Build an async iterable from a chunk array. */
function chunks(items) {
  return (async function* iterate() {
    for (const item of items) yield item
  })()
}

function reply(text, { inputTokens = 100, outputTokens = 25, finish = 'stop' } = {}) {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'usage', usage: { inputTokens, outputTokens } },
    { type: 'finish', reason: { kind: finish } },
  ]
}

function makeCtx({ handler, providers = [{ id: 'prov-1', name: 'Provider 1' }], models = { 'prov-1': [{ provider: 'prov-1', id: 'model-1', name: 'Model 1' }] }, defaultSelection, logger } = {}) {
  const calls = []
  const ctx = {
    logger: logger ?? silentLogger(),
    llm: {
      async listProviders() {
        return providers
      },
      async listModels(provider) {
        return models[provider] ?? []
      },
      stream(options) {
        calls.push(options)
        return handler(options, calls.length - 1)
      },
    },
    get(name) {
      if (name === 'agentDefaultModel' && defaultSelection !== undefined) {
        return { currentSelection: () => defaultSelection }
      }
      return undefined
    },
  }
  ctx.calls = calls
  return ctx
}

test('normalizeRoute trims and drops empty/invalid fields', () => {
  assert.deepEqual(normalizeRoute({ provider: ' p ', model: ' m ', reasoningEffort: ' low ', maxTokens: 0 }), {
    provider: 'p',
    model: 'm',
    reasoningEffort: 'low',
  })
  assert.deepEqual(normalizeRoute({ provider: '', model: '', maxTokens: -5 }), { provider: '', model: '' })
  assert.deepEqual(normalizeRoute(null), { provider: '', model: '' })
})

test('resolveRoute: complete plugin override wins without provider discovery', async () => {
  let listProvidersCalled = false
  const ctx = {
    logger: silentLogger(),
    llm: {
      listProviders() {
        listProvidersCalled = true
        return []
      },
    },
    get: () => undefined,
  }
  const route = await resolveRoute(ctx, undefined, { provider: 'cfg-p', model: 'cfg-m', reasoningEffort: 'high', maxTokens: 512 })
  assert.deepEqual(route, { provider: 'cfg-p', model: 'cfg-m', reasoningEffort: 'high', maxTokens: 512 })
  assert.equal(listProvidersCalled, false)
})

test('resolveRoute: session request header beats host default', async () => {
  const ctx = { logger: silentLogger(), get: () => undefined, llm: { listProviders: () => [] } }
  const session = { requestHeader: () => ({ config: { provider: 'sess-p', model: 'sess-m', maxTokens: 256 } }) }
  const route = await resolveRoute(ctx, session, { provider: '', model: '' })
  assert.deepEqual(route, { provider: 'sess-p', model: 'sess-m', maxTokens: 256 })
})

test('resolveRoute: host default selection is used when the session has no header', async () => {
  const ctx = makeCtx({ defaultSelection: { provider: 'host-p', model: 'host-m', reasoningEffort: 'medium' } })
  const route = await resolveRoute(ctx, { requestHeader: () => undefined }, {})
  assert.equal(route.provider, 'host-p')
  assert.equal(route.model, 'host-m')
  assert.equal(route.reasoningEffort, 'medium')
})

test('resolveRoute: falls back to the first advertised provider/model', async () => {
  const ctx = makeCtx({ providers: [{ id: 'p-a' }, { id: 'p-b' }], models: { 'p-a': [], 'p-b': [{ id: 'm-b' }] } })
  const route = await resolveRoute(ctx, undefined, {})
  assert.deepEqual(route, { provider: 'p-b', model: 'm-b' })
})

test('resolveRoute: throws a typed RouteUnavailable when nothing resolves', async () => {
  const ctx = makeCtx({ providers: [], models: {} })
  await assert.rejects(() => resolveRoute(ctx, undefined, {}), (error) => {
    assert.ok(error instanceof RouteUnavailable)
    assert.equal(error.code, 'DREAMING_ROUTE_UNAVAILABLE')
    return true
  })
})

test('streamText: collects text, usage, finish, latency and passes a sane request', async () => {
  const logger = silentLogger()
  const ctx = makeCtx({ logger, handler: () => chunks(reply('hello world')) })
  const result = await streamText(ctx, {
    route: { provider: 'prov-1', model: 'model-1', reasoningEffort: 'low' },
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    temperature: 0.2,
    maxTokens: 700,
    timeoutMs: 2000,
    purpose: 'probe',
    logger,
  })
  assert.equal(result.text, 'hello world')
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 25 })
  assert.equal(result.finishKind, 'stop')
  assert.equal(result.provider, 'prov-1')
  assert.equal(result.model, 'model-1')
  assert.ok(result.latencyMs >= 0)
  const sent = ctx.calls[0]
  assert.equal(sent.provider, 'prov-1')
  assert.equal(sent.model, 'model-1')
  assert.equal(sent.reasoningEffort, 'low')
  assert.equal(sent.system, 'sys')
  assert.equal(sent.temperature, 0.2)
  assert.equal(sent.maxTokens, 700)
  assert.ok(sent.signal instanceof AbortSignal)
  assert.equal('purpose' in sent, false, 'purpose is a logging label, not a GenerateOptions field')
  // Never logs the prompt body above debug; the debug line may include sizes only.
  assert.ok(logger.lines.warn.length === 0)
  assert.ok(logger.lines.debug.every((line) => !line.includes('hi') || line.includes('promptChars')))
})

test('streamText: reasoning deltas are ignored unless requested', async () => {
  const handler = () =>
    chunks([
      { type: 'reasoning-delta', index: 0, text: 'thinking…' },
      { type: 'text-delta', index: 1, text: 'answer' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  const plain = await streamText(makeCtx({ handler }), { route: { provider: 'p', model: 'm' }, messages: [], timeoutMs: 1000 })
  assert.equal(plain.text, 'answer')
  assert.equal(plain.reasoning, '')
  const withReasoning = await streamText(makeCtx({ handler }), {
    route: { provider: 'p', model: 'm' },
    messages: [],
    includeReasoning: true,
    timeoutMs: 1000,
  })
  assert.equal(withReasoning.reasoning, 'thinking…')
})

test('streamText: retries once on a retryable transport error', async () => {
  let attempts = 0
  const ctx = makeCtx({
    handler: () => {
      attempts += 1
      if (attempts === 1) {
        const error = new Error('socket hang up')
        error.code = 'ECONNRESET'
        throw error
      }
      return chunks(reply('second try'))
    },
  })
  const result = await streamText(ctx, { route: { provider: 'p', model: 'm' }, messages: [], timeoutMs: 1000 })
  assert.equal(result.text, 'second try')
  assert.equal(attempts, 2)
  assert.equal(LLM_RETRY.maxAttempts, 2)
})

test('streamText: drops an effort the model rejects and retries with the inherited effort', async () => {
  let attempts = 0
  const ctx = makeCtx({
    handler: (options) => {
      attempts += 1
      if (options.reasoningEffort !== undefined) {
        return chunks([
          { type: 'finish', reason: { kind: 'error', failure: { message: 'unsupported effort', code: 'UNSUPPORTED_REASONING_EFFORT' } } },
        ])
      }
      return chunks(reply('inherited reply'))
    },
  })
  const result = await streamText(ctx, {
    route: { provider: 'p', model: 'm', reasoningEffort: 'low' },
    messages: [],
    timeoutMs: 1000,
  })
  assert.equal(result.text, 'inherited reply')
  assert.equal(attempts, 2)
  assert.equal(ctx.calls[0].reasoningEffort, 'low')
  assert.equal('reasoningEffort' in ctx.calls[1], false, 'the fallback request must inherit')
  assert.equal(LLM_RETRY.maxAttempts, 2, 'the effort fallback does not consume the transport budget')
})

test('streamText: a thrown unsupported-effort error also falls back once', async () => {
  let attempts = 0
  const ctx = makeCtx({
    handler: (options) => {
      attempts += 1
      if (options.reasoningEffort !== undefined) {
        const error = new Error('DeepSeek Messages does not support reasoning effort medium')
        error.code = 'UNSUPPORTED_REASONING_EFFORT'
        throw error
      }
      return chunks(reply('ok'))
    },
  })
  const result = await streamText(ctx, {
    route: { provider: 'p', model: 'm', reasoningEffort: 'medium' },
    messages: [],
    timeoutMs: 1000,
  })
  assert.equal(result.text, 'ok')
  assert.equal(attempts, 2)
  assert.equal('reasoningEffort' in ctx.calls[1], false)
  assert.equal(ctx.calls.length, 2)
})

test('streamText: does not retry a non-retryable failure', async () => {
  let attempts = 0
  const ctx = makeCtx({
    handler: () => {
      attempts += 1
      const error = new Error('bad request')
      error.code = 'LLM_INVALID_REQUEST'
      throw error
    },
  })
  await assert.rejects(
    () => streamText(ctx, { route: { provider: 'p', model: 'm' }, messages: [], timeoutMs: 1000 }),
    (error) => {
      assert.ok(error instanceof StreamError)
      assert.equal(error.retryable, false)
      return true
    },
  )
  assert.equal(attempts, 1)
})

test('streamText: maps an adapter error finish to a StreamError', async () => {
  let attempts = 0
  const ctx = makeCtx({
    handler: () => {
      attempts += 1
      return chunks([{ type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 } } }])
    },
  })
  await assert.rejects(
    () => streamText(ctx, { route: { provider: 'p', model: 'm' }, messages: [], timeoutMs: 1000 }),
    (error) => {
      assert.ok(error instanceof StreamError)
      assert.equal(error.code, 'RATE_LIMIT')
      assert.equal(error.retryable, true)
      return true
    },
  )
  assert.equal(attempts, 2, 'retryable adapter errors are retried once')
})

test('streamText: caller cancellation is never retried', async () => {
  let attempts = 0
  const controller = new AbortController()
  const ctx = makeCtx({
    handler: (options) => {
      attempts += 1
      return (async function* iterate() {
        if (options.signal.aborted) {
          const error = new Error('aborted')
          error.name = 'AbortError'
          throw error
        }
        await new Promise((resolvePromise) => {
          options.signal.addEventListener('abort', resolvePromise, { once: true })
        })
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      })()
    },
  })
  setTimeout(() => controller.abort(new Error('user cancel')), 10)
  await assert.rejects(
    () => streamText(ctx, { route: { provider: 'p', model: 'm' }, messages: [], timeoutMs: 5000, signal: controller.signal }),
    (error) => {
      assert.ok(error instanceof StreamError)
      assert.equal(error.aborted, true)
      assert.equal(error.retryable, false)
      return true
    },
  )
  assert.equal(attempts, 1)
})

test('streamText: enforces the timeout, retries it once, and disposes the timer', async () => {
  let attempts = 0
  const ctx = makeCtx({
    handler: (options) => {
      attempts += 1
      return (async function* iterate() {
        await new Promise((resolvePromise, rejectPromise) => {
          const onAbort = () => {
            options.signal.removeEventListener('abort', onAbort)
            const error = new Error('aborted')
            error.name = 'AbortError'
            rejectPromise(error)
          }
          options.signal.addEventListener('abort', onAbort, { once: true })
          const timer = setTimeout(resolvePromise, 5000)
          if (typeof timer.unref === 'function') timer.unref()
        })
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  })
  const startedAt = Date.now()
  await assert.rejects(
    () => streamText(ctx, { route: { provider: 'p', model: 'm' }, messages: [], timeoutMs: 40 }),
    (error) => {
      assert.ok(error instanceof StreamError)
      assert.equal(error.code, 'DREAMING_TIMEOUT')
      assert.equal(error.timeout, true)
      return true
    },
  )
  const elapsed = Date.now() - startedAt
  assert.equal(attempts, 2)
  assert.ok(elapsed < 2000, `timeout should be enforced quickly, took ${elapsed}ms`)
})

test('streamText: rejects a missing/unknown route before touching the adapter', async () => {
  const ctx = makeCtx({ handler: () => chunks(reply('unused')) })
  await assert.rejects(() => streamText(ctx, { route: {}, messages: [] }), (error) => error instanceof RouteUnavailable)
  assert.equal(ctx.calls.length, 0)
})

test('streamText: missing finish chunk is tolerated as stop', async () => {
  const ctx = makeCtx({ handler: () => chunks([{ type: 'text-delta', index: 0, text: 'partial' }]) })
  const result = await streamText(ctx, { route: { provider: 'p', model: 'm' }, messages: [], timeoutMs: 1000 })
  assert.equal(result.text, 'partial')
  assert.equal(result.finishKind, 'stop')
})

test('streamText: settles even when the adapter ignores the abort signal', async () => {
  let attempts = 0
  const ctx = makeCtx({
    handler: () => {
      attempts += 1
      return (async function* iterate() {
        await new Promise(() => {})
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  })
  const startedAt = Date.now()
  await assert.rejects(
    () => streamText(ctx, { route: { provider: 'p', model: 'm' }, messages: [], timeoutMs: 40 }),
    (error) => {
      assert.ok(error instanceof StreamError)
      assert.equal(error.code, 'DREAMING_TIMEOUT')
      return true
    },
  )
  assert.equal(attempts, 2)
  assert.ok(Date.now() - startedAt < 2000, 'abort/timeout must not wait for a cooperative adapter')
})

test('isRetryableError classifies common transport failures', () => {
  assert.equal(isRetryableError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true)
  assert.equal(isRetryableError(Object.assign(new Error('x'), { status: 503 })), true)
  assert.equal(isRetryableError(new Error('rate limited, retry later')), true)
  assert.equal(isRetryableError(Object.assign(new Error('bad'), { name: 'AbortError' })), false)
  assert.equal(isRetryableError(Object.assign(new Error('x'), { code: 'LLM_INVALID_REQUEST' })), false)
  assert.equal(isRetryableError(null), false)
})
