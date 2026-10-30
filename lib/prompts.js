/**
 * Prompt builders, output descriptors and coercing validators for the three cheap model
 * calls (probe, judge, dream).
 *
 * Rules this module enforces before a call is made (ARCHITECTURE.md §7):
 * - every user message is assembled from already-bounded sections and then checked against
 *   the hard character caps in `constants.js`; truncation happens before the call;
 * - the system prompts carry the entire output contract, so no JSON schema text is injected
 *   twice;
 * - validators never throw: they clamp, coerce, drop unknown keys and report `issues`.
 *
 * No Harness imports and no I/O: this file is pure and unit-testable.
 */

import { CAPS, ROOT_CAUSES, VERDICTS } from './constants.js'
import { asInt, clamp, estimateTokens, normalizeWhitespace, oneLine, truncate, truncateMiddle } from './util.js'

/** Sentence appended to a judge retry when the first reply was not valid JSON. */
export const JUDGE_RETRY_REMINDER =
  'Your previous reply could not be parsed as JSON. Return ONLY one JSON object matching the schema: ' +
  'no markdown fences, no prose, no comments, no trailing commas. Keep it compact: at most 2 mismatches; ' +
  'keep every string under 160 characters; keep recommendation fields under 300 characters; omit fields you cannot support.'

/** Compact descriptor of the probe output. Hand-written for documentation and validation. */
export const PROBE_SCHEMA = freezeSchema({
  type: 'object',
  additionalProperties: false,
  required: ['fit', 'confidence', 'intent', 'expectedUse'],
  properties: {
    fit: { type: 'number', minimum: 0, maximum: 1, description: 'Probability this skill is the right choice for this task.' },
    confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Auditor certainty in this prediction.' },
    intent: { type: 'string', maxLength: 240, description: 'What the task actually needs, in one sentence.' },
    expectedUse: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 160 } },
    successSignals: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 160 } },
    likelyPitfalls: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 200 } },
    capabilityGap: { type: 'string', maxLength: 300 },
    cheaperAlternative: { type: ['string', 'null'], maxLength: 240 },
    expectedValueTokens: { type: 'integer', minimum: 0, maximum: 200000 },
  },
})

/** Compact descriptor of the judge output. */
export const JUDGE_SCHEMA = freezeSchema({
  type: 'object',
  additionalProperties: false,
  required: ['score', 'verdict'],
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100, description: 'How well the skill delivered for this task.' },
    verdict: { type: 'string', enum: VERDICTS },
    predictionAccuracy: { type: 'number', minimum: 0, maximum: 1 },
    capabilityGap: {
      type: 'object',
      properties: {
        present: { type: 'boolean' },
        claim: { type: 'string', maxLength: 300 },
        reality: { type: 'string', maxLength: 300 },
      },
    },
    mismatches: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          expected: { type: 'string', maxLength: 200 },
          observed: { type: 'string', maxLength: 200 },
          cause: { type: 'string', maxLength: 200 },
        },
      },
    },
    rootCause: { type: 'string', enum: ROOT_CAUSES },
    reusableRule: { type: 'string', maxLength: 300 },
    rework: { type: 'boolean', description: 'True only when the trace shows the work being redone after using the skill.' },
    recommendation: {
      type: 'object',
      properties: {
        descriptionEdit: { type: ['string', 'null'], maxLength: CAPS.descriptionMaxChars },
        bodyAddition: { type: ['string', 'null'], maxLength: CAPS.bodySectionMaxChars },
        selectionRule: { type: ['string', 'null'], maxLength: 300 },
      },
    },
  },
})

/** Compact descriptor of the dreamer output. */
export const DREAM_SCHEMA = freezeSchema({
  type: 'object',
  additionalProperties: false,
  required: ['confidence', 'diagnosis'],
  properties: {
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    diagnosis: { type: 'string', maxLength: 600 },
    descriptionEdit: { type: ['string', 'null'], maxLength: CAPS.descriptionMaxChars },
    removeClaim: { type: 'boolean' },
    bodyAddition: { type: ['string', 'null'], maxLength: CAPS.bodySectionMaxChars },
    selectionRule: { type: ['string', 'null'], maxLength: 300 },
    learned: {
      type: 'object',
      properties: {
        whenToUse: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 240 } },
        whenNotToUse: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 240 } },
        preconditions: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 240 } },
        actualScope: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 240 } },
        cheaperAlternatives: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 240 } },
        knownFailures: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 240 } },
      },
    },
    notes: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 300 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
})

