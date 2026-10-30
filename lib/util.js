/**
 * Dependency-free helpers: identifiers, text budgeting, loose JSON, and the small
 * durable-file primitives the store builds on.
 *
 * Design rules:
 * - every filesystem write is atomic or append-only; no partial JSON is ever left behind;
 * - reads never throw: a corrupt file is copied aside and reported, then replaced in memory;
 * - no helper performs network or model work, so all of this is unit-testable.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** Compact, sortable-enough unique id: `prefix_<base36 time>_<6 random chars>`. */
export function makeId(prefix) {
  const time = Date.now().toString(36)
  const rand = randomBytes(4).toString('hex').slice(0, 6)
  return `${prefix}_${time}_${rand}`
}

/** SHA-256 hex digest of a string or Buffer. */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Clamp a number into [min, max]; non-finite input falls back to `fallback`. */
export function clamp(value, min, max, fallback = min) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Coerce to a trimmed string; never returns non-strings. */
export function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** Coerce to a non-negative integer, clamped to [min, max]. */
export function asInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.round(Math.min(max, Math.max(min, number)))
}

/** Coerce to a boolean; only `true`/`false` and the strings 'true'/'false' count. */
export function asBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Collapse runs of whitespace into single spaces and trim. */
export function normalizeWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** One-line rendering used in prompt bullet lists and the dashboard. */
export function oneLine(text, maxChars = 240) {
  return truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), maxChars)
}

/** Truncate by code units with an explicit ellipsis; never splits a surrogate pair. */
export function truncate(text, maxChars) {
  const value = String(text ?? '')
  if (maxChars <= 0) return ''
  if (value.length <= maxChars) return value
  let cut = Math.max(0, maxChars - 1)
  const code = value.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return `${value.slice(0, cut)}…`
}

/** Keep the head and tail of a long text; useful for skill bodies and traces. */
export function truncateMiddle(text, maxChars) {
  const value = String(text ?? '')
  if (value.length <= maxChars) return value
  const head = Math.ceil(indices(maxChars) * 0.62)
  const tail = Math.max(0, indices(maxChars) - head - 1)
  return `${value.slice(0, head)}\n…\n${value.slice(value.length - tail)}`
}

function indices(maxChars) {
  return Math.max(1, maxChars)
}

/**
 * Rough token budget: ~3.5 UTF-16 units per token for mixed English/CJK technical text.
 * Deliberately conservative: budgets must not undershoot the provider's real cost.
 */
export function estimateTokens(chars) {
  const length = typeof chars === 'number' ? chars : String(chars ?? '').length
  return Math.max(1, Math.ceil(length / 3.5))
}

/**
 * Parse JSON that a model may have wrapped in prose or fences.
 * Returns `undefined` when no JSON value can be recovered; callers treat that as a failure.
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const candidates = [trimmed]
  const fences = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/gi)
  if (fences) {
    for (const fence of fences) {
      candidates.push(fence.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim())
    }
  }
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  const firstBracket = trimmed.indexOf('[')
  const lastBracket = trimmed.lastIndexOf(']')
  if (firstBracket >= 0 && lastBracket > firstBracket) candidates.push(trimmed.slice(firstBracket, lastBracket + 1))
  for (const candidate of candidates) {
    for (const attempt of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        const value = JSON.parse(attempt)
        if (value !== null && typeof value === 'object') return value
      } catch {
        // try the next candidate
      }
    }
  }
  return undefined
}

/**
 * Best-effort recovery for a JSON object cut off by the model's output cap.
 * Closes an unterminated string and the open containers; when that still fails, drops
 * trailing members one at a time until the remaining prefix parses. Returns `undefined`
 * when no object can be recovered. Only used after `parseJsonLoose` fails, so a complete
 * reply always wins over a repaired one.
 */
