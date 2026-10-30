# Dreaming — architecture and contracts

Status: implementation contract (v1), written against DSH 0.2.1-rc.2 and verified on 0.2.1-rc.3 with the
Web profile. This document is the single source of truth for module boundaries.

Compatibility baseline: extension points and data contracts below were re-verified live on
`0.2.1-rc.3` (2026-10-24). The seven Harness packages this plugin depends on
(`dsh-tools`, `dsh-system-prompt`, `dsh-skill`, `dsh-session`, `dsh-agent`, `dsh-llm`,
`dsh-settings`) are unchanged between `0.2.1-rc.2` and `0.2.1-rc.3`; only `package.json`
versions differ, plus removed build-only `lib/types/*` files.

## 1. What the plugin is for

Agent skills carry a **claimed capability** (name + description + body). The model pays for that claim
twice: once when it loads the skill (the whole body becomes context) and again when the skill turns out
to be the wrong tool and the work is redone. The user's framing:

> Before executing, accurately knowing what it can actually do is *consciousness strength* (意识强度).
> Dreaming exists to raise consciousness strength, so skills get invoked more precisely and tokens are
> not wasted on skills whose semantics merely *look* right.

Therefore dreaming is a **capability-self-model** plugin, not a logging plugin:

1. **Probe** — when a skill is loaded, concurrently ask an independent model what this skill is expected
   to actually deliver for *this specific task*, how likely it is to fit, what it will not deliver, and
   what a cheaper path would be. This is the synchronous "expectation" requirement.
2. **Observe** — record what really happened after the load: did the model follow the skill, did it
   abandon it, did it retry/redo the work, did the user correct it, how many tokens did the load and
   the rework cost.
3. **Judge** — after the turn (or after the observation window), compare expectation with reality and
   produce a score plus concrete, reusable findings (description claim vs. actual behaviour, root cause).
4. **Model** — maintain a durable per-skill *capability belief*: fit history, calibration, boundary
   accuracy, mis-invocation rate, token waste, and a single **意识强度 / consciousness strength** score.
5. **Inject** — before the model uses a skill, give it the cheap truth: historical accuracy + learned
   boundaries; right after the load, annotate the skill result with the probe's expectation and the
   learned "not for / preconditions / cheaper alternative" notes.
6. **Dream** — nightly, offline, revisit the cases where expectation and reality diverged, and *safely*
   improve the skill itself: append a marked capability-boundary section to the body and rewrite the
   frontmatter description so the catalog itself becomes precise. Backups, journal, revert. Skills we
   must not edit (bundled/project/runtime) get a knowledge overlay instead.

The success metric is not "number of skills tracked"; it is **consciousness strength up and wasted
tokens down**. Every design choice below is measured against that.

## 2. Why cheap probes and real dreams

A full child agent per skill call would cost more tokens (preset prompt + tool schemas + multi-step
reasoning) than the skill body it is meant to save. That contradicts the product. So:

- **Probe and judge use `ctx.llm.stream(...)` directly** — one bounded, temperature-low, JSON-only call
  each, no child session, no tools, no history pollution. Typical budget: probe ≤ ~900 output tokens,
  judge ≤ ~1200. The probe's input is a compact, truncated context pack (≤ ~4 k chars).
- **Optional probe backend**: `probe.mode = 'inline' | 'subagent'`. `'inline'` is the default and the
  recommended mode. `'subagent'` starts a real caller-delivery child via `ctx.subagents.startActivation`
  for users who explicitly want an agent-shaped observer; it is documented as more expensive.
- **Dream is inline in v1** (`dream.mode = 'auto' | 'subagent' | 'inline'`): the nightly scheduler runs
  without a guaranteed live parent Agent, so v1 always journals `mode: 'inline'` (truthfully) and logs
  one warning when a subagent mode was requested. The inline dreamer receives the bounded skill file and
  case pack in its prompt — the plugin reads the files itself. The `buildDreamInput`/`validateDream`/
  `streamText` seam is kept so a caller-delivery subagent dreamer can be added without prompt changes.
- Everything is **sampled and budgeted**: per-hour probe cap, concurrent-LLM cap, per-day dream token
  budget, adaptive sampling (always probe skills with known gaps, sample healthy skills).

## 3. Verified Harness extension points (0.2.1-rc.3)

Everything below was confirmed with `cordis_inspect_query` and package-source diffs against the live
Host. Do not substitute guesses; re-confirm with inspection if the runtime version changes.

Re-checked on `0.2.1-rc.2 → 0.2.1-rc.3` (2026-10-24): every extension point in this table is intact.
The plugin's Host packages are byte-identical across the two releases, so a future re-check should
start with the same seven packages whenever DSH changes them.

