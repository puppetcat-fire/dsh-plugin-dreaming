/**
 * Durable, single-process store for capability beliefs, episodes, dream journal and edits.
 *
 * Storage choices (see ARCHITECTURE.md §5):
 * - `episodes.jsonl` is an append-only journal of **full episode snapshots**. The newest
 *   snapshot for an id wins. This keeps finalization O(1) instead of rewriting a large file;
 *   compaction rewrites only the newest snapshot per episode, and is performed at open time.
 * - `state.json`, `dreams.json`, `edits.json` are small JSON documents rewritten atomically.
 * - Every public method is expected to be called from the Host process; synchronous writes are
 *   deliberate: they are small, and a partially recorded episode is worse than a 2 ms pause.
 *
 * Failure posture: disk problems never stop the plugin. `open()` falls back to an in-memory
 * store with `ready === false` so probes/judging can continue and the dashboard can say so.
 */

import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CAPS, LAYOUT, SCHEMA_VERSION } from './constants.js'
import { computeSkillMetrics } from './stats.js'
import {
  appendJsonl,
  atomicWriteJson,
  ensureDir,
  makeId,
  oneLine,
  quarantineFile,
  readJson,
  readJsonl,
  safeError,
  sha256,
} from './util.js'

function emptyState() {
  const now = Date.now()
  return {
    v: SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    totals: {
      episodes: 0,
      judged: 0,
      probeTokens: 0,
      judgeTokens: 0,
      dreamTokens: 0,
      skillLoadTokens: 0,
      wastedTokens: 0,
    },
    skills: {},
    dream: { lastRunAt: 0, lastRunId: null, nextRunAt: 0, consecutiveFailures: 0 },
    runtime: { disabledReason: null },
  }
}

function emptyDreams() {
  return { v: SCHEMA_VERSION, runs: [] }
}

function emptyEdits() {
  return { v: SCHEMA_VERSION, edits: [] }
}

function noopLogger() {
  const noop = () => {}
  return { info: noop, warn: noop, error: noop, debug: noop }
}

function normalizeLoadedState(value) {
  const base = emptyState()
  if (value === null || typeof value !== 'object') return base
  const state = {
    ...base,
    ...value,
    totals: { ...base.totals, ...(value.totals ?? {}) },
    dream: { ...base.dream, ...(value.dream ?? {}) },
    runtime: { ...base.runtime, ...(value.runtime ?? {}) },
    skills: value.skills !== null && typeof value.skills === 'object' ? value.skills : {},
  }
  state.v = SCHEMA_VERSION
  return state
}

export class DreamStore {
  /**
   * @param {object} options
   * @param {string} options.dir resolved data directory
   * @param {object} [options.logger] Cordis logger or compatible
   * @param {() => number} [options.now]
   * @param {object} [options.limits] overrides for CAPS/store config
   */
  constructor({ dir, logger, now = Date.now, limits = {} }) {
    this.dir = dir
    this.logger = logger ?? noopLogger()
    this.now = now
    this.limits = {
      retainDays: limits.retainDays ?? 120,
      maxEpisodes: limits.maxEpisodes ?? CAPS.episodesMax,
      maxSkills: limits.maxSkills ?? CAPS.skillsMax,
      compactBytes: limits.compactBytes ?? 8 * 1024 * 1024,
      dreamRunsMax: limits.dreamRunsMax ?? CAPS.dreamRunsMax,
      editsMax: limits.editsMax ?? CAPS.editsMax,
      mismatchScoreThreshold: limits.mismatchScoreThreshold ?? 78,
    }
    this.ready = false
    this.lastError = null
    this.state = emptyState()
    this.dreams = emptyDreams()
    this.edits = emptyEdits()
    this.episodes = new Map()
    this.revision = 0
    this._appended = 0
    this._opened = false
  }

  /** Files this store owns, for diagnostics and tests. */
  paths() {
    return {
      state: join(this.dir, LAYOUT.state),
      episodes: join(this.dir, LAYOUT.episodes),
      dreams: join(this.dir, LAYOUT.dreams),
      edits: join(this.dir, LAYOUT.edits),
      backups: join(this.dir, LAYOUT.backups),
      logs: join(this.dir, LAYOUT.logs),
    }
  }

