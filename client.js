window.__ModuleLoader__.load({
  id: 'dsh-plugin-dreaming',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ---------------------------------------------------------------------------------------
    // locale: the browser module table cannot require the package's locale/*.json, so the
    // dictionaries live inline (same as the host's own client bundles). test/api.test.mjs
    // enforces key parity with locale/en.json + locale/zh.json and with every t() call below.
    // ---------------------------------------------------------------------------------------
    const zh = {
      "meta.title": "Dreaming · 意识强度",
      "meta.description": "提升技能的“意识强度”：每次加载技能时同步预测它真正能做什么，记录真实结果，并在夜间改进技能描述与能力边界，让技能调用更精准、少浪费 token。",
      "panel.title": "Dreaming · 意识强度",
      "panel.subtitle": "实测的技能自知、token 浪费与夜间能力修正",
      "panel.refresh": "刷新",
      "panel.dreamNow": "立即做梦",
      "panel.dreaming": "做梦中…",
      "panel.dreamStarted": "已开始梦境运行",
      "panel.loading": "加载中…",
      "panel.reverting": "正在回滚…",
      "panel.revertFailed": "无法回滚该修改",
      "panel.dreamBusy": "已有梦境在运行中",
      "panel.dreamUnavailable": "当前无法运行梦境",
      "panel.dreamFailed": "无法启动梦境运行",
      "panel.noData": "还没有观察到技能调用。加载一个技能后再回来。",
      "panel.noSkills": "还没有跟踪任何技能。",
      "panel.error": "无法加载 dreaming 数据",
      "panel.retry": "重试",
      "panel.overview": "总览",
      "panel.consciousness": "意识强度",
      "panel.judged": "已判定的技能调用",
      "panel.wasteRate": "token 浪费率",
      "panel.spent": "探针 + 判定开销",
      "panel.avoided": "估算避免的浪费",
      "panel.nextDream": "下次做梦",
      "panel.lastDream": "上次做梦",
      "panel.dreamSpend": "梦境开销",
      "panel.skills": "技能",
      "panel.skill": "技能",
      "panel.loads": "加载",
      "panel.awareness": "自知",
      "panel.fitAccuracy": "适配准确率",
      "panel.boundaryAccuracy": "边界准确率",
      "panel.precision": "精确率",
      "panel.waste": "浪费",
      "panel.trend": "趋势",
      "panel.lastUsed": "最近使用",
      "panel.edits": "修改",
      "panel.episodes": "最近技能调用",
      "panel.episodeEmpty": "没有符合条件的记录。",
      "panel.filterAll": "全部",
      "panel.filterMismatch": "不匹配",
      "panel.verdict": "结论",
      "panel.score": "得分",
      "panel.prediction": "预测",
      "panel.reality": "实际",
      "panel.probeExpectation": "预期用法",
      "panel.pitfalls": "常见陷阱",
      "panel.rootCause": "根因",
      "panel.rule": "可复用规则",
      "panel.dreamJournal": "梦境日志",
      "panel.dreamEmpty": "还没有梦境运行。",
      "panel.run": "运行",
      "panel.caseCount": "{count} 个案例",
      "panel.applied": "已应用",
      "panel.suggested": "仅建议",
      "panel.rejected": "已拒绝",
      "panel.revert": "回滚",
      "panel.reverted": "已回滚",
      "panel.revertConflict": "无法回滚：修改后文件已变化",
      "panel.status": "状态",
      "panel.statusOk": "正常",
      "panel.statusPartial": "部分完成",
      "panel.statusFailed": "失败",
      "panel.statusSkipped": "跳过",
      "panel.modeInline": "内联",
      "panel.modeSubagent": "子代理",
      "panel.modeAuto": "自动",
      "panel.turnCompleted": "完成",
      "panel.turnAborted": "中止",
      "panel.turnError": "出错",
      "panel.turnMaxTokens": "超出 token",
      "panel.turnInterrupted": "被中断",
      "panel.turnTimeout": "超时",
      "panel.skillCount": "{count} 个技能",
      "panel.storeOffline": "存储不可用，当前仅内存运行",
      "panel.confidence": "置信度",
      "panel.low": "低",
      "panel.medium": "中",
      "panel.high": "高",
      "panel.match": "匹配",
      "panel.partial": "部分匹配",
      "panel.missed": "未达成",
      "panel.misapplied": "误用",
      "panel.unknown": "未知",
      "panel.fit": "适配度",
      "panel.expectedValue": "预期价值",
      "panel.capabilityGap": "能力差距",
      "panel.claim": "声称",
      "panel.mismatches": "不匹配项",
      "panel.expected": "预期",
      "panel.observed": "实际",
      "panel.cause": "原因",
      "panel.recommendation": "建议",
      "panel.descriptionEdit": "描述",
      "panel.bodyAddition": "正文",
      "panel.selectionRule": "选择规则",
      "panel.trace": "观测",
      "panel.turnEnd": "回合结束",
      "panel.observedFor": "观察时长",
      "panel.assistantMessages": "助手消息",
      "panel.toolCalls": "工具调用",
      "panel.userMessages": "用户消息",
      "panel.finalAnswerChars": "最终回答字符数",
      "panel.skillReloaded": "技能被重新加载",
      "panel.yes": "是",
      "panel.no": "否",
      "panel.probe": "探针",
      "panel.judge": "判定",
      "panel.tokensIn": "输入",
      "panel.tokensOut": "输出",
      "panel.tokens": "token",
      "panel.tokenCount": "{count} token",
      "panel.wastedTokens": "浪费 token",
      "panel.estimate": "估算",
      "panel.generated": "更新于 {time}",
      "panel.mode": "模式",
      "panel.trigger": "触发",
      "panel.manual": "手动",
      "panel.schedule": "定时",
      "panel.before": "之前",
      "panel.afterEstimate": "之后（估算）",
      "panel.openEpisodes": "进行中的技能调用",
      "panel.storeReady": "存储就绪",
      "panel.storeError": "存储错误",
      "panel.lastError": "最近错误",
      "panel.never": "从未",
      "panel.scheduleOff": "夜间梦境已关闭",
      "panel.running": "运行中",
      "panel.details": "详情",
      "panel.hide": "收起",
      "panel.predictionAccuracy": "预测准确率",
      "panel.editKind": "类型",
      "panel.appliedAt": "应用时间",
      "panel.backup": "备份",
      "panel.backupMissing": "无",
      "panel.noEdits": "还没有已应用的修改。",
      "panel.seconds": "{count} 秒",
      "panel.scoreOf": "{score}/100",
      "panel.delta": "Δ",
      "panel.spendDetail": "探针 {probe} · 判定 {judge}",
      "panel.episodeCount": "{count} 次技能调用",
      "panel.showingRecent": "显示最近 {count} 条",
      "panel.skillsEmpty": "首次观察到技能调用后，这里会列出技能。"
    };

    const en = {
      "meta.title": "Dreaming",
      "meta.description": "Raises consciousness strength for skills: probes each skill call, records what really happened, and improves skill descriptions and boundaries overnight so skills are invoked precisely and tokens are not wasted.",
      "panel.title": "Dreaming · 意识强度",
      "panel.subtitle": "Measured skill awareness, token waste, and nightly capability refinement",
      "panel.refresh": "Refresh",
      "panel.dreamNow": "Dream now",
      "panel.dreaming": "Dreaming…",
      "panel.dreamStarted": "Dream run started",
      "panel.loading": "Loading…",
      "panel.reverting": "Reverting…",
      "panel.revertFailed": "Could not revert this edit",
      "panel.dreamBusy": "A dream run is already in progress",
      "panel.dreamUnavailable": "Dream runs are unavailable right now",
      "panel.dreamFailed": "Could not start a dream run",
      "panel.noData": "No skill calls observed yet. Load a skill and come back.",
      "panel.noSkills": "No skills tracked yet.",
      "panel.error": "Could not load dreaming data",
      "panel.retry": "Retry",
      "panel.overview": "Overview",
      "panel.consciousness": "Consciousness strength",
      "panel.judged": "Judged skill calls",
      "panel.wasteRate": "Token waste rate",
      "panel.spent": "Probe + judge spend",
      "panel.avoided": "Estimated waste avoided",
      "panel.nextDream": "Next dream",
      "panel.lastDream": "Last dream",
      "panel.dreamSpend": "Dream spend",
      "panel.skills": "Skills",
      "panel.skill": "Skill",
      "panel.loads": "Loads",
      "panel.awareness": "Awareness",
      "panel.fitAccuracy": "Fit accuracy",
      "panel.boundaryAccuracy": "Boundary accuracy",
      "panel.precision": "Precision",
      "panel.waste": "Waste",
      "panel.trend": "Trend",
      "panel.lastUsed": "Last used",
      "panel.edits": "Edits",
      "panel.episodes": "Recent skill calls",
      "panel.episodeEmpty": "No episodes match this filter.",
      "panel.filterAll": "All",
      "panel.filterMismatch": "Mismatched",
      "panel.verdict": "Verdict",
      "panel.score": "Score",
      "panel.prediction": "Prediction",
      "panel.reality": "Reality",
      "panel.probeExpectation": "Expected use",
      "panel.pitfalls": "Pitfalls",
      "panel.rootCause": "Root cause",
      "panel.rule": "Reusable rule",
      "panel.dreamJournal": "Dream journal",
      "panel.dreamEmpty": "No dream run yet.",
      "panel.run": "Run",
      "panel.caseCount": "{count} cases",
      "panel.applied": "applied",
      "panel.suggested": "suggested",
      "panel.rejected": "rejected",
      "panel.revert": "Revert",
      "panel.reverted": "Reverted",
      "panel.revertConflict": "Cannot revert: the file changed after the edit",
      "panel.status": "Status",
      "panel.statusOk": "OK",
      "panel.statusPartial": "Partial",
      "panel.statusFailed": "Failed",
      "panel.statusSkipped": "Skipped",
      "panel.modeInline": "inline",
      "panel.modeSubagent": "subagent",
      "panel.modeAuto": "auto",
      "panel.turnCompleted": "Completed",
      "panel.turnAborted": "Aborted",
      "panel.turnError": "Error",
      "panel.turnMaxTokens": "Max tokens",
      "panel.turnInterrupted": "Interrupted",
      "panel.turnTimeout": "Timeout",
      "panel.skillCount": "{count} skills",
      "panel.storeOffline": "Store unavailable; running in memory",
      "panel.confidence": "confidence",
      "panel.low": "low",
      "panel.medium": "medium",
      "panel.high": "high",
      "panel.match": "matched",
      "panel.partial": "partial",
      "panel.missed": "missed",
      "panel.misapplied": "misapplied",
      "panel.unknown": "unknown",
      "panel.fit": "Fit",
      "panel.expectedValue": "Expected value",
      "panel.capabilityGap": "Capability gap",
      "panel.claim": "Claim",
      "panel.mismatches": "Mismatches",
      "panel.expected": "Expected",
      "panel.observed": "Observed",
      "panel.cause": "Cause",
      "panel.recommendation": "Recommendation",
      "panel.descriptionEdit": "Description",
      "panel.bodyAddition": "Body",
      "panel.selectionRule": "Selection rule",
      "panel.trace": "Observation",
      "panel.turnEnd": "Turn ended",
      "panel.observedFor": "Observed",
      "panel.assistantMessages": "Assistant",
      "panel.toolCalls": "Tool calls",
      "panel.userMessages": "User messages",
      "panel.finalAnswerChars": "Final answer chars",
      "panel.skillReloaded": "Skill reloaded",
      "panel.yes": "Yes",
      "panel.no": "No",
      "panel.probe": "Probe",
      "panel.judge": "Judge",
      "panel.tokensIn": "In",
      "panel.tokensOut": "Out",
      "panel.tokens": "tokens",
      "panel.tokenCount": "{count} tokens",
      "panel.wastedTokens": "Wasted tokens",
      "panel.estimate": "estimate",
      "panel.generated": "Updated {time}",
      "panel.mode": "Mode",
      "panel.trigger": "Trigger",
      "panel.manual": "manual",
      "panel.schedule": "schedule",
      "panel.before": "Before",
      "panel.afterEstimate": "After (estimated)",
      "panel.openEpisodes": "Open skill calls",
      "panel.storeReady": "Store ready",
      "panel.storeError": "Store error",
      "panel.lastError": "Last error",
      "panel.never": "Never",
      "panel.scheduleOff": "Nightly dreams are off",
      "panel.running": "running",
      "panel.details": "Details",
      "panel.hide": "Hide",
      "panel.predictionAccuracy": "Prediction accuracy",
      "panel.editKind": "Kind",
      "panel.appliedAt": "Applied",
      "panel.backup": "Backup",
      "panel.backupMissing": "none",
      "panel.noEdits": "No applied edits yet.",
      "panel.seconds": "{count}s",
      "panel.scoreOf": "{score}/100",
      "panel.delta": "Δ",
      "panel.spendDetail": "probe {probe} · judge {judge}",
      "panel.episodeCount": "{count} skill calls",
      "panel.showingRecent": "Showing the most recent {count}",
      "panel.skillsEmpty": "Skills appear after the first observed skill call."
    };

    const NS = 'dreaming';
    const API_BASE = '/dreaming/api/';
    const POLL_MS = 30000;

    /** Detect the UI language without requiring the locale service. */
    function detectLanguage(ctx) {
      let language = '';
      try {
        const locale = typeof ctx?.get === 'function' ? ctx.get('locale') : undefined;
        const snapshot = typeof locale?.getLocale === 'function' ? locale.getLocale() : undefined;
        if (snapshot && typeof snapshot.language === 'string') language = snapshot.language;
      } catch {
        language = '';
      }
      if (!language && typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
        language = navigator.language;
      }
      return String(language || 'en').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
    }

    /** Build a translator for one language; unknown keys fall back to English, then the key. */
    function makeTranslator(language) {
      const dictionary = language === 'zh' ? zh : en;
      function translate(key, params) {
        const template = typeof dictionary[key] === 'string'
          ? dictionary[key]
          : (typeof en[key] === 'string' ? en[key] : key);
        if (params === null || typeof params !== 'object') return template;
        return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => {
          const value = params[name];
          return value === null || value === undefined ? '' : String(value);
        });
      }
      // Keep date formatting in the same language as the visible copy.
      translate.language = language === 'zh' ? 'zh-CN' : 'en';
      return translate;
    }

    // ---------------------------------------------------------------------------------------
    // defensive readers: the API is bounded but a partial/older payload must never crash render
    // ---------------------------------------------------------------------------------------
    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }
    function record(value) {
      return isRecord(value) ? value : {};
    }
    function list(value) {
      return Array.isArray(value) ? value : [];
    }
    function text(value, fallback) {
      if (typeof value === 'string' && value.length > 0) return value;
      return typeof fallback === 'string' ? fallback : '';
    }
    function number(value, fallback) {
      const parsed = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : (Number.isFinite(fallback) ? fallback : 0);
    }
    function ratio(value) {
      return Math.min(1, Math.max(0, number(value, 0)));
    }
    function percent(value) {
      return Math.round(ratio(value) * 100) + '%';
    }
    function fixed(value, digits) {
      return number(value, 0).toFixed(typeof digits === 'number' ? digits : 1);
    }
    function formatTokens(value) {
      const amount = number(value, 0);
      if (Math.abs(amount) >= 1000000) return (amount / 1000000).toFixed(1) + 'M';
      if (Math.abs(amount) >= 1000) return (amount / 1000).toFixed(1) + 'k';
      return String(Math.round(amount));
    }
    function formatInteger(value) {
      const amount = Math.round(number(value, 0));
      try {
        return new Intl.NumberFormat(undefined).format(amount);
      } catch {
        return String(amount);
      }
    }
    /** Epoch milliseconds from a number, an ISO string, or 0 when unparseable. */
    function toMillis(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
      if (typeof value === 'string' && value.length > 0) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
      }
      return 0;
    }
    function formatTime(ms, t, fallbackKey) {
      const stamp = toMillis(ms);
      if (!(stamp > 0)) return t(fallbackKey || 'panel.never');
      try {
        return new Date(stamp).toLocaleString(typeof t.language === 'string' ? t.language : undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return t('panel.unknown');
      }
    }
    function formatDuration(ms, t) {
      const millis = number(ms, 0);
      if (!(millis > 0)) return '';
      const seconds = millis / 1000;
      return t('panel.seconds', { count: seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1) });
    }
    function confidenceKey(value) {
      const level = text(value, 'low');
      return level === 'high' || level === 'medium' ? level : 'low';
    }
    function verdictKey(value) {
      const verdict = text(value, '');
      if (verdict === 'matched') return 'panel.match';
      if (verdict === 'partial') return 'panel.partial';
      if (verdict === 'missed') return 'panel.missed';
      if (verdict === 'misapplied') return 'panel.misapplied';
      return 'panel.unknown';
    }
    function verdictTone(value) {
      const verdict = text(value, '');
      if (verdict === 'matched') return 'success';
      if (verdict === 'partial') return 'warn';
      if (verdict === 'missed' || verdict === 'misapplied') return 'error';
      return 'neutral';
    }
    function statusTone(value) {
      const status = text(value, '');
      if (status === 'ok') return 'success';
      if (status === 'partial' || status === 'suggested') return 'warn';
      if (status === 'failed' || status === 'rejected' || status === 'conflict') return 'error';
      return 'neutral';
    }
    function runStatusLabel(value, t) {
      const status = text(value, '');
      if (status === 'ok') return t('panel.statusOk');
      if (status === 'partial') return t('panel.statusPartial');
      if (status === 'failed') return t('panel.statusFailed');
      if (status === 'skipped') return t('panel.statusSkipped');
      return text(value, t('panel.unknown'));
    }
    function modeLabel(value, t) {
      const mode = text(value, '');
      if (mode === 'inline') return t('panel.modeInline');
      if (mode === 'subagent') return t('panel.modeSubagent');
      if (mode === 'auto') return t('panel.modeAuto');
      return text(value, t('panel.unknown'));
    }
    function kindLabel(value, t) {
      const kind = text(value, '');
      if (kind === 'description') return t('panel.descriptionEdit');
      if (kind === 'body') return t('panel.bodyAddition');
      return text(value, t('panel.unknown'));
    }
    function probeStatusLabel(value, t) {
      const status = text(value, '');
      if (status === 'ok') return t('panel.statusOk');
      if (status === 'failed' || status === 'error' || status === 'invalid') return t('panel.statusFailed');
      if (status === 'skipped') return t('panel.statusSkipped');
      return text(value, t('panel.unknown'));
    }
    function turnEndLabel(value, t) {
      const turnEnd = text(value, '');
      if (turnEnd === 'completed') return t('panel.turnCompleted');
      if (turnEnd === 'aborted') return t('panel.turnAborted');
      if (turnEnd === 'error') return t('panel.turnError');
      if (turnEnd === 'max-tokens') return t('panel.turnMaxTokens');
      if (turnEnd === 'interrupted') return t('panel.turnInterrupted');
      if (turnEnd === 'timeout') return t('panel.turnTimeout');
      return text(value, t('panel.unknown'));
    }
    function triggerLabel(value, t) {
      const trigger = text(value, '');
      if (trigger === 'manual') return t('panel.manual');
      if (trigger === 'schedule') return t('panel.schedule');
      return text(value, t('panel.unknown'));
    }
    function editStatusLabel(value, t) {
      const status = text(value, 'applied');
      if (status === 'applied') return t('panel.applied');
      if (status === 'reverted') return t('panel.reverted');
      if (status === 'conflict') return t('panel.revertConflict');
      return t('panel.unknown');
    }
    function mergeStyle() {
      const merged = {};
      for (let index = 0; index < arguments.length; index += 1) {
        const part = arguments[index];
        if (isRecord(part)) Object.assign(merged, part);
      }
      return merged;
    }

    // ---------------------------------------------------------------------------------------
    // theme: colors and radii come only from the host's --dsw-* tokens (never literal colors)
    // ---------------------------------------------------------------------------------------
    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '18px',
        padding: '8px 0 12px',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '14px',
        lineHeight: '22px',
        minWidth: 0,
      },
      toolbar: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '16px',
        flexWrap: 'wrap',
      },
      toolbarText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      subtitle: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' },
      toolbarActions: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none', marginLeft: 'auto' },
      notice: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 12px',
        borderRadius: 'var(--dsw-radius-md)',
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-primary)',
      },
      errorRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '8px 12px',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-state-warn-tertiary)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        lineHeight: '18px',
      },
      storeBanner: {
        padding: '8px 12px',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-state-warn-tertiary)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        lineHeight: '18px',
      },
      cards: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: '10px',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        minWidth: 0,
        padding: '12px 14px',
        borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-alias-settings-card-fill)',
        border: '.5px solid var(--dsw-alias-settings-card-stroke)',
      },
      cardLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' },
      cardValue: {
        fontSize: '22px',
        lineHeight: '28px',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.01em',
      },
      cardSub: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', lineHeight: '16px' },
      section: { display: 'flex', flexDirection: 'column', gap: '10px' },
      sectionHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        flexWrap: 'wrap',
        paddingTop: '6px',
      },
      sectionTitle: { fontSize: '14px', fontWeight: 500, lineHeight: '22px' },
      sectionMeta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' },
      sectionFilters: { display: 'flex', alignItems: 'center', gap: '6px' },
      filterButton: {
        border: '.5px solid var(--dsw-alias-border-l3)',
        background: 'none',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: 'var(--dsw-radius-sm)',
        padding: '2px 10px',
        fontFamily: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        cursor: 'pointer',
      },
      filterButtonActive: {
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
        borderColor: 'var(--dsw-alias-border-l2)',
      },
      tableWrap: {
        overflowX: 'auto',
        border: '.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-lg)',
      },
      table: { width: '100%', borderCollapse: 'collapse', minWidth: '680px' },
      th: {
        textAlign: 'left',
        padding: '8px 10px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '11px',
        fontWeight: 500,
        lineHeight: '16px',
        whiteSpace: 'nowrap',
        borderBottom: '.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      td: {
        padding: '10px',
        fontSize: '13px',
        lineHeight: '20px',
        borderBottom: '.5px solid var(--dsw-alias-border-l2)',
        verticalAlign: 'middle',
      },
      tdNum: {
        padding: '10px',
        fontSize: '13px',
        lineHeight: '20px',
        borderBottom: '.5px solid var(--dsw-alias-border-l2)',
        verticalAlign: 'middle',
        textAlign: 'right',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
      },
      skillCell: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 },
      skillName: {
        fontWeight: 500,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      skillMeta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', lineHeight: '16px' },
      barRow: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '104px' },
      barTrack: {
        flex: 1,
        height: '6px',
        borderRadius: '3px',
        background: 'var(--dsw-alias-bg-layer-3)',
        overflow: 'hidden',
        minWidth: '56px',
      },
      barFill: { height: '6px', borderRadius: '3px', background: 'var(--dsw-alias-brand-primary)' },
      barValue: { fontSize: '12px', lineHeight: '18px', fontVariantNumeric: 'tabular-nums' },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0 8px',
        borderRadius: '10px',
        fontSize: '11px',
        lineHeight: '18px',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      },
      badgeSuccess: {
        color: 'var(--dsw-alias-state-success-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)',
      },
      badgeWarn: {
        color: 'var(--dsw-alias-state-warn-primary)',
        background: 'var(--dsw-alias-state-warn-tertiary)',
      },
      badgeError: {
        color: 'var(--dsw-alias-state-error-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)',
      },
      badgeNeutral: { color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-3)' },
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        height: '32px',
        padding: '0 14px',
        borderRadius: 'var(--dsw-radius-md)',
        border: '.5px solid var(--dsw-alias-border-l3)',
        background: 'none',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonHover: {
        background: 'var(--dsw-alias-interactive-bg-hover)',
      },
      buttonPrimary: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        height: '32px',
        padding: '0 14px',
        borderRadius: 'var(--dsw-radius-md)',
        border: 'none',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonPrimaryHover: { background: 'var(--dsw-alias-button-primary-hover)' },
      buttonSmall: {
        height: '26px',
        padding: '0 10px',
        fontSize: '12px',
        lineHeight: '18px',
        borderRadius: 'var(--dsw-radius-sm)',
      },
      buttonDisabled: { opacity: 0.5, cursor: 'default' },
      episodeList: {
        display: 'flex',
        flexDirection: 'column',
        border: '.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-lg)',
        overflow: 'hidden',
      },
      episodeItem: { borderBottom: '.5px solid var(--dsw-alias-border-l2)' },
      episodeHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        width: '100%',
        padding: '10px 12px',
        border: 'none',
        background: 'none',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '13px',
        lineHeight: '20px',
        textAlign: 'left',
        cursor: 'pointer',
      },
      episodeTime: {
        flex: 'none',
        width: '116px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      },
      episodeSkill: {
        flex: 1,
        minWidth: 0,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      episodeScore: {
        flex: 'none',
        width: '56px',
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
      },
      episodeState: {
        flex: 'none',
        width: '92px',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '12px',
        textAlign: 'right',
        whiteSpace: 'nowrap',
      },
      chevron: {
        flex: 'none',
        width: '16px',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '11px',
      },
      episodeBody: {
        padding: '4px 12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '12px',
      },
      block: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '10px 12px',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '.5px solid var(--dsw-alias-border-l2)',
        minWidth: 0,
      },
      blockTitle: {
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
        fontWeight: 500,
        lineHeight: '16px',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      },
      field: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 },
      fieldLabel: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', lineHeight: '16px' },
      fieldValue: { fontSize: '12px', lineHeight: '18px', overflowWrap: 'anywhere' },
      list: { margin: 0, paddingLeft: '16px', fontSize: '12px', lineHeight: '18px' },
      toolRow: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        fontSize: '12px',
        lineHeight: '18px',
        minWidth: 0,
      },
      toolName: {
        fontFamily: 'var(--ds-font-family-code)',
        flex: 'none',
        color: 'var(--dsw-alias-label-primary)',
      },
      toolBrief: {
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
      },
      pre: {
        margin: 0,
        padding: '8px 10px',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'var(--dsw-alias-bg-layer-1)',
        fontFamily: 'var(--ds-font-family-code)',
        fontSize: '11px',
        lineHeight: '17px',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        maxHeight: '180px',
        overflow: 'auto',
        color: 'var(--dsw-alias-label-primary)',
      },
      journal: { display: 'flex', flexDirection: 'column', gap: '10px' },
      journalRun: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '12px 14px',
        borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-alias-settings-card-fill)',
        border: '.5px solid var(--dsw-alias-settings-card-stroke)',
        minWidth: 0,
      },
      journalHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
      },
      journalWhen: { fontSize: '13px', fontWeight: 500, lineHeight: '20px' },
      journalMeta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', lineHeight: '16px' },
      journalSkill: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        paddingTop: '10px',
        borderTop: '.5px solid var(--dsw-alias-border-l2)',
        minWidth: 0,
      },
      journalSkillHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      journalSkillName: { fontWeight: 500, fontSize: '13px', lineHeight: '20px' },
      journalActions: { display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' },
      editRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
        fontSize: '11px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      empty: {
        padding: '18px 14px',
        borderRadius: 'var(--dsw-radius-lg)',
        border: '.5px dashed var(--dsw-alias-border-l3)',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '12px',
        lineHeight: '18px',
        textAlign: 'center',
      },
      loading: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '28px 14px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '13px',
      },
      footer: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '11px',
        lineHeight: '16px',
        paddingTop: '2px',
      },
    };

    /** Resolve a badge tone to a concrete style. */
    function badgeStyle(tone) {
      if (tone === 'success') return styles.badgeSuccess;
      if (tone === 'warn') return styles.badgeWarn;
      if (tone === 'error') return styles.badgeError;
      return styles.badgeNeutral;
    }

    // ---------------------------------------------------------------------------------------
    // primitives
    // ---------------------------------------------------------------------------------------
    function Button(props) {
      const [hover, setHover] = React.useState(false);
      const primary = props.tone === 'primary';
      const base = primary ? styles.buttonPrimary : styles.button;
      const hoverStyle = primary ? styles.buttonPrimaryHover : styles.buttonHover;
      return h('button', {
        type: 'button',
        onClick: props.onClick,
        disabled: props.disabled === true,
        style: mergeStyle(
          base,
          props.small === true ? styles.buttonSmall : null,
          props.disabled === true ? styles.buttonDisabled : null,
          hover && props.disabled !== true ? hoverStyle : null,
          props.style,
        ),
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setHover(true),
        onBlur: () => setHover(false),
        'aria-label': props.ariaLabel,
      }, props.children);
    }

    function Badge(props) {
      return h('span', { style: mergeStyle(styles.badge, badgeStyle(props.tone)) }, props.children);
    }

    function StatCard(props) {
      return h('div', { style: styles.card },
        h('div', { style: styles.cardLabel }, props.label),
        h('div', { style: styles.cardValue }, props.value),
        props.sub ? h('div', { style: styles.cardSub }, props.sub) : null);
    }

    function SectionHead(props) {
      return h('div', { style: styles.sectionHead },
        h('div', { style: styles.sectionTitle }, props.title),
        h('div', { style: styles.sectionMeta }, props.meta));
    }

    function EmptyState(props) {
      return h('div', { style: styles.empty }, props.text);
    }

    function LoadingRow(props) {
      return h('div', { style: styles.loading }, props.text);
    }

    function ErrorRow(props) {
      return h('div', { style: styles.errorRow, role: 'alert' },
        h('span', null, props.text),
        h(Button, { small: true, onClick: props.onRetry }, props.retryLabel));
    }

    function Field(props) {
      if (props.value === null || props.value === undefined || props.value === '') return null;
      return h('div', { style: styles.field },
        h('div', { style: styles.fieldLabel }, props.label),
        h('div', { style: styles.fieldValue }, props.value));
    }

    function BulletList(props) {
      const items = list(props.items).filter((item) => typeof item === 'string' && item.length > 0);
      if (items.length === 0) return null;
      return h('ul', { style: styles.list }, items.map((item, index) => h('li', { key: String(index) }, item)));
    }

    function Snippet(props) {
      if (typeof props.text !== 'string' || props.text.length === 0) return null;
      return h('pre', { style: styles.pre }, props.text);
    }

    // ---------------------------------------------------------------------------------------
    // network
    // ---------------------------------------------------------------------------------------
    async function readPayload(response) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || !isRecord(payload) || payload.ok === false) {
        const error = new Error(
          isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
            ? payload.error.message
            : 'HTTP ' + String(response.status),
        );
        error.status = response.status;
        // A handled refusal (e.g. a revert conflict) still carries its reason on the body.
        error.payload = payload;
        throw error;
      }
      return payload;
    }

    async function fetchJson(path) {
      const response = await fetch(API_BASE + path, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
      });
      return readPayload(response);
    }

    async function postJson(path, body) {
      const response = await fetch(API_BASE + path, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        body: JSON.stringify(body === undefined ? {} : body),
      });
      return readPayload(response);
    }

    function episodesQuery(mismatchOnly) {
      const params = ['limit=20'];
      if (mismatchOnly === true) params.push('filter=mismatch');
      return 'episodes?' + params.join('&');
    }

    // ---------------------------------------------------------------------------------------
    // dashboard sections
    // ---------------------------------------------------------------------------------------
    function OverviewCards(props) {
      const t = props.t;
      const overall = record(props.overall);
      const dream = record(props.dream);
      const spent = number(overall.probeTokens, 0) + number(overall.judgeTokens, 0);
      const nextDream = dream.enabled === false
        ? t('panel.scheduleOff')
        : formatTime(dream.nextRunAt, t, 'panel.never');
      const lastDream = formatTime(dream.lastRunAt, t, 'panel.never');
      return h('div', { style: styles.cards },
        h(StatCard, {
          label: t('panel.consciousness'),
          value: String(number(overall.consciousness, 0)),
          sub: t('panel.confidence') + ': ' + t('panel.' + confidenceKey(overall.confidence)),
        }),
        h(StatCard, {
          label: t('panel.judged'),
          value: formatInteger(overall.judged),
          sub: t('panel.episodeCount', { count: formatInteger(overall.episodes) }),
        }),
        h(StatCard, {
          label: t('panel.wasteRate'),
          value: percent(overall.wasteRate),
          sub: formatTokens(overall.wastedTokens) + ' ' + t('panel.tokens'),
        }),
        h(StatCard, {
          label: t('panel.spent'),
          value: formatTokens(spent),
          sub: t('panel.spendDetail', {
            probe: formatTokens(overall.probeTokens),
            judge: formatTokens(overall.judgeTokens),
          }),
        }),
        h(StatCard, {
          label: t('panel.avoided'),
          value: formatTokens(overall.estimatedWasteAvoided),
          sub: t('panel.estimate'),
        }),
        h(StatCard, {
          label: t('panel.nextDream'),
          value: nextDream,
          sub: t('panel.lastDream') + ': ' + lastDream,
        }));
    }

    function SkillTable(props) {
      const t = props.t;
      const skills = list(props.skills);
      if (skills.length === 0) return h(EmptyState, { text: t('panel.skillsEmpty') });
      const head = (label, numeric) => h('th', { style: mergeStyle(styles.th, numeric ? { textAlign: 'right' } : null) }, label);
      return h('div', { style: styles.tableWrap },
        h('table', { style: styles.table },
          h('thead', null,
            h('tr', null,
              head(t('panel.skill')),
              head(t('panel.loads'), true),
              head(t('panel.awareness')),
              head(t('panel.fitAccuracy'), true),
              head(t('panel.boundaryAccuracy'), true),
              head(t('panel.waste'), true),
              head(t('panel.trend'), true),
              head(t('panel.lastUsed'), true),
              head(t('panel.edits'), true))),
          h('tbody', null, skills.map((entry, index) => {
            const skill = record(entry);
            const name = text(skill.name, t('panel.unknown'));
            const source = text(skill.source, '');
            const trend = number(skill.trend, 0);
            return h('tr', { key: name + ':' + String(index) },
              h('td', { style: styles.td },
                h('div', { style: styles.skillCell },
                  h('div', { style: styles.skillName, title: name }, name),
                  source ? h('div', { style: styles.skillMeta }, source) : null)),
              h('td', { style: styles.tdNum }, formatInteger(skill.loads)),
              h('td', { style: styles.td },
                h('div', { style: styles.barRow },
                  h('div', { style: styles.barTrack },
                    h('div', { style: mergeStyle(styles.barFill, { width: percent(skill.consciousness) }) })),
                  h('span', { style: styles.barValue }, String(number(skill.consciousness, 0))))),
              h('td', { style: styles.tdNum }, percent(skill.fitAccuracy)),
              h('td', { style: styles.tdNum }, percent(skill.boundaryAccuracy)),
              h('td', { style: styles.tdNum }, percent(skill.wasteRate)),
              h('td', {
                style: mergeStyle(styles.tdNum, {
                  color: trend > 0
                    ? 'var(--dsw-alias-state-success-primary)'
                    : trend < 0 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)',
                }),
              }, (trend > 0 ? '+' : '') + fixed(trend, 1)),
              h('td', { style: styles.tdNum }, formatTime(skill.lastUsedAt, t, 'panel.never')),
              h('td', { style: styles.tdNum }, formatInteger(skill.appliedEdits)));
          }))));
    }

    function EpisodeDetail(props) {
      const t = props.t;
      const episode = record(props.episode);
      const prediction = isRecord(episode.prediction) ? episode.prediction : null;
      const judge = isRecord(episode.judge) ? episode.judge : null;
      const trace = isRecord(episode.trace) ? episode.trace : null;
      const probe = isRecord(episode.probe) ? episode.probe : null;
      const cost = record(episode.cost);
      const gap = judge !== null && isRecord(judge.capabilityGap) ? judge.capabilityGap : null;
      const recommendation = judge !== null && isRecord(judge.recommendation) ? judge.recommendation : null;
      const mismatches = judge === null ? [] : list(judge.mismatches);
      const predictionBlock = h('div', { style: styles.block },
        h('div', { style: styles.blockTitle }, t('panel.prediction')),
        prediction === null
          ? h('div', { style: styles.fieldValue }, t('panel.unknown'))
          : h(React.Fragment, null,
            h(Field, { label: t('panel.fit'), value: percent(prediction.fit) }),
            h(Field, { label: t('panel.confidence'), value: percent(prediction.confidence) }),
            h(Field, { label: t('panel.probeExpectation'), value: text(prediction.intent, '') }),
            h('div', { style: styles.field },
              h(BulletList, { items: prediction.expectedUse })),
            list(prediction.likelyPitfalls).length > 0 ? h('div', { style: styles.field },
              h('div', { style: styles.fieldLabel }, t('panel.pitfalls')),
              h(BulletList, { items: prediction.likelyPitfalls })) : null,
            h(Field, { label: t('panel.capabilityGap'), value: text(prediction.capabilityGap, '') }),
            h(Field, { label: t('panel.expectedValue'), value: number(prediction.expectedValueTokens, 0) > 0 ? formatTokens(prediction.expectedValueTokens) : '' })));
      const judgeBlock = h('div', { style: styles.block },
        h('div', { style: styles.blockTitle }, t('panel.judge')),
        judge === null
          ? h('div', { style: styles.fieldValue }, t('panel.unknown'))
          : h(React.Fragment, null,
            h('div', { style: styles.field },
              h('div', { style: styles.fieldLabel }, t('panel.verdict')),
              h('div', null,
                h(Badge, { tone: verdictTone(judge.verdict) }, t(verdictKey(judge.verdict))),
                ' ',
                h('span', { style: styles.fieldValue }, t('panel.scoreOf', { score: number(judge.score, 0) })))),
            h(Field, { label: t('panel.predictionAccuracy'), value: percent(judge.predictionAccuracy) }),
            gap === null ? null : h('div', { style: styles.field },
              h('div', { style: styles.fieldLabel }, t('panel.capabilityGap')),
              h('div', { style: styles.fieldValue }, t('panel.claim') + ': ' + text(gap.claim, '—')),
              h('div', { style: styles.fieldValue }, t('panel.reality') + ': ' + text(gap.reality, '—'))),
            h(Field, { label: t('panel.rootCause'), value: text(judge.rootCause, '') }),
            h(Field, { label: t('panel.rule'), value: text(judge.reusableRule, '') }),
            list(judge.mismatches).length > 0 ? h('div', { style: styles.field },
              h('div', { style: styles.fieldLabel }, t('panel.mismatches')),
              h('ul', { style: styles.list }, mismatches.map((entry, index) => {
                const mismatch = record(entry);
                return h('li', { key: String(index) },
                  t('panel.expected') + ': ' + text(mismatch.expected, '—') + ' · '
                  + t('panel.observed') + ': ' + text(mismatch.observed, '—') + ' · '
                  + t('panel.cause') + ': ' + text(mismatch.cause, '—'));
              }))) : null,
            recommendation === null ? null : h('div', { style: styles.field },
              h('div', { style: styles.fieldLabel }, t('panel.recommendation')),
              text(recommendation.descriptionEdit, '') ? h(Field, {
                label: t('panel.descriptionEdit'),
                value: text(recommendation.descriptionEdit, ''),
              }) : null,
              text(recommendation.bodyAddition, '') ? h(Snippet, { text: recommendation.bodyAddition }) : null,
              text(recommendation.selectionRule, '') ? h(Field, {
                label: t('panel.selectionRule'),
                value: text(recommendation.selectionRule, ''),
              }) : null)));
      const traceBlock = h('div', { style: styles.block },
        h('div', { style: styles.blockTitle }, t('panel.trace')),
        trace === null
          ? h('div', { style: styles.fieldValue }, t('panel.unknown'))
          : h(React.Fragment, null,
            h(Field, { label: t('panel.turnEnd'), value: turnEndLabel(trace.turnEnd, t) }),
            h(Field, { label: t('panel.observedFor'), value: formatDuration(trace.observedMs, t) }),
            h(Field, { label: t('panel.skillReloaded'), value: trace.skillReLoaded === true ? t('panel.yes') : t('panel.no') }),
            h(Field, { label: t('panel.finalAnswerChars'), value: formatInteger(trace.finalAnswerChars) }),
            list(trace.assistantTexts).length > 0 ? h('div', { style: styles.field },
              h('div', { style: styles.fieldLabel }, t('panel.assistantMessages')),
              list(trace.assistantTexts).map((entry, index) => h(Snippet, { key: 'a' + String(index), text: text(entry, '') }))) : null,
            list(trace.userMessages).length > 0 ? h('div', { style: styles.field },
              h('div', { style: styles.fieldLabel }, t('panel.userMessages')),
              list(trace.userMessages).map((entry, index) => h(Snippet, { key: 'u' + String(index), text: text(entry, '') }))) : null,
            list(trace.toolSequence).length > 0 ? h('div', { style: styles.field },
              h('div', { style: styles.fieldLabel }, t('panel.toolCalls')),
              list(trace.toolSequence).map((entry, index) => {
                const tool = record(entry);
                return h('div', { key: 't' + String(index), style: styles.toolRow },
                  h('span', {
                    style: {
                      flex: 'none',
                      color: tool.ok === false
                        ? 'var(--dsw-alias-state-error-primary)'
                        : 'var(--dsw-alias-label-tertiary)',
                    },
                  }, tool.ok === false ? '✗' : '✓'),
                  h('span', { style: styles.toolName }, text(tool.name, t('panel.unknown'))),
                  h('span', { style: styles.toolBrief }, text(tool.brief, '')));
              })) : null,
            probe === null ? null : h(Field, { label: t('panel.probe'), value: probeStatusLabel(probe.status, t) + (text(probe.backend, '') ? ' · ' + modeLabel(probe.backend, t) : '') }),
            h(Field, {
              label: t('panel.spent'),
              value: t('panel.tokenCount', { count: formatInteger(number(cost.probe, 0) + number(cost.judge, 0)) }),
            })));
      return h('div', { style: styles.episodeBody },
        h('div', { style: styles.grid }, predictionBlock, judgeBlock),
        traceBlock);
    }

    function EpisodesPanel(props) {
      const t = props.t;
      const episodes = list(props.episodes);
      const expandedId = props.expandedId;
      const filters = h('div', { style: styles.sectionFilters },
        h('button', {
          type: 'button',
          style: mergeStyle(styles.filterButton, props.mismatchOnly !== true ? styles.filterButtonActive : null),
          'aria-pressed': props.mismatchOnly === true ? 'false' : 'true',
          onClick: () => props.onFilter(false),
        }, t('panel.filterAll')),
        h('button', {
          type: 'button',
          style: mergeStyle(styles.filterButton, props.mismatchOnly === true ? styles.filterButtonActive : null),
          'aria-pressed': props.mismatchOnly === true ? 'true' : 'false',
          onClick: () => props.onFilter(true),
        }, t('panel.filterMismatch')));
      return h('div', { style: styles.section },
        h('div', { style: styles.sectionHead },
          h('div', { style: styles.sectionTitle }, t('panel.episodes')),
          filters),
        episodes.length === 0
          ? h(EmptyState, { text: t('panel.episodeEmpty') })
          : h('div', { style: styles.episodeList }, episodes.map((entry, index) => {
            const episode = record(entry);
            const id = text(episode.id, 'episode-' + String(index));
            const open = expandedId === id;
            const judge = isRecord(episode.judge) ? episode.judge : null;
            return h('div', { key: id, style: styles.episodeItem },
              h('button', {
                type: 'button',
                style: styles.episodeHead,
                'aria-expanded': open ? 'true' : 'false',
                title: open ? t('panel.hide') : t('panel.details'),
                onClick: () => props.onToggle(id),
              },
              h('span', { style: styles.episodeTime }, formatTime(episode.startedAt, t, 'panel.never')),
              h('span', { style: styles.episodeSkill }, text(episode.skill, t('panel.unknown'))),
              judge === null
                ? h(Badge, { tone: 'neutral' }, t('panel.unknown'))
                : h(Badge, { tone: verdictTone(judge.verdict) }, t(verdictKey(judge.verdict))),
              h('span', { style: styles.episodeScore }, judge === null ? '' : String(number(judge.score, 0))),
              h('span', { style: styles.episodeState },
                number(episode.turn, 0) > 0 ? 'T' + String(number(episode.turn, 0)) : ''),
              h('span', { style: styles.chevron }, open ? '▾' : '▸')),
              open ? h(EpisodeDetail, { t: t, episode: episode }) : null);
          })));
    }

    function DreamJournal(props) {
      const t = props.t;
      const runs = list(props.dreams);
      const editsById = isRecord(props.editsById) ? props.editsById : {};
      const revertingId = props.revertingId;
      const onRevert = props.onRevert;
      if (runs.length === 0) return h(EmptyState, { text: t('panel.dreamEmpty') });
      return h('div', { style: styles.journal }, runs.map((entry, runIndex) => {
        const run = record(entry);
        const id = text(run.id, 'dream-' + String(runIndex));
        const skills = list(run.skills);
        const before = record(run.before);
        const after = record(run.afterEstimate);
        const tokens = record(run.tokens);
        return h('div', { key: id, style: styles.journalRun },
          h('div', { style: styles.journalHead },
            h('span', { style: styles.journalWhen }, formatTime(run.startedAt, t, 'panel.never')),
            h(Badge, { tone: statusTone(run.status) }, runStatusLabel(run.status, t)),
            h('span', { style: styles.journalMeta },
              t('panel.mode') + ': ' + modeLabel(run.mode, t) + ' · '
              + t('panel.trigger') + ': ' + triggerLabel(run.trigger, t) + ' · '
              + t('panel.caseCount', { count: formatInteger(run.cases) }) + ' · '
              + t('panel.dreamSpend') + ': ' + t('panel.tokenCount', {
                count: formatInteger(number(tokens.in, 0) + number(tokens.out, 0)),
              })),
            h('span', { style: mergeStyle(styles.journalMeta, { marginLeft: 'auto' }) },
              t('panel.before') + ': ' + String(number(before.consciousness, 0)) + ' · '
              + t('panel.afterEstimate') + ': ' + String(number(after.consciousness, 0)))),
          text(run.error, '') ? h('div', { style: styles.errorRow }, text(run.error, '')) : null,
          skills.length === 0
            ? h('div', { style: styles.journalMeta }, t('panel.noEdits'))
            : skills.map((skillEntry, skillIndex) => {
              const skill = record(skillEntry);
              const status = text(skill.status, 'suggested');
              const proposal = isRecord(skill.proposal) ? skill.proposal : null;
              return h('div', { key: id + ':' + String(skillIndex), style: styles.journalSkill },
                h('div', { style: styles.journalSkillHead },
                  h('span', { style: styles.journalSkillName }, text(skill.skill, t('panel.unknown'))),
                  h(Badge, { tone: statusTone(status) }, t('panel.' + (status === 'applied' ? 'applied' : status === 'rejected' ? 'rejected' : 'suggested'))),
                  proposal === null || number(proposal.confidence, 0) === 0 ? null
                    : h('span', { style: styles.journalMeta }, t('panel.confidence') + ': ' + percent(proposal.confidence)),
                  text(skill.rejectionReason, '') ? h('span', { style: styles.journalMeta }, text(skill.rejectionReason, '')) : null,
                  h('div', { style: styles.journalActions },
                    list(skill.editIds).length === 0 ? null : list(skill.editIds).map((editId) => {
                      const edit = record(editsById[editId]);
                      const hasEdit = isRecord(editsById[editId]);
                      const editStatus = text(edit.status, 'applied');
                      const busy = revertingId === editId;
                      return h('div', { key: String(editId), style: styles.editRow },
                        h('span', null,
                          t('panel.editKind') + ': ' + kindLabel(edit.kind, t) + ' · '
                          + t('panel.status') + ': ' + editStatusLabel(editStatus, t) + ' · '
                          + t('panel.backup') + ': ' + (edit.hasBackup === false ? t('panel.backupMissing') : t('panel.yes'))),
                        editStatus !== 'applied' || !hasEdit
                          ? null
                          : h(Button, {
                            small: true,
                            disabled: busy,
                            onClick: () => onRevert(editId),
                          }, busy ? t('panel.reverting') : t('panel.revert')));
                    }))),
                text(proposal?.descriptionEdit, '') ? h(Field, {
                  label: t('panel.descriptionEdit'),
                  value: text(proposal.descriptionEdit, ''),
                }) : null,
                text(proposal?.bodyAddition, '') ? h(Snippet, { text: proposal.bodyAddition }) : null,
                text(proposal?.selectionRule, '') ? h(Field, {
                  label: t('panel.selectionRule'),
                  value: text(proposal.selectionRule, ''),
                }) : null);
            }));
      }));
    }

    // ---------------------------------------------------------------------------------------
    // page
    // ---------------------------------------------------------------------------------------
    function DreamingPage(props) {
      const t = props.t;
      const [data, setData] = React.useState({
        loading: true,
        refreshing: false,
        error: false,
        summary: null,
        episodes: null,
        dreams: null,
        edits: null,
      });
      const [mismatchOnly, setMismatchOnly] = React.useState(false);
      const [expandedId, setExpandedId] = React.useState(null);
      const [dreaming, setDreaming] = React.useState(false);
      const [revertingId, setRevertingId] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const mountedRef = React.useRef(true);
      const requestRef = React.useRef(0);
      const episodeRequestRef = React.useRef(0);
      const mismatchRef = React.useRef(false);
      const busyRef = React.useRef(false);

      React.useEffect(() => {
        busyRef.current = dreaming || revertingId !== null;
      }, [dreaming, revertingId]);

      const loadAll = React.useCallback(async (silent) => {
        const request = ++requestRef.current;
        const filterAtStart = mismatchRef.current;
        if (!silent) {
          setData((previous) => ({ ...previous, loading: previous.summary === null, refreshing: previous.summary !== null }));
        }
        const results = await Promise.allSettled([
          fetchJson('summary'),
          fetchJson(episodesQuery(filterAtStart)),
          fetchJson('dreams?limit=10'),
          fetchJson('edits?limit=100'),
        ]);
        if (!mountedRef.current || request !== requestRef.current) return;
        const [summary, episodes, dreams, edits] = results;
        const failed = results.some((result) => result.status === 'rejected');
        setData((previous) => ({
          ...previous,
          loading: false,
          refreshing: false,
          error: failed,
          summary: summary.status === 'fulfilled' ? summary.value : previous.summary,
          // A filter change while this request was in flight makes its episode page
          // stale; keep the newer episode request's result instead of overwriting it.
          episodes: episodes.status === 'fulfilled' && filterAtStart === mismatchRef.current
            ? episodes.value
            : previous.episodes,
          dreams: dreams.status === 'fulfilled' ? dreams.value : previous.dreams,
          edits: edits.status === 'fulfilled' ? edits.value : previous.edits,
        }));
      }, []);

      const loadEpisodes = React.useCallback(async () => {
        const request = ++episodeRequestRef.current;
        try {
          const payload = await fetchJson(episodesQuery(mismatchRef.current));
          if (!mountedRef.current || request !== episodeRequestRef.current) return;
          setData((previous) => ({ ...previous, episodes: payload }));
        } catch {
          if (!mountedRef.current || request !== episodeRequestRef.current) return;
          setData((previous) => ({ ...previous, error: true }));
        }
      }, []);

      React.useEffect(() => {
        mountedRef.current = true;
        loadAll(false);
        const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
        const timer = setInterval(() => {
          if (visible() && !busyRef.current) loadAll(true);
        }, POLL_MS);
        const onVisibility = () => {
          if (visible()) loadAll(true);
        };
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibility);
        }
        return () => {
          mountedRef.current = false;
          clearInterval(timer);
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVisibility);
          }
        };
      }, [loadAll]);

      const onFilter = (nextMismatch) => {
        if (mismatchRef.current === nextMismatch) return;
        mismatchRef.current = nextMismatch;
        setMismatchOnly(nextMismatch);
        loadEpisodes();
      };

      const onToggleEpisode = (id) => {
        setExpandedId((previous) => (previous === id ? null : id));
      };

      const onDreamNow = async () => {
        if (dreaming === true) return;
        setDreaming(true);
        setNotice(null);
        try {
          await postJson('dream/run', {});
          if (!mountedRef.current) return;
          setNotice({ tone: 'success', key: 'panel.dreamStarted' });
          await loadAll(true);
        } catch (error) {
          if (!mountedRef.current) return;
          const status = isRecord(error) ? number(error.status, 0) : 0;
          setNotice({
            tone: 'error',
            key: status === 409 ? 'panel.dreamBusy' : status === 503 ? 'panel.dreamUnavailable' : 'panel.dreamFailed',
          });
        } finally {
          if (mountedRef.current) setDreaming(false);
        }
      };

      const onRevert = async (editId) => {
        if (revertingId !== null) return;
        setRevertingId(editId);
        setNotice(null);
        try {
          const payload = await postJson('edits/revert', { editId: editId });
          if (!mountedRef.current) return;
          if (payload.ok === true) {
            setNotice({ tone: 'success', key: 'panel.reverted' });
          } else if (payload.reason === 'conflict'
            || payload.reason === 'hash-mismatch'
            || payload.reason === 'changed'
            || payload.reason === 'missing-file') {
            setNotice({ tone: 'error', key: 'panel.revertConflict' });
          } else {
            setNotice({ tone: 'error', key: 'panel.revertFailed' });
          }
          await loadAll(true);
        } catch (error) {
          if (!mountedRef.current) return;
          const status = isRecord(error) ? number(error.status, 0) : 0;
          const refusal = isRecord(error) && isRecord(error.payload) ? error.payload.reason : null;
          const conflict = refusal === 'conflict'
            || refusal === 'hash-mismatch'
            || refusal === 'changed'
            || refusal === 'missing-file';
          setNotice({
            tone: 'error',
            key: conflict
              ? 'panel.revertConflict'
              : status === 404 || status === 409
                ? 'panel.revertConflict'
                : 'panel.revertFailed',
          });
        } finally {
          if (mountedRef.current) setRevertingId(null);
        }
      };

      const summary = isRecord(data.summary) ? data.summary : null;
      const overall = summary === null ? {} : record(summary.overall);
      const skills = summary === null ? [] : list(summary.skills);
      const dream = summary === null ? {} : record(summary.dream);
      const storeInfo = summary === null ? {} : record(summary.store);
      const episodes = data.episodes === null ? [] : list(record(data.episodes).items);
      const dreams = data.dreams === null ? [] : list(record(data.dreams).items);
      const edits = data.edits === null ? [] : list(record(data.edits).items);
      const editsById = {};
      for (let index = 0; index < edits.length; index += 1) {
        const edit = record(edits[index]);
        const editId = text(edit.id, '');
        if (editId) editsById[editId] = edit;
      }
      const generatedAt = summary === null ? 0 : toMillis(summary.generatedAt);
      const busy = dreaming || revertingId !== null;

      if (data.loading === true && summary === null) {
        return h('div', { style: styles.root }, h(LoadingRow, { text: t('panel.loading') }));
      }

      const notices = notice === null ? null : h('div', {
        style: mergeStyle(
          styles.notice,
          notice.tone === 'error' ? { background: 'var(--dsw-alias-state-warn-tertiary)' } : { background: 'var(--dsw-alias-bg-layer-1)' },
        ),
        role: 'status',
      }, t(notice.key));

      return h('div', { style: styles.root },
        h('div', { style: styles.toolbar },
          h('div', { style: styles.toolbarText },
            h('div', { style: styles.subtitle }, t('panel.subtitle')),
            generatedAt > 0 ? h('div', { style: styles.footer }, t('panel.generated', {
              time: formatTime(generatedAt, t, 'panel.never'),
            })) : null),
          h('div', { style: styles.toolbarActions },
            h(Button, {
              onClick: () => loadAll(false),
              disabled: data.refreshing === true || busy,
            }, t('panel.refresh')),
            h(Button, {
              tone: 'primary',
              onClick: onDreamNow,
              disabled: dreaming || dream.running === true,
            }, dreaming ? t('panel.dreaming') : t('panel.dreamNow')))),
        notices,
        data.error === true
          ? h(ErrorRow, {
            text: t('panel.error'),
            retryLabel: t('panel.retry'),
            onRetry: () => loadAll(false),
          })
          : null,
        storeInfo.ready === false
          ? h('div', { style: styles.storeBanner }, t('panel.storeOffline'))
          : null,
        summary === null
          ? h(EmptyState, { text: t('panel.noData') })
          : h(React.Fragment, null,
            h(OverviewCards, { t: t, overall: overall, dream: dream }),
            h('div', { style: styles.section },
              h(SectionHead, {
                title: t('panel.skills'),
                meta: t('panel.skillCount', { count: formatInteger(skills.length) }),
              }),
              h(SkillTable, { t: t, skills: skills })),
            h(EpisodesPanel, {
              t: t,
              episodes: episodes,
              mismatchOnly: mismatchOnly,
              expandedId: expandedId,
              onFilter: onFilter,
              onToggle: onToggleEpisode,
            }),
            h('div', { style: styles.section },
              h(SectionHead, {
                title: t('panel.dreamJournal'),
                meta: t('panel.dreamSpend') + ': ' + t('panel.tokenCount', {
                  count: formatInteger(number(overall.dreamTokens, 0)),
                }),
              }),
              h(DreamJournal, {
                t: t,
                dreams: dreams,
                editsById: editsById,
                revertingId: revertingId,
                onRevert: onRevert,
              }))));
    }

    function DreamingRoot(props) {
      const [language, setLanguage] = React.useState(() => detectLanguage(props.ctx));
      React.useEffect(() => {
        let dispose = null;
        try {
          const locale = typeof props.ctx?.get === 'function' ? props.ctx.get('locale') : undefined;
          if (typeof locale?.subscribe === 'function') {
            dispose = locale.subscribe(() => setLanguage(detectLanguage(props.ctx)));
          }
        } catch {
          dispose = null;
        }
        return () => {
          try {
            if (typeof dispose === 'function') dispose();
          } catch {
            // The client root may already be disposed during teardown.
          }
        };
      }, [props.ctx]);
      const t = React.useMemo(() => makeTranslator(language), [language]);
      return h(DreamingPage, { t: t, close: props.close });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dreaming',
          order: 95,
          label: () => makeTranslator(detectLanguage(ctx))('panel.title'),
        }, (props) => h(DreamingRoot, { ...props, ctx: ctx })));
        // The host locale is optional: register dictionaries when available so a
        // future locale-aware slot composition can resolve the namespace by name.
        try {
          const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
          if (typeof locale?.register === 'function') {
            const dispose = locale.register(NS, { zh: zh, en: en });
            if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
              ctx.effect(() => dispose, NS + ': dictionaries');
            }
          }
        } catch {
          // The inline dictionaries still translate the page without the service.
        }
      },
    };
  },
});