| Need | API |
|---|---|
| Skill loaded by the model | `ctx.on('tools/pre-execute', (exec, next) => ...)`, `exec.name === 'skill'`, `exec.arguments.name`, `exec.agent`, `exec.callId`, `exec.signal`; **waterfall**; must return `next()` (or a decision) |
| Skill load outcome | `ctx.on('tools/result', (exec, result) => ...)`; `result.isError`, `result.content` |
| Annotate the skill result before the model reads it | `ctx.on('tools/post-execute', (exec, result, next) => ...)`; return `{ kind: 'accept', content: [...] }` to replace content, with a short deadline |
| Observe what happens next | `ctx.on('session/event', (session, event) => ...)`; event types include `turn/start`, `turn/end`, `step/*`, `assistant/message`, `tool/call`, `tool/result`, `user/message`; `session.id`, `session.deriveMessages()`, `session.snapshotEvents()` |
| Prompt injection before skill selection | `ctx.systemPrompt.section({ name, order, text })` (global, number order; scoped registration on an agent context shadows by name) |
| Read a skill | `ctx.skills.get(name, { cwd, scope: agent, signal }) -> { name, description, whenToUse?, content, provider, source, path?, resourceBase? }`; `ctx.skills.list({ cwd, scope }) -> SkillSummary[]` |
| Cheap model call | `ctx.llm.stream({ provider, model, messages, system, temperature, maxTokens, signal })` → `AsyncIterable<StreamChunk>`; collect `text-delta`, optional `reasoning-delta`, `usage`, `finish` |
| Model route of the triggering agent | `session.requestHeader()?.config` (`{provider, model, reasoningEffort?, maxTokens?}`); fallback `ctx.agentDefaultModel.currentSelection()`; fallback plugin config |
| Agent handle | `agent.id`, `agent.session`, `agent.ctx`, `agent.inject(...)`, `agent.followup(...)`, `agent.whenIdle()`, `agent.status` |
| Subagent (optional paths) | `ctx.subagents.startActivation({ provider, label, request: { parent, prompt: ContentBlock[], agentOptions?, maxDepth?, cwd? }, signal, delivery: 'caller' }) -> { childId, result: Promise<{ output, stopReason, structured? }>, dispose }`; local child ids require `provider` with `prepareContinuable` (`spawn`) |
| Durable sessions | `ctx.sessions.get(sessionId)`; `ctx.sessions.list()` |
| HTTP API for the dashboard | `ctx.webServer.register({ kind: 'prefix' | 'exact', path, handler(req, res) })` (`node:http`) |
| Data directory | `process.env.DSH_HOME` (`~/.dsh`) + `/dreaming`; configurable |

Module resolution: the plugin is a profile bundle. Declare every Harness package it imports as a
`peerDependencies` entry with a broad, update-tolerant range (`">=0.2.1-0"` for `@deepseek-ai/dsh-*`;
`"*"` for `@deepseek-ai/cordis`, `@deepseek-ai/schemastery`) so the launcher's peer-aware runtime
resolution serves them from the installation. Keep the import surface deliberately small:
`@deepseek-ai/schemastery` (Config), `@deepseek-ai/dsh-tools` (`defineTool`), `@deepseek-ai/dsh-llm`
(`createUserMessage`, token helpers if needed). Everything else is plain Node.

## 4. Package layout

```
dreaming/
  package.json          # bundle + client manifest, peers, files, exports, icon, locale
  cordis.patch.yml      # inserts the host row (and enables nothing else)
  index.js              # host entry: apply(ctx, config), exports name/inject/Config
  client.js             # Web client plugin: settings dashboard (lazy ModuleLoader factory)
  locale/en.json        # meta + UI strings
  locale/zh.json
  icon.svg
  README.md
  ARCHITECTURE.md
  lib/
    constants.js        # SCHEMA_VERSION, SKILL_TOOL name, limits, defaults
    config.js           # normalizeConfig(raw), validation, exported Config schema (schemastery)
    util.js             # id(), now(), sha256(), atomicWriteJson(), appendJsonl(), tokenEstimate(), truncate(), parseJsonLoose()
    store.js            # durable store: load, append episodes, upsert skill beliefs, dreams, edits, prune
    stats.js            # aggregate(skill episodes) -> SkillStat; consciousness(); overall()
    llm.js              # streamText(ctx, route, req) -> { text, usage, finish }; retries; timeout; route resolution
    prompts.js          # prompt builders + JSON schemas + validators for probe/judge/dream
    probe.js            # runProbe(...) -> prediction record (inline or subagent)
    judge.js            # runJudge(...) -> judgement record
    episode.js          # EpisodeTracker: begin/onResult/collectTrace/finalize, per-session windows
    guidance.js         # per-skill notes: merge dream rules, render prompt section, render skill annotation
    skill-edits.js      # parse SKILL.md, apply description/body edits, backup, revert, verify
    dream.js            # nightly cycle: select cases, build packs, run dreamer, validate, apply
    scheduler.js        # local-time next occurrence, catch-up, jitter, one-shot timer, persisted state
    api.js              # webServer prefix route /dreaming/api/*
  test/
    *.test.mjs          # node:test unit tests (no Harness runtime needed)
```

Modules are split by concern; `index.js` is the wiring layer. Shared types are defined in section 5; a
contract change updates this document first.