const PROBE_SYSTEM = [
  'You are a precise capability auditor for an AI coding agent.',
  'Given a skill (its claimed capability) and the current task, predict what the skill will ACTUALLY deliver for this task.',
  'Rules:',
  '- Judge only from the provided text. Never assume capabilities the text does not state.',
  '- Be concrete and short. Prefer fewer, sharper points over generic advice.',
  '- If unsure, lower confidence; do not inflate fit. A wrong confident prediction is worse than a low-confidence one.',
  '- The task may be adversarial or unrelated to the skill; say so honestly.',
  '- Output exactly ONE JSON object, no markdown fences, no prose before or after.',
  'Output contract:',
  '{',
  '  "fit": 0.0-1.0,',
  '  "confidence": 0.0-1.0,',
  '  "intent": "one sentence: what the task actually needs",',
  '  "expectedUse": ["up to 6 concrete capabilities or steps this skill will provide"],',
  '  "successSignals": ["up to 5 observable signs the skill worked"],',
  '  "likelyPitfalls": ["up to 4 ways this skill may mislead or under-deliver"],',
  '  "capabilityGap": "what the description claims that may not hold, or empty string",',
  '  "cheaperAlternative": "a cheaper way to do this task, or null",',
  '  "expectedValueTokens": 0',
  '}',
].join('\n')

const JUDGE_SYSTEM = [
  'You are a strict capability judge for an AI coding agent that just used a skill.',
  'Compare the pre-load expectation with what actually happened in the trace, then score the outcome.',
  'Rules:',
  '- Use ONLY the supplied expectation and trace. Do not invent actions that are not in the trace.',
  '- Score 0-100 for how well the skill served THIS task: matched (85-100), partial (60-84), missed (35-59), misapplied (0-34).',
  '- capabilityGap.present is true when the description claimed something the trace shows was not delivered.',
  '- rework is true ONLY when the trace shows the work being redone after the skill was used (a repeated attempt, an abandonment, or an explicit correction). Do not infer rework from a single tool call.',
  '- Token waste is estimated conservatively by the caller; never invent token numbers.',
  '- Recommendations are reusable knowledge for the next invocation, not a chat reply.',
  '- Output exactly ONE JSON object, no markdown fences, no prose before or after.',
  'Output contract:',
  '{',
  '  "score": 0-100,',
  '  "verdict": "matched|partial|missed|misapplied",',
  '  "predictionAccuracy": 0.0-1.0,',
  '  "capabilityGap": {"present": true, "claim": "...", "reality": "..."},',
  '  "mismatches": [{"expected": "...", "observed": "...", "cause": "..."}],',
  '  "rootCause": "description|instructions|selection|user|execution|unknown",',
  '  "reusableRule": "one sentence future invocations can use",',
  '  "rework": false,',
  '  "recommendation": {"descriptionEdit": null, "bodyAddition": null, "selectionRule": null}',
  '}',
].join('\n')

const DREAM_SYSTEM = [
  'You improve an AI agent skill description and capability boundaries from observed evidence.',
  'You receive the current SKILL.md, its learned notes, and compact cases of past mispredictions.',
  'Rules:',
  '- Propose edits that make the catalog description precise about what the skill does and does NOT do.',
  '- Keep every real capability claim; never widen or silently remove scope without evidence.',
  '- The description must be one paragraph, 40-500 characters, and mention the concrete capability.',
  '- The body addition must be a short markdown section (max 2400 characters) with boundaries, preconditions and cheaper alternatives.',
  '- Only propose changes supported by the supplied cases. If evidence is thin, return low confidence and null edits.',
  '- Output exactly ONE JSON object, no markdown fences, no prose before or after.',
  'Output contract:',
  '{',
  '  "confidence": 0.0-1.0,',
  '  "diagnosis": "what the evidence shows, one short paragraph",',
  '  "descriptionEdit": "new full description string, or null",',
  '  "removeClaim": false,',
  '  "bodyAddition": "markdown section body, or null",',
  '  "selectionRule": "one sentence: when to invoke this skill (or null)",',
  '  "learned": {"whenToUse": [], "whenNotToUse": [], "preconditions": [], "actualScope": [], "cheaperAlternatives": [], "knownFailures": []},',
  '  "notes": [{"text": "short reusable note", "confidence": 0.0}]',
  '}',
].join('\n')

// ---------------------------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------------------------

function freezeSchema(schema) {
  const clone = JSON.parse(JSON.stringify(schema))
  const deepFreeze = (value) => {
    if (value !== null && typeof value === 'object') {
      for (const inner of Object.values(value)) deepFreeze(inner)
      Object.freeze(value)
    }
    return value
  }
  return deepFreeze(clone)
}

/** `truncateMiddle` keeps head+tail but adds a separator; this guarantees the hard cap. */
function truncateExact(text, maxChars) {
  const bounded = truncateMiddle(text, maxChars)
  return bounded.length > maxChars ? truncate(bounded, maxChars) : bounded
}

