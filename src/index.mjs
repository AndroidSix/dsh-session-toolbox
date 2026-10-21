/**
 * dsh-session-toolbox host plugin: draft vault manifest mirror (§4 FR1), session
 * move (§10) and trash bin (§11) for DeepSeek Harness. Every official surface
 * is reached through `ctx.get(...)` service names probed at runtime; a missing
 * capability degrades that feature to a visible "unavailable" state — never a
 * crash, never a patch (NFR3 / §10 MN1). The plugin declares no hard `inject`
 * dependencies so it can never block host boot.
 */
import { mkdir, realpath, stat } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { guardJournal, guardLedger, guardManifest, guardSettings, JsonDocument } from './store.mjs';
import { MoveEngine } from './move.mjs';
import { createSessionMaintenance } from './session-maintenance.mjs';
import { TrashEngine } from './trash.mjs';
import { WorkspaceTools, guardGroups, guardWorkspaceJournal } from './workspace.mjs';
import { apiHandler, dispatch } from './api.mjs';
import { Checkpoints, installCheckpoints } from './checkpoints.mjs';
import { MessageTools } from './messages.mjs';
import { NextTasks, installNextTasks } from './next-tasks.mjs';
import pkg from '../package.json' with { type: 'json' };
const pluginVersion = pkg.version;

export const name = 'dsh-session-toolbox';
export const inject = [];
// schemastery has no `.optional()`; empty defaults mean "unset" (apply() treats '' as absent).
export const Config = z.object({
	configFile: z.string().description('Directory for session-toolbox data (defaults to <DSH_HOME>/session-toolbox)').default(''),
	dshHome: z.string().description('Override the DSH home whose sessions/ storage the tool manages (advanced)').default(''),
});

export function defaultKitRoot() {
	return join(resolveDshHome(), 'session-toolbox');
}

export async function apply(ctx, options = {}) {
	try {
		return await applyInner(ctx, options);
	} catch (error) {
		// A failing third-party plugin must never take the whole app down.
		// Record the real stack so the failure is diagnosable, then degrade.
		recordStartupFailure(error);
		const hint = /Cannot find package|ERR_MODULE_NOT_FOUND/.test(String(error?.message ?? error))
			? '（依赖缺失：请从插件页卸载后重新安装，让包管理器重新拉取 peer 依赖）'
			: '';
		ctx.logger?.warn?.(`session-toolbox: disabled after startup error${hint} — ${error?.message ?? error}`);
	}
}

/** Absolute path of the startup-failure log, next to the plugin's other state. */
function startupFailureLog() {
	try {
		return join(resolve(resolveDshHome()), 'session-toolbox', 'startup-error.log');
	} catch { return ''; }
}

/** Append a startup failure (with stack) so a failed activation stays diagnosable. */
function recordStartupFailure(error) {
	const file = startupFailureLog();
	if (file === '') return;
	try {
		const detail = `${new Date().toISOString()}\n${error?.stack ?? String(error)}\n\n`;
		appendFileSync(file, detail, { mode: 0o600 });
	} catch { /* diagnostics must never throw */ }
}

