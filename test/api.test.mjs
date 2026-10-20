/**
 * Unit tests for the dreaming dashboard API (`lib/api.js`) plus static checks on
 * `client.js` and the locale dictionaries.
 *
 * Everything runs on node:test/node:assert with fakes: no Harness runtime, no
 * real HTTP server, no plugin installation. The API module must stay usable by a
 * plain `node --test` run, which is exactly what this file proves.
 *
 * Run: node --test test/api.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { installApi } from '../lib/api.js'

const NOW = 1_700_000_000_000
const ORIGIN = 'http://127.0.0.1:3080'
const ROUTE_PATH = '/dreaming/api'
const PREFIX = '/dreaming/api/'
const BIG = 'x'.repeat(5000)

const tempDir = mkdtempSync(join(tmpdir(), 'dreaming-api-test-'))
const backupsDir = join(tempDir, 'backups')
mkdirSync(join(backupsDir, 'edit_1'), { recursive: true })
writeFileSync(join(backupsDir, 'edit_1', 'SKILL.md'), '# backup\n', 'utf8')
test.after(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// fake HTTP objects
// ---------------------------------------------------------------------------------------------

/** Minimal `ServerResponse` that records status, headers and the written body. */
class FakeResponse {
  constructor() {
    this.statusCode = 200
    this.headers = {}
    this.body = null
    this.headersSent = false
    this.writableEnded = false
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = value
  }

  getHeader(name) {
    return this.headers[String(name).toLowerCase()]
  }

  end(body) {
    this.headersSent = true
    this.writableEnded = true
    if (body !== undefined && body !== null) this.body = String(body)
  }
}

/** Minimal `IncomingMessage`: a readable stream with method/url/headers. */
class FakeRequest extends Readable {
  constructor({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
    super()
    this.method = method
    this.url = url
    this.headers = { ...headers }
    if (body !== null && body !== undefined) this.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
    this.push(null)
  }

  _read() {}
}

/**
 * Invoke the route handler the way the web server would and collect the answer.
 * @param {Function} handler registered route handler.
 * @param {object} request request options.
 * @returns {Promise<{status:number, headers:object, json:object|null, raw:string|null}>} response.
 */
async function call(handler, request = {}) {
  const { body = null, declareLength = true, ...rest } = request
  const headers = { ...(rest.headers ?? {}) }
  if (body !== null && body !== undefined && declareLength === true) {
    headers['content-length'] = String(Buffer.byteLength(String(body), 'utf8'))
  }
  const req = new FakeRequest({ ...rest, headers, body })
  const res = new FakeResponse()
  const outcome = handler(req, res)
  if (outcome !== null && outcome !== undefined && typeof outcome.then === 'function') await outcome
  await new Promise((resolve) => setImmediate(resolve))
  let json = null
  if (typeof res.body === 'string' && res.body.length > 0) {
    json = JSON.parse(res.body)
  }
  return { status: res.statusCode, headers: res.headers, json, raw: res.body }
}

// ---------------------------------------------------------------------------------------------
// fakes: config, store, engine, tracker
// ---------------------------------------------------------------------------------------------

function makeConfig() {
  return {
    enabled: true,
    debug: false,
    probe: { enabled: true, mode: 'inline', sampleRate: 1, maxPerHour: 120, alwaysForGapSkills: true },
    judge: { enabled: true },
    prompt: { awarenessSection: true, annotateSkillResult: true, maxSkills: 8 },
    dream: {
      enabled: true,
      mode: 'auto',
      time: '03:30',
      timeZone: '',
      caseWindowDays: 7,
      scoreThreshold: 78,
      maxSkillsPerRun: 3,
      maxCasesPerSkill: 6,
      autoApply: true,
      dailyTokenBudget: 60000,
    },
    store: { retainDays: 120, maxEpisodes: 4000, maxSkills: 400 },
    api: { enabled: true },
    dataDir: 'C:\\secret\\should\\not\\be\\projected',
  }
}

function makeState() {
  return {
    v: 1,
    totals: {
      episodes: 12,
      judged: 9,
      probeTokens: 5400,
      judgeTokens: 7600,
      dreamTokens: 1200,
      skillLoadTokens: 9800,
      wastedTokens: 1300,
    },
    skills: {
      'office-xlsx': {
        name: 'office-xlsx',
        source: 'user-dsh',
        editable: true,
        lastUsedAt: NOW - 1000,
        counts: { loads: 8, judged: 6, matched: 3, partial: 2, missed: 1, misapplied: 1, boundaryGaps: 2 },
        metrics: {
          meanScore: 74.2,
          fitAccuracy: 0.71,
          boundaryAccuracy: 0.67,
          precision: 0.875,
          consciousness: 73,
          wasteRate: 0.12,
          trend: 2.4,
          confidence: 'medium',
        },
        cost: { probe: 180, judge: 256, skillLoad: 1200, wasted: 140 },
        fitHistory: [{ t: NOW - 1000, episodeId: 'ep_1', fit: 0.7, success: 0.75, signature: 's1' }],
        appliedEdits: [{ editId: 'edit_1', dreamId: 'dream_1', kind: 'description', appliedAt: NOW - 500 }],
        learned: { notes: [] },
      },
      'probe-helper': {
        name: 'probe-helper',
        source: 'bundled',
        editable: false,
        lastUsedAt: NOW - 9000,
        counts: { loads: 4, judged: 3, boundaryGaps: 0 },
        metrics: {
          meanScore: 88,
          fitAccuracy: 0.9,
          boundaryAccuracy: 1,
          precision: 1,
          consciousness: 92,
          wasteRate: 0,
          trend: -0.5,
          confidence: 'low',
        },
        cost: { probe: 20, judge: 30, skillLoad: 400, wasted: 0 },
        appliedEdits: [],
        learned: { notes: [] },
      },
    },
    dream: { lastRunAt: NOW - 86400000, lastRunId: 'dream_1', nextRunAt: NOW + 3600000, consecutiveFailures: 0 },
    runtime: { disabledReason: null },
  }
}

function makeEpisode() {
  return {
    v: 1,
    id: 'ep_1',
    sessionId: 'session_should_not_leak',
    skill: 'office-xlsx',
    startedAt: NOW - 60000,
    endedAt: NOW - 20000,
    state: 'judged',
    turn: 3,
    step: 1,
    skillMeta: { description: BIG, source: 'user-dsh', path: 'C:\\skills\\office-xlsx\\SKILL.md', bodyChars: 4200, bodyTokens: 1200 },
    prediction: {
      fit: 0.72,
      confidence: 0.6,
      intent: BIG,
      expectedUse: Array.from({ length: 9 }, () => BIG),
      likelyPitfalls: Array.from({ length: 8 }, () => BIG),
      capabilityGap: BIG,
      cheaperAlternative: BIG,
      expectedValueTokens: 1200,
    },
    probe: { backend: 'inline', model: 'deepseek-account/deepseek-flash', status: 'ok', tokensIn: 1500, tokensOut: 300, latencyMs: 2100, error: null },
    call: { isError: false, durationMs: 40, contentChars: 4300 },
    trace: {
      observedMs: 42000,
      turnEnd: 'completed',
      assistantTexts: Array.from({ length: 6 }, () => BIG),
      userMessages: Array.from({ length: 5 }, () => BIG),
      toolSequence: Array.from({ length: 30 }, () => ({ name: 'read', ok: true, brief: BIG })),
      skillReLoaded: false,
      finalAnswerChars: 800,
    },
    judge: {
      status: 'ok',
      model: 'deepseek-account/deepseek-flash',
      score: 78,
      verdict: 'partial',
      predictionAccuracy: 0.55,
      capabilityGap: { present: true, claim: BIG, reality: BIG },
      mismatches: Array.from({ length: 6 }, () => ({ expected: BIG, observed: BIG, cause: BIG })),
      rootCause: 'description',
      reusableRule: BIG,
      recommendation: { descriptionEdit: BIG, bodyAddition: BIG, selectionRule: BIG },
    },
    cost: { probe: 1800, judge: 2550, skillLoad: 1200, reworkEstimate: 0, wastedEstimate: 100 },
    flags: { sampled: false, truncated: false, dreamIds: ['dream_1'] },
  }
}

function makeDream() {
  return {
    v: 1,
    id: 'dream_1',
    trigger: 'schedule',
    startedAt: NOW - 86400000,
    endedAt: NOW - 86000000,
    status: 'ok',
    mode: 'inline',
    before: { consciousness: 62, episodes: 40, wastedTokens: 5200 },
    afterEstimate: { consciousness: 66, wastedTokensAvoided: 1800 },
    cases: 6,
    tokens: { in: 8000, out: 1500 },
    error: null,
    skills: [
      {
        skill: 'office-xlsx',
        caseIds: ['ep_1'],
        applied: true,
        editIds: ['edit_1'],
        error: null,
        proposal: { descriptionEdit: BIG, bodyAddition: BIG, selectionRule: BIG, confidence: 0.7 },
      },
      {
        skill: 'probe-helper',
        caseIds: ['ep_2'],
        applied: false,
        editIds: [],
        error: null,
        proposal: { descriptionEdit: BIG, bodyAddition: BIG, selectionRule: BIG, confidence: 0.62 },
      },
      {
        skill: 'broken-skill',
        caseIds: [],
        applied: false,
        editIds: [],
        error: 'proposal validation failed',
        rejectionReason: 'description too long',
        proposal: null,
      },
    ],
  }
}

function makeEdits() {
  return [
    {
      id: 'edit_1',
      dreamId: 'dream_1',
      skill: 'office-xlsx',
      kind: 'description',
      appliedAt: NOW - 500,
      status: 'applied',
      revertedAt: null,
      backupPath: join(backupsDir, 'edit_1', 'SKILL.md'),
      before: { sha256: 'a'.repeat(64), text: 'SECRET FILE CONTENT' },
      after: { sha256: 'b'.repeat(64) },
    },
    {
      id: 'edit_2',
      dreamId: 'dream_1',
      skill: 'probe-helper',
      kind: 'body',
      appliedAt: NOW - 400,
      status: 'reverted',
      revertedAt: NOW - 300,
      backupPath: join(backupsDir, 'edit_2', 'SKILL.md'),
      before: { sha256: 'c'.repeat(64), text: 'SECRET FILE CONTENT' },
      after: { sha256: 'd'.repeat(64) },
    },
  ]
}

/**
 * Build a store fake whose every method the API uses is controllable.
 * @param {object} [overrides] per-test overrides.
 * @returns {object} store fake.
 */
function makeStore(overrides = {}) {
  const store = {
    dir: tempDir,
    state: makeState(),
    lastEpisodesQuery: null,
    recentEpisodes(query) {
      store.lastEpisodesQuery = query
      return [makeEpisode()]
    },
    recentDreams() {
      return [makeDream()]
    },
    recentEdits() {
      return makeEdits()
    },
    getEdit(id) {
      return makeEdits().find((edit) => edit.id === id)
    },
    paths() {
      return { backups: backupsDir }
    },
    health() {
      return { ready: true, dir: tempDir, error: null, episodes: 1, skills: 2, revision: 3 }
    },
    ...overrides,
  }
  return store
}

function makeDreamEngine(overrides = {}) {
  const engine = {
    calls: [],
    running: false,
    isRunning() {
      return engine.running
    },
    run(options) {
      engine.calls.push(options)
      return Promise.resolve({ runId: 'dream_async' })
    },
    ...overrides,
  }
  return engine
}

function makeTracker() {
  return { openEpisodes: new Map([['call_1', {}], ['call_2', {}]]) }
}

/**
 * Install the API on a fake context and expose what the test needs.
 * @param {object} [overrides] installApi option overrides.
 * @returns {object} harness.
 */
function harness(overrides = {}) {
  const routes = []
  const warnings = []
  const logger = {
    info() {},
    warn(message) {
      warnings.push(String(message))
    },
    error() {},
    debug() {},
  }
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          route.disposed = true
        }
      },
      getOrigin() {
        return ORIGIN
      },
    },
  }
  const store = makeStore()
  const dreamEngine = makeDreamEngine()
  const base = {
    ctx,
    config: makeConfig(),
    store,
    dreamEngine,
    tracker: makeTracker(),
    logger,
    now: () => NOW,
  }
  const dispose = installApi({ ...base, ...overrides })
  return { routes, route: routes[0], warnings, logger, ctx, store, dreamEngine, dispose, base }
}

