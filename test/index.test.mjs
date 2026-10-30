import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, inject, name, __internals } from '../index.js'

function quietLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} }
}

function createFakeContext({ services = {} } = {}) {
  const listeners = new Map()
  const sections = []
  const tools = []
  const cleanups = []
  const injections = []
  const ctx = {
    logger: quietLogger(),
    fiber: { marker: 'fiber' },
    on(event, handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
      return () => {}
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    get(service) {
      return services[service]
    },
    inject(dependencies, callback) {
      injections.push(dependencies)
      const available = dependencies.every((dependency) => services[dependency] !== undefined)
      if (!available) return undefined
      const child = createFakeContext({ services }).ctx
      child.parent = ctx
      callback(child)
      return child
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') cleanups.push(disposer)
      return disposer
    },
  }
  // Injected services are reachable both through ctx.get(name) and as ctx.<name>.
  for (const [name, service] of Object.entries(services)) {
    if (!Object.hasOwn(ctx, name)) ctx[name] = service
  }
  return { ctx, listeners, sections, tools, cleanups, injections }
}

function skillExec(overrides = {}) {
  return {
    name: 'skill',
    callId: 'call-1',
    arguments: { name: 'office-xlsx' },
    agent: { id: 'session-1' },
    signal: new AbortController().signal,
    ...overrides,
  }
}

test('module exports the plugin identity and required service declarations', () => {
  assert.equal(name, 'dreaming')
  assert.ok(Array.isArray(inject))
  for (const service of ['tools', 'systemPrompt', 'skills', 'llm']) assert.ok(inject.includes(service))
})

test('apply registers the awareness section, the dreaming tool and the listeners', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dreaming-index-'))
  const { ctx, sections, tools, listeners, cleanups, injections } = createFakeContext()
  try {
    apply(ctx, {
      dataDir: dir,
      probe: { enabled: false },
      judge: { enabled: false },
      dream: { enabled: false },
      prompt: { awarenessSection: true },
    })
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'dreaming:capability-awareness')
    assert.equal(sections[0].interpolate, false, 'generated prose must stay out of {{variable}} interpolation')
    assert.equal(typeof sections[0].text, 'function')
    assert.equal(sections[0].text(), '')
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, 'dreaming')
    for (const event of ['tools/pre-execute', 'tools/post-execute', 'tools/result', 'session/event', 'agent/disposed', 'session/disposed']) {
      assert.ok((listeners.get(event)?.length ?? 0) === 1, `expected one listener for ${event}`)
    }
    assert.ok(injections.some((deps) => deps.includes('webServer')))
    assert.ok(injections.some((deps) => deps.includes('settings')))
    assert.equal(cleanups.length, 1)
  } finally {
    for (const cleanup of cleanups) {
      try {
        cleanup()
      } catch {
        // ignore
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the dashboard API is mounted only when api.enabled allows it', async () => {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const dirA = mkdtempSync(join(tmpdir(), 'dreaming-index-api-off-'))
  const dirB = mkdtempSync(join(tmpdir(), 'dreaming-index-api-on-'))
  const off = createFakeContext({ services: { webServer } })
  const on = createFakeContext({ services: { webServer } })
  try {
    apply(off.ctx, {
      dataDir: dirA,
      probe: { enabled: false },
      judge: { enabled: false },
      dream: { enabled: false },
      api: { enabled: false },
    })
    assert.equal(routes.length, 0, 'api.enabled=false must not register the dashboard route')
    apply(on.ctx, { dataDir: dirB, probe: { enabled: false }, judge: { enabled: false }, dream: { enabled: false } })
    assert.equal(routes.length, 1, 'api.enabled defaults to true and mounts the dashboard route')
    assert.equal(routes[0].kind, 'prefix')
    assert.match(String(routes[0].path), /^\/dreaming\/api/)
  } finally {
    for (const cleanup of [...off.cleanups, ...on.cleanups]) {
      try {
        cleanup()
      } catch {
        // ignore
      }
    }
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('an unexpected failure inside a listener never rejects the tool pipeline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dreaming-index-'))
  const { ctx, listeners, cleanups } = createFakeContext({
    services: {
      sessions: {
        get() {
          throw new Error('session registry exploded')
        },
      },
    },
  })
  try {
    apply(ctx, { dataDir: dir, probe: { enabled: false }, judge: { enabled: false }, dream: { enabled: false } })
    const pre = listeners.get('tools/pre-execute')[0]
    const next = async () => ({ kind: 'allow' })
    const decision = await pre(skillExec(), next)
    assert.deepEqual(decision, { kind: 'allow' })
    // A throw inside result handling is contained too.
    const resultHandler = listeners.get('tools/result')[0]
    assert.doesNotThrow(() => resultHandler(skillExec(), { isError: false, content: [] }))
  } finally {
    for (const cleanup of cleanups) cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('post-execute returns the downstream decision unchanged when there is nothing to annotate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dreaming-index-'))
  const { ctx, listeners, cleanups } = createFakeContext()
  try {
    apply(ctx, { dataDir: dir, probe: { enabled: false }, judge: { enabled: false }, dream: { enabled: false } })
    const handler = listeners.get('tools/post-execute')[0]
    const downstream = { kind: 'accept', content: [{ type: 'text', text: 'skill body' }] }
    const decision = await handler(skillExec(), { isError: false, content: downstream.content }, async () => downstream)
    assert.deepEqual(decision, downstream)
  } finally {
    for (const cleanup of cleanups) cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a first skill load gets the first-observation stub exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dreaming-index-first-'))
  const { ctx, listeners, cleanups } = createFakeContext()
  try {
    apply(ctx, { dataDir: dir, probe: { enabled: false }, judge: { enabled: false }, dream: { enabled: false } })
    const pre = listeners.get('tools/pre-execute')[0]
    const post = listeners.get('tools/post-execute')[0]
    const exec = skillExec({ callId: 'call-first', arguments: { name: 'fresh-skill' } })
    await pre(exec, async () => ({ kind: 'allow' }))
    const body = { type: 'text', text: '<skill_content>body</skill_content>' }
    const decision = await post(exec, { isError: false, content: [body] }, async () => ({ kind: 'accept' }))
    assert.equal(decision.kind, 'accept')
    assert.equal(decision.content.length, 2, 'exactly one text block is appended')
    assert.equal(decision.content[0], body)
    assert.equal(
      decision.content[1].text,
      '[dreaming] first observation for fresh-skill — no measured history yet; recording this turn.',
    )
    assert.equal((decision.content[1].text.match(/\[dreaming\]/g) ?? []).length, 1, 'never duplicated')

    // An errored load is never annotated, even when the stub would apply.
    const downstream = { kind: 'accept', content: [body] }
    const errored = await post(exec, { isError: true, content: [body] }, async () => downstream)
    assert.deepEqual(errored, downstream)
  } finally {
    for (const cleanup of cleanups) cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the first-observation stub is skipped when annotation is disabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dreaming-index-first-off-'))
  const { ctx, listeners, cleanups } = createFakeContext()
  try {
    apply(ctx, {
      dataDir: dir,
      probe: { enabled: false },
      judge: { enabled: false },
      dream: { enabled: false },
      prompt: { annotateSkillResult: false },
    })
    const pre = listeners.get('tools/pre-execute')[0]
    const post = listeners.get('tools/post-execute')[0]
    const exec = skillExec({ callId: 'call-first-off', arguments: { name: 'fresh-skill' } })
    await pre(exec, async () => ({ kind: 'allow' }))
    const body = { type: 'text', text: '<skill_content>body</skill_content>' }
    const decision = await post(exec, { isError: false, content: [body] }, async () => ({ kind: 'accept' }))
    assert.equal(decision.content, undefined, 'the stub must not bypass prompt.annotateSkillResult=false')
  } finally {
    for (const cleanup of cleanups) cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the model-facing tool reports an empty store without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dreaming-index-'))
  const { ctx, tools, cleanups } = createFakeContext()
  try {
    apply(ctx, { dataDir: dir, probe: { enabled: false }, judge: { enabled: false }, dream: { enabled: false } })
    const status = await tools[0].execute({ action: 'status' }, {})
    assert.equal(status.action, 'status')
    assert.match(status.text, /Consciousness strength: 0\/100/)
    const gaps = await tools[0].execute({ action: 'gaps', limit: 3 }, {})
    assert.equal(gaps.action, 'gaps')
    assert.ok(gaps.text.length > 0)
  } finally {
    for (const cleanup of cleanups) cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applying twice on two contexts is independent (no shared mutable state)', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'dreaming-index-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'dreaming-index-b-'))
  const a = createFakeContext()
  const b = createFakeContext()
  try {
    apply(a.ctx, { dataDir: dirA, probe: { enabled: false }, judge: { enabled: false }, dream: { enabled: false } })
    apply(b.ctx, { dataDir: dirB, probe: { enabled: false }, judge: { enabled: false }, dream: { enabled: false } })
    assert.equal(a.sections.length, 1)
    assert.equal(b.sections.length, 1)
    assert.notEqual(a.tools[0], b.tools[0])
  } finally {
    for (const cleanup of a.cleanups) cleanup()
    for (const cleanup of b.cleanups) cleanup()
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('the skill result is annotated from history even when the probe misses the deadline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dreaming-index-late-'))
  const now = Date.now()
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    v: 1,
    createdAt: now - 1000,
    totals: {},
    skills: {
      'demo-skill': {
        name: 'demo-skill',
        description: 'Analyze any dataset.',
        counts: { loads: 2, judged: 2, matched: 0, partial: 0, missed: 0, misapplied: 2, boundaryGaps: 2, failed: 0 },
        fitHistory: [{ t: now, fit: 0.2, success: 0.1, score: 10 }],
        cost: { probe: 0, judge: 0, skillLoad: 100, wasted: 100 },
        metrics: { meanScore: 10, fitAccuracy: 0.9, boundaryAccuracy: 0, precision: 0, consciousness: 20, wasteRate: 1, trend: 0, confidence: 'low' },
        learned: { whenToUse: [], whenNotToUse: ['Not for datasets.'], preconditions: [], actualScope: [], cheaperAlternatives: [], knownFailures: [], notes: [] },
        appliedEdits: [],
      },
    },
  }), 'utf8')
  const { ctx, listeners, cleanups } = createFakeContext({
    services: {
      skills: {
        async get() {
          return { name: 'demo-skill', description: 'd', source: 'user-dsh', provider: 'filesystem', content: 'body' }
        },
        async list() {
          return []
        },
      },
    },
  })
  try {
    apply(ctx, { dataDir: dir, judge: { enabled: false }, dream: { enabled: false }, probe: { attachDeadlineMs: 0 } })
    const post = listeners.get('tools/post-execute')[0]
    const body = { type: 'text', text: '<skill_content>body</skill_content>' }
    const exec = { name: 'skill', callId: 'call-never-probed', arguments: { name: 'demo-skill' }, agent: { id: 's-late' }, signal: new AbortController().signal }
    const decision = await post(exec, { isError: false, content: [body] }, async () => ({ kind: 'accept' }))
    assert.equal(decision.kind, 'accept')
    assert.equal(decision.content.length, 2)
    assert.match(decision.content[1].text, /not for: Not for datasets/i)
  } finally {
    for (const cleanup of cleanups) cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the skill result is annotated with learned awareness when a belief exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dreaming-index-annotate-'))
  const now = Date.now()
  const skill = {
    name: 'demo-skill',
    description: 'Analyze any dataset and produce charts.',
    whenToUse: '',
    source: 'user-dsh',
    provider: 'filesystem',
    path: '',
    resourceBase: null,
    editable: true,
    firstSeenAt: now,
    lastUsedAt: now,
    counts: { loads: 3, judged: 3, matched: 1, partial: 0, missed: 0, misapplied: 2, boundaryGaps: 2, failed: 0 },
    fitHistory: [
      { t: now - 2, fit: 0.2, success: 0.2, score: 20 },
      { t: now - 1, fit: 0.3, success: 0.3, score: 30 },
      { t: now, fit: 0.1, success: 0.1, score: 10 },
    ],
    cost: { probe: 200, judge: 300, skillLoad: 900, wasted: 900 },
    metrics: { meanScore: 20, fitAccuracy: 0.98, boundaryAccuracy: 0.33, precision: 0.33, consciousness: 55, wasteRate: 1, trend: 0, confidence: 'low' },
    learned: {
      whenToUse: [],
      whenNotToUse: ['Not for datasets: the body only prints a greeting.'],
      preconditions: ['Requires a self-test context.'],
      actualScope: [],
      cheaperAlternatives: ['Skip the skill; answer directly.'],
      knownFailures: [],
      notes: [],
    },
    appliedEdits: [],
  }
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ v: 1, createdAt: now - 1000, totals: {}, skills: { 'demo-skill': skill } }), 'utf8')
  const { ctx, listeners, cleanups } = createFakeContext({
    services: {
      skills: {
        async get() {
          return { name: 'demo-skill', description: skill.description, source: 'user-dsh', provider: 'filesystem', content: 'body' }
        },
        async list() {
          return []
        },
      },
    },
  })
  const session = {
    id: 's1',
    header: { cwd: dir },
    seq: 0,
    deriveMessages: () => [],
    snapshotEvents: () => [],
    eventAt: () => undefined,
  }
  const exec = skillExec({
    callId: 'call-annotate',
    agent: { id: 's1', session },
    arguments: { name: 'demo-skill' },
  })
  try {
    apply(ctx, { dataDir: dir, judge: { enabled: false }, dream: { enabled: false }, probe: { attachDeadlineMs: 2000 } })
    const pre = listeners.get('tools/pre-execute')[0]
    await pre(exec, async () => ({ kind: 'allow' }))
    const post = listeners.get('tools/post-execute')[0]
    const body = { type: 'text', text: '<skill_content>body</skill_content>' }
    const decision = await post(exec, { isError: false, content: [body] }, async () => ({ kind: 'accept' }))
    assert.equal(decision.kind, 'accept')
    assert.equal(Array.isArray(decision.content), true)
    assert.equal(decision.content.length, 2, 'annotation must be appended when the default accept carries no content')
    assert.equal(decision.content[0], body)
    assert.match(decision.content[1].text, /dreaming/i)
    assert.ok(
      !decision.content[1].text.includes('first observation'),
      'a measured annotation must not be replaced by the stub',
    )
    assert.equal((decision.content[1].text.match(/\[dreaming\]/g) ?? []).length, 1, 'normal annotation is appended once')
  } finally {
    for (const cleanup of cleanups) cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the dreaming tool reports applied, suggested and rejected packs truthfully', async () => {
  const tool = __internals.buildDreamingTool({
    ctx: { get: () => undefined },
    config: {},
    store: { state: {}, allSkills: () => [], getSkill: () => undefined },
    tracker: {},
    dreamEngine: { isRunning: () => false },
    runDream: async () => ({
      id: 'dream_x',
      status: 'ok',
      mode: 'inline',
      tokens: { in: 10, out: 20 },
      skills: [
        { skill: 'a', status: 'applied', applied: true },
        { skill: 'b', status: 'suggested', applied: false },
        { skill: 'c', status: 'rejected', applied: false, reasons: ['skill-busy'] },
      ],
    }),
    scheduler: { isRunning: () => false, nextRunAt: () => 0 },
    logger: quietLogger(),
  })
  const result = await tool.execute({ action: 'dream' }, {})
  assert.equal(result.action, 'dream')
  assert.match(result.text, /3 skill pack\(s\)/)
  assert.match(result.text, /1 applied/)
  assert.match(result.text, /1 suggestion\(s\)/)
  assert.match(result.text, /1 rejected/)
})

