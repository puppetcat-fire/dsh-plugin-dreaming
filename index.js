/**
 * Dreaming — Host plugin entry.
 *
 * The plugin raises **consciousness strength**: the measured agreement between what the agent
 * believes a skill can do and what the skill actually delivers. It does not log for its own sake.
 *
 *   probe (concurrent, cheap) → observe the real turn → judge → capability belief
 *   → inject awareness before use → nightly dream → safer, more precise skill descriptions
 *
 * Everything here is defensive by construction: a skill call, a turn, or the Host process must
 * never fail because dreaming failed. Every listener contains its own errors; every
 * fire-and-forget promise is caught; every timer and observation window is owned and disposed.
 *
 * @module dsh-plugin-dreaming
 */

import { CAPS, SECTION_NAME, TOOL_NAME } from './lib/constants.js'
import { buildConfigSchema, normalizeConfig, resolveDataDir } from './lib/config.js'
import { DreamStore, stateDigest } from './lib/store.js'
import { computeOverall, renderSkillLine } from './lib/stats.js'
import { EpisodeTracker } from './lib/episode.js'
import { DreamEngine } from './lib/dream.js'
import { DreamScheduler } from './lib/scheduler.js'
import { mergeLearnings, renderPromptSection, renderSkillAnnotation } from './lib/guidance.js'
import { installApi } from './lib/api.js'
import { readSkillFile, revertEdit as revertSkillEdit } from './lib/skill-edits.js'
import { oneLine, safeError, truncate } from './lib/util.js'

/** Optional schemastery import: the plugin still runs (with manual validation) without it. */
let ConfigSchema
try {
  const mod = await import('@deepseek-ai/schemastery')
  const z = mod?.default ?? mod
  if (z !== undefined && typeof z.object === 'function') ConfigSchema = buildConfigSchema(z)
} catch {
  // Optional dependency; `normalizeConfig` is the authoritative validator at runtime.
  // The Host logs this once from `apply` (a module-scope write to stderr would be noisy).
}

/** Exported schemastery schema (undefined when the optional package is absent). */
export const Config = ConfigSchema

export const name = 'dreaming'

/**
 * Only services that must exist for the plugin to do useful work. Optional services
 * (`webServer`, `subagents`, `settings`, `workingDirectory`) are reached lazily through
 * `ctx.get(...)` and degrade gracefully.
 */
export const inject = ['tools', 'systemPrompt', 'skills', 'llm', 'sessions', 'agents']

const AWARENESS_SECTION_ORDER = 900
const NOOP = () => {}

/**
 * Install the dreaming capability into one Host composition.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig plugin configuration from the profile patch
 */