// ---------------------------------------------------------------------------------------------
// GET routes
// ---------------------------------------------------------------------------------------------

test('GET summary returns overall metrics, skill rows, schedule, sanitized config and store health', async () => {
  const { route, store } = harness()
  const response = await call(route.handler, { method: 'GET', url: PREFIX + 'summary' })
  assert.equal(response.status, 200)
  assert.match(String(response.headers['content-type']), /^application\/json/)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.json.ok, true)
  assert.equal(typeof response.json.generatedAt, 'string')
  assert.equal(response.json.overall.skillsTracked, 2)
  assert.equal(response.json.overall.consciousness > 0, true)
  assert.equal(response.json.overall.probeTokens, 5400)
  assert.equal(response.json.overall.judgeTokens, 7600)
  assert.equal(response.json.skills.length, 2)
  const names = response.json.skills.map((skill) => skill.name).sort()
  assert.deepEqual(names, ['office-xlsx', 'probe-helper'])
  assert.equal(response.json.skills[0].loads >= 0, true)
  assert.equal(typeof response.json.dream.nextRunAt, 'number')
  assert.equal(response.json.dream.enabled, true)
  assert.equal(response.json.dream.running, false)
  assert.equal(response.json.config.probe.mode, 'inline')
  assert.equal(response.json.config.dream.time, '03:30')
  assert.equal(response.json.store.ready, true)
  assert.equal(response.json.dataDir, tempDir)
  // The configured dataDir and the store directory must not be projected blindly, and
  // no raw skill path leaks through the summary.
  assert.equal(response.raw.includes('secret'), false)
  assert.equal(response.raw.includes('SKILL.md'), false)
  assert.equal(store.lastEpisodesQuery, null)
})

