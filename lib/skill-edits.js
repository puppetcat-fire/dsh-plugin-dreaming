/**
 * Safe, reversible edits to user-level SKILL.md files.
 *
 * This is the most dangerous module in the plugin: it is the only code that writes outside the
 * plugin data directory. The safety model is layered:
 *
 * 1. **Source gate** — only skill sources listed in `dream.editableSources` (default user-level)
 *    are considered at all.
 * 2. **Path gate** — the *real* path (symlinks resolved with `realpathSync.native`) must be inside
 *    `$DSH_HOME/skills` or `~/.agents/skills`; containment is checked with `path.relative`, never
 *    with string prefixes, and case-insensitively on Windows.
 * 3. **Exact-match edit** — a plan locates one unambiguous YAML scalar or the marked body block and
 *    replaces only those bytes. Anything the parser cannot rewrite safely is refused, not guessed.
 * 4. **Write gate** — the file is hashed before planning (`before`), backed up byte-for-byte, written
 *    atomically (tmp + rename, original mode kept), and verified by hash and re-parse after the
 *    write. A failed verification restores the backup.
 * 5. **Revert gate** — restore only when the current file hash still equals the post-edit hash;
 *    a manual edit after the dream produces `{ ok: false, reason: 'conflict' }`, never a clobber.
 *
 * Every exported function is total: it returns `{ ok: false, reason }` instead of throwing, so a
 * dream cycle can journal the refusal and continue.
 *
 * @module skill-edits
 */

import { Buffer } from 'node:buffer'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DEFAULT_EDITABLE_SOURCES, LAYOUT, SKILL_EDIT } from './constants.js'
import { CAPS } from './constants.js'
import { asInt, clamp, safeError, sha256, truncate } from './util.js'

/** Characters that must never reach a skill file or a prompt. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

/** Fraction of the original description's significant tokens the new text must keep. */
const DEFAULT_CLAIM_OVERLAP = 0.6

/** A description must be one paragraph; long inputs are flattened, paragraph breaks are kept. */
const PARAGRAPH_BREAK = /\n\s*\n/

// ---------------------------------------------------------------------------------------------
// markdown / frontmatter parsing
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {'plain'|'single'|'double'|'literal'|'folded'} DescriptionStyle
 *
 * @typedef {object} FrontmatterField
 * @property {string} key
 * @property {DescriptionStyle} style
 * @property {string} value decoded scalar value
 * @property {string} raw raw source slice of the scalar
 * @property {number} valueStart replacement span start (absolute index in the file text)
 * @property {number} valueEnd replacement span end (exclusive)
 * @property {number} lineStart absolute index of the line start
 * @property {number} lineEnd absolute index after the line EOL
 * @property {{indicator:string, chomping:string, indent:number}|null} block block-scalar layout
 * @property {boolean} endsWithEol whether the replacement span ends with a line break
 * @property {boolean} supported false when the value form cannot be rewritten safely
 * @property {string|null} reason why the field is unsupported
 * @property {boolean} ambiguous true when the key appears more than once
 *
 * @typedef {object} ParsedSkill
 * @property {string} text
 * @property {string} eol '\r\n' or '\n', taken from the first line break
 * @property {boolean} hasFrontmatter
 * @property {boolean} malformedFrontmatter opening `---` without a closing delimiter
 * @property {string} frontmatterRaw
 * @property {Record<string,string>} frontmatter decoded top-level scalar values
 * @property {Map<string,FrontmatterField>} frontmatterFields
 * @property {FrontmatterField|null} descriptionField
 * @property {string} body
 * @property {number} bodyStart absolute index where the body begins
 * @property {number} frontmatterStart
 * @property {number} frontmatterEnd
 */

/**
 * Split text into line spans. `content` excludes the EOL; `end` is after it.
 * @param {string} text
 */
function lineSpans(text) {
  const lines = []
  let start = 0
  while (start <= text.length) {
    const nl = text.indexOf('\n', start)
    const end = nl === -1 ? text.length : nl + 1
    let content = text.slice(start, nl === -1 ? text.length : nl)
    if (content.endsWith('\r')) content = content.slice(0, -1)
    lines.push({ start, end, content, index: lines.length })
    if (nl === -1) break
    start = end
  }
  return lines
}

/** Detect the dominant EOL; the first line break wins so mixed files round-trip their head. */
function detectEol(text) {
  const index = text.indexOf('\n')
  if (index === -1) return '\n'
  return index > 0 && text[index - 1] === '\r' ? '\r\n' : '\n'
}

/** Decode a YAML block scalar into its semantic string (single paragraph use only). */
function decodeBlockScalar(lines, indicator, chomping, indent) {
  const stripped = lines.map((line) => {
    if (line.trim().length === 0) return ''
    return line.length >= indent ? line.slice(indent) : line.trimStart()
  })
  let value
  if (indicator === '|') {
    value = stripped.join('\n')
  } else {
    // YAML folded scalar: single line breaks fold to spaces, blank lines become newlines.
    value = ''
    let previousBlank = true
    for (const line of stripped) {
      const blank = line.length === 0
      if (blank) {
        value += '\n'
      } else if (previousBlank) {
        value += line
      } else {
        value += ` ${line}`
      }
      previousBlank = blank
    }
  }
  if (chomping === '-') return value.replace(/\n+$/, '')
  if (chomping === '+') return value
  return `${value.replace(/\n+$/, '')}\n`
}

/**
 * Route 1 of the safety model: parse only what we can rewrite exactly. Unsupported forms are
 * marked, never repaired.
 */
