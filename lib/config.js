/**
 * Configuration: one declarative SPEC drives three things —
 * 1. `DEFAULTS` (a complete, documented default object),
 * 2. `normalizeConfig(raw)` (tolerant, warning-producing validation for the runtime), and
 * 3. `buildConfigSchema(z)` (the schemastery schema exported as the plugin's `Config`,
 *    which powers the Settings form and `Config.listConfigs`).
 *
 * Adding a field therefore requires one edit, not three. Unknown user keys are warned about,
 * never silently dropped without a diagnostic, and never crash plugin activation.
 */

import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { DEFAULT_EDITABLE_SOURCES, DREAM_MODES, JUDGE_MODES, PROBE_MODES, SKILL_TOOL } from './constants.js'
import { asBool, asInt, asString, clamp } from './util.js'

const f = {
  bool: (def) => ({ kind: 'bool', def }),
  str: (def, { max = 4096 } = {}) => ({ kind: 'str', def, max }),
  int: (def, min, max) => ({ kind: 'int', def, min, max }),
  num: (def, min, max) => ({ kind: 'num', def, min, max }),
  oneOf: (values, def) => ({ kind: 'oneOf', values, def }),
  list: (def, { max = 16, itemMax = 64 } = {}) => ({ kind: 'list', def, max, itemMax }),
  obj: (fields) => ({ kind: 'obj', fields }),
}

/** `{ provider, model, reasoningEffort, maxTokens }`; empty values mean "inherit". */
const route = () =>
  f.obj({
    provider: f.str('', { max: 120 }),
    model: f.str('', { max: 200 }),
    reasoningEffort: f.str('', { max: 60 }),
    maxTokens: f.int(0, 0, 64000),
  })

/**
 * Reasoning-effort ids the installed Harness adapters accept. `dsh-llm-deepseek` unions exactly
 * `off | low | high | max` (it rejects `medium`), and `dsh-llm` validates an explicit effort
 * against the exact model's advertised list without clamping or aliasing. `''` is not an
 * effort: it means "inherit whatever the triggering session route uses".
 */
export const REASONING_EFFORTS = ['', 'off', 'low', 'high', 'max']

/**
 * The single field specification. Keys are stable; their order is the Settings form order.
 * `description` strings are attached to the generated schema (English; UI locales live in locale/).
 */
