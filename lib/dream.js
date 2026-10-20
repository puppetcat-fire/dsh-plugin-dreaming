/**
 * The nightly dream cycle: find the skill loads where expectation and reality diverged, ask a
 * dreamer model for an evidence-backed improvement, validate that improvement, and — only for
 * user-level skills and only when `dream.autoApply` is on — apply it through the guarded edit
 * pipeline in `skill-edits.js`. The run is journaled in full, including rejected proposals.
 *
 * Design constraints (ARCHITECTURE.md §6 dream, §11 failure posture):
 * - one in-process run at a time (`isRunning()`); a second call returns `{ status:'skipped' }`;
 * - the dreamer is an **inline** bounded call in v1 for every `dream.mode` (auto/subagent/inline).
 *   A nightly run has no live parent Agent, so the subagent path is not wired yet; the code keeps
 *   `buildDreamInput`/`validateDream`/`streamText` split so a subagent backend can be added later
 *   without prompt changes. `mode` in the journal is therefore always `'inline'` (truthful);
 *   a warning is logged when the config asked for `subagent`.
 * - every proposal is journaled with `applied`/`status`/`reasons`, including rejected ones;
 * - learned rules are merged for every skill regardless of editability (guidance overlay only);
 * - `dailyTokenBudget` and `maxRunMs` bound the run; exhaustion yields `status:'partial'`;
 * - a skill with an in-flight episode is never edited (`isSkillBusy`/`tracker.isSkillBusy`);
 * - `run()` never throws: every failure becomes a run record with `status:'failed'`.
 *
 * @module dream
 */

import { CAPS } from './constants.js'
import { mergeLearnings } from './guidance.js'
import { resolveRoute, streamText } from './llm.js'
import { buildDreamInput, compactCase, validateDream } from './prompts.js'
import {
  applyEditPlan,
  isEditableSkill,
  planBodySectionEdit,
  planDescriptionEdit,
  readSkillFile,
  scanEditSafety,
} from './skill-edits.js'
import { computeOverall } from './stats.js'
import { asInt, clamp, makeId, oneLine, parseJsonLoose, safeError, withTimeout } from './util.js'

const DEFAULT_LOGGER = Object.freeze({
  info() {},
  warn() {},
  error() {},
  debug() {},
})

/** The dream builder only uses the first eight cases; selecting more would waste evidence slots. */
const MAX_CASES_IN_PACK = 8

/** Minimum spacing between edits for one skill, in case a future subagent returns many proposals. */
const MAX_EDITS_PER_SKILL = 2

/**
 * Awareness fragments are injected as guidance, never as skill instructions. They only need the
 * instruction/role guard: legitimate preconditions may mention credentials or network commands
 * ("requires an API key", "download it with curl first"), so the broader edit-time families must
 * not drop them.
 */
const GUIDANCE_SAFETY_FAMILIES = Object.freeze(['instruction-override', 'role-injection'])

/**
 * One dream cycle. Construct once (owned by `index.js`) and call `run()` per trigger so the
 * in-process lock is shared between the scheduler and the API/dashboard trigger.
 */
export class DreamEngine {
  /**
   * @param {object} options
   * @param {object} options.ctx Harness context (may be a fake in unit tests)
   * @param {object} options.config normalized plugin config
   * @param {object} options.store `DreamStore`
   * @param {object} [options.logger] Cordis logger or compatible
   * @param {object} [options.tracker] `EpisodeTracker` (optional; `isSkillBusy` wins)
   * @param {(name: string) => boolean} [options.isSkillBusy] in-flight skill check
   * @param {() => number} [options.now]
   * @param {NodeJS.ProcessEnv} [options.env] environment used for the skill-root gate
   * @param {string} [options.home] home directory used for the skill-root gate
   * @param {string} [options.dataDir] edit/backup data dir (defaults to `store.dir`)
   */
  constructor({ ctx, config, store, logger, tracker, isSkillBusy, now = Date.now, env, home, dataDir } = {}) {
    this.ctx = ctx
    this.config = config ?? {}
    this.store = store
    this.logger = logger ?? DEFAULT_LOGGER
    this.tracker = tracker ?? null
    this.isSkillBusy = typeof isSkillBusy === 'function' ? isSkillBusy : null
    this.now = now
    this.env = env
    this.home = home
    this.dataDir = dataDir
    this._running = null
    this._runTokens = 0
    this._remainingBudget = 0
    this._loggedSubagentWarning = false
  }

