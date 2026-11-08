/**
 * dsh-token-board — 使用统计（usage stats）聚合半边。
 *
 * 纯 ESM、零 npm 依赖（只用 Node 内置的 fs/promises、path、os）：做「会话事件日志 →
 * 单会话汇总 → 统计快照」的折叠与计算，并把单会话汇总持久化为本地索引，避免每次打开
 * 统计面板都重放全部会话日志。数据来源是可选宿主服务 `ctx.get('sessionQuery')`：
 *   - `listSessions()` → `{ header, live, persisted }[]`
 *   - `readSession(id)` → `{ session, inheritedEventCount, events }`
 * （DSH 0.2.2 的 `SessionLogSnapshot`；0.1.x 的 header.seedLength 仅作兼容回退。）
 *
 * 设计取自参考实现 dsh-token-usage-board 的 `src/types.ts` / `src/core.ts` /
 * `src/index.ts` 的「快照聚合」部分，并适配本 checkout：
 *   - 0.2.2 用 `inheritedEventCount` 精确剔除 fork 继承前缀（0.1.x 是 header.seedLength）；
 *   - `request/header` 的 `data.header.config.reasoningEffort`、`assistant/message` 的
 *     `data.message.source.{provider,model}` 与 `data.usage`、`user/message` 的
 *     `data.source.kind === 'user'`、`tool/call` 的 `data.{name,arguments}` 均与 0.2.2 一致；
 *   - 只保留 UI 需要的字段：去掉 calls / CSV/JSON 导出 / scope 过滤；
 *   - 额外持久化单会话索引（`$DSH_HOME/token-board/usage-index.json`，版本化、原子写、
 *     防抖 ~1s），并在快照上新增 `indexReady` 标识索引是否已补齐（性能修复，不改其余形状）。
 *
 * 返回的快照形状与参考 `StatsSnapshot` 一致（UI 用到的 `totals`、`allTime.totals`、
 * `allTime.models`、`days`、`models`、`topSkills`、`generatedAt`、`range`、`index` 全部正确）。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** 聚合结果纯内存缓存 TTL（毫秒）；`refresh=1` 强制绕过。 */
export const USAGE_CACHE_TTL_MS = 30_000;

/** 历史会话并发读取数（参考实现的 `indexConcurrency` 默认值）。 */
export const USAGE_READ_CONCURRENCY = 2;

/** 快速模型 id 的默认匹配式（大小写不敏感）：命中后计入 fastCalls。 */
export const DEFAULT_FAST_MODEL_PATTERN = 'flash|turbo|lite|nano|haiku|fast|mini';

/** 持久化会话索引的 schema 版本；不兼容的历史/外来缓存会被忽略并重建。 */
export const USAGE_INDEX_VERSION = 1;

/** 索引写盘防抖（毫秒）。 */
export const USAGE_INDEX_WRITE_DELAY_MS = 1000;

/** 初次后台索引（冷启动补齐缺失会话）的读取并发。 */
export const USAGE_INDEX_CONCURRENCY = 4;

/** 刷新/重启补读「仍活跃 / 上次保存时仍活跃」会话的上限：保持数据新鲜又不阻塞请求。 */
export const USAGE_REFRESH_LIVE_LIMIT = 8;

/** 初次后台索引失败后的重试间隔（毫秒）。 */
const USAGE_WARM_RETRY_MS = 5000;

/** 归日时区缺省值；参考实现同样以 UTC 为默认。 */
const DEFAULT_TIME_ZONE = 'UTC';

const DSH_HOME_ENV = 'DSH_HOME';
const DSH_HOME_DIR_NAME = '.dsh';
const USAGE_INDEX_DIR_NAME = 'token-board';
const USAGE_INDEX_FILE_NAME = 'usage-index.json';

/** 查询区间跨度上限（天）：与参考实现一致（10 年）。 */
const MAX_RANGE_DAYS = 3660;

/** 缓存条目上限：不同 from/to/timeZone 组合不会无限占用内存。 */
const MAX_CACHE_ENTRIES = 8;

/** 模型占比下拉的滚动时间窗口（毫秒）；与客户端 `24h / 7d / 30d` 选项对应。 */
export const MODEL_WINDOW_MS = Object.freeze({
	'24h': 24 * 60 * 60 * 1000,
	'7d': 7 * 24 * 60 * 60 * 1000,
	'30d': 30 * 24 * 60 * 60 * 1000,
});

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const ZERO_TOKENS = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

function isObject(value) {
	return value !== null && typeof value === 'object';
}

