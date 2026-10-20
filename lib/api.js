/**
 * HTTP dashboard API for the Dreaming plugin.
 *
 * Owns exactly one `node:http` route on the Harness web server:
 * `{ kind: 'prefix', path: '/dreaming/api' }`. Every response is JSON with
 * `Cache-Control: no-store`; mutations are `POST` only and carry an Origin check
 * because the built-in web server has no session CSRF token of its own.
 *
 * Design rules (ARCHITECTURE.md §6 api):
 * - read-only views project the durable store; they never mutate it and never
 *   expose raw model traces or file contents (fields are capped and truncated);
 * - the two mutations delegate to the same code path the dream engine uses:
 *   `POST dream/run` calls `dreamEngine.run(...)` and `POST edits/revert` calls a
 *   host-provided revert callback (or `dreamEngine.revertEdit`). This module
 *   never edits skill files itself;
 * - every handler is wrapped so a bug can never throw into the HTTP layer: the
 *   failure becomes `500 { ok:false, error }` and is logged at `warn`;
 * - request bodies are capped at 64 KiB before buffering, and JSON responses are
 *   bounded projections, not dumps of the underlying records.
 *
 * @module dreaming/lib/api
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { VERDICTS } from './constants.js'
import { computeOverall } from './stats.js'
import { asInt, oneLine, safeError, truncate } from './util.js'

/** Route prefix owned by this plugin. Must match the client's API base. */
const PREFIX = '/dreaming/api'

/** Hard request-body cap: the dashboard only posts small JSON objects. */
const BODY_LIMIT = 64 * 1024

/** Route tables: the allowlist is explicit so unknown paths 404 and methods 405. */
const GET_ROUTES = new Set(['summary', 'episodes', 'dreams', 'edits', 'health'])
const POST_ROUTES = new Set(['dream/run', 'edits/revert'])

/** Projection limits. Kept local: the API is the only consumer. */
const CAPS = {
  skills: 200,
  episodeLimit: 100,
  episodeDefault: 20,
  episodeOffset: 5000,
  dreamLimit: 50,
  dreamDefault: 20,
  editLimit: 200,
  editDefault: 100,
  idChars: 120,
  nameChars: 128,
  descriptionChars: 240,
  sentenceChars: 200,
  briefChars: 120,
  listItems: 4,
  traceToolItems: 12,
  traceAssistantItems: 3,
  traceUserItems: 3,
  mismatchItems: 3,
  dreamSkills: 20,
  dreamEditIds: 10,
  dreamCaseIds: 20,
}

const noop = () => {}
const noopLogger = { info: noop, warn: noop, error: noop, debug: noop }

/**
 * Error carrying the HTTP status this API should answer with.
 * Internal: thrown inside a handler and converted to a JSON body by `runRoute`.
 */
