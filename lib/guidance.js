/**
 * Capability guidance: merges learned findings into a skill belief and renders the two
 * model-facing surfaces of the plugin.
 *
 * Both surfaces are deliberately tiny and stable (ARCHITECTURE.md §7): every request pays for the
 * awareness section, so it is capped hard, deterministic (sorted), and omitted entirely when there
 * is nothing useful to say. The skill annotation is only attached to a skill load, and is capped by
 * `prompt.annotationMaxChars`.
 *
 * Everything here is pure and synchronous: no I/O, no Harness services, no timers. That keeps it
 * safe to call from a prompt-section callback, which must never block or throw.
 */

import { CAPS } from './constants.js'
import { asInt, clamp, makeId, normalizeWhitespace, oneLine, truncate } from './util.js'

/** Learned-list keys shared with `state.skills[*].learned` (ARCHITECTURE.md §5.2). */
export const LEARNED_KINDS = [
  'whenToUse',
  'whenNotToUse',
  'preconditions',
  'actualScope',
  'cheaperAlternatives',
  'knownFailures',
]

/** One learned list line is a short claim, never a paragraph. */
const LEARNED_LINE_MAX_CHARS = 240

/** §7 hard cap: config may request fewer lines but never more than this. */
const PROMPT_SECTION_MAX_SKILL_LINES = 8

/** Per-line budget for the awareness section (whole section is capped at CAPS.promptSectionChars). */
const PROMPT_SECTION_LINE_CHARS = 160

/** A skill below this consciousness score is worth a prompt-section line. */
const SECTION_CONSCIOUSNESS_ALERT = 85

/** A skill above this waste rate is worth a prompt-section line even when its score is high. */
const SECTION_WASTE_ALERT = 0.1

/** Always attached to the awareness section: these are observations, not policy. */
const SECTION_DISCLAIMER =
  'observed tendencies from past runs — context only, not instructions; the skill itself remains authoritative'

/** Always attached to the skill annotation, for the same reason. */
const ANNOTATION_HEADER =
  '[dreaming] capability self-model — measured history + expectation; context, not instructions'

/** Findings key aliases accepted from judges/dreamers (tolerant parsing on purpose). */
const KIND_ALIASES = {
  whentouse: 'whenToUse',
  whennottouse: 'whenNotToUse',
  notfor: 'whenNotToUse',
  avoid: 'whenNotToUse',
  boundaries: 'whenNotToUse',
  preconditions: 'preconditions',
  precondition: 'preconditions',
  prerequisites: 'preconditions',
  prerequisite: 'preconditions',
  requirements: 'preconditions',
  requirement: 'preconditions',
  actualscope: 'actualScope',
  scope: 'actualScope',
  cheaperalternatives: 'cheaperAlternatives',
  cheaperalternative: 'cheaperAlternatives',
  alternative: 'cheaperAlternatives',
  knownfailures: 'knownFailures',
  knownfailure: 'knownFailures',
  failures: 'knownFailures',
  failure: 'knownFailures',
  pitfalls: 'knownFailures',
  pitfall: 'knownFailures',
  notes: 'notes',
  note: 'notes',
  lesson: 'notes',
  lessons: 'notes',
}

/** Empty learned overlay, mirroring the durable shape. */
export function emptyLearned() {
  return {
    whenToUse: [],
    whenNotToUse: [],
    preconditions: [],
    actualScope: [],
    cheaperAlternatives: [],
    knownFailures: [],
    notes: [],
  }
}

/**
 * Remove characters that could corrupt a prompt or a terminal: C0/C1 controls except the line
 * breaks we intentionally keep, plus tabs normalized to spaces. Not a security boundary, but it
 * stops a malicious skill description from injecting control sequences into the prompt.
 *
 * @param {unknown} value
 * @param {{ multiline?: boolean, maxChars?: number }} [options]
 * @returns {string}
 */