/** 有限时间戳；非法值返回 null（事件缺失/损坏时不污染统计）。 */
function finiteTime(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 非负有限计数：下取整；NaN/Infinity/负数一律 0（与参考实现一致）。 */
function finiteCount(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 安全取对象字段；非对象一律 null。 */
function objectAt(value) {
	return isObject(value) ? value : null;
}

/**
 * 解析 `skill` 工具调用的 `name` 参数；缺失/畸形 JSON 返回 null。
 * DSH 0.2.2 的 `tool/call.data.arguments` 仍是模型产出的原始 JSON 字符串。
 */
export function parseSkillName(argumentsJson) {
	if (typeof argumentsJson !== 'string' || argumentsJson.length === 0) return null;
	try {
		const parsed = JSON.parse(argumentsJson);
		if (!isObject(parsed)) return null;
		const skillName = parsed.name;
		return typeof skillName === 'string' && skillName.length > 0 ? skillName : null;
	} catch {
		return null;
	}
}

/**
 * 扩展单个会话的计数字段（活动跨度、工具/技能计数）。内容只投影为计数器，不保留载荷。
 * @param {object} summary 目标会话汇总（就地更新）
 * @param {object} event 一条 SessionEvent
 */
function recordSessionMeta(summary, event) {
	const time = finiteTime(event?.time);
	if (time !== null) {
		if (summary.firstAt === undefined || time < summary.firstAt) summary.firstAt = time;
		if (summary.lastAt === undefined || time > summary.lastAt) summary.lastAt = time;
	}
	if (event?.type !== 'tool/call') return;
	const data = objectAt(event.data);
	if (data === null) return;
	const toolName = data.name;
	if (typeof toolName !== 'string' || toolName.length === 0) return;
	if (toolName === 'skill') {
		const skillName = parseSkillName(data.arguments);
		if (skillName !== null) summary.skills[skillName] = (summary.skills[skillName] ?? 0) + 1;
		return;
	}
	summary.tools[toolName] = (summary.tools[toolName] ?? 0) + 1;
}

/** 每个会话折叠时的临时状态：配对 step 耗时、追踪最近一次推理强度。 */
function newCollectState() {
	return { openStep: null, currentEffort: undefined };
}

/**
 * 从一条事件投影出「活动记录」；不需要的事件返回 null。
 * 活动记录只含聚合需要的元数据（序号/时间/来源/模型/Token/耗时/effort）。
 */
function activityFromEvent(event, state) {
	if (!isObject(event)) return null;
	const time = finiteTime(event.time);
	if (time === null) return null;
	const data = objectAt(event.data) ?? {};
	switch (event.type) {
		case 'step/start': {
			const turn = finiteCount(data.turn);
			const step = finiteCount(data.step);
			state.openStep = { turn, step, time };
			return null;
		}
		case 'request/header': {
			// 0.2.2: data.header.config = LlmCallConfig { provider, model, reasoningEffort? }
			const config = objectAt(objectAt(data.header)?.config);
			const effort = config?.reasoningEffort;
			if (typeof effort === 'string' && effort.length > 0) state.currentEffort = effort;
			return null;
		}
		case 'step/end':
		case 'turn/end':
			state.openStep = null;
			return null;
		case 'user/message': {
			// 只有真人输入（source.kind === 'user'）计为 human；注入上下文（schedule/plugin/…）不计。
			return objectAt(data.source)?.kind === 'user'
				? { seq: finiteCount(event.seq), time, kind: 'human' }
				: null;
		}
		case 'assistant/message': {
			const usage = objectAt(data.usage);
			const source = objectAt(objectAt(data.message)?.source);
			const turn = finiteCount(data.turn);
			const step = finiteCount(data.step);
			let durationMs;
			if (state.openStep !== null && state.openStep.turn === turn && state.openStep.step === step) {
				durationMs = Math.max(0, time - state.openStep.time);
				state.openStep = null;
			}
			const activity = {
				seq: finiteCount(event.seq),
				time,
				kind: 'assistant',
				provider: typeof source?.provider === 'string' && source.provider.length > 0 ? source.provider : undefined,
				model: typeof source?.model === 'string' && source.model.length > 0 ? source.model : undefined,
				tokens: {
					input: finiteCount(usage?.inputTokens),
					output: finiteCount(usage?.outputTokens),
					cacheRead: finiteCount(usage?.cacheReadTokens),
					cacheWrite: finiteCount(usage?.cacheWriteTokens),
					reasoning: finiteCount(usage?.reasoningTokens),
				},
			};
			if (durationMs !== undefined) activity.durationMs = durationMs;
			if (state.currentEffort !== undefined) activity.effort = state.currentEffort;
			return activity;
		}
		default:
			return null;
	}
}

/**
 * 把一个会话的完整事件日志折叠为 `SessionSummary`。
 *
 * @param {object} header SessionHeader（0.2.2：含 isSeeded / origin；不再有 seedLength）
 * @param {object[]} events 完整原始事件日志（含 fork 继承前缀）
 * @param {number} [inheritedEventCount] 0.2.2 的继承前缀长度；缺省时回退 header.seedLength
 * @param {number} [indexedAt] 索引时间（快照 `index.lastUpdatedAt` 用）
 * @returns {object} SessionSummary
 */
export function summarizeSession(header, events, inheritedEventCount, indexedAt = Date.now()) {
	const sessionHeader = objectAt(header) ?? {};
	const list = Array.isArray(events) ? events : [];
	let inherited = Number.isSafeInteger(inheritedEventCount) && inheritedEventCount > 0
		? inheritedEventCount
		// 兼容 0.1.x 形状：父会话 + seedLength 表示 fork 继承前缀（0.2.2 已移出 header）。
		: (sessionHeader.parentSession !== undefined && Number.isSafeInteger(sessionHeader.seedLength) && sessionHeader.seedLength > 0
			? sessionHeader.seedLength
			: 0);
	// 防御回退：宿主声明 isSeeded 却没给 inheritedEventCount 时，用标记事件
	// `session/end-seed { inherited: true }` 的 seq（= 继承前缀长度）兜底，避免父前缀被重复计费。
	if (inherited <= 0 && sessionHeader.isSeeded === true) {
		for (const event of list) {
			if (!isObject(event) || event.type !== 'session/end-seed') continue;
			const markerData = objectAt(event.data);
			if (markerData?.inherited !== true) continue;
			const markerSeq = finiteTime(event.seq);
			if (markerSeq !== null && markerSeq > 0) inherited = markerSeq;
			break;
		}
	}
	const activities = [];
	const summary = {
		id: sessionHeader.id === undefined || sessionHeader.id === null ? '' : String(sessionHeader.id),
		createdAt: finiteTime(sessionHeader.createdAt) ?? 0,
		lastSeq: -1,
		indexedAt,
		activities,
		tools: {},
		skills: {},
	};
	const state = newCollectState();
	for (const event of list) {
		if (!isObject(event)) continue;
		// fork 子会话的日志带父会话前缀：精确跳过 inheritedEventCount 条，避免重复计费。
		if (inherited > 0) {
			const seq = finiteTime(event.seq);
			if (seq !== null && seq < inherited) continue;
		}
		recordSessionMeta(summary, event);
		const activity = activityFromEvent(event, state);
		if (activity !== null) activities.push(activity);
	}
	const lastEvent = list.at(-1);
	if (isObject(lastEvent)) {
		const lastSeq = finiteTime(lastEvent.seq);
		if (lastSeq !== null) summary.lastSeq = lastSeq;
	}
	if (typeof sessionHeader.cwd === 'string') summary.cwd = sessionHeader.cwd;
	if (sessionHeader.parentSession !== undefined && sessionHeader.parentSession !== null) {
		summary.parentSession = String(sessionHeader.parentSession);
	}
	return summary;
}

/** 按 timeZone 构造日期格式化器；非法时区回退 UTC（入口已校验，这里只防御）。 */
function formatter(timeZone) {
	try {
		return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
	} catch {
		return new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
	}
}

/** 时间戳 → 该时区下的 `YYYY-MM-DD`。 */
function dateKey(value, format) {
	const parts = format.formatToParts(value);
	let year = '1970';
	let month = '01';
	let day = '01';
	for (const part of parts) {
		if (part.type === 'year') year = part.value;
		else if (part.type === 'month') month = part.value;
		else if (part.type === 'day') day = part.value;
	}
	return `${year}-${month}-${day}`;
}

/** `YYYY-MM-DD` 加减天数（按 UTC 日历，不受时区影响）。 */
function shiftDate(date, deltaDays) {
	const value = new Date(`${date}T00:00:00Z`);
	if (!Number.isFinite(value.getTime())) return date;
	value.setUTCDate(value.getUTCDate() + deltaDays);
	return value.toISOString().slice(0, 10);
}

/** 严格校验 `YYYY-MM-DD`（含日历合法性；参考实现只查格式）。 */
function isIsoDate(value) {
	if (typeof value !== 'string') return false;
	const match = ISO_DATE.exec(value);
	if (match === null) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return false;
	const cursor = new Date(0);
	cursor.setUTCFullYear(year, month - 1, day);
	cursor.setUTCHours(0, 0, 0, 0);
	return cursor.getUTCFullYear() === year && cursor.getUTCMonth() === month - 1 && cursor.getUTCDate() === day;
}

/** 闭区间日期序列（升序）；上限由 MAX_RANGE_DAYS 保护。 */
function datesBetween(from, to) {
	const days = [];
	const cursor = new Date(`${from}T00:00:00Z`);
	const end = new Date(`${to}T00:00:00Z`);
	if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(end.getTime())) return days;
	while (cursor <= end && days.length < MAX_RANGE_DAYS + 1) {
		days.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return days;
}

function newDay(date) {
	return { date, tokens: 0, calls: 0, messages: 0, sessions: 0, models: {}, ...ZERO_TOKENS() };
}

/** 最长连续活跃天数（集合内相邻日历日的最长连续段）。 */
function longestStreak(dates) {
	if (dates.size === 0) return 0;
	const sorted = [...dates].sort();
	let best = 1;
	let run = 1;
	for (let index = 1; index < sorted.length; index += 1) {
		if (shiftDate(sorted[index - 1], 1) === sorted[index]) {
			run += 1;
			if (run > best) best = run;
		} else {
			run = 1;
		}
	}
	return best;
}

/** 当前连续活跃天数：以今天锚定，今天尚无活动则回退到昨天（与参考实现一致）。 */
function currentStreak(dates, format, now = Date.now()) {
	let cursor = dateKey(now, format);
	if (!dates.has(cursor)) cursor = shiftDate(cursor, -1);
	let streak = 0;
	while (dates.has(cursor)) {
		streak += 1;
		cursor = shiftDate(cursor, -1);
	}
	return streak;
}

function sessionSpanMs(session) {
	if (session.firstAt === undefined || session.lastAt === undefined) return 0;
	return Math.max(0, session.lastAt - session.firstAt);
}

/** 统一 Token 桶：缺字段/非法值按 0，避免 NaN 污染合计。 */
function normalizedTokens(value) {
	if (!isObject(value)) return ZERO_TOKENS();
	return {
		input: finiteCount(value.input),
		output: finiteCount(value.output),
		cacheRead: finiteCount(value.cacheRead),
		cacheWrite: finiteCount(value.cacheWrite),
		reasoning: finiteCount(value.reasoning),
	};
}

/** 把一组 Token 桶累加进目标，返回计费 token 数（输入+输出+缓存读写，不含 reasoning）。 */
function addTokens(target, value) {
	target.input += value.input;
	target.output += value.output;
	target.cacheRead += value.cacheRead;
	target.cacheWrite += value.cacheWrite;
	target.reasoning += value.reasoning;
	return value.input + value.output + value.cacheRead + value.cacheWrite;
}

/** 归一化查询对象（入口 parseUsageQuery 已校验；这里容忍直接调用）。 */
function normalizeQuery(query) {
	const source = isObject(query) ? query : {};
	const from = typeof source.from === 'string' && source.from !== '' ? source.from : '1970-01-01';
	const rawTo = typeof source.to === 'string' && source.to !== '' ? source.to : from;
	const timeZone = typeof source.timeZone === 'string' && source.timeZone !== '' ? source.timeZone : DEFAULT_TIME_ZONE;
	return { from, to: rawTo, timeZone };
}

/** 编译快速模型匹配式：非法正则回退默认值；去掉 g/y 以免 test() 带 lastIndex 状态。 */
export function compileFastModelPattern(value) {
	if (value instanceof RegExp) {
		try {
			return new RegExp(value.source, value.flags.replace(/[gy]/g, ''));
		} catch {
			return new RegExp(DEFAULT_FAST_MODEL_PATTERN, 'i');
		}
	}
	const source = typeof value === 'string' && value.length > 0 ? value : DEFAULT_FAST_MODEL_PATTERN;
	try {
		return new RegExp(source, 'i');
	} catch {
		return new RegExp(DEFAULT_FAST_MODEL_PATTERN, 'i');
	}
}

/** 展开 `~`/`~/`/`~\\` 前缀；其余原样返回。 */
function expandHomePath(value) {
	if (value === '~') return homedir();
	if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
	return value;
}

/**
 * 解析持久化索引路径：`$DSH_HOME/token-board/usage-index.json`。
 * 规则与 DSH home-paths 一致：`$DSH_HOME`（非空白）优先，否则 `~/.dsh`；
 * 空/空白环境变量视为未设置，结果始终是绝对路径。
 * @param {Record<string, string | undefined>} [env]
 * @returns {string|null} 绝对路径；无法解析 home 时 null（禁用持久化）。
 */
export function resolveUsageIndexPath(env = process.env) {
	try {
		const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
		const home = configured.length > 0 ? expandHomePath(configured) : join(homedir(), DSH_HOME_DIR_NAME);
		return resolve(home, USAGE_INDEX_DIR_NAME, USAGE_INDEX_FILE_NAME);
	} catch {
		return null;
	}
}

/** 从构造选项解析缓存路径：未提供 => $DSH_HOME 默认；null/false/空串 => 显式禁用。 */
function cachePathFromOptions(options) {
	if (!Object.prototype.hasOwnProperty.call(options, 'cachePath') || options.cachePath === undefined) {
		return resolveUsageIndexPath();
	}
	const configured = options.cachePath;
	if (configured === null || configured === false) return null;
	if (typeof configured !== 'string' || configured.trim() === '') return null;
	try {
		return resolve(expandHomePath(configured.trim()));
	} catch {
		return null;
	}
}

/**
 * 聚合统计快照（参考 `aggregateStats` 的移植；删去 calls/scope/workspace 过滤）。
 *
 * @param {Iterable<object>} sessions `summarizeSession` 产出的会话汇总
 * @param {{from: string, to: string, timeZone: string}} query 已校验的查询区间
 * @param {{fastModelPattern?: RegExp|string, indexReady?: boolean}} [options]
 * @returns {object} StatsSnapshot
 */
export function aggregateStats(sessions, query, options = {}) {
	const source = isObject(options) ? options : {};
	const allSessions = [];
	if (sessions !== null && sessions !== undefined && typeof sessions === 'object' && Symbol.iterator in sessions) {
		for (const session of sessions) if (isObject(session)) allSessions.push(session);
	}
	const range = normalizeQuery(query);
	const format = formatter(range.timeZone);
	const fastPattern = compileFastModelPattern(source.fastModelPattern);

	const days = datesBetween(range.from, range.to).map(newDay);
	const byDate = new Map(days.map((day) => [day.date, day]));
	const activeSessionsByDay = new Map();
	const models = new Map();
	const sessionIds = new Set();
	const activeDates = new Set();
	const totals = { tokens: 0, sessions: 0, messages: 0, activeDays: 0, currentStreak: 0, ...ZERO_TOKENS() };
	const allTimeTotals = {
		tokens: 0, sessions: 0, messages: 0, activeDays: 0, currentStreak: 0,
		peakDayTokens: 0, longestSessionMs: 0, longestStreak: 0, chats: 0,
		totalCalls: 0, fastCalls: 0, skillInvocations: 0, uniqueSkills: 0, efforts: [],
		...ZERO_TOKENS(),
	};
	const allTimeModels = new Map();
	const allTimeSessionIds = new Set();
	const allTimeActiveDates = new Set();
	const allTimeDailyTokens = new Map();
	const allTimeEfforts = new Map();
	const skillRuns = new Map();
	let allTimeTotalCalls = 0;
	let allTimeFastCalls = 0;
	let allTimeLongestSessionMs = 0;
	let allTimeSkillInvocations = 0;
	const allTimeSkillNames = new Set();
	const modelWindowNow = Date.now();
	const windowModels = new Map(Object.keys(MODEL_WINDOW_MS).map((id) => [id, new Map()]));

	for (const session of allSessions) {
		let sessionActive = false;
		let allTimeSessionActive = false;
		const skills = objectAt(session.skills) ?? {};
		for (const skillName of Object.keys(skills)) {
			const runs = finiteCount(skills[skillName]);
			if (runs === 0) continue;
			allTimeSkillInvocations += runs;
			allTimeSkillNames.add(skillName);
			skillRuns.set(skillName, (skillRuns.get(skillName) ?? 0) + runs);
		}
		const spanMs = sessionSpanMs(session);
		if (spanMs > allTimeLongestSessionMs) allTimeLongestSessionMs = spanMs;
		const activities = Array.isArray(session.activities) ? session.activities : [];
		for (const activity of activities) {
			if (!isObject(activity)) continue;
			const time = finiteTime(activity.time);
			if (time === null) continue;
			const dayKey = dateKey(time, format);
			allTimeTotals.messages += 1;
			allTimeSessionActive = true;
			allTimeActiveDates.add(dayKey);
			if (activity.kind === 'assistant' && activity.tokens !== undefined) {
				const tokens = normalizedTokens(activity.tokens);
				const provider = typeof activity.provider === 'string' && activity.provider.length > 0 ? activity.provider : 'unknown';
				const model = typeof activity.model === 'string' && activity.model.length > 0 ? activity.model : 'unknown';
				const key = `${provider}/${model}`;
				let modelStats = allTimeModels.get(key);
				if (modelStats === undefined) {
					modelStats = { key, provider, model, tokens: 0, calls: 0, percent: 0, ...ZERO_TOKENS() };
					allTimeModels.set(key, modelStats);
				}
				const amount = addTokens(modelStats, tokens);
				modelStats.tokens += amount;
				modelStats.calls += 1;
				allTimeTotals.tokens += amount;
				addTokens(allTimeTotals, tokens);
				allTimeTotalCalls += 1;
				allTimeDailyTokens.set(dayKey, (allTimeDailyTokens.get(dayKey) ?? 0) + amount);
				if (typeof activity.effort === 'string' && activity.effort.length > 0) {
					allTimeEfforts.set(activity.effort, (allTimeEfforts.get(activity.effort) ?? 0) + 1);
				}
				if (model !== '' && fastPattern.test(model)) allTimeFastCalls += 1;
				// Rolling windows for the model-share range selector: exact token
				// totals over the last 24h / 7d / 30d by activity timestamp.
				for (const [windowId, windowMs] of Object.entries(MODEL_WINDOW_MS)) {
					if (time < modelWindowNow - windowMs) continue;
					const windowMap = windowModels.get(windowId);
					let windowStats = windowMap.get(key);
					if (windowStats === undefined) {
						windowStats = { key, provider, model, tokens: 0, calls: 0, percent: 0, ...ZERO_TOKENS() };
						windowMap.set(key, windowStats);
					}
					windowStats.tokens += addTokens(windowStats, tokens);
					windowStats.calls += 1;
				}
			}
			const day = byDate.get(dayKey);
			if (day === undefined) continue;
			day.messages += 1;
			totals.messages += 1;
			sessionActive = true;
			activeDates.add(dayKey);
			let daySessions = activeSessionsByDay.get(dayKey);
			if (daySessions === undefined) activeSessionsByDay.set(dayKey, daySessions = new Set());
			daySessions.add(session.id);
			if (activity.kind !== 'assistant' || activity.tokens === undefined) continue;
			const tokens = normalizedTokens(activity.tokens);
			day.calls += 1;
			const provider = typeof activity.provider === 'string' && activity.provider.length > 0 ? activity.provider : 'unknown';
			const model = typeof activity.model === 'string' && activity.model.length > 0 ? activity.model : 'unknown';
			const key = `${provider}/${model}`;
			let modelStats = models.get(key);
			if (modelStats === undefined) {
				modelStats = { key, provider, model, tokens: 0, calls: 0, percent: 0, ...ZERO_TOKENS() };
				models.set(key, modelStats);
			}
			const amount = addTokens(modelStats, tokens);
			modelStats.tokens += amount;
			modelStats.calls += 1;
			day.tokens += amount;
			day.models[key] = (day.models[key] ?? 0) + amount;
			addTokens(day, tokens);
			totals.tokens += amount;
			addTokens(totals, tokens);
		}
		if (sessionActive) sessionIds.add(session.id);
		if (allTimeSessionActive) allTimeSessionIds.add(session.id);
	}

	for (const day of days) day.sessions = activeSessionsByDay.get(day.date)?.size ?? 0;
	totals.sessions = sessionIds.size;
	totals.activeDays = activeDates.size;
	for (let index = days.length - 1; index >= 0; index -= 1) {
		const day = days[index];
		if (day === undefined || !activeDates.has(day.date)) break;
		totals.currentStreak += 1;
	}

	const sortedModels = [...models.values()].sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
	for (const model of sortedModels) model.percent = totals.tokens === 0 ? 0 : model.tokens / totals.tokens * 100;

	allTimeTotals.sessions = allTimeSessionIds.size;
	allTimeTotals.activeDays = allTimeActiveDates.size;
	allTimeTotals.currentStreak = currentStreak(allTimeActiveDates, format);
	let allTimePeakDayTokens = 0;
	for (const tokens of allTimeDailyTokens.values()) if (tokens > allTimePeakDayTokens) allTimePeakDayTokens = tokens;
	allTimeTotals.longestStreak = longestStreak(allTimeActiveDates);
	allTimeTotals.peakDayTokens = allTimePeakDayTokens;
	allTimeTotals.longestSessionMs = allTimeLongestSessionMs;
	allTimeTotals.chats = allTimeSessionIds.size;
	allTimeTotals.totalCalls = allTimeTotalCalls;
	allTimeTotals.fastCalls = allTimeFastCalls;
	allTimeTotals.skillInvocations = allTimeSkillInvocations;
	allTimeTotals.uniqueSkills = allTimeSkillNames.size;
	allTimeTotals.efforts = [...allTimeEfforts.entries()]
		.map(([id, calls]) => ({ id, calls, percent: allTimeTotalCalls === 0 ? 0 : calls / allTimeTotalCalls * 100 }))
		.sort((a, b) => b.calls - a.calls || a.id.localeCompare(b.id));

	const sortedAllTimeModels = [...allTimeModels.values()].sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
	for (const model of sortedAllTimeModels) model.percent = allTimeTotals.tokens === 0 ? 0 : model.tokens / allTimeTotals.tokens * 100;

	// Rolling model windows: sorted rows with percentages relative to their own
	// window total, so the pie's legend and center agree without extra math.
	const modelWindows = {};
	for (const windowId of Object.keys(MODEL_WINDOW_MS)) {
		const windowList = [...windowModels.get(windowId).values()]
			.sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));
		let windowTotal = 0;
		for (const model of windowList) windowTotal += model.tokens;
		for (const model of windowList) model.percent = windowTotal === 0 ? 0 : model.tokens / windowTotal * 100;
		modelWindows[windowId] = { total: windowTotal, models: windowList };
	}

	const topSkills = [...skillRuns.entries()]
		.map(([skillName, runs]) => ({ name: skillName, runs }))
		.sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name))
		.slice(0, 5);

	// workspaces 不参与 UI（照参考保留形状，值为全量会话按 cwd 去重计数）。
	const workspaceCounts = new Map();
	for (const session of allSessions) {
		if (typeof session.cwd !== 'string') continue;
		let ids = workspaceCounts.get(session.cwd);
		if (ids === undefined) workspaceCounts.set(session.cwd, ids = new Set());
		ids.add(session.id);
	}
	const workspaces = [...workspaceCounts.entries()]
		.map(([path, ids]) => ({ path, sessions: ids.size }))
		.sort((a, b) => b.sessions - a.sessions || a.path.localeCompare(b.path));

	let lastUpdatedAt = null;
	for (const session of allSessions) {
		const at = finiteTime(session.indexedAt);
		if (at === null) continue;
		if (lastUpdatedAt === null || at > lastUpdatedAt) lastUpdatedAt = at;
	}

	return {
		generatedAt: Date.now(),
		/** 会话索引是否已完成首轮（false = 仍有会话未纳入，UI 可展示部分数据）。 */
		indexReady: source.indexReady === true,
		range: { from: range.from, to: range.to, timeZone: range.timeZone },
		totals,
		mostUsedModel: sortedModels[0] ?? null,
		allTime: { totals: allTimeTotals, models: sortedAllTimeModels, mostUsedModel: sortedAllTimeModels[0] ?? null },
		modelWindows,
		days,
		models: sortedModels,
		workspaces,
		topSkills,
		index: { sessions: allSessions.length, lastUpdatedAt },
	};
}

