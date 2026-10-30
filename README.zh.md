# Dreaming · 意识强度

[English](README.md) | 中文

> 在执行之前，准确知道一个 skill 真正能做什么——这就是**意识强度**。Dreaming 通过持续测量与夜间修正来提高它，让 skill 被更精准地调用，减少"看介绍像是对的、加载后才发现不对"的 token 浪费。

Dreaming 是一个 DeepSeek Harness 全局插件（Host + Web 面板）。它不是日志插件，而是**能力自模型**（capability self-model）插件：

- 每次加载 skill 时，**并发**预测它对这个任务真正能交付什么；
- 记录加载之后**真实发生**的事（是否按 skill 执行、是否放弃/返工、token 代价）；
- 回合结束后**判定**预期与现实的差异，得到可复用的规则；
- 维护每个 skill 的**能力信念**与**意识强度**指标；
- 在模型使用 skill 前，把"实测真相"注入上下文（历史准确率、能力边界、更便宜的替代路径）；
- **夜间做梦**：回到预期与现实不一致的案例，安全地修改 skill 的描述与能力边界（自动备份、日志、可回滚），从源头提高调用精度。

## 为什么需要它

Skill 的描述是一种"声明能力"，但声明与实际能力经常不一致：

- 描述说"可以处理 X"，正文实际只覆盖 X 的一个子集；
- 描述太宽，模型在不该加载时加载，整段正文变成上下文成本；
- 描述太窄，模型绕开 skill 自己重做，浪费更多 token；
- 同一类任务反复误用同一个 skill，但没有任何机制把这次教训写回描述。

Dreaming 把这件事变成闭环：**测量 → 判定 → 写入边界 → 再测量**。指标是"意识强度上升、浪费的 token 下降"，而不是"记录了多少条日志"。

## 工作机制

```
                    ┌──────────── 每次 skill 调用 ────────────┐
user/agent ── skill ─┤ tools/pre-execute                        │
                    │   ├─ 记录任务上下文（截断、预算内）        │
                    │   └─ 并发 probe：一个便宜的 LLM 调用       │
                    │       预测 fit / 预期用法 / 陷阱 / 缺口    │
                    ├─ tools/result：记录 skill 正文与加载结果   │
                    ├─ tools/post-execute：把「历史准确率 +      │
                    │   预测 + 学到的边界」附在 skill 结果后面   │
                    ├─ session/event：观察后续 assistant/tool   │
                    │   /user 事件，直到 turn 结束               │
                    └─ judge：预期 vs 现实 → 分数 / 根因 / 规则  │
                                   │
                     ┌─────────────┴──────────────┐
                     │ 能力信念（每个 skill）        │
                     │ 意识强度 / 校准 / 边界准确率  │
                     │ token 浪费估计               │
                     └─────────────┬──────────────┘
                                   │
              系统提示中的「能力自知」段落 + skill 结果注解
                                   │
                        ┌──────────┴──────────┐
                        │ 夜间 dream（定时）    │
                        │ 选不匹配案例 → 反思   │
                        │ → 描述/边界修改       │
                        │ → 备份 + 日志 + 回滚  │
                        └─────────────────────┘
```

### 1. Probe：在加载时同步预测

`tools/pre-execute` 里在 skill 真正执行前登记一个 episode，并**并发**发起一次受预算约束的 LLM 调用（默认 `probe.mode = 'inline'`，直接 `ctx.llm.stream`，不创建子会话、不污染对话历史）。它返回结构化预测：

- `fit`（0–1）：这个 skill 对该任务是否合适、是否足够；
- `expected_use`：预期模型会用它做哪些具体步骤；
- `success_signals`：怎样算用对了；
- `likely_pitfalls`：最可能踩的坑；
- `capability_gap`：任务需要、但 skill 可能实际不提供的能力；
- `cheaper_alternative`：不加载它也能完成时更便宜的路径。

> 为什么默认不是子 agent：一个完整子 agent 的固定提示 + 工具 schema + 多步推理，通常比它想省下的 skill 正文更贵。Dreaming 的目标是省 token，所以探针必须是**单次、低温度、结构化、可采样**的调用。`probe.mode = 'subagent'` 仍可用，供明确需要 agent 形态观察者的场景。

### 2. 观察真实结果