test('GET episodes returns compact bounded projections and forwards validated filters', async () => {
  const { route, store } = harness()
  const response = await call(route.handler, {
    method: 'GET',
    url: PREFIX + 'episodes?limit=5&offset=2&skill=office-xlsx&verdict=partial&filter=mismatch',
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.offset, 2)
  assert.equal(response.json.limit, 5)
  assert.deepEqual(store.lastEpisodesQuery, {
    limit: 7,
    skill: 'office-xlsx',
    verdict: 'partial',
    mismatchedOnly: true,
  })
  // One returned episode would be paginated away by offset=2; the fixture returns one row.
  assert.equal(response.json.items.length, 0)
  assert.equal(response.json.hasMore, false)

  const second = await call(route.handler, { method: 'GET', url: PREFIX + 'episodes?limit=1' })
  assert.equal(second.json.items.length, 1)
  const episode = second.json.items[0]
  assert.equal(episode.id, 'ep_1')
  assert.equal(episode.skill, 'office-xlsx')
  assert.equal(episode.judge.verdict, 'partial')
  assert.equal(episode.prediction.fit, 0.72)
  // Caps: never the raw multi-KB traces.
  assert.equal(episode.trace.assistantTexts.length <= 3, true)
  assert.equal(episode.trace.userMessages.length <= 3, true)
  assert.equal(episode.trace.toolSequence.length <= 12, true)
  assert.equal(episode.judge.mismatches.length <= 3, true)
  assert.equal(episode.prediction.expectedUse.length <= 4, true)
  assert.equal(JSON.stringify(episode).length < 12000, true)
  assert.equal(second.raw.includes('x'.repeat(600)), false)
  // Session identifiers and file paths are not part of the projection.
  assert.equal(second.raw.includes('session_should_not_leak'), false)
  assert.equal(second.raw.includes('C:\\\\skills'), false)
})

test('GET episodes ignores invalid filters instead of failing', async () => {
  const { route, store } = harness()
  const response = await call(route.handler, {
    method: 'GET',
    url: PREFIX + 'episodes?skill=%00bad&verdict=nope&limit=9999',
  })
  assert.equal(response.status, 200)
  assert.equal(store.lastEpisodesQuery.skill, undefined)
  assert.equal(store.lastEpisodesQuery.verdict, undefined)
  assert.equal(store.lastEpisodesQuery.limit, 100) // clamped to the episode limit cap
  assert.equal(response.json.filter.skill, null)
})

test('GET dreams returns a compact journal with applied/suggested/rejected states', async () => {
  const { route } = harness()
  const response = await call(route.handler, { method: 'GET', url: PREFIX + 'dreams?limit=5' })
  assert.equal(response.status, 200)
  assert.equal(response.json.items.length, 1)
  const run = response.json.items[0]
  assert.equal(run.id, 'dream_1')
  assert.equal(run.status, 'ok')
  assert.equal(run.cases, 6)
  assert.deepEqual(run.before, { consciousness: 62, episodes: 40, wastedTokens: 5200 })
  assert.equal(run.afterEstimate.consciousness, 66)
  assert.deepEqual(run.skills.map((skill) => skill.status), ['applied', 'suggested', 'rejected'])
  assert.deepEqual(run.skills[0].editIds, ['edit_1'])
  assert.equal(JSON.stringify(run).length < 9000, true)
  assert.equal(response.raw.includes('x'.repeat(600)), false)
})

test('GET edits reports backup availability and never exposes file contents', async () => {
  const { route } = harness()
  const response = await call(route.handler, { method: 'GET', url: PREFIX + 'edits?skill=office-xlsx' })
  assert.equal(response.status, 200)
  assert.equal(response.json.items.length, 2)
  assert.equal(response.json.items[0].hasBackup, true)
  assert.equal(response.json.items[1].hasBackup, false)
  assert.equal(response.json.items[0].status, 'applied')
  assert.equal(response.raw.includes('SECRET FILE CONTENT'), false)
  assert.equal(response.raw.includes('before'), false)
  assert.equal(response.raw.includes('backupPath'), false)
})

test('GET health reports store readiness, next run and open episodes', async () => {
  const { route } = harness()
  const response = await call(route.handler, { method: 'GET', url: PREFIX + 'health' })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.storeReady, true)
  assert.equal(response.json.nextRunAt, NOW + 3600000)
  assert.equal(response.json.openEpisodes, 2)
  assert.equal(response.json.dreamRunning, false)
  assert.equal(response.json.lastError, null)
})

test('GET health tolerates a broken store and a tracker without a Map', async () => {
  const brokenStore = makeStore({
    health() {
      throw new Error('disk is gone')
    },
  })
  const { route } = harness({ store: brokenStore, tracker: { size: 4 } })
  const response = await call(route.handler, { method: 'GET', url: PREFIX + 'health' })
  assert.equal(response.status, 200)
  assert.equal(response.json.storeReady, false)
  assert.equal(response.json.openEpisodes, 4)
  assert.match(response.json.lastError.message, /disk is gone/)
})

// ---------------------------------------------------------------------------------------------
// routing and security
// ---------------------------------------------------------------------------------------------

test('unknown routes answer 404 and known routes answer 405 for the wrong method', async () => {
  const { route } = harness()
  const unknown = await call(route.handler, { method: 'GET', url: PREFIX + 'nope' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.ok, false)
  assert.equal(unknown.json.error.code, 'not_found')

  const getRouteWithPost = await call(route.handler, { method: 'POST', url: PREFIX + 'summary', body: '{}', origin: ORIGIN })
  assert.equal(getRouteWithPost.status, 405)
  assert.equal(getRouteWithPost.headers.allow, 'GET')

  const postRouteWithGet = await call(route.handler, { method: 'GET', url: PREFIX + 'dream/run' })
  assert.equal(postRouteWithGet.status, 405)
  assert.equal(postRouteWithGet.headers.allow, 'POST')

  const otherMethod = await call(route.handler, { method: 'PUT', url: PREFIX + 'summary' })
  assert.equal(otherMethod.status, 405)
  assert.equal(otherMethod.headers.allow, 'GET, POST')
})

test('POST rejects a body over the 64 KiB limit (declared and streamed)', async () => {
  const { route, dreamEngine } = harness()
  const oversized = JSON.stringify({ pad: 'y'.repeat(70 * 1024) })

  const declared = await call(route.handler, {
    method: 'POST',
    url: PREFIX + 'dream/run',
    body: '{}',
    declareLength: false,
    headers: { 'content-length': String(oversized.length), origin: ORIGIN },
  })
  assert.equal(declared.status, 413)
  assert.equal(declared.json.error.code, 'payload_too_large')

  const streamed = await call(route.handler, {
    method: 'POST',
    url: PREFIX + 'dream/run',
    body: oversized,
    declareLength: false,
    origin: ORIGIN,
  })
  assert.equal(streamed.status, 413)
  assert.equal(dreamEngine.calls.length, 0)
})

test('POST mutations are rejected when Origin does not match the web server', async () => {
  const { route, dreamEngine } = harness()
  const response = await call(route.handler, {
    method: 'POST',
    url: PREFIX + 'dream/run',
    body: '{}',
    headers: { origin: 'http://evil.example' },
  })
  assert.equal(response.status, 403)
  assert.equal(response.json.error.code, 'forbidden_origin')
  assert.equal(dreamEngine.calls.length, 0)

  // An absent Origin is a non-browser caller and stays allowed.
  const allowed = await call(route.handler, { method: 'POST', url: PREFIX + 'dream/run', body: '{}' })
  assert.equal(allowed.status, 200)
  assert.equal(dreamEngine.calls.length, 1)
})

test('handler failures are contained as 500 responses and never throw', async () => {
  const store = makeStore()
  Object.defineProperty(store, 'state', {
    configurable: true,
    get() {
      throw new Error('state exploded')
    },
  })
  const { route, warnings } = harness({ store })
  const response = await call(route.handler, { method: 'GET', url: PREFIX + 'summary' })
  assert.equal(response.status, 500)
  assert.equal(response.json.ok, false)
  assert.equal(response.json.error.code, 'internal_error')
  assert.equal(warnings.length > 0, true)
  assert.equal(warnings.some((message) => message.includes('failed')), true)
})

test('malformed POST bodies answer 400 and missing edit ids are rejected', async () => {
  const { route } = harness({ revertEdit: async () => ({ ok: true }) })
  const invalid = await call(route.handler, {
    method: 'POST',
    url: PREFIX + 'edits/revert',
    body: '{not json',
    origin: ORIGIN,
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.json.error.code, 'invalid_json')

  const missing = await call(route.handler, { method: 'POST', url: PREFIX + 'edits/revert', body: '{}', origin: ORIGIN })
  assert.equal(missing.status, 400)
  assert.equal(missing.json.error.code, 'invalid_edit_id')

  const unknown = await call(route.handler, {
    method: 'POST',
    url: PREFIX + 'edits/revert',
    body: JSON.stringify({ editId: 'edit_missing' }),
    origin: ORIGIN,
  })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.error.code, 'edit_not_found')
})

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

test('POST dream/run accepts a manual run, reports 409 while running and handles sync run ids', async () => {
  const engine = makeDreamEngine()
  const { route } = harness({ dreamEngine: engine })
  const accepted = await call(route.handler, { method: 'POST', url: PREFIX + 'dream/run', body: '{}', origin: ORIGIN })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.json.ok, true)
  assert.equal(accepted.json.accepted, true)
  assert.equal(accepted.json.runId, null)
  assert.deepEqual(engine.calls[0], { trigger: 'manual', source: 'api' })

  engine.running = true
  const busy = await call(route.handler, { method: 'POST', url: PREFIX + 'dream/run', body: '{}', origin: ORIGIN })
  assert.equal(busy.status, 409)
  assert.equal(busy.json.error.code, 'dream_running')
  assert.equal(engine.calls.length, 1)

  const syncEngine = makeDreamEngine({ run: () => ({ runId: 'dream_sync' }) })
  const syncHarness = harness({ dreamEngine: syncEngine })
  const sync = await call(syncHarness.route.handler, { method: 'POST', url: PREFIX + 'dream/run', body: '{}', origin: ORIGIN })
  assert.equal(sync.json.runId, 'dream_sync')

  const unavailable = harness({ dreamEngine: undefined, revertEdit: undefined })
  const missing = await call(unavailable.route.handler, { method: 'POST', url: PREFIX + 'dream/run', body: '{}', origin: ORIGIN })
  assert.equal(missing.status, 503)
  assert.equal(missing.json.error.code, 'dream_unavailable')
})