test('the dreaming tool uses the raw wire schema ToolRuntime.register expects', () => {
  const definition = __internals.buildDreamingTool({
    ctx: { get: () => undefined },
    config: {},
    store: { state: {}, allSkills: () => [], getSkill: () => undefined },
    tracker: {},
    dreamEngine: { isRunning: () => false },
    runDream: async () => ({}),
    scheduler: { isRunning: () => false, nextRunAt: () => 0 },
    logger: quietLogger(),
  })
  assert.equal(definition.name, 'dreaming')
  // parameters: object-rooted wire schema, no defineTool-style property-level `required: true`.
  assert.equal(definition.parameters.type, 'object')
  assert.deepEqual(definition.parameters.required, ['action'])
  assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(definition.parameters.properties.action.enum, ['status', 'gaps', 'dream'])
  for (const property of Object.values(definition.parameters.properties)) {
    assert.equal(property.required, undefined, 'property-level required is defineTool-only')
  }
  // output schema: raw wire shape too.
  assert.equal(definition.output.schema.type, 'object')
  assert.deepEqual(definition.output.schema.required, ['action', 'text'])
  assert.equal(definition.output.schema.additionalProperties, false)
  assert.equal(typeof definition.output.render, 'function')
  // render produces a plain text content block.
  assert.deepEqual(definition.output.render({}, { action: 'status', text: 'ok' }), [{ type: 'text', text: 'ok' }])
})