## 5. Data contracts (durable, versioned)

All files live under `dataDir` (default `$DSH_HOME/dreaming`). JSON is UTF-8, written atomically
(tmp file + rename), JSONL is append-only with periodic compaction. `SCHEMA_VERSION = 1`.
Unknown/corrupt content must never crash the plugin: log a warning, keep a `.corrupt-<ts>` copy, start a
fresh file.

### 5.1 `episodes.jsonl` — one record per skill load

```jsonc
{
  "v": 1,
  "id": "ep_<time36>_<rand>",
  "sessionId": "...",
  "turn": 3, "step": 1,
  "callId": "...",
  "skill": "office-xlsx",
  "startedAt": 1700000000000,
  "endedAt": 1700000060000,
  "state": "recorded",            // recording | observed | judged | failed | skipped
  "skillMeta": {
    "description": "…", "whenToUse": "…", "source": "user-dsh", "provider": "filesystem",
    "path": "C:\\Users\\…\\SKILL.md", "resourceBase": null,
    "bodyChars": 4200, "bodyTokens": 1200
  },
  "task": {                         // compact context pack sent to the probe
    "userGoal": "…",                // ≤ 600 chars
    "recentUser": ["…"],            // ≤ 3
    "recentAssistant": ["…"],       // ≤ 3, ≤ 300 chars each
    "cwd": "…",
    "messageCount": 12
  },
  "prediction": {                   // null when probe disabled/failed/skipped
    "fit": 0.72, "confidence": 0.6,
    "intent": "…",
    "expectedUse": ["…"],           // ≤ 6
    "successSignals": ["…"],        // ≤ 5
    "likelyPitfalls": ["…"],        // ≤ 4
    "capabilityGap": "…",
    "cheaperAlternative": null,
    "expectedValueTokens": 800
  },
  "probe": { "backend": "inline", "model": "deepseek-account/deepseek-flash", "status": "ok",
             "tokensIn": 1500, "tokensOut": 300, "latencyMs": 2100, "error": null },
  "call": { "isError": false, "durationMs": 40, "contentChars": 4300 },
  "trace": {
    "observedMs": 42000,
    "turnEnd": "completed",         // completed|aborted|error|max-tokens|interrupted|timeout
    "assistantTexts": ["…"],        // ≤ 4, ≤ 400 chars each
    "toolSequence": [ { "name": "read", "ok": true, "brief": "…" } ],   // ≤ 24
    "userMessages": ["…"],          // ≤ 3
    "skillReLoaded": false,
    "finalAnswerChars": 800
  },
  "judge": {
    "status": "ok", "model": "…", "tokensIn": 2200, "tokensOut": 350,
    "score": 78, "verdict": "partial", "predictionAccuracy": 0.55,
    "capabilityGap": { "present": true, "claim": "…", "reality": "…" },
    "mismatches": [ { "expected": "…", "observed": "…", "cause": "…" } ],
    "rootCause": "description", "reusableRule": "…",
    "recommendation": { "descriptionEdit": null, "bodyAddition": "…", "selectionRule": "…" }
  },
  "cost": { "probe": 1800, "judge": 2550, "skillLoad": 1200, "reworkEstimate": 0, "wastedEstimate": 0 },
  "flags": { "sampled": false, "truncated": false, "dreamIds": [] }
}
```

`wastedEstimate` is a conservative estimate set by the judge path: `skillLoad` when the verdict is
`misapplied` or `missed`, plus `reworkEstimate` when the model redid the work (tool sequence contains a
repeated attempt after abandoning the skill). It is used for the dashboard and dream prioritisation only.

### 5.2 `state.json` — capability beliefs and learned knowledge

```jsonc
{
  "v": 1,
  "createdAt": 0, "updatedAt": 0,
  "totals": { "episodes": 0, "judged": 0, "probeTokens": 0, "judgeTokens": 0, "dreamTokens": 0,
              "skillLoadTokens": 0, "wastedTokens": 0 },
  "skills": {
    "office-xlsx": {
      "name": "office-xlsx",
      "description": "…current catalog description…",
      "source": "user-dsh",
      "editable": true,
      "path": "…",
      "firstSeenAt": 0, "lastUsedAt": 0,
      "counts": { "loads": 0, "judged": 0, "matched": 0, "partial": 0, "missed": 0, "misapplied": 0 },
      "fitHistory": [ { "t": 0, "episodeId": "…", "fit": 0.7, "success": 0.78 } ],  // ring, ≤ 60
      "metrics": { "meanScore": 0, "fitAccuracy": 0, "boundaryAccuracy": 0, "precision": 0,
                   "consciousness": 0, "wasteRate": 0, "trend": 0, "confidence": "low|medium|high" },
      "learned": {                       // guidance overlay, capped
        "whenToUse": ["…"], "whenNotToUse": ["…"], "preconditions": ["…"],
        "actualScope": ["…"], "cheaperAlternatives": ["…"], "knownFailures": ["…"],
        "notes": [ { "id": "…", "text": "…", "confidence": 0.7, "evidence": ["ep_…"], "dreamId": "…", "createdAt": 0 } ]
      },
      "appliedEdits": [ { "editId": "…", "dreamId": "…", "kind": "description|body", "appliedAt": 0 } ]
    }
  },
  "dream": { "lastRunAt": 0, "lastRunId": null, "nextRunAt": 0, "consecutiveFailures": 0 },
  "runtime": { "disabledReason": null }
}
```