class ApiError extends Error {
  /**
   * @param {number} status HTTP status code.
   * @param {string} code stable machine-readable error code.
   * @param {string} [message] short human-readable diagnostic (never a stack).
   */
  constructor(status, code, message) {
    super(message || code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

// ---------------------------------------------------------------------------------------------
// public entry
// ---------------------------------------------------------------------------------------------

/**
 * Register the dashboard HTTP API.
 *
 * @param {object} options
 * @param {object} options.ctx Cordis plugin context; `ctx.webServer` must provide
 *   `register()`/`getOrigin()` (index.js calls this inside `ctx.inject(['webServer'])`).
 * @param {object} [options.config] normalized plugin config (`normalizeConfig().config`).
 * @param {object} options.store `DreamStore` instance (read-only except via callbacks).
 * @param {object} [options.dreamEngine] object with `isRunning()` and `run({trigger})`;
 *   optionally `revertEdit(editId, { reason })`.
 * @param {object} [options.tracker] `EpisodeTracker`; only `openCount()`/`openEpisodes` is read.
 * @param {object} [options.guidance] accepted for wiring symmetry; not read by the API.
 * @param {object} [options.logger] Cordis-compatible logger (`warn` is used).
 * @param {() => number} [options.now] clock, injectable for tests.
 * @param {(editId: string, opts: object) => Promise<{ok: boolean, reason?: string, edit?: object}>} [options.revertEdit]
 *   host-provided revert path (same as the dream engine's). Preferred over
 *   `dreamEngine.revertEdit` because the Lead owns the wiring and can import
 *   `dream.js`/`skill-edits.js` lazily.
 * @returns {() => void} disposer removing the route and rejecting later requests.
 */
export function installApi(options = {}) {
  const {
    ctx,
    config = {},
    store,
    dreamEngine,
    tracker,
    guidance, // eslint-disable-line no-unused-vars -- documented wiring slot
    logger = noopLogger,
    now = Date.now,
    revertEdit,
  } = options

  const log = normalizeLogger(logger)
  const deps = {
    ctx,
    config: config !== null && typeof config === 'object' ? config : {},
    store,
    dreamEngine,
    tracker,
    logger: log,
    now: typeof now === 'function' ? now : Date.now,
    revert: resolveRevert(revertEdit, dreamEngine, log),
    runDream: resolveRunDream(dreamEngine),
    isDreamRunning: resolveIsRunning(dreamEngine),
    state: { disposed: false, lastError: null },
  }

  if (ctx === null || typeof ctx !== 'object' || ctx.webServer === undefined || ctx.webServer === null
    || typeof ctx.webServer.register !== 'function') {
    log.warn?.('dreaming: api not registered because ctx.webServer is unavailable')
    return noop
  }

  const handler = (req, res) => {
    // Belt and braces: `runRoute` already contains every failure, but the route
    // callback itself must never return a rejected promise to the HTTP server.
    return runRoute(deps, req, res).catch((error) => {
      try {
        deps.state.lastError = safeError(error)
        log.warn?.(`dreaming: api handler escaped: ${deps.state.lastError.message}`)
        fail(res, 500, 'internal_error')
      } catch {
        // Nothing left to do: the response object itself is unusable.
      }
    })
  }

  let disposeRoute
  try {
    disposeRoute = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })
  } catch (error) {
    log.warn?.(`dreaming: failed to register the dashboard API route: ${safeError(error).message}`)
    return noop
  }

  return function dispose() {
    if (deps.state.disposed) return
    deps.state.disposed = true
    try {
      if (typeof disposeRoute === 'function') disposeRoute()
    } catch (error) {
      log.debug?.(`dreaming: api route disposer failed: ${safeError(error).message}`)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

/**
 * One request: validate method, route and origin, then dispatch.
 * @param {object} deps resolved dependencies.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {import('node:http').ServerResponse} res response.
 * @returns {Promise<void>} always settles.
 */
async function runRoute(deps, req, res) {
  try {
    if (deps.state.disposed) {
      fail(res, 503, 'api_disposed')
      return
    }

    const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
    if (method !== 'GET' && method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      fail(res, 405, 'method_not_allowed')
      return
    }

    const url = parseUrl(req.url)
    if (url === null) {
      fail(res, 404, 'not_found')
      return
    }
    const raw = url.pathname.slice(PREFIX.length)
    let route
    try {
      route = decodeURIComponent(raw).replace(/^\/+|\/+$/g, '')
    } catch {
      fail(res, 404, 'not_found')
      return
    }

    const knownGet = GET_ROUTES.has(route)
    const knownPost = POST_ROUTES.has(route)
    if (!knownGet && !knownPost) {
      fail(res, 404, 'not_found')
      return
    }
    if (method === 'GET' && !knownGet) {
      res.setHeader('Allow', 'POST')
      fail(res, 405, 'method_not_allowed')
      return
    }
    if (method === 'POST' && !knownPost) {
      res.setHeader('Allow', 'GET')
      fail(res, 405, 'method_not_allowed')
      return
    }

    if (method === 'POST') {
      // CSRF guard: the web server is same-origin, so an absent Origin means a
      // non-browser client (allowed); a present Origin must be this server.
      if (!isAllowedOrigin(deps, req)) {
        drain(req)
        fail(res, 403, 'forbidden_origin')
        return
      }
      let body
      try {
        body = await readJsonBody(req, BODY_LIMIT)
      } catch (error) {
        if (error instanceof ApiError) {
          fail(res, error.status, error.code)
          return
        }
        throw error
      }
      await dispatchPost(deps, route, body, res)
      return
    }

    await dispatchGet(deps, route, url, res)
  } catch (error) {
    if (error instanceof ApiError) {
      fail(res, error.status, error.code)
      return
    }
    deps.state.lastError = safeError(error)
    deps.logger.warn?.(`dreaming: api ${String(req?.method || 'GET')} ${String(req?.url || '')} failed: ${deps.state.lastError.message}`)
    fail(res, 500, 'internal_error')
  }
}

/**
 * Dispatch a GET route and answer with its JSON projection.
 * @param {object} deps resolved dependencies.
 * @param {string} route matched route name.
 * @param {URL} url parsed request URL.
 * @param {import('node:http').ServerResponse} res response.
 */
async function dispatchGet(deps, route, url, res) {
  switch (route) {
    case 'summary':
      sendJson(res, 200, buildSummary(deps))
      return
    case 'episodes':
      sendJson(res, 200, buildEpisodes(deps, url.searchParams))
      return
    case 'dreams':
      sendJson(res, 200, buildDreams(deps, url.searchParams))
      return
    case 'edits':
      sendJson(res, 200, buildEdits(deps, url.searchParams))
      return
    case 'health':
      sendJson(res, 200, buildHealth(deps))
      return
    default:
      throw new ApiError(404, 'not_found')
  }
}

/**
 * Dispatch a POST route. The body is already parsed and bounded.
 * @param {object} deps resolved dependencies.
 * @param {string} route matched route name.
 * @param {object} body parsed JSON object (never an array).
 * @param {import('node:http').ServerResponse} res response.
 */
async function dispatchPost(deps, route, body, res) {
  if (route === 'dream/run') {
    const running = deps.isDreamRunning()
    if (running) {
      throw new ApiError(409, 'dream_running')
    }
    if (deps.runDream === null) {
      throw new ApiError(503, 'dream_unavailable')
    }
    let outcome
    try {
      outcome = deps.runDream({ trigger: 'manual', source: 'api' })
    } catch (error) {
      deps.state.lastError = safeError(error)
      deps.logger.warn?.(`dreaming: manual dream failed to start: ${deps.state.lastError.message}`)
      throw new ApiError(500, 'dream_start_failed')
    }
    let runId = readRunId(outcome)
    if (isThenable(outcome)) {
      // The engine runs in the background; observe rejection so it can never
      // become an unhandled rejection, but do not make the user wait.
      Promise.resolve(outcome)
        .then((value) => {
          if (runId === null) runId = readRunId(value)
        })
        .catch((error) => {
          deps.state.lastError = safeError(error)
          deps.logger.warn?.(`dreaming: manual dream run failed: ${deps.state.lastError.message}`)
        })
    }
    sendJson(res, 200, { ok: true, accepted: true, runId })
    return
  }

  if (route === 'edits/revert') {
    const editId = typeof body?.editId === 'string' ? body.editId.trim() : ''
    if (editId.length === 0 || editId.length > CAPS.idChars) {
      throw new ApiError(400, 'invalid_edit_id')
    }
    if (deps.revert === null) {
      throw new ApiError(503, 'revert_unavailable')
    }
    if (typeof deps.store?.getEdit === 'function' && deps.store.getEdit(editId) === undefined) {
      throw new ApiError(404, 'edit_not_found')
    }
    let result
    try {
      result = await deps.revert(editId, { reason: 'user requested from dashboard' })
    } catch (error) {
      deps.state.lastError = safeError(error)
      deps.logger.warn?.(`dreaming: revert ${editId} failed: ${deps.state.lastError.message}`)
      throw new ApiError(500, 'revert_failed')
    }
    if (result === null || typeof result !== 'object') {
      throw new ApiError(500, 'revert_failed')
    }
    sendJson(res, 200, {
      ok: result.ok === true,
      reason: typeof result.reason === 'string' ? oneLine(result.reason, 200) : null,
      edit: compactEdit(result.edit ?? deps.store?.getEdit?.(editId), deps.store),
    })
    return
  }

  throw new ApiError(404, 'not_found')
}

// ---------------------------------------------------------------------------------------------
// GET projections
// ---------------------------------------------------------------------------------------------

/**
 * `GET summary`: overall metrics, compact skill rows, dream schedule, sanitized
 * config, store health and the generated timestamp.
 * @param {object} deps resolved dependencies.
 * @returns {object} JSON payload.
 */
function buildSummary(deps) {
  const state = deps.store?.state
  const storeHealth = safeStoreHealth(deps.store)
  const overall = computeOverall(state)
  const rows = compactSkills(state)
  return {
    ok: true,
    generatedAt: isoOrNull(deps.now()),
    overall: overall ?? {},
    skills: rows,
    dream: compactDreamState(state, deps.config, deps),
    config: sanitizeConfig(deps.config),
    store: storeHealth,
    dataDir: storeHealth.dir,
  }
}

/**
 * `GET episodes`: newest-first compact projections. Supports `skill`, `limit`,
 * `offset`, `verdict` and `filter=mismatch`.
 * @param {object} deps resolved dependencies.
 * @param {URLSearchParams} params query parameters.
 * @returns {object} JSON payload.
 */
function buildEpisodes(deps, params) {
  const limit = queryInt(params, 'limit', 1, CAPS.episodeLimit, CAPS.episodeDefault)
  const offset = queryInt(params, 'offset', 0, CAPS.episodeOffset, 0)
  const skill = cleanSkillName(params.get('skill'))
  const verdict = VERDICTS.includes(params.get('verdict')) ? params.get('verdict') : undefined
  const mismatchedOnly = params.get('filter') === 'mismatch' || params.get('mismatched') === '1'
  const rows = typeof deps.store?.recentEpisodes === 'function'
    ? deps.store.recentEpisodes({ limit: limit + offset, skill, verdict, mismatchedOnly })
    : []
  const list = Array.isArray(rows) ? rows : []
  const page = list.slice(offset, offset + limit).map(compactEpisode)
  return {
    ok: true,
    generatedAt: isoOrNull(deps.now()),
    items: page,
    offset,
    limit,
    hasMore: list.length > offset + limit,
    filter: { skill: skill ?? null, verdict: verdict ?? null, mismatchedOnly },
  }
}

/**
 * `GET dreams`: the dream journal, newest first.
 * @param {object} deps resolved dependencies.
 * @param {URLSearchParams} params query parameters.
 * @returns {object} JSON payload.
 */
function buildDreams(deps, params) {
  const limit = queryInt(params, 'limit', 1, CAPS.dreamLimit, CAPS.dreamDefault)
  const rows = typeof deps.store?.recentDreams === 'function' ? deps.store.recentDreams(limit) : []
  const list = Array.isArray(rows) ? rows : []
  return {
    ok: true,
    generatedAt: isoOrNull(deps.now()),
    items: list.slice(0, limit).map(compactDream),
  }
}

/**
 * `GET edits`: the reversible edit journal with backup availability (never file contents).
 * @param {object} deps resolved dependencies.
 * @param {URLSearchParams} params query parameters.
 * @returns {object} JSON payload.
 */
function buildEdits(deps, params) {
  const limit = queryInt(params, 'limit', 1, CAPS.editLimit, CAPS.editDefault)
  const skill = cleanSkillName(params.get('skill'))
  const rows = typeof deps.store?.recentEdits === 'function'
    ? deps.store.recentEdits(limit, { skill })
    : []
  const list = Array.isArray(rows) ? rows : []
  return {
    ok: true,
    generatedAt: isoOrNull(deps.now()),
    items: list.slice(0, limit).map((edit) => compactEdit(edit, deps.store)),
  }
}

/**
 * `GET health`: liveness plus store/scheduler/tracker diagnostics.
 * @param {object} deps resolved dependencies.
 * @returns {object} JSON payload.
 */
function buildHealth(deps) {
  const health = safeStoreHealth(deps.store)
  return {
    ok: true,
    generatedAt: isoOrNull(deps.now()),
    storeReady: health.ready === true,
    nextRunAt: finiteNumber(deps.store?.state?.dream?.nextRunAt),
    openEpisodes: openEpisodeCount(deps.tracker),
    dreamRunning: deps.isDreamRunning(),
    lastError: deps.state.lastError ?? health.error ?? null,
    dataDir: health.dir ?? null,
    revision: finiteNumber(health.revision),
  }
}

/**
 * Compact one durable skill belief into a table row.
 * @param {object|null|undefined} state durable state document.
 * @returns {object[]} rows, newest-used first, capped.
 */
function compactSkills(state) {
  const skills = state !== null && typeof state === 'object' && state.skills !== null
    && typeof state.skills === 'object' ? Object.values(state.skills) : []
  return skills
    .filter((skill) => skill !== null && typeof skill === 'object')
    .sort((a, b) => finiteNumber(b.lastUsedAt) - finiteNumber(a.lastUsedAt))
    .slice(0, CAPS.skills)
    .map((skill) => {
      const metrics = skill.metrics !== null && typeof skill.metrics === 'object' ? skill.metrics : {}
      const counts = skill.counts !== null && typeof skill.counts === 'object' ? skill.counts : {}
      const cost = skill.cost !== null && typeof skill.cost === 'object' ? skill.cost : {}
      return {
        name: shortString(skill.name, CAPS.nameChars),
        source: shortString(skill.source, 40),
        editable: skill.editable === true,
        loads: finiteNumber(counts.loads),
        judged: finiteNumber(counts.judged),
        matched: finiteNumber(counts.matched),
        partial: finiteNumber(counts.partial),
        missed: finiteNumber(counts.missed),
        misapplied: finiteNumber(counts.misapplied),
        consciousness: finiteNumber(metrics.consciousness),
        fitAccuracy: finiteRatio(metrics.fitAccuracy),
        boundaryAccuracy: finiteRatio(metrics.boundaryAccuracy),
        precision: finiteRatio(metrics.precision),
        wasteRate: finiteRatio(metrics.wasteRate),
        trend: finiteNumber(metrics.trend),
        confidence: shortString(metrics.confidence, 10) || 'low',
        meanScore: finiteNumber(metrics.meanScore),
        lastUsedAt: finiteNumber(skill.lastUsedAt),
        appliedEdits: Array.isArray(skill.appliedEdits) ? skill.appliedEdits.length : 0,
        wastedTokens: Math.round(finiteNumber(cost.wasted)),
      }
    })
}

/**
 * Compact one episode: prediction, capped trace and judge, never the raw record.
 * @param {object} episode durable episode snapshot.
 * @returns {object} projection.
 */
function compactEpisode(episode) {
  const value = episode !== null && typeof episode === 'object' ? episode : {}
  const prediction = value.prediction !== null && typeof value.prediction === 'object' ? value.prediction : null
  const trace = value.trace !== null && typeof value.trace === 'object' ? value.trace : null
  const judge = value.judge !== null && typeof value.judge === 'object' ? value.judge : null
  const call = value.call !== null && typeof value.call === 'object' ? value.call : {}
  const skillMeta = value.skillMeta !== null && typeof value.skillMeta === 'object' ? value.skillMeta : {}
  const cost = value.cost !== null && typeof value.cost === 'object' ? value.cost : {}
  const flags = value.flags !== null && typeof value.flags === 'object' ? value.flags : {}
  return {
    id: shortString(value.id, CAPS.idChars),
    skill: shortString(value.skill, CAPS.nameChars),
    startedAt: finiteNumber(value.startedAt),
    endedAt: finiteNumber(value.endedAt),
    state: shortString(value.state, 16),
    turn: finiteNumber(value.turn),
    step: finiteNumber(value.step),
    skillMeta: {
      description: shortString(skillMeta.description, CAPS.descriptionChars),
      source: shortString(skillMeta.source, 40),
      bodyChars: finiteNumber(skillMeta.bodyChars),
      bodyTokens: finiteNumber(skillMeta.bodyTokens),
    },
    prediction: prediction === null ? null : {
      fit: finiteRatio(prediction.fit),
      confidence: finiteRatio(prediction.confidence),
      intent: shortString(prediction.intent, CAPS.sentenceChars),
      expectedUse: shortList(prediction.expectedUse, CAPS.listItems, CAPS.sentenceChars),
      likelyPitfalls: shortList(prediction.likelyPitfalls, CAPS.listItems, CAPS.sentenceChars),
      capabilityGap: shortString(prediction.capabilityGap, CAPS.sentenceChars),
      cheaperAlternative: shortString(prediction.cheaperAlternative, CAPS.sentenceChars),
      expectedValueTokens: finiteNumber(prediction.expectedValueTokens),
    },
    probe: compactProbe(value.probe),
    call: {
      isError: call.isError === true,
      durationMs: finiteNumber(call.durationMs),
      contentChars: finiteNumber(call.contentChars),
    },
    trace: trace === null ? null : {
      observedMs: finiteNumber(trace.observedMs),
      turnEnd: shortString(trace.turnEnd, 24),
      assistantTexts: shortList(trace.assistantTexts, CAPS.traceAssistantItems, 300),
      userMessages: shortList(trace.userMessages, CAPS.traceUserItems, 240),
      toolSequence: compactToolSequence(trace.toolSequence),
      skillReLoaded: trace.skillReLoaded === true,
      finalAnswerChars: finiteNumber(trace.finalAnswerChars),
    },
    judge: compactJudge(judge),
    cost: {
      probe: finiteNumber(cost.probe),
      judge: finiteNumber(cost.judge),
      skillLoad: finiteNumber(cost.skillLoad),
      reworkEstimate: finiteNumber(cost.reworkEstimate),
      wastedEstimate: finiteNumber(cost.wastedEstimate),
    },
    flags: {
      sampled: flags.sampled === true,
      truncated: flags.truncated === true,
      abandoned: flags.abandoned === true,
      dreamIds: shortList(flags.dreamIds, 10, CAPS.idChars),
    },
  }
}

/**
 * Compact one probe record (status and cost only, never prompt content).
 * @param {object|null|undefined} probe stored probe record.
 * @returns {object|null} projection.
 */
function compactProbe(probe) {
  if (probe === null || typeof probe !== 'object') return null
  return {
    backend: shortString(probe.backend, 16),
    model: shortString(probe.model, 120),
    status: shortString(probe.status, 24),
    tokensIn: finiteNumber(probe.tokensIn),
    tokensOut: finiteNumber(probe.tokensOut),
    latencyMs: finiteNumber(probe.latencyMs),
    error: probe.error === null || probe.error === undefined ? null : shortString(probe.error, 200),
  }
}

/**
 * Compact one judge record: verdict, gap and bounded findings.
 * @param {object|null} judge stored judge record.
 * @returns {object|null} projection.
 */
function compactJudge(judge) {
  if (judge === null || typeof judge !== 'object') return null
  const gap = judge.capabilityGap !== null && typeof judge.capabilityGap === 'object' ? judge.capabilityGap : null
  const recommendation = judge.recommendation !== null && typeof judge.recommendation === 'object'
    ? judge.recommendation : null
  return {
    status: shortString(judge.status, 24),
    model: shortString(judge.model, 120),
    score: finiteNumber(judge.score),
    verdict: shortString(judge.verdict, 16),
    predictionAccuracy: finiteRatio(judge.predictionAccuracy),
    capabilityGap: gap === null ? null : {
      present: gap.present === true,
      claim: shortString(gap.claim, CAPS.sentenceChars),
      reality: shortString(gap.reality, CAPS.sentenceChars),
    },
    mismatches: Array.isArray(judge.mismatches)
      ? judge.mismatches.slice(0, CAPS.mismatchItems).map((mismatch) => ({
        expected: shortString(mismatch?.expected, CAPS.sentenceChars),
        observed: shortString(mismatch?.observed, CAPS.sentenceChars),
        cause: shortString(mismatch?.cause, CAPS.briefChars),
      }))
      : [],
    rootCause: shortString(judge.rootCause, 40),
    reusableRule: shortString(judge.reusableRule, CAPS.sentenceChars),
    recommendation: recommendation === null ? null : {
      descriptionEdit: shortString(recommendation.descriptionEdit, 300),
      bodyAddition: shortString(recommendation.bodyAddition, 300),
      selectionRule: shortString(recommendation.selectionRule, CAPS.sentenceChars),
    },
  }
}

/**
 * Cap the observed tool sequence.
 * @param {unknown} sequence stored tool items.
 * @returns {object[]} capped projections.
 */
function compactToolSequence(sequence) {
  if (!Array.isArray(sequence)) return []
  return sequence.slice(0, CAPS.traceToolItems).map((item) => ({
    name: shortString(item?.name, 60),
    ok: item?.ok !== false,
    brief: shortString(item?.brief, CAPS.briefChars),
  }))
}

/**
 * Compact one dream run for the journal.
 * @param {object} run durable dream run.
 * @returns {object} projection.
 */
function compactDream(run) {
  const value = run !== null && typeof run === 'object' ? run : {}
  const skills = Array.isArray(value.skills) ? value.skills.slice(0, CAPS.dreamSkills) : []
  return {
    id: shortString(value.id, CAPS.idChars),
    trigger: shortString(value.trigger, 16),
    startedAt: finiteNumber(value.startedAt),
    endedAt: finiteNumber(value.endedAt),
    status: shortString(value.status, 16),
    mode: shortString(value.mode, 16),
    before: compactDreamMetrics(value.before),
    afterEstimate: {
      consciousness: finiteNumber(value.afterEstimate?.consciousness),
      wastedTokensAvoided: finiteNumber(value.afterEstimate?.wastedTokensAvoided),
    },
    cases: finiteNumber(value.cases),
    tokens: {
      in: finiteNumber(value.tokens?.in),
      out: finiteNumber(value.tokens?.out),
    },
    error: errorText(value.error),
    skills: skills.map(compactDreamSkill),
  }
}

/**
 * Compact the measured "before" block of a dream run.
 * @param {unknown} before stored metrics.
 * @returns {object} projection.
 */
function compactDreamMetrics(before) {
  const value = before !== null && typeof before === 'object' ? before : {}
  return {
    consciousness: finiteNumber(value.consciousness),
    episodes: finiteNumber(value.episodes),
    wastedTokens: finiteNumber(value.wastedTokens),
  }
}

/**
 * Compact one per-skill dream result.
 * @param {unknown} entry stored dream skill entry.
 * @returns {object} projection with a computed `status` the journal renders.
 */
function compactDreamSkill(entry) {
  const value = entry !== null && typeof entry === 'object' ? entry : {}
  const proposal = value.proposal !== null && typeof value.proposal === 'object' ? value.proposal : null
  const applied = value.applied === true
  const rejectionReason = firstString([
    value.rejectionReason,
    value.rejectedReason,
    value.reason,
    value.error,
    proposal?.rejectionReason,
    proposal?.rejectedReason,
  ])
  const explicitStatus = firstString([value.status])
  const status = explicitStatus === 'applied' || explicitStatus === 'suggested' || explicitStatus === 'rejected'
    ? explicitStatus
    : applied
      ? 'applied'
      : rejectionReason === null ? 'suggested' : 'rejected'
  return {
    skill: shortString(value.skill, CAPS.nameChars),
    applied,
    status,
    caseIds: shortList(value.caseIds, CAPS.dreamCaseIds, CAPS.idChars),
    editIds: shortList(value.editIds, CAPS.dreamEditIds, CAPS.idChars),
    error: errorText(value.error),
    rejectionReason,
    proposal: proposal === null ? null : {
      confidence: finiteRatio(proposal.confidence),
      descriptionEdit: shortString(proposal.descriptionEdit, 300),
      bodyAddition: shortString(proposal.bodyAddition, 300),
      selectionRule: shortString(proposal.selectionRule, CAPS.sentenceChars),
    },
  }
}

/**
 * Project a stored error (string or `safeError` object) to one bounded line.
 * @param {unknown} value stored error field.
 * @returns {string|null} bounded message.
 */
function errorText(value) {
  if (typeof value === 'string') return value.length > 0 ? shortString(value, 200) : null
  if (value !== null && typeof value === 'object' && typeof value.message === 'string') {
    return value.message.length > 0 ? shortString(value.message, 200) : null
  }
  return null
}

/**
 * First non-empty bounded string from a list of candidates.
 * @param {unknown[]} candidates values in priority order.
 * @returns {string|null} the first usable string.
 */
function firstString(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return shortString(candidate, 200)
  }
  return null
}

/**
 * Compact one reversible edit and whether its byte backup exists.
 * @param {object|null|undefined} edit stored edit record.
 * @param {object} [store] durable store used to locate backups.
 * @returns {object} projection.
 */
function compactEdit(edit, store) {
  if (edit === null || typeof edit !== 'object') return null
  const editId = shortString(edit.id, CAPS.idChars)
  return {
    id: editId,
    dreamId: shortString(edit.dreamId, CAPS.idChars),
    skill: shortString(edit.skill, CAPS.nameChars),
    kind: shortString(edit.kind, 16),
    appliedAt: finiteNumber(edit.appliedAt),
    revertedAt: finiteNumber(edit.revertedAt),
    status: shortString(edit.status, 16) || 'applied',
    hasBackup: hasBackupFile(store, edit),
  }
}

/**
 * Whether an edit's backup file is present on disk. Never reads its contents.
 * @param {object} store durable store.
 * @param {object} edit edit record.
 * @returns {boolean} backup availability.
 */
function hasBackupFile(store, edit) {
  const candidates = []
  if (typeof edit.backupPath === 'string' && edit.backupPath.length > 0) candidates.push(edit.backupPath)
  try {
    if (typeof store?.paths === 'function' && typeof edit.id === 'string') {
      const backups = store.paths()?.backups
      if (typeof backups === 'string') candidates.push(join(backups, edit.id, 'SKILL.md'))
    }
  } catch {
    // Availability is optional diagnostics; an unreadable store means "unknown".
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return true
    } catch {
      // try the next candidate
    }
  }
  return false
}

/**
 * Dream schedule state for the summary page.
 * @param {object} state durable state document.
 * @param {object} config normalized config.
 * @param {object} deps resolved dependencies.
 * @returns {object} schedule projection.
 */
function compactDreamState(state, config, deps) {
  const dream = state !== null && typeof state === 'object' && state.dream !== null
    && typeof state.dream === 'object' ? state.dream : {}
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const dreamConfig = cfg.dream !== null && typeof cfg.dream === 'object' ? cfg.dream : {}
  return {
    enabled: dreamConfig.enabled !== false,
    running: deps.isDreamRunning(),
    lastRunAt: finiteNumber(dream.lastRunAt),
    lastRunId: shortString(dream.lastRunId, CAPS.idChars),
    nextRunAt: finiteNumber(dream.nextRunAt),
    consecutiveFailures: finiteNumber(dream.consecutiveFailures),
    time: shortString(dreamConfig.time, 5),
    timeZone: shortString(dreamConfig.timeZone, 80),
    autoApply: dreamConfig.autoApply === true,
    dailyTokenBudget: finiteNumber(dreamConfig.dailyTokenBudget),
  }
}

/**
 * Project the config to the knobs the dashboard explains. Nothing secret exists,
 * but writing an explicit allowlist keeps future fields from leaking silently.
 * @param {object} config normalized config.
 * @returns {object} sanitized config.
 */
function sanitizeConfig(config) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const probe = cfg.probe !== null && typeof cfg.probe === 'object' ? cfg.probe : {}
  const judge = cfg.judge !== null && typeof cfg.judge === 'object' ? cfg.judge : {}
  const prompt = cfg.prompt !== null && typeof cfg.prompt === 'object' ? cfg.prompt : {}
  const dream = cfg.dream !== null && typeof cfg.dream === 'object' ? cfg.dream : {}
  const store = cfg.store !== null && typeof cfg.store === 'object' ? cfg.store : {}
  return {
    enabled: cfg.enabled !== false,
    debug: cfg.debug === true,
    probe: {
      enabled: probe.enabled !== false,
      mode: shortString(probe.mode, 16),
      sampleRate: finiteRatio(probe.sampleRate, 1),
      maxPerHour: finiteNumber(probe.maxPerHour),
      alwaysForGapSkills: probe.alwaysForGapSkills === true,
    },
    judge: { enabled: judge.enabled !== false },
    prompt: {
      awarenessSection: prompt.awarenessSection !== false,
      annotateSkillResult: prompt.annotateSkillResult !== false,
      maxSkills: finiteNumber(prompt.maxSkills),
    },
    dream: {
      enabled: dream.enabled !== false,
      mode: shortString(dream.mode, 16),
      time: shortString(dream.time, 5),
      timeZone: shortString(dream.timeZone, 80),
      caseWindowDays: finiteNumber(dream.caseWindowDays),
      scoreThreshold: finiteNumber(dream.scoreThreshold),
      maxSkillsPerRun: finiteNumber(dream.maxSkillsPerRun),
      maxCasesPerSkill: finiteNumber(dream.maxCasesPerSkill),
      autoApply: dream.autoApply === true,
      dailyTokenBudget: finiteNumber(dream.dailyTokenBudget),
    },
    store: {
      retainDays: finiteNumber(store.retainDays),
      maxEpisodes: finiteNumber(store.maxEpisodes),
      maxSkills: finiteNumber(store.maxSkills),
    },
    api: { enabled: cfg.api?.enabled !== false },
  }
}

// ---------------------------------------------------------------------------------------------
// stable-resolution helpers
// ---------------------------------------------------------------------------------------------

/**
 * Resolve the host-provided revert callback, then the engine method.
 * @param {Function|undefined} callback explicit revert from index.js.
 * @param {object|undefined} dreamEngine dream engine.
 * @param {object} logger logger.
 * @returns {Function|null} `(editId, opts) => Promise<{ok, reason?, edit?}>` or null.
 */
function resolveRevert(callback, dreamEngine, logger) {
  if (typeof callback === 'function') return callback
  if (dreamEngine !== null && typeof dreamEngine === 'object' && typeof dreamEngine.revertEdit === 'function') {
    return (editId, opts) => dreamEngine.revertEdit(editId, opts)
  }
  if (typeof dreamEngine?.revert === 'function') return (editId, opts) => dreamEngine.revert(editId, opts)
  logger.warn?.('dreaming: revert is unavailable; POST edits/revert will answer 503')
  return null
}

/**
 * Resolve the manual-dream entry point from the engine.
 * @param {object|undefined} dreamEngine dream engine.
 * @returns {Function|null} `(opts) => run|Promise<run>` or null.
 */
function resolveRunDream(dreamEngine) {
  if (typeof dreamEngine?.run === 'function') return (opts) => dreamEngine.run(opts)
  if (typeof dreamEngine?.runDream === 'function') return (opts) => dreamEngine.runDream(opts)
  if (typeof dreamEngine?.dream === 'function') return (opts) => dreamEngine.dream(opts)
  return null
}

/**
 * Resolve the engine's busy predicate.
 * @param {object|undefined} dreamEngine dream engine.
 * @returns {() => boolean} predicate (false when unavailable).
 */
function resolveIsRunning(dreamEngine) {
  const method = dreamEngine?.isRunning
  if (typeof method === 'function') {
    return () => {
      try {
        return method.call(dreamEngine) === true
      } catch {
        return false
      }
    }
  }
  return () => false
}

/**
 * Count open episodes without depending on one tracker shape.
 * @param {object|undefined} tracker episode tracker.
 * @returns {number} open episode count.
 */
function openEpisodeCount(tracker) {
  try {
    if (typeof tracker?.openCount === 'function') return finiteNumber(tracker.openCount())
    const candidates = [tracker?.openEpisodes, tracker?.open, tracker?.windows, tracker?.byCallId]
    for (const candidate of candidates) {
      if (candidate instanceof Map) return candidate.size
      if (Array.isArray(candidate)) return candidate.length
      if (candidate !== null && typeof candidate === 'object') return Object.keys(candidate).length
    }
    if (typeof tracker?.size === 'number') return finiteNumber(tracker.size)
  } catch {
    // Diagnostics only: never fail the health endpoint over a tracker shape.
  }
  return 0
}

/**
 * Read a run identifier from an engine outcome.
 * @param {unknown} outcome engine return value.
 * @returns {string|null} run id.
 */
function readRunId(outcome) {
  if (outcome === null || typeof outcome !== 'object') return null
  const id = outcome.runId ?? outcome.id ?? outcome.dreamId
  return typeof id === 'string' && id.length > 0 && id.length <= CAPS.idChars ? id : null
}

/**
 * Read store health defensively.
 * @param {object|undefined} store durable store.
 * @returns {object} `{ ready, dir, error, revision }`.
 */
function safeStoreHealth(store) {
  try {
    const health = typeof store?.health === 'function' ? store.health() : null
    if (health !== null && typeof health === 'object') {
      return {
        ready: health.ready === true,
        dir: typeof health.dir === 'string' ? health.dir : null,
        error: health.error === null || health.error === undefined ? null : {
          name: shortString(health.error.name, 40),
          message: shortString(health.error.message, 200),
        },
        episodes: finiteNumber(health.episodes),
        skills: finiteNumber(health.skills),
        revision: finiteNumber(health.revision),
      }
    }
  } catch (error) {
    return { ready: false, dir: null, error: { name: 'Error', message: shortString(safeError(error).message, 200) }, episodes: 0, skills: 0, revision: 0 }
  }
  return { ready: false, dir: null, error: null, episodes: 0, skills: 0, revision: 0 }
}

// ---------------------------------------------------------------------------------------------
// HTTP primitives
// ---------------------------------------------------------------------------------------------

/**
 * Parse a request URL, returning null when it cannot be interpreted.
 * @param {unknown} raw request url.
 * @returns {URL|null} parsed URL.
 */
function parseUrl(raw) {
  const value = typeof raw === 'string' && raw.length > 0 ? raw : '/'
  try {
    const url = new URL(value, 'http://localhost')
    return url.pathname.startsWith(PREFIX) ? url : null
  } catch {
    return null
  }
}

/**
 * CSRF guard for mutations.
 * @param {object} deps resolved dependencies.
 * @param {import('node:http').IncomingMessage} req request.
 * @returns {boolean} whether the mutation may proceed.
 */
function isAllowedOrigin(deps, req) {
  const headers = req !== null && typeof req === 'object' && req.headers !== null
    && typeof req.headers === 'object' ? req.headers : {}
  const origin = typeof headers.origin === 'string' ? headers.origin.trim() : ''
  if (origin.length === 0) return true
  let expected
  try {
    expected = deps.ctx.webServer.getOrigin()
  } catch {
    return false
  }
  if (typeof expected !== 'string' || expected.length === 0) return false
  return normalizeOrigin(origin) === normalizeOrigin(expected)
}

/**
 * Normalize an origin for comparison (case-insensitive scheme/host, no trailing slash).
 * @param {string} value origin.
 * @returns {string} normalized origin.
 */
function normalizeOrigin(value) {
  return String(value).trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * Parse one JSON request body with a hard byte cap.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {number} limit byte cap.
 * @returns {Promise<object>} parsed plain object (empty object for an empty body).
 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const headers = req?.headers !== null && typeof req?.headers === 'object' ? req.headers : {}
    const declared = Number(headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      drain(req)
      reject(new ApiError(413, 'payload_too_large', `body exceeds ${limit} bytes`))
      return
    }

    const chunks = []
    let size = 0
    let settled = false

    const cleanup = () => {
      if (typeof req?.removeListener === 'function') {
        req.removeListener('data', onData)
        req.removeListener('end', onEnd)
        req.removeListener('error', onError)
        req.removeListener('close', onClose)
      }
    }
    const finish = (action, value) => {
      if (settled) return
      settled = true
      cleanup()
      action(value)
    }
    const onData = (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limit) {
        finish(reject, new ApiError(413, 'payload_too_large', `body exceeds ${limit} bytes`))
        drain(req)
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => {
      if (settled) return
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        finish(resolve, {})
        return
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        finish(reject, new ApiError(400, 'invalid_json', 'body must be valid JSON'))
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        finish(reject, new ApiError(400, 'invalid_json', 'body must be a JSON object'))
        return
      }
      finish(resolve, parsed)
    }
    const onError = (error) => {
      finish(reject, new ApiError(400, 'invalid_body', shortString(safeError(error).message, 120)))
    }
    // A client that disconnects mid-body emits close without end; settle the promise
    // so the request handler cannot stay pending forever.
    const onClose = () => {
      if (settled || req?.readableEnded === true) return
      finish(reject, new ApiError(400, 'aborted', 'request closed before the body was complete'))
    }

    try {
      if (req?.readableEnded === true) {
        onEnd()
        return
      }
      req.on('data', onData)
      req.on('end', onEnd)
      req.on('error', onError)
      req.on('close', onClose)
    } catch (error) {
      finish(reject, new ApiError(400, 'invalid_body', shortString(safeError(error).message, 120)))
    }
  })
}

