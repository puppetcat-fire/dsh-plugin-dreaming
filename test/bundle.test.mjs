import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))

function readJson(file) {
  return JSON.parse(readFileSync(join(packageDir, file), 'utf8'))
}

/** Expand a simple glob against files in the package, walking recursively. */
function expand(pattern) {
  const normalized = pattern.replaceAll('\\', '/')
  const source = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  const matcher = new RegExp(`^${source}$`)
  const files = []
  const walk = (relativeDir) => {
    for (const entry of readdirSync(join(packageDir, relativeDir || '.'), { withFileTypes: true })) {
      const next = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(next)
      else if (matcher.test(next)) files.push(next)
    }
  }
  walk('')
  return [...new Set(files)]
}

test('package manifest declares the bundle, the client half and the peer contract', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.name, 'dsh-plugin-dreaming')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.private, undefined)
  assert.match(pkg.engines.dsh, /^>=0\.2\.1/)
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings'])
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-tools'])
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-llm'])
  assert.ok(pkg.peerDependencies['@deepseek-ai/schemastery'])
})

test('every exported path and every files entry exists', () => {
  const pkg = readJson('package.json')
  for (const [key, value] of Object.entries(pkg.exports)) {
    if (typeof value !== 'string') continue
    if (value.startsWith('./locale/') && value.includes('*')) continue
    assert.ok(existsSync(join(packageDir, value)), `missing export ${key} -> ${value}`)
  }
  const seen = new Set()
  for (const pattern of pkg.files) {
    for (const file of expand(pattern)) {
      assert.ok(existsSync(join(packageDir, file)), `files pattern ${pattern} matched missing ${file}`)
      seen.add(file)
    }
  }
  for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json', 'README.md', 'README.zh.md', 'ARCHITECTURE.md', 'LICENSE']) {
    assert.ok(seen.has(required), `files list must include ${required}`)
  }
})

test('the patch inserts exactly one host row with the package name', () => {
  const patch = readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /^- insert:/m)
  assert.match(patch, /id: dreaming/)
  assert.match(patch, /name: 'dsh-plugin-dreaming'/)
  assert.equal((patch.match(/^- insert:/gm) ?? []).length, 1)
})

test('locale resources parse and match the meta contract', () => {
  for (const locale of ['locale/en.json', 'locale/zh.json']) {
    const value = readJson(locale)
    assert.equal(typeof value.meta.title, 'string')
    assert.ok(value.meta.title.length > 2)
    assert.equal(typeof value.meta.description, 'string')
    assert.ok(value.meta.description.length > 20)
    assert.ok(Object.keys(value.panel).length > 40)
  }
  const en = readJson('locale/en.json')
  const zh = readJson('locale/zh.json')
  assert.deepEqual(Object.keys(en.panel).sort(), Object.keys(zh.panel).sort())
})

test('the icon is a self-contained SVG inside the package', () => {
  const icon = readFileSync(join(packageDir, 'icon.svg'), 'utf8')
  assert.match(icon.trim(), /^<svg[\s>]/)
  assert.match(icon, /<\/svg>\s*$/)
  assert.ok(Buffer.byteLength(icon, 'utf8') < 256 * 1024)
  assert.ok(!/href=["']https?:/i.test(icon), 'icon must not reference remote resources')
})

test('the Host half has no static Harness imports except the optional schema package', () => {
  const hostFiles = ['index.js', ...readdirSync(join(packageDir, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`)]
  for (const file of hostFiles) {
    const text = readFileSync(join(packageDir, file), 'utf8')
    const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
    for (const specifier of imports) {
      if (!specifier.startsWith('@deepseek-ai/')) continue
      assert.fail(`${file} statically imports ${specifier}; only the optional dynamic schemastery import is allowed`)
    }
    assert.ok(!/from\s+'node:(http|https|net|tls)'/.test(text) || file === 'lib/api.js', `${file} must not open network listeners`)
  }
})

test('the client half is a lazy ModuleLoader factory with only react and relative fetches', () => {
  const client = readFileSync(join(packageDir, 'client.js'), 'utf8')
  assert.match(client, /window\.__ModuleLoader__\.load\(/)
  assert.match(client, /factory\(require\)/)
  assert.ok(!/from\s+'@deepseek-ai\//.test(client), 'client must not import Harness packages')
  assert.ok(!/\bJSX\b/.test(client))
  assert.ok(!/document\.body\.append/.test(client), 'client must not append to body')
  assert.match(client, /settings\.section/)
  assert.match(client, /fetch\(\s*API_BASE/)
  const literalColors = client.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? []
  assert.deepEqual(literalColors, [], 'client styles must use theme tokens, not literal colors')
})

test('the client reads the active locale id instead of the retired language field', () => {
  const client = readFileSync(join(packageDir, 'client.js'), 'utf8')
  assert.match(client, /snapshot\?\.active/, 'locale detection must read snapshot.active')
  assert.ok(!/typeof snapshot\.language/.test(client), 'the retired snapshot.language field must not be the primary read')
})

test('the client registers with exactly the documented slot options', () => {
  const client = readFileSync(join(packageDir, 'client.js'), 'utf8')
  const registration = client.match(/ctx\.slots\.register\(\{([\s\S]*?)\},\s*\(props\)/)?.[1] ?? ''
  assert.ok(registration.length > 0, 'could not find the slot registration')
  const keys = [...registration.matchAll(/^\s*([a-zA-Z]+):/gm)].map((match) => match[1]).sort()
  assert.deepEqual(keys, ['id', 'label', 'name', 'order'])
})

test('the host entry exports the expected plugin surface', () => {
  const entry = readFileSync(join(packageDir, 'index.js'), 'utf8')
  assert.match(entry, /export const name = 'dreaming'/)
  assert.match(entry, /export const inject = \[/)
  assert.match(entry, /export function apply\(ctx, rawConfig\)/)
  assert.match(entry, /export const Config = ConfigSchema/)
  for (const event of ['tools/pre-execute', 'tools/post-execute', 'tools/result', 'session/event']) {
    assert.ok(entry.includes(`'${event}'`), `entry must listen for ${event}`)
  }
})

test('the package contains no test/runtime leftovers outside the declared layout', () => {
  const pkg = readJson('package.json')
  const allowed = ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'README.zh.md', 'ARCHITECTURE.md', 'LICENSE', '.gitignore', '.gitattributes', '.github', 'package.json', 'lib', 'locale', 'test']
  for (const entry of readdirSync(packageDir).filter((name) => name !== '.git')) {
    assert.ok(allowed.includes(entry), `unexpected root entry ${entry}`)
  }
  const relativeFiles = []
  for (const root of ['lib', 'locale', 'test']) {
    for (const entry of readdirSync(join(packageDir, root))) relativeFiles.push(relative(packageDir, join(packageDir, root, entry)))
  }
  assert.ok(relativeFiles.length > 10)
  assert.ok(!relativeFiles.some((file) => file.endsWith('.tmp') || file.includes('.corrupt-')), 'temp artifacts must not ship')
  assert.ok(!relativeFiles.some((file) => file.endsWith('.map')), 'source maps are not required for a linked plain-JS bundle')
  void pkg
})