  /** @returns {boolean} true while a dream run is executing */
  isRunning() {
    return this._running !== null
  }

  /**
   * Run one dream cycle. Never throws and never overlaps a previous run.
   *
   * @param {{ trigger?: 'manual'|'schedule'|'catch-up', signal?: AbortSignal, source?: string }} [args]
   * @returns {Promise<object>} `dreams.json` run record (see ARCHITECTURE.md §5.3)
   */
  async run({ trigger = 'manual', signal, source } = {}) {
    if (this._running !== null) {
      return {
        id: null,
        trigger: trigger === 'manual' ? 'manual' : 'schedule',
        status: 'skipped',
        reason: 'already-running',
        startedAt: safeNow(this.now),
        endedAt: safeNow(this.now),
        mode: 'inline',
        before: null,
        afterEstimate: null,
        cases: 0,
        skills: [],
        tokens: { in: 0, out: 0 },
        error: null,
      }
    }
    const promise = this._execute({ trigger, signal, source })
    this._running = promise
    try {
      const record = await promise
      return record ?? this._failureRecord(trigger, new Error('dreaming: dream returned no record'))
    } catch (error) {
      // _execute has its own catch; this is the last line of defence.
      this.logger.warn?.(`dreaming: dream run escaped: ${safeError(error).message}`)
      return this._failureRecord(trigger, error)
    } finally {
      if (this._running === promise) this._running = null
    }
  }

  // -------------------------------------------------------------------------------------------
  // run orchestration
  // -------------------------------------------------------------------------------------------

  async _execute({ trigger, signal, source }) {
    const startedAt = safeNow(this.now)
    const dreamCfg = this.config?.dream ?? {}
    let record = this._newRecord(trigger, startedAt, source)
    let deadline = null
    try {
      if (this.config?.enabled === false) return this._markSkipped(record, 'disabled')
      if (dreamCfg.enabled === false && trigger !== 'manual') return this._markSkipped(record, 'dream-disabled')
      if (this.store?.ready === false) return this._markSkipped(record, 'store-unavailable')

      if (dreamCfg.mode !== undefined && dreamCfg.mode !== 'inline' && !this._loggedSubagentWarning) {
        this._loggedSubagentWarning = true
        this.logger.warn?.(
          `dreaming: dream.mode="${dreamCfg.mode}" requested but only the inline dreamer is implemented in v1; falling back to inline`,
        )
      }
      record.requestedMode = dreamCfg.mode ?? 'inline'

      const maxRunMs = asInt(dreamCfg.maxRunMs, 60_000, 7_200_000, 1_800_000)
      deadline = withTimeout(maxRunMs, signal)

      const route = await resolveRoute(this.ctx, null, dreamCfg.model)
      record.route = { provider: route.provider, model: route.model }
      this._remainingBudget = this._dailyBudgetRemaining(dreamCfg, startedAt)
      this._runTokens = 0

      const selection = this.selectCases(startedAt)
      record.cases = selection.reduce((total, group) => total + group.cases.length, 0)
      if (selection.length === 0) {
        record.status = 'ok'
        record.noCases = true
        return record
      }

      const limit = Math.max(1, Math.min(asInt(dreamCfg.maxConcurrent, 1, 4, 1), selection.length))
      const entries = new Array(selection.length)
      if (limit === 1) {
        for (let index = 0; index < selection.length; index += 1) {
          entries[index] = await this._processSkill(selection[index], {
            dreamCfg,
            runId: record.id,
            deadline,
            record,
            route,
          })
        }
      } else {
        let cursor = 0
        const worker = async () => {
          while (cursor < selection.length) {
            const index = cursor
            cursor += 1
            entries[index] = await this._processSkill(selection[index], {
              dreamCfg,
              runId: record.id,
              deadline,
              record,
              route,
            })
          }
        }
        await Promise.all(Array.from({ length: limit }, () => worker()))
      }
      record.skills = entries.filter(Boolean)
      record.status = this._statusFor(record, deadline)
      return record
    } catch (error) {
      record.status = 'failed'
      record.error = safeError(error)
      this.logger.warn?.(`dreaming: dream run failed: ${record.error.message}`)
      return record
    } finally {
      try {
        deadline?.dispose()
      } catch {
        // nothing to dispose
      }
      record.endedAt = safeNow(this.now)
      record.tokens = { in: this._runTokens, out: record.tokens?.out ?? 0 }
      this._finalize(record)
    }
  }

