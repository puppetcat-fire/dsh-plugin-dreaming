/**
 * Pure capability-belief math. No I/O, no Harness services, fully unit-testable.
 *
 * Two different questions are deliberately kept apart:
 * - `fitAccuracy` (calibration): how good the agent is at *predicting* whether a skill fits —
 *   the "consciousness strength" component. Computed as 1 − Brier score.
 * - `precision` / `boundaryAccuracy`: how often the skill was actually the right tool and
 *   whether its claimed capability matched its delivered capability.
 *
 * `consciousness` combines them into one 0–100 number. It is a diagnostic, not a reward:
 * a skill with too few samples reports low confidence rather than a fake high score.
 */

import { CAPS } from './constants.js'
import { clamp, estimateTokens, oneLine, truncate } from './util.js'

/** Map a judge verdict to a binary success value used for calibration. */
export const VERDICT_SUCCESS = {
  matched: 1,
  partial: 0.6,
  missed: 0.25,
  misapplied: 0,
}

/** Create the durable belief skeleton for a newly seen skill. */
export function emptySkillState({ name, meta = {}, now = Date.now() }) {
  return {
    name,
    description: meta.description ?? '',
    whenToUse: meta.whenToUse ?? '',
    source: meta.source ?? 'unknown',
    provider: meta.provider ?? 'unknown',
    path: meta.path ?? '',
    resourceBase: meta.resourceBase ?? null,
    editable: false,
    firstSeenAt: now,
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
    metrics: emptyMetrics(),
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
}

export function emptyMetrics() {
  return {
    meanScore: 0,
    fitAccuracy: 0,
    boundaryAccuracy: 0,
    precision: 0,
    consciousness: 0,
    wasteRate: 0,
    trend: 0,
    confidence: 'low',
  }
}

function finite(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function mean(values) {
  const usable = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  return usable.length === 0 ? 0 : usable.reduce((sum, value) => sum + value, 0) / usable.length
}

/**
 * Derived metrics for one skill belief. Pure: the caller owns persistence.
 * @returns the `metrics` object described in ARCHITECTURE.md §5.2.
 */
export function computeSkillMetrics(skill) {
  const counts = skill?.counts ?? {}
  const judged = finite(counts.judged)
  const loads = finite(counts.loads)
  const history = Array.isArray(skill?.fitHistory) ? skill.fitHistory : []
  const calibration = history.filter(
    (point) => typeof point?.fit === 'number' && typeof point?.success === 'number',
  )
  const brier = calibration.length === 0
    ? 0
    : mean(calibration.map((point) => (clamp(point.fit, 0, 1) - clamp(point.success, 0, 1)) ** 2))
  const fitAccuracy = calibration.length === 0 ? 0 : clamp(1 - brier, 0, 1)
  const boundaryAccuracy = judged === 0
    ? 0
    : clamp(1 - finite(counts.boundaryGaps) / judged, 0, 1)
  const precision = judged === 0 ? 0 : clamp(1 - finite(counts.misapplied) / judged, 0, 1)
  const scorePoints = history
    .filter((point) => typeof point?.score === 'number' && Number.isFinite(point.score))
    .map((point) => clamp(point.score, 0, 100))
  const recent = scorePoints.slice(-10)
  const prior = scorePoints.slice(-20, -10)
  const trend = prior.length >= 3 && recent.length >= 3 ? mean(recent) - mean(prior) : 0
  const skillLoad = finite(skill?.cost?.skillLoad)
  const wasted = finite(skill?.cost?.wasted)
  const wasteRate = skillLoad === 0 ? 0 : clamp(wasted / skillLoad, 0, 1)
  const consciousness = judged === 0
    ? 0
    : Math.round(
        100 * clamp(0.45 * fitAccuracy + 0.3 * boundaryAccuracy + 0.25 * precision, 0, 1),
      )
  return {
    meanScore: Math.round(mean(scorePoints) * 10) / 10,
    fitAccuracy: round3(fitAccuracy),
    boundaryAccuracy: round3(boundaryAccuracy),
    precision: round3(precision),
    consciousness,
    wasteRate: round3(wasteRate),
    trend: Math.round(trend * 10) / 10,
    confidence: judged === 0 ? 'low' : judged < 3 ? 'low' : judged < 10 ? 'medium' : 'high',
  }
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}

/** Token estimates for one loaded skill body. */
export function skillLoadTokens(chars) {
  return estimateTokens(Math.max(0, finite(chars)))
}

/**
 * Fold one finished episode into a skill belief. Mutates and returns the same object for
 * cheapness inside the store; callers that need purity should clone first.
 *
 * @param {object} skill - durable skill state (`emptySkillState` shape).
 * @param {object} episode - a judged (or failed) episode record.
 */
export function applyEpisodeToSkill(skill, episode, { now = Date.now() } = {}) {
  const judge = episode?.judge
  const prediction = episode?.prediction
  const counts = (skill.counts ??= emptySkillState({ name: skill.name ?? 'unknown' }).counts)
  counts.loads += 1
  skill.lastUsedAt = episode?.endedAt ?? now
  skill.description = episode?.skillMeta?.description ?? skill.description ?? ''
  if (episode?.skillMeta?.path) skill.path = episode.skillMeta.path
  if (episode?.skillMeta?.source) skill.source = episode.skillMeta.source
  const loadTokens = skillLoadTokens(episode?.skillMeta?.bodyChars ?? episode?.skillMeta?.bodyTokens)
  skill.cost ??= { probe: 0, judge: 0, skillLoad: 0, wasted: 0 }
  skill.cost.skillLoad += loadTokens
  if (episode?.probe?.status === 'ok') skill.cost.probe += finite(episode.probe.tokensIn) + finite(episode.probe.tokensOut)
  if (episode?.judge?.status === 'ok') skill.cost.judge += finite(episode.judge.tokensIn) + finite(episode.judge.tokensOut)

  if (judge?.status === 'ok') {
    counts.judged += 1
    const verdict = judge.verdict
    if (verdict === 'matched') counts.matched += 1
    else if (verdict === 'partial') counts.partial += 1
    else if (verdict === 'missed') counts.missed += 1
    else if (verdict === 'misapplied') counts.misapplied += 1
    if (judge.capabilityGap?.present) counts.boundaryGaps += 1
    const success = typeof judge.score === 'number'
      ? clamp(judge.score / 100, 0, 1)
      : (VERDICT_SUCCESS[verdict] ?? 0.5)
    const fit = typeof prediction?.fit === 'number' ? clamp(prediction.fit, 0, 1) : undefined
    const last = skill.fitHistory.at(-1)
    const signature = `${episode.id}:${judge.score}:${fit}:${success}`
    if (last?.signature !== signature) {
      skill.fitHistory.push({
        t: skill.lastUsedAt,
        episodeId: episode.id,
        score: typeof judge.score === 'number' ? clamp(judge.score, 0, 100) : undefined,
        fit,
        success,
        verdict,
        signature,
      })
      if (skill.fitHistory.length > CAPS.fitPointsPerSkill) {
        skill.fitHistory.splice(0, skill.fitHistory.length - CAPS.fitPointsPerSkill)
      }
    }
    const wasted = finite(episode.cost?.wastedEstimate)
    if (wasted > 0) {
      skill.cost.wasted += wasted
      skill.cost.skillLoad = Math.max(skill.cost.skillLoad, skill.cost.wasted)
    }
  } else if (episode?.state === 'failed') {
    counts.failed += 1
  }

  skill.metrics = computeSkillMetrics(skill)
  return skill
}

/**
 * Count a skill load that produced no judgement (judge disabled, route unavailable, probe
 * skipped with judging off, aborted/failed episode). `applyEpisodeToSkill` owns the judged
 * path; this helper keeps `loads`/`precision`/`wasteRate` honest everywhere else. Exactly one
 * of the two is applied per episode.
 */
export function applyUnjudgedLoadToSkill(skill, episode, { now = Date.now() } = {}) {
  const counts = (skill.counts ??= emptySkillState({ name: skill.name ?? 'unknown' }).counts)
  counts.loads += 1
  if (episode?.state === 'failed' || episode?.state === 'abandoned') counts.failed += 1
  skill.lastUsedAt = episode?.endedAt ?? now
  if (episode?.skillMeta?.description !== undefined) skill.description = episode.skillMeta.description
  if (episode?.skillMeta?.path) skill.path = episode.skillMeta.path
  if (episode?.skillMeta?.source) skill.source = episode.skillMeta.source
  skill.cost ??= { probe: 0, judge: 0, skillLoad: 0, wasted: 0 }
  skill.cost.skillLoad += skillLoadTokens(episode?.skillMeta?.bodyChars ?? episode?.skillMeta?.bodyTokens)
  if (episode?.probe?.status === 'ok') {
    skill.cost.probe += finite(episode.probe.tokensIn) + finite(episode.probe.tokensOut)
  }
  skill.metrics = computeSkillMetrics(skill)
  return skill
}

/** Overall figures: weighted by judged count so a single noisy skill cannot dominate. */
export function computeOverall(state) {
  const skills = Object.values(state?.skills ?? {})
  let weighted = 0
  let weight = 0
  let judged = 0
  let loads = 0
  let waste = 0
  let skillLoad = 0
  let worst = null
  for (const skill of skills) {
    const n = finite(skill?.counts?.judged)
    judged += n
    loads += finite(skill?.counts?.loads)
    waste += finite(skill?.cost?.wasted)
    skillLoad += finite(skill?.cost?.skillLoad)
    if (n > 0) {
      weighted += finite(skill?.metrics?.consciousness) * n
      weight += n
      if (worst === null || finite(skill?.metrics?.consciousness) < finite(worst?.metrics?.consciousness)) {
        worst = skill
      }
    }
  }
  const totals = state?.totals ?? {}
  return {
    consciousness: weight === 0 ? 0 : Math.round(weighted / weight),
    skillsTracked: skills.length,
    skillsJudged: weight,
    episodes: finite(totals.episodes, loads),
    judged,
    loads,
    wasteRate: skillLoad === 0 ? 0 : round3(clamp(waste / skillLoad, 0, 1)),
    wastedTokens: Math.round(waste),
    skillLoadTokens: Math.round(skillLoad),
    probeTokens: Math.round(finite(totals.probeTokens)),
    judgeTokens: Math.round(finite(totals.judgeTokens)),
    dreamTokens: Math.round(finite(totals.dreamTokens)),
    estimatedWasteAvoided: estimateWasteAvoided(state),
    worstSkill: worst?.name ?? null,
    confidence: weight < 3 ? 'low' : weight < 10 ? 'medium' : 'high',
  }
}

/**
 * Counterfactual "waste avoided": for each edited skill, the improvement in precision since
 * the first applied edit, projected onto the average load cost. Always labelled an estimate.
 */
export function estimateWasteAvoided(state) {
  let avoided = 0
  for (const skill of Object.values(state?.skills ?? {})) {
    if (!Array.isArray(skill.appliedEdits) || skill.appliedEdits.length === 0) continue
    const firstEdit = Math.min(...skill.appliedEdits.map((edit) => finite(edit.appliedAt, Infinity)))
    const after = (skill.fitHistory ?? []).filter((point) => finite(point.t, 0) >= firstEdit)
    const before = (skill.fitHistory ?? []).filter((point) => finite(point.t, 0) < firstEdit)
    if (after.length < 2 || before.length < 2) continue
    const avgLoad = finite(skill.cost?.skillLoad) / Math.max(1, finite(skill.counts?.loads))
    const beforeMiss = mean(before.map((point) => 1 - finite(point.success, 0.5)))
    const afterMiss = mean(after.map((point) => 1 - finite(point.success, 0.5)))
    avoided += Math.max(0, beforeMiss - afterMiss) * avgLoad * after.length
  }
  return Math.round(avoided)
}

/** Compact one-line description used by the model-facing `dreaming` tool and the dashboard. */
export function renderSkillLine(skill) {
  const metrics = skill.metrics ?? emptyMetrics()
  const line = `${skill.name}: 意识强度 ${metrics.consciousness}/100, n=${skill.counts?.judged ?? 0}, 浪费率 ${(metrics.wasteRate * 100).toFixed(0)}%`
  const notes = (skill.learned?.whenNotToUse ?? []).slice(0, 1).map((note) => oneLine(note, 90))
  return truncate(notes.length > 0 ? `${line} — 勿用于: ${notes[0]}` : line, 220)
}