async function applyInner(ctx, options = {}) {
	const dshHome = resolve(options.dshHome || resolveDshHome());
	const root = resolve(options.configFile || join(dshHome, 'session-toolbox'));
	await mkdir(root, { recursive: true, mode: 0o700 });
	const capabilities = {
		workspaceRegistry: ctx.get('workspaceRegistry') !== undefined,
		sessions: ctx.get('sessions') !== undefined,
		sessionPersistence: ctx.get('sessionPersistence') !== undefined,
		webServer: false, // flips true when the optional webServer inject fires
	};
	const settingsDoc = new JsonDocument(root, 'session-toolbox.json', { version: 1 }, guardSettings);
	const journalDoc = new JsonDocument(root, 'journal.json', { version: 1, active: null }, guardJournal);
	const ledgerDoc = new JsonDocument(root, 'trash.json', { version: 1, items: [] }, guardLedger);
	const manifestDoc = new JsonDocument(root, 'vault-manifest.json', { version: 1, records: [] }, guardManifest);

	const groupsDoc = new JsonDocument(root, 'groups.json', { version: 1, groups: [] }, guardGroups);
	const workspaceJournalDoc = new JsonDocument(root, 'workspace-journal.json', { version: 1, active: null }, guardWorkspaceJournal);

	let settingsCache = await settingsDoc.read().catch(() => ({ trash: {}, draftVault: {} }));
	let journalCache = null;
	try { journalCache = (await journalDoc.read()).active; }
	catch (error) { ctx.logger?.warn?.(`session-toolbox: journal unreadable — ${error.message}`); }
	if (journalCache !== null) ctx.logger?.warn?.(`session-toolbox: unresolved move journal for ${journalCache.sessionId}; complete or roll it back from the panel or CLI`);

	const move = new MoveEngine({
		root,
		sessionsRoot: join(dshHome, 'sessions'),
		projcacheRoot: join(dshHome, 'storages', 'session_projcache', 'sessions'),
		journal: journalDoc,
		capabilities: hostCapabilities(ctx),
	});
	const workspace = new WorkspaceTools({ registry: () => ctx.get('workspaceRegistry'), move, groups: groupsDoc, journal: workspaceJournalDoc, ledger: ledgerDoc });
	const checkpoints = new Checkpoints({ root, busy: async cwd => {
		const sessions = ctx.get('sessions')?.list?.() ?? [];
		for (const session of sessions) {
			const path = ctx.get('workingDirectory')?.get?.(session) ?? session.header?.cwd;
			if (typeof path !== 'string') continue;
			const actual = await realpath(path).catch(() => path);
			if (actual !== cwd && !actual.startsWith(cwd + sep) && !cwd.startsWith(actual + sep)) continue;
			if (await hostCapabilities(ctx).sessionLive(session.id ?? session.header?.id)) return true;
			for (const agent of ctx.get('agents')?.list?.() ?? []) if (agent.session?.id === (session.id ?? session.header?.id) && ctx.get('terminals')?.list?.(agent).some(terminal => terminal.status.kind === 'running')) return true;
		}
		return false;
	} });
	installCheckpoints(ctx, checkpoints);
	const messageIdle = sessionId => {
		const agent = ctx.get('agents')?.get?.(sessionId);
		return !agent || agent.status === 'idle' && !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length;
	};
	const messages = new MessageTools({ sessions: () => ctx.get('sessions'), idle: messageIdle, busy: async sessionId => {
		if (await hostCapabilities(ctx).sessionLive(sessionId)) return true;
		return !messageIdle(sessionId);
	} });
	const nextTasks = new NextTasks({ root, settings: () => settingsCache, llm: () => ctx.get('llm'), sessions: () => ctx.get('sessions'), busy: id => !messageIdle(id) });
	await nextTasks.restore().catch(error => ctx.logger.warn(`任务联想缓存恢复失败：${error.message}`));
	installNextTasks(ctx, nextTasks);
	const trash = new TrashEngine({
		adapter: registryAdapter(ctx),
		sessions: async () => {
			const ids = (ctx.get('sessions')?.list() ?? []).map(session => session.header?.id).filter(id => typeof id === 'string');
			return (await Promise.all(ids.map(async id => await hostCapabilities(ctx).sessionLive(id) ? id : null))).filter(Boolean);
		},
		loaded: id => ctx.get('sessions')?.get?.(id) !== undefined,
		sessionsRoot: join(dshHome, 'sessions'),
		projcacheRoot: join(dshHome, 'storages', 'session_projcache', 'sessions'),
		kitRoot: root,
		ledger: ledgerDoc,
		vault: { dropSession: sessionId => manifestDoc.update(current => ({ ...current, records: current.records.filter(record => record.sessionId !== sessionId) })) },
		journal: async () => (await journalDoc.read()).active,
		settings: () => settingsCache.trash ?? {},
	});

	/** All known projects (id/path/title/session count) for the move picker. */
	const listProjects = ctx => {
		const registry = ctx.get('workspaceRegistry');
		if (registry === undefined) return [];
		return registry.list().map(row => ({
			id: row.id,
			path: row.path,
			title: row.title ?? row.path,
			sessions: (row.sessionIds ?? []).length,
		})).sort((a, b) => a.title.localeCompare(b.title));
	};

	let pendingAction = Promise.resolve();
	const kit = {
		settings: settingsDoc,
		manifest: manifestDoc,
		journal: journalDoc,
		move,
		trash,
		workspace,
		checkpoints,
		messages,
		nextTasks,
		updateSettings: async patch => {
			const next = await settingsDoc.update(current => deepMerge(current, patch));
			settingsCache = next;
			nextTasks.configure();
			return next;
		},
		vaultSync: async records => {
			const manifest = await manifestDoc.update(() => ({
				version: 1,
				records: (Array.isArray(records) ? records : []).filter(record => typeof record.sessionId === 'string' && typeof record.attachmentId === 'string')
					.slice(-2000)
					.map(record => ({ sessionId: record.sessionId, attachmentId: record.attachmentId,
						name: String(record.name ?? ''), size: Number(record.size) || 0, hash: String(record.hash ?? ''),
						createdAt: Number(record.createdAt) || Date.now() })),
			}));
			return manifest;
		},
		state: async () => {
			const settings = await settingsDoc.read();
			settingsCache = settings;
			const journal = (await journalDoc.read().catch(() => ({ active: journalCache }))).active;
			journalCache = journal;
			const manifest = await manifestDoc.read();
			const groupState = await groupsDoc.read();
			return {
				pluginVersion,
				capabilities,
				settings,
				nextTasks: await nextTasks.summary(),
				journal,
				projects: listProjects(ctx),
				groups: groupState.groups,
				ungroupedIndex: groupState.ungroupedIndex ?? groupState.groups.length,
				workspaceMove: await workspace.active(),
				trash: await trash.items(),
				// Bytes live in browser IndexedDB; the manifest mirrors their metadata only.
				vault: { records: manifest.records.length, bytes: manifest.records.reduce((total, record) => total + (record.size ?? 0), 0) },
				recovery: journal === null ? null : `未完成迁移：${journal.sessionId} → ${journal.toCwd}（已完成 ${journal.done.join('/') || '无'}）`,
			};
		},
		/** The project a session currently belongs to (null when unknown). */
		projectOf: async sessionId => {
			if (sessionId === '') return null;
			const registry = ctx.get('workspaceRegistry');
			if (registry === undefined) return null;
			for (const row of registry.list()) {
				if ((row.sessionIds ?? []).includes(sessionId)) {
					return { id: row.id, path: row.path, title: row.title ?? row.path };
				}
			}
			return null;
		},
		action: input => {
			const result = pendingAction.then(async () => {
				if (!['nextTasks.get', 'nextTasks.generate', 'workspace.complete', 'project.of', 'trash.list', 'vault.sync', 'vault.sweep', 'settings.update'].includes(input.type)) await workspace.assertIdle();
				return dispatch(kit, input);
			});
			pendingAction = result.catch(() => {});
			return result;
		},
	};

	ctx.inject?.(['webServer'], webCtx => {
		capabilities.webServer = true;
		webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: '/.well-known/dsh-session-toolbox', handler: apiHandler(kit) }));
	});

	// Expose the kit in-process (cordis plugins must return nothing; the service
	// is the surface other plugins or future official hooks can reach).
	ctx.provide('sessionToolbox', kit);

	ctx.effect(() => {
		const sweep = () => { void kit.action({ type: 'trash.sweep' }).catch(error => ctx.logger?.warn?.(`session-toolbox: trash sweep failed — ${error.message}`)); };
		const timer = setInterval(sweep, 60 * 60 * 1000);
		timer.unref?.();
		return () => clearInterval(timer);
	});
	ctx.logger?.info?.('dsh-session-toolbox ready', JSON.stringify({ version: pluginVersion, capabilities }));
}