  /**
   * Select mismatch cases grouped by skill: judged episodes in the window whose score is below
   * the threshold or whose verdict/gap says the skill under-delivered, newest first, excluding
   * episodes already attached to a dream run.
   *
   * @param {number} [now]
   * @returns {Array<{ skill: string, skillState: object|undefined, cases: object[], newest: number }>}
   */
  selectCases(now = safeNow(this.now)) {
    const dreamCfg = this.config?.dream ?? {}
    const windowMs = asInt(dreamCfg.caseWindowDays, 1, 90, 7) * 86_400_000
    const cutoff = now - windowMs
    const threshold = asInt(dreamCfg.scoreThreshold, 0, 100, 78)
    const groups = new Map()
    let episodes = []
    try {
      episodes = typeof this.store?.allEpisodes === 'function' ? this.store.allEpisodes() : []
    } catch {
      episodes = []
    }
    for (const episode of Array.isArray(episodes) ? episodes : []) {
      try {
        if (episode === null || typeof episode !== 'object') continue
        if (typeof episode.skill !== 'string' || episode.skill.length === 0) continue
        if ((episode.startedAt ?? 0) < cutoff) continue
        if (Array.isArray(episode.flags?.dreamIds) && episode.flags.dreamIds.length > 0) continue
        const judge = episode.judge
        if (judge === null || typeof judge !== 'object' || judge.status !== 'ok') continue
        const verdict = judge.verdict
        const score = typeof judge.score === 'number' && Number.isFinite(judge.score) ? judge.score : null
        const mismatch =
          verdict === 'missed' ||
          verdict === 'misapplied' ||
          (score !== null && score < threshold) ||
          judge.capabilityGap?.present === true
        if (!mismatch) continue
        const group = groups.get(episode.skill) ?? { skill: episode.skill, cases: [], newest: 0 }
        group.cases.push(episode)
        group.newest = Math.max(group.newest, episode.startedAt ?? 0)
        groups.set(episode.skill, group)
      } catch {
        // one corrupt episode must never fail case selection
      }
    }
    const minNew = Math.max(1, asInt(dreamCfg.minNewEpisodes, 0, 1000, 1))
    const ordered = [...groups.values()]
      .filter((group) => group.cases.length >= minNew)
      .sort((a, b) => b.newest - a.newest)
      .slice(0, asInt(dreamCfg.maxSkillsPerRun, 1, 20, 3))
    const maxCases = Math.min(MAX_CASES_IN_PACK, asInt(dreamCfg.maxCasesPerSkill, 1, 40, 6))
    return ordered.map((group) => ({
      skill: group.skill,
      cases: group.cases
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
        .slice(0, maxCases),
      skillState: this._resolveSkillState(group.skill, group.cases[0]),
    }))
  }