export function repairJsonLoose(text) {
  if (typeof text !== 'string') return undefined
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let fragment = text.slice(start).replace(/```[\s\S]*$/, '')
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = closeJsonFragment(fragment)
    if (candidate !== undefined) {
      try {
        const value = JSON.parse(candidate)
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
      } catch {
        // fall through to a shorter prefix
      }
    }
    const cut = lastJsonSeparator(fragment)
    if (cut < 0) return undefined
    fragment = fragment.slice(0, cut)
  }
  return undefined
}

/** Close strings/containers of a truncated JSON fragment; `undefined` on mismatched brackets. */
function closeJsonFragment(fragment) {
  let inString = false
  let escaped = false
  const stack = []
  for (const ch of fragment) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return undefined
    }
  }
  let out = fragment
  if (inString) out += '"'
  out = out.replace(/\s+$/u, '')
  while (out.length > 0 && (out.endsWith(',') || out.endsWith(':'))) {
    out = out.slice(0, -1).replace(/\s+$/u, '')
  }
  for (let index = stack.length - 1; index >= 0; index -= 1) out += stack[index]
  return out
}

/** Index of the last `,` or `:` outside a JSON string, or -1. */
function lastJsonSeparator(fragment) {
  let inString = false
  let escaped = false
  let last = -1
  for (let index = 0; index < fragment.length; index += 1) {
    const ch = fragment[index]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === ',' || ch === ':') last = index
  }
  return last
}

/** Whether `child` is inside `parent` after path normalization (caller passes resolved paths). */
export function isInside(parent, child) {
  const normalizedParent = String(parent).replace(/[\\/]+$/, '').toLowerCase()
  const normalizedChild = String(child).toLowerCase()
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}\\`) || normalizedChild.startsWith(`${normalizedParent}/`)
}

/** Safe error projection for journals and logs: never stores stacks or prompt content. */
export function safeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: oneLine(error.message, 300),
      code: typeof error.code === 'string' ? error.code : undefined,
    }
  }
  return { name: 'Error', message: oneLine(String(error), 300) }
}

/** Compose an AbortSignal with a timeout in a way the caller can always clean up. */
export function withTimeout(timeoutMs, parentSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1, timeoutMs))
  const onAbort = () => controller.abort(parentSignal.reason)
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason)
    else parentSignal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      if (parentSignal) parentSignal.removeEventListener('abort', onAbort)
    },
  }
}

/** Resolve and create a directory, returning the path. */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Atomically write a JSON file: write tmp, fsync-ish flush, rename over the target.
 * A reader therefore sees either the old complete file or the new complete file.
 */
export function atomicWriteJson(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  const text = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // best effort
    }
    throw error
  }
}

/** Append one JSON line. Used for the append-only episode journal. */
export function appendJsonl(file, value) {
  ensureDir(dirname(file))
  appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
}

/**
 * Read a JSON document. `onCorrupt(path)` decides what to do with an unreadable file
 * (the store moves it aside); this helper only reports and returns the fallback.
 */
export function readJson(file, fallback, onCorrupt) {
  if (!existsSync(file)) return { value: fallback, corrupt: false }
  try {
    const text = readFileSync(file, 'utf8')
    if (text.trim().length === 0) return { value: fallback, corrupt: false }
    return { value: JSON.parse(text), corrupt: false }
  } catch (error) {
    onCorrupt?.(file, error)
    return { value: fallback, corrupt: true }
  }
}

/**
 * Scan an append-only JSONL journal, keeping only parseable lines and reporting how many
 * were skipped. Never throws for a corrupt tail (a crash can truncate the last line).
 */
export function readJsonl(file, { maxBytes = 64 * 1024 * 1024 } = {}) {
  if (!existsSync(file)) return { rows: [], skipped: 0, bytes: 0 }
  let text
  try {
    const stat = statSync(file)
    if (stat.size > maxBytes) {
      // Read only the tail: the journal only needs the newest episodes.
      const fd = readFileSync(file).subarray(-maxBytes)
      text = fd.toString('utf8')
    } else {
      text = readFileSync(file, 'utf8')
    }
  } catch {
    return { rows: [], skipped: 0, bytes: 0 }
  }
  const rows = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      skipped += 1
    }
  }
  return { rows, skipped, bytes: Buffer.byteLength(text, 'utf8') }
}

/** Move a corrupt file aside, preserving it for diagnosis. Returns the new path or null. */
export function quarantineFile(file, dir) {
  try {
    if (!existsSync(file)) return null
    ensureDir(dir)
    const target = join(dir, `${file.split(/[\\/]/).pop()}.corrupt-${Date.now()}`)
    copyFileSync(file, target)
    return target
  } catch {
    return null
  }
}

/** Best-effort directory size in bytes (backend diagnostics only). */
export function directoryBytes(dir) {
  try {
    let total = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) total += directoryBytes(full)
      else if (entry.isFile()) total += statSync(full).size
    }
    return total
  } catch {
    return 0
  }
}

/** Format a timestamp in a fixed locale-independent shape for the API and journal. */
export function isoTime(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/** Wall-clock parts for an arbitrary IANA zone; throws for an invalid zone. */
export function zonedParts(ms, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || undefined,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(ms))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? 0 : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  }
}

/** Fixed-width local wall-clock string `YYYY-MM-DD HH:MM`. */
export function localTimeString(ms, timeZone) {
  const p = zonedParts(ms, timeZone)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}