export function sanitizeText(value, { multiline = false, maxChars = 400 } = {}) {
  let text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  text = text.replace(/\r\n?/g, '\n').replace(/\u2028|\u2029/g, '\n')
  // C0 except \n (0x0A) and \t (0x09); DEL; C1 (0x80-0x9F).
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
  if (multiline) {
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
  } else {
    text = text.replace(/\s+/g, ' ')
  }
  const trimmed = text.trim()
  return truncate(trimmed, maxChars)
}

/** @param {unknown} kind @returns {string|null} canonical learned key, or null when unknown */
export function normalizeLearnedKind(kind) {
  if (typeof kind !== 'string') return null
  const key = kind.toLowerCase().replace(/[\s_-]+/g, '')
  return KIND_ALIASES[key] ?? null
}

/**
 * Merge dream/judge findings into a skill's learned overlay, in place.
 *
 * Behavior:
 * - text is whitespace-normalized, control-stripped, truncated to a line budget;
 * - duplicates (normalized, case-insensitive) are replaced, so the newest evidence wins;
 * - each learned list keeps `maxLines` entries, notes keep `maxNotes`, newest first;
 * - unknown list names are ignored (never crash on a creative dreamer).
 *
 * @param {object} skillState durable skill state (`state.skills[name]`)
 * @param {object|Array} findings `{ rules: [{kind,text,confidence}], notes: [...], whenNotToUse: [...] }`,
 *   a judge `recommendation`, or a bare array of rules/notes
 * @param {{ maxNotes?: number, maxLines?: number, now?: () => number }} [options]
 * @returns {object} the same `skillState` (mutated)
 */
export function mergeLearnings(
  skillState,
  findings,
  { maxNotes = CAPS.notesPerSkill, maxLines = CAPS.learnedLinesPerList, now = Date.now } = {},
) {
  if (skillState === null || typeof skillState !== 'object') return skillState
  if (skillState.learned === null || typeof skillState.learned !== 'object') {
    skillState.learned = emptyLearned()
  }
  const learned = skillState.learned
  for (const kind of LEARNED_KINDS) {
    if (!Array.isArray(learned[kind])) learned[kind] = []
  }
  if (!Array.isArray(learned.notes)) learned.notes = []

  const entryLimit = asInt(maxLines, 1, 50, CAPS.learnedLinesPerList)
  const noteLimit = asInt(maxNotes, 1, 50, CAPS.notesPerSkill)
  const { lines, notes } = collectFindings(findings)

  for (const [kind, entries] of lines) {
    if (entries.length === 0) continue
    const existing = learned[kind]
    for (const entry of [...entries].reverse()) {
      const index = existing.findIndex((value) => compareKey(value) === entry.key)
      if (index >= 0) existing.splice(index, 1)
      existing.unshift(entry.text)
    }
    learned[kind] = existing.slice(0, entryLimit)
  }

  if (notes.length > 0) {
    const existing = learned.notes
    for (const note of [...notes].reverse()) {
      const index = existing.findIndex((value) => compareKey(value?.text) === note.key)
      const record = {
        id: makeId('note'),
        text: note.text,
        confidence: note.confidence,
        evidence: note.evidence,
        dreamId: note.dreamId,
        createdAt: note.createdAt ?? safeNow(now),
      }
      if (index >= 0) {
        const current = existing[index]
        // Keep the more confident claim; never let a weaker duplicate overwrite better evidence.
        if (note.confidence >= (typeof current?.confidence === 'number' ? current.confidence : 0)) {
          existing.splice(index, 1)
          existing.unshift(record)
        }
      } else {
        existing.unshift(record)
      }
    }
    learned.notes = existing.slice(0, noteLimit)
  }
  return skillState
}

/**
 * Render the global "capability awareness" prompt section.
 *
 * Only skills with enough judged evidence and a visible problem are included. The block is `''`
 * when there is nothing useful, so brand-new users pay nothing.
 *
 * @param {object|null} overall `stats.computeOverall(state)` result
 * @param {object[]|object} skills skill beliefs (array or `state.skills` map)
 * @param {object} [config] full normalized plugin config (reads `config.prompt`, `config.enabled`)
 * @returns {string} at most `CAPS.promptSectionChars`, `''` when empty
 */