export function apply(ctx, rawConfig) {
  const logger = createLogger(ctx?.logger)
  if (ConfigSchema === undefined) {
    logger.warn('dreaming: Config schema unavailable (schemastery not resolvable); runtime validation still applies')
  }
  const { config, warnings } = normalizeConfig(rawConfig ?? {})
  for (const warning of warnings) logger.warn(`dreaming config: ${warning}`)
  if (!config.enabled) {
    logger.info('dreaming: disabled by configuration')
    return
  }

  const store = new DreamStore({
    dir: resolveDataDir(config),
    logger,
    limits: { ...config.store, mismatchScoreThreshold: config.dream.scoreThreshold },
  })
  const opened = store.open()
  if (!opened.ready) {
    logger.warn('dreaming: durable store unavailable; observations will not persist across restarts')
  }

  const guidanceCache = createGuidanceCache({ store, config, logger })
  const tracker = new EpisodeTracker({
    ctx,
    config,
    store,
    logger,
    guidance: { mergeLearnings },
  })

  const dreamEngine = new DreamEngine({
    ctx,
    config,
    store,
    logger,
    tracker,
    isSkillBusy: (skillName) => {
      try {
        return typeof tracker.isSkillBusy === 'function' ? tracker.isSkillBusy(skillName) === true : false
      } catch {
        return false
      }
    },
  })

  /** Single place every dream trigger funnels through, so the prompt cache always refreshes. */
  const runDream = async (trigger, options = {}) => {
    try {
      const result = await dreamEngine.run({ trigger, source: options.source ?? trigger, signal: options.signal })
      guidanceCache.invalidate()
      return result
    } catch (error) {
      logger.warn(`dreaming: dream run failed: ${safeError(error).message}`)
      guidanceCache.invalidate()
      return { status: 'failed', error: safeError(error) }
    }
  }

  const scheduler = new DreamScheduler({
    store,
    config,
    logger,
    run: async (reason, { signal } = {}) => runDream(reason, { source: 'schedule', signal }),
  })

  // ---------------------------------------------------------------------------------------------
  // observation
  // ---------------------------------------------------------------------------------------------

  const resolveSession = (exec) => {
    if (exec?.agent?.session) return exec.agent.session
    const id = exec?.agent?.id
    if (id === undefined || id === null) return undefined
    try {
      return ctx.get('sessions')?.get(id)
    } catch {
      return undefined
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (exec?.name === config.skillTool && exec.agent !== undefined) {
        await tracker.onPreExecute({ exec, session: resolveSession(exec) })
      }
    } catch (error) {
      logger.warn(`dreaming: pre-execute observation failed: ${safeError(error).message}`)
    }
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    try {
      if (exec?.name !== config.skillTool) return
      tracker.onToolResult({ exec, result })
    } catch (error) {
      logger.warn(`dreaming: result observation failed: ${safeError(error).message}`)
    }
  })

  ctx.on('session/event', (session, event) => {
    try {
      tracker.onSessionEvent(session, event)
    } catch (error) {
      logger.warn(`dreaming: session observation failed: ${safeError(error).message}`)
    }
  })

  ctx.on('agent/disposed', ({ agent } = {}) => {
    try {
      if (agent?.id !== undefined) tracker.onSessionGone(agent.id)
    } catch (error) {
      logger.warn(`dreaming: agent cleanup failed: ${safeError(error).message}`)
    }
  })

  ctx.on('session/disposed', (session) => {
    try {
      if (session?.id !== undefined) tracker.onSessionGone(session.id)
    } catch (error) {
      logger.warn(`dreaming: session cleanup failed: ${safeError(error).message}`)
    }
  })

  // ---------------------------------------------------------------------------------------------
  // injection: awareness before use, reality check on the loaded skill
  // ---------------------------------------------------------------------------------------------

  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: AWARENESS_SECTION_ORDER,
    // The generated text is literal model-facing prose (skill names, judge/dream free text). Keep it
    // out of the Harness `{{variable}}` interpolation: an unregistered or malformed reference would
    // otherwise throw during prompt assembly and fail every model request.
    interpolate: false,
    text: () => guidanceCache.text(),
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (!config.prompt.annotateSkillResult || exec?.name !== config.skillTool || result?.isError === true) {
      return next()
    }
    // Let a downstream listener failure propagate as the pipeline expects; catching and calling
    // next() again would run the remaining waterfall twice.
    const decision = await next()
    try {
      if (decision?.kind !== 'accept') return decision
      // The default accept decision usually carries no `content`: ToolRuntime then falls back
      // to `result.content`. Append the annotation to whichever content is authoritative.
      const baseContent = Array.isArray(decision.content)
        ? decision.content
        : (Array.isArray(result?.content) ? result.content : null)
      if (baseContent === null) return decision
      const episode = await raceDeadline(
        tracker.probePromiseFor(exec.callId, exec.agent?.id),
        config.probe.attachDeadlineMs,
        logger,
      )
      // The probe may still be running when the model is about to read the skill result. Even
      // then, historical awareness and learned boundaries are immediately available: derive the
      // skill name from the call arguments instead of waiting for the episode.
      const skillName = episode?.skill ?? (typeof exec.arguments?.name === 'string' ? exec.arguments.name : undefined)
      const skillState = skillName !== undefined ? store.getSkill(skillName) : undefined
      if (skillState === undefined) return decision
      const annotation = renderSkillAnnotation({
        skillState,
        prediction: episode?.prediction ?? null,
        config,
      })
      if (typeof annotation !== 'string' || annotation.trim().length === 0) return decision
      const budget = Math.max(200, Math.min(config.prompt.annotationMaxChars, CAPS.skillAnnotationChars))
      const bounded = truncate(annotation, budget)
      logger.debug?.(
        `dreaming: annotated skill result for ${skillName} (${bounded.length} chars, ${CAPS.skillAnnotationChars} cap)`,
      )
      return {
        ...decision,
        content: [...baseContent, { type: 'text', text: bounded }],
      }
    } catch (error) {
      logger.warn(`dreaming: skill annotation failed: ${safeError(error).message}`)
      return decision
    }
  })

  // ---------------------------------------------------------------------------------------------
  // model-facing tool
  // ---------------------------------------------------------------------------------------------

  try {
    ctx.tools.register(buildDreamingTool({ ctx, config, store, tracker, dreamEngine, runDream, scheduler, logger }))
  } catch (error) {
    logger.warn(`dreaming: failed to register the "${TOOL_NAME}" tool: ${safeError(error).message}`)
  }

  // ---------------------------------------------------------------------------------------------
  // dashboard + revert
  // ---------------------------------------------------------------------------------------------

  const revertEdit = async (editId, options = {}) => {
    try {
      if (typeof editId !== 'string' || editId.length === 0) return { ok: false, reason: 'bad-request' }
      const edit = store.getEdit(editId)
      if (edit === undefined) return { ok: false, reason: 'not-found' }
      if (edit.status === 'reverted') return { ok: true, edit }
      // A conflict is not terminal: the user may reconcile the file (for example restore it to the
      // exact post-edit hash) and retry. revertEdit re-verifies the hash and refuses again if not.
      if (edit.status !== 'applied' && edit.status !== 'conflict') {
        return { ok: false, reason: `not-applied:${edit.status}` }
      }
      const currentText = typeof edit.path === 'string' ? readSkillFile(edit.path) : null
      if (currentText === null) {
        store.markEdit(editId, 'conflict', { conflictAt: Date.now(), conflictReason: 'missing-file' })
        return { ok: false, reason: 'missing-file' }
      }
      const outcome = await revertSkillEdit({
        edit,
        dataDir: store.dir,
        currentText,
        logger,
      })
      if (outcome?.ok === true) {
        store.markEdit(editId, 'reverted', { revertedAt: Date.now(), revertReason: options.reason ?? 'manual' })
        // The belief's edit list must reflect reality, otherwise the dashboard keeps showing
        // an applied edit that was rolled back.
        try {
          store.updateSkill(edit.skill, (skill) => {
            skill.appliedEdits = (skill.appliedEdits ?? []).filter((entry) => entry?.editId !== editId)
          })
        } catch (error) {
          logger.warn(`dreaming: failed to update skill edit list after revert: ${safeError(error).message}`)
        }
        guidanceCache.invalidate()
        return { ok: true, edit: store.getEdit(editId) }
      }
      const reason = typeof outcome?.reason === 'string' ? outcome.reason : 'revert-failed'
      if (reason === 'conflict' || reason === 'hash-mismatch' || reason === 'changed') {
        store.markEdit(editId, 'conflict', { conflictAt: Date.now(), conflictReason: reason })
      }
      return { ok: false, reason }
    } catch (error) {
      logger.warn(`dreaming: revert failed: ${safeError(error).message}`)
      return { ok: false, reason: 'error' }
    }
  }

  ctx.inject(['webServer'], (child) => {
    if (config.api?.enabled === false) {
      logger.info('dreaming: dashboard API disabled by configuration (api.enabled=false)')
      return
    }
    const dispose = installApi({
      ctx: child,
      config,
      store,
      tracker,
      guidance: { renderPromptSection, renderSkillAnnotation },
      logger,
      revertEdit,
      dreamEngine: {
        isRunning: () => {
          try {
            return dreamEngine.isRunning() === true || scheduler.isRunning() === true
          } catch {
            return false
          }
        },
        run: (options = {}) => runDream(options.trigger ?? 'manual', { source: options.source ?? 'api' }),
      },
    })
    child.effect(() => dispose)
    logger.info('dreaming: dashboard API mounted at /dreaming/api/')
  })

  // Settings page: no volatile config fields are exposed, so this is informational only.
  ctx.inject(['settings'], (child) => {
    try {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    } catch (error) {
      logger.debug?.(`dreaming: settings.configure skipped: ${safeError(error).message}`)
    }
  })

  // ---------------------------------------------------------------------------------------------
  // lifecycle
  // ---------------------------------------------------------------------------------------------

  scheduler.start()

  ctx.effect(() => () => {
    try {
      scheduler.dispose()
    } catch (error) {
      logger.warn(`dreaming: scheduler disposal failed: ${safeError(error).message}`)
    }
    try {
      tracker.dispose()
    } catch (error) {
      logger.warn(`dreaming: tracker disposal failed: ${safeError(error).message}`)
    }
    try {
      store.close()
    } catch (error) {
      logger.warn(`dreaming: store close failed: ${safeError(error).message}`)
    }
    logger.info('dreaming: stopped')
  })

  logger.info(
    `dreaming: active (data=${store.dir}, probe=${config.probe.enabled ? config.probe.mode : 'off'}, judge=${config.judge.enabled ? 'on' : 'off'}, dream=${config.dream.enabled ? config.dream.time : 'off'})`,
  )
}

