/**
 * dsh-token-board — 主机半边（host half）。
 *
 * 监听所有 agent 的 `session/event` 落账流与 `agent/assistant-stream` 实时帧，按滚动
 * 窗口估算每个 agent（会话 id 即 agent id）的输出速度（tok/s，字符启发式；提供方
 * 上报 usage 时校正为精确值），维护运行/流式/工具/重试状态与父会话谱系，并通过
 * webServer 暴露只读 HTTP 端点供客户端轮询。
 *
 * 纯内存、零持久化、零提示词注入：不写任何文件，不进会话日志。
 *
 * 数据契约：GET {apiPath}/stats（亦接受裸 {apiPath}）→
 *   { serverTime, windowMs, activity, agents }
 *   GET {apiPath}/usage?timeZone=<IANA>&from=YYYY-MM-DD&to=YYYY-MM-DD[&refresh=1] →
 *   使用统计面板快照（参考 StatsSnapshot；聚合与持久化索引在 lib/usage.js，惰性加载）。
 *   快照采用 stale-while-revalidate：HTTP 响应永不等待索引/刷新，后台单飞补齐。
 */
export const name = 'token-board';
export const inject = ['webServer'];

/** 配置默认值（不使用 schemastery：宿主配置缺省时用普通值回退）。 */
const DEFAULTS = {
	apiPath: '/token-board/v1',
	charsPerToken: 4,
	cjkTokensPerChar: 1,
	windowMs: 5000,
	idleTtlMs: 180000,
};

const MIN_WINDOW_MS = 1000;
const MIN_IDLE_TTL_MS = 15000;
/** 显示名解析缓存：命中后 10s 刷新；未命中（标题可能稍后生成）2s 后重试。 */
const IDENTITY_HIT_TTL_MS = 10000;
const IDENTITY_MISS_TTL_MS = 2000;
/** 非 idle 会话的硬过期倍数：crashed/stale 会话不能永久占位。 */
const STALE_TTL_FACTOR = 4;
/** 谱系链解析的环路/深度保护。 */
const MAX_LINEAGE_HOPS = 64;

/** CJK（含假名/谚文）码点判定：这些字符按 ~1 token/字 估算，其余按 charsPerToken。 */
const CJK_RANGES = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * 使用统计聚合模块（lib/usage.js）按需动态加载。
 * 本文件既有的「零 import / 零依赖」约定由 test-host.mjs 校验，故用动态 import 保持字面约定；
 * usage.js 自身零依赖，加载一次后由模块缓存持有。
 */
let usageModulePromise;
function loadUsageModule() {
	if (usageModulePromise === undefined) usageModulePromise = import('./usage.js');
	return usageModulePromise;
}

/** 从错误对象取一条可读原因（用于 400 响应体）。 */
function errorMessage(error) {
	return error instanceof Error && typeof error.message === 'string' && error.message !== ''
		? error.message
		: 'Bad request';
}

/** `refresh=1`（兼容 `refresh=true`）：强制绕过 /usage 的内存缓存。 */
function isRefreshRequest(rawUrl) {
	if (typeof rawUrl !== 'string' || rawUrl === '') return false;
	try {
		const value = new URL(rawUrl, 'http://localhost').searchParams.get('refresh');
		return value === '1' || value === 'true';
	} catch {
		return false;
	}
}

