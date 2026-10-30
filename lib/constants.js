/**
 * Shared constants for the Dreaming plugin.
 *
 * Everything here is data, not policy: policy lives in `config.js`, prompts in `prompts.js`.
 * Keep this module dependency-free so every other module (including tests) can import it.
 */

/** Durable data schema version. Bump when a stored field changes meaning. */
export const SCHEMA_VERSION = 1

/** Model-facing tool registered by this plugin. */
export const TOOL_NAME = 'dreaming'

/** The Harness tool the model calls to load a skill; overridable through `config.skillTool`. */
export const SKILL_TOOL = 'skill'

/** Stable prompt-section name (global layer). */
export const SECTION_NAME = 'dreaming:capability-awareness'

/** Directory layout inside the data directory. */
export const LAYOUT = {
  episodes: 'episodes.jsonl',
  state: 'state.json',
  dreams: 'dreams.json',
  edits: 'edits.json',
  backups: 'backups',
  logs: 'logs',
}

/** File names written beside every edited skill by the dream applier. */
export const SKILL_EDIT = {
  beginMarker: '<!-- dreaming:begin -->',
  endMarker: '<!-- dreaming:end -->',
  heading: '## 能力边界（Dreaming · 自动维护）',
  headingEn: '## Capability boundaries (maintained by Dreaming)',
}

/** Hard caps that protect the Harness prompt and the plugin's own memory. */
export const CAPS = {
  promptSectionChars: 1200,
  skillAnnotationChars: 900,
  probeInputChars: 6000,
  judgeInputChars: 9000,
  dreamInputChars: 16000,
  probeMaxTokens: 700,
  // 900 was leaving judge replies truncated: the model's structured verdict (mismatches +
  // recommendation prose) routinely ran to the cap, and two attempts at 900 both failed to parse
  // on 2026-10-28. 1400 keeps one bounded JSON object per attempt and removes that truncation.
  judgeMaxTokens: 1400,
  dreamMaxTokens: 1800,
  fitPointsPerSkill: 60,
  notesPerSkill: 8,
  learnedLinesPerList: 6,
  skillsMax: 400,
  episodesMax: 4000,
  dreamRunsMax: 50,
  editsMax: 500,
  bodyExcerptChars: 2400,
  taskUserGoalChars: 600,
  taskMessageChars: 300,
  traceAssistantChars: 400,
  traceToolItems: 24,
  traceUserItems: 3,
  traceAssistantItems: 4,
  skillBodyCharsForProbe: 1800,
  descriptionMinChars: 40,
  descriptionMaxChars: 500,
  bodySectionMaxChars: 2400,
}

/** Verdict vocabulary shared by the judge, stats and UI. */
export const VERDICTS = ['matched', 'partial', 'missed', 'misapplied']

/** Root causes a dreamer can act on. */
export const ROOT_CAUSES = [
  'description',
  'instructions',
  'selection',
  'user',
  'execution',
  'unknown',
]

/** Skill sources the dream may edit on disk by default. */
export const DEFAULT_EDITABLE_SOURCES = ['user-dsh', 'user-agents']

/** Accepted probe backends. */
export const PROBE_MODES = ['inline', 'subagent']

/** Accepted judge backends. */
export const JUDGE_MODES = ['inline', 'subagent']

/** Accepted dream backends. */
export const DREAM_MODES = ['auto', 'subagent', 'inline']