/**
 * Host capabilities for the move engine (§10 MR5). Services are fetched lazily
 * through `ctx.get`; a missing one raises a stable error the UI can show.
 */
export function hostCapabilities(ctx) {
	return {
		sessionMaintenance: createSessionMaintenance(ctx),
		/**
		 * Whether a session is actively working.
		 *
		 * The old check asked whether `sessions.list()` contained the id, but that
		 * list holds every session the host has loaded — a session that is merely
		 * open (or was opened at some point) counted as live and blocked every
		 * move. The official activity hook is `workspace/session-activity`: any
		 * returned activity (turn, job, subagent or schedule) blocks relocation.
		 */
		sessionLive: async sessionId => {
			const activities = await ctx.waterfall?.('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
			return Array.isArray(activities) && activities.length > 0;
		},
		sessionLoaded: sessionId => ctx.get('sessions')?.get?.(sessionId) !== undefined,
		listHeaders: async () => {
			const persistence = ctx.get('sessionPersistence');
			if (persistence?.list !== undefined) return (await persistence.list()).map(snapshot => snapshot.header);
			const registry = ctx.get('workspaceRegistry');
			if (registry?.listStoredHeaders !== undefined) return await registry.listStoredHeaders();
			throw new Error('no session-persistence service in this DSH build');
		},
		/** Drop stale header entries so `attachSession` validates the NEW on-disk cwd (§10 MR4). */
		refreshHeaderCache: async () => {
			const registry = ctx.get('workspaceRegistry');
			if (typeof registry?.replaceHeaderIndex !== 'function') return;
			await registry.replaceHeaderIndex(await registry.listStoredHeaders());
		},
		/** Ledger step (§10 MR2 step 2): source detach → target create → attach. */
		moveLedger: async (sessionId, fromCwd, toCwd) => {
			const registry = ctx.get('workspaceRegistry');
			if (registry === undefined) throw new Error('workspaceRegistry unavailable in this DSH build');
			const canonicalFrom = fromCwd === undefined ? undefined : await realpath(fromCwd).catch(() => fromCwd);
			const source = canonicalFrom === undefined ? undefined : typeof registry.list === 'function'
				? registry.list().find(row => row.path === canonicalFrom)
				: await registry.resolveByPath(canonicalFrom);
			if (source !== undefined) await source.detachSession(sessionId);
			if (toCwd === undefined) return;
			let target = await registry.resolveByPath(toCwd);
			if (target === undefined) {
				if (!(await stat(toCwd).then(s => s.isDirectory(), () => false))) throw new Error(`target directory ${toCwd} does not exist`);
				target = await registry.create(toCwd);
			}
			await target.attachSession(sessionId);
		},
		resyncIndex: async () => {
			// §10.8-3: the sqlite query index reconciles against persistence lazily on
			// every query path; there is nothing explicit to call in this build.
			return ctx.get('sessionQuery') !== undefined ? 'lazy' : 'unavailable';
		},
		/**
		 * Re-read the session headers so the registry (and every list built from
		 * it) sees the session's new location. This is the host-side half of
		 * "refresh"; the client half is a refetch scoped to this one session.
		 */
		refreshPlacement: async sessionId => {
			const registry = ctx.get('workspaceRegistry');
			if (registry === undefined) return 'unavailable';
			if (typeof registry.listStoredHeaders === 'function' && typeof registry.replaceHeaderIndex === 'function') {
				await registry.replaceHeaderIndex(await registry.listStoredHeaders());
			}
			await ctx.get('sessionPersistence')?.refresh?.().catch?.(() => {});
			return registry.sessionKnown !== undefined && sessionId !== undefined
				? (await registry.sessionKnown(sessionId) ? 'known' : 'unknown')
				: 'refreshed';
		},
	};
}

/**
 * The narrow adapter the trash engine runs every official effect through
 * (§11 TB5). Workspace deletion keeps session logs (§11.1-2); bootstrap only
 * re-claims non-archived unaccounted sessions — which is why trashing a project
 * archives its sessions first, and restoring re-registers + attaches +
 * unarchives in order.
 */
export function registryAdapter(ctx) {
	const registry = () => {
		const value = ctx.get('workspaceRegistry');
		if (value === undefined) throw Object.assign(new Error('workspaceRegistry unavailable'), { code: 'no-capability' });
		return value;
	};
	return {
		sessionKnown: async sessionId => {
			const rows = registry();
			return typeof rows.sessionKnown === 'function' ? await rows.sessionKnown(sessionId) : false;
		},
		archivedSet: async () => new Set(ctx.get('workspaceRegistry')?.archivedSessionIds ?? []),
		pinnedSet: async () => new Set(registry().pinnedSessionIds ?? []),
		locateSession: async sessionId => {
			let title = null;
			try { title = (await ctx.get('sessionQuery')?.readTitle?.(sessionId))?.title ?? null; } catch { /* title is optional */ }
			for (const entity of registry().list()) {
				const ids = entity.sessionIds ?? [];
				if (!ids.includes(sessionId)) continue;
				const at = ids.indexOf(sessionId);
				return { workspaceId: entity.id, beforeId: at + 1 < ids.length ? ids[at + 1] : null, title };
			}
			return { workspaceId: null, beforeId: null, title };
		},
		workspaceSnapshot: async workspaceId => {
			const rows = registry();
			const entity = rows.get(workspaceId);
			if (entity === undefined) return undefined;
			const ids = entity.sessionIds ?? [];
			const archived = new Set(rows.archivedSessionIds ?? []);
			const pinned = new Set(rows.pinnedSessionIds ?? []);
			const order = rows.list().map(row => row.id);
			const at = order.indexOf(entity.id);
			return {
				workspaceId: entity.id, path: entity.path, title: entity.title,
				beforeId: at + 1 < order.length ? order[at + 1] : null,
				sessions: ids.map((sessionId, index) => ({ sessionId,
					previouslyArchived: archived.has(sessionId),
					previouslyPinned: pinned.has(sessionId),
					beforeId: index + 1 < ids.length ? ids[index + 1] : null })),
			};
		},
		archiveSession: (sessionId, options) => registry().archiveSession(sessionId, options),
		unarchiveSession: sessionId => registry().unarchiveSession(sessionId),
		pinSession: sessionId => registry().pinSession(sessionId),
		unpinSession: sessionId => registry().unpinSession(sessionId),
		deleteWorkspace: workspaceId => registry().delete(workspaceId),
		repairSlot: async (sessionId, workspaceId, beforeId) => {
			const entity = registry().get(workspaceId);
			if (entity === undefined) return;
			if (!entity.sessionIds?.includes(sessionId)) await entity.attachSession(sessionId);
			await entity.insertSessionBefore(sessionId, beforeId !== null && entity.sessionIds?.includes(beforeId) ? beforeId : undefined);
		},
		restoreWorkspace: async snapshot => {
			const rows = registry();
			let entity = rows.list().find(row => row.path === snapshot.path);
			if (entity === undefined) {
				await mkdir(snapshot.path, { recursive: true }).catch(() => {});
				entity = await rows.create(snapshot.path, snapshot.title);
			}
			for (const row of [...snapshot.sessions].reverse()) await entity.attachSession(row.sessionId);
			for (const row of [...snapshot.sessions].reverse()) {
				await entity.insertSessionBefore(row.sessionId, row.beforeId ?? undefined);
			}
			const anchor = rows.list().some(row => row.id === snapshot.beforeId) ? snapshot.beforeId : undefined;
			if (entity.id !== anchor) await rows.insertBefore(entity.id, anchor);
			return entity;
		},
		purgeSession: async sessionId => {
			for (const entity of registry().list()) {
				if (entity.sessionIds?.includes(sessionId)) await entity.detachSession(sessionId);
			}
			await hostCapabilities(ctx).refreshHeaderCache();
		},
		/** Re-read headers so a restored/archived session's placement is visible. */
		refreshPlacement: async sessionId => hostCapabilities(ctx).refreshPlacement(sessionId),
	};
}

function deepMerge(base, patch) {
	const next = { ...base };
	for (const [key, value] of Object.entries(patch ?? {})) {
		next[key] = value !== null && typeof value === 'object' && !Array.isArray(value) ? deepMerge(base[key] ?? {}, value) : value;
	}
	return next;
}