function safeNumber(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' || typeof value === 'boolean') return Number(value)
  return Number.NaN
}

/** Build a one-message request whose content is one text block (Harness RequestUserInput shape). */
function messagesFor(text) {
  return [{ role: 'user', content: [{ type: 'text', text }] }]
}

/** Render a built prompt as one plain text string (used by the optional subagent backend). */
export function renderRequestText(prompt) {
  const parts = []
  if (typeof prompt?.system === 'string' && prompt.system.length > 0) parts.push(prompt.system)
  for (const message of Array.isArray(prompt?.messages) ? prompt.messages : []) {
    const text = contentText(message?.content)
    if (text.length > 0) parts.push(text)
  }
  return parts.join('\n\n')
}

/** Concatenate the visible text of a ContentBlock[] / string message content. */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (typeof block === 'string') parts.push(block)
      else if (typeof block?.text === 'string' && (block.type === undefined || block.type === 'text')) parts.push(block.text)
    }
    return parts.join('\n')
  }
  if (content !== null && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

function bulletLines(label, values, maxItems, maxChars) {
  if (!Array.isArray(values)) return []
  const items = values
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .slice(0, maxItems)
    .map((value) => `- ${oneLine(value, maxChars)}`)
  if (items.length === 0) return []
  return [`${label}:`, ...items]
}

function learnedLines(state) {
  if (state === null || typeof state !== 'object') return []
  const learned = state.learned !== null && typeof state.learned === 'object' ? state.learned : state
  const lines = []
  lines.push(...bulletLines('when_to_use', learned.whenToUse, CAPS.learnedLinesPerList, 160))
  lines.push(...bulletLines('when_not_to_use', learned.whenNotToUse, CAPS.learnedLinesPerList, 160))
  lines.push(...bulletLines('preconditions', learned.preconditions, CAPS.learnedLinesPerList, 160))
  lines.push(...bulletLines('actual_scope', learned.actualScope, CAPS.learnedLinesPerList, 160))
  lines.push(...bulletLines('cheaper_alternatives', learned.cheaperAlternatives, CAPS.learnedLinesPerList, 160))
  lines.push(...bulletLines('known_failures', learned.knownFailures, CAPS.learnedLinesPerList, 160))
  const notes = Array.isArray(learned.notes) ? learned.notes : []
  const noteLines = notes
    .filter((note) => typeof note?.text === 'string')
    .slice(0, CAPS.notesPerSkill)
    .map((note) => `- ${oneLine(note.text, 160)}`)
  if (noteLines.length > 0) lines.push('notes:', ...noteLines)
  const counts = state.counts
  const metrics = state.metrics
  if (counts !== null && typeof counts === 'object') {
    const history = [
      `loads=${asInt(counts.loads, 0, 1e9, 0)}`,
      `judged=${asInt(counts.judged, 0, 1e9, 0)}`,
      `misapplied=${asInt(counts.misapplied, 0, 1e9, 0)}`,
    ]
    if (metrics !== null && typeof metrics === 'object') {
      history.push(`mean_score=${Math.round(Number(metrics.meanScore) || 0)}`)
      history.push(`consciousness=${Math.round(Number(metrics.consciousness) || 0)}`)
      history.push(`waste_rate=${Number(metrics.wasteRate) || 0}`)
    }
    lines.unshift(`history: ${history.join(' ')}`)
  }
  return lines
}

// ---------------------------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------------------------

function renderProbeUser({ skillMeta, task, learned, bodyExcerpt }) {
  const skill = skillMeta !== null && typeof skillMeta === 'object' ? skillMeta : {}
  const taskPack = task !== null && typeof task === 'object' ? task : {}
  const lines = ['<skill>', `name: ${oneLine(skill.name ?? '', 120)}`, `description: ${oneLine(skill.description ?? '', 600)}`]
  if (typeof skill.whenToUse === 'string' && skill.whenToUse.trim().length > 0) {
    lines.push(`when_to_use: ${oneLine(skill.whenToUse, 400)}`)
  }
  if (typeof skill.bodyChars === 'number' && skill.bodyChars > 0) {
    lines.push(`body_chars: ${asInt(skill.bodyChars, 0, 1e9, 0)}`)
  }
  if (bodyExcerpt.length > 0) lines.push('body_excerpt:', bodyExcerpt)
  lines.push('</skill>', '')

  lines.push('<task>', `user_goal: ${truncate(taskPack.userGoal ?? '', CAPS.taskUserGoalChars)}`)
  lines.push(...bulletLines('recent_user', taskPack.recentUser, 3, CAPS.taskMessageChars))
  if (typeof taskPack.cwd === 'string' && taskPack.cwd.length > 0) lines.push(`cwd: ${oneLine(taskPack.cwd, 240)}`)
  if (typeof taskPack.messageCount === 'number') lines.push(`session_messages: ${asInt(taskPack.messageCount, 0, 1e9, 0)}`)
  lines.push('</task>', '')

  const learnedSection = learnedLines(learned)
  if (learnedSection.length > 0) lines.push('<learned>', ...learnedSection, '</learned>', '')

  lines.push('<recent>', ...bulletLines('assistant', taskPack.recentAssistant, 3, CAPS.taskMessageChars), '</recent>')
  return lines.join('\n')
}

/**
 * Build the probe request. Bounded by `CAPS.probeInputChars` before the call.
 *
 * @param {object} input
 * @param {object} [input.skillMeta] `episode.skillMeta`; optional `content` carries the body
 * @param {object} [input.task] compact task pack (`episode.task`)
 * @param {object} [input.learned] durable skill belief (for historical notes)
 * @param {object} [input.config] normalized plugin config (reserved; caps are global)
 * @returns {{system: string, messages: Array<object>, truncated: boolean}}
 */
export function buildProbeInput({ skillMeta = {}, task = {}, learned = {}, config = {} } = {}) {
  void config
  const source = typeof skillMeta?.content === 'string' ? skillMeta.content : typeof skillMeta?.body === 'string' ? skillMeta.body : ''
  const bodyMax = CAPS.skillBodyCharsForProbe
  let bodyExcerpt = truncateExact(source, bodyMax)
  const truncated = { body: bodyExcerpt.length < source.length }
  let userText = renderProbeUser({ skillMeta, task, learned, bodyExcerpt })
  const maxUser = Math.max(600, CAPS.probeInputChars - PROBE_SYSTEM.length)
  if (userText.length > maxUser) {
    truncated.body = true
    const overflow = userText.length - maxUser
    const nextBody = Math.max(0, bodyExcerpt.length - overflow - 40)
    bodyExcerpt = nextBody > 120 ? truncate(bodyExcerpt, nextBody) : ''
    userText = renderProbeUser({ skillMeta, task, learned, bodyExcerpt })
    if (userText.length > maxUser) userText = truncate(userText, maxUser)
  }
  return { system: PROBE_SYSTEM, messages: messagesFor(userText), truncated: truncated.body }
}

// ---------------------------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------------------------

/** Compact one-line summary of an observed trace for the judge prompt. */
export function renderTraceText(trace, maxChars = CAPS.judgeInputChars) {
  const value = trace !== null && typeof trace === 'object' ? trace : {}
  const lines = []
  lines.push(`turn_end: ${oneLine(value.turnEnd ?? 'unknown', 40)}`)
  lines.push(`observed_ms: ${asInt(value.observedMs, 0, 1e9, 0)}`)
  lines.push(`skill_reloaded: ${value.skillReLoaded === true}`)
  lines.push(`final_answer_chars: ${asInt(value.finalAnswerChars, 0, 1e9, 0)}`)
  const call = value.call
  if (call !== null && typeof call === 'object') {
    lines.push(`call: is_error=${call.isError} duration_ms=${asInt(call.durationMs, 0, 1e9, 0)} content_chars=${asInt(call.contentChars, 0, 1e9, 0)}`)
  }
  lines.push(...bulletLines('assistant_texts', value.assistantTexts, CAPS.traceAssistantItems, CAPS.traceAssistantChars))
  lines.push(...bulletLines('user_messages', value.userMessages, CAPS.traceUserItems, CAPS.taskMessageChars))
  const tools = Array.isArray(value.toolSequence) ? value.toolSequence.slice(0, CAPS.traceToolItems) : []
  if (tools.length > 0) {
    lines.push('tool_sequence:')
    for (const item of tools) {
      const name = typeof item?.name === 'string' ? item.name : 'tool'
      const ok = item?.ok === true ? 'ok' : item?.ok === false ? 'error' : 'unknown'
      const brief = typeof item?.brief === 'string' ? oneLine(item.brief, 120) : ''
      lines.push(`- ${name} ${ok}${brief ? `: ${brief}` : ''}`)
    }
  }
  return truncateExact(lines.join('\n'), Math.max(200, asInt(maxChars, 200, 60000, CAPS.judgeInputChars)))
}

function renderObserved(episode, traceText) {
  const trace = episode?.trace !== null && typeof episode.trace === 'object' ? episode.trace : {}
  const call = episode?.call
  const lines = ['<observed>', traceText]
  if (call !== null && typeof call === 'object') {
    lines.push(
      `load_call: is_error=${call.isError} duration_ms=${asInt(call.durationMs, 0, 1e9, 0)} content_chars=${asInt(call.contentChars, 0, 1e9, 0)}`,
    )
  }
  lines.push('</observed>')
  return lines.join('\n')
}

/**
 * Build the judge request. Bounded by `CAPS.judgeInputChars`; the trace is truncated to the
 * configured `observe.maxTraceChars` first and further shrunk when the whole prompt overflows.
 *
 * @param {object} input
 * @param {object} input.episode judged episode (prediction/trace/skillMeta/call)
 * @param {string} [input.traceText] pre-rendered trace; recomputed from `episode.trace` when absent
 * @param {object} [input.config] normalized plugin config
 * @returns {{system: string, messages: Array<object>, truncated: boolean}}
 */
export function buildJudgeInput({ episode = {}, traceText = '', config = {} } = {}) {
  const maxTraceChars = asInt(config?.observe?.maxTraceChars, 1000, 60000, CAPS.judgeInputChars)
  let trace = typeof traceText === 'string' && traceText.length > 0 ? traceText : renderTraceText(episode.trace, maxTraceChars)
  trace = truncateExact(trace, maxTraceChars)
  const prediction = episode?.prediction !== null && episode?.prediction !== undefined
    ? truncate(JSON.stringify(compactPrediction(episode.prediction)), 1400)
    : 'none (probe disabled, skipped or failed)'
  const skillMeta = episode?.skillMeta !== null && typeof episode.skillMeta === 'object' ? episode.skillMeta : {}
  const compose = (traceValue) => {
    const lines = [
      '<skill>',
      `name: ${oneLine(skillMeta.name ?? episode?.skill ?? '', 120)}`,
      `claimed_description: ${oneLine(skillMeta.description ?? '', 600)}`,
      ...(typeof skillMeta.whenToUse === 'string' && skillMeta.whenToUse.trim().length > 0
        ? [`claimed_when_to_use: ${oneLine(skillMeta.whenToUse, 400)}`]
        : []),
      `body_chars: ${asInt(skillMeta.bodyChars, 0, 1e9, 0)}`,
      '</skill>',
      '',
      '<prediction>',
      prediction,
      '</prediction>',
      '',
      renderObserved(episode, traceValue),
      '',
      '<instruction>',
      'Score the delivery for this task, compare expectation with the trace, and give reusable findings.',
      'If the prediction is absent, judge the observed delivery only and set predictionAccuracy to 0.5.',
      '</instruction>',
    ]
    return lines.join('\n')
  }
  let userText = compose(trace)
  const maxUser = Math.max(600, CAPS.judgeInputChars - JUDGE_SYSTEM.length)
  let truncated = trace.length < (typeof traceText === 'string' ? traceText.length : 0)
  if (userText.length > maxUser) {
    truncated = true
    const overflow = userText.length - maxUser
    const nextTraceChars = Math.max(200, trace.length - overflow - 40)
    trace = truncateExact(trace, nextTraceChars)
    userText = compose(trace)
    if (userText.length > maxUser) userText = truncate(userText, maxUser)
  }
  return { system: JUDGE_SYSTEM, messages: messagesFor(userText), truncated }
}

/** Compact prediction projection used in judge/dream prompts. */
function compactPrediction(prediction) {
  if (prediction === null || typeof prediction !== 'object') return null
  return {
    fit: prediction.fit,
    confidence: prediction.confidence,
    intent: truncate(prediction.intent ?? '', 240),
    expectedUse: Array.isArray(prediction.expectedUse) ? prediction.expectedUse.slice(0, 4).map((item) => oneLine(item, 120)) : [],
    likelyPitfalls: Array.isArray(prediction.likelyPitfalls) ? prediction.likelyPitfalls.slice(0, 3).map((item) => oneLine(item, 120)) : [],
    capabilityGap: truncate(prediction.capabilityGap ?? '', 240),
    cheaperAlternative: prediction.cheaperAlternative == null ? null : truncate(prediction.cheaperAlternative, 160),
    expectedValueTokens: prediction.expectedValueTokens,
  }
}

/** Compact episode projection used in dream prompts. */
export function compactCase(episode) {
  const value = episode !== null && typeof episode === 'object' ? episode : {}
  const trace = value.trace !== null && typeof value.trace === 'object' ? value.trace : null
  const judge = value.judge !== null && typeof value.judge === 'object' ? value.judge : null
  return {
    skill: typeof value.skill === 'string' ? value.skill : undefined,
    prediction: value.prediction ? compactPrediction(value.prediction) : null,
    call: value.call ? { isError: value.call.isError, contentChars: value.call.contentChars } : null,
    trace: trace
      ? {
          turnEnd: trace.turnEnd,
          observedMs: trace.observedMs,
          assistantTexts: (trace.assistantTexts ?? []).slice(0, 2).map((text) => truncate(text, 300)),
          userMessages: (trace.userMessages ?? []).slice(0, 2).map((text) => truncate(text, 240)),
          toolSequence: (trace.toolSequence ?? []).slice(0, 10).map((item) => ({ name: item?.name, ok: item?.ok, brief: truncate(item?.brief ?? '', 100) })),
          skillReLoaded: trace.skillReLoaded === true,
        }
      : null,
    judge: judge
      ? {
          score: judge.score,
          verdict: judge.verdict,
          capabilityGap: judge.capabilityGap,
          rootCause: judge.rootCause,
          reusableRule: truncate(judge.reusableRule ?? '', 300),
          rework: judge.rework === true,
        }
      : null,
  }
}

// ---------------------------------------------------------------------------------------------
// dream
// ---------------------------------------------------------------------------------------------

/**
 * Build the dreamer request for one skill. Bounded by `CAPS.dreamInputChars`.
 *
 * @param {object} input
 * @param {object} input.skillState durable belief for the skill
 * @param {Array<object>} input.cases compact episodes (judge/mismatch cases)
 * @param {string|{text?: string, content?: string, path?: string}} [input.skillFile] current SKILL.md
 * @returns {{system: string, messages: Array<object>, truncated: boolean}}
 */
export function buildDreamInput({ skillState = {}, cases = [], skillFile = '' } = {}) {
  const fileText = typeof skillFile === 'string' ? skillFile : typeof skillFile?.text === 'string' ? skillFile.text : typeof skillFile?.content === 'string' ? skillFile.content : ''
  const bodyExcerpt = truncateExact(fileText, CAPS.bodyExcerptChars)
  let truncated = bodyExcerpt.length < fileText.length
  const caseLines = []
  const caseBudget = Math.min(CAPS.dreamInputChars - DREAM_SYSTEM.length - 2000, 9000)
  let used = 0
  for (const episode of Array.isArray(cases) ? cases.slice(0, 8) : []) {
    const line = JSON.stringify(compactCase(episode))
    if (used + line.length > caseBudget) {
      truncated = true
      break
    }
    used += line.length
    caseLines.push(`<case>\n${line}\n</case>`)
  }
  const learned = learnedLines(skillState)
  const compose = () => {
    const lines = ['<skill>', `name: ${oneLine(skillState?.name ?? '', 120)}`, `description: ${oneLine(skillState?.description ?? '', 600)}`]
    if (typeof skillState?.whenToUse === 'string' && skillState.whenToUse.trim().length > 0) {
      lines.push(`when_to_use: ${oneLine(skillState.whenToUse, 400)}`)
    }
    if (typeof skillState?.source === 'string') lines.push(`source: ${oneLine(skillState.source, 80)}`)
    lines.push('</skill>', '')
    if (learned.length > 0) lines.push('<learned>', ...learned, '</learned>', '')
    lines.push('<current_skill_md>', bodyExcerpt, '</current_skill_md>', '')
    lines.push('<cases>', ...caseLines, '</cases>', '')
    lines.push('<instruction>',
      'Propose only evidence-backed improvements to the description, capability boundaries and selection rule.',
      'If the cases do not support a change, return null edits with low confidence.',
      '</instruction>')
    return lines.join('\n')
  }
  let userText = compose()
  const maxUser = Math.max(800, CAPS.dreamInputChars - DREAM_SYSTEM.length)
  if (userText.length > maxUser) {
    truncated = true
    userText = truncate(userText, maxUser)
  }
  return { system: DREAM_SYSTEM, messages: messagesFor(userText), truncated }
}

// ---------------------------------------------------------------------------------------------
// validators
// ---------------------------------------------------------------------------------------------

function makeIssues(limit = 24) {
  const issues = []
  const note = (field, message) => {
    if (issues.length < limit) issues.push(`${field}: ${message}`)
  }
  return { issues, note }
}

function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function textOf(value, maxChars, fallback = '') {
  const raw = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
  return truncate(normalizeWhitespace(raw), maxChars) || fallback
}

function nullableTextOf(value, maxChars) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = truncate(normalizeWhitespace(String(value)), maxChars)
  return text.length > 0 ? text : null
}

