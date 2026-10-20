# Dreaming · consciousness strength

[中文](README.zh.md) | English

> Knowing what a skill can actually do *before* you execute it — that is **consciousness strength**. Dreaming raises it by measuring every skill call and correcting skill boundaries overnight, so skills are invoked precisely and tokens are not wasted on descriptions that merely *look* right.

Dreaming is a global DeepSeek Harness plugin (Host plugin + Web panel). It is not a logging plugin; it is a **capability self-model**:

- every skill load is **concurrently probed** with a cheap model call that predicts what the skill can really deliver for this task;
- what actually happened after the load is recorded (did the model follow the skill, abandon it, redo the work, how many tokens did it cost);
- at the end of the turn a **judge** compares expectation with reality and extracts reusable rules;
- each skill keeps a durable **capability belief** and a single consciousness score;
- the measured truth is injected before use (historical accuracy, boundaries, cheaper alternatives);
- a **nightly dream** revisits mismatches and safely edits skill descriptions and boundary sections (backups, journal, revertible), improving precision at the source.

## Why it exists

A skill description is a *claim*. Claims and reality often disagree:

- the description promises X, the body only covers a subset of X;
- the description is too broad, so the model loads it when it should not, and the whole body becomes context cost;
- the description is too narrow, so the model bypasses the skill and redoes the work, wasting more tokens;
- the same task keeps misusing the same skill, and nothing writes that lesson back into the description.

Dreaming closes the loop: **measure → judge → write the boundary back → measure again**. The metric is rising consciousness and falling wasted tokens, not the number of log lines.

## How it works

```
                    ┌──────────── every skill call ────────────┐
user/agent ── skill ─┤ tools/pre-execute                        │
                    │   ├─ record the task context (truncated)  │
                    │   └─ concurrent probe: a cheap LLM call   │
                    │        predicting fit / expected use /    │
                    │        pitfalls / capability gap          │
                    ├─ tools/result: record the skill body and │
                    │   the load outcome                        │
                    ├─ tools/post-execute: append measured     │
                    │   history + prediction + learned          │
                    │   boundaries to the skill result          │
                    ├─ session/event: observe later assistant/ │
                    │   tool/user events until turn end         │
                    └─ judge: expectation vs reality → score / │
                               root cause / reusable rules     │
                                    │
                     ┌──────────────┴──────────────┐
                     │ capability belief per skill  │
                     │ consciousness / calibration  │
                     │ boundary accuracy / waste    │
                     └──────────────┬──────────────┘
                                    │
              global awareness section in the system prompt
              + annotation appended to the skill result
                                    │
                         ┌──────────┴──────────┐
                         │ nightly dream (timer)│
                         │ pick mismatches →    │
                         │ reflect → edit the   │
                         │ description/boundary │
                         │ → backup + journal + │
                         │ revert               │
                         └─────────────────────┘
```

### 1. Probe — predict at load time

Inside `tools/pre-execute` the plugin registers an episode before the skill runs and starts a budgeted LLM call concurrently (default `probe.mode = 'inline'`; it uses `ctx.llm.stream` directly and does not create a sub-session or pollute the conversation). The probe returns a structured prediction:

- `fit` (0–1): whether and how well the skill fits this task;
- `expected_use`: the concrete steps the model is expected to take;
- `success_signals`: what using it correctly would look like;
- `likely_pitfalls`: the most likely traps;
- `capability_gap`: a capability the task needs that the skill may not actually provide;
- `cheaper_alternative`: a cheaper path when the skill is not needed.

> Why not a sub-agent by default: a full sub-agent's fixed prompt + tool schemas + multi-step reasoning usually costs more than the skill body it is meant to save. The probe is a single, low-temperature, structured, sampled call. `probe.mode = 'subagent'` remains available for cases that genuinely need an agent-shaped observer.

### 2. Observe the real outcome