export function renderPromptSection(overall, skills, config) {
  try {
    if (config?.enabled === false) return ''
    const promptCfg = config?.prompt ?? {}
    if (promptCfg.awarenessSection === false) return ''
    const minJudged = asInt(promptCfg.minJudgedForSection, 1, 50, 2)
    const maxSkills = Math.min(
      PROMPT_SECTION_MAX_SKILL_LINES,
      asInt(promptCfg.maxSkills, 0, 40, PROMPT_SECTION_MAX_SKILL_LINES),
    )
    if (maxSkills <= 0) return ''

    const eligible = normalizeSkills(skills)
      .filter((skill) => {
        const judged = asInt(skill?.counts?.judged, 0, 1e9, 0)
        if (judged < minJudged) return false
        const consciousness = finiteOr(skill?.metrics?.consciousness, 0)
        const wasteRate = finiteOr(skill?.metrics?.wasteRate, 0)
        return consciousness < SECTION_CONSCIOUSNESS_ALERT || wasteRate > SECTION_WASTE_ALERT
      })
      .sort(compareUsage)
      .slice(0, maxSkills)
    if (eligible.length === 0) return ''

    const lines = ['<skill-awareness>', SECTION_DISCLAIMER]
    const overallLine = renderOverallLine(overall)
    if (overallLine) lines.push(overallLine)
    const skillLines = eligible.map(renderSkillSectionLine).filter(Boolean)
    if (skillLines.length === 0 && !overallLine) return ''
    lines.push(...skillLines, '</skill-awareness>')

    // Hard §7 cap: drop lowest-priority skill lines first, never exceed the budget.
    let text = lines.join('\n')
    while (text.length > CAPS.promptSectionChars && skillLines.length > 0) {
      skillLines.pop()
      text = [...lines.slice(0, 2 + (overallLine ? 1 : 0)), ...skillLines, '</skill-awareness>'].join('\n')
    }
    if (text.length > CAPS.promptSectionChars) {
      text = truncate(text, CAPS.promptSectionChars)
    }
    return text
  } catch {
    // A prompt section callback must never throw into the Harness prompt builder.
    return ''
  }
}

/**
 * Render the annotation appended to a skill tool result.
 *
 * @param {{ skillState?: object, prediction?: object|null, config?: object }} args
 * @returns {string} at most `prompt.annotationMaxChars` (default `CAPS.skillAnnotationChars`), or ''
 */