  /** Process one skill: build the bounded pack, call the dreamer, validate, apply, merge. */
  async _processSkill(group, { dreamCfg, runId, deadline, record, route }) {
    const name = group.skill
    const cases = group.cases
    const caseIds = cases.map((episode) => episode.id)
    const entry = {
      skill: name,
      caseIds,
      proposal: null,
      applied: false,
      editIds: [],
      status: 'rejected',
      reasons: [],
      error: null,
      editable: false,
      tokens: { in: 0, out: 0 },
    }
    try {
      if (deadline?.signal.aborted === true) {
        entry.reason = this._abortReason(deadline.signal)
        entry.reasons.push(entry.reason)
        return entry
      }
      const skillState = group.skillState ?? this.store?.getSkill?.(name) ?? { name }
      entry.editable = this._editableCheck(skillState, cases[0]).ok
      if (this._isSkillBusy(name)) {
        entry.reasons.push('skill-busy')
        this.logger.warn?.(`dreaming: skipped "${name}": a skill call is in flight`)
        return entry
      }
      if (this._remainingBudget <= 0) {
        entry.reasons.push('token-budget')
        return entry
      }

      const skillFile = this._readSkillFile(skillState)
      const prompt = buildDreamInput({
        skillState,
        cases: cases.map((episode) => compactCase(episode)),
        skillFile: skillFile ?? '',
      })
      if (prompt === null || typeof prompt !== 'object' || typeof prompt.system !== 'string') {
        entry.reasons.push('prompt-build-failed')
        return entry
      }

      const maxTokens = this._dreamMaxTokens(dreamCfg)
      const reply = await streamText(this.ctx, {
        route,
        system: prompt.system,
        messages: prompt.messages,
        temperature: dreamCfg.temperature,
        maxTokens,
        timeoutMs: dreamCfg.timeoutMs,
        signal: deadline?.signal,
        purpose: 'dream',
        logger: this.logger,
      })
      this._accountTokens(reply.usage, entry, record)

      const parsed = parseJsonLoose(reply.text)
      if (parsed === undefined) {
        entry.reasons.push('invalid-json')
        entry.error = { name: 'InvalidDreamReply', message: oneLine(reply.text, 200) }
        return entry
      }
      const validation = validateDream(parsed)
      const proposal = validation.value
      entry.proposal = proposal
      if (Array.isArray(validation.issues) && validation.issues.length > 0) entry.issues = validation.issues

      const confidence = clamp(proposal.confidence, 0, 1, 0)
      const minConfidence = clamp(dreamCfg.minProposalConfidence, 0, 1, 0.55)
      if (confidence < minConfidence) {
        entry.reasons.push('low-confidence')
        return entry
      }

      const actionable = this._isActionable(proposal)
      if (!actionable) {
        entry.reasons.push('empty-proposal')
        return entry
      }

      // Deterministic semantic guard: never write dreamer text that could hijack future turns.
      // The whole proposal is rejected (safe description + unsafe body are not partially applied),
      // but evidence-derived learned rules are still merged as filtered awareness notes.
      const unsafe = this._unsafeProposalField(proposal)
      if (unsafe !== null) {
        entry.reasons.push('unsafe-content')
        entry.unsafe = unsafe
        this._mergeGuidance(name, proposal, { runId, caseIds, editable: entry.editable })
        entry.proposalReceived = true
        entry.status = 'rejected'
        return entry
      }

      // Learned guidance is merged for every valid proposal, editable or not.
      this._mergeGuidance(name, proposal, { runId, caseIds, editable: entry.editable })
      entry.proposalReceived = true

      if (!entry.editable) {
        entry.status = 'suggested'
        entry.reasons.push('source-not-editable')
        return entry
      }
      if (dreamCfg.autoApply !== true) {
        entry.status = 'suggested'
        entry.reasons.push('auto-apply-off')
        return entry
      }
      await this._applyProposal({
        entry,
        proposal,
        skillState,
        cases,
        caseIds,
        dreamCfg,
        runId,
        currentText: skillFile,
      })
      entry.applied = entry.editIds.length > 0
      entry.status = entry.applied ? 'applied' : 'rejected'
      return entry
    } catch (error) {
      const safe = safeError(error)
      entry.error = safe
      entry.reasons.push(this._isAbortError(error) ? 'aborted' : 'dream-failed')
      if (!entry.proposal || entry.editIds.length === 0) entry.status = 'rejected'
      this.logger.warn?.(`dreaming: dream for "${name}" failed: ${safe.message}`)
      return entry
    } finally {
      if (entry.proposalReceived === true) this._markCasesDreamed(cases, runId)
    }
  }