`tools/result` records the skill load; `session/event` collects a bounded trace from the load point: assistant text, tool-call sequence (name/outcome/summary), user corrections, and the `turn/end` reason. The window closes at the same turn's `turn/end`, or after `observe.maxTurnExtensionMs` / `observe.maxEvents`. Closed sessions are never read again and the window does not stay in memory.

### 3. Judge — expectation vs reality

After the turn, one cheap judge call produces:

- `score` (0–100) and `verdict` (`matched` / `partial` / `missed` / `misapplied`);
- `predictionAccuracy`: agreement between prediction and reality;
- `capabilityGap`: difference between what the description claims and what was delivered;
- `mismatches`, `rootCause` (`description` / `instructions` / `selection` / `user` / `execution`);
- `reusableRule`: a rule that can be reused next time;
- `cost.wastedEstimate`: a conservative estimate of wasted tokens.

### 4. Capability belief and consciousness

Each skill keeps a belief: load count, verdict distribution, fit history, cost, learned boundaries. Core metrics:

| Metric | Definition | Question it answers |
|---|---|---|
| `fitAccuracy` | `1 − Brier score` (predicted fit vs. actual success) | Does it predict *itself* accurately? |
| `boundaryAccuracy` | `1 − share of judged calls with a capability gap` | Is its stated boundary accurate? |
| `precision` | `1 − misapplied / judged` (judged calls only) | When it was called, was it on topic? |
| `consciousness` | `100 × (0.45·fitAccuracy + 0.30·boundaryAccuracy + 0.25·precision)` | The combined consciousness score |
| `wasteRate` | wasted tokens / loaded skill tokens | How much did it waste? |
| `confidence` | `<3 / <10 / ≥10 judged` → low / medium / high | How trustworthy is the score? |

> No fake high score with few samples: `confidence = low` is reported, and both the panel and the model-facing text say so.

### 5. Injection — give the truth before use

- **A global system-prompt section**, `Dreaming · capability awareness`, appears only when there is enough evidence, at most `prompt.maxSkills` lines, explicitly marked as observed tendency and not overriding the skill's own instructions.
- **Skill-result annotation**: after a skill loads, up to `prompt.annotationMaxChars` characters are appended to the result:
  - the skill's measured fit accuracy / consciousness / waste rate;
  - this call's predicted use, pitfalls and cheaper alternative (when the probe finishes inside `probe.attachDeadlineMs`);
  - the learned “not for / preconditions”.

The model sees this after reading the skill body and before acting, so it can adjust immediately.

### 6. Dream — correct the capability description overnight

`dream.time` (default `03:30`, local time zone, configurable IANA zone) triggers a run; catch-up and jitter are supported. Each run:

1. selects recent (within `caseWindowDays`) `missed` / `misapplied` / low-score cases, grouped by skill (at most `maxCasesPerSkill` cases per skill, `maxSkillsPerRun` skills per run);
2. builds a bounded dream pack: the current skill file, the current description, learned boundaries, compressed cases;
3. asks the dreamer for a structured proposal: a `description` edit, a `body` capability-boundary section, reusable rules, confidence;
4. applies **deterministic validation**: description length / locatability / confidence threshold / removal of existing claims — any failure turns the proposal into a suggestion only;
5. applies safely: only to user-level skills inside `dream.editableSources` (default `user-dsh`, `user-agents`), path-checked against the user skill roots (`realpath`), backup first, atomic replace, sha256 verified;
6. merges the rules into the skill's guidance overlay (this also improves skills that cannot be edited);
7. writes the dream journal, including rejected proposals and reasons, and shows `before` together with an explicitly estimated `afterEstimate`.

Body edits use markers so repeated dreams only replace the block between them and never rewrite your hand-written body or other frontmatter:

```markdown
<!-- dreaming:begin -->
## Capability boundaries (Dreaming · auto-maintained)
...
<!-- dreaming:end -->
```

## Install

Requires DSH ≥ 0.2.1-0 (see `engines.dsh`).