test('POST edits/revert delegates to the host callback and reports conflicts', async () => {
  const calls = []
  const revertEdit = async (editId, opts) => {
    calls.push({ editId, opts })
    if (editId === 'edit_2') return { ok: false, reason: 'conflict' }
    return { ok: true, edit: { ...makeEdits()[0], status: 'reverted', revertedAt: NOW } }
  }
  const { route } = harness({ revertEdit })

  const reverted = await call(route.handler, {
    method: 'POST',
    url: PREFIX + 'edits/revert',
    body: JSON.stringify({ editId: 'edit_1' }),
    origin: ORIGIN,
  })
  assert.equal(reverted.status, 200)
  assert.equal(reverted.json.ok, true)
  assert.equal(reverted.json.edit.status, 'reverted')
  assert.equal(reverted.json.edit.hasBackup, true)
  assert.equal(calls[0].editId, 'edit_1')
  assert.equal(typeof calls[0].opts.reason, 'string')

  const conflict = await call(route.handler, {
    method: 'POST',
    url: PREFIX + 'edits/revert',
    body: JSON.stringify({ editId: 'edit_2' }),
    origin: ORIGIN,
  })
  assert.equal(conflict.status, 200)
  assert.equal(conflict.json.ok, false)
  assert.equal(conflict.json.reason, 'conflict')
})

test('POST edits/revert falls back to dreamEngine.revertEdit and answers 503 when unavailable', async () => {
  const engine = makeDreamEngine({
    async revertEdit(editId) {
      return { ok: true, edit: { ...makeEdits()[0], id: editId, status: 'reverted' } }
    },
  })
  const fallback = harness({ dreamEngine: engine })
  const response = await call(fallback.route.handler, {
    method: 'POST',
    url: PREFIX + 'edits/revert',
    body: JSON.stringify({ editId: 'edit_1' }),
    origin: ORIGIN,
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)

  const unavailable = harness({ dreamEngine: undefined, revertEdit: undefined })
  const missing = await call(unavailable.route.handler, {
    method: 'POST',
    url: PREFIX + 'edits/revert',
    body: JSON.stringify({ editId: 'edit_1' }),
    origin: ORIGIN,
  })
  assert.equal(missing.status, 503)
  assert.equal(missing.json.error.code, 'revert_unavailable')
})

test('installApi registers exactly one prefix route and its disposer rejects later requests', async () => {
  const { routes, route, dispose } = harness()
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, ROUTE_PATH)
  dispose()
  dispose()
  assert.equal(routes[0].disposed, true)
  const afterDispose = await call(route.handler, { method: 'GET', url: PREFIX + 'summary' })
  assert.equal(afterDispose.status, 503)
  assert.equal(afterDispose.json.error.code, 'api_disposed')
})

test('installApi degrades to a no-op when webServer is missing', () => {
  const warnings = []
  const dispose = installApi({
    ctx: {},
    store: makeStore(),
    logger: { warn: (message) => warnings.push(String(message)) },
  })
  assert.equal(typeof dispose, 'function')
  assert.equal(warnings.some((message) => message.includes('webServer')), true)
  assert.doesNotThrow(() => dispose())
})

test('real node:http server round-trips JSON, enforces 405/413/403 and streams bodies', async () => {
  const { route } = harness()
  const server = createServer((req, res) => {
    void route.handler(req, res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  try {
    const summary = await fetch(`${base}${PREFIX}summary`)
    assert.equal(summary.status, 200)
    assert.equal(summary.headers.get('cache-control'), 'no-store')
    assert.match(String(summary.headers.get('content-type')), /^application\/json/)
    const payload = await summary.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.overall.consciousness > 0, true)

    const wrongMethod = await fetch(`${base}${PREFIX}summary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.get('allow'), 'GET')

    const crossOrigin = await fetch(`${base}${PREFIX}dream/run`, {
      method: 'POST',
      headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(crossOrigin.status, 403)
    assert.equal((await crossOrigin.json()).error.code, 'forbidden_origin')

    const accepted = await fetch(`${base}${PREFIX}dream/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(accepted.status, 200)
    assert.equal((await accepted.json()).accepted, true)

    // Declared length over the cap is rejected before the body is buffered.
    const huge = 'x'.repeat(70 * 1024)
    const oversized = await fetch(`${base}${PREFIX}dream/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: huge }),
    })
    assert.equal(oversized.status, 413)
    assert.equal((await oversized.json()).error.code, 'payload_too_large')

    // Chunked body (no content-length) is rejected while streaming.
    const chunkedBody = new ReadableStream({
      start(controller) {
        for (let index = 0; index < 20; index += 1) controller.enqueue(new TextEncoder().encode('y'.repeat(8 * 1024)))
        controller.close()
      },
    })
    const chunked = await fetch(`${base}${PREFIX}dream/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chunkedBody,
      duplex: 'half',
    })
    assert.equal(chunked.status, 413)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})

// ---------------------------------------------------------------------------------------------
// static checks: client.js + locale dictionaries
// ---------------------------------------------------------------------------------------------

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const localeEn = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
const localeZh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))

/** Flatten a nested locale object to its dotted leaf keys. */
function flattenKeys(value, prefix = '', out = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix) out.push(prefix)
    return out
  }
  for (const [key, child] of Object.entries(value)) {
    flattenKeys(child, prefix ? `${prefix}.${key}` : key, out)
  }
  return out
}