// -----------------------------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------------------------

function createLogger(base) {
  const target = base ?? console
  const log = (level, message) => {
    try {
      const fn = typeof target?.[level] === 'function' ? target[level].bind(target) : undefined
      if (fn !== undefined) fn(message)
    } catch {
      // logging must never throw into a listener
    }
  }
  return {
    info: (message) => log('info', message),
    warn: (message) => log('warn', message),
    error: (message) => log('error', message),
    debug: (message) => log('debug', message),
  }
}

/**
 * Prompt text cache: rebuilt at most once per `prompt.refreshMinutes`, and immediately after a
 * dream or a revert. This keeps the global prompt prefix stable (KV cache) while still noticing
 * learned capability boundaries; the digest is only logged, never used to force a rebuild storm.
 */
function createGuidanceCache({ store, config, logger }) {
  let text = ''
  let builtAt = 0
  let builtDigest = ''
  let invalidated = true
  const ttl = Math.max(0, config.prompt.refreshMinutes) * 60_000
  return {
    text() {
      try {
        if (!config.prompt.awarenessSection) return ''
        const now = Date.now()
        if (!invalidated && builtAt !== 0 && now - builtAt < ttl) return text
        const overall = computeOverall(store.state)
        const skills = store
          .allSkills()
          .filter((skill) => (skill?.counts?.judged ?? 0) >= config.prompt.minJudgedForSection)
        const next = renderPromptSection(overall, skills, config)
        const digest = stateDigest(store.state)
        if (next !== text) logger.debug?.(`dreaming: awareness section refreshed (${next.length} chars)`)
        text = typeof next === 'string' ? next : ''
        builtAt = now
        builtDigest = digest
        invalidated = false
        return text
      } catch (error) {
        logger.warn(`dreaming: awareness section failed: ${safeError(error).message}`)
        return text
      }
    },
    invalidate() {
      invalidated = true
    },
    digest() {
      return builtDigest
    },
    markBuiltAt(value) {
      builtAt = Number.isFinite(value) ? value : builtAt
    },
  }
}