Caps: 60 fit points per skill, 8 notes per skill, 6 lines per learned list, 400 skills max (LRU prune).
`metrics` is derived, recomputed from the ring + counts on every update (never trusted as input).

### 5.3 `dreams.json` — dream journal

```jsonc
{ "v": 1, "runs": [ {
  "id": "dream_…", "trigger": "schedule|manual", "startedAt": 0, "endedAt": 0,
  "status": "ok|partial|failed|skipped", "mode": "inline|subagent",
  "before": { "consciousness": 62, "episodes": 40, "wastedTokens": 5200 },
  "afterEstimate": { "consciousness": 66, "wastedTokensAvoided": 1800 },
  "cases": 6, "skills": [ { "skill": "…", "caseIds": ["…"], "proposal": {…}, "applied": true,
                            "editIds": ["…"], "error": null } ],
  "tokens": { "in": 0, "out": 0 }, "error": null
} ] }
```

`afterEstimate` is explicitly labelled an estimate: it projects the latest fit trend and the edited
description's boundary coverage; it is never presented as measured. Measured effect appears in
`state.skills[*].metrics.trend` and in the dashboard's pre/post comparison after enough new episodes.

### 5.4 `edits.json` — reversible edits

```jsonc
{ "v": 1, "edits": [ {
  "id": "edit_…", "dreamId": "…", "skill": "…", "kind": "description|body", "path": "…",
  "appliedAt": 0, "before": { "sha256": "…", "text": "…" }, "after": { "sha256": "…" },
  "backupPath": "…", "status": "applied|reverted|superseded|conflict", "revertedAt": null
} ] }
```
Backups: `dataDir/backups/<editId>/SKILL.md` (byte copy). Revert refuses when the current file hash no
longer matches `after.sha256` (manual edits happened) and marks `conflict` instead of clobbering.

## 6. Module contracts

### `config.js`
- `DEFAULTS` — complete default config object (documented in README).
- `normalizeConfig(raw)` → `{ config, warnings }`; never throws for an unknown key (warn), throws for a
  value that cannot be coerced safely (e.g. non-string time). Clamps numeric ranges.
- `ConfigSchema` — schemastery `z.object({...})` matching `DEFAULTS`, used as `export const Config`.
  Built from a dynamic import so a profile without the package still loads; when unavailable the plugin
  validates manually and exports no `Config`.

### `store.js`
- `class DreamStore` constructed with `{ dir, logger, now }`.
- `async open()` → loads `state.json`, `edits.json`, `dreams.json`, prepares dirs, recovers corrupt files.
- `async appendEpisode(record)`; `async updateEpisode(id, patch)` (compaction: rewrite jsonl when > 4× live
  count or > 8 MB).
- `async saveState(mutatorOrState)` — serialized writes; recomputes `updatedAt`.
- `async upsertSkill(name, patchFn)` — applies to `state.skills[name]`, updates totals.
- `async appendDream(run)`; `async addEdit(edit)`; `async markEdit(editId, status)`.
- `async revertEdit(editId, { reason })` — delegates file work to `skill-edits.js`.
- `get episodesFor(skill, limit)` (in-memory index; rebuilt incrementally on append; reads back only the
  needed journal tail), `get recentEpisodes(limit)`, `get skill(name)`.
- `async prune({ retainDays, maxEpisodes, maxSkills })` — called on open and after each dream.
- All public methods are safe to call concurrently (single internal promise queue). Never throws into
  Harness event handlers: errors are logged and returned as `{ ok: false, error }`.

### `stats.js` (pure, no I/O)
- `computeSkillMetrics(skillState, opts)` → `{ meanScore, fitAccuracy, boundaryAccuracy, precision,
  consciousness, wasteRate, trend, confidence }`.
  - `fitAccuracy` = `1 − mean((fit − success)^2)` over points that have both, clamped [0,1];
    `success = judge.score/100` (or binary verdict mapping).
  - `boundaryAccuracy` = `1 − boundaryGapRate` (judge `capabilityGap.present`).
  - `precision` = `1 − misapplied/judged` (0 when nothing is judged; loads are reported separately
    so disabled/failed judging can never inflate precision).
  - `consciousness` = round(100 × (0.45·fitAccuracy + 0.30·boundaryAccuracy + 0.25·precision)).
  - `confidence` = `low` when n<3, `medium` n<10, `high` n≥10.
  - `trend` = mean(last 10 scores) − mean(previous 10 scores), else 0.