function parseFrontmatterFields(source, rawLines) {
  /** @type {Map<string, FrontmatterField>} */
  const fields = new Map()
  const duplicates = new Set()

  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i]
    const content = line.content
    if (content.trim().length === 0) continue
    if (/^[ \t]*#/.test(content)) continue
    if (/^[ \t]/.test(content)) continue // indented: belongs to a parent key or a block scalar
    const colonIndex = content.indexOf(':')
    if (colonIndex <= 0) continue
    const key = content.slice(0, colonIndex).trim()
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) continue

    let cursor = colonIndex + 1
    while (cursor < content.length && (content[cursor] === ' ' || content[cursor] === '\t')) cursor += 1
    const rest = content.slice(cursor)
    const valueStart = line.start + cursor
    const lineContentEnd = line.start + content.length
    /** @type {FrontmatterField} */
    const field = {
      key,
      style: 'plain',
      value: '',
      raw: rest,
      valueStart,
      valueEnd: lineContentEnd,
      lineStart: line.start,
      lineEnd: line.end,
      block: null,
      endsWithEol: false,
      supported: true,
      reason: null,
      ambiguous: duplicates.has(key),
    }

    if (rest.startsWith('|') || rest.startsWith('>')) {
      parseBlockScalarField({ source, rawLines, index: i, line, rest, cursor, field, lineContentEnd })
      if (field.consumedUntil !== undefined) i = field.consumedUntil
    } else if (rest.startsWith("'")) {
      parseQuotedField({ line, rest, cursor, field, quote: "'" })
    } else if (rest.startsWith('"')) {
      parseQuotedField({ line, rest, cursor, field, quote: '"' })
    } else if (/^[[{]/.test(rest)) {
      field.supported = false
      field.reason = 'flow-collection-value'
    } else if (/^[&*!]/.test(rest)) {
      field.supported = false
      field.reason = 'unsupported-yaml-value'
    } else {
      parsePlainField({ rawLines, index: i, line, rest, cursor, colonIndex, field })
    }

    delete field.consumedUntil
    if (fields.has(key)) {
      duplicates.add(key)
      const existing = fields.get(key)
      existing.ambiguous = true
      field.ambiguous = true
    }
    if (!fields.has(key)) fields.set(key, field)
  }
  return { fields, duplicates }
}