`tools/result` 记录 skill 加载结果；`session/event` 从加载点开始收集有界轨迹：assistant 文本、工具调用序列（名字/成败/摘要）、用户纠正、`turn/end` 原因。窗口在以下任一条件关闭：同回合 `turn/end`、`observe.maxTurnExtensionMs`、`observe.maxEvents`。窗口关闭后不会读已关闭会话，也不会一直占用内存。

### 3. Judge：预期 vs 现实

回合结束后，一次便宜的判定调用产出：

- `score`（0–100）与 `verdict`（matched / partial / missed / misapplied）；
- `predictionAccuracy`：预测与实际的吻合度；
- `capabilityGap`：描述声称的能力与真实交付的差异；
- `mismatches`、`rootCause`（description / instructions / selection / user / execution）；
- `reusableRule`：下次可直接复用的判断规则；
- `cost.wastedEstimate`：保守估计的浪费 token。

### 4. 能力信念与意识强度

每个 skill 持久化一份能力信念（加载次数、判定分布、fit 历史、成本、学到的边界）。核心指标：

| 指标 | 定义 | 回答的问题 |
|---|---|---|
| `fitAccuracy` | `1 − Brier score`（预测 fit 与真实成功率的平方误差） | 它**预测自己**准不准 |
| `boundaryAccuracy` | `1 − 出现能力缺口的判定比例` | 它的描述**边界**准不准 |
| `precision` | `1 − misapplied / judged`（只看已判定调用） | 它**被调用**时是否切题 |
| `consciousness` | `100 × (0.45·fitAccuracy + 0.30·boundaryAccuracy + 0.25·precision)` | 综合**意识强度** |
| `wasteRate` | 浪费 token / 已加载 skill token | 它**浪费**了多少 |
| `confidence` | 判定样本 `<3 / <10 / ≥10` → low / medium / high | 这个分数可不可信 |

> 样本不足时不会给出虚假的高分：`confidence = low`，面板和模型提示都会标明。
>
> 浪费口径：判定为 `misapplied` 或 `missed` 的调用，skill 正文 token 整体计入浪费；`partial` 只在确认发生返工时计入返工 token。

### 5. 注入：在使用前给出真相

- **系统提示中的全局段落**：`Dreaming · capability awareness`，只在有足够样本时出现，最多 `prompt.maxSkills` 行，明确标注"这是观测到的倾向，不覆盖 skill 自身指令"。
- **skill 结果注解**：skill 加载完成后，在结果末尾追加一段（≤ `prompt.annotationMaxChars`）：
  - 该 skill 的历史 fit 准确率 / 意识强度 / 浪费率；
  - 本次 probe 的预期用法、陷阱与更便宜的替代路径（若在 `probe.attachDeadlineMs` 内完成）；
  - 学到的"不要用于 / 前置条件"。
  
  模型是在**读完 skill 正文之后、动手之前**看到这段内容的，因此能立即调整。

### 6. Dream：夜间修正能力描述

`dream.time`（默认 03:30，本地时区，可配 IANA 时区）触发；支持开机补跑（`catchUpHours` 内）与抖动。每次运行：

1. 选取最近 `caseWindowDays` 内判定为 `missed` / `misapplied` / 低分的案例，按 skill 分组（每 skill 最多 `maxCasesPerSkill`，每次最多 `maxSkillsPerRun` 个 skill）；
2. 构造有界 dream pack：skill 当前文件、当前描述、已学边界、压缩后的案例（预测 + 轨迹 + 判定）；
3. 让 dreamer 产出结构化提案：`description` 修改、`body` 能力边界段落、可复用规则、置信度；
4. **确定性校验**：描述长度/可定位性/置信度阈值/是否移除原有能力声明；任何一项不通过就只记录为建议，不落盘；
5. 安全应用：只编辑 `dream.editableSources` 白名单内的 **用户级 skill**（默认 `user-dsh`、`user-agents`），路径必须在用户 skill 根目录内（`realpath` 校验），先写备份、再原子替换、校验 sha256；
6. 把规则合并进该 skill 的 guidance overlay（对不可编辑的 skill 同样生效，这是它们的主要改进途径）；
7. 写入梦境日志（包括被拒绝的提案与原因），并把 `before` 与**明确标注为估算**的 `afterEstimate` 一起展示。

内置 skill 能力边界段落使用标记：

```markdown
<!-- dreaming:begin -->
## 能力边界（Dreaming · 自动维护）
...
<!-- dreaming:end -->
```

