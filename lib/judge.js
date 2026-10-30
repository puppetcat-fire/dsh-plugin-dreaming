/**
 * The judge: one cheap inline model call that compares the probe's expectation with the
 * observed trace, scores the delivery, and extracts reusable findings.
 *
 * It owns the durable `episode.judge` / `episode.cost` fields and the skill-belief update:
 * - costs are computed only from measured data (skill body size, trace text, token usage);
 *   nothing is invented when the measurement is missing;
 * - `wastedEstimate` follows ARCHITECTURE.md §5.1 exactly: the skill-load cost when the
 *   verdict is `misapplied`, plus measured rework when the trace shows the work redone;
 * - invalid JSON gets one deterministic repair attempt (for replies cut off by the output
 *   cap), then at most one reminder retry, then is recorded as `invalid`;
 *
 * `judgeEpisode` never rejects into the Harness event loop.
 */

import { CAPS } from './constants.js'
import { clamp, estimateTokens, oneLine, parseJsonLoose, repairJsonLoose, safeError } from './util.js'
import { resolveRoute, streamText } from './llm.js'
import { buildJudgeInput, JUDGE_RETRY_REMINDER, renderRequestText, renderTraceText, validateJudge } from './prompts.js'
import { applyEpisodeToSkill } from './stats.js'
import { runSubagentText } from './subagent.js'

/** Local fallbacks only; normalized config is authoritative. */
const DEFAULT_TIMEOUT_MS = 40_000
const DEFAULT_MAX_TRACE_CHARS = 12_000

/** A fresh durable judge record (ARCHITECTURE.md §5.1). */
export function emptyJudgeRecord() {
  return {
    status: 'pending',
    model: null,
    tokensIn: 0,
    tokensOut: 0,
    error: null,
  }
}

/** A fresh cost record (ARCHITECTURE.md §5.1). */
export function emptyCost() {
  return { probe: 0, judge: 0, skillLoad: 0, reworkEstimate: 0, wastedEstimate: 0 }
}