/**
 * 校验并解析 `/usage` 查询参数。
 *
 * - `to` 默认今天（按 timeZone），`from` 默认 `to` 前 29 天；
 * - `from`/`to` 必须是合法 `YYYY-MM-DD`，`from <= to`，跨度 ≤ 3660 天；
 * - `timeZone` 默认 UTC，必须是 Intl 认识的 IANA 时区名。
 *
 * @param {string} rawUrl 原始 URL（通常 `req.url`）
 * @param {number} [now] 当前时间（测试可注入；缺省 Date.now()）
 * @returns {{from: string, to: string, timeZone: string}}
 */
export function parseUsageQuery(rawUrl, now = Date.now()) {
	let url;
	try {
		url = new URL(typeof rawUrl === 'string' && rawUrl !== '' ? rawUrl : '/', 'http://localhost');
	} catch {
		throw new Error('Invalid query string');
	}
	const rawTimeZone = url.searchParams.get('timeZone');
	const timeZone = rawTimeZone === null || rawTimeZone === '' ? DEFAULT_TIME_ZONE : rawTimeZone;
	if (timeZone.length > 80) throw new Error('Invalid time zone');
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone });
	} catch {
		throw new Error('Invalid time zone');
	}
	const format = formatter(timeZone);
	const fallbackTo = dateKey(finiteTime(now) ?? Date.now(), format);
	const fallbackFrom = shiftDate(fallbackTo, -29);
	const from = url.searchParams.get('from') ?? fallbackFrom;
	const to = url.searchParams.get('to') ?? fallbackTo;
	if (!isIsoDate(from) || !isIsoDate(to) || from > to) throw new Error('Invalid date range');
	const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
	if (!Number.isFinite(span) || span > MAX_RANGE_DAYS) throw new Error('Date range exceeds 10 years');
	return { from, to, timeZone };
}