/** Extract the inline `const <name> = {...}` dictionary literal from client.js. */
function extractDictionary(name) {
  const marker = `const ${name} = `
  const start = clientSource.indexOf(marker)
  assert.notEqual(start, -1, `client.js should define ${name}`)
  const from = start + marker.length
  const end = clientSource.indexOf('\n    };', from)
  assert.notEqual(end, -1, `client.js should terminate ${name} with a 4-space indent`)
  const literal = clientSource.slice(from, end + '\n    }'.length)
  return JSON.parse(literal)
}

test('locale files parse and expose the same key set in both languages', () => {
  for (const [name, locale] of [['en', localeEn], ['zh', localeZh]]) {
    assert.equal(typeof locale.meta.title, 'string', `${name} meta.title`)
    assert.equal(typeof locale.meta.description, 'string', `${name} meta.description`)
    assert.equal(typeof locale.panel.title, 'string', `${name} panel.title`)
    for (const key of flattenKeys(locale)) {
      const value = key.split('.').reduce((node, part) => node[part], locale)
      assert.equal(typeof value, 'string', `${name}.${key} should be a string`)
      assert.equal(value.length > 0, true, `${name}.${key} should not be empty`)
    }
  }
  const enKeys = flattenKeys(localeEn).sort()
  const zhKeys = flattenKeys(localeZh).sort()
  assert.deepEqual(zhKeys, enKeys, 'en and zh must define the same keys')
})