  /** Load everything; never throws. Returns `{ ready, error? }`. */
  open() {
    if (this._opened) return { ready: this.ready, error: this.lastError }
    this._opened = true
    try {
      ensureDir(this.dir)
      ensureDir(this.paths().backups)
      ensureDir(this.paths().logs)
      this.state = normalizeLoadedState(this._loadJson(LAYOUT.state, null))
      this.dreams = this._loadJson(LAYOUT.dreams, emptyDreams())
      this.edits = this._loadJson(LAYOUT.edits, emptyEdits())
      if (!Array.isArray(this.dreams.runs)) this.dreams = emptyDreams()
      if (!Array.isArray(this.edits.edits)) this.edits = emptyEdits()
      this._loadEpisodes()
      this._refreshTotals()
      this.ready = true
      this._markStaleEpisodes()
      this._compactEpisodesIfNeeded(true)
      this.prune()
      this.lastError = null
      this.logger.info?.(
        `dreaming: store ready (${Object.keys(this.state.skills).length} skills, ${this.episodes.size} episodes) at ${this.dir}`,
      )
    } catch (error) {
      this.lastError = safeError(error)
      this.ready = false
      this.logger.warn?.(`dreaming: store unavailable, running in memory: ${this.lastError.message}`)
    }
    return { ready: this.ready, error: this.lastError }
  }

  close() {
    try {
      if (this.ready) this.saveState()
    } catch (error) {
      this.logger.warn?.(`dreaming: failed to flush state on close: ${safeError(error).message}`)
    }
    this._opened = false
  }

  /** Health snapshot for the API. */
  health() {
    return {
      ready: this.ready,
      dir: this.dir,
      error: this.lastError,
      episodes: this.episodes.size,
      skills: Object.keys(this.state.skills).length,
      revision: this.revision,
    }
  }

  // ---------------------------------------------------------------------------------------------
  // episodes
  // ---------------------------------------------------------------------------------------------

  /**
   * Record the first snapshot of a new episode.
   * @returns the stored record (same object shape, with `v` added).
   */
  appendEpisode(record) {
    const value = { v: SCHEMA_VERSION, ...record }
    const previous = this.episodes.get(value.id)
    this._writeEpisode(value)
    if (previous === undefined) {
      this.state.totals.episodes += 1
      this._touch()
    }
    // Keep the journal bounded even when no dream ever runs (dream disabled, no mismatched
    // cases, profile used lightly): evict beyond a small hysteresis band, then compact.
    if (this.episodes.size > this.limits.maxEpisodes + Math.max(50, Math.ceil(this.limits.maxEpisodes * 0.25))) {
      try {
        this.prune()
      } catch (error) {
        this.logger.warn?.(`dreaming: episode prune failed: ${safeError(error).message}`)
      }
    } else if (this._appended > this.episodes.size * 3) {
      this._compactEpisodesIfNeeded(false)
    }
    return value
  }

  /**
   * Append a newer snapshot for an existing episode. Shallow merge; nested fields the caller
   * supplies (`judge`, `trace`, `cost`, `flags`, `prediction`, `probe`) replace their old value.
   */
  updateEpisode(id, patch) {
    const current = this.episodes.get(id)
    if (current === undefined) return undefined
    const next = { ...current, ...patch, id, v: SCHEMA_VERSION, updatedAt: this.now() }
    this._writeEpisode(next)
    return next
  }

  getEpisode(id) {
    return this.episodes.get(id)
  }

  /** Newest-first, optionally filtered. */
  recentEpisodes({ limit = 50, verdict = undefined, skill = undefined, mismatchedOnly = false } = {}) {
    const rows = []
    for (const episode of this.episodes.values()) {
      if (skill !== undefined && episode.skill !== skill) continue
      if (verdict !== undefined && episode.judge?.verdict !== verdict) continue
      if (mismatchedOnly && !isMismatch(episode, this.limits.mismatchScoreThreshold)) continue
      rows.push(episode)
    }
    rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    return rows.slice(0, Math.max(0, limit))
  }

  episodesForSkill(skill, limit = 50, { mismatchOnly = false } = {}) {
    return this.recentEpisodes({ limit, skill, mismatchedOnly: mismatchOnly })
  }

  /** All newest snapshots, for dream case selection. */
  allEpisodes() {
    return [...this.episodes.values()]
  }