/**
 * 使用统计数据源：会话事件日志 → 会话汇总（持久化索引）→ 区间统计快照。
 *
 * 性能模型（修复 198 会话首次打开 ~24s 的问题）：
 *   - 每会话只读一次并折叠为轻量 `SessionSummary`，持久化到
 *     `$DSH_HOME/token-board/usage-index.json`（版本化、原子写、防抖 ~1s）；
 *   - 插件启动时加载缓存并在后台补齐缺失会话；`/usage` 立即用缓存聚合（`indexReady:false`
 *     表示仍有会话未纳入），补齐后返回完整数据；
 *   - 30s TTL / `refresh=1` 的刷新只重新 listSessions、读取新出现的会话，并重读仍存活
 *     （record.live === true）或上次保存时仍存活的会话（有界），绝不重读全部历史。
 *
 * `snapshot()` 的契约（stale-while-revalidate，打开面板绝不阻塞）：
 *   - 永远只用「已加载的会话摘要 + 已有内存快照」立即返回 StatsSnapshot → HTTP 200 JSON；
 *     后台索引/刷新（含 TTL 过期、refresh=1）一律单飞异步进行，不 await；
 *   - `indexReady` 在后台工作期间为 false，完成后下一次请求为 true；
 *   - 返回 null → 宿主未提供 sessionQuery（端点回 `{ok:false}`，仍 200）；
 *   - 内部异常（listSessions 失败等）降级为已缓存数据，绝不向外抛。
 */