test('client.js dictionaries stay in parity with the locale files and with every t() call', () => {
  const zhDictionary = extractDictionary('zh')
  const enDictionary = extractDictionary('en')
  const localeEnKeys = flattenKeys(localeEn).sort()
  const localeZhKeys = flattenKeys(localeZh).sort()
  assert.deepEqual(Object.keys(zhDictionary).sort(), localeZhKeys, 'client zh dictionary must match locale/zh.json')
  assert.deepEqual(Object.keys(enDictionary).sort(), localeEnKeys, 'client en dictionary must match locale/en.json')
  assert.deepEqual(Object.keys(zhDictionary).sort(), Object.keys(enDictionary).sort(), 'inline dictionaries must share keys')

  const used = new Set()
  // Static calls: t('panel.key') and t('panel.key', params). Dynamic concatenations such as
  // t('panel.' + verdictKey(...)) are checked separately through the key namespaces below.
  for (const match of clientSource.matchAll(/\bt\(\s*'([^']+)'\s*[,)]/g)) used.add(match[1])
  assert.equal(used.size > 40, true, 'the page should use a substantial number of localized keys')
  for (const key of used) {
    assert.equal(typeof zhDictionary[key], 'string', `zh dictionary is missing t('${key}')`)
    assert.equal(typeof enDictionary[key], 'string', `en dictionary is missing t('${key}')`)
  }
})

test('client.js follows the ModuleLoader shape and imports only react', () => {
  assert.equal(clientSource.includes('window.__ModuleLoader__.load({'), true)
  assert.match(clientSource, /id:\s*'dsh-plugin-dreaming'/)
  const requires = [...clientSource.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
  assert.deepEqual(requires, ['react'], 'the client may require only react')
  assert.equal(clientSource.includes('@deepseek-ai/'), false, 'no Harness client package may be imported')
  assert.equal(clientSource.includes('React.createElement'), true)
  assert.equal(clientSource.includes('jsx'), false)
  // No JSX component elements (uppercase tags); lowercase comparisons like `trend < 0` are fine.
  assert.equal(/<[A-Z][A-Za-z0-9.]*[\s/>]/.test(clientSource), false, 'client.js must not use JSX')
  // No direct DOM writes outside the component tree.
  assert.equal(clientSource.includes('document.body'), false)
  assert.equal(clientSource.includes('appendChild'), false)
  assert.equal(clientSource.includes('insertBefore'), false)
})

test('client.js registers the dreaming settings section with the documented options only', () => {
  assert.equal(clientSource.includes("ctx.slots.inject('settings.section'"), true)
  const registerMatch = clientSource.match(/ctx\.slots\.register\(\{([\s\S]*?)\},\s*\(props\)/)
  assert.notEqual(registerMatch, null, 'expected a settings.section register call')
  const block = registerMatch[1]
  assert.match(block, /name:\s*'settings\.section'/)
  assert.match(block, /id:\s*'dreaming'/)
  assert.match(block, /order:\s*95/)
  assert.match(block, /label:\s*\(\)\s*=>/)
  assert.equal(block.includes('locale:'), false, 'unknown slot options must not be passed')
  const options = [...block.matchAll(/([A-Za-z]+):/g)].map((match) => match[1])
  for (const option of options) {
    assert.equal(['name', 'id', 'order', 'label'].includes(option), true, `unexpected slot option: ${option}`)
  }
})

test('client.js polls only while visible and clears its interval', () => {
  assert.equal(clientSource.includes('30000'), true)
  assert.equal(clientSource.includes('clearInterval'), true)
  assert.equal(clientSource.includes("document.visibilityState === 'visible'"), true)
  assert.equal(clientSource.includes("'visibilitychange'"), true)
})

test('client.js styles use theme tokens, not literal colors', () => {
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(clientSource), false, 'no hex colors')
  assert.equal(/rgb\(|rgba\(|hsl\(/.test(clientSource), false, 'no literal rgb/hsl colors')
  assert.equal(clientSource.includes('var(--dsw-alias-'), true)
})

test('locale dictionary covers the overview, skills, episode and journal surfaces', () => {
  for (const key of [
    'panel.consciousness',
    'panel.judged',
    'panel.wasteRate',
    'panel.spent',
    'panel.avoided',
    'panel.nextDream',
    'panel.skills',
    'panel.awareness',
    'panel.fitAccuracy',
    'panel.boundaryAccuracy',
    'panel.waste',
    'panel.trend',
    'panel.lastUsed',
    'panel.edits',
    'panel.episodes',
    'panel.prediction',
    'panel.trace',
    'panel.judge',
    'panel.dreamJournal',
    'panel.revert',
    'panel.dreamNow',
    'panel.refresh',
    'panel.loading',
    'panel.error',
    'panel.retry',
  ]) {
    assert.equal(typeof localeEn.panel[key.replace('panel.', '')], 'string', `en ${key}`)
    assert.equal(typeof localeZh.panel[key.replace('panel.', '')], 'string', `zh ${key}`)
  }
})

// ---------------------------------------------------------------------------------------------
// client render smoke test
//
// The client bundle is plain React.createElement code with no build step and no
// availability of the Host React runtime in unit tests. To prove the page actually
// renders (instead of only parsing), this section evaluates client.js against a
// minimal React-compatible hook runtime, a fake DOM and a fake fetch. It catches
// render-path crashes, missing-field crashes and wiring regressions that the static
// source checks cannot see.
// ---------------------------------------------------------------------------------------------

/**
 * Create a minimal React 18-compatible runtime: createElement, Fragment, hooks and a
 * tree renderer. It deliberately supports only what client.js uses.
 * @returns {object} runtime with React export plus mount/settle/unmount helpers.
 */
function createFakeReact() {
  const Fragment = Symbol('react.fragment')
  const instances = new Map()
  let current = null
  let dirty = true
  let rootElement = null
  let tree = null
  let nextInstanceId = 0
  let pendingEffects = []
  let mountCount = 0

  function sameDeps(left, right) {
    if (left === null || right === null || !Array.isArray(left) || !Array.isArray(right)) return false
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!Object.is(left[index], right[index])) return false
    }
    return true
  }

  function instanceOf() {
    let instance = instances.get(current.id)
    if (instance === undefined) {
      instance = { hooks: [], effects: [], pending: [] }
      instances.set(current.id, instance)
    }
    return instance
  }

  function createElement(type, props, ...children) {
    const normalized = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: { ...(props || {}), children: normalized } }
  }

  function useState(initial) {
    const instance = instanceOf()
    const index = current.index
    current.index += 1
    if (instance.hooks[index] === undefined) {
      instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    }
    const slot = instance.hooks[index]
    const instanceId = current.id
    const setState = (next) => {
      const target = instances.get(instanceId)
      if (target === undefined) return
      const value = typeof next === 'function' ? next(target.hooks[index].value) : next
      if (Object.is(value, target.hooks[index].value)) return
      target.hooks[index].value = value
      dirty = true
    }
    return [slot.value, setState]
  }

  function useRef(initial) {
    const instance = instanceOf()
    const index = current.index
    current.index += 1
    if (instance.hooks[index] === undefined) instance.hooks[index] = { current: initial }
    return instance.hooks[index]
  }

  function useCallback(fn, deps) {
    const instance = instanceOf()
    const index = current.index
    current.index += 1
    const previous = instance.hooks[index]
    if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.fn
    instance.hooks[index] = { fn, deps: Array.isArray(deps) ? deps.slice() : null }
    return fn
  }

  function useMemo(factory, deps) {
    const instance = instanceOf()
    const index = current.index
    current.index += 1
    const previous = instance.hooks[index]
    if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
    const value = factory()
    instance.hooks[index] = { value, deps: Array.isArray(deps) ? deps.slice() : null }
    return value
  }

  function useEffect(fn, deps) {
    const instance = instanceOf()
    const index = current.index
    current.index += 1
    instance.pending.push({ index, fn, deps: Array.isArray(deps) ? deps.slice() : null })
  }

  const React = { Fragment, createElement, useState, useRef, useCallback, useMemo, useEffect }

  function renderChildren(children) {
    if (children === null || children === undefined || typeof children === 'boolean') return []
    const flattened = Array.isArray(children) ? children.flat(Infinity) : [children]
    const out = []
    for (const child of flattened) {
      const node = renderNode(child)
      if (node !== null && node !== undefined) out.push(node)
    }
    return out
  }

  function renderNode(element) {
    if (element === null || element === undefined || typeof element === 'boolean') return null
    if (typeof element === 'string' || typeof element === 'number') return { text: String(element) }
    if (Array.isArray(element)) return renderChildren(element)
    const type = element.type
    const props = element.props || {}
    if (type === Fragment) return { type: 'fragment', props, children: renderChildren(props.children) }
    if (typeof type === 'function') {
      const id = nextInstanceId
      nextInstanceId += 1
      let instance = instances.get(id)
      if (instance === undefined) {
        instance = { hooks: [], effects: [], pending: [] }
        instances.set(id, instance)
      }
      instance.pending = []
      const parent = current
      current = { id, index: 0 }
      let output
      try {
        output = type(props)
      } finally {
        current = parent
      }
      for (const effect of instance.pending) pendingEffects.push({ ...effect, instanceId: id })
      return renderNode(output)
    }
    return { type, props, children: renderChildren(props.children) }
  }

  function flushEffects() {
    const queue = pendingEffects
    pendingEffects = []
    for (const job of queue) {
      const instance = instances.get(job.instanceId)
      if (instance === undefined) continue
      const previous = instance.effects[job.index]
      if (previous !== undefined && sameDeps(previous.deps, job.deps)) continue
      if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
      const cleanup = job.fn()
      instance.effects[job.index] = {
        deps: job.deps,
        cleanup: typeof cleanup === 'function' ? cleanup : null,
      }
    }
  }

  function renderOnce() {
    nextInstanceId = 0
    pendingEffects = []
    tree = renderNode(rootElement)
    flushEffects()
    mountCount += 1
  }

  function mount(element) {
    rootElement = element
    dirty = true
    for (let pass = 0; pass < 30 && dirty; pass += 1) {
      dirty = false
      renderOnce()
    }
    return tree
  }

  async function settle() {
    for (let round = 0; round < 20; round += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      if (!dirty) {
        await new Promise((resolve) => setImmediate(resolve))
        if (!dirty) return tree
      }
      for (let pass = 0; pass < 20 && dirty; pass += 1) {
        dirty = false
        renderOnce()
      }
    }
    return tree
  }

  function unmount() {
    for (const instance of instances.values()) {
      for (const effect of Object.values(instance.effects)) {
        if (typeof effect.cleanup === 'function') effect.cleanup()
      }
    }
    instances.clear()
    rootElement = null
    tree = null
  }

  function textOf(node) {
    if (node === null || node === undefined) return ''
    if (typeof node.text === 'string') return node.text
    return (node.children || []).map(textOf).filter(Boolean).join(' ')
  }

  function findAll(node, predicate, out = []) {
    if (node === null || node === undefined) return out
    if (predicate(node)) out.push(node)
    for (const child of node.children || []) findAll(child, predicate, out)
    return out
  }

  return {
    React,
    mount,
    settle,
    unmount,
    getTree: () => tree,
    getText: () => textOf(tree),
    getRenderCount: () => mountCount,
    findButton(label) {
      const matches = findAll(tree, (node) => node.type === 'button' && textOf(node).includes(label))
      assert.equal(matches.length > 0, true, `expected a button containing "${label}" in: ${textOf(tree)}`)
      return matches[0]
    },
    findAll,
    textOf,
  }
}

/** A JSON-shaped fetch response. */
function fakeJsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

/**
 * Install a scripted fetch and return the recorded calls.
 * @param {Array<object>} routes route matchers.
 * @returns {{calls: object[], restore: Function}} fetch control.
 */
function installFakeFetch(routes) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    const request = {
      url: String(url),
      method: typeof options.method === 'string' ? options.method : 'GET',
      body: typeof options.body === 'string' ? options.body : null,
    }
    calls.push(request)
    const route = routes.find((candidate) => {
      const method = candidate.method || 'GET'
      if (method !== request.method) return false
      return candidate.test.test(request.url)
    })
    if (route === undefined) return fakeJsonResponse(404, { ok: false, error: { code: 'not_found', message: 'no route' } })
    if (route.networkError === true) throw new Error('network down')
    const payload = typeof route.payload === 'function' ? route.payload(request) : route.payload
    return fakeJsonResponse(200, payload)
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

function makeSummaryPayload() {
  return {
    ok: true,
    generatedAt: new Date(NOW).toISOString(),
    overall: {
      consciousness: 73,
      skillsTracked: 2,
      skillsJudged: 9,
      episodes: 12,
      judged: 9,
      loads: 12,
      wasteRate: 0.12,
      wastedTokens: 1300,
      skillLoadTokens: 9800,
      probeTokens: 5400,
      judgeTokens: 7600,
      dreamTokens: 1200,
      estimatedWasteAvoided: 800,
      worstSkill: 'office-xlsx',
      confidence: 'medium',
    },
    skills: [
      {
        name: 'office-xlsx',
        source: 'user-dsh',
        editable: true,
        loads: 8,
        judged: 6,
        consciousness: 73,
        fitAccuracy: 0.71,
        boundaryAccuracy: 0.67,
        precision: 0.875,
        wasteRate: 0.12,
        trend: 2.4,
        confidence: 'medium',
        meanScore: 74.2,
        lastUsedAt: NOW - 1000,
        appliedEdits: 1,
        wastedTokens: 140,
      },
    ],
    dream: {
      enabled: true,
      running: false,
      lastRunAt: NOW - 86400000,
      lastRunId: 'dream_1',
      nextRunAt: NOW + 3600000,
      consecutiveFailures: 0,
      time: '03:30',
      timeZone: '',
      autoApply: true,
      dailyTokenBudget: 60000,
    },
    config: {
      enabled: true,
      probe: { enabled: true, mode: 'inline', sampleRate: 1, maxPerHour: 120, alwaysForGapSkills: true },
      judge: { enabled: true },
      prompt: { awarenessSection: true, annotateSkillResult: true, maxSkills: 8 },
      dream: { enabled: true, mode: 'auto', time: '03:30', timeZone: '', autoApply: true, dailyTokenBudget: 60000 },
      store: { retainDays: 120, maxEpisodes: 4000, maxSkills: 400 },
      api: { enabled: true },
    },
    store: { ready: true, dir: tempDir, error: null, revision: 3 },
    dataDir: tempDir,
  }
}

function makeEpisodesPayload() {
  return {
    ok: true,
    generatedAt: new Date(NOW).toISOString(),
    items: [
      {
        id: 'ep_1',
        skill: 'office-xlsx',
        startedAt: NOW - 60000,
        endedAt: NOW - 20000,
        state: 'judged',
        turn: 3,
        step: 1,
        skillMeta: { description: 'Spreadsheet work', source: 'user-dsh', bodyChars: 4200, bodyTokens: 1200 },
        prediction: {
          fit: 0.72,
          confidence: 0.6,
          intent: 'Build an xlsx report',
          expectedUse: ['Read workbooks', 'Write formulas'],
          likelyPitfalls: ['Large sheets time out'],
          capabilityGap: 'No chart export',
          cheaperAlternative: '',
          expectedValueTokens: 1200,
        },
        probe: { backend: 'inline', model: 'deepseek-flash', status: 'ok', tokensIn: 1500, tokensOut: 300, latencyMs: 2100, error: null },
        call: { isError: false, durationMs: 40, contentChars: 4300 },
        trace: {
          observedMs: 42000,
          turnEnd: 'completed',
          assistantTexts: ['Wrote the workbook'],
          userMessages: ['Add a summary sheet'],
          toolSequence: [{ name: 'read', ok: true, brief: 'read the template' }, { name: 'write', ok: false, brief: 'failed once' }],
          skillReLoaded: false,
          finalAnswerChars: 800,
        },
        judge: {
          status: 'ok',
          model: 'deepseek-flash',
          score: 78,
          verdict: 'partial',
          predictionAccuracy: 0.55,
          capabilityGap: { present: true, claim: 'Charts supported', reality: 'No chart export' },
          mismatches: [{ expected: 'Charts', observed: 'No charts', cause: 'description claim' }],
          rootCause: 'description',
          reusableRule: 'State chart limits explicitly',
          recommendation: { descriptionEdit: 'Describe chart limits', bodyAddition: 'Chart export is unavailable.', selectionRule: 'Use for tabular data only' },
        },
        cost: { probe: 1800, judge: 2550, skillLoad: 1200, reworkEstimate: 0, wastedEstimate: 100 },
        flags: { sampled: false, truncated: false, abandoned: false, dreamIds: ['dream_1'] },
      },
    ],
    offset: 0,
    limit: 20,
    hasMore: false,
    filter: { skill: null, verdict: null, mismatchedOnly: false },
  }
}

function makeDreamsPayload() {
  return {
    ok: true,
    generatedAt: new Date(NOW).toISOString(),
    items: [
      {
        id: 'dream_1',
        trigger: 'schedule',
        startedAt: NOW - 86400000,
        endedAt: NOW - 86000000,
        status: 'ok',
        mode: 'inline',
        before: { consciousness: 62, episodes: 40, wastedTokens: 5200 },
        afterEstimate: { consciousness: 66, wastedTokensAvoided: 1800 },
        cases: 6,
        tokens: { in: 8000, out: 1500 },
        error: null,
        skills: [
          {
            skill: 'office-xlsx',
            applied: true,
            status: 'applied',
            caseIds: ['ep_1'],
            editIds: ['edit_1'],
            error: null,
            rejectionReason: null,
            proposal: {
              confidence: 0.7,
              descriptionEdit: 'Sharper description',
              bodyAddition: 'Chart export is unavailable.',
              selectionRule: 'Use for tabular data only',
            },
          },
        ],
      },
    ],
  }
}

function makeClientEditsPayload() {
  return {
    ok: true,
    generatedAt: new Date(NOW).toISOString(),
    items: [
      {
        id: 'edit_1',
        dreamId: 'dream_1',
        skill: 'office-xlsx',
        kind: 'description',
        appliedAt: NOW - 500,
        revertedAt: 0,
        status: 'applied',
        hasBackup: true,
      },
    ],
  }
}

/** Routes for a fully populated page. */
function populatedRoutes(overrides = {}) {
  return [
    { test: /\/summary$/, payload: overrides.summary ?? makeSummaryPayload() },
    { test: /\/episodes\?/, payload: overrides.episodes ?? makeEpisodesPayload() },
    { test: /\/dreams\?/, payload: overrides.dreams ?? makeDreamsPayload() },
    { test: /\/edits\/revert$/, method: 'POST', payload: overrides.revert ?? { ok: true } },
    { test: /\/edits\?/, payload: overrides.edits ?? makeClientEditsPayload() },
    { test: /\/dream\/run$/, method: 'POST', payload: overrides.dreamRun ?? { ok: true, accepted: true, runId: null } },
  ]
}

/**
 * Evaluate client.js against the fake React runtime and mount the settings page.
 * @param {object} options routes and locale overrides.
 * @returns {Promise<object>} mounted page harness.
 */
async function mountClientPage(options = {}) {
  const handlers = []
  const listeners = new Map()
  const fakeDocument = {
    visibilityState: 'visible',
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type)
    },
  }
  const fakeNavigator = { language: options.language || 'en' }
  const evaluate = new Function('window', 'navigator', 'document', clientSource)
  evaluate({ __ModuleLoader__: { load: (registration) => handlers.push(registration) } }, fakeNavigator, fakeDocument)
  assert.equal(handlers.length, 1)
  assert.equal(handlers[0].id, 'dsh-plugin-dreaming')

  const runtime = createFakeReact()
  const requireCalls = []
  const plugin = handlers[0].factory((specifier) => {
    requireCalls.push(specifier)
    assert.equal(specifier, 'react')
    return runtime.React
  })
  assert.deepEqual(requireCalls, ['react'])

  const registrations = []
  const locale = {
    getLocale: () => ({ language: fakeNavigator.language }),
    register: () => () => {},
    subscribe: () => () => {},
  }
  const ctx = {
    slots: {
      inject(name, factory) {
        assert.equal(name, 'settings.section')
        return factory()
      },
      register(registerOptions, Component) {
        registrations.push({ options: registerOptions, Component })
        return () => {}
      },
    },
    get(name) {
      return name === 'locale' ? locale : undefined
    },
    effect(callback) {
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
  plugin.apply(ctx)
  assert.equal(registrations.length, 1)
  const page = registrations[0]
  assert.equal(typeof page.Component, 'function')

  const fetchControl = installFakeFetch(options.routes ?? populatedRoutes())
  const intervalSpy = spyIntervals()
  try {
    runtime.mount(runtime.React.createElement(page.Component, { close: () => {} }))
    await runtime.settle()
    return { runtime, page, fetchControl, intervalSpy, fakeDocument, listeners, registrations }
  } catch (error) {
    fetchControl.restore()
    intervalSpy.restore()
    throw error
  }
}

/** Spy on the global interval functions so the cleanup contract is observable. */
function spyIntervals() {
  const created = []
  const cleared = []
  const originalSet = globalThis.setInterval
  const originalClear = globalThis.clearInterval
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms }
    created.push(handle)
    return handle
  }
  globalThis.clearInterval = (handle) => {
    cleared.push(handle)
  }
  return {
    created,
    cleared,
    restore() {
      globalThis.setInterval = originalSet
      globalThis.clearInterval = originalClear
    },
  }
}