function finiteNumber(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 取正数配置；非法/缺失时回退默认值。 */
function positiveNumber(value, fallback) {
	const parsed = finiteNumber(value);
	return parsed === null || parsed === 0 ? fallback : parsed;
}

/** tok/s 统一保留一位小数；非有限值退化为 0。 */
function round1(value) {
	return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

/** 相对年龄：时间戳缺失/非法 → null；否则 max(0, now - at)。 */
function ageOf(now, at) {
	return typeof at === 'number' && Number.isFinite(at) ? Math.max(0, now - at) : null;
}

function makeSession(id) {
	return {
		id,
		parentSession: null, // string | null，来自 session.header.parentSession
		origin: null, // 'subagent' | null，来自 session.header.origin
		delegationDepth: 0, // 来自 session.header.delegationDepth
		status: 'idle', // idle | running | streaming | tool | retrying
		samples: [], // { t, tokens } 滚动窗口样本
		turnOutput: 0,
		sessionOutput: 0,
		stepEstimate: 0,
		turnStartedAt: null,
		lastChunkAt: null,
		lastEventAt: 0,
		model: null,
		provider: null,
		untaggedTokens: 0, // 模型未知时流入的估算 token，模型确定后回填聚合表
		// 显示名解析（Agent Team 成员名 / 会话标题），仅用于展示：
		agent: null, // 实时 Agent 句柄（来自 assistant-stream 帧）
		sessionRecord: null, // 持久 Session 句柄（来自 session/event 或 agent.session）
		identity: null, // { name, role } | { name: null, role: null }
		identityAt: 0, // 上次解析时间
	};
}

/** 合并缺省值并夹取边界；apiPath 去掉尾部 `/`。 */
function resolveConfig(config = {}) {
	const source = config !== null && typeof config === 'object' ? config : {};
	const rawPath = typeof source.apiPath === 'string' ? source.apiPath.trim() : '';
	const trimmedPath = rawPath.replace(/\/+$/, '');
	const rawUsageIndexPath = typeof source.usageIndexPath === 'string' ? source.usageIndexPath.trim() : '';
	return {
		apiPath: trimmedPath === '' ? DEFAULTS.apiPath : trimmedPath,
		charsPerToken: positiveNumber(source.charsPerToken, DEFAULTS.charsPerToken),
		cjkTokensPerChar: positiveNumber(source.cjkTokensPerChar, DEFAULTS.cjkTokensPerChar),
		windowMs: Math.max(MIN_WINDOW_MS, positiveNumber(source.windowMs, DEFAULTS.windowMs)),
		idleTtlMs: Math.max(MIN_IDLE_TTL_MS, positiveNumber(source.idleTtlMs, DEFAULTS.idleTtlMs)),
		// 使用统计持久化索引路径；null = 默认 $DSH_HOME/token-board/usage-index.json。
		usageIndexPath: rawUsageIndexPath === '' ? null : rawUsageIndexPath,
	};
}

class TokenBoard {
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
		this.sessions = new Map(); // sessionId（= agentId）-> state
		this.models = new Map(); // model -> { model, provider, outputTokens } 进程级聚合（不进 API）
		// 子智能体在「N 个子智能体」下拉里显示的名称 = 父会话 subagentCatalog 的 label。
		// 该读取是异步的（SubagentRuntime.listChildren），按父会话批量拉取后缓存。
		this.subagentLabels = new Map(); // childSessionId -> catalog label
		this.labelPending = new Set(); // 正在拉取的 parentSessionId
		this.liveFramesSeen = false; // 见到 agent/assistant-stream 帧后，停用旧版 chunk 通道防双计
		this.apiPath = config.apiPath;
		// /usage 端点的懒加载聚合器：undefined = 尚未尝试加载；null = 加载失败（端点降级）。
		this.usageService = undefined;
		this.usageServicePromise = undefined;
		this.disposed = false;
	}

	warn(error) {
		const logger = this.ctx?.logger;
		const normalized = error instanceof Error ? error : new Error(String(error));
		if (logger !== null && typeof logger === 'object' && typeof logger.warn === 'function') logger.warn(normalized);
	}

	estimate(text) {
		if (typeof text !== 'string' || text === '') return 0;
		let cjk = 0;
		for (const ch of text) if (CJK_RANGES.test(ch)) cjk += 1;
		const other = text.length - cjk;
		return cjk * this.config.cjkTokensPerChar + other / this.config.charsPerToken;
	}

	/** 取（或建）模型聚合行；tokens 可为负（usage 校正回退），下限 0。 */
	addModelTokens(model, provider, tokens) {
		let entry = this.models.get(model);
		if (entry === undefined) {
			entry = { model, provider: null, outputTokens: 0 };
			this.models.set(model, entry);
		}
		if (provider && entry.provider !== provider) entry.provider = provider;
		if (tokens !== 0) entry.outputTokens = Math.max(0, entry.outputTokens + tokens);
		return entry;
	}

	addTokens(session, tokens, at) {
		if (!(tokens > 0)) return;
		session.turnOutput += tokens;
		session.sessionOutput += tokens;
		// 入队即裁剪：窗口外的旧样本不再累积（页面隐藏/长期无 /stats 请求时也保持有界）。
		const cutoff = at - this.config.windowMs;
		while (session.samples.length > 0 && session.samples[0].t < cutoff) session.samples.shift();
		session.samples.push({ t: at, tokens });
		session.lastChunkAt = at;
		if (session.model !== null) this.addModelTokens(session.model, session.provider, tokens);
		else session.untaggedTokens += tokens;
	}

	ensure(id) {
		let session = this.sessions.get(id);
		if (session === undefined) {
			session = makeSession(id);
			this.sessions.set(id, session);
		}
		return session;
	}

	/** 从持久会话 header 同步谱系；只接受新观察到的非空值，绝不用 null 覆盖已知父会话。 */
	updateLineage(session, header) {
		if (header === null || typeof header !== 'object') return;
		const parentSession = header.parentSession;
		if (typeof parentSession === 'string' && parentSession !== '') session.parentSession = parentSession;
		if (header.origin === 'subagent') session.origin = 'subagent';
		const delegationDepth = finiteNumber(header.delegationDepth);
		if (delegationDepth !== null) session.delegationDepth = Math.floor(delegationDepth);
	}

	/** 可选服务句柄：缺失（如精简 composition）时返回 undefined，不抛错。 */
	service(name) {
		try {
			const get = this.ctx?.get;
			return typeof get === 'function' ? get.call(this.ctx, name) : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * 解析展示名，优先级：Agent Team 成员名（lead/host-dev…）→ 会话标题（子智能体列表里显示的名称）
	 * → null（客户端回退到「主 Agent / 子 Agent N」）。纯展示用途，绝不写会话。
	 * @returns {{ name: string | null, role: 'lead' | 'teammate' | 'main' | 'subagent' | null }}
	 */
	identityOf(session, now) {
		const cached = session.identity;
		if (cached !== null && now - session.identityAt < (cached.name === null ? IDENTITY_MISS_TTL_MS : IDENTITY_HIT_TTL_MS)) {
			return cached;
		}
		let identity = { name: null, role: null };
		// 1) Agent Team roster：成员名（lead / host-dev / client-dev …）。
		try {
			const teams = this.service('agentTeams');
			if (teams !== null && typeof teams?.tryMembership === 'function') {
				const agent = session.agent ?? this.service('agents')?.get?.(session.id);
				if (agent !== null && agent !== undefined) {
					const membership = teams.tryMembership(agent);
					const name = typeof membership?.name === 'string' ? membership.name.trim() : '';
					if (name !== '') identity = { name, role: membership.role === 'lead' ? 'lead' : 'teammate' };
				}
			}
		} catch {
			/* 可选集成失败不影响统计 */
		}
		// 2) 子智能体目录 label：与「N 个子智能体」下拉里的主名称同源。
		if (identity.name === null && session.parentSession !== null) {
			const label = this.subagentLabels.get(session.id);
			if (typeof label === 'string' && label !== '') {
				identity = { name: label, role: 'subagent' };
			} else {
				void this.resolveSubagentLabels(session.parentSession);
			}
		}
		// 3) 会话标题：与侧栏列表 / 子智能体下拉里的副标题同源。
		if (identity.name === null) {
			try {
				const titles = this.service('sessionTitle');
				const target = session.sessionRecord ?? this.service('sessions')?.get?.(session.id);
				if (target !== null && target !== undefined && typeof titles?.get === 'function') {
					const snapshot = titles.get(target);
					const title = typeof snapshot?.title === 'string' ? snapshot.title.trim() : '';
					if (title !== '') {
						const isChild = session.origin === 'subagent' || session.parentSession !== null;
						identity = { name: title, role: isChild ? 'subagent' : 'main' };
					}
				}
			} catch {
				/* 可选集成失败不影响统计 */
			}
		}
		session.identity = identity;
		session.identityAt = now;
		return identity;
	}

	/**
	 * 拉取一个父会话的子智能体目录并缓存每个孩子的 label（与子智能体下拉里的主名称同源）。
	 * 失败/服务缺失时静默回退到会话标题。
	 */
	async resolveSubagentLabels(parentSessionId) {
		if (typeof parentSessionId !== 'string' || parentSessionId === '' || this.labelPending.has(parentSessionId)) return
		this.labelPending.add(parentSessionId)
		try {
			const runtime = this.service('subagents');
			if (runtime === null || runtime === undefined || typeof runtime.listChildren !== 'function') return;
			const entries = await runtime.listChildren(parentSessionId);
			if (!Array.isArray(entries)) return;
			for (const entry of entries) {
				if (entry === null || typeof entry !== 'object') continue;
				const childId = typeof entry.id === 'string' ? entry.id : null;
				const label = typeof entry.label === 'string' ? entry.label.trim() : '';
				if (childId === null || label === '') continue;
				this.subagentLabels.set(childId, label);
				// 命中后让该会话的展示名立即重新解析。
				const child = this.sessions.get(childId);
				if (child !== undefined) { child.identity = null; child.identityAt = 0; }
			}
		} catch {
			/* 可选集成失败不影响统计 */
		} finally {
			this.labelPending.delete(parentSessionId);
		}
	}

	onEvent(session, event) {
		if (event === null || typeof event !== 'object') return;
		const at = finiteNumber(event.time) ?? Date.now();
		session.lastEventAt = at;
		switch (event.type) {
			case 'turn/start':
				session.status = 'running';
				session.turnOutput = 0;
				session.turnStartedAt = at;
				break;
			case 'step/start':
				session.status = 'running';
				session.stepEstimate = 0;
				break;
			case 'assistant/chunk': {
				// 0.1.2-rc.x 通道：新版（0.1.5-rc.2+，format v2）把逐 delta 流挪进了
				// `agent/assistant-stream` 帧通道，session log 只在尝试结束落一个完整
				// `assistant/attempt`。两通道互斥；一旦见到帧，本通道一律忽略防双计。
				if (this.liveFramesSeen) break;
				const chunk = event.data?.chunk;
				if (!chunk) break;
				let text = '';
				if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') text = chunk.text ?? '';
				else if (chunk.type === 'tool-call-delta') text = chunk.argumentsDelta ?? '';
				const tokens = this.estimate(text);
				if (tokens > 0) {
					session.stepEstimate += tokens;
					this.addTokens(session, tokens, at);
					session.status = 'streaming';
				}
				break;
			}
			case 'assistant/message': {
				const source = event.data?.message?.source;
				const stepModel = typeof source?.model === 'string' && source.model !== '' ? source.model : session.model;
				const stepProvider = typeof source?.provider === 'string' && source.provider !== '' ? source.provider : session.provider;
				// 模型已知：把流式期间攒下的未归属 token 回填进聚合表。
				if (stepModel !== null && session.untaggedTokens > 0) {
					this.addModelTokens(stepModel, stepProvider, session.untaggedTokens);
					session.untaggedTokens = 0;
				}
				// 提供方 usage 到达：把本步估算校正为精确输出 token 数（聚合表同步校正）。
				const actual = finiteNumber(event.data?.usage?.outputTokens);
				if (actual !== null) {
					const diff = actual - session.stepEstimate;
					if (diff !== 0) {
						if (diff > 0) {
							session.turnOutput += diff;
							session.sessionOutput += diff;
							const last = session.samples.at(-1);
							if (last) last.tokens += diff;
						} else {
							session.turnOutput = Math.max(0, session.turnOutput + diff);
							session.sessionOutput = Math.max(0, session.sessionOutput + diff);
							const last = session.samples.at(-1);
							if (last) last.tokens = Math.max(0, last.tokens + diff);
						}
						if (stepModel !== null) this.addModelTokens(stepModel, stepProvider, diff);
					}
				}
				if (stepModel !== null) session.model = stepModel;
				if (stepProvider !== null) session.provider = stepProvider;
				session.stepEstimate = 0;
				if (session.status === 'streaming') session.status = 'running';
				break;
			}
			case 'request/header': {
				// 尽早锁定模型名（首轮流式期间就能正确归属聚合表）。
				if (session.model === null) {
					const headerConfig = event.data?.header?.config;
					if (typeof headerConfig?.model === 'string' && headerConfig.model !== '') session.model = headerConfig.model;
					if (typeof headerConfig?.provider === 'string' && headerConfig.provider !== '') session.provider = headerConfig.provider;
				}
				break;
			}
			case 'tool/call':
				session.status = 'tool';
				break;
			case 'tool/result':
				if (session.status === 'tool') session.status = 'running';
				break;
			case 'llm/retry':
				session.status = 'retrying';
				break;
			case 'llm/retry-started':
				if (session.status === 'retrying') session.status = 'running';
				break;
			case 'step/end':
				session.stepEstimate = 0;
				break;
			case 'turn/end':
				session.status = 'idle';
				session.turnStartedAt = null;
				break;
		}
	}

	/** `session/event` 通道：会话记录即 Session，谱系从 session.header 读取（主/子 agent 同构）。 */
	accept(sessionRecord, event) {
		if (sessionRecord === null || typeof sessionRecord !== 'object') return;
		const rawId = sessionRecord.id;
		if (rawId === undefined || rawId === null) return;
		const id = String(rawId);
		if (id === '') return;
		const session = this.ensure(id);
		session.sessionRecord = sessionRecord;
		this.updateLineage(session, sessionRecord.header);
		if (session.parentSession !== null) void this.resolveSubagentLabels(session.parentSession);
		try {
			this.onEvent(session, event);
		} catch (error) {
			this.warn(error);
		}
	}

	/**
	 * 新版（0.1.5-rc.2+，format v2）实时流通道：loop 每收到一个 model chunk 就广播
	 * `agent/assistant-stream` 帧（start/chunk/end），与 session log 的落账事件互补。
	 * 逐 chunk 估算在这里做；`start` 重置本尝试的估算基线（重试是同 turn/step 的新尝试）。
	 * 该通道实时到达，谱系（parentSession/origin/delegationDepth）也在这里同步。
	 */
	acceptFrame(agent, frame) {
		if (agent === null || typeof agent !== 'object') return;
		const record = agent.session;
		if (record === null || typeof record !== 'object') return;
		const rawId = record.id;
		if (rawId === undefined || rawId === null) return;
		const id = String(rawId);
		if (id === '') return;
		this.liveFramesSeen = true;
		const session = this.ensure(id);
		session.agent = agent;
		session.sessionRecord = record;
		this.updateLineage(session, record.header);
		if (session.parentSession !== null) void this.resolveSubagentLabels(session.parentSession);
		try {
			if (frame === null || typeof frame !== 'object') return;
			if (frame.type === 'start') {
				session.lastEventAt = Date.now();
				session.stepEstimate = 0;
				if (session.status === 'idle') session.status = 'running';
			} else if (frame.type === 'chunk') {
				session.lastEventAt = Date.now();
				const chunk = frame.chunk;
				if (chunk !== null && typeof chunk === 'object') {
					let text = '';
					if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') text = chunk.text ?? '';
					else if (chunk.type === 'tool-call-delta') text = chunk.argumentsDelta ?? '';
					const tokens = this.estimate(text);
					if (tokens > 0) {
						session.stepEstimate += tokens;
						this.addTokens(session, tokens, finiteNumber(frame.time) ?? Date.now());
						session.status = 'streaming';
					}
				}
			}
			// 'end' 帧：committed/abandoned，状态交由 turn/step/session 落账事件驱动。
		} catch (error) {
			this.warn(error);
		}
	}

	tps(session, now) {
		const { windowMs } = this.config;
		const cutoff = now - windowMs;
		let expired = 0;
		while (expired < session.samples.length && session.samples[expired].t < cutoff) expired += 1;
		if (expired > 0) session.samples.splice(0, expired);
		if (session.samples.length === 0) return 0;
		let sum = 0;
		for (const sample of session.samples) sum += sample.tokens;
		return (sum / windowMs) * 1000;
	}

	/** 沿已跟踪会话解析父链距离（header 缺 delegationDepth 时的回退）；链不可完整解析 → 0。 */
	chainDepth(session) {
		const seen = new Set([session.id]);
		let current = session;
		let depth = 0;
		while (depth <= MAX_LINEAGE_HOPS) {
			const parentId = current.parentSession;
			if (parentId === null) return depth;
			const parent = this.sessions.get(parentId);
			if (parent === undefined || seen.has(parent.id)) return 0;
			seen.add(parent.id);
			depth += 1;
			current = parent;
		}
		return 0;
	}

	/** header 的 delegationDepth 优先；缺失（0）时按可解析的祖先链距离回退。 */
	depthOf(session) {
		if (session.delegationDepth > 0) return Math.floor(session.delegationDepth);
		return this.chainDepth(session);
	}

	isSubagent(session, depth) {
		return session.origin === 'subagent' || session.parentSession !== null || depth > 0;
	}

	evict(id, session) {
		if (session.untaggedTokens > 0 && session.model !== null) {
			this.addModelTokens(session.model, session.provider, session.untaggedTokens);
		}
		session.untaggedTokens = 0;
		this.sessions.delete(id);
	}

	prune(now) {
		const idleTtlMs = this.config.idleTtlMs;
		const staleTtlMs = idleTtlMs * STALE_TTL_FACTOR;
		for (const [id, session] of this.sessions) {
			const age = now - session.lastEventAt;
			if (age > staleTtlMs || (session.status === 'idle' && age > idleTtlMs)) this.evict(id, session);
		}
	}

	rowOf(session, now) {
		const tps = round1(this.tps(session, now));
		const depth = this.depthOf(session);
		const identity = this.identityOf(session, now);
		return {
			id: session.id,
			parentSession: session.parentSession,
			origin: session.origin,
			depth,
			subagent: this.isSubagent(session, depth),
			name: identity.name,
			role: identity.role,
			status: session.status,
			tps,
			model: session.model,
			provider: session.provider,
			turnOutput: Math.max(0, Math.round(session.turnOutput)),
			sessionOutput: Math.max(0, Math.round(session.sessionOutput)),
			turnMs: ageOf(now, session.turnStartedAt),
			lastChunkAgeMs: ageOf(now, session.lastChunkAt),
			lastEventAgeMs: ageOf(now, session.lastEventAt) ?? 0,
		};
	}

	emptyStats() {
		return {
			serverTime: Date.now(),
			windowMs: this.config.windowMs,
			activity: { active: false, agents: 0, streaming: 0, running: 0, tool: 0, retrying: 0, tps: 0 },
			agents: [],
		};
	}

	snapshot() {
		const now = Date.now();
		try {
			this.prune(now);
			const agents = [];
			for (const session of this.sessions.values()) {
				try {
					agents.push(this.rowOf(session, now));
				} catch (error) {
					this.warn(error);
				}
			}
			agents.sort((a, b) => b.tps - a.tps || a.lastEventAgeMs - b.lastEventAgeMs);
			const activity = { active: false, agents: agents.length, streaming: 0, running: 0, tool: 0, retrying: 0, tps: 0 };
			let totalTps = 0;
			for (const row of agents) {
				if (row.status !== 'idle') activity.active = true;
				if (row.status === 'streaming') activity.streaming += 1;
				else if (row.status === 'running') activity.running += 1;
				else if (row.status === 'tool') activity.tool += 1;
				else if (row.status === 'retrying') activity.retrying += 1;
				totalTps += row.tps;
			}
			activity.tps = round1(totalTps);
			return { serverTime: now, windowMs: this.config.windowMs, activity, agents };
		} catch (error) {
			this.warn(error);
			return this.emptyStats();
		}
	}

	pathnameOf(req) {
		const raw = typeof req?.url === 'string' && req.url !== '' ? req.url : '/';
		try {
			return new URL(raw, 'http://localhost').pathname;
		} catch {
			return raw.split('?')[0] ?? raw;
		}
	}

	/** 只读 HTTP 端点；GET/HEAD 之外 405，非本前缀路径 404。handler 绝不向外抛。 */
	handle(req, res) {
		try {
			const method = typeof req?.method === 'string' ? req.method : 'GET';
			if (method !== 'GET' && method !== 'HEAD') {
				sendJson(res, 405, { error: 'Method not allowed' }, { allow: 'GET, HEAD' });
				return;
			}
			const pathname = this.pathnameOf(req);
			if (pathname === `${this.apiPath}/usage`) {
				// 使用统计快照是异步聚合（读 sessionQuery），错误在 handleUsage 内部收敛，绝不外抛。
				return this.handleUsage(req, res);
			}
			if (pathname !== this.apiPath && pathname !== `${this.apiPath}/stats`) {
				sendJson(res, 404, { error: 'Not found' });
				return;
			}
			if (method === 'HEAD') {
				const json = JSON.stringify(this.snapshot());
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'content-length': Buffer.byteLength(json),
					'cache-control': 'no-store',
					'x-content-type-options': 'nosniff',
				});
				res.end();
				return;
			}
			sendJson(res, 200, this.snapshot());
		} catch (error) {
			this.warn(error);
			try {
				sendJson(res, 200, this.emptyStats());
			} catch {
				// 连接已断开：无法再响应，保持静默（handler 绝不向外抛）。
			}
		}
	}

	/** 懒加载 lib/usage.js；加载失败时缓存 null 并告警，端点降级而不崩溃。 */
	async usageModule() {
		try {
			return await loadUsageModule();
		} catch (error) {
			this.warn(error);
			return null;
		}
	}

	/** 懒创建 UsageService（持有持久化单会话索引 + 30s 聚合缓存）；sessionQuery 缺失由 snapshot() 返回 null 表达。 */
	async usageAggregator() {
		if (this.usageService !== undefined) return this.usageService;
		// 请求与启动预热可能并发首次访问：共享同一个创建 promise，避免两个索引实例同时读盘/写盘。
		if (this.usageServicePromise === undefined) {
			this.usageServicePromise = (async () => {
				const module = await this.usageModule();
				if (module === null) {
					this.usageService = null;
					return null;
				}
				const options = this.config.usageIndexPath === null ? {} : { cachePath: this.config.usageIndexPath };
				this.usageService = new module.UsageService(this.ctx, options);
				return this.usageService;
			})();
		}
		return this.usageServicePromise;
	}

	/**
	 * 插件启动即在后台加载持久化索引并补齐缺失会话，使统计面板首次打开走缓存聚合
	 * （而非重放全部会话日志）。sessionQuery 可能与本插件并发加载，最多等待约 10s；
	 * 始终缺失/加载失败都静默降级（端点会回 {ok:false}）。
	 */
	async startUsageWarmup() {
		for (let attempt = 0; attempt < 40; attempt += 1) {
			if (this.disposed) return;
			try {
				if (this.service('sessionQuery') !== null && this.service('sessionQuery') !== undefined) {
					const aggregator = await this.usageAggregator();
					if (aggregator !== null) aggregator.warm();
					return;
				}
			} catch (error) {
				this.warn(error);
			}
			await new Promise((resolveWait) => {
				const timer = setTimeout(resolveWait, 250);
				timer.unref?.();
			});
		}
	}

	/**
	 * `GET {apiPath}/usage?timeZone&from&to[&refresh=1]` → 参考 StatsSnapshot。
	 *
	 * stale-while-revalidate：handler 永不等待索引/刷新（索引在插件启动时以及后台单飞进行），
	 * 总是立即返回内存中最后可用的聚合结果；`refresh=1` 也只触发后台刷新。
	 * - 参数非法 → 400 `{ error }`；
	 * - `sessionQuery` 缺失 → 200 `{ ok:false, error:'session query unavailable' }`（UI 进入错误态）；
	 * - 其它聚合失败 → 200 `{ ok:false, error:'usage stats unavailable' }`；
	 * - HEAD 与 GET 同头同 content-length、无响应体。
	 */
	async handleUsage(req, res) {
		try {
			const module = await this.usageModule();
			if (module === null) {
				this.sendUsageJson(req, res, 200, { ok: false, error: 'usage stats unavailable' });
				return;
			}
			let query;
			try {
				query = module.parseUsageQuery(req?.url);
			} catch (error) {
				this.sendUsageJson(req, res, 400, { error: errorMessage(error) });
				return;
			}
			const aggregator = await this.usageAggregator();
			if (aggregator === null) {
				this.sendUsageJson(req, res, 200, { ok: false, error: 'usage stats unavailable' });
				return;
			}
			const snapshot = await aggregator.snapshot(query, isRefreshRequest(req?.url));
			if (snapshot === null) {
				this.sendUsageJson(req, res, 200, { ok: false, error: 'session query unavailable' });
				return;
			}
			this.sendUsageJson(req, res, 200, snapshot);
		} catch (error) {
			this.warn(error);
			try {
				this.sendUsageJson(req, res, 200, { ok: false, error: 'usage stats unavailable' });
			} catch {
				// 连接已断开：保持静默。
			}
		}
	}

	/** /usage 的 JSON 响应：HEAD 与 GET 同头同 content-length，但不发送响应体。 */
	sendUsageJson(req, res, status, body) {
		const json = JSON.stringify(body);
		const method = typeof req?.method === 'string' ? req.method : 'GET';
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'content-length': Buffer.byteLength(json),
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
		});
		if (method === 'HEAD') {
			res.end();
			return;
		}
		res.end(json);
	}

	start() {
		this.ctx.on('session/event', (session, event) => this.accept(session, event));
		// 0.1.5-rc.2+（format v2）的实时流通道；老宿主上此事件不存在，注册本身无害。
		// { global: true } 与 dsh-api-session-controller 的用法一致，接收全部 agent（含子代理）。
		this.ctx.on('agent/assistant-stream', ({ agent, frame } = {}) => this.acceptFrame(agent, frame), { global: true });
		this.ctx.effect(() => {
			const dispose = this.ctx.webServer.register({
				kind: 'prefix',
				path: this.apiPath,
				handler: (req, res) => this.handle(req, res),
			});
			// 启动即后台预热使用统计索引；卸载时冲刷并停掉防抖写盘。
			void this.startUsageWarmup();
			return () => {
				this.disposed = true;
				if (typeof dispose === 'function') dispose();
				const service = this.usageService;
				if (service !== undefined && service !== null && typeof service.dispose === 'function') void service.dispose();
			};
		}, 'token-board: read-only stats API + usage stats index');
	}
}

function sendJson(res, status, body, extraHeaders) {
	const json = JSON.stringify(body);
	const headers = {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(json),
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	};
	if (extraHeaders !== undefined) Object.assign(headers, extraHeaders);
	res.writeHead(status, headers);
	res.end(json);
}

export function apply(ctx, config = {}) {
	new TokenBoard(ctx, resolveConfig(config)).start();
}
