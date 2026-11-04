/**
 * dsh-token-board — client half.
 *
 * Four surfaces, three of them fed by one shared 1s poller
 * (`GET /token-board/v1/stats`):
 *
 *   · sidebar.footer.action               — activity bars + «N 会话进行中，X tok/s»
 *                                            summary above the account row (rail: icon
 *                                            only, hover opens the summary bubble);
 *                                            clicking it opens the full usage panel;
 *   · sidebar.session.row.hover           — per-agent tok/s inside the Session
 *                                            row's dark hover card;
 *   · conversation.session.header.actions   — the opened session's total tok/s
 *                                            pill, with a hover/focus popover that
 *                                            lists every tracked agent, plus a
 *                                            line-chart icon right beside it whose
 *                                            hover shows the sampled tps history;
 *   · main (keyed: `token-board-stats`)    — the full «使用统计» panel, fetched on
 *                                            mount from `GET /token-board/v1/usage`
 *                                            (the reference dashboard UI).
 *
 * Plain browser artifact: no JSX, no imports beyond `react` / `react-dom`.
 * The host may be absent or partially rendered at any time, so every DOM read
 * is defensive and the module never throws from a render path.
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-board',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const reactDom = require('react-dom')
    const h = react.createElement
    // Shims consumed by the generated usage-panel block below (the reference UI
    // was written as TSX against these React APIs; only react/react-dom ship).
    const Fragment = react.Fragment
    const createPortal = reactDom.createPortal
    const { useState, useEffect, useMemo, useRef, useCallback } = react

    const inject = ['slots', 'layout']
    const API_PATH = '/token-board/v1'
    const PANEL_ID = 'token-board-stats'
    const POLL_MS = 1000
    const POPOVER_FALLBACK_WIDTH = 220
    const TIP_FALLBACK_WIDTH = 180
    const POPOVER_MAX_ROWS = 12
    const POPOVER_ID = 'tb-throughput-popover'
    // Header speed-history chart: one sample per poll (1s) while the session is
    // active; idle seconds are skipped, so the curve breaks across idle spans.
    const CHART_POP_ID = 'tb-throughput-chart'
    const HISTORY_GAP_MS = 2500
    const HISTORY_MAX_SAMPLES = 7200
    const CHART_WIDTH = 340
    const CHART_HEIGHT = 180
    const CHART_PAD = { top: 12, right: 12, bottom: 22, left: 42 }
    const CHART_FALLBACK_WIDTH = 352
    const CHART_FALLBACK_HEIGHT = 210

    const language = String((typeof navigator !== 'undefined' && navigator && navigator.language) || '')
    const zh = language.toLowerCase().indexOf('zh') === 0
    const L = zh
      ? {
          mainAgent: '主 Agent',
          subAgent: '子 Agent',
          streaming: '出字中',
          running: '等待模型',
          tool: '工具调用',
          retrying: '重试中',
          idle: '空闲',
          total: '会话总吞吐',
          summary: (sessions, tps) => sessions + ' 会话进行中，' + tps + ' tok/s',
          active: '进行中',
          sum: '合计',
          noActivity: '暂无活动',
          chartTitle: '速度历史',
          chartEmpty: '暂无速度记录',
          chartSamples: (count) => count + ' 个采样',
          chartPeak: '峰值',
        }
      : {
          mainAgent: 'Main Agent',
          subAgent: 'Sub Agent',
          streaming: 'Streaming',
          running: 'Waiting for model',
          tool: 'Tool call',
          retrying: 'Retrying',
          idle: 'Idle',
          total: 'Session throughput',
          summary: (sessions, tps) => sessions + ' active · ' + tps + ' tok/s',
          active: 'Active',
          sum: 'total',
          noActivity: 'No activity',
          chartTitle: 'Speed history',
          chartEmpty: 'No speed samples yet',
          chartSamples: (count) => count + ' samples',
          chartPeak: 'Peak',
        }

    /**
     * `ctx.layout.selectPanel` face, installed by apply(). Guarded: the real
     * layout controller throws when a main panel is not registered, and a click
     * handler must never throw (worst case the navigation is a no-op).
     */
    let panelSelect = null
    function selectMainPanel(panelId) {
      if (typeof panelSelect !== 'function') return
      try {
        panelSelect(panelId)
      } catch {
        /* layout or panel not ready — ignore */
      }
    }

    // ==== generated usage panel — BEGIN =====================================
    // One-off esbuild output from the adapted reference dashboard
    // (.tmp/board/ref-usage-board/src/client/{index.tsx,i18n.ts,styles.ts}),
    // JSX→JS via jsxFactory h / jsxFragment Fragment. It closes over: h,
    // Fragment, createPortal, the React hooks destructured above, `zh`
    // (navigator language is Chinese) and selectMainPanel(id).
    // Do not hand-edit this block; the hand-written plugin code follows it.
    const DICT_ZH = {
      nav: "使用统计",
      title: "使用统计",
      appUsage: "token用量",
      back: "返回对话",
      noData: "暂无数据",
      loadError: "统计数据暂时无法读取",
      loading: "正在建立本地增量索引…",
      tokenUnit: "Token",
      daysUnit: "天",
      hourMinute: "{h} 小时 {m} 分",
      minutesOnly: "{m} 分钟",
      subMinute: "1 分钟以内",
      dayHour: "{d} 天 {h} 小时",
      statTokens: "累计 Token 数",
      statTokensDetail: "输入、输出与缓存合计",
      statPeak: "峰值 Token 数",
      statPeakDetail: "单日最高 Token 消耗",
      statLongestChat: "最长聊天时长",
      statLongestChatDetail: "单次会话首末事件间隔",
      statCurrentStreak: "当前连续天数",
      statLongestStreak: "最长连续天数",
      activityTitle: "Token 活动",
      yearLabel: "年份",
      themeLabel: "主题",
      modeDaily: "每日",
      modeWeekly: "每周",
      modeMonthly: "每月",
      modeCumulative: "累计",
      less: "Less",
      more: "More",
      mon: "一",
      wed: "三",
      fri: "五",
      callsSuffix: "轮",
      dayDetail: "{date} · {tokens} {token} · {calls} {callsUnit}",
      weekDetail: "{range} · {tokens} {token}",
      monthDetail: "{month} · {tokens} {token}",
      cumulativeDetail: "{date} · 累计 {tokens} {token}",
      insightsTitle: "活动洞察",
      fastMode: "快速模式",
      fastModeDetail: "命中快速模型（flash/turbo 等）的调用占比",
      topEffort: "最常用的推理强度",
      skillsExplored: "已探索的技能",
      skillsTotal: "使用的技能总数",
      totalChats: "聊天总数",
      skillsTitle: "最常用的技能",
      runsSuffix: "次运行",
      modelShareTitle: "模型 Token 占比",
      modelShareNote: "全部历史 · 输入、输出与缓存合计",
      otherModel: "其他",
      modelDetail: "{name} · {tokens} {token} · {percent}%",
      peakPercent: "{percent}%",
      effortOff: "关闭",
      effortLow: "低",
      effortMedium: "中",
      effortHigh: "高",
      effortXhigh: "极高",
      effortUltra: "超高",
      effortMax: "极高"
    };
    const DICT_EN = {
      nav: "Usage Stats",
      title: "Usage Stats",
      appUsage: "Token Usage",
      back: "Back to chat",
      noData: "No data",
      loadError: "Unable to load usage stats",
      loading: "Building local index…",
      tokenUnit: "tokens",
      daysUnit: "days",
      hourMinute: "{h}h {m}m",
      minutesOnly: "{m}m",
      subMinute: "<1m",
      dayHour: "{d}d {h}h",
      statTokens: "Total Tokens",
      statTokensDetail: "Input, output and cache combined",
      statPeak: "Peak Tokens",
      statPeakDetail: "Highest single-day token total",
      statLongestChat: "Longest Chat",
      statLongestChatDetail: "First-to-last event span of a session",
      statCurrentStreak: "Current Streak",
      statLongestStreak: "Longest Streak",
      activityTitle: "Token Activity",
      yearLabel: "Year",
      themeLabel: "Theme",
      modeDaily: "Daily",
      modeWeekly: "Weekly",
      modeMonthly: "Monthly",
      modeCumulative: "Cumulative",
      less: "Less",
      more: "More",
      mon: "M",
      wed: "W",
      fri: "F",
      callsSuffix: "calls",
      dayDetail: "{date} · {tokens} {token} · {calls} {callsUnit}",
      weekDetail: "{range} · {tokens} {token}",
      monthDetail: "{month} · {tokens} {token}",
      cumulativeDetail: "{date} · {tokens} {token} total",
      insightsTitle: "Activity Insights",
      fastMode: "Fast mode",
      fastModeDetail: "Share of calls hitting fast models (flash/turbo etc.)",
      topEffort: "Top reasoning effort",
      skillsExplored: "Skills explored",
      skillsTotal: "Skill invocations",
      totalChats: "Total chats",
      skillsTitle: "Most Used Skills",
      runsSuffix: "runs",
      modelShareTitle: "Tokens by Model",
      modelShareNote: "All time · input, output and cache",
      otherModel: "Other",
      modelDetail: "{name} · {tokens} {token} · {percent}%",
      peakPercent: "{percent}%",
      effortOff: "Off",
      effortLow: "Low",
      effortMedium: "Medium",
      effortHigh: "High",
      effortXhigh: "Extreme",
      effortUltra: "Ultra",
      effortMax: "Extreme"
    };
    const DICTIONARIES = { zh: DICT_ZH, en: DICT_EN };
    function activeLanguage() {
      return zh ? "zh" : "en";
    }
    function translate(lang, key, vars) {
      let text = DICTIONARIES[lang][key];
      if (vars !== void 0) {
        for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
      }
      return text;
    }
    function formatDateLabel(date, lang) {
      const [, month = "", day = ""] = date.split("-");
      return lang === "zh" ? `${Number(month)}月${Number(day)}日` : `${Number(month)}/${Number(day)}`;
    }
    function numberLocaleOf(lang) {
      return lang === "zh" ? "zh-CN" : "en-US";
    }
    function useLocale() {
      const lang = activeLanguage();
      const numberLocale = numberLocaleOf(lang);
      return {
        lang,
        numberLocale,
        t: (key, vars) => translate(lang, key, vars)
      };
    }
    function Icon({ name, size = 18 }) {
      const paths = {
        chart: /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h("path", { d: "M4 19V9M10 19V5M16 19v-7M22 19H2" })),
        back: /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h("path", { d: "m15 18-6-6 6-6" }), /* @__PURE__ */ h("path", { d: "M9 12h11" })),
        spark: /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h("path", { d: "M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" }))
      };
      return /* @__PURE__ */ h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" }, paths[name]);
    }
    function localDate(offset = 0) {
      const date = /* @__PURE__ */ new Date();
      date.setDate(date.getDate() + offset);
      const year = date.getFullYear();
      return `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }
    function isoLocal(date) {
      const year = date.getFullYear();
      return `${year}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }
    function compact(value, numberLocale) {
      return new Intl.NumberFormat(numberLocale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
    }
    function monthShort(date, lang) {
      return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", { month: "short" }).format(date);
    }
    function clampTipX(x) {
      return Math.min(window.innerWidth - 150, Math.max(150, x));
    }
    function useFloatingTip() {
      const [tip, setTip] = useState(null);
      const show = useCallback((x, y, text) => {
        setTip({ x, y, text });
      }, []);
      const hide = useCallback(() => {
        setTip(null);
      }, []);
      const node = tip === null ? null : createPortal(/* @__PURE__ */ h("div", { "data-token-usage-board": true, className: "us-floating-tip", role: "tooltip", style: { left: tip.x, top: tip.y } }, tip.text), document.body);
      return { show, hide, node };
    }
    function formatDuration(ms, t) {
      if (ms <= 0) return "0";
      const totalMinutes = Math.floor(ms / 6e4);
      if (totalMinutes < 1) return t("subMinute");
      if (totalMinutes < 60) return t("minutesOnly", { m: totalMinutes });
      const totalHours = Math.floor(totalMinutes / 60);
      if (totalHours < 48) return t("hourMinute", { h: totalHours, m: totalMinutes % 60 });
      const totalDays = Math.floor(totalHours / 24);
      return t("dayHour", { d: totalDays, h: totalHours % 24 });
    }
    function effortLabel(id, t) {
      const labels = { off: "effortOff", low: "effortLow", medium: "effortMedium", high: "effortHigh", xhigh: "effortXhigh", ultra: "effortUltra", max: "effortMax" };
      const key = labels[id.toLowerCase()];
      return key === void 0 ? id : t(key);
    }
    function finiteNumber(value) {
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    }
    function stringOf(value) {
      return typeof value === "string" ? value : "";
    }
    function normalizeSnapshot(raw) {
      const source = raw !== null && typeof raw === "object" ? raw : {};
      const allTimeSource = source.allTime !== null && typeof source.allTime === "object" ? source.allTime : {};
      const totalsSource = allTimeSource.totals !== null && typeof allTimeSource.totals === "object" ? allTimeSource.totals : {};
      const totals = {
        tokens: finiteNumber(totalsSource.tokens),
        peakDayTokens: finiteNumber(totalsSource.peakDayTokens),
        longestSessionMs: finiteNumber(totalsSource.longestSessionMs),
        currentStreak: finiteNumber(totalsSource.currentStreak),
        longestStreak: finiteNumber(totalsSource.longestStreak),
        chats: finiteNumber(totalsSource.chats),
        totalCalls: finiteNumber(totalsSource.totalCalls),
        fastCalls: finiteNumber(totalsSource.fastCalls),
        uniqueSkills: finiteNumber(totalsSource.uniqueSkills),
        skillInvocations: finiteNumber(totalsSource.skillInvocations),
        efforts: (Array.isArray(totalsSource.efforts) ? totalsSource.efforts : []).map((entry) => ({ id: stringOf(entry && entry.id), percent: finiteNumber(entry && entry.percent) }))
      };
      const models = (Array.isArray(allTimeSource.models) ? allTimeSource.models : []).map((entry) => ({
        key: stringOf(entry && entry.key),
        provider: stringOf(entry && entry.provider),
        model: stringOf(entry && entry.model) || "unknown",
        tokens: finiteNumber(entry && entry.tokens),
        percent: finiteNumber(entry && entry.percent)
      }));
      const days = (Array.isArray(source.days) ? source.days : []).map((entry) => ({ date: stringOf(entry && entry.date), tokens: finiteNumber(entry && entry.tokens), calls: finiteNumber(entry && entry.calls) })).filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.date));
      const topSkills = (Array.isArray(source.topSkills) ? source.topSkills : []).slice(0, 5).map((entry) => ({ name: stringOf(entry && entry.name), runs: finiteNumber(entry && entry.runs) })).filter((entry) => entry.name !== "");
      return { allTime: { totals, models }, days, topSkills, indexReady: source.indexReady !== false };
    }
    function StatStrip({ snapshot }) {
      const { t, numberLocale } = useLocale();
      const allTime = snapshot.allTime.totals;
      const cells = [
        { label: t("statTokens"), value: compact(allTime.tokens, numberLocale), detail: t("statTokensDetail") },
        { label: t("statPeak"), value: compact(allTime.peakDayTokens, numberLocale), detail: t("statPeakDetail") },
        { label: t("statLongestChat"), value: formatDuration(allTime.longestSessionMs, t), detail: t("statLongestChatDetail") },
        { label: t("statCurrentStreak"), value: `${allTime.currentStreak} ${t("daysUnit")}` },
        { label: t("statLongestStreak"), value: `${allTime.longestStreak} ${t("daysUnit")}` }
      ];
      return /* @__PURE__ */ h("div", { className: "us-stats-strip" }, cells.map((cell) => /* @__PURE__ */ h("div", { className: "us-stat-cell", key: cell.label }, /* @__PURE__ */ h("div", { className: "us-stat-value", title: cell.detail ?? void 0 }, cell.value), /* @__PURE__ */ h("div", { className: "us-stat-label" }, cell.label))));
    }
    /** Monday-start week columns covering one full calendar year, with future/outside flags. */
    function buildYearWeeks(year) {
      const todayIso = isoLocal(new Date());
      const jan1 = new Date(year, 0, 1);
      const weekStart = new Date(jan1);
      weekStart.setDate(jan1.getDate() - (jan1.getDay() + 6) % 7);
      const dec31 = new Date(year, 11, 31);
      const lastDay = new Date(dec31);
      lastDay.setDate(dec31.getDate() + 6 - (dec31.getDay() + 6) % 7);
      const weeks = [];
      for (const cursor = new Date(weekStart); cursor <= lastDay; cursor.setDate(cursor.getDate() + 7)) {
        const days = [];
        for (let index = 0; index < 7; index += 1) {
          const date = new Date(cursor);
          date.setDate(cursor.getDate() + index);
          const iso = isoLocal(date);
          days.push({ iso, outside: date.getFullYear() !== year, future: iso > todayIso });
        }
        weeks.push({ start: new Date(cursor), days });
      }
      return weeks;
    }

    // Calendar heatmap themes extracted from the user-supplied design-token
    // document (calendar-heatmap-design-tokens.md, v1.0.0). Only the colour
    // palette is applied so the year grid keeps its layout and geometry.
    const HEAT_THEMES = [
      { id: "github-reference", label: "GitHub 经典", levels: ["#EFF2F5", "#ACEEBB", "#4AC26B", "#2DA44E", "#116329"] },
      { id: "habitkit-inspired", label: "HabitKit 深绿", levels: ["#242832", "#21433F", "#24675A", "#31A488", "#57D9B1"] },
      { id: "habitify-inspired", label: "Habitify 蓝紫", levels: ["#EEF0F7", "#DAD8FF", "#AAA4F6", "#7768E8", "#5140C7"] },
      { id: "pomodoro-inspired", label: "Pomodoro 暖橙", levels: ["#292522", "#563527", "#8C482A", "#CA6B35", "#F4A261"] },
      { id: "gitlab-inspired", label: "GitLab 紫", levels: ["#ECECF2", "#D9D2F2", "#B39DDB", "#8562BF", "#594099"] },
      { id: "pixela-inspired", label: "Pixela 青蓝", levels: ["#EDF2F4", "#CCE8F4", "#8DC9E2", "#459BC2", "#176889"] },
      { id: "routine-inspired", label: "Routine 蓝", levels: ["#F0F2F5", "#D4E2F6", "#9DBCE8", "#5F8EC9", "#315F9A"] },
      { id: "highcharts-inspired", label: "Highcharts 蓝", levels: ["#F2F4F7", "#D9ECF4", "#A3D0E2", "#5EA9C5", "#26758F"] }
    ];
    const HEAT_THEME_KEY = "dsh-token-board:heat-theme";
    function heatThemeById(id) {
      for (const theme of HEAT_THEMES) if (theme.id === id) return theme;
      return HEAT_THEMES[0];
    }
    function heatThemeVars(theme) {
      return {
        "--tb-heat-0": theme.levels[0],
        "--tb-heat-1": theme.levels[1],
        "--tb-heat-2": theme.levels[2],
        "--tb-heat-3": theme.levels[3],
        "--tb-heat-4": theme.levels[4],
        "--tb-heat-accent": theme.levels[3]
      };
    }
    function storedHeatTheme() {
      try {
        return heatThemeById(String(localStorage.getItem(HEAT_THEME_KEY) || "")).id;
      } catch {
        return HEAT_THEMES[0].id;
      }
    }

    const ACTIVITY_MODES = ["daily", "weekly", "monthly", "cumulative"];
    function heatLevel(tokens, max) {
      return tokens === 0 ? 0 : Math.max(1, Math.min(4, Math.ceil(Math.log1p(tokens) / Math.log1p(max) * 4)));
    }
    function heatDayMap(days) {
      const map = new Map();
      for (const day of Array.isArray(days) ? days : []) if (day && typeof day.date === "string") map.set(day.date, day);
      return map;
    }
    /**
     * Month labels aligned to the actual month starts: a column is labelled when
     * the week contains the 1st day of a month inside the selected year.
     */
    function monthStartLabels(weeks, year, lang) {
      const labels = new Array(weeks.length).fill("");
      for (let index = 0; index < weeks.length; index += 1) {
        const week = weeks[index];
        for (const day of week.days) {
          if (day.outside || !day.iso.endsWith("-01")) continue;
          labels[index] = monthShort(new Date(year, Number(day.iso.slice(5, 7)) - 1, 1), lang);
          break;
        }
        if (labels[index] === "" && index === 0) {
          labels[index] = monthShort(new Date(year, 0, 1), lang);
        }
      }
      return labels;
    }

    function DailyGrid({ days, year }) {
      const { t, lang, numberLocale } = useLocale();
      const { show, hide, node } = useFloatingTip();
      const dayMap = useMemo(() => heatDayMap(days), [days]);
      const weeks = useMemo(() => buildYearWeeks(year), [year]);
      const max = useMemo(() => Math.max(1, ...(Array.isArray(days) ? days : []).map((day) => day.tokens)), [days]);
      const monthLabels = useMemo(() => monthStartLabels(weeks, year, lang), [weeks, year, lang]);
      const showTip = (target, text) => {
        const rect = target.getBoundingClientRect();
        show(clampTipX(rect.left + rect.width / 2), Math.max(4, rect.top - 10), text);
      };
      const columns = weeks.length;
      const gridStyle = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` };
      return /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h("div", { className: "us-heat-scroll" }, /* @__PURE__ */ h("div", { className: "us-heat-week" }, /* @__PURE__ */ h("span", null, t("mon")), /* @__PURE__ */ h("span", null, t("wed")), /* @__PURE__ */ h("span", null, t("fri"))), /* @__PURE__ */ h("div", { className: "us-heat-body" }, /* @__PURE__ */ h("div", { className: "us-heat", style: gridStyle }, weeks.map((week, weekIndex) => week.days.map((day, dayIndex) => {
        const key = `${weekIndex}-${dayIndex}`;
        if (day.outside) return /* @__PURE__ */ h("span", { className: "us-cell", key, "data-outside": "true", "aria-hidden": "true" });
        if (day.future) return /* @__PURE__ */ h("span", { className: "us-cell", key: day.iso, "data-future": "true", "aria-hidden": "true" });
        const record = dayMap.get(day.iso);
        if (record === void 0 || ((record.tokens ?? 0) === 0 && (record.calls ?? 0) === 0)) return /* @__PURE__ */ h("span", { className: "us-cell", key: day.iso, "data-level": 0, "aria-hidden": "true" });
        const text = t("dayDetail", { date: formatDateLabel(day.iso, lang), tokens: compact(record.tokens, numberLocale), token: t("tokenUnit"), calls: record.calls, callsUnit: t("callsSuffix") });
        return /* @__PURE__ */ h("span", { className: "us-cell us-cell-tip", key: day.iso, "data-level": heatLevel(record.tokens, max), "aria-label": text, tabIndex: 0, onMouseEnter: (event) => showTip(event.currentTarget, text), onMouseLeave: hide, onFocus: (event) => showTip(event.currentTarget, text), onBlur: hide });
      }))), /* @__PURE__ */ h("div", { className: "us-heat-months", style: gridStyle, "aria-hidden": "true" }, monthLabels.map((label, index) => /* @__PURE__ */ h("span", { key: index }, label))))), node);
    }
    function useBarTip(title, value, max) {
      const { show, hide, node } = useFloatingTip();
      const onEnter = useCallback((slot, index) => {
        const rect = slot.getBoundingClientRect();
        const barArea = Math.max(0, rect.height - 18);
        const top = rect.top + barArea * (1 - Math.min(1, value(index) / max));
        show(clampTipX(rect.left + rect.width / 2), Math.max(4, top - 10), title(index));
      }, [show, title, value, max]);
      return { onEnter, hide, node };
    }
    function WeeklyBars({ days, year }) {
      const { t, lang, numberLocale } = useLocale();
      const dayMap = useMemo(() => heatDayMap(days), [days]);
      const weeks = useMemo(() => buildYearWeeks(year), [year]);
      const totals = useMemo(() => weeks.map((week) => week.days.reduce((sum, day) => sum + ((dayMap.get(day.iso) ?? {}).tokens ?? 0), 0)), [weeks, dayMap]);
      const max = Math.max(1, ...totals);
      const tip = useBarTip((index) => {
        const week = weeks[index];
        if (week === void 0) return "";
        const end = new Date(week.start);
        end.setDate(week.start.getDate() + 6);
        const range = `${formatDateLabel(isoLocal(week.start), lang)} – ${formatDateLabel(isoLocal(end), lang)}`;
        return t("weekDetail", { range, tokens: compact(totals[index] ?? 0, numberLocale), token: t("tokenUnit") });
      }, (index) => totals[index] ?? 0, max);
      const monthLabels = useMemo(() => monthStartLabels(weeks, year, lang), [weeks, year, lang]);
      return /* @__PURE__ */ h("div", { className: "us-bars" }, weeks.map((week, index) => {
        const future = week.days.every((day) => day.future || day.outside);
        const end = new Date(week.start);
        end.setDate(week.start.getDate() + 6);
        const range = `${formatDateLabel(isoLocal(week.start), lang)} – ${formatDateLabel(isoLocal(end), lang)}`;
        const title = t("weekDetail", { range, tokens: compact(totals[index] ?? 0, numberLocale), token: t("tokenUnit") });
        return /* @__PURE__ */ h("div", { className: "us-bar-slot", key: index, "data-future": future || void 0, onMouseEnter: future ? void 0 : (event) => tip.onEnter(event.currentTarget, index), onMouseLeave: future ? void 0 : tip.hide }, /* @__PURE__ */ h("div", { className: "us-bar", style: { height: `${(totals[index] ?? 0) / max * 100}%` }, "aria-label": future ? void 0 : title, tabIndex: future ? void 0 : 0 }), /* @__PURE__ */ h("span", { className: "us-bar-label" }, monthLabels[index] ?? ""));
      }), tip.node);
    }
    function MonthlyBars({ days, year }) {
      const { t, lang, numberLocale } = useLocale();
      const months = useMemo(() => Array.from({ length: 12 }, (_, index) => {
        const label = new Date(year, index, 1);
        const key = `${year}-${String(index + 1).padStart(2, "0")}`;
        let total = 0;
        for (const day of Array.isArray(days) ? days : []) if (day.date.startsWith(`${key}-`)) total += day.tokens;
        return { key, label, total };
      }), [days, year]);
      const max = Math.max(1, ...months.map((month) => month.total));
      const tip = useBarTip((index) => {
        const month = months[index];
        if (month === void 0) return "";
        return t("monthDetail", { month: monthShort(month.label, lang), tokens: compact(month.total, numberLocale), token: t("tokenUnit") });
      }, (index) => months[index]?.total ?? 0, max);
      const now = new Date();
      return /* @__PURE__ */ h("div", { className: "us-bars" }, months.map((month, index) => {
        const future = year > now.getFullYear() || (year === now.getFullYear() && index > now.getMonth());
        const label = monthShort(month.label, lang);
        const title = t("monthDetail", { month: label, tokens: compact(month.total, numberLocale), token: t("tokenUnit") });
        return /* @__PURE__ */ h("div", { className: "us-bar-slot", key: month.key, "data-future": future || void 0, onMouseEnter: future ? void 0 : (event) => tip.onEnter(event.currentTarget, index), onMouseLeave: future ? void 0 : tip.hide }, /* @__PURE__ */ h("div", { className: "us-bar", style: { height: `${future ? 0 : month.total / max * 100}%` }, "aria-label": future ? void 0 : title, tabIndex: future ? void 0 : 0 }), /* @__PURE__ */ h("span", { className: "us-bar-label" }, label));
      }), tip.node);
    }
    function CumulativeChart({ days, year }) {
      const { t, lang, numberLocale } = useLocale();
      const frameRef = useRef(null);
      const [hover, setHover] = useState(null);
      const { show, hide, node } = useFloatingTip();
      const sequence = useMemo(() => {
        const dayMap = heatDayMap(days);
        const todayIso = isoLocal(new Date());
        const currentYear = new Date().getFullYear();
        const endIso = year === currentYear ? todayIso : `${year}-12-31`;
        const list = [];
        const cursor = new Date(year, 0, 1);
        while (isoLocal(cursor) <= endIso) {
          const iso = isoLocal(cursor);
          list.push({ date: iso, tokens: (dayMap.get(iso) ?? {}).tokens ?? 0 });
          cursor.setDate(cursor.getDate() + 1);
        }
        return list;
      }, [days, year]);
      const { points, max, monthLabels, values } = useMemo(() => {
        let running = 0;
        const pointValues = sequence.map((day) => running += day.tokens);
        const peak = Math.max(1, running);
        const height = 190;
        const step = sequence.length > 1 ? 720 / (sequence.length - 1) : 720;
        const pointList = pointValues.map((value, index) => `${(index * step).toFixed(2)},${(height - value / peak * height).toFixed(2)}`);
        const todayIso = isoLocal(new Date());
        const labels = [];
        for (let month = 0; month < 12; month += 1) {
          const startIso = `${year}-${String(month + 1).padStart(2, "0")}-01`;
          if (startIso > todayIso) break;
          const at = sequence.findIndex((day) => day.date === startIso);
          if (at < 0) continue;
          const fraction = sequence.length > 1 ? at / (sequence.length - 1) : 0;
          labels.push({ key: startIso, label: monthShort(new Date(year, month, 1), lang), fraction });
        }
        return { points: pointList.join(" "), max: peak, monthLabels: labels, values: pointValues };
      }, [sequence, year, lang]);
      const onMove = (event) => {
        const frame = frameRef.current;
        if (frame === null || sequence.length === 0) return;
        const rect = frame.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const frac = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        const index = Math.min(sequence.length - 1, Math.round(frac * (sequence.length - 1)));
        const day = sequence[index];
        const value = values[index];
        if (day === void 0 || value === void 0) return;
        const x = rect.left + (sequence.length > 1 ? index / (sequence.length - 1) * rect.width : 0);
        const y = rect.top + (1 - value / max) * rect.height;
        setHover(index);
        show(clampTipX(x), Math.max(4, y - 12), t("cumulativeDetail", { date: formatDateLabel(day.date, lang), tokens: compact(value, numberLocale), token: t("tokenUnit") }));
      };
      const onLeave = () => {
        setHover(null);
        hide();
      };
      const areaPath = points.length > 0 ? `M0,190 L${points} L720,190 Z` : "";
      const hoverFrac = hover === null || sequence.length <= 1 ? 0 : hover / (sequence.length - 1);
      const hoverValue = hover === null ? void 0 : values[hover];
      return /* @__PURE__ */ h("div", { className: "us-cum-wrap" }, /* @__PURE__ */ h("div", { className: "us-cum-frame", ref: frameRef, onMouseMove: onMove, onMouseLeave: onLeave }, /* @__PURE__ */ h("svg", { viewBox: "0 0 720 190", preserveAspectRatio: "none", role: "img", "aria-label": t("modeCumulative") }, /* @__PURE__ */ h("path", { className: "us-cum-area", d: areaPath }), /* @__PURE__ */ h("polyline", { className: "us-cum-line", points })), hover !== null && hoverValue !== void 0 && /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h("span", { className: "us-cum-guide", style: { left: `${hoverFrac * 100}%` }, "aria-hidden": "true" }), /* @__PURE__ */ h("span", { className: "us-cum-dot", style: { left: `${hoverFrac * 100}%`, top: `${(1 - hoverValue / max) * 100}%` }, "aria-hidden": "true" })), /* @__PURE__ */ h("span", { className: "us-cum-peak" }, compact(max, numberLocale), " ", t("tokenUnit"))), /* @__PURE__ */ h("div", { className: "us-cum-months", "aria-hidden": "true" }, monthLabels.map((mark) => /* @__PURE__ */ h("span", { key: mark.key, style: { left: `${mark.fraction * 100}%` } }, mark.label))), node);
    }
    function TokenActivity({ days }) {
      const { t, lang } = useLocale();
      const [mode, setMode] = useState("daily");
      const currentYear = new Date().getFullYear();
      const years = useMemo(() => {
        const found = new Set([currentYear]);
        for (const day of Array.isArray(days) ? days : []) {
          const year = Number(String(day && day.date || "").slice(0, 4));
          const active = day && ((day.tokens ?? 0) > 0 || (day.calls ?? 0) > 0);
          if (active && Number.isInteger(year) && year > 1970) found.add(year);
        }
        return [...found].sort((left, right) => right - left);
      }, [days, currentYear]);
      const [year, setYear] = useState(currentYear);
      const selectedYear = years.includes(year) ? year : currentYear;
      const [themeId, setThemeId] = useState(storedHeatTheme);
      const theme = heatThemeById(themeId);
      const chooseTheme = (nextId) => {
        const next = heatThemeById(nextId);
        setThemeId(next.id);
        try { localStorage.setItem(HEAT_THEME_KEY, next.id) } catch { /* storage may be unavailable */ }
      };
      const modeLabels = { daily: "modeDaily", weekly: "modeWeekly", monthly: "modeMonthly", cumulative: "modeCumulative" };
      const themeSelect = /* @__PURE__ */ h("span", { className: "us-year-wrap" }, /* @__PURE__ */ h("select", {
        className: "us-year",
        value: theme.id,
        "aria-label": t("themeLabel"),
        title: t("themeLabel"),
        onChange: (event) => chooseTheme(event.target.value),
      }, HEAT_THEMES.map((option) => /* @__PURE__ */ h("option", { key: option.id, value: option.id }, option.label))), /* @__PURE__ */ h("span", { className: "us-year-arrow", "aria-hidden": "true" }, /* @__PURE__ */ h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ h("path", { d: "m6 9 6 6 6-6" }))));
      const select = /* @__PURE__ */ h("span", { className: "us-year-wrap" }, /* @__PURE__ */ h("select", {
        className: "us-year",
        value: String(selectedYear),
        "aria-label": t("yearLabel"),
        title: t("yearLabel"),
        onChange: (event) => setYear(Number(event.target.value)),
      }, years.map((option) => /* @__PURE__ */ h("option", { key: option, value: String(option) }, String(option)))), /* @__PURE__ */ h("span", { className: "us-year-arrow", "aria-hidden": "true" }, /* @__PURE__ */ h("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ h("path", { d: "m6 9 6 6 6-6" }))));
      return /* @__PURE__ */ h("section", { className: "us-panel", style: heatThemeVars(theme), "data-heat-theme": theme.id }, /* @__PURE__ */ h("div", { className: "us-panel-head" }, /* @__PURE__ */ h("span", { className: "us-activity-head" }, /* @__PURE__ */ h("span", { className: "us-panel-title" }, t("activityTitle")), select, themeSelect), /* @__PURE__ */ h("span", { className: "us-activity-controls" }, /* @__PURE__ */ h("span", { className: "us-heat-legend" }, /* @__PURE__ */ h("span", null, t("less")), [0, 1, 2, 3, 4].map((level) => /* @__PURE__ */ h("span", { className: "us-cell", key: level, "data-level": level, "aria-hidden": "true" })), /* @__PURE__ */ h("span", null, t("more"))), /* @__PURE__ */ h("span", { className: "us-segment", "aria-label": t("activityTitle") }, ACTIVITY_MODES.map((item) => /* @__PURE__ */ h("button", { type: "button", key: item, "aria-pressed": mode === item, onClick: () => setMode(item) }, t(modeLabels[item])))))), mode === "daily" && /* @__PURE__ */ h(DailyGrid, { days, year: selectedYear }), mode === "weekly" && /* @__PURE__ */ h(WeeklyBars, { days, year: selectedYear }), mode === "monthly" && /* @__PURE__ */ h(MonthlyBars, { days, year: selectedYear }), mode === "cumulative" && /* @__PURE__ */ h(CumulativeChart, { days, year: selectedYear }));
    }
    function Insights({ snapshot }) {
      const { t, numberLocale } = useLocale();
      const allTime = snapshot.allTime.totals;
      const fastPercent = allTime.totalCalls === 0 ? 0 : Math.round(allTime.fastCalls / allTime.totalCalls * 100);
      const topEffort = allTime.efforts[0];
      const rows = [
        { label: t("fastMode"), value: `${fastPercent}%`, sub: t("fastModeDetail") },
        { label: t("topEffort"), value: topEffort === void 0 ? t("noData") : `${effortLabel(topEffort.id, t)}: ${Math.round(topEffort.percent)}%` },
        { label: t("skillsExplored"), value: new Intl.NumberFormat(numberLocale).format(allTime.uniqueSkills) },
        { label: t("skillsTotal"), value: new Intl.NumberFormat(numberLocale).format(allTime.skillInvocations) },
        { label: t("totalChats"), value: new Intl.NumberFormat(numberLocale).format(allTime.chats) }
      ];
      return /* @__PURE__ */ h("section", { className: "us-panel" }, /* @__PURE__ */ h("div", { className: "us-panel-head" }, /* @__PURE__ */ h("span", { className: "us-panel-title" }, t("insightsTitle"))), rows.map((row) => /* @__PURE__ */ h("div", { className: "us-duo-row", key: row.label }, /* @__PURE__ */ h("span", { className: "us-duo-label", title: row.sub }, row.label), /* @__PURE__ */ h("span", { className: "us-duo-value" }, row.value))));
    }
    function SkillList({ snapshot }) {
      const { t, numberLocale } = useLocale();
      return /* @__PURE__ */ h("section", { className: "us-panel" }, /* @__PURE__ */ h("div", { className: "us-panel-head" }, /* @__PURE__ */ h("span", { className: "us-panel-title" }, t("skillsTitle"))), snapshot.topSkills.length === 0 ? /* @__PURE__ */ h("div", { className: "us-duo-row" }, /* @__PURE__ */ h("span", { className: "us-duo-label" }, t("noData"))) : snapshot.topSkills.map((skill) => /* @__PURE__ */ h("div", { className: "us-skill-row", key: skill.name }, /* @__PURE__ */ h("span", { className: "us-skill-mark" }, /* @__PURE__ */ h(Icon, { name: "spark", size: 13 })), /* @__PURE__ */ h("span", { className: "us-skill-name", title: skill.name }, skill.name), /* @__PURE__ */ h("span", { className: "us-skill-count" }, new Intl.NumberFormat(numberLocale).format(skill.runs), " ", t("runsSuffix")))));
    }
    const PROVIDER_LABELS = {
      "opencode-go": "OpenCode Go",
      "deepseek-official": "DeepSeek 官方",
      "deepseek-account": "DeepSeek 官方",
      "deepseek": "DeepSeek"
    };
    function providerLabel(provider) {
      const value = typeof provider === "string" ? provider.trim() : "";
      if (value === "") return "";
      return PROVIDER_LABELS[value.toLowerCase()] ?? value;
    }
    const PIE_COLORS = ["#1684ff", "#219653", "#9368ef", "#f59e0b", "#ef5da8", "#22b8b5", "#8b5cf6", "#10b981"];
    const PIE_OTHER_COLOR = "#c3c9d1";
    const PIE_HOLE_PX = 30;
    function withAlpha(hex, alpha) {
      const value = hex.replace("#", "");
      const red = Number.parseInt(value.slice(0, 2), 16);
      const green = Number.parseInt(value.slice(2, 4), 16);
      const blue = Number.parseInt(value.slice(4, 6), 16);
      return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    }
    function ModelPie({ snapshot }) {
      const { t, numberLocale } = useLocale();
      const models = snapshot.allTime.models;
      const total = snapshot.allTime.totals.tokens;
      const pieRef = useRef(null);
      const [hover, setHover] = useState(null);
      const { show, hide, node } = useFloatingTip();
      const segments = useMemo(() => {
        const top = models.slice(0, 8).map((model, index) => ({ key: model.key || `${model.provider}/${model.model}`, name: model.model, source: providerLabel(model.provider), color: PIE_COLORS[index] ?? PIE_OTHER_COLOR, tokens: model.tokens, percent: model.percent }));
        const rest = models.slice(8).reduce((sum, model) => sum + model.tokens, 0);
        if (rest > 0) top.push({ key: "other", name: t("otherModel"), source: "", color: PIE_OTHER_COLOR, tokens: rest, percent: total === 0 ? 0 : rest / total * 100 });
        return top;
      }, [models, total, t]);
      const ranges = useMemo(() => {
        let cursor = 0;
        return segments.map((segment) => {
          const from = cursor * 3.6;
          cursor += segment.percent;
          return { from, to: Math.min(cursor, 100) * 3.6 };
        });
      }, [segments]);
      const conic = useMemo(() => {
        let cursor = 0;
        const stops = segments.map((segment, index) => {
          const from = cursor;
          cursor += segment.percent;
          const color = hover === null || hover === index ? segment.color : withAlpha(segment.color, 0.45);
          return `${color} ${(from * 3.6).toFixed(2)}deg ${(Math.min(cursor, 100) * 3.6).toFixed(2)}deg`;
        });
        return stops.length === 0 ? `conic-gradient(${PIE_OTHER_COLOR} 0deg 360deg)` : `conic-gradient(${stops.join(", ")})`;
      }, [segments, hover]);
      const clearHover = () => {
        setHover(null);
        hide();
      };
      const activate = useCallback((index) => {
        const pie = pieRef.current;
        const segment = segments[index];
        if (pie === null || segment === void 0) return;
        setHover(index);
        const rect = pie.getBoundingClientRect();
        show(clampTipX(rect.left + rect.width / 2), Math.max(4, rect.top - 10), t("modelDetail", { name: segment.source === "" ? segment.name : `${segment.name} · ${segment.source}`, tokens: compact(segment.tokens, numberLocale), token: t("tokenUnit"), percent: segment.percent.toFixed(1) }));
      }, [segments, show, t, numberLocale]);
      const onMove = (event) => {
        const pie = pieRef.current;
        if (pie === null) return;
        const rect = pie.getBoundingClientRect();
        const dx = event.clientX - (rect.left + rect.width / 2);
        const dy = event.clientY - (rect.top + rect.height / 2);
        const radius = Math.hypot(dx, dy);
        if (radius < PIE_HOLE_PX || radius > rect.width / 2) {
          clearHover();
          return;
        }
        const deg = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
        const hit = ranges.findIndex((range) => deg >= range.from && deg < range.to);
        if (hit === -1) {
          clearHover();
          return;
        }
        if (hit !== hover) activate(hit);
      };
      return /* @__PURE__ */ h("section", { className: "us-panel" }, /* @__PURE__ */ h("div", { className: "us-panel-head" }, /* @__PURE__ */ h("span", { className: "us-panel-title" }, t("modelShareTitle")), /* @__PURE__ */ h("span", { className: "us-panel-note" }, t("modelShareNote"))), /* @__PURE__ */ h("div", { className: "us-pie-layout" }, /* @__PURE__ */ h("div", { className: "us-pie", ref: pieRef, style: { background: conic }, onMouseMove: onMove, onMouseLeave: clearHover }, /* @__PURE__ */ h("div", { className: "us-pie-center" }, compact(total, numberLocale), /* @__PURE__ */ h("small", null, t("tokenUnit")))), /* @__PURE__ */ h("div", { className: "us-pie-legend" }, segments.map((segment, index) => /* @__PURE__ */ h("div", { className: "us-pie-row", key: segment.key, "data-active": hover === index || void 0, onMouseEnter: () => activate(index), onMouseLeave: clearHover }, /* @__PURE__ */ h("span", { className: "us-pie-dot", style: { background: segment.color } }), /* @__PURE__ */ h("span", { className: "us-pie-name-wrap" }, /* @__PURE__ */ h("span", { className: "us-pie-name", title: segment.source === "" ? segment.name : `${segment.name} · ${segment.source}` }, segment.name), segment.source === "" ? null : /* @__PURE__ */ h("span", { className: "us-pie-source", title: segment.source }, segment.source)), /* @__PURE__ */ h("span", { className: "us-pie-tokens" }, compact(segment.tokens, numberLocale)), /* @__PURE__ */ h("span", { className: "us-pie-percent" }, segment.percent.toFixed(segment.percent < 10 ? 1 : 0), "%"))))), node);
    }
    const ACTIVITY_WINDOW_DAYS = 53 * 7;
    // Last normalized usage snapshot, kept across panel opens so reopening shows the
    // previous result instantly while the fresh request runs (the user asked for
    // non-blocking, last-cached-first behaviour).
    let lastUsageSnapshot = null;
    function StatsPanel() {
      const { t } = useLocale();
      const [snapshot, setSnapshot] = useState(() => lastUsageSnapshot);
      const [error, setError] = useState(null);
      const retryRef = useRef({ attempts: 0, timer: null });
      const query = useMemo(() => {
        const now = new Date();
        const from = `${now.getFullYear() - 9}-01-01`;
        const params = new URLSearchParams({ from, to: localDate(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
        return params.toString();
      }, []);
      const refresh = useCallback((signal) => {
        setError(null);
        fetch(`/token-board/v1/usage?${query}`, { signal: signal ?? null, headers: { accept: "application/json" } }).then(async (response) => {
          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          if (!response || response.ok !== true) {
            const detail = body !== null && typeof body === "object" && typeof body.error === "string" ? body.error : `HTTP ${response ? response.status : "?"}`;
            throw new Error(detail);
          }
          if (body !== null && typeof body === "object" && body.ok === false) {
            throw new Error(typeof body.error === "string" ? body.error : translate(activeLanguage(), "loadError"));
          }
          return normalizeSnapshot(body);
        }).then((value) => {
          lastUsageSnapshot = value;
          setSnapshot(value);
          // First-ever cold open: the host answers from a partial cache while its
          // background index runs; pick up the complete snapshot shortly after.
          if (value.indexReady === false && retryRef.current !== null && retryRef.current.attempts < 8) {
            retryRef.current.attempts += 1;
            retryRef.current.timer = setTimeout(() => {
              retryRef.current.timer = null;
              refresh(signal);
            }, 2500);
          }
        }).catch((reason) => {
          if (reason !== null && typeof reason === "object" && reason.name === "AbortError") return;
          setError(reason instanceof Error ? reason.message : String(reason));
        });
      }, [query]);
      useEffect(() => {
        const abort = new AbortController();
        refresh(abort.signal);
        return () => {
          abort.abort();
          if (retryRef.current !== null && retryRef.current.timer !== null) clearTimeout(retryRef.current.timer);
        };
      }, [refresh]);
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === "Escape") selectMainPanel(null);
        };
        window.addEventListener("keydown", onKey);
        return () => {
          window.removeEventListener("keydown", onKey);
        };
      }, []);
      return /* @__PURE__ */ h("div", { "data-token-usage-board": true, className: "us-shell tb-stats", role: "region", "aria-label": t("title") }, /* @__PURE__ */ h("header", { className: "us-top" }, /* @__PURE__ */ h("button", { className: "us-back", onClick: () => selectMainPanel(null), title: t("back") }, /* @__PURE__ */ h(Icon, { name: "back", size: 17 }), t("back")), /* @__PURE__ */ h("div", { className: "us-title" }, t("title"))), /* @__PURE__ */ h("main", { className: "us-scroll" }, /* @__PURE__ */ h("div", { className: "us-content" }, error !== null ? /* @__PURE__ */ h("div", { className: "us-state" }, /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("p", null, t("loadError")), /* @__PURE__ */ h("small", null, error))) : snapshot === null ? /* @__PURE__ */ h("div", { className: "us-state" }, /* @__PURE__ */ h("div", null, /* @__PURE__ */ h("div", { className: "us-spinner" }), t("loading"))) : /* @__PURE__ */ h(Fragment, null, /* @__PURE__ */ h(StatStrip, { snapshot }), /* @__PURE__ */ h(TokenActivity, { days: snapshot.days }), /* @__PURE__ */ h("div", { className: "us-duo" }, /* @__PURE__ */ h(Insights, { snapshot }), /* @__PURE__ */ h(SkillList, { snapshot })), /* @__PURE__ */ h(ModelPie, { snapshot })))));
    }
    // ==== generated usage panel — END =======================================

    // Status → solid dot color; the pill/hover dots are pure fills by contract
    // (no border, glow or animation).
    const STATUS_COLORS = {
      streaming: '#34d399',
      running: '#facc15',
      tool: '#60a5fa',
      retrying: '#fb923c',
      idle: '#9aa0a6',
    }
    // Highest-priority first: what the pill dot shows for a whole subtree.
    const STATUS_PRIORITY = ['streaming', 'retrying', 'tool', 'running', 'idle']
    const POLL_URL = API_PATH + '/stats'

    // ---------------------------------------------------------------- helpers

    function toNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }

    function round1(value) {
      return Math.round(toNumber(value) * 10) / 10
    }

    /** `0` / one decimal under 100 / rounded integer from 100 on. */
    function fmtTps(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0'
      if (value < 100) return value.toFixed(1)
      return String(Math.round(value))
    }

    function normStatus(status) {
      return status === 'streaming' || status === 'running' || status === 'tool'
        || status === 'retrying' || status === 'idle'
        ? status
        : 'idle'
    }

    function statusColor(status) {
      return STATUS_COLORS[normStatus(status)]
    }

    function statusText(status) {
      switch (normStatus(status)) {
        case 'streaming': return L.streaming
        case 'running': return L.running
        case 'tool': return L.tool
        case 'retrying': return L.retrying
        default: return L.idle
      }
    }

    function priorityStatus(statuses) {
      for (const candidate of STATUS_PRIORITY) {
        if (statuses.indexOf(candidate) !== -1) return candidate
      }
      return 'idle'
    }

    /** Real name from the Agent Team roster or the session title; generic only when unknown. */
    function rowLabel(row) {
      if (typeof row.name === 'string' && row.name !== '') return row.name
      return row.isMain ? L.mainAgent : L.subAgent + ' ' + (row.subIndex + 1)
    }

    function sumTps(rows) {
      let total = 0
      for (const row of rows) total += toNumber(row.tps)
      return round1(total)
    }

    /** Safe `getBoundingClientRect`; null when the node cannot answer. */
    function rectOf(element) {
      try {
        if (!element || typeof element.getBoundingClientRect !== 'function') return null
        const rect = element.getBoundingClientRect()
        if (!rect || typeof rect.left !== 'number' || typeof rect.top !== 'number') return null
        return rect
      } catch {
        return null
      }
    }

    /**
     * Distance from `agent` up the durable `parentSession` chain to `sessionId`;
     * -1 when the chain does not reach it. Cycle-safe and garbage-tolerant.
     */
    function resolveDepth(agent, sessionId, byId) {
      let current = agent
      let depth = 0
      const seen = new Set()
      while (current) {
        if (seen.size > 64) return -1
        if (current.id === sessionId) return depth
        const parent = current.parentSession
        if (typeof parent !== 'string' || parent === '') return -1
        if (seen.has(parent)) return -1
        seen.add(parent)
        depth += 1
        if (parent === sessionId) return depth
        current = byId.get(parent) || null
      }
      return -1
    }

    function emptyRows() {
      return { main: null, subs: [], all: [], totalTps: 0, status: 'idle' }
    }

    /**
     * Every tracked agent whose own-or-ancestor chain reaches `sessionId`.
     * Rows are `{ id, status, tps, model, depth, isMain, subIndex }`, sorted
     * main-first, then by depth and id. Pure: null/garbage input → empty rows.
     */
    function agentSpeedRows(data, sessionId) {
      try {
        if (typeof sessionId !== 'string' || sessionId === '') return emptyRows()
        const agents = data && Array.isArray(data.agents) ? data.agents : []
        const byId = new Map()
        for (const agent of agents) {
          if (agent && typeof agent.id === 'string' && !byId.has(agent.id)) byId.set(agent.id, agent)
        }
        const rows = []
        for (const agent of byId.values()) {
          const depth = resolveDepth(agent, sessionId, byId)
          if (depth < 0) continue
          rows.push({
            id: agent.id,
            status: normStatus(agent.status),
            tps: round1(agent.tps),
            model: typeof agent.model === 'string' ? agent.model : '',
            name: typeof agent.name === 'string' ? agent.name.trim() : '',
            role: typeof agent.role === 'string' ? agent.role : '',
            depth,
            isMain: depth === 0,
            subIndex: -1,
          })
        }
        if (rows.length === 0) return emptyRows()
        rows.sort((left, right) => {
          if (left.isMain !== right.isMain) return left.isMain ? -1 : 1
          if (left.depth !== right.depth) return left.depth - right.depth
          if (left.id === right.id) return 0
          return left.id < right.id ? -1 : 1
        })
        let subIndex = 0
        let totalTps = 0
        for (const row of rows) {
          if (!row.isMain) {
            row.subIndex = subIndex
            subIndex += 1
          }
          totalTps += row.tps
        }
        return {
          main: rows.find((row) => row.isMain) || null,
          subs: rows.filter((row) => !row.isMain),
          all: rows,
          totalTps: round1(totalTps),
          status: priorityStatus(rows.map((row) => row.status)),
        }
      } catch {
        return emptyRows()
      }
    }

    function activeRows(data, sessionId) {
      return agentSpeedRows(data, sessionId).all.filter((row) => row.status !== 'idle')
    }

    // -------------------------------------------------------------- the store

    /**
     * One module-level poller for every surface. `subscribe` keeps the poller
     * alive only while somebody listens; a hidden document pauses fetches and
     * a failed request keeps the last good payload (with a failure counter).
     */
    function createStore() {
      let snapshot = { data: null, failures: 0 }
      const listeners = new Set()
      let timer = null
      let inFlight = false

      function notify() {
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch {
            /* a broken subscriber must never stop the poller */
          }
        }
      }

      function commit(data, failures) {
        snapshot = { data, failures }
        notify()
      }

      async function fetchStats() {
        if (inFlight) return
        if (typeof document !== 'undefined' && document.hidden) return
        inFlight = true
        try {
          const response = await fetch(POLL_URL, { cache: 'no-store', headers: { accept: 'application/json' } })
          if (!response || response.ok !== true) throw new Error('token-board: bad response')
          const body = await response.json()
          if (!body || typeof body !== 'object') throw new Error('token-board: bad payload')
          commit(body, 0)
        } catch {
          commit(snapshot.data, snapshot.failures + 1)
        } finally {
          inFlight = false
        }
      }

      function onVisibilityChange() {
        if (typeof document !== 'undefined' && !document.hidden) void fetchStats()
      }

      function start() {
        void fetchStats()
        timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          void fetchStats()
        }, POLL_MS)
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVisibilityChange)
        }
      }

      function stop() {
        if (timer !== null) {
          clearInterval(timer)
          timer = null
        }
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          document.removeEventListener('visibilitychange', onVisibilityChange)
        }
      }

      return {
        subscribe(listener) {
          if (typeof listener !== 'function') return () => {}
          listeners.add(listener)
          if (listeners.size === 1) start()
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0) stop()
          }
        },
        getSnapshot() {
          return snapshot
        },
      }
    }

    const store = createStore()

    function useStats() {
      const snapshot = react.useSyncExternalStore(store.subscribe, store.getSnapshot)
      return snapshot && snapshot.data ? snapshot.data : null
    }

    // ------------------------------------------------- speed history (chart)

    /**
     * Per-session tps history for the header chart. One sample per successful
     * poll while the session has a non-idle agent; idle seconds are not
     * recorded, which the chart renders as a gap in the curve (no fabricated
     * zero samples). Bounded per session and pruned across sessions, so a
     * long-lived page cannot grow memory without limit.
     */
    const speedHistory = new Map()

    function recordSpeedSample(sessionId, tps, status) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (normStatus(status) === 'idle') return
      let samples = speedHistory.get(sessionId)
      if (!samples) {
        samples = []
        speedHistory.set(sessionId, samples)
      }
      samples.push({ t: Date.now(), v: round1(tps) })
      if (samples.length > HISTORY_MAX_SAMPLES) samples.splice(0, samples.length - HISTORY_MAX_SAMPLES)
      if (speedHistory.size > 48) {
        const cutoff = Date.now() - 30 * 60 * 1000
        for (const [id, list] of speedHistory) {
          if (id === sessionId) continue
          const last = list[list.length - 1]
          if (!last || last.t < cutoff) speedHistory.delete(id)
        }
      }
    }

    function speedSamplesOf(sessionId) {
      if (typeof sessionId !== 'string') return []
      const samples = speedHistory.get(sessionId)
      return samples ? samples.slice() : []
    }

    /** Friendly Y-axis maximum: round the peak up to a multiple of 5 (minimum 5). */
    function speedAxisMax(value) {
      const peak = Math.max(0, toNumber(value))
      return Math.max(5, Math.ceil((peak * 1.08) / 5) * 5)
    }

    /** Y-axis label: compacts thousands, rounds above 100, one decimal below. */
    function speedAxisLabel(value) {
      const number = toNumber(value)
      if (number >= 1000) return compact(number, numberLocaleOf(activeLanguage()))
      if (number >= 100) return String(Math.round(number))
      return String(Math.round(number * 10) / 10)
    }

    /** Local `HH:MM:SS` (locale-appropriate digits) for one sample timestamp. */
    function clockLabel(ms) {
      try {
        const date = new Date(ms)
        if (Number.isNaN(date.getTime())) return ''
        return date.toLocaleTimeString(zh ? 'zh-CN' : 'en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      } catch {
        return ''
      }
    }

    /**
     * Catmull-Rom → cubic Bézier path through `points`, with the control
     * ordinates clamped to the plot band so the smoothed curve cannot bulge
     * outside it. One `d` string per contiguous run of samples.
     */
    function smoothHistoryPath(points, top, bottom) {
      if (!points || points.length === 0) return ''
      const clampY = (value) => Math.min(Math.max(value, top), bottom)
      const fixed = (value) => value.toFixed(2)
      let d = 'M' + fixed(points[0].x) + ' ' + fixed(points[0].y)
      for (let index = 0; index < points.length - 1; index += 1) {
        const p0 = points[index === 0 ? 0 : index - 1]
        const p1 = points[index]
        const p2 = points[index + 1]
        const p3 = points[index + 2 < points.length ? index + 2 : points.length - 1]
        const c1x = p1.x + (p2.x - p0.x) / 6
        const c1y = clampY(p1.y + (p2.y - p0.y) / 6)
        const c2x = p2.x - (p3.x - p1.x) / 6
        const c2y = clampY(p2.y - (p3.y - p1.y) / 6)
        d += ' C' + fixed(c1x) + ' ' + fixed(c1y) + ' ' + fixed(c2x) + ' ' + fixed(c2y)
          + ' ' + fixed(p2.x) + ' ' + fixed(p2.y)
      }
      return d
    }

    /** The SVG chart: smoothed tps-vs-time curve over all recorded samples. */
    function SpeedHistorySvg(props) {
      const samples = props && Array.isArray(props.samples) ? props.samples : []
      const peak = props ? toNumber(props.peak) : 0
      if (samples.length === 0) return null
      const plotWidth = CHART_WIDTH - CHART_PAD.left - CHART_PAD.right
      const plotHeight = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom
      const top = CHART_PAD.top
      const bottom = top + plotHeight
      const yMax = speedAxisMax(peak)
      const first = samples[0]
      const last = samples[samples.length - 1]
      const span = Math.max(last.t - first.t, 1)
      const xOf = (t) => CHART_PAD.left + ((t - first.t) / span) * plotWidth
      const yOf = (value) => bottom - (Math.max(0, Math.min(toNumber(value), yMax)) / yMax) * plotHeight
      const points = samples.map((sample) => ({ t: sample.t, x: xOf(sample.t), y: yOf(sample.v) }))
      // Split into contiguous runs: a pause longer than HISTORY_GAP_MS is an
      // idle span and stays a visible break instead of a fabricated slope.
      const runs = []
      let run = [points[0]]
      for (let index = 1; index < points.length; index += 1) {
        if (points[index].t - points[index - 1].t > HISTORY_GAP_MS) {
          runs.push(run)
          run = []
        }
        run.push(points[index])
      }
      runs.push(run)
      const chart = []
      for (let index = 0; index < 3; index += 1) {
        const value = (yMax / 2) * index
        const y = yOf(value)
        chart.push(h('line', {
          key: 'grid-' + index,
          className: 'tb-chart-grid',
          x1: CHART_PAD.left,
          y1: y,
          x2: CHART_PAD.left + plotWidth,
          y2: y,
        }))
        chart.push(h('text', {
          key: 'y-label-' + index,
          className: 'tb-chart-axis',
          x: CHART_PAD.left - 6,
          y: y + 3,
          textAnchor: 'end',
          children: speedAxisLabel(value),
        }))
      }
      const indices = points.length === 1 ? [0]
        : points.length === 2 ? [0, 1]
          : [0, Math.floor((points.length - 1) / 2), points.length - 1]
      const seen = new Set()
      for (let index = 0; index < indices.length; index += 1) {
        const point = points[indices[index]]
        if (!point || seen.has(point.t)) continue
        seen.add(point.t)
        const anchor = indices.length === 1 ? 'middle' : index === 0 ? 'start' : index === indices.length - 1 ? 'end' : 'middle'
        chart.push(h('text', {
          key: 'x-label-' + index,
          className: 'tb-chart-axis',
          x: point.x,
          y: CHART_HEIGHT - 6,
          textAnchor: anchor,
          children: clockLabel(point.t),
        }))
      }
      for (let index = 0; index < runs.length; index += 1) {
        const runPoints = runs[index]
        if (runPoints.length < 2) continue
        const line = smoothHistoryPath(runPoints, top, bottom)
        const area = line
          + ' L' + runPoints[runPoints.length - 1].x.toFixed(2) + ' ' + bottom.toFixed(2)
          + ' L' + runPoints[0].x.toFixed(2) + ' ' + bottom.toFixed(2) + ' Z'
        chart.push(h('path', { key: 'area-' + index, className: 'tb-chart-area', d: area }))
        chart.push(h('path', { key: 'line-' + index, className: 'tb-chart-line', d: line }))
      }
      chart.push(h('circle', {
        key: 'last-dot',
        className: 'tb-chart-dot',
        cx: points[points.length - 1].x,
        cy: points[points.length - 1].y,
        r: 2.6,
      }))
      return h('svg', {
        className: 'tb-chart-svg',
        viewBox: '0 0 ' + CHART_WIDTH + ' ' + CHART_HEIGHT,
        role: 'img',
        'aria-label': L.chartTitle,
      }, chart)
    }

    /** Small line-chart glyph for the header history button. */
    function ChartIcon() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.8',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, [
        h('path', { key: 'axes', d: 'M4 4v16h16' }),
        h('path', { key: 'curve', d: 'm7 14 4-4 3 3 5-7' }),
      ])
    }

    /** Hover panel body: title row plus the history chart (or an empty hint). */
    function SpeedHistoryPanel(props) {
      const sessionId = props ? props.sessionId : null
      const samples = speedSamplesOf(sessionId)
      let peak = 0
      for (const sample of samples) peak = Math.max(peak, sample.v)
      const head = h('div', { className: 'tb-chart-head', key: 'head' }, [
        h('span', { key: 'title', className: 'tb-chart-title', children: L.chartTitle }),
        h('span', {
          key: 'meta',
          className: 'tb-chart-meta',
          children: samples.length === 0
            ? ''
            : L.chartSamples(samples.length) + ' · ' + L.chartPeak + ' ' + fmtTps(peak) + ' tok/s',
        }),
      ])
      const body = samples.length === 0
        ? h('div', { key: 'empty', className: 'tb-chart-empty', children: L.chartEmpty })
        : h(SpeedHistorySvg, { key: 'svg', samples, peak })
      return h('div', { className: 'tb-chart' }, [head, body])
    }

    // ------------------------------------------------------------------- CSS

    const CSS = [
      /* 1. Sidebar-foot activity summary (above the account row). */
      '.tb-summary{display:flex;align-items:flex-end;gap:8px;box-sizing:border-box;width:100%;min-width:0;padding:6px 8px;height:32px;border:0;border-radius:8px;background:transparent;color:#46484B;font:inherit;font-size:13px;line-height:16px;user-select:none;font-variant-numeric:tabular-nums;text-align:left;cursor:pointer;appearance:none}',
      'body[data-ds-dark-theme] .tb-summary{color:var(--dsw-alias-label-primary,#e7e7ea)}',
      '.tb-summary:hover,.tb-summary:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
      '.tb-summary:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:-2px}',
      '.tb-summary[data-wide="0"]{width:36px;height:36px;padding:0;justify-content:center;margin:0 auto}',
      '.tb-bars{display:flex;align-items:flex-end;justify-content:center;gap:2px;width:18px;height:16px;flex:none;margin-bottom:4px}',
      '.tb-bar{display:block;flex:none;width:3px;border-radius:2px;background:#9aa0a6;transform-origin:center bottom}',
      '.tb-bar:nth-child(1){height:7px}',
      '.tb-bar:nth-child(2){height:11px}',
      '.tb-bar:nth-child(3){height:9px}',
      '.tb-summary[data-active="1"] .tb-bar:nth-child(1){background:#34d399}',
      '.tb-summary[data-active="1"] .tb-bar:nth-child(2){background:#60a5fa}',
      '.tb-summary[data-active="1"] .tb-bar:nth-child(3){background:#facc15}',
      '.tb-summary[data-active="1"] .tb-bar{animation:tb-bounce 1.05s ease-in-out infinite}',
      '.tb-summary[data-active="0"] .tb-bar{background:#9aa0a6;animation:none}',
      '@keyframes tb-bounce{0%,100%{transform:scaleY(.45)}50%{transform:scaleY(1)}}',
      '@media (prefers-reduced-motion: reduce){.tb-summary[data-active="1"] .tb-bar{animation:none}}',
      '.tb-summary-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-bottom:1px}',
      '.tb-tip{position:fixed;z-index:1200;box-sizing:border-box;max-width:min(300px,calc(100vw - 16px));padding:5px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1f1f24);color:var(--dsw-alias-label-primary,#e7e7ea);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));box-shadow:0 8px 24px rgba(0,0,0,.28);font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;font-variant-numeric:tabular-nums}',
      /* 2. Session row hover card section — fixed light-on-dark colors. */
      '.tb-hover{display:flex;flex-direction:column;gap:4px;padding:2px 0 1px;border-top:1px solid rgba(255,255,255,.12);font-size:12px;line-height:18px;color:#E6E8EA;font-variant-numeric:tabular-nums;order:99}',
      '.tb-hover-head{font-size:11px;line-height:16px;color:#ADB2B8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.tb-hover-row{display:flex;align-items:center;gap:6px;min-width:0}',
      '.tb-dot{display:inline-block;flex:none;width:6px;height:6px;border-radius:50%;corner-shape:round;background:#9aa0a6}',
      '.tb-hover-row .tb-dot{width:10px;height:10px;min-width:10px;min-height:10px;border-radius:50%;aspect-ratio:1/1}',
      '.tb-hover-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#E6E8EA}',
      '.tb-hover-tps{margin-left:auto;flex:none;font-weight:600;white-space:nowrap;color:#FFFFFF;font-variant-numeric:tabular-nums}',
      /* 3. Conversation header throughput pill + popover. */
      '.tb-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;min-width:64px;padding:2px 8px;border-radius:6px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:20px;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:default;user-select:none}',
      '.tb-pill:hover,.tb-pill:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
      '.tb-pill-tps{font-variant-numeric:tabular-nums}',
      '.tb-pop{position:fixed;z-index:1200;box-sizing:border-box;min-width:200px;max-width:280px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#1f1f24);color:var(--dsw-alias-label-primary,#e7e7ea);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));box-shadow:0 10px 30px rgba(0,0,0,.32);font-size:12px;line-height:18px;pointer-events:none;font-variant-numeric:tabular-nums;user-select:none}',
      '.tb-pop-head{display:flex;align-items:center;gap:8px}',
      '.tb-pop-title{flex:none;color:var(--dsw-alias-label-secondary,#a9a9b3);white-space:nowrap}',
      '.tb-pop-total{margin-left:auto;font-weight:600;white-space:nowrap}',
      '.tb-pop-div{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));margin:6px 0 4px}',
      '.tb-pop-row{display:flex;align-items:center;gap:6px;min-width:0;padding:1px 0}',
      '.tb-pop-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tb-pop-status{flex:none;color:var(--dsw-alias-label-secondary,#a9a9b3);font-size:11px;white-space:nowrap}',
      '.tb-pop-tps{margin-left:auto;font-weight:600;white-space:nowrap}',
      '.tb-pop-more{padding-top:2px;text-align:right;color:var(--dsw-alias-label-secondary,#a9a9b3);font-size:11px}',
      /* 4. Conversation header history button + smooth tps chart popover. */
      '.tb-throughput{display:inline-flex;align-items:center;gap:2px;min-width:0}',
      '.tb-chart-btn{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:22px;height:22px;padding:0;margin:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;flex:none;appearance:none;line-height:1}',
      '.tb-chart-btn:hover,.tb-chart-btn:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#17191c)}',
      'body[data-ds-dark-theme] .tb-chart-btn:hover,body[data-ds-dark-theme] .tb-chart-btn:focus-visible{color:var(--dsw-alias-label-primary,#e7e7ea)}',
      '.tb-chart-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:-2px}',
      '.tb-chart-pop{width:min(352px,calc(100vw - 16px));max-width:none;min-width:0;padding:10px 12px 8px}',
      '.tb-chart-head{display:flex;align-items:baseline;gap:10px;margin-bottom:4px}',
      '.tb-chart-title{flex:none;color:var(--dsw-alias-label-secondary,#a9a9b3);font-weight:600}',
      '.tb-chart-meta{margin-left:auto;color:var(--dsw-alias-label-secondary,#a9a9b3);font-size:11px;white-space:nowrap}',
      '.tb-chart-svg{display:block;width:100%;height:auto;overflow:visible}',
      '.tb-chart-grid{stroke:var(--dsw-alias-border-l2,rgba(128,128,128,.22));stroke-width:1;shape-rendering:crispEdges}',
      '.tb-chart-axis{fill:var(--dsw-alias-label-secondary,#a9a9b3);font-size:10px;font-family:inherit;font-variant-numeric:tabular-nums}',
      '.tb-chart-area{fill:color-mix(in srgb,#60a5fa 14%,transparent)}',
      '.tb-chart-line{fill:none;stroke:#60a5fa;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
      '.tb-chart-dot{fill:#60a5fa;stroke:var(--dsw-alias-bg-layer-1,#1f1f24);stroke-width:1.5}',
      '.tb-chart-empty{padding:26px 0 30px;text-align:center;color:var(--dsw-alias-label-secondary,#a9a9b3);font-size:12px}',
    ].join('\n')

    /**
     * Full usage-panel styles, adapted from the reference dashboard's
     * `styles.ts` (MIT): the `us-*` classes and light/dark `--dsw-alias-*`
     * token surface are kept, while the reference's global center-column
     * takeover rules, its sidebar nav row and export-only chrome are dropped.
     */
    const US_CSS = String.raw`
/* The layout renders keyed 'main' entries into .mainPanel (a flex column). */
.tb-stats { flex: 1 1 auto; height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
[data-token-usage-board] {
  --us-bg: var(--dsw-alias-bg-base, #ffffff);
  --us-surface: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #f5f5f5) 92%, var(--us-bg));
  --us-raised: var(--dsw-alias-bg-layer-2, #ffffff);
  --us-hover: var(--dsw-alias-interactive-bg-hover, #eef1f4);
  --us-text: var(--dsw-alias-label-primary, #17191c);
  --us-muted: var(--dsw-alias-label-secondary, #747b86);
  --us-border: var(--dsw-alias-border-l1, #e4e7eb);
  --us-accent: #1677ff;
  --us-shadow-soft: 0 1px 2px rgba(18, 26, 41, .03), 0 8px 28px rgba(18, 26, 41, .035);
  color: var(--us-text);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif);
  font-size: 14px;
  box-sizing: border-box;
}
[data-token-usage-board], [data-token-usage-board] button, [data-token-usage-board] input, [data-token-usage-board] select { font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif); }
body[data-ds-dark-theme] [data-token-usage-board] {
  --us-bg: var(--dsw-alias-bg-base, #18191c);
  --us-surface: var(--dsw-alias-bg-layer-1, #222428);
  --us-raised: var(--dsw-alias-bg-layer-2, #292b30);
  --us-hover: var(--dsw-alias-interactive-bg-hover, #31343a);
  --us-text: var(--dsw-alias-label-primary, #f2f3f5);
  --us-muted: var(--dsw-alias-label-secondary, #a6acb5);
  --us-border: var(--dsw-alias-border-l1, #35383e);
}
[data-token-usage-board] *, [data-token-usage-board] *::before, [data-token-usage-board] *::after { box-sizing: border-box; }
.us-shell { height: 100%; display: flex; flex-direction: column; background: var(--us-bg); overflow: hidden; animation: us-enter 180ms ease-out; }
.us-top { min-height: 90px; flex: none; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 18px; padding: 18px clamp(24px, 4vw, 58px) 10px; }
.us-title { justify-self: center; text-align: center; font-size: clamp(28px, 3vw, 40px); line-height: 1.12; font-weight: 750; letter-spacing: -.045em; }
.us-back { justify-self: start; height: 40px; display: inline-flex; align-items: center; gap: 7px; border: 0; border-radius: 12px; padding: 0 14px; color: var(--us-muted); background: transparent; cursor: pointer; font: inherit; transition: color 150ms ease, background 150ms ease, transform 150ms ease; }
.us-back:hover { color: var(--us-text); background: var(--us-hover); transform: translateX(-2px); }
.us-scroll { overflow: auto; scrollbar-gutter: stable; padding: 10px clamp(24px, 4vw, 58px) 40px; }
.us-content { width: min(1180px, 100%); margin: 0 auto; }
.us-panel { border: 1px solid color-mix(in srgb, var(--us-border) 55%, transparent); background: var(--us-surface); border-radius: 16px; box-shadow: var(--us-shadow-soft); margin-top: 14px; padding: 18px 20px; overflow: hidden; animation: us-panel-in 380ms 90ms both; }
.us-panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.us-activity-head { display: inline-flex; align-items: center; gap: 10px; min-width: 0; }
.us-cum-months { position: relative; height: 16px; margin-top: 6px; }
.us-cum-months span { position: absolute; top: 0; transform: translateX(-50%); color: var(--us-muted); font-size: 11px; line-height: 16px; white-space: nowrap; }
.us-bar-slot[data-future="true"] { opacity: .38; }
.us-bar-slot[data-future="true"] .us-bar { animation: none; background: color-mix(in srgb, var(--us-border) 70%, transparent); }
.us-year-wrap { position: relative; display: inline-flex; align-items: center; flex: none; }
.us-year { height: 28px; flex: none; border: 1px solid var(--us-border); border-radius: 8px; background: var(--us-raised); color: var(--us-text); font: inherit; font-size: 12px; padding: 0 28px 0 10px; cursor: pointer; outline: none; appearance: none; -webkit-appearance: none; }
.us-year-arrow { position: absolute; right: 10px; top: 50%; display: inline-flex; transform: translateY(-50%); color: var(--us-muted); pointer-events: none; }
.us-year-arrow svg { width: 12px; height: 12px; }
.us-year:hover { background: var(--us-hover); }
.us-year:hover + .us-year-arrow { color: var(--us-text); }
.us-year:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--us-accent) 45%, transparent); }
.us-cell[data-future="true"] { background: color-mix(in srgb, var(--us-border) 28%, transparent); opacity: .42; }
.us-cell[data-outside="true"] { background: transparent; opacity: 0; }
.us-panel-title { font-size: 16px; font-weight: 620; }
.us-panel-note { color: var(--us-muted); font-size: 12px; }
.us-segment { display: inline-flex; gap: 3px; padding: 3px; border: 1px solid var(--us-border); border-radius: 11px; background: var(--us-raised); }
.us-segment button { border: 0; min-width: 64px; padding: 6px 12px; border-radius: 8px; color: var(--us-muted); background: transparent; cursor: pointer; font: inherit; white-space: nowrap; }
.us-segment button[aria-pressed="true"] { color: var(--us-text); background: var(--us-hover); box-shadow: 0 1px 3px rgba(0,0,0,.06); }
.us-stats-strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border: 1px solid color-mix(in srgb, var(--us-border) 55%, transparent); background: var(--us-surface); border-radius: 16px; box-shadow: var(--us-shadow-soft); animation: us-card-in 320ms both; }
.us-stat-cell { min-width: 0; padding: 16px 18px; border-left: 1px solid color-mix(in srgb, var(--us-border) 45%, transparent); }
.us-stat-cell:first-child { border-left: 0; }
.us-stat-value { overflow: hidden; font-size: 22px; line-height: 1.25; font-weight: 700; letter-spacing: -.02em; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.us-stat-label { margin-top: 5px; color: var(--us-muted); font-size: 12px; white-space: nowrap; }
.us-heat-scroll { display: flex; align-items: flex-start; gap: 8px; width: 100%; overflow: visible; padding: 8px 4px 4px; }
.us-heat-week { flex: none; display: grid; grid-template-rows: repeat(7, 15px); gap: 4px; width: 14px; color: var(--us-muted); font-size: 10px; line-height: 15px; }
.us-heat-week span:nth-child(2) { grid-row: 3; }
.us-heat-week span:nth-child(3) { grid-row: 5; }
.us-heat-body { flex: 1; min-width: 0; }
.us-heat { display: grid; grid-template-rows: repeat(7, auto); grid-template-columns: repeat(53, minmax(0, 1fr)); grid-auto-flow: column; gap: clamp(2px, .28vw, 4px); width: 100%; }
.us-cell { width: 100%; max-width: 15px; aspect-ratio: 1; justify-self: center; border-radius: 3px; display: inline-block; background: color-mix(in srgb, var(--us-border) 66%, transparent); }
.us-cell[data-level="0"] { background: color-mix(in srgb, var(--us-border) 66%, transparent); }
body[data-ds-dark-theme] .us-cell[data-level="0"] { background: color-mix(in srgb, var(--us-border) 46%, transparent); }
.us-cell[data-level="1"] { background: var(--tb-heat-1, #ACEEBB); }
.us-cell[data-level="2"] { background: var(--tb-heat-2, #4AC26B); }
.us-cell[data-level="3"] { background: var(--tb-heat-3, #2DA44E); }
.us-cell[data-level="4"] { background: var(--tb-heat-4, #116329); }
.us-heat-legend { display: inline-flex; align-items: center; gap: 5px; color: var(--us-muted); font-size: 11px; line-height: 1; white-space: nowrap; }
.us-heat-legend .us-cell { width: 12px; height: 12px; max-width: none; aspect-ratio: auto; justify-self: auto; }
.us-heat-months { display: grid; grid-template-columns: repeat(53, minmax(0, 1fr)); gap: clamp(2px, .28vw, 4px); width: 100%; margin-top: 6px; }
.us-heat-months span { overflow: visible; color: var(--us-muted); font-size: 11px; white-space: nowrap; }
.us-cell-tip { position: relative; cursor: default; outline: none; transition: transform 90ms ease, box-shadow 90ms ease; }
.us-cell-tip:hover, .us-cell-tip:focus-visible { box-shadow: 0 0 0 2px var(--us-surface), 0 0 0 3px var(--tb-heat-accent, var(--us-text)); z-index: 3; transform: scale(1.12); }
.us-floating-tip { position: fixed; z-index: 200; transform: translate(-50%, -100%); width: max-content; max-width: min(360px, calc(100vw - 24px)); padding: 9px 11px; border: 1px solid var(--us-border); border-radius: 10px; color: var(--us-text); background: color-mix(in srgb, var(--us-raised) 94%, transparent); box-shadow: 0 12px 38px rgba(0,0,0,.16); backdrop-filter: blur(14px); font-size: 12px; line-height: 1.4; pointer-events: none; animation: us-tip-in 110ms ease-out; }
.us-bars { display: flex; align-items: stretch; gap: clamp(2px, .4vw, 6px); height: 220px; padding: 12px 4px 0; }
.us-bar-slot { min-width: 0; flex: 1 1 0; height: 100%; display: grid; grid-template-rows: minmax(0, 1fr) 18px; align-items: end; }
.us-bar { width: min(72%, 20px); min-width: 3px; justify-self: center; border-radius: 3px 3px 0 0; background: var(--tb-heat-accent, var(--us-accent)); outline: none; cursor: default; animation: us-bar-in 520ms cubic-bezier(.2,.8,.2,1) both; }
.us-bar:hover { filter: saturate(1.12) brightness(1.05); }
.us-bar:focus-visible { box-shadow: 0 0 0 2px var(--us-bg), 0 0 0 3px var(--us-text); }
.us-bar-label { align-self: start; justify-self: center; color: var(--us-muted); font-size: 11px; line-height: 18px; white-space: nowrap; }
.us-activity-controls { display: inline-flex; align-items: center; gap: 14px; }
.us-cum-wrap { padding: 4px 4px 0; }
.us-cum-frame { position: relative; height: 220px; }
.us-cum-frame svg { display: block; width: 100%; height: 100%; }
.us-cum-area { fill: color-mix(in srgb, var(--tb-heat-accent, var(--us-accent)) 16%, transparent); }
.us-cum-line { fill: none; stroke: var(--tb-heat-accent, var(--us-accent)); stroke-width: 2; vector-effect: non-scaling-stroke; }
.us-cum-peak { position: absolute; right: 4px; top: 0; color: var(--us-muted); font-size: 11px; pointer-events: none; }
.us-cum-guide { position: absolute; top: 0; bottom: 0; width: 1px; background: color-mix(in srgb, var(--us-text) 32%, transparent); pointer-events: none; }
.us-cum-dot { position: absolute; width: 10px; height: 10px; transform: translate(-50%, -50%); border-radius: 50%; corner-shape: round; background: var(--tb-heat-accent, var(--us-accent)); box-shadow: 0 0 0 2px var(--us-surface); pointer-events: none; }
.us-duo { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }
.us-duo .us-panel { margin-top: 0; }
.us-duo-row { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; padding: 11px 2px; border-bottom: 1px solid color-mix(in srgb, var(--us-border) 55%, transparent); }
.us-duo-row:last-child { border-bottom: 0; }
.us-duo-label { color: var(--us-text); font-size: 13.5px; }
.us-duo-value { font-weight: 640; font-variant-numeric: tabular-nums; white-space: nowrap; }
.us-duo-sub { margin-top: 6px; color: var(--us-muted); font-size: 12px; }
.us-skill-row { display: flex; align-items: center; gap: 10px; padding: 10px 2px; border-bottom: 1px solid color-mix(in srgb, var(--us-border) 55%, transparent); }
.us-skill-row:last-child { border-bottom: 0; }
.us-skill-mark { flex: none; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 6px; color: var(--us-accent); background: color-mix(in srgb, var(--us-accent) 12%, transparent); font-size: 12px; font-weight: 700; }
.us-skill-name { min-width: 0; overflow: hidden; font-weight: 580; text-overflow: ellipsis; white-space: nowrap; }
.us-skill-count { margin-left: auto; flex: none; color: var(--us-muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.us-pie-layout { display: grid; grid-template-columns: 220px 1fr; align-items: center; gap: 28px; }
.us-pie { width: 190px; aspect-ratio: 1; margin: auto; border-radius: 50%; corner-shape: round; display: grid; place-items: center; position: relative; }
.us-pie::after { content: ''; position: absolute; inset: 30px; border-radius: 50%; corner-shape: round; background: var(--us-surface); }
.us-pie-center { z-index: 1; text-align: center; font-weight: 700; font-size: 22px; font-variant-numeric: tabular-nums; }
.us-pie-center small { display: block; margin-top: 3px; color: var(--us-muted); font-weight: 400; font-size: 11px; }
.us-pie-legend { display: grid; gap: 2px; }
.us-pie-name-wrap { display: flex; align-items: center; gap: 6px; min-width: 0; }
.us-pie-source { flex: none; padding: 0 5px; border-radius: 6px; border: 1px solid var(--us-border); color: var(--us-muted); font-size: 11px; line-height: 15px; white-space: nowrap; }
.us-pie-row { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto auto; align-items: center; gap: 10px; padding: 8px 8px; border-bottom: 1px solid color-mix(in srgb, var(--us-border) 45%, transparent); border-radius: 8px; }
.us-pie-row:last-child { border-bottom: 0; }
.us-pie-row[data-active] { background: var(--us-hover); }
.us-pie-dot { width: 9px; height: 9px; border-radius: 50%; corner-shape: round; }
.us-pie-name { overflow: hidden; font-weight: 560; text-overflow: ellipsis; white-space: nowrap; }
.us-pie-tokens { color: var(--us-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.us-pie-percent { min-width: 46px; text-align: right; font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.us-state { min-height: 420px; display: grid; place-items: center; color: var(--us-muted); text-align: center; }
.us-spinner { width: 28px; height: 28px; margin: 0 auto 14px; border: 3px solid var(--us-border); border-top-color: var(--us-accent); border-radius: 50%; animation: us-spin .8s linear infinite; }
@keyframes us-spin { to { transform: rotate(360deg); } }
@keyframes us-enter { from { opacity: 0; transform: translateY(4px); } }
@keyframes us-card-in { from { opacity: 0; transform: translateY(8px); } }
@keyframes us-panel-in { from { opacity: 0; transform: translateY(10px); } }
@keyframes us-bar-in { from { transform: scaleY(0); opacity: .25; } }
@keyframes us-tip-in { from { opacity: 0; transform: translate(-50%, calc(-100% + 4px)); } }
@media (max-width: 900px) { .us-stats-strip { grid-template-columns: repeat(2, minmax(0,1fr)); } .us-stat-cell { border-left: 0; border-top: 1px solid color-mix(in srgb, var(--us-border) 45%, transparent); } .us-stat-cell:nth-child(-n+2) { border-top: 0; } .us-stat-cell:nth-child(2n) { border-left: 1px solid color-mix(in srgb, var(--us-border) 45%, transparent); } .us-duo { grid-template-columns: 1fr; } }
@media (max-width: 760px) { .us-top { min-height: 88px; gap: 10px; } .us-back { padding: 0 8px; } .us-pie-layout { grid-template-columns: 1fr; } }
@media (max-width: 480px) { .us-stats-strip { grid-template-columns: 1fr; } .us-stat-cell { border-left: 0 !important; } .us-stat-cell:nth-child(n+2) { border-top: 1px solid color-mix(in srgb, var(--us-border) 45%, transparent); } }
@media (prefers-reduced-motion: reduce) { .us-shell, .us-spinner, .us-bar, .us-stats-strip, .us-panel, .us-floating-tip { animation: none; transition: none; } }
`

    // -------------------------------------------------------------- surface 1

    /** Root session id of one tracked agent; cycle-safe, unknown ancestors count as roots. */
    function rootSessionOf(agent, byId) {
      let current = agent
      const seen = new Set()
      while (current) {
        if (seen.has(current.id)) return current.id
        seen.add(current.id)
        const parentId = current.parentSession
        if (typeof parentId !== 'string' || parentId === '') return current.id
        const parent = byId.get(parentId)
        if (!parent) return current.id
        current = parent
      }
      return agent.id
    }

    /**
     * Global activity summary: distinct top-level sessions with at least one
     * non-idle agent, plus the summed throughput of every tracked agent.
     */
    function activitySummary(data) {
      try {
        const agents = data && Array.isArray(data.agents) ? data.agents : []
        const byId = new Map()
        for (const agent of agents) {
          if (agent && typeof agent.id === 'string' && !byId.has(agent.id)) byId.set(agent.id, agent)
        }
        const roots = new Set()
        let tps = 0
        for (const agent of byId.values()) {
          tps += toNumber(agent.tps)
          if (normStatus(agent.status) === 'idle') continue
          roots.add(rootSessionOf(agent, byId))
        }
        return { sessions: roots.size, tps: round1(tps) }
      } catch {
        return { sessions: 0, tps: 0 }
      }
    }

    /**
     * Sidebar-foot row stacked above the account row, styled like it: three
     * activity bars followed by «N 会话进行中，X tok/s». In the collapsed rail only
     * the bars render; hover/focus opens the same summary as a bubble. Clicking
     * the row (wide or rail) opens the full usage-stats main panel.
     */
    function TokenSummary(props) {
      const wide = !props || props.wide !== false
      const data = useStats()
      const { sessions, tps } = activitySummary(data)
      const activity = data && data.activity && typeof data.activity === 'object' ? data.activity : null
      const active = activity && typeof activity.active === 'boolean' ? activity.active : sessions > 0
      const text = L.summary(sessions, fmtTps(tps))
      const anchorRef = react.useRef(null)
      const tipRef = react.useRef(null)
      const [open, setOpen] = react.useState(false)
      const [placement, setPlacement] = react.useState(null)

      const resetPlacement = () => {
        setPlacement((previous) => (previous === null ? previous : null))
      }

      const place = react.useCallback(() => {
        try {
          const anchor = rectOf(anchorRef.current)
          if (!anchor) {
            resetPlacement()
            return
          }
          const tipRect = tipRef.current ? rectOf(tipRef.current) : null
          const width = tipRect && tipRect.width > 0 ? tipRect.width : TIP_FALLBACK_WIDTH
          const viewportWidth = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 0
          const viewportHeight = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 0
          const gap = 8
          let left = anchor.left + anchor.width / 2 - width / 2
          if (viewportWidth > 0) left = Math.min(Math.max(gap, left), Math.max(gap, viewportWidth - width - gap))
          const bottom = viewportHeight > 0 ? viewportHeight - anchor.top + gap : gap
          if (!Number.isFinite(left) || !Number.isFinite(bottom)) {
            resetPlacement()
            return
          }
          setPlacement((previous) => (
            previous && previous.left === left && previous.bottom === bottom ? previous : { left, bottom }
          ))
        } catch {
          resetPlacement()
        }
      }, [])

      react.useLayoutEffect(() => {
        if (!open) return undefined
        place()
        let frame = 0
        if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(() => { place() })
        return () => {
          if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
        }
      }, [open, place])

      react.useEffect(() => {
        if (!open || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onReflow = () => { place() }
        window.addEventListener('resize', onReflow)
        window.addEventListener('scroll', onReflow, true)
        return () => {
          window.removeEventListener('resize', onReflow)
          window.removeEventListener('scroll', onReflow, true)
        }
      }, [open, place])

      const show = () => { setOpen(true) }
      const hide = () => { setOpen(false) }
      const bars = [0, 1, 2].map((index) => h('span', {
        key: index,
        className: 'tb-bar',
        style: { animationDelay: (index * 140) + 'ms' },
      }))
      const anchor = h('button', {
        ref: anchorRef,
        type: 'button',
        className: 'tb-summary',
        'data-active': active ? '1' : '0',
        'data-wide': wide ? '1' : '0',
        tabIndex: 0,
        'aria-label': text,
        title: wide ? text : undefined,
        onClick: () => { selectMainPanel(PANEL_ID) },
        onMouseEnter: wide ? undefined : show,
        onMouseLeave: wide ? undefined : hide,
        onFocus: wide ? undefined : show,
        onBlur: wide ? undefined : hide,
      }, [
        h('span', { key: 'bars', className: 'tb-bars' }, bars),
        wide ? h('span', { key: 'text', className: 'tb-summary-text', children: text }) : null,
      ])

      const tip = open ? reactDom.createPortal(
        h('div', {
          ref: tipRef,
          className: 'tb-tip',
          id: 'tb-summary-tip',
          role: 'tooltip',
          style: placement
            ? { left: placement.left + 'px', bottom: placement.bottom + 'px' }
            : { left: '0px', bottom: '0px', visibility: 'hidden' },
          children: text,
        }),
        document.body,
      ) : null

      return h(react.Fragment, null, anchor, tip)
    }

    // -------------------------------------------------------------- surface 2

    /**
     * Hover-card section: one compact row per in-progress agent of the session
     * subtree. Renders nothing (card unchanged) when every agent is idle.
     */
    function SessionHoverSpeed(props) {
      const sessionId = props ? props.sessionId : null
      const data = useStats()
      const rows = activeRows(data, sessionId)
      if (rows.length === 0) return null
      const children = rows.map((row) => {
        const label = rowLabel(row)
        return h('div', { className: 'tb-hover-row', key: row.id }, [
          h('span', { key: 'dot', className: 'tb-dot', 'aria-hidden': 'true', style: { background: statusColor(row.status) } }),
          h('span', {
            key: 'name',
            className: 'tb-hover-name',
            title: [label, statusText(row.status), row.model].filter(Boolean).join(' · '),
            children: label,
          }),
          h('span', { key: 'tps', className: 'tb-hover-tps', children: fmtTps(row.tps) + ' tok/s' }),
        ])
      })
      const head = rows.length > 1
        ? h('div', {
            key: 'head',
            className: 'tb-hover-head',
            children: L.active + ' ' + rows.length + ' · ' + L.sum + ' ' + fmtTps(sumTps(rows)) + ' tok/s',
          })
        : null
      return h('div', { className: 'tb-hover' }, head ? [head].concat(children) : children)
    }

    // -------------------------------------------------------------- surface 3

    /**
     * Header pill with a hover/focus popover. The pill shows the subtree total
     * once data has ever loaded (0 tok/s + gray dot for an idle session); the
     * popover lists every tracked agent, idle and 0 tok/s included. A compact
     * line-chart icon follows the pill: it records one tps sample per poll
     * while the session is active and opens the smooth history chart on hover.
     */
    function SessionHeaderSpeed(props) {
      const sessionId = props ? props.sessionId : null
      const data = useStats()
      const pillRef = react.useRef(null)
      const popRef = react.useRef(null)
      const [open, setOpen] = react.useState(false)
      const [placement, setPlacement] = react.useState(null)
      const chartRef = react.useRef(null)
      const chartPopRef = react.useRef(null)
      const [chartOpen, setChartOpen] = react.useState(false)
      const [chartPlacement, setChartPlacement] = react.useState(null)
      const sampledDataRef = react.useRef(null)

      const summary = data ? agentSpeedRows(data, sessionId) : null
      const totalTps = summary ? summary.totalTps : 0
      const sessionStatus = summary ? summary.status : 'idle'

      // Record one history point per successful poll, only while this session
      // is active. The store hands out a fresh `data` object per poll, so a
      // re-render of the same payload never records twice.
      react.useEffect(() => {
        if (!data) return
        if (sampledDataRef.current === data) return
        sampledDataRef.current = data
        recordSpeedSample(sessionId, totalTps, sessionStatus)
      }, [data, sessionId, totalTps, sessionStatus])

      const resetPlacement = () => {
        setPlacement((previous) => (previous === null ? previous : null))
      }

      const place = react.useCallback(() => {
        try {
          const pill = pillRef.current
          const pillRect = rectOf(pill)
          if (!pillRect) {
            resetPlacement()
            return
          }
          const popRect = popRef.current ? rectOf(popRef.current) : null
          const width = popRect && popRect.width > 0 ? popRect.width : POPOVER_FALLBACK_WIDTH
          const height = popRect && popRect.height > 0 ? popRect.height : 0
          const viewportWidth = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 0
          const viewportHeight = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 0
          const gap = 8
          let left = pillRect.left + pillRect.width / 2 - width / 2
          if (viewportWidth > 0) {
            left = Math.min(Math.max(gap, left), Math.max(gap, viewportWidth - width - gap))
          } else {
            left = Math.max(gap, left)
          }
          // Prefer sitting just above the pill; when the viewport cannot fit it
          // there, drop below the pill and finally clamp inside the viewport.
          let bottom = viewportHeight > 0 ? viewportHeight - pillRect.top + gap : gap
          if (viewportHeight > 0 && height > 0 && bottom > viewportHeight - height - gap) {
            const below = viewportHeight - pillRect.top - pillRect.height - gap - height
            bottom = below >= gap ? below : Math.max(gap, viewportHeight - height - gap)
          }
          if (viewportHeight > 0) bottom = Math.max(gap, Math.min(bottom, viewportHeight - gap))
          if (!Number.isFinite(left) || !Number.isFinite(bottom)) {
            resetPlacement()
            return
          }
          setPlacement((previous) => (
            previous && previous.left === left && previous.bottom === bottom ? previous : { left, bottom }
          ))
        } catch {
          resetPlacement()
        }
      }, [])

      react.useLayoutEffect(() => {
        if (!open) return undefined
        // The popover is already committed here, so let it be measured for the
        // viewport clamp. The extra frame absorbs font/paint settling.
        place()
        let frame = 0
        if (typeof requestAnimationFrame === 'function') {
          frame = requestAnimationFrame(() => { place() })
        }
        return () => {
          if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
        }
      }, [open, place])

      react.useEffect(() => {
        if (!open || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onReflow = () => { place() }
        window.addEventListener('resize', onReflow)
        window.addEventListener('scroll', onReflow, true)
        return () => {
          window.removeEventListener('resize', onReflow)
          window.removeEventListener('scroll', onReflow, true)
        }
      }, [open, place])

      const resetChartPlacement = () => {
        setChartPlacement((previous) => (previous === null ? previous : null))
      }

      const placeChart = react.useCallback(() => {
        try {
          const anchor = rectOf(chartRef.current)
          if (!anchor) {
            resetChartPlacement()
            return
          }
          const popRect = chartPopRef.current ? rectOf(chartPopRef.current) : null
          const width = popRect && popRect.width > 0 ? popRect.width : CHART_FALLBACK_WIDTH
          const height = popRect && popRect.height > 0 ? popRect.height : CHART_FALLBACK_HEIGHT
          const viewportWidth = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 0
          const viewportHeight = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 0
          const gap = 8
          let left = anchor.left + anchor.width / 2 - width / 2
          if (viewportWidth > 0) {
            left = Math.min(Math.max(gap, left), Math.max(gap, viewportWidth - width - gap))
          } else {
            left = Math.max(gap, left)
          }
          let bottom = viewportHeight > 0 ? viewportHeight - anchor.top + gap : gap
          if (viewportHeight > 0 && height > 0 && bottom > viewportHeight - height - gap) {
            const below = viewportHeight - anchor.top - anchor.height - gap - height
            bottom = below >= gap ? below : Math.max(gap, viewportHeight - height - gap)
          }
          if (viewportHeight > 0) bottom = Math.max(gap, Math.min(bottom, viewportHeight - gap))
          if (!Number.isFinite(left) || !Number.isFinite(bottom)) {
            resetChartPlacement()
            return
          }
          setChartPlacement((previous) => (
            previous && previous.left === left && previous.bottom === bottom ? previous : { left, bottom }
          ))
        } catch {
          resetChartPlacement()
        }
      }, [])

      react.useLayoutEffect(() => {
        if (!chartOpen) return undefined
        placeChart()
        let frame = 0
        if (typeof requestAnimationFrame === 'function') {
          frame = requestAnimationFrame(() => { placeChart() })
        }
        return () => {
          if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
        }
      }, [chartOpen, placeChart])

      react.useEffect(() => {
        if (!chartOpen || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onReflow = () => { placeChart() }
        window.addEventListener('resize', onReflow)
        window.addEventListener('scroll', onReflow, true)
        return () => {
          window.removeEventListener('resize', onReflow)
          window.removeEventListener('scroll', onReflow, true)
        }
      }, [chartOpen, placeChart])

      if (!data || !summary) return null
      const totalText = fmtTps(summary.totalTps) + ' tok/s'
      const show = () => { setOpen(true) }
      const hide = () => { setOpen(false) }
      const showChart = () => { setChartOpen(true) }
      const hideChart = () => { setChartOpen(false) }

      const pill = h('div', {
        ref: pillRef,
        key: 'pill',
        className: 'tb-pill',
        tabIndex: 0,
        'aria-label': L.total + ' ' + totalText,
        'aria-describedby': open ? POPOVER_ID : undefined,
        title: L.total,
        onMouseEnter: show,
        onMouseLeave: hide,
        onFocus: show,
        onBlur: hide,
      }, [
        h('span', { key: 'dot', className: 'tb-dot', style: { background: statusColor(summary.status) } }),
        h('span', { key: 'tps', className: 'tb-pill-tps', children: totalText }),
      ])

      // The history icon sits flush to the right of the throughput counter;
      // hovering/focusing it opens the smooth speed-history panel.
      const chartButton = h('button', {
        ref: chartRef,
        key: 'chart',
        type: 'button',
        className: 'tb-chart-btn',
        'aria-label': L.chartTitle,
        'aria-describedby': chartOpen ? CHART_POP_ID : undefined,
        title: L.chartTitle,
        onMouseEnter: showChart,
        onMouseLeave: hideChart,
        onFocus: showChart,
        onBlur: hideChart,
      }, h(ChartIcon))
      const pillGroup = h('span', { className: 'tb-throughput' }, [pill, chartButton])

      const rows = summary.all.slice(0, POPOVER_MAX_ROWS)
      const hidden = summary.all.length - rows.length
      const popChildren = [
        h('div', { key: 'head', className: 'tb-pop-head' }, [
          h('span', { key: 'title', className: 'tb-pop-title', children: L.total }),
          h('span', { key: 'total', className: 'tb-pop-total', children: totalText }),
        ]),
        h('div', { key: 'divider', className: 'tb-pop-div' }),
      ]
      for (const row of rows) {
        const label = rowLabel(row)
        popChildren.push(h('div', { className: 'tb-pop-row', key: row.id }, [
          h('span', { key: 'dot', className: 'tb-dot', 'aria-hidden': 'true', style: { background: statusColor(row.status) } }),
          h('span', {
            key: 'name',
            className: 'tb-pop-name',
            title: [label, row.model].filter(Boolean).join(' · '),
            children: label,
          }),
          h('span', { key: 'status', className: 'tb-pop-status', children: statusText(row.status) }),
          h('span', { key: 'tps', className: 'tb-pop-tps', children: fmtTps(row.tps) + ' tok/s' }),
        ]))
      }
      if (summary.all.length === 0) {
        popChildren.push(h('div', {
          key: 'empty',
          className: 'tb-pop-more',
          style: { textAlign: 'left' },
          children: L.noActivity,
        }))
      }
      if (hidden > 0) {
        popChildren.push(h('div', { key: 'more', className: 'tb-pop-more', children: '+' + hidden }))
      }

      const popover = open ? reactDom.createPortal(
        h('div', {
          ref: popRef,
          className: 'tb-pop',
          id: POPOVER_ID,
          role: 'tooltip',
          style: placement
            ? { left: placement.left + 'px', bottom: placement.bottom + 'px' }
            : { left: '0px', bottom: '0px', visibility: 'hidden' },
        }, popChildren),
        document.body,
      ) : null

      const chartPanel = chartOpen ? reactDom.createPortal(
        h('div', {
          ref: chartPopRef,
          className: 'tb-pop tb-chart-pop',
          id: CHART_POP_ID,
          role: 'tooltip',
          style: chartPlacement
            ? { left: chartPlacement.left + 'px', bottom: chartPlacement.bottom + 'px' }
            : { left: '0px', bottom: '0px', visibility: 'hidden' },
        }, h(SpeedHistoryPanel, { sessionId })),
        document.body,
      ) : null

      return h(react.Fragment, null, pillGroup, popover, chartPanel)
    }

    // ------------------------------------------------------------------- apply

    function apply(ctx) {
      // Panel navigation face shared by the footer row and the panel's own
      // back/Esc affordances. `layout` is a declared dependency; stay inert if
      // the service is somehow absent so a click can never throw.
      panelSelect = ctx && ctx.layout && typeof ctx.layout.selectPanel === 'function'
        ? (panelId) => { ctx.layout.selectPanel(panelId) }
        : null

      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-token-board'
      style.textContent = CSS + '\n' + US_CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { style.remove() }, 'token-board: styles')
      ctx.effect(() => () => { panelSelect = null }, 'token-board: panel navigation')

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'token-board-summary',
        order: 10,
      }, TokenSummary))

      ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
        name: 'sidebar.session.row.hover',
        id: 'token-board-speeds',
        order: 10,
      }, SessionHoverSpeed))

      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'token-board-throughput',
        order: 100,
        label: () => 'Token 吞吐',
      }, SessionHeaderSpeed))

      // Keyed main panel (DSH 0.2.2): the footer summary row selects it through
      // ctx.layout.selectPanel(PANEL_ID); the panel's back button / Esc clears
      // the selection again. No sidebar panellist entry by design.
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, StatsPanel))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