  /** Plan + apply description then body edit independently, re-checking the path gate each time. */
  async _applyProposal({ entry, proposal, skillState, cases, caseIds, dreamCfg, runId, currentText }) {
    let text = typeof currentText === 'string' ? currentText : null
    const dataDir = this.dataDir ?? this.store?.dir
    const write = async (kind, plan, path) => {
      if (plan === null || plan.ok !== true) {
        entry.reasons.push(`${kind}:${plan?.reason ?? 'plan-failed'}`)
        return false
      }
      if (plan.changed === false) {
        entry.reasons.push(`${kind}:unchanged`)
        return false
      }
      if (this._isSkillBusy(entry.skill)) {
        entry.reasons.push(`${kind}:skill-busy`)
        return false
      }
      // Re-resolve symlinks immediately before the write (narrows the TOCTOU window).
      const fresh = this._editableCheck(skillState, cases[0])
      if (!fresh.ok) {
        entry.reasons.push(`${kind}:${fresh.reason}`)
        return false
      }
      if (typeof dataDir !== 'string' || dataDir.length === 0) {
        entry.reasons.push(`${kind}:no-data-dir`)
        return false
      }
      const applied = await applyEditPlan({
        plan,
        edit: {
          id: makeId('edit'),
          dreamId: runId,
          skill: entry.skill,
          kind,
          path: fresh.path,
        },
        dataDir,
        logger: this.logger,
        now: this.now,
      })
      if (applied.ok !== true) {
        entry.reasons.push(`${kind}:${applied.reason}`)
        return false
      }
      entry.editIds.push(applied.edit.id)
      text = plan.newText
      try {
        this.store?.addEdit?.(applied.edit)
        this.store?.recordSkillEdit?.(entry.skill, {
          editId: applied.edit.id,
          dreamId: runId,
          kind,
          appliedAt: applied.edit.appliedAt,
        })
      } catch (error) {
        this.logger.warn?.(`dreaming: applied edit could not be journaled: ${safeError(error).message}`)
      }
      return true
    }

    if (entry.editIds.length >= MAX_EDITS_PER_SKILL) return
    if (typeof proposal.descriptionEdit === 'string' && proposal.descriptionEdit.length > 0) {
      const plan = text === null
        ? { ok: false, reason: 'no-skill-file' }
        : planDescriptionEdit(text, proposal.descriptionEdit, {
            maxChars: dreamCfg.maxDescriptionChars,
            removeClaim: proposal.removeClaim === true,
            evidence: caseIds,
          })
      await write('description', plan, skillState?.path)
    }
    if (entry.editIds.length >= MAX_EDITS_PER_SKILL) return
    if (typeof proposal.bodyAddition === 'string' && proposal.bodyAddition.length > 0) {
      const plan = text === null
        ? { ok: false, reason: 'no-skill-file' }
        : planBodySectionEdit(text, proposal.bodyAddition, { maxChars: dreamCfg.maxBodySectionChars })
      await write('body', plan, skillState?.path)
    }
  }

  _mergeGuidance(name, proposal, { runId, caseIds, editable }) {
    try {
      // Awareness notes are injected into the global prompt section, so apply the narrow
      // instruction/role guard (not the full edit filter) before merging them as guidance.
      const isSafeGuidance = (text) => scanEditSafety(text, { families: GUIDANCE_SAFETY_FAMILIES }).ok === true
      const notes = Array.isArray(proposal.notes)
        ? proposal.notes.filter((note) => isSafeGuidance(note?.text))
        : []
      const learned = this._safeLearnings(proposal.learned)
      if (typeof proposal.selectionRule === 'string' && proposal.selectionRule.trim().length > 0
        && isSafeGuidance(proposal.selectionRule)) {
        notes.push({
          text: proposal.selectionRule,
          confidence: proposal.confidence,
          evidence: caseIds.slice(0, 4),
          dreamId: runId,
        })
      }
      this.store?.updateSkill?.(name, (skill) => {
        skill.editable = editable === true
        mergeLearnings(
          skill,
          { learned, notes },
          { maxNotes: CAPS.notesPerSkill, maxLines: CAPS.learnedLinesPerList, now: this.now },
        )
      })
    } catch (error) {
      this.logger.warn?.(`dreaming: could not merge learned guidance for "${name}": ${safeError(error).message}`)
    }
  }