export const SPEC = {
  enabled: { ...f.bool(true), description: 'Master switch for probing, annotation and dreaming.' },
  dataDir: {
    ...f.str('', { max: 1024 }),
    description: 'Durable data directory. Empty = $DSH_HOME/dreaming.',
  },
  skillTool: {
    ...f.str(SKILL_TOOL, { max: 40 }),
    description: 'Model-facing tool name used to load skills; change only if another plugin shadows it.',
  },
  probe: f.obj({
    enabled: { ...f.bool(true), description: 'Concurrently predict what a skill will actually deliver for this task.' },
    mode: { ...f.oneOf(PROBE_MODES, 'subagent'), description: 'subagent = a real caller-delivered child (default); inline = one cheap LLM call.' },
    subagentProvider: { ...f.str('spawn', { max: 60 }), description: 'ctx.subagents provider used when mode = subagent.' },
    model: route(),
    reasoningEffort: {
      ...f.oneOf(REASONING_EFFORTS, 'low'),
      description:
        'Reasoning effort for probe calls: off | low | high | max, or empty to inherit the session route. ' +
        'The bundled DeepSeek adapter does not accept "medium". low keeps the probe inside the annotation deadline.',
    },
    temperature: f.num(0.2, 0, 1),
    timeoutMs: f.int(25000, 1000, 180000),
    attachDeadlineMs: {
      ...f.int(0, 0, 15000),
      description: 'How long the skill result waits for a ready probe before it is annotated. 0 (default) never blocks the skill call; the probe prediction is still recorded and used by the judge.',
    },
    sampleRate: {
      ...f.num(1, 0, 1),
      description: 'Fraction of eligible skill loads probed. Skills with a known capability gap are always probed when alwaysForGapSkills is on.',
    },
    alwaysForGapSkills: f.bool(true),
    maxPerHour: f.int(120, 1, 2000),
    minBodyChars: f.int(0, 0, 1000000),
  }),
  judge: f.obj({
    enabled: f.bool(true),
    mode: { ...f.oneOf(JUDGE_MODES, 'subagent'), description: 'subagent = a real caller-delivered child (default); inline = one cheap LLM call.' },
    subagentProvider: { ...f.str('spawn', { max: 60 }), description: 'ctx.subagents provider used when judge.mode = subagent.' },
    model: route(),
    reasoningEffort: {
      ...f.oneOf(REASONING_EFFORTS, 'low'),
      description:
        'Reasoning effort for judge calls: off | low | high | max, or empty to inherit the session route. ' +
        'The bundled DeepSeek adapter does not accept "medium". low leaves more of the capped reply budget for the JSON verdict.',
    },
    temperature: f.num(0.1, 0, 1),
    timeoutMs: f.int(40000, 1000, 300000),
    judgeWithoutProbe: f.bool(true),
    retryInvalidOnce: f.bool(true),
  }),
  observe: f.obj({
    maxTurnExtensionMs: {
      ...f.int(600000, 30000, 3600000),
      description: 'Hard stop for the post-load observation window when the turn never ends.',
    },
    maxEvents: f.int(240, 20, 4000),
    maxTraceChars: f.int(12000, 1000, 60000),
    flushGraceMs: f.int(8000, 0, 60000),
  }),
  prompt: f.obj({
    awarenessSection: f.bool(true),
    annotateSkillResult: f.bool(true),
    maxSkills: f.int(8, 0, 40),
    refreshMinutes: f.int(10, 0, 1440),
    annotationMaxChars: f.int(900, 200, 900),
    minJudgedForSection: f.int(2, 1, 50),
  }),
  dream: f.obj({
    enabled: f.bool(true),
    mode: f.oneOf(DREAM_MODES, 'auto'),
    time: { ...f.str('03:30', { max: 5 }), description: 'Local wall-clock time HH:MM.' },
    timeZone: { ...f.str('', { max: 80 }), description: 'IANA zone; empty uses the process zone.' },
    jitterMinutes: f.int(10, 0, 120),
    catchUpHours: f.int(18, 0, 168),
    caseWindowDays: f.int(7, 1, 90),
    scoreThreshold: f.int(78, 0, 100),
    maxCasesPerSkill: f.int(6, 1, 40),
    maxSkillsPerRun: f.int(3, 1, 20),
    maxConcurrent: f.int(1, 1, 4),
    model: route(),
    temperature: f.num(0.2, 0, 1),
    timeoutMs: f.int(180000, 10000, 900000),
    maxRunMs: f.int(1800000, 60000, 7200000),
    dailyTokenBudget: f.int(60000, 1000, 2000000),
    autoApply: {
      ...f.bool(false),
      description: 'Apply validated description/body edits with backups. Off (the default) records suggestions only.',
    },
    minProposalConfidence: f.num(0.55, 0, 1),
    editableSources: f.list(DEFAULT_EDITABLE_SOURCES, { max: 8, itemMax: 60 }),
    maxDescriptionChars: f.int(500, 100, 2000),
    maxBodySectionChars: f.int(2400, 200, 12000),
    minNewEpisodes: f.int(1, 0, 1000),
  }),
  run: f.obj({
    maxConcurrent: f.int(2, 1, 8),
  }),
  store: f.obj({
    retainDays: f.int(120, 1, 3650),
    maxEpisodes: f.int(4000, 50, 100000),
    maxSkills: f.int(400, 10, 5000),
    compactBytes: f.int(8 * 1024 * 1024, 256 * 1024, 512 * 1024 * 1024),
  }),
  api: f.obj({
    enabled: f.bool(true),
  }),
  debug: f.bool(false),
}