- `computeOverall(state)` → totals + weighted consciousness across skills with n≥1 + waste rate.
- `estimateTokens(chars)` lives in `util.js` (`ceil(chars / 3.5)`, CJK-aware enough for budgeting).

### `llm.js`
- `resolveRoute(ctx, session, cfg)` → `{ provider, model, reasoningEffort?, maxTokens? }`; precedence:
  plugin config override → trigger session request header → `agentDefaultModel.currentSelection()` →
  first provider/model advertised by `ctx.llm.listProviders()` + `listModels()`; throws a typed
  `RouteUnavailable` error otherwise.
- `async streamText(ctx, { route, system, messages, temperature, maxTokens, timeoutMs, signal,
  purpose })` → `{ text, usage: { inputTokens, outputTokens }, finish, latencyMs }`.
  Uses `ctx.llm.stream`, collects `text-delta`, ignores `reasoning-delta` unless `includeReasoning`,
  rejects on `finish.reason.kind` `error`/`aborted`, enforces an `AbortController` timeout that composes
  with the caller signal. One retry on a retryable adapter error (network/timeout), never on abort.
- Never logs prompt content above `debug`; logs sizes and durations.

### `prompts.js`
- `buildProbeInput({ skillMeta, task, learned, config })` → `{ system, messages }`. System explains the
  role: precise capability auditor; output strict JSON matching schema; no markdown fences; if unsure,
  lower confidence. User message contains compact `<skill>` (name, description, whenToUse, body excerpt
  ≤ 1800 chars), `<task>` pack, `<learned>` overlay notes, `<recent>` conversation snippets.
- `PROBE_SCHEMA` / `JUDGE_SCHEMA` / `DREAM_SCHEMA` as hand-written JSON-schema-like descriptors used by
  `validateProbe(value)` etc.; validators coerce and clamp, drop unknown keys, and return
  `{ value, issues }`.