Install from this Git repository (the plugin is distributed from GitHub; npm publishing is planned).

In the Harness **Plugins** page, paste the repository URL:

```
https://github.com/puppetcat-fire/dsh-plugin-dreaming
```

or from the CLI for a profile:

```sh
dsh plugin --profile <profile> add git+https://github.com/puppetcat-fire/dsh-plugin-dreaming.git
```

A profile-level bundle takes effect for all sessions and survives restarts. Remove it from the Plugins page, or with `plugin_manager(action="remove_bundle", target="dsh-plugin-dreaming")`.

> Runtime packages (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/schemastery`, `@deepseek-ai/cordis`) are provided by Harness; they are declared as `peerDependencies` and need no separate install.

## Configuration

All configuration lives in the profile's `cordis.patch.yml` (or a home patch). The plugin exports no editable volatile fields, so Settings shows no generic form; Settings → Dreaming is a read-only observability page. Defaults are defined in `lib/config.js`. The most useful keys:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `dataDir` | `''` | Data directory; empty = `$DSH_HOME/dreaming` |
| `probe.enabled` | `true` | Predict on skill load |
| `probe.mode` | `'inline'` | `inline` (recommended, cheap) or `subagent` |
| `probe.sampleRate` | `1` | Sampling rate; known-gap skills are always probed |
| `probe.attachDeadlineMs` | `1500` | How long the skill result waits for the probe; on timeout only history is attached |
| `probe.maxPerHour` | `120` | Hourly probe cap |
| `judge.enabled` | `true` | Judge after the turn |
| `observe.maxTurnExtensionMs` | `600000` | Hard cap on the observation window |
| `prompt.awarenessSection` | `true` | Inject the global awareness section |
| `prompt.annotateSkillResult` | `true` | Annotate the skill result |
| `prompt.refreshMinutes` | `10` | Minimum refresh interval for the global section (KV-cache friendly) |
| `dream.enabled` | `true` | Nightly dream |
| `dream.time` | `'03:30'` | Local wall-clock time HH:MM |
| `dream.timeZone` | `''` | IANA zone; empty uses the process zone |
| `dream.scoreThreshold` | `78` | Below this score a judged episode is a mismatch case |
| `dream.autoApply` | `false` | `false` records suggestions only; `true` applies validated edits with backup and revert |
| `dream.editableSources` | `['user-dsh','user-agents']` | Skill sources that may be edited on disk |
| `dream.dailyTokenBudget` | `60000` | Daily dream token budget |
| `run.maxConcurrent` | `2` | Concurrent probe/judge calls |
| `store.retainDays` | `120` | Episode retention |
| `store.maxEpisodes` | `4000` | Episode cap |

Example (probe office skills only and opt into automatic edits):

```yaml
- id: dreaming
  config:
    probe:
      sampleRate: 0.5
      attachDeadlineMs: 1200
    dream:
      time: '04:10'
      timeZone: Asia/Shanghai
      autoApply: true
```

## Panel

Settings → **Dreaming · consciousness strength** (`settings.section`, order 95):

- overview: consciousness, judged calls, waste rate, probe/judge spend, estimated waste avoided, next dream time;
- skills table: loads, self-knowledge, fit accuracy, boundary accuracy, precision, waste rate, trend, last used, applied edits;
- recent calls: prediction vs. trace vs. judgement, expandable;
- dream journal: run status, proposals (applied / suggested / rejected), revert button;
- **Dream now** button.

The panel only reads `/dreaming/api/*` (a Host prefix route: JSON only, Origin check on POST, request-size limit). Every write goes through the same revert path as the dream engine.

## Data and privacy

- Data directory: `$DSH_HOME/dreaming/` (`episodes.jsonl`, `state.json`, `dreams.json`, `edits.json`, `backups/`);
- only compressed evidence is stored: task goals, conversation excerpts, tool-sequence summaries, judgements; no full prompts, no raw model output; episode records do not store the full skill body;
- to support revert, `edits.json` stores the full pre-edit text and sha256 of **the one skill file this plugin modified** (in the local data directory only; never sent to a model, never shown in the panel/API);
- probe and judge content is sent to the model provider currently configured, exactly like normal conversation; no extra network requests;
- before a skill edit, a byte backup is written to `backups/<editId>/SKILL.md`; `edits.json` records the before/after sha256;
- logs contain no prompt text; even at `debug` level only lengths and timings are logged.

## Safety and failure posture

- Any dreaming failure **never** fails a skill call, a turn, or the Host process; every listener catches internally and warns;
- every fire-and-forget promise has `.catch`; every timer and AbortController is owned and released on unload;
- if the store is unavailable the plugin degrades to memory-only; the panel shows `store offline` and sessions are unaffected;
- only user-level skills are edited; project / bundled / runtime / custom sources only receive a guidance overlay;
- before writing, a backup is made; on revert, a manually changed file (hash mismatch) is refused and marked `conflict` — your edits are never clobbered;
- a dream never edits a skill that is currently being loaded or observed.

## Cost

Under the default configuration:

- per skill load: one probe (≈1–2k input + ≤700 output tokens) and one judge (≈2–3k + ≤900);
- per model request: the awareness section (≈100–300 tokens when data exists, refreshed at most every 10 minutes);
- nightly: bounded by `dream.dailyTokenBudget`.

If one wrong load wastes 3–8k tokens, cutting misuse by 10% is enough to pay for this overhead. The panel shows both “probe + judge spend” and “estimated waste avoided”, so you can tune sampling up or down.

## Development and testing

```powershell
cd dsh-plugin-dreaming
npm test                          # node --test --test-isolation=none "test/*.test.mjs"
# or run a single file:
node test/config.test.mjs
node test/stats.test.mjs
node test/store.test.mjs
```

- `ARCHITECTURE.md`: the full design contract, Harness extension points, data schemas, module interfaces and failure posture;
- unit tests cover config normalization, metric math, persistence/compaction/corruption recovery, prompt building and validation, probe/judge, episode traces, dream proposal validation, skill edits/revert, scheduler DST/catch-up and the API handlers;
- no test-framework dependency; `node:test` only. CI runs the same suite on Windows.

## Known limitations

- **No edits by default**: `dream.autoApply` is `false`, so dreams journal proposals without touching files. Enable it explicitly to correct descriptions/boundaries (backups, journal, conflict detection and revert still apply).
- **Suggestions need samples**: the first calls of a new skill show only low-confidence hints; the plugin deliberately never fabricates a high score without evidence.
- **Non-editable sources**: bundled / project / runtime skills can only improve through the injected guidance overlay; their files are never rewritten.
- **Capability edits are heuristic**: dream proposals pass deterministic validation, but a “better description” can still introduce bias; that is why backups, journal, conflict detection and single-step revert exist.
- **Dream is inline-only in v1**: the night usually has no live parent agent; `dream.mode` is recorded truthfully as `inline` and logs one warning.
- **Symlinks are not edited**: if a skill's `SKILL.md` is a symlink the plugin refuses to write (`symlink-path`) and only records a suggestion, so the link is never replaced by a regular file.
- **Local trust boundary**: `/dreaming/api/` has no extra auth beyond the loopback binding (POST has an Origin check). Do not expose the profile's listener on a non-loopback address without adding authentication, and treat the data directory and backups as local user data.
- **`POST /dreaming/api/dream/run` runId**: the run is asynchronous; the call returns `accepted:true` immediately and `runId` may be `null` — the actual run id is in the next journal refresh.
- **Judge quality depends on the model**: scores are relative signals for trends and prioritization, not absolute truth.
- **Sub-agent probe**: `probe.mode = 'subagent'` creates a real sub-session, costs significantly more and is subject to delegation depth/capacity; failures fall back to inline.

## License

[MIT](LICENSE)