重复做梦只会替换标记之间的内容，永远不会重写你手写的正文或其它 frontmatter 字段。

## 安装

要求：DSH ≥ 0.2.1-0（见 `engines.dsh`）。

从本仓库（Git）安装（插件通过 GitHub 分发；npm 发布计划中）。

在 Harness 的 **Plugins** 页面粘贴仓库地址：

```
https://github.com/puppetcat-fire/dsh-plugin-dreaming
```

或在 CLI 里：

```sh
dsh plugin --profile <profile> add git+https://github.com/puppetcat-fire/dsh-plugin-dreaming.git
```

安装后插件对所有会话生效（profile 级），重启 Harness 后仍然生效。卸载：Plugins 页面移除，或 `plugin_manager(action="remove_bundle", target="dsh-plugin-dreaming")`。

> 运行时包（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`、`@deepseek-ai/cordis`）由 Harness 提供，不需要单独安装；它们以 `peerDependencies` 声明。

## 配置

所有配置写在 profile 的 `cordis.patch.yml`（或 home patch）。本插件不导出可编辑的 volatile 字段，因此 Settings 里不会出现通用配置表单；Settings → Dreaming 是只读观测页。默认值完整定义见 `lib/config.js`。常用项：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dataDir` | `''` | 数据目录；空 = `$DSH_HOME/dreaming` |
| `probe.enabled` | `true` | 是否在 skill 加载时预测 |
| `probe.mode` | `'inline'` | `inline`（推荐，便宜）或 `subagent` |
| `probe.sampleRate` | `1` | 采样率；有已知缺口的 skill 始终探测 |
| `probe.attachDeadlineMs` | `1500` | skill 结果等待预测的最长时间，超时只附历史 |
| `probe.maxPerHour` | `120` | 每小时探测上限 |
| `judge.enabled` | `true` | 是否判定 |
| `observe.maxTurnExtensionMs` | `600000` | 观察窗口硬上限 |
| `prompt.awarenessSection` | `true` | 是否注入全局能力自知段落 |
| `prompt.annotateSkillResult` | `true` | 是否在 skill 结果后追加注解 |
| `prompt.refreshMinutes` | `10` | 全局段落最短刷新间隔（保护 KV cache） |
| `dream.enabled` | `true` | 是否夜间做梦 |
| `dream.time` | `'03:30'` | 本地时间 HH:MM |
| `dream.timeZone` | `''` | IANA 时区；空 = 进程时区 |
| `dream.scoreThreshold` | `78` | 低于该判定分数视为不匹配案例 |
| `dream.autoApply` | `false` | `false` 时只记录建议，不修改文件；打开后才会自动落盘（带备份与回滚） |
| `dream.editableSources` | `['user-dsh','user-agents']` | 允许落盘修改的 skill 来源 |
| `dream.dailyTokenBudget` | `60000` | 每日做梦 token 预算 |
| `run.maxConcurrent` | `2` | 并发 probe / judge 上限 |
| `store.retainDays` | `120` | episode 保留天数 |
| `store.maxEpisodes` | `4000` | episode 上限 |

示例（只对 office 相关任务采样，并显式打开夜间自动落盘）：

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

## 面板

Settings → **Dreaming · 意识强度**（`settings.section`，order 95）：

- 总览：意识强度、已判定调用数、浪费率、probe/judge 开销、估算避免的浪费、下次做梦时间；
- 技能表：加载数、自知、fit 准确率、边界准确率、精确率、浪费率、趋势、最近使用、已应用修改；
- 最近调用：预测 vs 轨迹 vs 判定，可展开；
- 梦境日志：运行状态、提案（已应用/仅建议/被拒绝）、回滚按钮；
- **立即做梦** 按钮。

面板只读 `/dreaming/api/*`（Host 注册的 prefix route，JSON-only，POST 有 Origin 校验与请求体上限）。所有写操作都经过与 dream engine 相同的回滚路径。

## 数据与隐私

- 数据目录：`$DSH_HOME/dreaming/`（`episodes.jsonl`、`state.json`、`dreams.json`、`edits.json`、`backups/`）；
- 只保存压缩后的证据：任务目标、对话片段、工具序列摘要、判定结果；不保存完整 prompt、不保存模型原始输出；episode 记录不保存完整 skill 正文；
- 为了支持回滚，`edits.json` 会保存**被本插件修改过的那个 skill** 在修改前的全文与 sha256（仅本机数据目录；不会发送给模型，也不会出现在面板/API 中）；
- probe/judge 的内容会发送给当前配置的模型 provider（与正常对话一致）；不做额外网络请求；
- 修改 skill 前写入 `backups/<editId>/SKILL.md` 字节备份，`edits.json` 记录前后 sha256；
- 日志不包含 prompt 正文；`debug` 级别也只记录长度与耗时。