- `buildJudgeInput({ episode, traceText, config })`; `buildDreamInput({ skillState, cases, skillFile })`.
- `parseJsonLoose(text)` in `util.js` handles ```json fences, leading prose, and trailing commas; when
  parsing fails return `null` (caller treats as a failed probe/judge, never retries in a loop).

### `probe.js`
- `async probeSkill({ ctx, config, store, episode, session })` → updates `episode.prediction` and
  `episode.probe`; honors sampling, per-hour cap, concurrency cap, and cancellation.
- `backend: 'inline'`: one `streamText` call (≤ `probe.maxTokens`), one attempt, `temperature: 0.2`.
- `backend: 'subagent'`: `ctx.subagents.startActivation` with `provider` from config, `parent` from the
  triggering agent, `delivery: 'caller'`, prompt = `buildProbeInput` rendered as one text block, then
  `await activation.result` with a timeout and `await activation.dispose()` in `finally`. Parse the
  final assistant text as JSON. If `subagents` is unavailable, fall back to inline.
- Attaches a promise to `episode._probePromise` so `tools/post-execute` can race it against a short
  deadline. Never rejects to the caller; failures set `probe.status` and leave `prediction = null`.

### `judge.js`
- `async judgeEpisode({ ctx, config, store, episode, session })` → fills `episode.judge` and `cost`;
  no-op when `judge.enabled` is false or the episode has no prediction and `judge.judgeWithoutProbe` is
  false. Reads the trace collected by `episode.js` (never re-reads a closed session).
- One `streamText` call, `temperature: 0.1`. Validates with `validateJudge`; on invalid JSON retries once
  with a "return only JSON" reminder, then records `judge.status = 'invalid'`.
- Sets `episode.state = 'judged'`, appends the update, and calls `stats`/`guidance` through the store.

### `episode.js`
- `class EpisodeTracker` owns in-memory open episodes keyed by `callId` and a per-session window map.
  - `begin({ exec, sessionId })` → creates the record, resolves skill metadata via `ctx.skills.get`,
    snapshots the task pack from `session.deriveMessages()` (bounded), starts the probe (fire-and-
    forget, promise stored), and schedules the observation window.
  - `onToolResult({ exec, result, session })` → records the load outcome and cancels the "never loaded"
    timer.
  - `onSessionEvent(session, event)` → appends to each open window of that session: assistant text,
    tool call/result summaries, user messages, turn end. Stops on `turn/end` of the same turn or on
    `observe.maxTurnExtensionMs`/`maxEvents` (then `judge.turnEnd = 'timeout'`).
  - `finalize(episode)` → freezes trace, calls judge, persists, updates skill beliefs and guidance,
    removes window. All failures are logged and mark the episode `failed`; they never throw into the
    Harness event loop.
  - A small queue bounds concurrent probes and judges (`run.maxConcurrent`, default 2). Episodes that
    are still open at process shutdown are flushed as `failed` on the next `open()` (they remain
    `recording` in the journal; the loader marks stale ones `abandoned`).
- Per-session observation windows must be removed on `session/disposed`/`agent/disposed` to avoid leaks.

### `guidance.js`
- Pure rendering + merge:
  - `mergeLearnings(skillState, findings, { maxNotes, maxLines })` dedupes by normalized text and
    confidence, keeps newest, caps.
  - `renderPromptSection(overall, skills, config)` → the compact "capability awareness" block or `''`.
    Only skills with `judged ≥ 2` and (consciousness < 85 or wasteRate > 0.1), sorted by usage; cap
    `prompt.maxSkills`; each line ≤ 160 chars; overall line first. Includes a disclaimer that these are
    observed tendencies, not instructions that override the skill.
  - `renderSkillAnnotation({ skillState, prediction })` → the block appended to the skill tool result:
    historical fit/awareness + probe expectation (fit, expected use, pitfalls, cheaper alternative) +
    learned "not for" / preconditions. Hard cap 900 chars (`prompt.annotationMaxChars`, clamped).
- `installPromptSection(ctx, ...)` in `index.js` registers `ctx.systemPrompt.section({ name:
  'dreaming:capability-awareness', order: 900, text: () => cache })`; the cache is rebuilt at most
  every `prompt.refreshMinutes` (default 10) and immediately after a dream or a revert. Ordinary
  per-episode metric drift deliberately waits for the TTL so the global prompt prefix stays stable
  for KV-cache reuse; the digest is logged, not used to force rebuilds. Text must be empty when
  there is nothing useful (no cost for new users). The callback is synchronous.
- The section text is global; it is intentionally small and stable to limit KV-cache churn. It is
  suppressed inside dreamer subagents by checking `agent` context where possible; where not possible the
  text is simply omitted for processes whose store is empty.

### `skill-edits.js`
- `parseSkillMarkdown(text)` → `{ frontmatterRaw, frontmatter: Map-ish parsed subset, body, eol }`.
  Supports `---` frontmatter with simple `key: value`, quoted values, and block scalars. Never rewrites
  unrelated frontmatter.
- `readSkillFile(path)` / `sha256File(path)`.
- `planDescriptionEdit(currentText, newDescription)` → `{ ok, newText, before, after } | { ok:false, reason }`.
  Only touches the `description` value; preserves quoting style; rejects when the description cannot be
  located unambiguously. New description must be 40–500 chars, single paragraph, and contain the
  original capability claim (no silent capability removal) unless the dream proposal carries
  `removeClaim: true` with evidence.
- `planBodySectionEdit(currentText, sectionMarkdown)` → uses markers
  `<!-- dreaming:begin -->` / `<!-- dreaming:end -->`; replaces an existing marked block or appends one;
  never edits above the markers. Section ≤ 2400 chars.
- `async applyEditPlan({ plan, edit, dataDir })` → backup original to `dataDir/backups/<editId>/SKILL.md`,
  write atomically with original EOL, verify re-parse and sha256, return the edit record.
- `async revertEdit({ edit, dataDir, currentText })` → restores the backup only if the current hash
  matches `after.sha256`; otherwise returns `{ ok:false, reason:'conflict' }`.
- Editable sources: config `dream.editableSources` (default `['user-dsh','user-agents']`) and only when
  `path` is inside the user skills roots (`$DSH_HOME/skills`, `~/.agents/skills`) — resolved texts are
  compared with `path.resolve`, never by prefix string. Project, bundled, runtime and custom sources are
  never edited; they receive guidance notes only.

### `dream.js`
- `async runDream({ ctx, config, store, trigger, signal })`:
  1. skip when a run is already active (in-process lock) or the profile is unhealthy;
  2. select cases: episodes from the last `dream.caseWindowDays` (7) with `judge.score <
     dream.scoreThreshold` or `misapplied`/`missed`, grouped by skill, newest first, at most
     `dream.maxSkillsPerRun` skills and `dream.maxCasesPerSkill` cases each; skip skills with no new cases;
  3. build a dream pack per skill: current file text (bounded), current description, learned notes,
     compact cases (prediction + trace + judge, truncated);
  4. run the dreamer (`dream.mode`), one call per skill, sequential with `dream.maxConcurrent`;
     validate `DREAM_SCHEMA`; reject proposals whose description is longer than 500 chars, whose edits
     cannot be located, or whose confidence is under `dream.minProposalConfidence`;
  5. apply: description edit then body section edit (each independently), only for editable skills and
     only when `dream.autoApply`; otherwise record `status: 'suggested'` in the journal for the UI;
  6. merge `rules`/`learned` into the guidance overlay for every skill (editable or not);
  7. write the dream run with measured `before` and clearly labelled `afterEstimate`;
  8. update `state.dream.nextRunAt`; emit nothing model-facing (the prompt section refreshes by digest).
- Token budget: `dream.dailyTokenBudget` (default 60k); abort remaining skills when exhausted, record
  `status: 'partial'`.
- Candidate model route: `dream.model` override, else same resolution as probes.
- Never edits a skill while a skill tool call for that skill is in flight (checks the tracker).
- Every proposal, including rejected ones, is journaled with its rejection reason for review.

### `scheduler.js`
- `computeNextRun({ time: 'HH:MM', timeZone, from, catchUpHours })` → epoch ms, DST-safe by using
  `Intl.DateTimeFormat` to resolve wall-clock time in the configured zone (default: process zone).
- `class DreamScheduler` owns one disposable timer, never uses `setInterval`; after each run it
  recomputes the next occurrence. Catch-up: if `now` is within `catchUpHours` after the last scheduled
  occurrence and that occurrence was never run, run once shortly after boot (jitter 0–120 s) instead of
  waiting a day. Persists `state.dream.nextRunAt`; respects `dream.enabled`.
- All timers are cleared in the plugin effect disposer; the scheduler reports `{ nextRunAt }` for the UI.
- A missed run is not replayed after `catchUpHours`; it is skipped and journaled.

### `api.js`
- Registers `ctx.webServer.register({ kind: 'prefix', path: '/dreaming/api/', handler })`.
- Routes (GET unless noted):
  - `GET summary` → `{ overall, skills: [...], dream: {...}, config: sanitized, dataDir, generatedAt }`
  - `GET episodes?skill=&limit=&offset=&verdict=` → compact records
  - `GET dreams?limit=` → journal
  - `GET edits?skill=` → edit journal with backup availability
  - `POST dream/run` → starts a manual dream (returns `{ accepted: true, runId }`; `runId` may be
    `null` because the run id is minted inside the asynchronous engine — correlate through the next
    journal refresh; 409 when a run is already active)
  - `POST edits/revert` `{ editId }` → `{ ok, reason? }`
  - `GET health` → `{ ok, storeReady, nextRunAt, openEpisodes, lastError }`
- JSON responses with `Cache-Control: no-store`; body size limit 64 KiB; only `GET`/`POST`; reject
  mutation when `Origin` is present and does not match the webServer origin (CSRF guard); never expose
  file contents outside the journal, and never expose the raw config secrets (there are none).
- All handlers catch and answer 500 with `{ ok:false, error }`; never throw into the HTTP layer.

### `index.js` (wiring)
- `export const name = 'dreaming'`, `export const inject = ['tools', 'systemPrompt', 'skills', 'llm',
  'sessions', 'agents']` (only services that must exist); optional services are reached with
  `ctx.get(...)` and degrade.
- `export const Config = ConfigSchema` (when available).
- `apply(ctx, rawConfig)`:
  1. normalize config, create `DreamStore`, `await store.open()`;
  2. create `EpisodeTracker`, `DreamScheduler`, `Guidance` cache;
  3. register listeners: `tools/pre-execute`, `tools/post-execute`, `tools/result`, `session/event`,
     `agent/disposed`, `session/disposed`;
  4. register the prompt section (guidance);
  5. register the `dreaming` model-facing tool (query stats / trigger dream / list gaps).
     `ToolRuntime.register()` sends `parameters` and `output.schema` verbatim to the provider
     and validates them with `assertSupportedJsonSchema`, so the definition uses the **raw wire
     schema** shape (`{ type: 'object', properties, required: [...], additionalProperties: false }`),
     not the `defineTool` DSL (whose property-level `required: true` is converted only by
     `defineTool` and is rejected by the raw checker);
  6. `ctx.inject(['webServer'], ...)` → `installApi`; `ctx.inject(['settings'], ...)` → expose the plugin
     Config form (`settings.configure({ auto: true })`) when the service exists;
  7. schedule the nightly dream; flush/close on effect disposal (await store.flush, clear timers, abort
     active LLM calls);
  8. every async callback is wrapped so a rejection can never become an unhandled rejection (which is
     fatal to the Harness process) — this is a hard requirement.
- The `dreaming` tool schema (model-facing):
  `name: 'dreaming'`, parameters `{ action: 'status'|'gaps'|'dream', limit?: number }`, read-only except
  `dream` (which asks for confirmation through the tool result text when `autoApply` is on? No — the
  model may trigger a dream; it is bounded and journaled). Output: compact text summary + JSON value.
  Description must state that it reports the measured capability awareness of skills and can run a
  bounded dream pass; keep it short.

## 7. Model-facing token budget

Hard caps enforced by code:

| Surface | Cap | Rationale |
|---|---|---|
| Awareness prompt section | 1200 chars, ≤ 8 skill lines | ≈ 300 tokens/request worst case; only rendered when useful |
| Skill-result annotation | 900 chars (`prompt.annotationMaxChars` is clamped to this) | ≈ 220 tokens, only on skill loads |
| Probe input | 6000 chars | ≈ 1500 tokens, sampled |
| Probe output | 700 tokens | one JSON object |
| Judge input | 9000 chars | ≈ 2200 tokens, once per loaded skill |
| Judge output | 1400 tokens | one JSON object; 900 truncated real verdicts |
| Dream input | 16000 chars/skill | nightly, budgeted |
| Dream output | 1800 tokens/skill | nightly, budgeted |

The dashboard reports probe+judge spend against estimated waste avoided, so the plugin is honest about
its own cost. `probe.sampleRate` (default 1.0), `probe.alwaysForGapSkills` and per-hour caps keep the
cost bounded; the README explains the break-even rule.

## 8. Dashboard (client.js)

- Registers one page in the `settings.section` slot: label "Dreaming · 意识强度", order 95.
- Sections: overview cards (consciousness, judged episodes, waste rate, tokens spent/avoided, next
  dream), skills table (name, loads, consciousness bar, fit accuracy, boundary accuracy, waste, trend,
  last used, applied edits), episode inspector (expandable; prediction vs. trace vs. judge), dream
  journal (run status, proposals, applied/suggested, revert button), and a "Dream now" action.
- Data only from `/dreaming/api/*`; no direct DOM writes, no host client packages imported; plain
  `React.createElement`; theme tokens only (`var(--dsw-alias-*)`); light/dark correct; all strings from
  the client locale (`ctx.locale`) with `en`/`zh` dictionaries.
- Polling: fetch on mount + on a 30 s interval only while the page is visible; mutations refresh
  immediately. Errors render an inline retry row, never a blank page.
- Zero crashes: every render path guards missing/partial data; a failed fetch shows a diagnostic.

## 9. Testing and verification

1. **Unit tests** (`node --test test/*.test.mjs`, no Harness runtime): config normalization and clamps,
   stats/consciousness math (fixtures), prompt builders and validators (adversarial JSON), JSONL store
   append/compaction/corruption recovery in a temp dir, skill-edit plan/apply/revert including conflict
   and frontmatter variants, scheduler next-run/DST/catch-up, dream case selection and proposal
   validation, api handlers with a fake req/res and CSRF rejection.
2. **Manifest checks**: `node --check` every JS file; parse `package.json` and `cordis.patch.yml`;
   verify every file in `files` exists; verify icon is a valid SVG; locale JSON parses.
3. **Live installation**: `plugin_manager install_bundle` with the absolute package directory; read
   `application`/`warnings`; `cordis_inspect_query` `Config.listConfigs` to confirm the row and schema;
   confirm the plugin entry is active; check the Harness log for import/activation errors.
4. **End-to-end**: in the live profile, trigger a real `skill` call (a subagent instructed to load a
   known skill) while the plugin is active; verify an episode appears in `episodes.jsonl` with probe and
   judge records; verify the skill tool result contains the annotation; then trigger a manual dream via
   the `dreaming` tool or the API and verify journal + backup behavior (with `dream.autoApply` enabled on
   a disposable copy of a user skill; never mutate a real skill during testing without a backup and a
   revert).
5. **Non-interference**: run a normal turn; confirm no unhandled rejections, no visible latency over the
   configured deadline, no session events added by the plugin (the plugin only appends via the skill
   result annotation, which replaces content), and that disabling the plugin removes the section and
   listeners.
6. **Independent review**: a reviewer reads the code against this document, checks for unhandled
   rejections, unbounded memory/timer leaks, and prompt-injection/token-budget violations, and reports
   without editing production modules.

## 10. Module layout

| Area | Files | Notes |
|---|---|---|
| Host wiring, config, durability, metrics | `index.js`, `lib/constants.js`, `lib/config.js`, `lib/util.js`, `lib/store.js`, `lib/stats.js` | wiring, durability, metrics |
| Probe and judge | `lib/llm.js`, `lib/prompts.js`, `lib/probe.js`, `lib/judge.js`, `lib/episode.js`, `test/probe.test.mjs`, `test/judge.test.mjs` | no session clutter, bounded prompts |
| Dream, guidance and edits | `lib/guidance.js`, `lib/skill-edits.js`, `lib/dream.js`, `lib/scheduler.js`, `test/guidance.test.mjs`, `test/skill-edits.test.mjs`, `test/dream.test.mjs`, `test/scheduler.test.mjs` | safe edits, backups, revert |
| API and dashboard | `lib/api.js`, `client.js`, `locale/*.json`, `icon.svg`, `test/api.test.mjs` | host route + settings page |
| Tests and docs | `test/*.test.mjs`, `README.md`, `README.zh.md`, `ARCHITECTURE.md` | `node:test`, no new dependencies |

Contract changes update this document first. Tests live beside the module they cover; use only
`node:test` and `node:assert`, no new dependencies.

## 11. Failure posture (non-negotiable)

- A dreaming failure must never fail a skill call, a turn, or the Harness process. Every listener
  returns quickly, catches internally, and logs at `warn`.
- No unhandled rejections: every fire-and-forget promise gets `.catch(...)`; timers are owned and cleared.
- The store is best-effort: if the disk is unavailable, the plugin keeps running in memory and reports
  `storeReady: false` in the API/health.
- Skill edits are the only writes outside the data directory, always backed up, always hashed, always
  revertible, and never touch sources outside the configured user-skill roots.
- Probe/judge/dream calls are bounded by timeout + AbortController and never use `ctx.llm.stream` with
  an unbounded prompt; truncation happens before the call, not after.