/**
 * Drain a request stream we deliberately did not consume, so keep-alive sockets
 * do not stall. Errors are ignored: the response is already decided.
 * @param {import('node:http').IncomingMessage} req request.
 */
function drain(req) {
  try {
    if (typeof req?.resume === 'function') req.resume()
  } catch {
    // The socket may already be gone.
  }
}

/**
 * Write one JSON response with the dashboard's fixed headers.
 * @param {import('node:http').ServerResponse} res response.
 * @param {number} status status code.
 * @param {object} payload JSON-serializable payload.
 */
function sendJson(res, status, payload) {
  if (res === null || typeof res !== 'object') return
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    body = JSON.stringify({ ok: false, error: { code: 'serialization_failed', message: 'response could not be serialized' } })
    status = 500
  }
  if (res.writableEnded === true || res.headersSent === true) {
    try {
      res.end()
    } catch {
      // Response already closed.
    }
    return
  }
  try {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'))
    res.end(body)
  } catch {
    try {
      res.end?.()
    } catch {
      // Nothing else can be done for an unusable response.
    }
  }
}

/**
 * Write a JSON error response.
 * @param {import('node:http').ServerResponse} res response.
 * @param {number} status status code.
 * @param {string} code stable error code.
 * @param {string} [detail] optional short detail (never a stack).
 */