function finite(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Tokens attributable to the visible trace: a conservative lower bound for rework. */
export function estimateTraceTokens(trace) {
  if (trace === null || typeof trace !== 'object') return 0
  let chars = 0
  for (const text of Array.isArray(trace.assistantTexts) ? trace.assistantTexts : []) {
    if (typeof text === 'string') chars += text.length
  }
  for (const text of Array.isArray(trace.userMessages) ? trace.userMessages : []) {
    if (typeof text === 'string') chars += text.length
  }
  for (const item of Array.isArray(trace.toolSequence) ? trace.toolSequence : []) {
    if (typeof item?.name === 'string') chars += item.name.length
    if (typeof item?.brief === 'string') chars += item.brief.length
  }
  return chars > 0 ? estimateTokens(chars) : 0
}

/**
 * Cost semantics from ARCHITECTURE.md §5.1.
 *
 * `wastedEstimate` = skill-load tokens when the judge says `misapplied` or `missed`, plus rework
 * tokens when the trace shows the work redone. Both parts are measured/estimated from data we have;
 * if the skill body size was unavailable, the load part is 0 rather than a guess. `partial` keeps its
 * load cost unless rework was actually observed.
 *
 * @param {object} episode
 * @returns {{probe: number, judge: number, skillLoad: number, reworkEstimate: number, wastedEstimate: number}}
 */
export function computeEpisodeCost(episode) {
  const probe = episode?.probe ?? {}
  const judge = episode?.judge ?? {}
  const skillMeta = episode?.skillMeta ?? {}
  const probeSpend = Math.max(0, finite(probe.tokensIn) + finite(probe.tokensOut))
  const judgeSpend = Math.max(0, finite(judge.tokensIn) + finite(judge.tokensOut))
  const bodyChars = Math.max(0, finite(skillMeta.bodyChars))
  const bodyTokens = Math.max(0, finite(skillMeta.bodyTokens))
  const skillLoad = bodyTokens > 0 ? Math.round(bodyTokens) : bodyChars > 0 ? estimateTokens(bodyChars) : 0
  const reworkEstimate = judge.rework === true ? estimateTraceTokens(episode?.trace) : 0
  const loadWasted = judge.status === 'ok' && (judge.verdict === 'misapplied' || judge.verdict === 'missed')
  const wastedEstimate = (loadWasted ? skillLoad : 0) + reworkEstimate
  return { probe: probeSpend, judge: judgeSpend, skillLoad, reworkEstimate, wastedEstimate }
}

/** Structurally bound the trace before it is persisted or rendered. */
function boundTrace(trace, config) {
  if (trace === null || trace === undefined || typeof trace !== 'object') {
    return { value: { observedMs: 0, turnEnd: 'unknown', assistantTexts: [], toolSequence: [], userMessages: [], skillReLoaded: false, finalAnswerChars: 0 }, trimmed: false }
  }
  const assistantTexts = (Array.isArray(trace.assistantTexts) ? trace.assistantTexts : [])
    .filter((text) => typeof text === 'string')
    .slice(-CAPS.traceAssistantItems)
    .map((text) => text.slice(0, CAPS.traceAssistantChars))
  const toolSequence = (Array.isArray(trace.toolSequence) ? trace.toolSequence : [])
    .slice(0, CAPS.traceToolItems)
    .map((item) => ({
      name: typeof item?.name === 'string' ? item.name.slice(0, 80) : 'tool',
      ok: item?.ok === true ? true : item?.ok === false ? false : null,
      brief: typeof item?.brief === 'string' ? item.brief.slice(0, 160) : '',
    }))
  const userMessages = (Array.isArray(trace.userMessages) ? trace.userMessages : [])
    .filter((text) => typeof text === 'string')
    .slice(-CAPS.traceUserItems)
    .map((text) => text.slice(0, CAPS.taskMessageChars))
  const value = {
    observedMs: Math.max(0, finite(trace.observedMs)),
    turnEnd: typeof trace.turnEnd === 'string' ? trace.turnEnd.slice(0, 40) : 'unknown',
    assistantTexts,
    toolSequence,
    userMessages,
    skillReLoaded: trace.skillReLoaded === true,
    finalAnswerChars: Math.max(0, finite(trace.finalAnswerChars)),
  }
  const sourceCounts =
    (Array.isArray(trace.assistantTexts) ? trace.assistantTexts.length : 0) +
    (Array.isArray(trace.toolSequence) ? trace.toolSequence.length : 0) +
    (Array.isArray(trace.userMessages) ? trace.userMessages.length : 0)
  const keptCounts = assistantTexts.length + toolSequence.length + userMessages.length
  void config
  return { value, trimmed: keptCounts < sourceCounts }
}

/** Findings projected for the guidance overlay (dream-engine owns the merge). */
export function buildGuidanceFindings(episode) {
  const judge = episode?.judge ?? {}
  const prediction = episode?.prediction ?? {}
  const findings = {
    whenToUse: [],
    whenNotToUse: [],
    preconditions: [],
    actualScope: [],
    cheaperAlternatives: [],
    knownFailures: [],
    notes: [],
  }
  const gap = judge.capabilityGap
  if (gap !== null && typeof gap === 'object') {
    if (gap.present && typeof gap.claim === 'string' && gap.claim.length > 0) {
      // The claim is what the DESCRIPTION promises, so the reusable boundary is the
      // negation of that promise — not the claim text itself.
      findings.whenNotToUse.push(oneLine(`Do not rely on this skill for: ${gap.claim}`, 200))
    }
    if (typeof gap.reality === 'string' && gap.reality.length > 0) findings.actualScope.push(oneLine(gap.reality, 200))
  }
  for (const mismatch of Array.isArray(judge.mismatches) ? judge.mismatches : []) {
    if (typeof mismatch?.cause === 'string' && mismatch.cause.length > 0) findings.knownFailures.push(oneLine(mismatch.cause, 200))
  }
  if (typeof prediction.cheaperAlternative === 'string' && prediction.cheaperAlternative.length > 0) {
    findings.cheaperAlternatives.push(oneLine(prediction.cheaperAlternative, 200))
  }
  const recommendation = judge.recommendation
  if (recommendation !== null && typeof recommendation === 'object') {
    if (typeof recommendation.selectionRule === 'string' && recommendation.selectionRule.length > 0) {
      const rule = oneLine(recommendation.selectionRule, 200)
      // Selection rules are usually phrased as exclusions ("do not select …"); route them to
      // the list that the awareness prompt renders as a boundary instead of a use case.
      if (/^(do not|don't|never|avoid|not for)\b/i.test(rule)) findings.whenNotToUse.push(rule)
      else findings.whenToUse.push(rule)
    }
    if (typeof recommendation.bodyAddition === 'string' && recommendation.bodyAddition.length > 0) {
      findings.notes.push({
        text: oneLine(recommendation.bodyAddition, 300),
        confidence: 0.65,
        evidence: [episode?.id].filter(Boolean),
      })
    }
  }
  if (typeof judge.reusableRule === 'string' && judge.reusableRule.length > 0) {
    findings.notes.push({ text: oneLine(judge.reusableRule, 300), confidence: 0.6, evidence: [episode?.id].filter(Boolean) })
  }
  for (const key of ['whenToUse', 'whenNotToUse', 'preconditions', 'actualScope', 'cheaperAlternatives', 'knownFailures']) {
    findings[key] = findings[key].filter(Boolean).slice(-CAPS.learnedLinesPerList)
  }
  findings.notes = findings.notes.slice(-CAPS.notesPerSkill)
  return findings
}

/** Resolve the guidance overlay: injected first, then the optional sibling module. */
async function resolveGuidance(injected) {
  if (injected !== null && injected !== undefined && typeof injected.mergeLearnings === 'function') return injected
  try {
    const module = await import('./guidance.js')
    if (module !== null && typeof module.mergeLearnings === 'function') return module
  } catch {
    // guidance.js is optional at unit-test time; its absence is not an error.
  }
  return null
}

async function persistSkippedOrInvalid({ store, episode, log }) {
  if (store === null || store === undefined) return
  try {
    store.updateEpisode(episode.id, {
      state: episode.state,
      judge: episode.judge,
      cost: episode.cost,
      trace: episode.trace,
      prediction: episode.prediction,
      probe: episode.probe,
      call: episode.call,
      flags: episode.flags,
      endedAt: episode.endedAt,
    })
  } catch (error) {
    log?.warn?.(`dreaming: failed to persist judge status for ${episode?.id}: ${safeError(error).message}`)
  }
  try {
    store.bumpTotals({
      probeTokens: Math.max(0, finite(episode?.cost?.probe)),
      judgeTokens: Math.max(0, finite(episode?.cost?.judge)),
    })
    if (typeof store.saveState === 'function') store.saveState()
    episode._totalsBumped = true
  } catch (error) {
    log?.warn?.(`dreaming: failed to persist judge totals for ${episode?.id}: ${safeError(error).message}`)
  }
}

async function persistJudged({ store, episode, guidance, log }) {
  if (store === null || store === undefined) return
  try {
    store.updateEpisode(episode.id, {
      state: 'judged',
      judge: episode.judge,
      cost: episode.cost,
      trace: episode.trace,
      prediction: episode.prediction,
      probe: episode.probe,
      call: episode.call,
      flags: episode.flags,
      endedAt: episode.endedAt,
    })
  } catch (error) {
    log?.warn?.(`dreaming: failed to persist judged episode ${episode?.id}: ${safeError(error).message}`)
  }
  try {
    // bumpTotals does not persist by itself; updateSkill/saveState below commits the state file.
    store.bumpTotals({
      judged: 1,
      probeTokens: Math.max(0, finite(episode?.cost?.probe)),
      judgeTokens: Math.max(0, finite(episode?.cost?.judge)),
      skillLoadTokens: Math.max(0, finite(episode?.cost?.skillLoad)),
      wastedTokens: Math.max(0, finite(episode?.cost?.wastedEstimate)),
    })
    episode._totalsBumped = true
  } catch (error) {
    log?.warn?.(`dreaming: failed to bump totals for ${episode?.id}: ${safeError(error).message}`)
  }
  const findings = buildGuidanceFindings(episode)
  const overlay = await resolveGuidance(guidance)
  try {
    const updated = store.updateSkill(episode.skill, (skill) => {
      applyEpisodeToSkill(skill, episode)
      if (overlay !== null) {
        try {
          overlay.mergeLearnings(skill, findings, {
            maxNotes: CAPS.notesPerSkill,
            maxLines: CAPS.learnedLinesPerList,
          })
        } catch (error) {
          log?.warn?.(`dreaming: guidance merge failed for ${episode.skill}: ${safeError(error).message}`)
        }
      }
      return skill
    })
    if (updated === undefined && typeof store.saveState === 'function') store.saveState()
  } catch (error) {
    log?.warn?.(`dreaming: failed to update skill belief for ${episode.skill}: ${safeError(error).message}`)
  }
}

/** Resolve a judge route with the output cap clamped to the hard judge budget. */
async function resolveJudgeRoute(ctx, session, cfg) {
  const route = await resolveRoute(ctx, session, cfg?.model)
  const configured = Number(route.maxTokens)
  const maxTokens = Number.isFinite(configured) && configured > 0 ? Math.min(configured, CAPS.judgeMaxTokens) : CAPS.judgeMaxTokens
  return { ...route, maxTokens }
}

function reminderMessage() {
  return { role: 'user', content: [{ type: 'text', text: JUDGE_RETRY_REMINDER }] }
}

/** Parse a judge reply, repairing a reply truncated by the output cap before giving up. */
function parseJudgeReply(text) {
  const parsed = parseJsonLoose(text)
  if (parsed !== undefined) return { parsed, repaired: false }
  const repaired = repairJsonLoose(text)
  if (repaired === undefined) return { parsed: undefined, repaired: false }
  return { parsed: repaired, repaired: true }
}

/**
 * Judge one observed episode.
 *
 * No-op (`judge.status = 'skipped'`) when judging is disabled or there is no prediction and
 * `judgeWithoutProbe` is false. On success: fills `episode.judge`, `episode.cost`, sets
 * `episode.state = 'judged'`, appends the update through the store and folds the episode into
 * the skill belief (plus the optional guidance overlay).
 *
 * @param {object} options
 * @param {object} options.ctx Harness context (fake-friendly)
 * @param {object} options.config normalized config
 * @param {object} [options.store] durable store
 * @param {object} options.episode episode with a frozen `trace`
 * @param {object} [options.session] session used for route resolution only
 * @param {AbortSignal} [options.signal] cancellation (disposal)
 * @param {object} [options.logger] logger override
 * @param {object} [options.guidance] optional guidance module with `mergeLearnings`
 * @returns {Promise<object>} the episode (never rejects)
 */
export async function judgeEpisode({ ctx, config, store, episode, session, signal, logger, guidance } = {}) {
  if (episode === null || episode === undefined || typeof episode !== 'object') return episode
  const cfg = config?.judge ?? {}
  const log = logger ?? ctx?.logger
  if (episode.flags === null || episode.flags === undefined) episode.flags = { sampled: false, truncated: false, dreamIds: [] }
  try {
    if (episode.judge === null || episode.judge === undefined) episode.judge = emptyJudgeRecord()
    if (episode.cost === null || episode.cost === undefined) episode.cost = emptyCost()
    episode.cost = { ...emptyCost(), ...episode.cost }

    if (cfg.enabled === false) {
      episode.judge = { ...episode.judge, status: 'skipped', error: null }
      log?.debug?.(`dreaming: judge disabled; keeping episode ${episode.id ?? '(unknown)'} observed`)
      return episode
    }
    if (!episode.prediction && cfg.judgeWithoutProbe !== true) {
      episode.judge = { ...episode.judge, status: 'skipped', error: null }
      log?.debug?.(`dreaming: judge skipped (no prediction and judgeWithoutProbe=false) id=${episode.id ?? '(unknown)'}`)
      return episode
    }

    const bounded = boundTrace(episode.trace, config)
    episode.trace = bounded.value
    if (bounded.trimmed) episode.flags.truncated = true
    const maxTraceChars = Number.isFinite(config?.observe?.maxTraceChars)
      ? config.observe.maxTraceChars
      : DEFAULT_MAX_TRACE_CHARS
    const traceText = renderTraceText(episode.trace, maxTraceChars)
    try {
      const serialized = JSON.stringify(episode.trace)
      if (serialized !== undefined && traceText.length < serialized.length && serialized.length > maxTraceChars) {
        episode.flags.truncated = true
      }
    } catch {
      episode.flags.truncated = true
    }
    const route = await resolveJudgeRoute(ctx, session, cfg)
    const prompt = buildJudgeInput({ episode, traceText, config })
    if (prompt.truncated === true) episode.flags.truncated = true
    const temperature = clamp(cfg.temperature ?? 0.1, 0, 1, 0.1)
    const timeoutMs = clamp(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, 300000, DEFAULT_TIMEOUT_MS)
    const call = async (messages, purpose) => {
      if (cfg.mode === 'subagent') {
        const promptText = renderRequestText({ system: prompt.system, messages })
        const parent = episode?._agent ?? episode?.agent ?? session?.agent
        const cwd = typeof episode?.task?.cwd === 'string' && episode.task.cwd.length > 0 ? episode.task.cwd : undefined
        const subagentResult = await runSubagentText({
          ctx,
          provider: cfg.subagentProvider,
          label: purpose === 'judge-retry' ? 'dreaming judge retry' : 'dreaming judge',
          promptText,
          parent,
          cwd,
          timeoutMs,
          signal,
          logger: log,
        })
        if (subagentResult !== null) return subagentResult
      }
      return streamText(ctx, {
        route,
        system: prompt.system,
        messages,
        temperature,
        maxTokens: route.maxTokens,
        timeoutMs,
        signal,
        purpose,
        logger: log,
      })
    }

    let judgeModel = `${route.provider}/${route.model}`
    const noteBackend = (result) => {
      if (result?.provider === 'subagent') judgeModel = `subagent/${result.model}`
    }

    let result = await call(prompt.messages, 'judge')
    noteBackend(result)
    let tokensIn = result.usage.inputTokens
    let tokensOut = result.usage.outputTokens
    let attempt = parseJudgeReply(result.text)
    if (attempt.repaired) {
      episode.flags.truncated = true
      log?.warn?.(`dreaming: judge for ${episode.skill} reply was truncated; recovered a JSON prefix`)
    }
    let validated = attempt.parsed === undefined ? null : validateJudge(attempt.parsed)
    if (validated === null && cfg.retryInvalidOnce === true) {
      log?.debug?.(`dreaming: judge for ${episode.skill} returned invalid JSON; retrying once with a reminder`)
      result = await call([...prompt.messages, reminderMessage()], 'judge-retry')
      noteBackend(result)
      tokensIn += result.usage.inputTokens
      tokensOut += result.usage.outputTokens
      attempt = parseJudgeReply(result.text)
      if (attempt.repaired) {
        episode.flags.truncated = true
        log?.warn?.(`dreaming: judge retry for ${episode.skill} was truncated; recovered a JSON prefix`)
      }
      validated = attempt.parsed === undefined ? null : validateJudge(attempt.parsed)
    }

    if (validated === null) {
      episode.judge = {
        ...episode.judge,
        status: 'invalid',
        model: judgeModel,
        tokensIn,
        tokensOut,
        error: 'invalid-json',
      }
      episode.cost = computeEpisodeCost(episode)
      episode.endedAt = episode.endedAt || Date.now()
      if (episode.state !== 'failed') episode.state = 'observed'
      await persistSkippedOrInvalid({ store, episode, log })
      log?.warn?.(`dreaming: judge for ${episode.skill} returned invalid JSON after retry`)
      return episode
    }

    episode.judge = {
      status: 'ok',
      model: judgeModel,
      tokensIn,
      tokensOut,
      error: null,
      ...validated.value,
    }
    episode.cost = computeEpisodeCost(episode)
    episode.state = 'judged'
    episode.endedAt = episode.endedAt || Date.now()
    if (validated.issues.length > 0) log?.debug?.(`dreaming: judge for ${episode.skill} coerced ${validated.issues.length} field(s)`)
    log?.debug?.(
      `dreaming: judge ok skill=${episode.skill} score=${episode.judge.score} verdict=${episode.judge.verdict} ` +
        `wasted=${episode.cost.wastedEstimate} in=${tokensIn} out=${tokensOut}`,
    )
    await persistJudged({ store, episode, guidance, log })
    return episode
  } catch (error) {
    const failure = safeError(error)
    try {
      episode.judge = {
        ...(episode.judge ?? emptyJudgeRecord()),
        status: 'error',
        error: failure.message || failure.name,
      }
      episode.cost = computeEpisodeCost(episode)
      if (episode.state !== 'judged') episode.state = episode.state === 'failed' ? 'failed' : 'observed'
      if (!episode.endedAt) episode.endedAt = Date.now()
      await persistSkippedOrInvalid({ store, episode, log })
    } catch {
      // Persisting a judge failure is best effort; never escalate.
    }
    log?.warn?.(`dreaming: judge for ${episode?.skill ?? 'unknown'} failed: ${failure.message}`)
    return episode
  }
}