  // ---------------------------------------------------------------------------------------------
  // skill beliefs
  // ---------------------------------------------------------------------------------------------

  /**
   * Ensure a skill belief exists and refresh the metadata we re-read from the catalog.
   * @returns the skill state
   */
  ensureSkill({ name, meta = {}, editable = false }) {
    if (typeof name !== 'string' || name.length === 0) throw new Error('dreaming: skill name is required')
    let skill = this.state.skills[name]
    if (skill === undefined) {
      skill = {
        name,
        description: meta.description ?? '',
        whenToUse: meta.whenToUse ?? '',
        source: meta.source ?? 'unknown',
        provider: meta.provider ?? 'unknown',
        path: meta.path ?? '',
        resourceBase: meta.resourceBase ?? null,
        editable: Boolean(editable),
        firstSeenAt: this.now(),
        lastUsedAt: 0,
        counts: {
          loads: 0,
          judged: 0,
          matched: 0,
          partial: 0,
          missed: 0,
          misapplied: 0,
          boundaryGaps: 0,
          failed: 0,
        },
        fitHistory: [],
        cost: { probe: 0, judge: 0, skillLoad: 0, wasted: 0 },
        metrics: {
          meanScore: 0,
          fitAccuracy: 0,
          boundaryAccuracy: 0,
          precision: 0,
          consciousness: 0,
          wasteRate: 0,
          trend: 0,
          confidence: 'low',
        },
        learned: {
          whenToUse: [],
          whenNotToUse: [],
          preconditions: [],
          actualScope: [],
          cheaperAlternatives: [],
          knownFailures: [],
          notes: [],
        },
        appliedEdits: [],
      }
    } else {
      if (meta.description !== undefined) skill.description = meta.description
      if (meta.whenToUse !== undefined) skill.whenToUse = meta.whenToUse
      if (meta.source !== undefined) skill.source = meta.source
      if (meta.provider !== undefined) skill.provider = meta.provider
      if (meta.path !== undefined) skill.path = meta.path
      if (meta.resourceBase !== undefined) skill.resourceBase = meta.resourceBase
      skill.editable = Boolean(editable)
    }
    this.state.skills[name] = skill
    return skill
  }

  getSkill(name) {
    return this.state.skills[name]
  }

  allSkills() {
    return Object.values(this.state.skills)
  }

  /** Mutate one skill belief, recompute its metrics, persist. */
  updateSkill(name, mutator) {
    const skill = this.state.skills[name]
    if (skill === undefined) return undefined
    mutator?.(skill)
    skill.metrics = computeSkillMetrics(skill)
    this.state.skills[name] = skill
    this._touch()
    this.saveState()
    return skill
  }

  /** Mutate state and persist. */
  updateState(mutator) {
    mutator?.(this.state)
    this.state.updatedAt = this.now()
    this._touch()
    this.saveState()
    return this.state
  }