  /** Copy only the learned lists/lines that pass the narrow guidance safety scan. */
  _safeLearnings(learned) {
    const out = {}
    if (learned === null || typeof learned !== 'object') return out
    for (const [kind, list] of Object.entries(learned)) {
      if (!Array.isArray(list)) continue
      out[kind] = list.filter((item) => scanEditSafety(
        typeof item === 'string' ? item : item?.text,
        { families: GUIDANCE_SAFETY_FAMILIES },
      ).ok === true)
    }
    return out
  }

  /** First proposed skill-instruction field (description/body) that fails the semantic scan. */
  _unsafeProposalField(proposal) {
    const candidates = [
      ['descriptionEdit', proposal?.descriptionEdit],
      ['bodyAddition', proposal?.bodyAddition],
    ]
    for (const [field, value] of candidates) {
      if (typeof value !== 'string' || value.length === 0) continue
      const scan = scanEditSafety(value)
      if (scan.ok !== true) {
        return { field, matched: scan.matched, pattern: scan.reason }
      }
    }
    return null
  }

  _markCasesDreamed(cases, runId) {
    try {
      for (const episode of cases) {
        const current = typeof this.store?.getEpisode === 'function' ? this.store.getEpisode(episode.id) : episode
        if (current === null || current === undefined) continue
        const dreamIds = Array.isArray(current.flags?.dreamIds) ? current.flags.dreamIds : []
        this.store?.updateEpisode?.(episode.id, {
          flags: { ...(current.flags ?? {}), dreamIds: [...dreamIds, runId].slice(-5) },
        })
      }
    } catch (error) {
      this.logger.warn?.(`dreaming: could not mark cases as dreamed: ${safeError(error).message}`)
    }
  }

  // -------------------------------------------------------------------------------------------
  // small helpers
  // -------------------------------------------------------------------------------------------

  _newRecord(trigger, startedAt, source) {
    const overall = this._overall()
    return {
      id: makeId('dream'),
      trigger: trigger === 'manual' ? 'manual' : 'schedule',
      startedAt,
      endedAt: startedAt,
      status: 'failed',
      mode: 'inline',
      before: {
        consciousness: overall.consciousness,
        episodes: overall.episodes,
        wastedTokens: overall.wastedTokens,
      },
      afterEstimate: null,
      cases: 0,
      skills: [],
      tokens: { in: 0, out: 0 },
      error: null,
      ...(typeof source === 'string' && source.length > 0 ? { source } : {}),
    }
  }

  _overall() {
    try {
      const state = this.store?.state
      return state !== undefined && state !== null ? computeOverall(state) : { consciousness: 0, episodes: 0, wastedTokens: 0 }
    } catch {
      return { consciousness: 0, episodes: 0, wastedTokens: 0 }
    }
  }

  _markSkipped(record, reason) {
    record.status = 'skipped'
    record.reason = reason
    return record
  }

  _statusFor(record, deadline) {
    if (deadline?.signal.aborted === true) return 'partial'
    if (this._remainingBudget <= 0) return 'partial'
    const entries = Array.isArray(record.skills) ? record.skills : []
    if (entries.length === 0) return 'failed'
    const failures = entries.filter((entry) => entry.status === 'rejected' && entry.error !== null).length
    return failures > 0 ? 'partial' : 'ok'
  }

  _failureRecord(trigger, error) {
    const now = safeNow(this.now)
    return {
      id: makeId('dream'),
      trigger: trigger === 'manual' ? 'manual' : 'schedule',
      startedAt: now,
      endedAt: now,
      status: 'failed',
      mode: 'inline',
      before: null,
      afterEstimate: null,
      cases: 0,
      skills: [],
      tokens: { in: 0, out: 0 },
      error: safeError(error),
    }
  }

  _finalize(record) {
    if (record._finalized === true) return
    record._finalized = true
    record.afterEstimate = this._estimateAfter(record)
    try {
      this.store?.appendDream?.(record)
    } catch (error) {
      this.logger.warn?.(`dreaming: could not journal the dream run: ${safeError(error).message}`)
    }
    if (record.status !== 'skipped') {
      try {
        // `lastRunAt`/`lastRunId` are the dream journal's schedule markers. `nextRunAt` and the
        // consecutive-failure counter belong to DreamScheduler, which persists them after it sees
        // this record; writing `failed` here too would double-count a single failure.
        this.store?.setDreamSchedule?.({
          lastRunAt: record.endedAt,
          lastRunId: record.id,
        })
      } catch (error) {
        this.logger.warn?.(`dreaming: could not persist dream schedule state: ${safeError(error).message}`)
      }
    }
    try {
      this.store?.prune?.()
    } catch {
      // pruning is maintenance, never fatal
    }
  }