## 安全与失败姿态

- 任何 dreaming 失败都**不会**导致 skill 调用、回合或 Host 进程失败；所有监听器内部捕获异常并 `warn`；
- 所有 fire-and-forget promise 都有 `.catch`；所有定时器/AbortController 都被持有并在插件卸载时释放；
- 存储不可用时退化为纯内存运行，面板显示 `store offline`，不影响会话；
- 只修改用户级 skill；project / bundled / runtime / custom 来源只写 guidance overlay，不落盘；
- 文件修改前先备份，回滚时若发现文件已被手工改动（hash 不匹配）会拒绝并标记 `conflict`，绝不覆盖你的改动；
- 做梦不会在某个 skill 正在被调用/观察时修改它。

## 成本

默认配置下的固定开销：

- 每次 skill 加载：一次 probe（约 1–2k 输入 + ≤700 输出 token），一次 judge（约 2–3k + ≤1400）；
- 每次模型请求：能力自知段落（有数据时约 100–300 token，10 分钟最多刷新一次）；
- 夜间：受 `dream.dailyTokenBudget` 限制。

如果平均每次错误加载会浪费 3–8k token，那么把误用率降低 10% 就足以抵消这些开销。面板会同时展示"探针+判定开销"和"估算避免的浪费"，方便你判断是否值得调高/调低采样。

## 开发与测试

```powershell
cd dsh-plugin-dreaming
npm test                          # node --test --test-isolation=none "test/*.test.mjs"
# 或逐个文件直接运行：
node test/config.test.mjs
node test/stats.test.mjs
node test/store.test.mjs
```

- `ARCHITECTURE.md`：完整设计契约、Harness 扩展点、数据 schema、模块接口、失败姿态；
- 单元测试覆盖：配置归一化、指标数学、持久化/压缩/损坏恢复、prompt 构建与校验、probe/judge、episode 轨迹、dream 提案校验、skill 编辑/回滚、调度 DST/补跑、API 处理器；
- 不引入任何测试框架依赖，使用 `node:test`；CI 在 Windows 上跑同一套测试。

## 已知限制

- **默认不改文件**：`dream.autoApply` 默认为 `false`，只把提案写进梦境日志；要自动改进 skill 描述/边界，需要在 profile 配置里显式打开（仍有备份、日志、冲突检测与回滚）。
- **智能体建议需要样本**：新 skill 的前几次调用只有低置信度提示，这是刻意的；不做"无证据的高分"。
- **不可编辑来源**：bundled / project / runtime skill 只能通过注入的 guidance 改进，不会改文件（避免破坏项目与升级）。
- **能力描述修改是启发式的**：dreamer 的提案经过确定性校验，但"更好的描述"仍可能引入偏差；因此保留备份、日志、冲突检测与单次回滚。
- **dream 默认 inline**：夜间通常没有存活的父 Agent，子 agent 形态的 dream 未在 v1 中启用；`dream.mode` 会如实记录为 `inline` 并记录一次警告。
- **symlink 不自动编辑**：如果 skill 的 `SKILL.md` 本身是符号链接，插件会拒绝落盘修改（`symlink-path`）并只记录建议，避免把链接替换成普通文件。
- **本地信任边界**：`/dreaming/api/` 与普通 loopback 路由一样没有额外鉴权（POST 有 Origin 校验）。它只在 `127.0.0.1` 上暴露；数据目录与备份属于本机用户，不要把 profile 的监听地址改成非 loopback 而不加前置鉴权。
- **`POST /dreaming/api/dream/run` 的 runId**：运行是异步的，接口立即返回 `accepted:true`；`runId` 可能为 `null`，实际运行 id 以随后刷新的梦境日志为准。
- **判断依赖模型质量**：judge 的分数是相对信号，用于趋势与优先级，不应被当作绝对真值。
- **子 agent probe**：`probe.mode = 'subagent'` 会创建真实子会话，成本显著更高，且受委派深度/容量限制；失败会自动回退到 inline。

## 许可证

[MIT](LICENSE)