test('client page mounts against the API payloads and renders every dashboard section', async () => {
  const mounted = await mountClientPage()
  try {
    const text = mounted.runtime.getText()
    assert.match(text, /Consciousness strength/)
    assert.match(text, /73/)
    assert.match(text, /office-xlsx/)
    assert.match(text, /Dream now/)
    assert.match(text, /Refresh/)
    assert.match(text, /Dream journal/)
    assert.match(text, /Recent skill calls/)
    assert.match(text, /Updated /)
    assert.equal(mounted.fetchControl.calls.some((call) => call.url.endsWith('/summary')), true)
    assert.equal(mounted.fetchControl.calls.filter((call) => call.url.includes('/episodes?')).length, 1)
    assert.equal(mounted.fetchControl.calls.some((call) => call.url.includes('/dreams?')), true)
    assert.equal(mounted.fetchControl.calls.some((call) => call.url.includes('/edits?')), true)
    assert.equal(mounted.fetchControl.calls.filter((call) => call.method === 'GET').length, 4)
    // Every request is relative to the page origin.
    for (const call of mounted.fetchControl.calls) {
      assert.equal(call.url.startsWith('/dreaming/api/'), true)
    }
  } finally {
    mounted.runtime.unmount()
    mounted.fetchControl.restore()
    mounted.intervalSpy.restore()
  }
})

