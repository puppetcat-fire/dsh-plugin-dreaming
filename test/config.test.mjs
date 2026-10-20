import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULTS,
  buildConfigSchema,
  cloneDefaults,
  materialize,
  normalizeConfig,
  resolveDataDir,
  SPEC,
} from '../lib/config.js'

test('defaults are a complete, plain JSON tree', () => {
  const clone = cloneDefaults()
  assert.deepEqual(clone, DEFAULTS)
  assert.equal(DEFAULTS.probe.mode, 'inline')
  assert.equal(DEFAULTS.dream.time, '03:30')
  assert.deepEqual(DEFAULTS.dream.editableSources, ['user-dsh', 'user-agents'])
  assert.equal(DEFAULTS.dream.autoApply, false)
  assert.equal(DEFAULTS.enabled, true)
})

test('empty config normalizes to defaults without warnings', () => {
  const { config, warnings } = normalizeConfig({})
  assert.deepEqual(config, DEFAULTS)
  assert.deepEqual(warnings, [])
})

test('unknown keys are warned about and ignored', () => {
  const { config, warnings } = normalizeConfig({ mystery: 1, probe: { nope: true } })
  assert.equal(config.mystery, undefined)
  assert.equal(config.probe.nope, undefined)
  assert.ok(warnings.some((line) => line.includes('mystery')))
  assert.ok(warnings.some((line) => line.includes('probe.nope')))
})

test('numbers are clamped with a warning, bad types fall back', () => {
  const { config, warnings } = normalizeConfig({
    probe: { sampleRate: 5, maxPerHour: 0, temperature: 'cold' },
    dream: { maxSkillsPerRun: 99 },
  })
  assert.equal(config.probe.sampleRate, 1)
  assert.equal(config.probe.maxPerHour, 1)
  assert.equal(config.probe.temperature, 0.2)
  assert.equal(config.dream.maxSkillsPerRun, 20)
  assert.equal(warnings.length, 4)
})

test('invalid oneOf values fall back to the default and warn', () => {
  const { config, warnings } = normalizeConfig({
    probe: { mode: 'psychic' },
    dream: { mode: 'daydream' },
  })
  assert.equal(config.probe.mode, 'inline')
  assert.equal(config.dream.mode, 'auto')
  assert.equal(warnings.length, 2)
})

test('invalid dream time and time zone fall back', () => {
  const { config, warnings } = normalizeConfig({ dream: { time: '3:30', timeZone: 'Mars/Olympus' } })
  assert.equal(config.dream.time, '03:30')
  assert.equal(config.dream.timeZone, '')
  assert.equal(warnings.length, 2)
})

test('a valid time zone is preserved', () => {
  const { config, warnings } = normalizeConfig({ dream: { timeZone: 'Asia/Shanghai', time: '23:59' } })
  assert.equal(config.dream.timeZone, 'Asia/Shanghai')
  assert.equal(config.dream.time, '23:59')
  assert.deepEqual(warnings, [])
})

test('editableSources keeps only non-empty strings with a cap', () => {
  const { config } = normalizeConfig({
    dream: {
      editableSources: ['user-dsh', '', 7, 'x'.repeat(100), 'user-agents', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
    },
  })
  assert.ok(config.dream.editableSources.includes('user-dsh'))
  assert.ok(config.dream.editableSources.includes('user-agents'))
  assert.ok(config.dream.editableSources.every((item) => typeof item === 'string' && item.length <= 60))
  assert.ok(config.dream.editableSources.length <= 8)
})

test('resolveDataDir honors an absolute config, tilde and DSH_HOME', () => {
  const absolute = resolveDataDir({ dataDir: 'C:\\custom\\dir' })
  assert.match(absolute, /custom[\\/]dir$/)
  const viaEnv = resolveDataDir({ dataDir: '' }, { DSH_HOME: 'C:\\Users\\tester\\.dsh' })
  assert.match(viaEnv, /dreaming$/)
  assert.match(viaEnv, /tester/)
  const relative = resolveDataDir({ dataDir: 'data' }, { DSH_HOME: 'C:\\x' })
  assert.ok(relative.includes('data'))
})

test('materialize is independent of mutation of the result', () => {
  const first = materialize(SPEC)
  first.probe.model.provider = 'changed'
  assert.notEqual(DEFAULTS.probe.model.provider, 'changed')
})

test('the annotation budget is clamped to the hard 900-char prompt cap', () => {
  const { config, warnings } = normalizeConfig({ prompt: { annotationMaxChars: 4000 } })
  assert.equal(config.prompt.annotationMaxChars, 900)
  assert.equal(warnings.length, 1)
})

test('buildConfigSchema drives every spec field through a fake schemastery', () => {
  const calls = []
  const field = (kind) => {
    const schema = {
      kind,
      default: (value) => {
        calls.push(`${kind}.default(${JSON.stringify(value)})`)
        return schema
      },
      min: () => schema,
      max: () => schema,
      step: () => schema,
      description: (text) => {
        calls.push(`${kind}.description(${text.slice(0, 12)})`)
        return schema
      },
    }
    return schema
  }
  const fakeZ = {
    object: (shape) => ({ kind: 'object', shape }),
    boolean: () => field('boolean'),
    string: () => field('string'),
    number: () => field('number'),
    array: () => field('array'),
    union: () => field('union'),
    const: (value) => ({ kind: 'const', value }),
    any: () => field('any'),
  }
  const schema = buildConfigSchema(fakeZ)
  assert.equal(schema.kind, 'object')
  assert.ok(Object.hasOwn(schema.shape, 'probe'))
  assert.ok(Object.hasOwn(schema.shape.probe.shape, 'mode'))
  assert.ok(calls.some((line) => line.includes('boolean.default(true)')))
})