function fail(res, status, code, detail) {
  sendJson(res, status, {
    ok: false,
    error: { code, message: oneLine(detail || defaultMessage(code), 300) },
  })
}

/**
 * Default English diagnostic for an error code (API-only; the UI localizes its own copy).
 * @param {string} code error code.
 * @returns {string} diagnostic.
 */
function defaultMessage(code) {
  switch (code) {
    case 'not_found': return 'unknown route'
    case 'method_not_allowed': return 'method not allowed'
    case 'payload_too_large': return 'request body too large'
    case 'forbidden_origin': return 'cross-origin mutation rejected'
    case 'invalid_json': return 'invalid JSON body'
    case 'dream_running': return 'a dream run is already in progress'
    case 'dream_unavailable': return 'dream runs are unavailable'
    case 'revert_unavailable': return 'revert is unavailable'
    case 'edit_not_found': return 'edit not found'
    case 'api_disposed': return 'the dreaming plugin is shutting down'
    default: return 'internal error'
  }
}

// ---------------------------------------------------------------------------------------------
// small guards
// ---------------------------------------------------------------------------------------------

/**
 * Coerce a value to a finite number.
 * @param {unknown} value candidate.
 * @param {number} [fallback] value used for non-finite input.
 * @returns {number} finite number.
 */