/** Race a promise against a deadline without leaking the timer or rejecting. */
function raceDeadline(promise, ms, logger) {
  const timeout = Math.max(0, Number.isFinite(ms) ? ms : 0)
  if (timeout === 0 || typeof promise?.then !== 'function') return Promise.resolve(promise)
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(undefined)
      logger.debug?.('dreaming: probe missed the annotation deadline; history-only annotation used')
    }, timeout)
    Promise.resolve(promise)
      .then((value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        logger.debug?.(`dreaming: probe promise failed: ${safeError(error).message}`)
        resolve(undefined)
      })
  })
}

/** Model-facing `dreaming` tool: read capability awareness, list gaps, or run a bounded dream. */
function buildDreamingTool({ ctx, config, store, tracker, dreamEngine, runDream, scheduler, logger }) {
  const MAX_LIMIT = 40
  return {
    name: TOOL_NAME,
    description:
      'Report measured skill capability awareness ("consciousness strength"): how reliably each skill delivers what its description claims, the token waste observed, and the learned boundaries. Use action="status" for the overall picture, "gaps" for the skills that are most often mis-invoked, and "dream" to run one bounded, journaled dream pass that may refine skill descriptions and boundaries (it creates backups and is reversible). This tool reads the dreaming store; it does not change the current task unless action is "dream".',
    // Raw wire schema: ToolRuntime.register() snapshots `parameters` as lossless JSON and sends it
    // verbatim to the provider; `output.schema` is the part validated by
    // assertSupportedJsonSchema. It is deliberately NOT the defineTool DSL (which uses
    // property-level `required: true` and is converted only by defineTool itself).
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'gaps', 'dream'],
          description: 'status = overall awareness; gaps = most mis-invoked skills; dream = run one bounded dream pass.',
        },
        limit: {
          type: 'number',
          description: `Maximum number of skills to report (default 10, max ${MAX_LIMIT}).`,
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['action', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      try {
        const action = typeof args?.action === 'string' ? args.action : 'status'
        const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(args?.limit) ? Math.floor(args.limit) : 10))
        if (action === 'dream') {
          if (dreamEngine.isRunning() === true || scheduler.isRunning() === true) {
            return {
              action,
              text: 'A dream pass is already running. Ask again after it finishes; the journal will show its proposals and applied edits.',
            }
          }
          const result = await runDream('manual', { source: 'tool' })
          const status = result?.status ?? 'unknown'
          const skills = Array.isArray(result?.skills) ? result.skills : []
          const countStatus = (value) => skills.filter((row) => row?.status === value).length
          const applied = countStatus('applied')
          const suggested = countStatus('suggested')
          const rejected = countStatus('rejected')
          const summary = truncate(
            `Dream ${status}: ${skills.length} skill pack(s), ${applied} applied, ${suggested} suggestion(s), ${rejected} rejected. ` +
              `Mode ${result?.mode ?? 'inline'}, tokens in/out ${result?.tokens?.in ?? 0}/${result?.tokens?.out ?? 0}. ` +
              (result?.error !== undefined ? `Error: ${safeError(result.error).message}. ` : '') +
              'Open Settings → Dreaming to review the journal or revert an applied edit.',
            1200,
          )
          return { action, text: summary }
        }
        const overall = computeOverall(store.state)
        const skills = store
          .allSkills()
          .filter((skill) => (skill?.counts?.judged ?? 0) > 0)
          .sort((a, b) =>
            action === 'gaps'
              ? (a.metrics?.consciousness ?? 0) - (b.metrics?.consciousness ?? 0) || (b.metrics?.wasteRate ?? 0) - (a.metrics?.wasteRate ?? 0)
              : (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
          )
          .slice(0, limit)
        const nextDream = scheduler.nextRunAt?.() ?? store.state.dream?.nextRunAt ?? 0
        const nextDreamText = nextDream > 0 ? new Date(nextDream).toISOString() : 'not scheduled'
        const lines = [
          `Consciousness strength: ${overall.consciousness}/100 (confidence ${overall.confidence}; ${overall.judged} judged skill calls across ${overall.skillsTracked} skills).`,
          `Token waste: ${(overall.wasteRate * 100).toFixed(1)}% of loaded skill tokens; estimated waste avoided after edits: ${overall.estimatedWasteAvoided} tokens. Probe+judge spend: ${overall.probeTokens + overall.judgeTokens} tokens. Dream tokens: ${overall.dreamTokens}. Next dream: ${nextDreamText}.`,
        ]
        if (skills.length === 0) {
          lines.push('No skill has been judged yet; load a skill and act on it, then ask again.')
        } else {
          lines.push(action === 'gaps' ? 'Lowest-awareness skills:' : 'Recently used skills:')
          for (const skill of skills) lines.push(`- ${renderSkillLine(skill)}`)
        }
        if (ctx.get('subagents') === undefined) {
          lines.push('(subagent probing unavailable; inline probing is used)')
        }
        return { action, text: truncate(lines.join('\n'), 1600) }
      } catch (error) {
        logger.warn(`dreaming: "${TOOL_NAME}" tool failed: ${safeError(error).message}`)
        return { action: 'status', text: `Dreaming is unavailable: ${safeError(error).message}` }
      }
    },
  }
}

// Kept for tests/tools without importing the tracker internals.
export const __internals = { NOOP, buildDreamingTool }