const FIELD_DESCRIPTIONS = {
  'probe.model': 'Optional model override for probes; empty inherits the triggering session route. Its reasoningEffort falls back to probe.reasoningEffort unless set here.',
  'judge.model': 'Optional model override for judges; empty inherits the triggering session route. Its reasoningEffort falls back to judge.reasoningEffort unless set here.',
  'dream.model': 'Optional model override for the dreamer; empty inherits the triggering session route or the host default.',
  'dream.editableSources': 'Skill sources the dreamer may edit on disk. Others receive guidance notes only.',
  'store.retainDays': 'Episode journal retention in days.',
  'store.maxEpisodes': 'Hard episode cap; the oldest records are compacted away first.',
  'store.maxSkills': 'Hard skill-belief cap; least-recently-used skills are pruned first.',
}

/** Materialize a complete default value tree from SPEC. */
export function materialize(fields = SPEC) {
  const out = {}
  for (const [key, spec] of Object.entries(fields)) {
    if (spec.kind === 'obj') out[key] = materialize(spec.fields)
    else if (spec.kind === 'list') out[key] = [...spec.def]
    else if (spec.def !== null && typeof spec.def === 'object') out[key] = { ...spec.def }
    else out[key] = spec.def
  }
  return out
}

/**
 * `config.probe.model` / `config.judge.model` is the route object probe.js and judge.js already
 * pass to `resolveRoute`, so the ergonomic top-level `reasoningEffort` is folded into it after
 * validation. A route-level value stays authoritative: it is the more specific override and
 * keeps configs written before the top-level field existed working unchanged.
 */
function foldReasoningEffort(config) {
  for (const section of ['probe', 'judge']) {
    const routeConfig = config?.[section]?.model
    if (routeConfig === null || typeof routeConfig !== 'object') continue
    if (!routeConfig.reasoningEffort) routeConfig.reasoningEffort = config[section].reasoningEffort
  }
  return config
}

/** Complete default configuration. */
export const DEFAULTS = foldReasoningEffort(materialize(SPEC))

/** Deep clone that is safe for the plain JSON configuration tree. */
export function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS))
}

function normalizeFields(raw, fields, path, warnings) {
  const out = {}
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push(`${path || '<root>'}: expected an object; using defaults`)
  }
  for (const [key, spec] of Object.entries(fields)) {
    const value = source[key]
    const keyPath = path ? `${path}.${key}` : key
    if (value === undefined) {
      out[key] = materializeField(spec)
      continue
    }
    switch (spec.kind) {
      case 'bool': {
        const flag = asBool(value, undefined)
        if (flag === undefined) warnings.push(`${keyPath}: expected a boolean; using ${spec.def}`)
        out[key] = flag ?? spec.def
        break
      }
      case 'str': {
        if (typeof value !== 'string') warnings.push(`${keyPath}: expected a string; using default`)
        const text = asString(value, spec.def).trim()
        out[key] = text.length > spec.max ? text.slice(0, spec.max) : text
        break
      }
      case 'int':
      case 'num': {
        const number = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(number)) warnings.push(`${keyPath}: expected a number; using ${spec.def}`)
        const clamped = spec.kind === 'int'
          ? asInt(Number.isFinite(number) ? number : spec.def, spec.min, spec.max, spec.def)
          : clamp(Number.isFinite(number) ? number : spec.def, spec.min, spec.max, spec.def)
        if (Number.isFinite(number) && clamped !== number) {
          warnings.push(`${keyPath}: clamped ${number} to ${clamped} (allowed ${spec.min}..${spec.max})`)
        }
        out[key] = clamped
        break
      }
      case 'oneOf': {
        if (!spec.values.includes(value)) {
          warnings.push(`${keyPath}: expected one of ${spec.values.map((item) => JSON.stringify(item)).join(', ')}; using ${JSON.stringify(spec.def)}`)
          out[key] = spec.def
        } else {
          out[key] = value
        }
        break
      }
      case 'list': {
        if (!Array.isArray(value)) {
          warnings.push(`${keyPath}: expected an array; using default`)
          out[key] = [...spec.def]
          break
        }
        out[key] = value
          .filter((item) => typeof item === 'string')
          .map((item) => item.trim().slice(0, spec.itemMax))
          .filter(Boolean)
          .slice(0, spec.max)
        break
      }
      case 'obj': {
        out[key] = normalizeFields(value, spec.fields, keyPath, warnings)
        break
      }
      default: {
        out[key] = materializeField(spec)
      }
    }
  }
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(fields, key)) warnings.push(`${path ? `${path}.` : ''}${key}: unknown option (ignored)`)
  }
  return out
}