function finiteNumber(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * Coerce a ratio-ish value to a finite number in [0, 1].
 * @param {unknown} value candidate.
 * @param {number} [fallback] value used for non-finite input.
 * @returns {number} finite ratio.
 */
function finiteRatio(value, fallback = 0) {
  const number = finiteNumber(value, fallback)
  return Math.min(1, Math.max(0, number))
}

/**
 * Coerce to a bounded single-line string.
 * @param {unknown} value candidate.
 * @param {number} maxChars cap.
 * @returns {string} bounded text.
 */
function shortString(value, maxChars) {
  if (typeof value !== 'string') return ''
  return truncate(oneLine(value, maxChars), maxChars)
}

/**
 * Project a list to bounded strings.
 * @param {unknown} value candidate list.
 * @param {number} maxItems item cap.
 * @param {number} maxChars per-item cap.
 * @returns {string[]} bounded list.
 */
function shortList(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => item !== null && item !== undefined && item !== '')
    .slice(0, Math.max(0, maxItems))
    .map((item) => shortString(typeof item === 'string' ? item : String(item), maxChars))
    .filter((item) => item.length > 0)
}

/**
 * Read an integer query parameter, falling back when the parameter is absent.
 * `URLSearchParams.get` returns `null` for a missing key, and `Number(null)` is 0,
 * so `asInt` alone would silently clamp missing limits to the minimum.
 * @param {URLSearchParams} params query parameters.
 * @param {string} key parameter name.
 * @param {number} min lower bound.
 * @param {number} max upper bound.
 * @param {number} fallback value used when absent or blank.
 * @returns {number} clamped integer.
 */