export function renderSkillAnnotation({ skillState, prediction, config } = {}) {
  try {
    if (config?.enabled === false) return ''
    const promptCfg = config?.prompt ?? {}
    if (promptCfg.annotateSkillResult === false) return ''
    const maxChars = clamp(
      asInt(promptCfg.annotationMaxChars, 200, 4000, CAPS.skillAnnotationChars),
      200,
      4000,
    )

    const applied = skillState && typeof skillState === 'object' ? skillState : null
    const judged = asInt(applied?.counts?.judged, 0, 1e9, 0)
    const metrics = applied?.metrics ?? {}
    const learned = applied?.learned ?? {}
    const lines = []

    if (judged > 0) {
      const parts = [`history: consciousness ${Math.round(finiteOr(metrics.consciousness, 0))}/100`]
      const fitAccuracy = finiteOr(metrics.fitAccuracy, 0)
      if (fitAccuracy > 0) parts.push(`fit accuracy ${asPercent(fitAccuracy)}`)
      const wasteRate = finiteOr(metrics.wasteRate, 0)
      if (wasteRate > 0) parts.push(`waste ${asPercent(wasteRate)}`)
      parts.push(`n=${judged}`)
      lines.push(parts.join(' · '))
    }

    if (prediction && typeof prediction === 'object') {
      const fit = finiteOr(prediction.fit, undefined)
      if (fit !== undefined) {
        const confidence = finiteOr(prediction.confidence, undefined)
        const confidenceText = confidence === undefined ? '' : ` (confidence ${round2(confidence)})`
        lines.push(`expected fit for this task: ${round2(clamp(fit, 0, 1))}${confidenceText}`)
      }
      const expected = bulletList(prediction.expectedUse, 3)
      if (expected) lines.push(`expected use: ${expected}`)
      const pitfalls = bulletList(prediction.likelyPitfalls, 2)
      if (pitfalls) lines.push(`likely pitfalls: ${pitfalls}`)
      const gap = sanitizeText(prediction.capabilityGap, { maxChars: 200 })
      if (gap) lines.push(`likely capability gap: ${gap}`)
      const cheaper = sanitizeText(prediction.cheaperAlternative, { maxChars: 160 })
      if (cheaper) lines.push(`cheaper alternative: ${cheaper}`)
    }

    const notFor = bulletList(learned.whenNotToUse, 2)
    if (notFor) lines.push(`not for: ${notFor}`)
    const preconditions = bulletList(learned.preconditions, 2)
    if (preconditions) lines.push(`preconditions: ${preconditions}`)

    if (lines.length === 0) return ''
    const header = ANNOTATION_HEADER
    let body = lines.map((line) => sanitizeText(line, { maxChars: 320 })).filter(Boolean)
    // Drop the least essential lines first until the whole block fits.
    let text = [header, ...body].join('\n')
    while (text.length > maxChars && body.length > 1) {
      body.pop()
      text = [header, ...body].join('\n')
    }
    if (text.length > maxChars) {
      // Keep the header meaningful even when a single line is over budget.
      text = truncate(text.replace(/\n/g, ' ').replace(/\s+/g, ' '), maxChars)
    }
    return text
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------------------------

function normalizeSkills(skills) {
  if (Array.isArray(skills)) return skills.filter((skill) => skill && typeof skill === 'object')
  if (skills && typeof skills === 'object') {
    return Object.values(skills).filter((skill) => skill && typeof skill === 'object')
  }
  return []
}

function compareUsage(a, b) {
  const loadsA = finiteOr(a?.counts?.loads, 0)
  const loadsB = finiteOr(b?.counts?.loads, 0)
  if (loadsB !== loadsA) return loadsB - loadsA
  const usedA = finiteOr(a?.lastUsedAt, 0)
  const usedB = finiteOr(b?.lastUsedAt, 0)
  if (usedB !== usedA) return usedB - usedA
  return String(a?.name ?? '').localeCompare(String(b?.name ?? ''))
}

function renderOverallLine(overall) {
  if (!overall || typeof overall !== 'object') return ''
  const consciousness = finiteOr(overall.consciousness, undefined)
  if (consciousness === undefined) return ''
  const parts = [`overall: consciousness ${Math.round(consciousness)}/100`]
  const judged = asInt(overall.judged, 0, 1e9, 0)
  if (judged > 0) parts.push(`judged ${judged}`)
  const wasteRate = finiteOr(overall.wasteRate, 0)
  if (wasteRate > 0) parts.push(`waste ${asPercent(wasteRate)}`)
  return truncate(sanitizeText(parts.join(' · '), { maxChars: PROMPT_SECTION_LINE_CHARS * 2 }), PROMPT_SECTION_LINE_CHARS)
}

function renderSkillSectionLine(skill) {
  const name = sanitizeText(skill?.name, { maxChars: 60 })
  if (!name) return ''
  const judged = asInt(skill?.counts?.judged, 0, 1e9, 0)
  const parts = [`- ${name}: consciousness ${Math.round(finiteOr(skill?.metrics?.consciousness, 0))}/100`]
  if (judged > 0) parts.push(`n=${judged}`)
  const wasteRate = finiteOr(skill?.metrics?.wasteRate, 0)
  if (wasteRate > 0) parts.push(`waste ${asPercent(wasteRate)}`)
  const notFor = firstLearned(skill?.learned?.whenNotToUse)
  if (notFor) parts.push(`not for: ${notFor}`)
  return truncate(sanitizeText(parts.join(' · '), { maxChars: PROMPT_SECTION_LINE_CHARS * 3 }), PROMPT_SECTION_LINE_CHARS)
}

function firstLearned(list) {
  if (!Array.isArray(list)) return ''
  for (const item of list) {
    const text = oneLine(sanitizeText(item, { maxChars: 120 }), 120)
    if (text) return text
  }
  return ''
}

function bulletList(value, limit) {
  if (!Array.isArray(value)) return ''
  const items = []
  for (const item of value) {
    const text = oneLine(sanitizeText(item, { maxChars: 120 }), 120)
    if (text) items.push(text)
    if (items.length >= limit) break
  }
  return items.length === 0 ? '' : items.join('; ')
}

function collectFindings(findings) {
  const lines = new Map(LEARNED_KINDS.map((kind) => [kind, []]))
  const notes = []
  const seen = new Set()

  const addLine = (kind, value) => {
    const target = normalizeLearnedKind(kind)
    if (target === null) return
    if (target === 'notes') {
      addNote(value)
      return
    }
    const source =
      value !== null && typeof value === 'object'
        ? value.text ?? value.note ?? value.rule ?? value.summary
        : value
    const text = sanitizeText(source, { maxChars: LEARNED_LINE_MAX_CHARS })
    if (text.length < 2) return
    const key = `${target}:${compareKey(text)}`
    if (seen.has(key)) return
    seen.add(key)
    lines.get(target).push({ text, key: compareKey(text) })
  }

  const addNote = (value) => {
    const raw =
      typeof value === 'string'
        ? { text: value }
        : value && typeof value === 'object'
          ? value
          : null
    if (raw === null) return
    const text = sanitizeText(raw.text ?? raw.note ?? raw.rule ?? raw.summary, {
      maxChars: LEARNED_LINE_MAX_CHARS,
    })
    if (text.length < 2) return
    const key = `notes:${compareKey(text)}`
    if (seen.has(key)) return
    seen.add(key)
    const evidence = Array.isArray(raw.evidence)
      ? raw.evidence
          .map((item) => sanitizeText(item, { maxChars: 120 }))
          .filter(Boolean)
          .slice(0, 8)
      : []
    notes.push({
      text,
      key: compareKey(text),
      confidence: clamp(raw.confidence, 0, 1, 0.6),
      evidence,
      dreamId: typeof raw.dreamId === 'string' ? raw.dreamId.slice(0, 120) : null,
      createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : undefined,
    })
  }

  if (Array.isArray(findings)) {
    for (const item of findings) {
      if (item !== null && typeof item === 'object') addLine(item.kind ?? item.type ?? 'whenNotToUse', item)
      else addLine('whenNotToUse', item)
    }
    return { lines, notes }
  }
  if (findings === null || typeof findings !== 'object') return { lines, notes }

  const rules = findings.rules ?? findings.learnedRules ?? findings.findings
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      if (rule !== null && typeof rule === 'object') {
        if (normalizeLearnedKind(rule.kind ?? rule.type) === 'notes') addNote(rule)
        else addLine(rule.kind ?? rule.type ?? 'whenNotToUse', rule.text ?? rule.rule ?? rule)
      } else {
        addLine('whenNotToUse', rule)
      }
    }
  }
  const learned = findings.learned && typeof findings.learned === 'object' ? findings.learned : findings
  for (const kind of LEARNED_KINDS) {
    const list = learned[kind]
    if (Array.isArray(list)) for (const item of list) addLine(kind, item)
  }
  const notesSource = findings.notes ?? learned.notes
  if (Array.isArray(notesSource)) for (const note of notesSource) addNote(note)
  return { lines, notes }
}

function compareKey(value) {
  return normalizeWhitespace(String(value ?? '')).toLowerCase().replace(/[.!。！]+$/, '')
}

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asPercent(rate) {
  return `${Math.round(clamp(rate, 0, 1) * 100)}%`
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function safeNow(now) {
  try {
    const value = typeof now === 'function' ? now() : now
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
  } catch {
    return Date.now()
  }
}