export class UsageService {
	constructor(ctx, options = {}) {
		const source = isObject(options) ? options : {};
		this.ctx = ctx;
		this.cacheTtlMs = typeof source.cacheTtlMs === 'number' && Number.isFinite(source.cacheTtlMs) && source.cacheTtlMs >= 0
			? source.cacheTtlMs
			: USAGE_CACHE_TTL_MS;
		const rawConcurrency = Number.isSafeInteger(source.concurrency) && source.concurrency > 0 ? source.concurrency : USAGE_READ_CONCURRENCY;
		this.concurrency = Math.min(8, Math.max(1, rawConcurrency));
		const rawIndexConcurrency = Number.isSafeInteger(source.indexConcurrency) && source.indexConcurrency > 0 ? source.indexConcurrency : USAGE_INDEX_CONCURRENCY;
		this.indexConcurrency = Math.min(8, Math.max(1, rawIndexConcurrency));
		this.indexWriteDelayMs = typeof source.indexWriteDelayMs === 'number' && Number.isFinite(source.indexWriteDelayMs) && source.indexWriteDelayMs >= 0
			? source.indexWriteDelayMs
			: USAGE_INDEX_WRITE_DELAY_MS;
		this.fastModelPattern = compileFastModelPattern(source.fastModelPattern);
		/** 持久化索引文件路径；null = 禁用磁盘缓存（仍可内存工作）。 */
		this.cachePath = cachePathFromOptions(source);
		/** id -> { summary, lastSeq, volatile }（volatile = 保存时仍活跃，可能已有新事件）。 */
		this.summaries = new Map();
		this.loaded = false;
		this.loading = null;
		/** 首轮索引是否已补齐（快照的 indexReady）。 */
		this.ready = false;
		this.warmPromise = null;
		this.warmFailedAt = 0;
		/** 上次成功 listSessions 的时间；用于避免 warm 后首个快照重复列举。 */
		this.lastListAt = 0;
		this.refreshing = null;
		/** key(from|to|timeZone) -> { at, snapshot } 的聚合结果 TTL 缓存。 */
		this.snapshotCache = new Map();
		this.persistTimer = undefined;
		this.persisting = false;
		this.persistQueued = false;
		this.persistPromise = undefined;
		this.dirty = false;
		this.disposed = false;
	}