function numberIn(value, min, max, fallback) {
  const num = safeNumber(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function intIn(value, min, max, fallback) {
  const num = safeNumber(value)
  if (!Number.isFinite(num)) return fallback
  return Math.round(Math.min(max, Math.max(min, num)))
}

function boolOf(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function textList(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => oneLine(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems)
}

/** Score -> verdict fallback used only when the model omits/invalidates `verdict`. */
export function verdictFromScore(score) {
  const value = clamp(score, 0, 100, 50)
  if (value >= 85) return 'matched'
  if (value >= 60) return 'partial'
  if (value >= 35) return 'missed'
  return 'misapplied'
}

/**
 * Coerce a raw probe reply into the durable prediction shape. Never throws.
 * @returns {{value: object, issues: string[]}}
 */
export function validateProbe(raw) {
  const { issues, note } = makeIssues()
  const root = objectOf(raw)
  const value = {
    fit: 0.5,
    confidence: 0.1,
    intent: '',
    expectedUse: [],
    successSignals: [],
    likelyPitfalls: [],
    capabilityGap: '',
    cheaperAlternative: null,
    expectedValueTokens: 0,
  }
  if (root === null) {
    note('root', 'expected a JSON object; using conservative defaults')
    return { value, issues }
  }
  const fit = numberIn(root.fit, 0, 1, 0.5)
  if (fit !== root.fit) note('fit', `coerced ${JSON.stringify(root.fit)} to ${fit}`)
  value.fit = fit
  const confidence = numberIn(root.confidence, 0, 1, 0.1)
  if (confidence !== root.confidence) note('confidence', `coerced ${JSON.stringify(root.confidence)} to ${confidence}`)
  value.confidence = confidence
  value.intent = textOf(root.intent, 240)
  value.expectedUse = textList(root.expectedUse, 6, 160)
  value.successSignals = textList(root.successSignals, 5, 160)
  value.likelyPitfalls = textList(root.likelyPitfalls, 4, 200)
  value.capabilityGap = textOf(root.capabilityGap, 300)
  value.cheaperAlternative = nullableTextOf(root.cheaperAlternative, 240)
  value.expectedValueTokens = Math.max(0, intIn(root.expectedValueTokens, 0, 200000, 0))
  if (!Array.isArray(root.expectedUse)) note('expectedUse', 'expected an array; using []')
  const known = new Set(['fit', 'confidence', 'intent', 'expectedUse', 'successSignals', 'likelyPitfalls', 'capabilityGap', 'cheaperAlternative', 'expectedValueTokens'])
  const unknown = Object.keys(root).filter((key) => !known.has(key))
  if (unknown.length > 0) note('root', `dropped unknown keys: ${unknown.slice(0, 8).join(', ')}`)
  if (value.fit >= 0.9 && value.confidence >= 0.9 && value.expectedUse.length === 0) {
    note('confidence', 'high confidence with no expected use is suspicious; consider lowering it')
  }
  return { value, issues }
}

/**
 * Coerce a raw judge reply into the durable judge shape. Never throws.
 * @returns {{value: object, issues: string[]}}
 */
export function validateJudge(raw) {
  const { issues, note } = makeIssues()
  const root = objectOf(raw)
  if (root === null) {
    note('root', 'expected a JSON object; using conservative defaults')
    return { value: defaultJudgeValue(), issues }
  }
  const score = Math.round(numberIn(root.score, 0, 100, 50))
  if (score !== root.score) note('score', `coerced ${JSON.stringify(root.score)} to ${score}`)
  let verdict = typeof root.verdict === 'string' && VERDICTS.includes(root.verdict) ? root.verdict : null
  if (verdict === null) {
    verdict = verdictFromScore(score)
    note('verdict', `missing/invalid; derived "${verdict}" from score ${score}`)
  }
  const gapRoot = objectOf(root.capabilityGap)
  const capabilityGap = gapRoot === null
    ? { present: false, claim: '', reality: '' }
    : {
        present: boolOf(gapRoot.present, false),
        claim: textOf(gapRoot.claim, 300),
        reality: textOf(gapRoot.reality, 300),
      }
  if (gapRoot !== null && gapRoot.present === undefined) note('capabilityGap.present', 'missing; defaulted to false')
  const mismatchRoot = Array.isArray(root.mismatches) ? root.mismatches : []
  const mismatches = mismatchRoot
    .map((item) => objectOf(item))
    .filter(Boolean)
    .slice(0, 5)
    .map((item) => ({ expected: textOf(item.expected, 200), observed: textOf(item.observed, 200), cause: textOf(item.cause, 200) }))
  if (mismatchRoot.length > 5) note('mismatches', `capped ${mismatchRoot.length} to 5`)
  const recommendationRoot = objectOf(root.recommendation) ?? {}
  const recommendation = {
    descriptionEdit: nullableTextOf(recommendationRoot.descriptionEdit ?? root.descriptionEdit, CAPS.descriptionMaxChars),
    bodyAddition: nullableTextOf(recommendationRoot.bodyAddition ?? root.bodyAddition, CAPS.bodySectionMaxChars),
    selectionRule: nullableTextOf(recommendationRoot.selectionRule ?? root.selectionRule, 300),
  }
  const value = {
    score,
    verdict,
    predictionAccuracy: numberIn(root.predictionAccuracy, 0, 1, 0.5),
    capabilityGap,
    mismatches,
    rootCause: typeof root.rootCause === 'string' && ROOT_CAUSES.includes(root.rootCause) ? root.rootCause : 'unknown',
    reusableRule: textOf(root.reusableRule, 300),
    rework: boolOf(root.rework ?? root.reworkHappened, false),
    recommendation,
  }
  if (typeof root.rootCause === 'string' && !ROOT_CAUSES.includes(root.rootCause)) note('rootCause', 'invalid; using unknown')
  return { value, issues }
}

function defaultJudgeValue() {
  return {
    score: 50,
    verdict: 'partial',
    predictionAccuracy: 0.5,
    capabilityGap: { present: false, claim: '', reality: '' },
    mismatches: [],
    rootCause: 'unknown',
    reusableRule: '',
    rework: false,
    recommendation: { descriptionEdit: null, bodyAddition: null, selectionRule: null },
  }
}

/**
 * Coerce a raw dream reply into the durable proposal shape. Never throws.
 * @returns {{value: object, issues: string[]}}
 */
export function validateDream(raw) {
  const { issues, note } = makeIssues()
  const root = objectOf(raw)
  if (root === null) {
    note('root', 'expected a JSON object; using conservative defaults')
    return { value: defaultDreamValue(), issues }
  }
  const learnedRoot = objectOf(root.learned) ?? objectOf(root.rules) ?? {}
  const learned = {
    whenToUse: textList(learnedRoot.whenToUse, CAPS.learnedLinesPerList, 240),
    whenNotToUse: textList(learnedRoot.whenNotToUse, CAPS.learnedLinesPerList, 240),
    preconditions: textList(learnedRoot.preconditions, CAPS.learnedLinesPerList, 240),
    actualScope: textList(learnedRoot.actualScope, CAPS.learnedLinesPerList, 240),
    cheaperAlternatives: textList(learnedRoot.cheaperAlternatives, CAPS.learnedLinesPerList, 240),
    knownFailures: textList(learnedRoot.knownFailures, CAPS.learnedLinesPerList, 240),
  }
  const descriptionEdit = nullableTextOf(
    objectOf(root.descriptionEdit)?.description ?? objectOf(root.descriptionEdit)?.text ?? root.descriptionEdit,
    CAPS.descriptionMaxChars,
  )
  if (descriptionEdit !== null && descriptionEdit.length < CAPS.descriptionMinChars) {
    note('descriptionEdit', `shorter than ${CAPS.descriptionMinChars} chars; dropped`)
  }
  const bodyAddition = nullableTextOf(
    objectOf(root.bodyAddition)?.section ?? objectOf(root.bodyAddition)?.markdown ?? root.bodyAddition,
    CAPS.bodySectionMaxChars,
  )
  const noteRoot = Array.isArray(root.notes) ? root.notes : []
  const notes = noteRoot
    .map((item) => objectOf(item))
    .filter(Boolean)
    .slice(0, CAPS.notesPerSkill)
    .map((item) => ({ text: textOf(item.text, 300), confidence: numberIn(item.confidence, 0, 1, 0.5) }))
    .filter((item) => item.text.length > 0)
  const value = {
    confidence: numberIn(root.confidence, 0, 1, 0),
    diagnosis: textOf(root.diagnosis, 600),
    descriptionEdit: descriptionEdit !== null && descriptionEdit.length >= CAPS.descriptionMinChars ? descriptionEdit : null,
    removeClaim: boolOf(root.removeClaim, false),
    bodyAddition,
    selectionRule: nullableTextOf(root.selectionRule, 300),
    learned,
    notes,
  }
  if (value.confidence === 0) note('confidence', 'missing/invalid; using 0')
  if (noteRoot.length > CAPS.notesPerSkill) note('notes', `capped ${noteRoot.length} to ${CAPS.notesPerSkill}`)
  return { value, issues }
}

function defaultDreamValue() {
  return {
    confidence: 0,
    diagnosis: '',
    descriptionEdit: null,
    removeClaim: false,
    bodyAddition: null,
    selectionRule: null,
    learned: {
      whenToUse: [],
      whenNotToUse: [],
      preconditions: [],
      actualScope: [],
      cheaperAlternatives: [],
      knownFailures: [],
    },
    notes: [],
  }
}

/** Rough token estimate for a built prompt (debug/accounting only). */
export function promptTokenEstimate(prompt) {
  const system = typeof prompt?.system === 'string' ? prompt.system : ''
  let chars = system.length
  for (const message of Array.isArray(prompt?.messages) ? prompt.messages : []) {
    if (typeof message?.content === 'string') {
      chars += message.content.length
      continue
    }
    if (Array.isArray(message?.content)) {
      for (const block of message.content) chars += typeof block?.text === 'string' ? block.text.length : 0
    }
  }
  return estimateTokens(chars)
}