function queryInt(params, key, min, max, fallback) {
  const raw = params.get(key)
  if (raw === null || raw.trim() === '') return fallback
  return asInt(raw, min, max, fallback)
}

/**
 * Validate a skill-name query parameter.
 * @param {unknown} raw query value.
 * @returns {string|undefined} skill name or undefined.
 */
function cleanSkillName(raw) {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value.length === 0 || value.length > CAPS.nameChars) return undefined
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value) ? value : undefined
}

/**
 * ISO timestamp or null for an invalid clock.
 * @param {unknown} value epoch milliseconds.
 * @returns {string|null} ISO string.
 */
function isoOrNull(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return null
  try {
    return new Date(number).toISOString()
  } catch {
    return null
  }
}

/**
 * Whether a value is promise-like.
 * @param {unknown} value candidate.
 * @returns {boolean} thenable check.
 */
function isThenable(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function'
}

/**
 * Normalize a logger to the four methods used here.
 * @param {unknown} logger candidate logger.
 * @returns {{warn: Function, debug: Function}} safe logger.
 */
function normalizeLogger(logger) {
  if (logger === null || typeof logger !== 'object') return noopLogger
  return {
    info: typeof logger.info === 'function' ? logger.info.bind(logger) : noop,
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : noop,
    error: typeof logger.error === 'function' ? logger.error.bind(logger) : noop,
    debug: typeof logger.debug === 'function' ? logger.debug.bind(logger) : noop,
  }
}