  /**
   * Project the effect of this run. This is a *projection* derived from the existing fit trend and
   * the amount of boundary text added — never a measurement. The field is labelled `estimate: true`
   * and the dashboard must render it as "estimated".
   */
  _estimateAfter(record) {
    const before = record?.before ?? { consciousness: 0, wastedTokens: 0 }
    const skills = Array.isArray(record?.skills) ? record.skills : []
    let delta = 0
    let avoided = 0
    for (const entry of skills) {
      if (entry?.status === 'rejected' && entry?.proposal === null) continue
      const skill = this._skill(entry?.skill)
      const trend = typeof skill?.metrics?.trend === 'number' ? skill.metrics.trend : 0
      const learned = entry?.proposal?.learned ?? {}
      const boundaryLines = Object.values(learned)
        .reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0)
      const avgLoad = this._avgLoadTokens(skill)
      if (entry?.applied === true) {
        delta += Math.max(0, trend) * 0.4 + Math.min(6, boundaryLines * 1.25)
        avoided += avgLoad * clamp(0.1 + boundaryLines * 0.02, 0, 0.4)
      } else if (entry?.status === 'suggested') {
        delta += Math.min(2, boundaryLines * 0.4)
        avoided += avgLoad * 0.05
      }
    }
    return {
      consciousness: Math.round(clamp(before.consciousness + delta, 0, 100)),
      wastedTokensAvoided: Math.round(avoided),
      estimate: true,
      basis: 'fit trend + added boundary coverage (projection, not measured)',
    }
  }

  _skill(name) {
    try {
      return typeof this.store?.getSkill === 'function' ? this.store.getSkill(name) : undefined
    } catch {
      return undefined
    }
  }

  _avgLoadTokens(skill) {
    const loads = asInt(skill?.counts?.loads, 0, 1e9, 0)
    const total = typeof skill?.cost?.skillLoad === 'number' ? skill.cost.skillLoad : 0
    return loads > 0 && total > 0 ? total / loads : 0
  }

  _resolveSkillState(name, episode) {
    try {
      const existing = this._skill(name)
      if (existing !== undefined && existing !== null) return existing
      const meta = episode?.skillMeta ?? {}
      return this.store?.ensureSkill?.({
        name,
        meta: {
          description: meta.description ?? '',
          whenToUse: meta.whenToUse ?? '',
          source: meta.source ?? 'unknown',
          provider: meta.provider ?? 'unknown',
          path: meta.path ?? '',
          resourceBase: meta.resourceBase ?? null,
        },
        editable: false,
      })
    } catch {
      return { name }
    }
  }

  _editableCheck(skillState, episode) {
    try {
      return isEditableSkill(
        {
          path: skillState?.path ?? episode?.skillMeta?.path ?? '',
          source: skillState?.source ?? episode?.skillMeta?.source ?? '',
        },
        {
          editableSources: this.config?.dream?.editableSources,
          env: this.env,
          home: this.home,
        },
      )
    } catch (error) {
      return { ok: false, reason: 'editable-check-failed', error: safeError(error) }
    }
  }

  _isSkillBusy(name) {
    try {
      if (this.isSkillBusy !== null && this.isSkillBusy(name) === true) return true
      const tracker = this.tracker
      if (tracker !== null && tracker !== undefined) {
        if (typeof tracker.isSkillBusy === 'function' && tracker.isSkillBusy(name) === true) return true
        if (typeof tracker.isBusy === 'function' && tracker.isBusy(name) === true) return true
      }
    } catch {
      // A broken tracker must not block dreaming; treat as not busy.
    }
    return false
  }

  _readSkillFile(skillState) {
    const path = skillState?.path
    if (typeof path !== 'string' || path.length === 0) return null
    try {
      return readSkillFile(path)
    } catch {
      return null
    }
  }

  _isActionable(proposal) {
    if (proposal === null || typeof proposal !== 'object') return false
    if (typeof proposal.descriptionEdit === 'string' && proposal.descriptionEdit.length > 0) return true
    if (typeof proposal.bodyAddition === 'string' && proposal.bodyAddition.length > 0) return true
    if (typeof proposal.selectionRule === 'string' && proposal.selectionRule.trim().length > 0) return true
    if (Array.isArray(proposal.notes) && proposal.notes.length > 0) return true
    const learned = proposal.learned
    if (learned !== null && typeof learned === 'object') {
      return Object.values(learned).some((list) => Array.isArray(list) && list.length > 0)
    }
    return false
  }

  _dailyBudgetRemaining(dreamCfg, now) {
    const budget = asInt(dreamCfg.dailyTokenBudget, 1000, 2_000_000, 60_000)
    let spentToday = 0
    try {
      const runs = typeof this.store?.recentDreams === 'function'
        ? this.store.recentDreams(this.store?.limits?.dreamRunsMax ?? CAPS.dreamRunsMax)
        : []
      const dayStart = new Date(now)
      dayStart.setHours(0, 0, 0, 0)
      const dayStartMs = dayStart.getTime()
      for (const run of Array.isArray(runs) ? runs : []) {
        if ((run?.startedAt ?? 0) < dayStartMs) continue
        spentToday += (run?.tokens?.in ?? 0) + (run?.tokens?.out ?? 0)
      }
    } catch {
      spentToday = 0
    }
    return Math.max(0, budget - spentToday)
  }

  _dreamMaxTokens(dreamCfg) {
    const override = dreamCfg?.model?.maxTokens
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
      return Math.min(Math.round(override), CAPS.dreamMaxTokens)
    }
    return CAPS.dreamMaxTokens
  }

  _accountTokens(usage, entry, record) {
    const input = Number.isFinite(usage?.inputTokens) ? Math.max(0, Math.round(usage.inputTokens)) : 0
    const output = Number.isFinite(usage?.outputTokens) ? Math.max(0, Math.round(usage.outputTokens)) : 0
    entry.tokens = { in: input, out: output }
    this._runTokens = (this._runTokens ?? 0) + input
    record.tokens = { in: this._runTokens, out: (record.tokens?.out ?? 0) + output }
    this._remainingBudget = Math.max(0, this._remainingBudget - input - output)
    try {
      this.store?.bumpTotals?.({ dreamTokens: input + output })
    } catch {
      // totals are diagnostics; never fatal
    }
  }

  _abortReason(signal) {
    const reason = signal?.reason
    const name = reason instanceof Error ? reason.name : ''
    if (name === 'TimeoutError' || /timeout/i.test(String(reason?.message ?? reason ?? ''))) return 'max-run-ms'
    return 'aborted'
  }

  _isAbortError(error) {
    return error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.aborted === true
  }
}