	/** 日志告警；logger 缺失时静默（端点绝不因可选服务失败而抛）。 */
	warn(error) {
		const logger = this.ctx?.logger;
		const normalized = error instanceof Error ? error : new Error(String(error));
		if (logger !== null && typeof logger === 'object' && typeof logger.warn === 'function') logger.warn(normalized);
	}

	/** 取可选 sessionQuery 服务；缺失/形状不完整返回 null。 */
	sessionQuery() {
		let service;
		try {
			const get = this.ctx?.get;
			service = typeof get === 'function' ? get.call(this.ctx, 'sessionQuery') : undefined;
		} catch {
			service = undefined;
		}
		if (service === null || (typeof service !== 'object' && typeof service !== 'function')) return null;
		if (typeof service.listSessions !== 'function' || typeof service.readSession !== 'function') return null;
		return service;
	}

	cacheKeyOf(query) {
		return `${query.from}|${query.to}|${query.timeZone}`;
	}

	// -------------------------------------------------------------------------
	// 持久化索引：加载 / 序列化 / 原子写 / 防抖。
	// -------------------------------------------------------------------------

	/** 加载一次磁盘索引；损坏/外来/版本不符的缓存静默忽略（后续全量重建）。 */
	async loadCache() {
		if (this.cachePath === null) return;
		let text;
		try {
			text = await readFile(this.cachePath, { encoding: 'utf8' });
		} catch {
			return; // ENOENT 或不可读：当作空缓存。
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			return; // 损坏 JSON：忽略。
		}
		if (!isObject(parsed) || parsed.version !== USAGE_INDEX_VERSION || !Array.isArray(parsed.sessions)) return;
		for (const entry of parsed.sessions) {
			if (!isObject(entry) || !isObject(entry.summary)) continue;
			const summary = entry.summary;
			const id = typeof summary.id === 'string' && summary.id !== ''
				? summary.id
				: (typeof entry.id === 'string' ? entry.id : '');
			if (id === '' || !Array.isArray(summary.activities)) continue;
			if (!isObject(summary.tools)) summary.tools = {};
			if (!isObject(summary.skills)) summary.skills = {};
			summary.id = id;
			const lastSeq = Number.isSafeInteger(entry.lastSeq)
				? entry.lastSeq
				: (Number.isSafeInteger(summary.lastSeq) ? summary.lastSeq : -1);
			this.summaries.set(id, { summary, lastSeq, volatile: entry.volatile === true, readAt: 0 });
		}
	}

	/** 幂等的缓存加载（并发调用共享同一个 promise）。 */
	async ensureLoaded() {
		if (this.loaded) return;
		if (this.loading === null) this.loading = this.loadCache();
		try {
			await this.loading;
		} finally {
			this.loading = null;
			this.loaded = true;
		}
	}

	serializeIndex() {
		const sessions = [...this.summaries.entries()]
			.map(([id, entry]) => ({ id, lastSeq: entry.lastSeq, volatile: entry.volatile, summary: entry.summary }))
			.sort((a, b) => a.id.localeCompare(b.id));
		return JSON.stringify({ version: USAGE_INDEX_VERSION, savedAt: Date.now(), sessions });
	}