function materializeField(spec) {
  if (spec.kind === 'obj') return materialize(spec.fields)
  if (spec.kind === 'list') return [...spec.def]
  if (spec.def !== null && typeof spec.def === 'object') return { ...spec.def }
  return spec.def
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Validate and normalize raw plugin config.
 * @param {unknown} raw
 * @returns {{ config: object, warnings: string[] }}
 */
export function normalizeConfig(raw) {
  const warnings = []
  const config = normalizeFields(raw, SPEC, '', warnings)
  foldReasoningEffort(config)
  if (!TIME_PATTERN.test(config.dream.time)) {
    warnings.push(`dream.time: expected HH:MM; using ${DEFAULTS.dream.time}`)
    config.dream.time = DEFAULTS.dream.time
  }
  if (config.dream.timeZone) {
    try {
      // Validation only; the scheduler resolves the zone on every computation.
      new Intl.DateTimeFormat('en-US', { timeZone: config.dream.timeZone }).format(new Date())
    } catch {
      warnings.push(`dream.timeZone: "${config.dream.timeZone}" is not a valid IANA zone; using the process zone`)
      config.dream.timeZone = ''
    }
  }
  if (config.dream.minProposalConfidence > 1) config.dream.minProposalConfidence = 1
  return { config, warnings }
}

/** Resolve the effective data directory from config, DSH_HOME and the home directory. */
export function resolveDataDir(config, env = process.env) {
  const configured = asString(config?.dataDir).trim()
  if (configured) {
    const expanded = configured.startsWith('~')
      ? resolve(homedir(), configured.slice(1).replace(/^[\\/]+/, ''))
      : configured
    return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
  }
  const home = asString(env.DSH_HOME).trim() || resolve(homedir(), '.dsh')
  return resolve(home, 'dreaming')
}

/**
 * Build the schemastery schema used as the plugin `Config` export.
 * @param {Function} z - the schemastery module default export.
 */
export function buildConfigSchema(z) {
  const convert = (fields, path) => {
    const shape = {}
    for (const [key, spec] of Object.entries(fields)) {
      const keyPath = path ? `${path}.${key}` : key
      shape[key] = convertField(spec, keyPath)
    }
    return z.object(shape)
  }
  const convertField = (spec, keyPath) => {
    let schema
    switch (spec.kind) {
      case 'bool':
        schema = z.boolean().default(spec.def)
        break
      case 'str':
        schema = z.string().default(spec.def)
        break
      case 'int':
        schema = z.number().step(1).min(spec.min).max(spec.max).default(spec.def)
        break
      case 'num':
        schema = z.number().min(spec.min).max(spec.max).default(spec.def)
        break
      case 'oneOf':
        schema = z.union(spec.values.map((value) => z.const(value))).default(spec.def)
        break
      case 'list':
        schema = z.array(z.string()).default(spec.def)
        break
      case 'obj':
        schema = convert(spec.fields, keyPath)
        break
      default:
        schema = z.any()
    }
    const description = spec.description ?? FIELD_DESCRIPTIONS[keyPath]
    if (description && typeof schema.description === 'function') schema = schema.description(description)
    return schema
  }
  return convert(SPEC, '')
}