function parseBlockScalarField({ source, rawLines, index, line, rest, cursor, field, lineContentEnd }) {
  const indicatorMatch = /^([|>])([+-]?)([1-9]?)([ \t]*(?:#.*)?)$/.exec(rest)
  if (!indicatorMatch) {
    field.supported = false
    field.reason = 'unsupported-block-scalar'
    return
  }
  if (indicatorMatch[3]) {
    field.supported = false
    field.reason = 'block-scalar-explicit-indent'
    return
  }
  const indicator = indicatorMatch[1]
  const chomping = indicatorMatch[2] ?? ''

  const blockLines = []
  let next = index + 1
  for (; next < rawLines.length; next += 1) {
    const candidate = rawLines[next]
    if (candidate.content.trim().length === 0) {
      blockLines.push(candidate)
      continue
    }
    if (/^[ \t]/.test(candidate.content)) {
      blockLines.push(candidate)
      continue
    }
    break
  }
  // Trailing blank lines are a separator owned by the following key, not by our replacement.
  let lastKept = blockLines.length - 1
  while (lastKept >= 0 && blockLines[lastKept].content.trim().length === 0) lastKept -= 1
  const contentLines = blockLines.slice(0, lastKept + 1)
  const lastLine = contentLines.length > 0 ? contentLines[contentLines.length - 1] : line
  field.consumedUntil = contentLines.length > 0 ? lastLine.index : index
  field.raw = source.slice(line.start + cursor, lastLine.end)
  field.valueStart = line.start + cursor
  field.valueEnd = contentLines.length > 0 ? lastLine.end : lineContentEnd
  field.endsWithEol = field.valueEnd > field.valueStart
    && (source[field.valueEnd - 1] === '\n')
  field.style = indicator === '|' ? 'literal' : 'folded'

  let indent = null
  for (const blockLine of contentLines) {
    if (blockLine.content.trim().length === 0) continue
    const spaces = /^( +)/.exec(blockLine.content)
    if (spaces === null && /^[ \t]/.test(blockLine.content)) {
      field.supported = false
      field.reason = 'tab-indentation'
      return
    }
    const count = spaces ? spaces[1].length : 0
    if (count === 0) {
      field.supported = false
      field.reason = 'unsupported-block-scalar'
      return
    }
    indent = indent === null ? count : Math.min(indent, count)
  }
  const resolvedIndent = indent ?? 2
  field.block = { indicator, chomping, indent: resolvedIndent }
  field.value = decodeBlockScalar(contentLines.map((entry) => entry.content), indicator, chomping, resolvedIndent)
}

function parseQuotedField({ line, rest, cursor, field, quote }) {
  let inner = ''
  let index = 1
  let closed = false
  while (index < rest.length) {
    const char = rest[index]
    if (quote === "'") {
      if (char === "'") {
        if (rest[index + 1] === "'") {
          inner += "'"
          index += 2
          continue
        }
        closed = true
        break
      }
      inner += char
      index += 1
      continue
    }
    if (char === '\\') {
      inner += char
      if (index + 1 < rest.length) inner += rest[index + 1]
      index += 2
      continue
    }
    if (char === '"') {
      closed = true
      break
    }
    inner += char
    index += 1
  }
  if (!closed) {
    field.supported = false
    field.reason = 'unterminated-quote'
    return
  }
  const suffix = rest.slice(index + 1)
  if (!/^[ \t]*(?:#.*)?$/.test(suffix)) {
    field.supported = false
    field.reason = 'unsupported-quote-suffix'
    return
  }
  if (quote === '"') {
    try {
      field.value = JSON.parse(`"${inner}"`)
    } catch {
      field.supported = false
      field.reason = 'unsupported-double-quote-escape'
      return
    }
  } else {
    field.value = inner
  }
  field.style = quote === "'" ? 'single' : 'double'
  field.raw = rest.slice(0, index + 1)
  field.valueStart = line.start + cursor
  field.valueEnd = line.start + cursor + index + 1
}

function parsePlainField({ rawLines, index, line, rest, cursor, colonIndex, field }) {
  const valueStart = line.start + cursor
  let commentIndex = -1
  if (rest.startsWith('#')) commentIndex = 0
  else {
    for (let scan = 1; scan < rest.length; scan += 1) {
      if (rest[scan] === '#' && (rest[scan - 1] === ' ' || rest[scan - 1] === '\t')) {
        commentIndex = scan
        break
      }
    }
  }
  const rawValue = commentIndex >= 0 ? rest.slice(0, commentIndex) : rest
  const valuePart = rawValue.replace(/[ \t]+$/, '')
  if (commentIndex === 0 || (commentIndex > 0 && valuePart.trim().length === 0)) {
    field.supported = false
    field.reason = 'comment-only-value'
    return
  }
  if (/^[[{]/.test(valuePart)) {
    field.supported = false
    field.reason = 'flow-collection-value'
    return
  }
  if (/^[-?](?:[ \t]|$)/.test(valuePart)) {
    field.supported = false
    field.reason = 'sequence-value'
    return
  }
  field.style = 'plain'
  field.value = valuePart
  field.raw = valuePart
  // The replacement span starts right after the colon so stray spaces around the value are
  // normalized instead of duplicated; the rest of the line (comments) is preserved.
  field.valueStart = line.start + colonIndex + 1
  field.valueEnd = valueStart + valuePart.length
  const nextLine = rawLines[index + 1]
  if (nextLine && nextLine.content.trim().length > 0 && /^[ \t]/.test(nextLine.content)) {
    field.supported = false
    field.reason = 'plain-multiline-value'
  }
}

/**
 * Parse a SKILL.md into its frontmatter and body without ever rewriting anything.
 *
 * @param {string} text
 * @returns {ParsedSkill}
 */
export function parseSkillMarkdown(text) {
  const source = typeof text === 'string' ? text : ''
  const eol = detectEol(source)
  /** @type {ParsedSkill} */
  const result = {
    text: source,
    eol,
    hasFrontmatter: false,
    malformedFrontmatter: false,
    frontmatterRaw: '',
    frontmatter: {},
    frontmatterFields: new Map(),
    descriptionField: null,
    body: source,
    bodyStart: 0,
    frontmatterStart: 0,
    frontmatterEnd: 0,
  }
  if (source.length === 0) return result
  const lines = lineSpans(source)
  if (lines.length < 2) return result
  const firstContent = lines[0].content.replace(/^\uFEFF/, '')
  if (firstContent.trim() !== '---') return result

  let closeIndex = -1
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].content.trim()
    if (trimmed === '---' || trimmed === '...') {
      closeIndex = index
      break
    }
  }
  if (closeIndex === -1) {
    result.malformedFrontmatter = true
    return result
  }

  const openLine = lines[0]
  const closeLine = lines[closeIndex]
  result.hasFrontmatter = true
  result.frontmatterStart = openLine.start
  result.frontmatterEnd = closeLine.end
  result.bodyStart = closeLine.end
  result.frontmatterRaw = source.slice(openLine.end, closeLine.start)
  result.body = source.slice(closeLine.end)
  const rawLines = lines.slice(1, closeIndex)
  const { fields, duplicates } = parseFrontmatterFields(source, rawLines)
  result.frontmatterFields = fields
  for (const [key, field] of fields) {
    result.frontmatter[key] = field.value
    if (duplicates.has(key)) field.ambiguous = true
  }
  const description = fields.get('description')
  if (description !== undefined) {
    result.descriptionField = {
      ...description,
      ambiguous: description.ambiguous || duplicates.has('description'),
    }
  }
  return result
}

/** Alias kept for callers that only care about the frontmatter (documented in the module report). */
export function parseFrontmatter(text) {
  return parseSkillMarkdown(text)
}

// ---------------------------------------------------------------------------------------------
// file helpers
// ---------------------------------------------------------------------------------------------

/**
 * Read a skill file as UTF-8. Never throws.
 * @param {string} filePath
 * @returns {string|null}
 */
export function readSkillFile(filePath) {
  try {
    if (typeof filePath !== 'string' || filePath.length === 0) return null
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * SHA-256 of a file's UTF-8 text. Never throws (returns null when unreadable).
 * @param {string} filePath
 * @returns {string|null}
 */
export function sha256File(filePath) {
  const text = readSkillFile(filePath)
  return text === null ? null : sha256(text)
}

// ---------------------------------------------------------------------------------------------
// path safety
// ---------------------------------------------------------------------------------------------

/** Default user skill roots: `$DSH_HOME/skills` and `~/.agents/skills`. */
export function computeSkillRoots({ env = process.env, home = homedir() } = {}) {
  const dshHome = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0
    ? env.DSH_HOME.trim()
    : resolve(home, '.dsh')
  return [resolve(dshHome, 'skills'), resolve(home, '.agents', 'skills')]
}

/**
 * Containment check using `path.relative`, so `/skills2` can never match `/skills`.
 *
 * @param {string} root absolute root
 * @param {string} target absolute candidate
 * @param {{ caseInsensitive?: boolean }} [options]
 * @returns {boolean}
 */
export function isInsideRoot(root, target, { caseInsensitive = process.platform === 'win32' } = {}) {
  try {
    if (typeof root !== 'string' || typeof target !== 'string') return false
    const normalizedRoot = normalizePathForCompare(resolve(root), caseInsensitive)
    const normalizedTarget = normalizePathForCompare(resolve(target), caseInsensitive)
    if (normalizedRoot === normalizedTarget) return true
    const rel = relative(normalizedRoot, normalizedTarget)
    return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
  } catch {
    return false
  }
}

function normalizePathForCompare(value, caseInsensitive) {
  let normalized = resolve(value)
  while (normalized.length > 3 && (normalized.endsWith(sep) || normalized.endsWith('/'))) {
    normalized = normalized.slice(0, -1)
  }
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

function defaultRealpath(target) {
  try {
    const fn = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync
    return fn(target)
  } catch {
    return null
  }
}

/**
 * Decide whether a skill file may be edited by the dreamer.
 *
 * A skill is editable only when all of these hold:
 * - its catalog `source` is in `editableSources` (default `['user-dsh','user-agents']`);
 * - its path resolves to an existing file inside `$DSH_HOME/skills` or `~/.agents/skills`;
 * - the *real* path (all symlinks resolved) is still inside one of those roots.
 *
 * @param {object|string} skillOrPath skill state (`{ path, source }`) or a raw path
 * @param {object} [options]
 * @param {string[]} [options.editableSources]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home]
 * @param {string[]} [options.roots] override the user skill roots (tests/advanced config)
 * @param {(path: string) => string|null} [options.realpath] override for tests
 * @param {string} [options.source] source when the first argument is a raw path
 * @param {boolean} [options.caseInsensitive]
 * @returns {{ ok: boolean, path?: string, resolvedPath?: string, root?: string, reason?: string, source?: string }}
 */
export function isEditableSkill(skillOrPath, options = {}) {
  try {
    const isObject = skillOrPath !== null && typeof skillOrPath === 'object'
    const rawPath = isObject ? skillOrPath.path ?? skillOrPath.skillMeta?.path : skillOrPath
    const source = isObject
      ? skillOrPath.source ?? skillOrPath.skillMeta?.source ?? options.source
      : options.source
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      return { ok: false, reason: 'no-path' }
    }
    const editableSources = Array.isArray(options.editableSources)
      ? options.editableSources.map((item) => String(item).trim()).filter(Boolean)
      : [...DEFAULT_EDITABLE_SOURCES]
    if (editableSources.length === 0) return { ok: false, reason: 'no-editable-sources', source }
    const normalizedSource = typeof source === 'string' ? source.trim() : ''
    if (!editableSources.includes(normalizedSource)) {
      return { ok: false, reason: 'source-not-editable', source: normalizedSource || null }
    }

    const caseInsensitive = options.caseInsensitive ?? process.platform === 'win32'
    const env = options.env ?? process.env
    const home = options.home ?? homedir()
    const roots = Array.isArray(options.roots) && options.roots.length > 0
      ? options.roots.map((root) => resolve(String(root)))
      : computeSkillRoots({ env, home })
    const realpath = typeof options.realpath === 'function' ? options.realpath : defaultRealpath

    const candidate = resolve(rawPath)
    if (!existsSync(candidate)) return { ok: false, reason: 'path-missing' }
    const realCandidate = realpath(candidate)
    if (typeof realCandidate !== 'string' || realCandidate.length === 0) {
      return { ok: false, reason: 'realpath-unavailable' }
    }

    let matchedRoot = null
    for (const root of roots) {
      const rawContainer = isInsideRoot(root, candidate, { caseInsensitive })
      const realRoot = realpath(root) ?? root
      const realContainer = isInsideRoot(realRoot, realCandidate, { caseInsensitive })
      // Both gates must pass: the catalog path is under a user root AND the symlink target is too.
      if (rawContainer && realContainer) {
        matchedRoot = root
        break
      }
    }
    if (matchedRoot === null) {
      // Distinguish "the path is simply not a user skill" from "a symlink escapes the user root".
      const rawInside = roots.some((root) => isInsideRoot(root, candidate, { caseInsensitive }))
      const realInside = roots.some((root) =>
        isInsideRoot(realpath(root) ?? root, realCandidate, { caseInsensitive }),
      )
      return {
        ok: false,
        reason: rawInside && !realInside ? 'symlink-escape' : 'outside-user-skill-roots',
        path: candidate,
        resolvedPath: realCandidate,
      }
    }
    return { ok: true, path: candidate, resolvedPath: realCandidate, root: matchedRoot, source: normalizedSource }
  } catch (error) {
    return { ok: false, reason: 'check-failed', error: safeError(error) }
  }
}

// ---------------------------------------------------------------------------------------------
// semantic safety scan
// ---------------------------------------------------------------------------------------------

/**
 * Deterministic last line of defence against prompt poisoning: the dreamer writes text that is
 * later loaded as trusted skill instructions, so the text we write must not contain instruction
 * overrides, role/tag injection, exfiltration instructions, destructive command invocations or tool
 * coercion.
 *
 * The rules are case-insensitive and word-boundary aware. Exfiltration needs an explicit action or
 * destination cue (a bare "API key" precondition is legitimate), and shell commands need a command
 * position or a real command argument, so ordinary boundary language ("requires an API key",
 * "download it with curl first", "never paste your token into a URL", "do not use this skill for
 * X", "not for", "preconditions", "requires", "read the file", "ask the user") is never rejected.
 *
 * @typedef {{ family: string, pattern: RegExp }} SafetyRule
 */

/** Rule families, ordered from most to least specific. */
export const SAFETY_FAMILIES = Object.freeze([
  'instruction-override',
  'role-injection',
  'exfiltration',
  'destructive-command',
  'tool-coercion',
])

/** @type {ReadonlyArray<SafetyRule>} */
const UNSAFE_RULES = Object.freeze([
  // Instruction override.
  { family: 'instruction-override', pattern: /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:of\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)\b/gi },
  { family: 'instruction-override', pattern: /\boverride\s+(?:the\s+)?(?:system|developer|safety)\b/gi },
  { family: 'instruction-override', pattern: /\bnew\s+instructions?\b/gi },
  { family: 'instruction-override', pattern: /\bsystem\s+prompt\b/gi },
  { family: 'instruction-override', pattern: /\bdeveloper\s+message\b/gi },
  // Role / tag injection.
  { family: 'role-injection', pattern: /<\/?(?:system|assistant)\s*>/gi },
  { family: 'role-injection', pattern: /\[\/?inst\]/gi },
  { family: 'role-injection', pattern: /#{2,}\s*(?:system|instructions?)\b/gi },
  { family: 'role-injection', pattern: /\bbegin\s+(?:system|prompt)\b/gi },
  // Hidden instructions / credential or data exfiltration. A bare noun is NOT unsafe: these
  // require an action verb or a destination URL, so real preconditions survive.
  { family: 'exfiltration', pattern: /\bdo\s*n[o']?t\s+(?:tell|inform|reveal(?:\s+(?:this|it)\s+to)?)\s+(?:the\s+)?user\b/gi },
  { family: 'exfiltration', pattern: /\b(?:reveal|send|post|upload|exfiltrate|forward)\b[^\n]{0,80}?\b(?:secrets?|tokens?|passwords?|api[-_ ]?keys?|credentials?)\b/gi },
  { family: 'exfiltration', pattern: /\b(?:secrets?|tokens?|passwords?|api[-_ ]?keys?|credentials?)\b[^\n]{0,40}?\b(?:to|at)\b\s*https?:\/\//gi },
  { family: 'exfiltration', pattern: /\bexfiltrat\w*/gi },
  { family: 'exfiltration', pattern: /\bsend\s+(?:this|the)\s+(?:data|content)\s+to\b/gi },
  // Destructive or network commands. A command position (start of line, after a shell separator,
  // or after whitespace, as in "run rm -rf") is required; a bare mention of the word is not.
  { family: 'destructive-command', pattern: /(?:^|[;&|`(\s])(?:rm\s+-[a-z]*[rf][a-z]*|del\s+\/[a-z]?|format\s+[a-z]:|powershell\s+-|invoke-webrequest)/gi },
  // `curl`/`wget` count as a command only when followed by a real argument: a flag, a URL or a
  // quote. "download it with curl first" is prose and stays allowed.
  { family: 'destructive-command', pattern: /\b(?:curl|wget)\s+(?:-{1,2}[a-z0-9-]+|https?:\/\/|["'])/gi },
  // Tool coercion: telling the agent which tool it must call.
  { family: 'tool-coercion', pattern: /\bcall\s+(?:the\s+)?[\w.-]{1,40}\s+tool\s+(?:before|instead)\b/gi },
  { family: 'tool-coercion', pattern: /\bmust\s+call\s+(?:the\s+)?[^\n]{1,60}?\s+tool\b/gi },
])

/** Collect every match for one rule without leaking `lastIndex` between calls. */
function ruleMatches(text, rule) {
  const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`
  try {
    return text.match(new RegExp(rule.pattern.source, flags)) ?? []
  } catch {
    return []
  }
}

/**
 * Scan proposed skill text for high-risk control/poisoning patterns.
 *
 * @param {unknown} text text that would be written into a SKILL.md (or injected as guidance)
 * @param {{ families?: string[] }} [options]
 *   `families` limits the scan to those rule families. Guidance/awareness fragments (learned
 *   rules, notes, selection rules) use only `['instruction-override','role-injection']`; skill-file
 *   description/body edits use the full set.
 * @returns {{ ok: boolean, reason?: string, matched?: string, count?: number }}
 *   `ok:true` when safe; otherwise `reason` is the rule family and `matched` the offending snippet.
 *   Fails closed: an internal scan error is reported as unsafe.
 */
export function scanEditSafety(text, options = {}) {
  try {
    const value = typeof text === 'string' ? text : String(text ?? '')
    if (value.trim().length === 0) return { ok: true }
    const requested = Array.isArray(options?.families)
      ? options.families.filter((family) => typeof family === 'string')
      : []
    const families = requested.length > 0 ? new Set(requested) : null
    const rules = families === null ? UNSAFE_RULES : UNSAFE_RULES.filter((rule) => families.has(rule.family))
    for (const rule of rules) {
      const matches = ruleMatches(value, rule)
      if (matches.length > 0) {
        return { ok: false, reason: rule.family, matched: truncate(oneLineSafe(matches[0]), 120), count: matches.length }
      }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'scan-failed', matched: '' }
  }
}

/**
 * Re-check a final rendered file before writing: report unsafe text that the edit *introduced*.
 * Pre-existing unsafe text in the user's own skill file is left alone — only the delta is judged,
 * so a legitimate skill that already mentions e.g. `curl` remains editable.
 *
 * @param {string} originalText current file contents
 * @param {string} nextText final contents that would be written
 * @returns {{reason:string, matched:string}|null}
 */
function introducedUnsafeText(originalText, nextText) {
  for (const rule of UNSAFE_RULES) {
    const nextMatches = ruleMatches(nextText, rule)
    if (nextMatches.length === 0) continue
    const originalMatches = ruleMatches(originalText, rule)
    if (nextMatches.length > originalMatches.length) {
      return { reason: rule.family, matched: truncate(oneLineSafe(nextMatches[0]), 120) }
    }
  }
  return null
}

function oneLineSafe(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------------------------
// edit planning
// ---------------------------------------------------------------------------------------------

/**
 * Plan a `description:` rewrite. Only the scalar span changes; every other byte is preserved.
 *
 * @param {string} currentText
 * @param {string} newDescription
 * @param {object} [options]
 * @param {number} [options.minChars] default `CAPS.descriptionMinChars` (40)
 * @param {number} [options.maxChars] default `CAPS.descriptionMaxChars` (500)
 * @param {boolean} [options.removeClaim] allow removing the original capability claim
 * @param {string[]} [options.evidence] required with `removeClaim`
 * @param {number} [options.minClaimOverlap] default 0.6
 * @returns {{ok:true,newText:string,before:string,after:string,style:string,styleChanged:boolean,expectDescription:string,field:object}|{ok:false,reason:string}}
 */
export function planDescriptionEdit(currentText, newDescription, options = {}) {
  try {
    if (typeof currentText !== 'string' || currentText.length === 0) return fail('empty-file')
    const minChars = clamp(asInt(options.minChars, 1, 100000, CAPS.descriptionMinChars), 1, 100000)
    const maxChars = clamp(asInt(options.maxChars, minChars, 1000000, CAPS.descriptionMaxChars), minChars, 1000000)
    const clean = normalizeNewDescription(newDescription)
    if (clean === null) return fail('empty-description')
    if (PARAGRAPH_BREAK.test(String(newDescription))) return fail('multiple-paragraphs')
    if (clean.length < minChars) return fail('description-too-short')
    if (clean.length > maxChars) return fail('description-too-long')

    const descriptionSafety = scanEditSafety(clean)
    if (descriptionSafety.ok !== true) {
      return {
        ok: false,
        reason: 'unsafe-content',
        matched: descriptionSafety.matched,
        pattern: descriptionSafety.reason,
      }
    }

    const parsed = parseSkillMarkdown(currentText)
    if (!parsed.hasFrontmatter) {
      return fail(parsed.malformedFrontmatter ? 'malformed-frontmatter' : 'no-frontmatter')
    }
    const field = parsed.descriptionField
    if (field === null) return fail('no-description')
    if (field.ambiguous) return fail('ambiguous-description')
    if (!field.supported) return fail(field.reason ?? 'unsupported-description-form')

    const original = field.value ?? ''
    if (options.removeClaim === true) {
      const evidence = Array.isArray(options.evidence) ? options.evidence.filter(Boolean) : []
      if (evidence.length === 0) return fail('remove-claim-without-evidence')
    } else if (original.trim().length > 0) {
      const overlap = claimOverlap(original, clean)
      const required = typeof options.minClaimOverlap === 'number' ? options.minClaimOverlap : DEFAULT_CLAIM_OVERLAP
      if (overlap < required) return fail('claim-removed')
    }

    const rendered = renderDescriptionScalar(clean, field, parsed.eol)
    if (!rendered.ok) return fail(rendered.reason)
    const newText = currentText.slice(0, field.valueStart) + rendered.text + currentText.slice(field.valueEnd)
    const changed = newText !== currentText

    const verification = parseSkillMarkdown(newText)
    if (!verification.hasFrontmatter) return fail('internal-verification-failed')
    if (verification.descriptionField === null || verification.descriptionField.value !== rendered.decoded) {
      return fail('internal-verification-failed')
    }
    // Unrelated frontmatter must be byte-identical by construction; check the decoded values too.
    for (const [key, value] of Object.entries(parsed.frontmatter)) {
      if (key === 'description') continue
      if (verification.frontmatter[key] !== value) return fail('internal-verification-failed')
    }
    if (verification.body !== parsed.body) return fail('internal-verification-failed')

    return {
      ok: true,
      newText,
      before: sha256(currentText),
      after: sha256(newText),
      changed,
      style: field.style,
      styleChanged: rendered.styleChanged,
      expectDescription: rendered.decoded,
      field: { key: 'description', style: field.style, styleChanged: rendered.styleChanged },
    }
  } catch (error) {
    return { ok: false, reason: 'plan-failed', error: safeError(error) }
  }
}

/**
 * Plan a marked body-section replacement (or append when no marked block exists yet).
 * The block is delimited by `constants.SKILL_EDIT.beginMarker` / `endMarker`; an existing block is
 * replaced, never duplicated, and nothing above the block is touched.
 *
 * @param {string} currentText
 * @param {string} sectionMarkdown
 * @param {object} [options]
 * @param {number} [options.maxChars] default `CAPS.bodySectionMaxChars` (2400)
 * @param {string} [options.heading] heading used when the section has none
 * @returns {{ok:true,newText:string,before:string,after:string,replaced:boolean,expectBodySection:true}|{ok:false,reason:string}}
 */
export function planBodySectionEdit(currentText, sectionMarkdown, options = {}) {
  try {
    if (typeof currentText !== 'string') return fail('empty-file')
    if (typeof sectionMarkdown !== 'string') return fail('empty-section')
    const maxChars = clamp(asInt(options.maxChars, 100, 1000000, CAPS.bodySectionMaxChars), 100, 1000000)
    let section = sectionMarkdown.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, ' ').trim()
    if (section.length === 0) return fail('empty-section')
    if (section.includes(SKILL_EDIT.beginMarker) || section.includes(SKILL_EDIT.endMarker)) {
      return fail('contains-markers')
    }
    if (section.length > maxChars) return fail('section-too-long')

    const sectionSafety = scanEditSafety(section)
    if (sectionSafety.ok !== true) {
      return {
        ok: false,
        reason: 'unsafe-content',
        matched: sectionSafety.matched,
        pattern: sectionSafety.reason,
      }
    }

    const parsed = parseSkillMarkdown(currentText)
    const eol = parsed.eol
    const normalizedSection = section.split('\n').join(eol)
    const heading = typeof options.heading === 'string' && options.heading.trim().length > 0
      ? options.heading.trim()
      : SKILL_EDIT.heading
    const bodyMarkdown = /^#{1,6}[ \t]/.test(section) ? normalizedSection : `${heading}${eol}${eol}${normalizedSection}`
    const block = `${SKILL_EDIT.beginMarker}${eol}${bodyMarkdown}${eol}${SKILL_EDIT.endMarker}`

    const located = findMarkedBlock(currentText, parsed.bodyStart)
    if (located.error !== undefined) return fail(located.error)

    let newText
    let replaced
    if (located.block !== null) {
      newText = currentText.slice(0, located.block.start) + block + currentText.slice(located.block.end)
      replaced = true
    } else {
      const endsWithEol = currentText.endsWith('\n')
      let prefix = currentText
      if (currentText.length > 0) {
        if (!endsWithEol) prefix = `${currentText}${eol}`
        else if (!currentText.endsWith(`${eol}${eol}`)) prefix = `${currentText}${eol}`
      }
      newText = `${prefix}${block}${endsWithEol || currentText.length === 0 ? eol : ''}`
      replaced = false
      // Appended text must start with the original file byte-for-byte.
      if (!newText.startsWith(currentText)) return fail('internal-verification-failed')
    }
    if (newText === currentText && replaced === false) return fail('no-change')

    const verification = parseSkillMarkdown(newText)
    const markers = countMarkers(verification.text)
    if (markers.begin !== 1 || markers.end !== 1) return fail('internal-verification-failed')
    const verifyBlock = findMarkedBlock(newText, verification.bodyStart)
    if (verifyBlock.error !== undefined || verifyBlock.block === null) return fail('internal-verification-failed')
    const content = newText.slice(verifyBlock.block.start, verifyBlock.block.end)
    if (!content.includes(SKILL_EDIT.beginMarker) || !content.includes(SKILL_EDIT.endMarker)) {
      return fail('internal-verification-failed')
    }
    if (!content.includes(normalizedSection.split(eol)[0])) return fail('internal-verification-failed')

    return {
      ok: true,
      newText,
      before: sha256(currentText),
      after: sha256(newText),
      replaced,
      changed: newText !== currentText,
      expectBodySection: true,
    }
  } catch (error) {
    return { ok: false, reason: 'plan-failed', error: safeError(error) }
  }
}

function findMarkedBlock(text, bodyStart) {
  const beginCount = countOccurrences(text, SKILL_EDIT.beginMarker)
  const endCount = countOccurrences(text, SKILL_EDIT.endMarker)
  if (beginCount === 0 && endCount === 0) return { block: null }
  if (beginCount !== 1 || endCount !== 1) return { error: 'malformed-markers' }
  const start = text.indexOf(SKILL_EDIT.beginMarker)
  const endStart = text.indexOf(SKILL_EDIT.endMarker)
  if (start < 0 || endStart < start) return { error: 'malformed-markers' }
  if (typeof bodyStart === 'number' && start < bodyStart) return { error: 'markers-in-frontmatter' }
  return { block: { start, end: endStart + SKILL_EDIT.endMarker.length } }
}

function countMarkers(text) {
  return {
    begin: countOccurrences(text, SKILL_EDIT.beginMarker),
    end: countOccurrences(text, SKILL_EDIT.endMarker),
  }
}

function countOccurrences(text, needle) {
  if (needle.length === 0) return 0
  let count = 0
  let index = text.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

/** Flatten a proposed description into exactly one paragraph, or null when empty. */
function normalizeNewDescription(value) {
  if (typeof value !== 'string') return null
  const flattened = value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flattened.length === 0 ? null : flattened
}

/**
 * Heuristic capability-claim preservation: the new description must keep most of the original's
 * significant tokens (ASCII words, CJK characters). Not a semantic check — a cheap guard against a
 * dreamer silently deleting a capability claim.
 */
function claimOverlap(original, proposed) {
  const tokens = significantTokens(original)
  if (tokens.length === 0) return 1
  const proposedTokens = new Set(significantTokens(proposed))
  let kept = 0
  for (const token of tokens) if (proposedTokens.has(token)) kept += 1
  return kept / tokens.length
}

function significantTokens(text) {
  const value = String(text ?? '').toLowerCase()
  const tokens = []
  const words = value.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []
  tokens.push(...words)
  const cjk = value.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []
  tokens.push(...cjk)
  return [...new Set(tokens)]
}

function renderDescriptionScalar(value, field, eol) {
  switch (field.style) {
    case 'single':
      return { ok: true, text: `'${value.replace(/'/g, "''")}'`, decoded: value, styleChanged: false }
    case 'double':
      return { ok: true, text: `"${escapeDoubleQuoted(value)}"`, decoded: value, styleChanged: false }
    case 'plain':
      if (isPlainSafe(value)) return { ok: true, text: ` ${value}`, decoded: value, styleChanged: false }
      // Preserve the field (single line), upgrade the quoting only because plain YAML would corrupt
      // the new value. The plan reports `styleChanged` so the journal can explain it.
      return { ok: true, text: ` "${escapeDoubleQuoted(value)}"`, decoded: value, styleChanged: true }
    case 'literal':
    case 'folded': {
      const block = field.block ?? { indicator: '|', chomping: '', indent: 2 }
      const indent = ' '.repeat(block.indent)
      const head = `${block.indicator}${block.chomping}${eol}${indent}${value}`
      // Block scalars have chomping semantics: clip (default) keeps one trailing newline, strip ('-')
      // keeps none, keep ('+') keeps what the block emitted (we emit exactly one).
      const decoded = block.chomping === '-' ? value : `${value}\n`
      return { ok: true, text: field.endsWithEol ? `${head}${eol}` : head, decoded, styleChanged: false }
    }
    default:
      return { ok: false, reason: 'unsupported-description-form' }
  }
}

function escapeDoubleQuoted(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}

const PLAIN_UNSAFE_START = /^[-?:,[\]{}#&*!|>'"%@`\s]/
const PLAIN_UNSAFE_BODY = /:[ \t]|[ \t]#|\s$/

function isPlainSafe(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value !== value.trim()) return false
  if (/[\n\r\t]/.test(value)) return false
  if (PLAIN_UNSAFE_START.test(value)) return false
  if (PLAIN_UNSAFE_BODY.test(value)) return false
  return true
}

// ---------------------------------------------------------------------------------------------
// apply / revert
// ---------------------------------------------------------------------------------------------

/**
 * Apply a validated plan: back up, write atomically, verify by hash and re-parse.
 * Never throws; every expected failure is `{ ok:false, reason }`.
 *
 * @param {object} args
 * @param {object} args.plan result of `planDescriptionEdit`/`planBodySectionEdit`
 * @param {{id:string,dreamId?:string,skill:string,kind:string,path:string}} args.edit
 * @param {string} args.dataDir plugin data directory (backups live under `<dataDir>/backups/<editId>`)
 * @param {object} [args.logger]
 * @param {() => number} [args.now]
 * @returns {Promise<{ok:true,edit:object}|{ok:false,reason:string,error?:object}>}
 */
export async function applyEditPlan({ plan, edit, dataDir, logger, now = Date.now } = {}) {
  try {
    if (plan === null || typeof plan !== 'object' || plan.ok !== true) return fail('invalid-plan')
    if (typeof plan.newText !== 'string' || typeof plan.before !== 'string' || typeof plan.after !== 'string') {
      return fail('invalid-plan')
    }
    if (edit === null || typeof edit !== 'object') return fail('invalid-edit')
    if (typeof edit.id !== 'string' || edit.id.length === 0) return fail('invalid-edit')
    if (typeof edit.path !== 'string' || edit.path.length === 0) return fail('invalid-edit')
    if (typeof edit.skill !== 'string' || edit.skill.length === 0) return fail('invalid-edit')
    if (typeof edit.kind !== 'string' || edit.kind.length === 0) return fail('invalid-edit')
    if (typeof dataDir !== 'string' || dataDir.length === 0) return fail('invalid-data-dir')

    const target = resolve(edit.path)
    if (!existsSync(target)) return fail('missing-file')
    // Atomic replace of a path that is itself a symlink would replace the LINK, not the data
    // the user expects to edit. Refuse and let the dream record a suggestion instead.
    try {
      if (lstatSync(target).isSymbolicLink()) return fail('symlink-path')
    } catch {
      return fail('missing-file')
    }
    const original = readFileSync(target)
    const originalText = original.toString('utf8')
    if (!Buffer.from(originalText, 'utf8').equals(original)) return fail('unsafe-encoding')
    if (sha256(originalText) !== plan.before) return fail('stale-plan')

    // Re-scan the final text immediately before writing. A plan that was tampered with after
    // planning reintroduces unsafe text here; pre-existing unsafe text in the user's own file is
    // allowed because only the delta is judged.
    const finalSafety = scanEditSafety(plan.newText)
    if (finalSafety.ok !== true) {
      const introduced = introducedUnsafeText(originalText, plan.newText)
      if (introduced !== null) {
        return { ok: false, reason: 'unsafe-content', matched: introduced.matched, pattern: introduced.reason }
      }
    }

    const backupDir = join(resolve(dataDir), LAYOUT.backups, edit.id)
    const backupPath = join(backupDir, 'SKILL.md')
    if (existsSync(backupPath)) return fail('backup-collision')
    try {
      mkdirSync(backupDir, { recursive: true })
      copyFileSync(target, backupPath)
    } catch (error) {
      return { ok: false, reason: 'backup-failed', error: safeError(error) }
    }
    const backupText = readSkillFile(backupPath)
    if (backupText === null || sha256(backupText) !== plan.before) {
      return fail('backup-corrupt')
    }

    const written = atomicWriteText(target, plan.newText)
    if (!written.ok) return { ok: false, reason: 'write-failed', error: safeError(written.error) }

    const afterText = readSkillFile(target)
    if (afterText === null || sha256(afterText) !== plan.after) {
      restoreQuietly(target, backupText)
      return fail('verify-failed')
    }
    const reparsed = parseSkillMarkdown(afterText)
    if (plan.expectDescription !== undefined) {
      if (reparsed.hasFrontmatter !== true || reparsed.descriptionField?.value !== plan.expectDescription) {
        restoreQuietly(target, backupText)
        return fail('verify-failed')
      }
    }
    if (plan.expectBodySection === true) {
      const markers = countMarkers(afterText)
      if (markers.begin !== 1 || markers.end !== 1) {
        restoreQuietly(target, backupText)
        return fail('verify-failed')
      }
    }

    const record = {
      id: edit.id,
      dreamId: typeof edit.dreamId === 'string' ? edit.dreamId : null,
      skill: edit.skill,
      kind: edit.kind,
      path: target,
      appliedAt: safeNow(now),
      before: { sha256: plan.before, text: originalText },
      after: { sha256: plan.after },
      backupPath,
      status: 'applied',
      revertedAt: null,
    }
    return { ok: true, edit: record }
  } catch (error) {
    return { ok: false, reason: 'apply-failed', error: safeError(error) }
  }
}

/** Contract alias: apply a validated edit plan. */
export const applySkillEdits = applyEditPlan

/**
 * Revert an applied edit from its byte backup.
 *
 * Refuses with `{ ok:false, reason:'conflict' }` when the file no longer hashes to the recorded
 * post-edit value (someone edited it after the dream) — it never clobbers those changes.
 *
 * @param {object} args
 * @param {object} args.edit edit record from `edits.json`
 * @param {string} args.dataDir plugin data directory
 * @param {string} [args.currentText] current file text when the caller already read it
 * @param {object} [args.logger]
 * @param {() => number} [args.now]
 * @returns {Promise<{ok:true,status:'reverted',revertedAt:number,path:string}|{ok:false,reason:string,error?:object}>}
 */
export async function revertEdit({ edit, dataDir, currentText, logger, now = Date.now } = {}) {
  try {
    if (edit === null || typeof edit !== 'object') return fail('invalid-edit')
    if (typeof edit.path !== 'string' || edit.path.length === 0) return fail('invalid-edit')
    if (typeof edit.after?.sha256 !== 'string' || edit.after.sha256.length === 0) return fail('invalid-edit')
    const target = resolve(edit.path)
    const text = typeof currentText === 'string' ? currentText : readSkillFile(target)
    if (text === null) return fail('missing-file')
    if (sha256(text) !== edit.after.sha256) return fail('conflict')

    const backupPath = typeof edit.backupPath === 'string' && edit.backupPath.length > 0
      ? edit.backupPath
      : typeof edit.id === 'string' && typeof dataDir === 'string'
        ? join(resolve(dataDir), LAYOUT.backups, edit.id, 'SKILL.md')
        : null
    if (backupPath === null || !existsSync(backupPath)) return fail('backup-missing')
    const backupText = readSkillFile(backupPath)
    if (backupText === null) return fail('backup-unreadable')
    if (typeof edit.before?.sha256 === 'string' && sha256(backupText) !== edit.before.sha256) {
      return fail('backup-corrupt')
    }

    // Re-check the hash immediately before writing: narrows (does not eliminate) the TOCTOU window.
    const currentOnDisk = readSkillFile(target)
    if (currentOnDisk === null || sha256(currentOnDisk) !== edit.after.sha256) return fail('conflict')

    const written = atomicWriteText(target, backupText)
    if (!written.ok) return { ok: false, reason: 'write-failed', error: safeError(written.error) }
    const restored = readSkillFile(target)
    if (restored === null || (typeof edit.before?.sha256 === 'string' && sha256(restored) !== edit.before.sha256)) {
      return fail('verify-failed')
    }
    return { ok: true, status: 'reverted', revertedAt: safeNow(now), path: target }
  } catch (error) {
    return { ok: false, reason: 'revert-failed', error: safeError(error) }
  }
}

function atomicWriteText(target, text) {
  const dir = dirname(target)
  const tmp = join(dir, `.${basename(target)}.dreaming-${process.pid}-${Date.now().toString(36)}.tmp`)
  let mode
  try {
    mode = statSync(target).mode
  } catch {
    mode = undefined
  }
  try {
    writeFileSync(tmp, text, 'utf8')
    if (mode !== undefined) {
      try {
        chmodSync(tmp, mode & 0o777)
      } catch {
        // Windows may not support POSIX modes; not fatal.
      }
    }
    renameSync(tmp, target)
    return { ok: true }
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // best effort
    }
    return { ok: false, error }
  }
}

function restoreQuietly(target, text) {
  try {
    atomicWriteText(target, text)
  } catch (error) {
    // The caller reports verify-failed; the backup remains on disk for manual recovery.
    void error
  }
}

function fail(reason) {
  return { ok: false, reason }
}

function safeNow(now) {
  try {
    const value = typeof now === 'function' ? now() : now
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
  } catch {
    return Date.now()
  }
}