	markDirty() {
		this.dirty = true;
		this.schedulePersist();
	}

	/** 防抖写盘（~1s）；计时器 unref，不阻止进程退出。 */
	schedulePersist() {
		if (this.disposed || this.cachePath === null || this.persistTimer !== undefined) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			void this.persist();
		}, this.indexWriteDelayMs);
		this.persistTimer.unref?.();
	}

	/** 原子写：同目录临时文件 + rename；串行化并发写（后续调用会等待本轮写盘并合入最新数据）。 */
	async persist() {
		if (this.cachePath === null) return;
		if (this.persisting) {
			this.persistQueued = true;
			if (this.persistPromise !== undefined) await this.persistPromise;
			return;
		}
		this.persisting = true;
		this.persistPromise = this.writeIndex();
		try {
			await this.persistPromise;
		} finally {
			this.persisting = false;
			this.persistPromise = undefined;
		}
	}

	/** 写盘循环：写盘期间的新变更会合入下一轮，直到没有排队为止。 */
	async writeIndex() {
		try {
			do {
				this.persistQueued = false;
				const json = this.serializeIndex();
				this.dirty = false;
				const target = this.cachePath;
				const dir = dirname(target);
				await mkdir(dir, { recursive: true });
				const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
				try {
					await writeFile(temporary, json, { encoding: 'utf8', mode: 0o600 });
					await rename(temporary, target);
				} catch (error) {
					await unlink(temporary).catch(() => {});
					throw error;
				}
			} while (this.persistQueued === true);
		} catch (error) {
			this.dirty = true;
			this.warn(error);
		}
	}

	/** 立即冲刷未写盘的索引（插件卸载/测试用）：等待在写的那一轮并补齐最新 dirty 数据。 */
	async flush() {
		if (this.persistTimer !== undefined) {
			clearTimeout(this.persistTimer);
			this.persistTimer = undefined;
		}
		if (this.persistPromise !== undefined) await this.persistPromise.catch(() => {});
		if (this.dirty) await this.persist();
	}

	/** 停止防抖计时器并冲刷索引；之后不再接受新的写盘调度。 */
	async dispose() {
		this.disposed = true;
		await this.flush();
	}

	// -------------------------------------------------------------------------
	// 会话枚举与折叠。
	// -------------------------------------------------------------------------

	/**
	 * 列举逻辑语料并只补读需要更新的会话：
	 * - initial（启动后台补齐）：缺失会话 + 上次保存时仍活跃（volatile）或当前活跃的会话；
	 * - 刷新（TTL/refresh=1）：缺失会话 + 当前活跃/上次仍活跃的会话（有界 USAGE_REFRESH_LIVE_LIMIT）。
	 * 持久化（非 live）会话视为不可变，直接复用缓存，绝不重读。
	 * @returns {Promise<boolean>} 是否有需要写盘的变化
	 */
	async reindex({ initial = false } = {}) {
		const service = this.sessionQuery();
		if (service === null) throw new Error('session query unavailable');
		const records = await service.listSessions();
		this.lastListAt = Date.now();
		const list = Array.isArray(records) ? records : [];
		const listed = new Map();
		for (const record of list) {
			const header = isObject(record) ? objectAt(record.header) : null;
			const rawId = header?.id;
			if (rawId === undefined || rawId === null) continue;
			const id = String(rawId);
			if (id === '' || listed.has(id)) continue;
			listed.set(id, isObject(record) && record.live === true);
		}
		let dirty = false;
		// 成功列举后修剪已从逻辑语料消失的会话（缓存不留幽灵）。
		for (const id of [...this.summaries.keys()]) {
			if (listed.has(id)) continue;
			this.summaries.delete(id);
			dirty = true;
		}
		const missing = [];
		const refreshable = [];
		for (const [id, live] of listed) {
			const entry = this.summaries.get(id);
			if (entry === undefined) {
				missing.push(id);
				continue;
			}
			if (initial) {
				if (entry.volatile || live) refreshable.push(id);
			} else if (live || entry.volatile) {
				refreshable.push(id);
			}
		}
		const extras = initial
			? refreshable
			// 有界刷新按「最久未读」轮转，避免活跃会话超过上限时固定那批被反复读、其余饿死。
			: refreshable
				.sort((left, right) => (this.summaries.get(left)?.readAt ?? 0) - (this.summaries.get(right)?.readAt ?? 0))
				.slice(0, USAGE_REFRESH_LIVE_LIMIT);
		// 本轮没来得及重读的活跃会话保持 volatile，重启/后续刷新会补读。
		if (!initial) {
			for (const id of refreshable.slice(USAGE_REFRESH_LIVE_LIMIT)) {
				const entry = this.summaries.get(id);
				if (entry !== undefined && entry.volatile !== true) {
					entry.volatile = true;
					dirty = true;
				}
			}
		}
		const readIds = [...missing];
		const seen = new Set(missing);
		for (const id of extras) {
			if (seen.has(id)) continue;
			seen.add(id);
			readIds.push(id);
		}
		const concurrency = initial ? this.indexConcurrency : this.concurrency;
		const readDirty = await this.readSummaries(service, readIds, listed, concurrency);
		return dirty || readDirty;
	}

	/** 并发读取并折叠指定会话；单个失败只告警跳过。返回是否产生变化。 */
	async readSummaries(service, ids, listed, concurrency) {
		if (ids.length === 0) return false;
		let dirty = false;
		let cursor = 0;
		const worker = async () => {
			for (;;) {
				const index = cursor;
				cursor += 1;
				if (index >= ids.length) return;
				const id = ids[index];
				try {
					const snapshot = await service.readSession(id);
					if (!isObject(snapshot)) continue;
					const summary = summarizeSession(snapshot.session, snapshot.events, snapshot.inheritedEventCount, Date.now());
					const volatile = listed.get(id) === true;
					const previous = this.summaries.get(id);
					if (previous !== undefined && previous.summary.lastSeq === summary.lastSeq && previous.volatile === volatile) {
						previous.readAt = Date.now();
						continue; // 无变化：保留旧 summary（indexedAt / 快照均稳定）。
					}
					this.summaries.set(id, { summary, lastSeq: summary.lastSeq, volatile, readAt: Date.now() });
					dirty = true;
				} catch (error) {
					this.warn(error);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
		return dirty;
	}

	// -------------------------------------------------------------------------
	// 索引生命周期：启动补齐（后台）/ 刷新（请求路径）。
	// -------------------------------------------------------------------------

	/** 触发首轮后台索引（幂等、不阻塞）。 */
	warm() {
		this.ensureWarm();
		return this.warmPromise ?? Promise.resolve();
	}

	ensureWarm() {
		if (this.ready || this.warmPromise !== null) return;
		const now = Date.now();
		if (this.warmFailedAt !== 0 && now - this.warmFailedAt >= 0 && now - this.warmFailedAt < USAGE_WARM_RETRY_MS) return;
		this.warmPromise = this.indexInitial()
			.catch((error) => {
				this.warmFailedAt = Date.now();
				this.warn(error);
			})
			.finally(() => {
				this.warmPromise = null;
			});
	}

	async indexInitial() {
		await this.ensureLoaded();
		const dirty = await this.reindex({ initial: true });
		this.ready = true;
		this.warmFailedAt = 0;
		if (dirty) this.markDirty();
		this.snapshotCache.clear();
	}

	/** TTL/refresh 刷新：只 list + 补读新会话与活跃会话；失败保留缓存并告警。 */
	async runRefresh(force = false) {
		if (this.refreshing !== null) return this.refreshing;
		this.refreshing = (async () => {
			// 刚刚补过索引（如 warm 刚完成）时无需立刻再列举一次：缓存已足够新。
			if (!force && this.ready && Date.now() - this.lastListAt >= 0 && Date.now() - this.lastListAt < this.cacheTtlMs) {
				this.snapshotCache.clear();
				return;
			}
			// 冷启动时后台补齐仍在跑：等它完成，避免重复读取全部会话。
			if (!this.ready && this.warmPromise !== null) {
				try {
					await this.warmPromise;
				} catch {
					// 后台补齐自己会告警；刷新继续走下面的 reindex。
				}
			}
			await this.ensureLoaded();
			const dirty = await this.reindex({ initial: false });
			if (dirty) this.markDirty();
			this.snapshotCache.clear();
		})()
			.catch((error) => {
				// listSessions 失败等：继续使用已缓存数据，绝不让端点失败。
				this.warn(error);
			})
			.finally(() => {
				this.refreshing = null;
			});
		return this.refreshing;
	}

	// -------------------------------------------------------------------------
	// 快照。
	// -------------------------------------------------------------------------

	/** 缓存条目是否仍在 TTL 内（可以不做后台刷新）。 */
	isSnapshotFresh(entry) {
		const age = Date.now() - entry.at;
		return age >= 0 && age < this.cacheTtlMs;
	}

	/**
	 * 对外的 `indexReady`：首轮索引未补齐、或任何后台刷新在飞时都为 false。
	 * 客户端可据此决定稍后重试（服务端本身从不阻塞响应）。
	 */
	snapshotIndexReady() {
		return this.ready && this.refreshing === null;
	}

	/**
	 * 触发后台索引/刷新，绝不返回可等待的阻塞路径（fire-and-forget、单飞）：
	 * - 首轮索引未完成 → 走 warm（幂等，缺失会话在后台补齐）；
	 * - 已就绪 → 若 refresh 强制或列表已超过 TTL，则启动 runRefresh。
	 */
	backgroundRefresh(force = false) {
		if (!this.ready) {
			this.ensureWarm();
			return;
		}
		if (!force) {
			const age = Date.now() - this.lastListAt;
			if (age >= 0 && age < this.cacheTtlMs) return;
		}
		void this.runRefresh(force === true);
	}

	/** 等待当前所有后台工作（缓存加载/首轮索引/刷新）完成；测试与优雅退出用。 */
	async whenIdle() {
		for (let loop = 0; loop < 32; loop += 1) {
			const pending = [];
			if (this.loading !== null) pending.push(this.loading);
			if (this.warmPromise !== null) pending.push(this.warmPromise);
			if (this.refreshing !== null) pending.push(this.refreshing);
			if (pending.length === 0) return;
			await Promise.all(pending);
		}
	}

	rememberSnapshot(key, snapshot) {
		if (this.snapshotCache.size >= 8 && !this.snapshotCache.has(key)) {
			const oldest = this.snapshotCache.keys().next();
			if (oldest.done !== true) this.snapshotCache.delete(oldest.value);
		}
		this.snapshotCache.set(key, { at: Date.now(), snapshot });
	}

	buildSnapshot(key, query) {
		const summaries = [];
		for (const entry of this.summaries.values()) summaries.push(entry.summary);
		const snapshot = aggregateStats(summaries, query, {
			fastModelPattern: this.fastModelPattern,
			indexReady: this.snapshotIndexReady(),
		});
		this.rememberSnapshot(key, snapshot);
		return snapshot;
	}

	/**
	 * 取统计快照（stale-while-revalidate，永不阻塞）。
	 *
	 * - 已有内存快照（即使 TTL 过期）→ 立即返回，TTL 过期时后台刷新；
	 * - 无内存快照 → 用当前已加载的会话摘要立即聚合（首次冷启动可能为空）；
	 * - `refresh=1` → 立即返回当前结果并触发后台刷新；
	 * - 首轮索引未完成时后台补齐并让 `indexReady:false`，补齐后下一次请求为 true。
	 *
	 * @param {{from: string, to: string, timeZone: string}} query 已校验查询
	 * @param {boolean} [refresh] true 时强制后台刷新（refresh=1）
	 * @returns {Promise<object|null>} StatsSnapshot；sessionQuery 缺失时 null
	 */
	async snapshot(query, refresh = false) {
		const normalized = normalizeQuery(query);
		if (this.sessionQuery() === null) return null;
		// 唯一允许的等待：本地缓存文件的毫秒级读取（让首次请求优先展示上次落盘的结果）。
		await this.ensureLoaded();
		const key = this.cacheKeyOf(normalized);
		const cached = this.snapshotCache.get(key);
		const force = refresh === true;
		const stale = cached === undefined || force || !this.isSnapshotFresh(cached);
		// 先决定并启动后台工作，再立刻返回当前可用的结果（不 await）。
		if (stale) this.backgroundRefresh(force);
		const snapshot = cached === undefined ? this.buildSnapshot(key, normalized) : cached.snapshot;
		// 后台工作仍在飞时，本响应标记 indexReady:false（客户端可稍后重试；服务端不阻塞）。
		snapshot.indexReady = this.snapshotIndexReady();
		return snapshot;
	}
}