/**
 * Convenience wrapper matching ARCHITECTURE.md §6. Prefer constructing one `DreamEngine` in
 * `index.js` and calling `engine.run(...)`, because the in-process lock lives on the instance.
 *
 * @param {object} options engine options plus `{ trigger, signal, source, engine }`
 * @returns {Promise<object>} run record
 */
export async function runDream({ engine, ctx, config, store, logger, tracker, isSkillBusy, now, env, home, dataDir, trigger, signal, source } = {}) {
  const instance = engine ?? new DreamEngine({ ctx, config, store, logger, tracker, isSkillBusy, now, env, home, dataDir })
  try {
    return await instance.run({ trigger, signal, source })
  } catch (error) {
    // `run()` already contains everything; this guards the wrapper contract.
    return {
      id: makeId('dream'),
      trigger: trigger === 'manual' ? 'manual' : 'schedule',
      startedAt: Date.now(),
      endedAt: Date.now(),
      status: 'failed',
      mode: 'inline',
      before: null,
      afterEstimate: null,
      cases: 0,
      skills: [],
      tokens: { in: 0, out: 0 },
      error: safeError(error),
    }
  }
}

function safeNow(now) {
  try {
    const value = typeof now === 'function' ? now() : now
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
  } catch {
    return Date.now()
  }
}