  bumpTotals(patch) {
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      this.state.totals[key] = (this.state.totals[key] ?? 0) + value
    }
    this._touch()
  }

  setDreamSchedule({ lastRunAt, lastRunId, nextRunAt, failed }) {
    if (lastRunAt !== undefined) this.state.dream.lastRunAt = lastRunAt
    if (lastRunId !== undefined) this.state.dream.lastRunId = lastRunId
    if (nextRunAt !== undefined) this.state.dream.nextRunAt = nextRunAt
    // Only an explicit boolean changes the failure streak. Re-arming the next occurrence
    // must not silently reset a failure that just happened.
    if (typeof failed === 'boolean') {
      this.state.dream.consecutiveFailures = failed ? (this.state.dream.consecutiveFailures ?? 0) + 1 : 0
    }
    this._touch()
    this.saveState()
  }

  /** Persist the whole state document atomically. */
  saveState() {
    if (!this.ready) return
    this.state.updatedAt = this.now()
    atomicWriteJson(this.paths().state, this.state)
  }

  // ---------------------------------------------------------------------------------------------
  // dreams
  // ---------------------------------------------------------------------------------------------

  appendDream(run) {
    this.dreams.runs.push(run)
    if (this.dreams.runs.length > this.limits.dreamRunsMax) {
      this.dreams.runs.splice(0, this.dreams.runs.length - this.limits.dreamRunsMax)
    }
    this._writeDocument(LAYOUT.dreams, this.dreams)
    return run
  }

  recentDreams(limit = 20) {
    return [...this.dreams.runs].reverse().slice(0, limit)
  }

  getDream(id) {
    return this.dreams.runs.find((run) => run.id === id)
  }

  // ---------------------------------------------------------------------------------------------
  // edits
  // ---------------------------------------------------------------------------------------------

  addEdit(edit) {
    this.edits.edits.push(edit)
    if (this.edits.edits.length > this.limits.editsMax) {
      this.edits.edits.splice(0, this.edits.edits.length - this.limits.editsMax)
    }
    this._writeDocument(LAYOUT.edits, this.edits)
    return edit
  }

  getEdit(id) {
    return this.edits.edits.find((edit) => edit.id === id)
  }

  recentEdits(limit = 100, { skill } = {}) {
    const rows = skill === undefined
      ? this.edits.edits
      : this.edits.edits.filter((edit) => edit.skill === skill)
    return [...rows].reverse().slice(0, limit)
  }

  markEdit(id, status, patch = {}) {
    const edit = this.getEdit(id)
    if (edit === undefined) return undefined
    edit.status = status
    Object.assign(edit, patch)
    this._writeDocument(LAYOUT.edits, this.edits)
    return edit
  }

  /** Register an applied edit on the skill belief and persist state. */
  recordSkillEdit(name, editSummary) {
    const skill = this.state.skills[name]
    if (skill === undefined) return
    skill.appliedEdits = [...(skill.appliedEdits ?? []), editSummary].slice(-20)
    this._touch()
    this.saveState()
  }

  // ---------------------------------------------------------------------------------------------
  // maintenance
  // ---------------------------------------------------------------------------------------------

  /**
   * Drop old episodes and least-recently-used skills. Called on open and after each dream.
   * @returns {{episodes:number, skills:number}}
   */
  prune() {
    const now = this.now()
    const cutoff = now - this.limits.retainDays * 24 * 60 * 60 * 1000
    let removedEpisodes = 0
    for (const [id, episode] of this.episodes) {
      const ended = episode.endedAt ?? episode.startedAt ?? 0
      if (ended < cutoff && episode.state !== 'recording') {
        this.episodes.delete(id)
        removedEpisodes += 1
      }
    }
    if (this.episodes.size > this.limits.maxEpisodes) {
      const ordered = [...this.episodes.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
      for (const episode of ordered.slice(0, this.episodes.size - this.limits.maxEpisodes)) {
        this.episodes.delete(episode.id)
        removedEpisodes += 1
      }
    }
    let removedSkills = 0
    const names = Object.keys(this.state.skills)
    if (names.length > this.limits.maxSkills) {
      const ordered = names
        .map((name) => this.state.skills[name])
        .sort((a, b) => (a.lastUsedAt ?? a.firstSeenAt ?? 0) - (b.lastUsedAt ?? b.firstSeenAt ?? 0))
      for (const skill of ordered.slice(0, names.length - this.limits.maxSkills)) {
        delete this.state.skills[skill.name]
        removedSkills += 1
      }
    }
    if (removedEpisodes > 0 || removedSkills > 0) {
      this._compactEpisodes(true)
      this._touch()
      this.saveState()
      this.logger.info?.(`dreaming: pruned ${removedEpisodes} episodes and ${removedSkills} skills`)
    }
    return { episodes: removedEpisodes, skills: removedSkills }
  }

  // ---------------------------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------------------------

  _touch() {
    this.revision += 1
  }

  _loadJson(name, fallback) {
    const file = join(this.dir, name)
    const result = readJson(file, fallback, (corruptFile) => {
      const saved = quarantineFile(corruptFile, this.paths().logs)
      this.logger.warn?.(`dreaming: ${name} was corrupt; kept a copy at ${saved ?? '(copy failed)'}`)
    })
    if (result.corrupt) {
      try {
        rmSync(file, { force: true })
      } catch {
        // best effort
      }
      return fallback
    }
    return result.value
  }

  _writeDocument(name, value) {
    if (!this.ready) return
    atomicWriteJson(join(this.dir, name), value)
  }

  _writeEpisode(value) {
    this.episodes.set(value.id, value)
    this._appended += 1
    if (this.ready) appendJsonl(this.paths().episodes, value)
    else this.logger.debug?.('dreaming: store not ready; episode kept in memory')
  }

  _loadEpisodes() {
    this.episodes.clear()
    const file = this.paths().episodes
    const { rows, skipped, bytes } = readJsonl(file)
    if (skipped > 0) {
      // Preserve the whole damaged journal (the tail may be truncated by a crash) instead of
      // silently discarding lines; compaction below rewrites a clean file.
      const saved = quarantineFile(file, join(this.dir, LAYOUT.logs))
      this.logger.warn?.(
        `dreaming: skipped ${skipped} corrupt episode journal lines; kept a copy at ${saved ?? '(copy failed)'}`,
      )
    }
    if (bytes > this.limits.compactBytes * 4) {
      this.logger.warn?.('dreaming: episode journal is unexpectedly large; compacting')
    }
    const latest = new Map()
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || typeof row.id !== 'string') continue
      const current = latest.get(row.id)
      if (current === undefined || (row.updatedAt ?? row.startedAt ?? 0) >= (current.updatedAt ?? current.startedAt ?? 0)) {
        latest.set(row.id, row)
      }
    }
    for (const [id, row] of latest) this.episodes.set(id, row)
    this._appended = rows.length
    this._journalBytes = bytes
  }

  /** Episodes left open by a crash/restart are marked abandoned once, with their trace kept. */
  _markStaleEpisodes() {
    const open = [...this.episodes.values()].filter(
      (episode) => episode.state === 'recording' || episode.state === 'observed',
    )
    for (const episode of open) {
      this.updateEpisode(episode.id, {
        state: 'abandoned',
        endedAt: episode.endedAt ?? episode.startedAt ?? this.now(),
        flags: { ...(episode.flags ?? {}), abandoned: true },
      })
    }
  }

  _refreshTotals() {
    // Totals are cumulative counters, not derivable from the retained window after pruning.
    // Keep the persisted values but make sure the numeric slots exist.
    for (const key of ['episodes', 'judged', 'probeTokens', 'judgeTokens', 'dreamTokens', 'skillLoadTokens', 'wastedTokens']) {
      if (typeof this.state.totals[key] !== 'number' || !Number.isFinite(this.state.totals[key])) {
        this.state.totals[key] = 0
      }
    }
  }

  _compactEpisodesIfNeeded(force = false) {
    const should = force
      || this._appended > this.episodes.size * 3
      || (this._journalBytes ?? 0) > this.limits.compactBytes
    if (!should || this.episodes.size === 0) return
    this._compactEpisodes(true)
  }

  _compactEpisodes(force = false) {
    if (!this.ready) return
    const rows = [...this.episodes.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    const text = rows.map((row) => `${JSON.stringify(row)}\n`).join('')
    const file = this.paths().episodes
    try {
      ensureDir(dirname(file))
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmp, text, 'utf8')
      renameSync(tmp, file)
      this._appended = rows.length
      this._journalBytes = Buffer.byteLength(text, 'utf8')
    } catch (error) {
      this.logger.warn?.(`dreaming: episode compaction failed: ${safeError(error).message}`)
    }
  }
}

function isMismatch(episode, scoreThreshold = 78) {
  const verdict = episode?.judge?.verdict
  if (verdict === 'missed' || verdict === 'misapplied') return true
  if (typeof episode?.judge?.score === 'number' && episode.judge.score < scoreThreshold) return true
  if (episode?.judge?.capabilityGap?.present) return true
  return false
}

/** Digest used by the prompt cache to know whether the awareness block changed. */
export function stateDigest(state) {
  const rows = Object.values(state?.skills ?? {})
    .filter((skill) => (skill?.counts?.judged ?? 0) > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => [
      skill.name,
      skill.counts?.judged,
      skill.metrics?.consciousness,
      skill.metrics?.wasteRate,
      (skill.learned?.whenNotToUse ?? []).slice(0, 2).join('|'),
      (skill.learned?.preconditions ?? []).slice(0, 2).join('|'),
    ])
  return sha256(JSON.stringify(rows))
}

/** Read-only raw file access used by tests and the API's backup listing. */
export function readTextFile(file) {
  if (!existsSync(file)) return null
  return readFileSync(file, 'utf8')
}

export { statFileSize }
function statFileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}