test('client episode inspector expands to prediction, judge and observation details', async () => {
  const mounted = await mountClientPage()
  try {
    const before = mounted.runtime.getText()
    assert.equal(before.includes('Observation'), false, 'details start collapsed')
    const episodeButton = mounted.runtime.findButton('office-xlsx')
    episodeButton.props.onClick()
    await mounted.runtime.settle()
    const expanded = mounted.runtime.getText()
    assert.match(expanded, /Prediction/)
    assert.match(expanded, /Judge/)
    assert.match(expanded, /Observation/)
    assert.match(expanded, /Mismatches/)
    assert.match(expanded, /Chart export is unavailable/)
    assert.match(expanded, /Tool calls/)
    assert.match(expanded, /Observed 42s/)
  } finally {
    mounted.runtime.unmount()
    mounted.fetchControl.restore()
    mounted.intervalSpy.restore()
  }
})

test('client filter, dream-now and revert actions exercise the mutation routes', async () => {
  const mounted = await mountClientPage()
  try {
    // Mismatch filter refetches episodes with the filter query.
    mounted.runtime.findButton('Mismatched').props.onClick()
    await mounted.runtime.settle()
    assert.equal(mounted.fetchControl.calls.some((call) => call.url.includes('filter=mismatch')), true)

    // Dream now posts and shows the localized confirmation.
    mounted.runtime.findButton('Dream now').props.onClick()
    await mounted.runtime.settle()
    const dreamCall = mounted.fetchControl.calls.find((call) => call.method === 'POST' && call.url.endsWith('/dream/run'))
    assert.notEqual(dreamCall, undefined)
    assert.match(mounted.runtime.getText(), /Dream run started/)

    // Revert posts the edit id from the journal.
    mounted.runtime.findButton('Revert').props.onClick()
    await mounted.runtime.settle()
    const revertCall = mounted.fetchControl.calls.find((call) => call.method === 'POST' && call.url.endsWith('/edits/revert'))
    assert.notEqual(revertCall, undefined)
    assert.deepEqual(JSON.parse(revertCall.body), { editId: 'edit_1' })
    assert.match(mounted.runtime.getText(), /Reverted/)
  } finally {
    mounted.runtime.unmount()
    mounted.fetchControl.restore()
    mounted.intervalSpy.restore()
  }
})

test('client page survives empty and partial payloads without crashing', async () => {
  const routes = [
    {
      test: /\/summary$/,
      payload: {
        ok: true,
        generatedAt: new Date(NOW).toISOString(),
        overall: {},
        skills: [],
        dream: {},
        config: {},
        store: { ready: true, dir: null, error: null, revision: 0 },
        dataDir: null,
      },
    },
    { test: /\/episodes\?/, payload: { ok: true, items: [], hasMore: false } },
    { test: /\/dreams\?/, payload: { ok: true, items: [] } },
    { test: /\/edits\?/, payload: { ok: true, items: [] } },
  ]
  const mounted = await mountClientPage({ routes })
  try {
    const text = mounted.runtime.getText()
    assert.match(text, /Skills appear after/)
    assert.match(text, /No episodes match this filter/)
    assert.match(text, /No dream run yet/)
    assert.match(text, /Never/)
  } finally {
    mounted.runtime.unmount()
    mounted.fetchControl.restore()
    mounted.intervalSpy.restore()
  }
})

test('client page renders the error state with a retry action and recovers', async () => {
  let allowSuccess = false
  const routes = populatedRoutes().map((route) => ({
    ...route,
    get networkError() {
      return !allowSuccess
    },
  }))
  const mounted = await mountClientPage({ routes })
  try {
    assert.match(mounted.runtime.getText(), /Could not load dreaming data/)
    assert.match(mounted.runtime.getText(), /Retry/)
    allowSuccess = true
    mounted.runtime.findButton('Retry').props.onClick()
    await mounted.runtime.settle()
    assert.match(mounted.runtime.getText(), /Consciousness strength/)
  } finally {
    mounted.runtime.unmount()
    mounted.fetchControl.restore()
    mounted.intervalSpy.restore()
  }
})

test('client polling is visibility-aware, 30s and cleaned up on unmount', async () => {
  const mounted = await mountClientPage()
  try {
    assert.equal(mounted.intervalSpy.created.length, 1)
    assert.equal(mounted.intervalSpy.created[0].ms, 30000)
    assert.equal(mounted.listeners.has('visibilitychange'), true)

    // Hidden tabs do not poll.
    const callsBeforeHidden = mounted.fetchControl.calls.length
    mounted.fakeDocument.visibilityState = 'hidden'
    await mounted.intervalSpy.created[0].fn()
    await mounted.runtime.settle()
    assert.equal(mounted.fetchControl.calls.length, callsBeforeHidden)

    // Becoming visible triggers one refresh.
    mounted.fakeDocument.visibilityState = 'visible'
    mounted.listeners.get('visibilitychange')()
    await mounted.runtime.settle()
    assert.equal(mounted.fetchControl.calls.length > callsBeforeHidden, true)
  } finally {
    const interval = mounted.intervalSpy.created[0]
    mounted.runtime.unmount()
    mounted.fetchControl.restore()
    assert.equal(mounted.intervalSpy.cleared.includes(interval), true)
    mounted.intervalSpy.restore()
    assert.equal(mounted.listeners.has('visibilitychange'), false)
  }
})

