/**
 * Trash bin for sessions and projects (§11). Semantics pinned by the shipped
 * build: archiving is the reversible hide (slot kept, unarchive restores the
 * position), workspace deletion keeps every session log, and startup bootstrap
 * only re-claims sessions that are NOT archived — so "archive all sessions +
 * delete the registration" keeps a trashed project invisible until this ledger
 * restores it. All official effects run through a narrow registry adapter
 * (implemented in the host, faked in tests); the plugin-owned ledger snapshots
 * the placement, archive and pin state needed to restore them (§11 TB1/TB5).
 *
 * `purge` is the hard-delete path the official surface has no command for
 * (§11.1-1): it moves the session artifact into `pending-purge/` (same volume,
 * atomic placement, undoable until the last step), drops the projection-cache
 * record and vault manifest entries, and only then removes the ledger item.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodeSegment } from './paths.mjs';
import { relocate } from './move.mjs';

export class TrashError extends Error {
	code;
	constructor(code, message) { super(message); this.name = 'TrashError'; this.code = code; }
}

const DAY = 24 * 60 * 60 * 1000;

export class TrashEngine {
	/**
	 * @param deps - {adapter: RegistryAdapter, sessions?: () => liveSessionIds,
	 *   sessionsRoot, projcacheRoot, kitRoot, ledger: JsonDocument, vault?,
	 *   journal?: () => activeJournalEntry|null, settings?: () => trashSettings, now}
	 */
	constructor(deps) {
		this.deps = deps;
		this.ledger = deps.ledger;
		this.now = deps.now ?? (() => Date.now());
	}

	async items() {
		const state = await this.ledger.read();
		return [...state.items, ...await this.#nativeItems(state)].map(publicItem);
	}

	/** Read native archives without enrolling them in the plugin's TTL policy. */
	async #nativeItems(state) {
		const covered = new Set(state.items.flatMap(item => item.kind === 'session' ? [item.id2] : item.snapshot.sessions.map(row => row.sessionId)));
		const items = [];
		for (const sessionId of await this.deps.adapter.archivedSet()) {
			if (covered.has(sessionId)) continue;
			const location = await this.deps.adapter.locateSession(sessionId);
			items.push({ id: `native:${sessionId}`, kind: 'session', id2: sessionId, source: 'native', trashedAt: null,
				snapshot: { sessionId, workspaceId: location.workspaceId ?? null, beforeId: location.beforeId ?? null,
					title: location.title ?? null, previouslyArchived: false, previouslyPinned: false } });
		}
		return items;
	}

	async #item(state, itemId) {
		return this.#find(state, row => row.id === itemId) ?? (await this.#nativeItems(state)).find(row => row.id === itemId);
	}

	async #guardJournal() {
		if (typeof this.deps.journal === 'function' && await this.deps.journal() !== null) {
			throw new TrashError('journal-active', 'a journaled move is unresolved; finish or roll it back first');
		}
	}

	async #guardFree(id, { force = false, purge = false } = {}) {
		await this.#guardJournal();
		const live = await this.deps.sessions?.() ?? [];
		if (!force && live.includes(id)) throw new TrashError('session-busy', `session ${id} is active; stop its work first`);
		if (purge && this.deps.loaded?.(id)) throw new TrashError('session-loaded', '会话仍由 DSH 持有。请完全重启后，不打开该会话再彻底删除，或退出 DSH 后使用 CLI。');
	}

	#find(state, predicate) { return state.items.find(predicate); }

	/** §11 TB3: trash one session (archive + ledger; already-archived sessions only enter the bin). */
	async trashSession(sessionId, { force = false } = {}) {
		await this.#guardFree(sessionId, { force });
		const adapter = this.deps.adapter;
		const state = await this.ledger.read();
		if (this.#find(state, item => item.kind === 'session' && item.id2 === sessionId)) throw new TrashError('already-trashed', 'this session is already in the trash bin');
		if (!await adapter.sessionKnown(sessionId)) throw new TrashError('session-unknown', `session ${sessionId} is unknown to the registry`);
		const archived = await adapter.archivedSet();
		const pinned = await adapter.pinnedSet();
		const { workspaceId, beforeId, title } = await adapter.locateSession(sessionId);
		const item = {
			id: randomUUID(), kind: 'session', id2: sessionId, trashedAt: new Date(this.now()).toISOString(),
			snapshot: { sessionId, workspaceId: workspaceId ?? null, beforeId: beforeId ?? null,
				previouslyArchived: archived.has(sessionId), previouslyPinned: pinned.has(sessionId), title: title ?? null },
		};
		state.items.push(item);
		await this.ledger.write(state);
		if (!archived.has(sessionId)) await adapter.archiveSession(sessionId, force ? { stopActivity: true } : {});
		return { ok: true, itemId: item.id };
	}

	/** §11 TB4: trash a project (archive all its sessions, snapshot order/state, delete registration). */
	async trashWorkspace(workspaceId, { force = false } = {}) {
		await this.#guardJournal();
		const adapter = this.deps.adapter;
		const state = await this.ledger.read();
		if (this.#find(state, item => item.kind === 'workspace' && item.id2 === workspaceId)) throw new TrashError('already-trashed', 'this project is already in the trash bin');
		const snapshot = await adapter.workspaceSnapshot(workspaceId);
		if (snapshot === undefined) throw new TrashError('workspace-unknown', `workspace ${workspaceId} not found`);
		const live = new Set(await this.deps.sessions?.() ?? []);
		if (!force && snapshot.sessions.some(row => live.has(row.sessionId))) throw new TrashError('workspace-busy', 'the project has live sessions; use force to stop and trash them');
		const item = { id: randomUUID(), kind: 'workspace', id2: workspaceId, trashedAt: new Date(this.now()).toISOString(), snapshot };
		state.items.push(item);
		await this.ledger.write(state);
		for (const row of snapshot.sessions) {
			if (row.previouslyArchived) continue;
			await adapter.archiveSession(row.sessionId, live.has(row.sessionId) ? { stopActivity: true } : {});
		}
		await adapter.deleteWorkspace(workspaceId);
		return { ok: true, itemId: item.id };
	}

	/** §11 TB5 idempotent restore: converge to the snapshot; failures propagate so the item survives for retry. */
	async restore(itemId) {
		await this.#guardJournal();
		const adapter = this.deps.adapter;
		const state = await this.ledger.read();
		const item = await this.#item(state, itemId);
		if (item === undefined) throw new TrashError('item-unknown', `no trash item ${itemId}`);
		if (item.purge) throw new TrashError('purge-in-progress', '彻底删除已开始，请重试彻底删除以完成清理');
		if (item.kind === 'session') await this.#restoreSession(adapter, item.snapshot);
		else await this.#restoreWorkspace(adapter, item.snapshot);
		// Restoring changes where a session lives in the sidebar; refresh that one
		// placement so the row reappears without a DSH restart (other sessions
		// are untouched).
		const affected = item.kind === 'session' ? [item.snapshot.sessionId]
			: item.snapshot.sessions.map(row => row.sessionId);
		for (const sessionId of affected) await adapter.refreshPlacement?.(sessionId)?.catch?.(() => {});
		state.items = state.items.filter(row => row.id !== itemId);
		await this.ledger.write(state);
		return { ok: true };
	}

	async #restoreSession(adapter, snapshot) {
		const { sessionId, workspaceId, beforeId, previouslyArchived, previouslyPinned } = snapshot;
		if (!previouslyArchived) await adapter.unarchiveSession(sessionId);
		if (workspaceId !== null) await adapter.repairSlot(sessionId, workspaceId, beforeId);
		if (previouslyPinned) await adapter.pinSession(sessionId);
	}

	async #restoreWorkspace(adapter, snapshot) {
		await adapter.restoreWorkspace(snapshot);
		for (const row of snapshot.sessions) {
			if (!row.previouslyArchived) await adapter.unarchiveSession(row.sessionId);
		}
		// Pins are dropped by archiving (official rule); restore them for sessions
		// that were pinned before entering the bin.
		for (const row of snapshot.sessions) {
			if (row.previouslyPinned && !row.previouslyArchived) await adapter.pinSession(row.sessionId);
		}
	}

	/** §11 TB6: hard-delete with staging so a crash never yields a half-deleted state. */
	async purge(itemId) {
		await this.#guardJournal();
		const adapter = this.deps.adapter;
		const state = await this.ledger.read();
		const item = await this.#item(state, itemId);
		if (item === undefined) throw new TrashError('item-unknown', `no trash item ${itemId}`);
		const sessionIds = item.kind === 'session' ? [item.snapshot.sessionId] : item.snapshot.sessions.map(row => row.sessionId);
		for (const sessionId of sessionIds) await this.#guardFree(sessionId, { purge: true });
		// Journal destinations before the first rename. Retries reuse the same staging
		// paths, and a bookkeeping failure never destroys the only remaining bytes.
		if (!item.purge) {
			if (item.source === 'native') { item.trashedAt = new Date(this.now()).toISOString(); state.items.push(item); }
			item.purge = [];
			for (const sessionId of sessionIds) {
				const encoded = encodeSegment(sessionId);
				const found = [];
				for (const project of await readdir(this.deps.sessionsRoot).catch(error => {
					if (error.code === 'ENOENT') return [];
					throw error;
				})) {
					if (project.startsWith('.')) continue;
					const dir = join(this.deps.sessionsRoot, project, encoded);
					if (await stat(dir).then(s => s.isDirectory(), error => { if (error.code === 'ENOENT') return false; throw error; })) found.push(dir);
				}
				if (found.length > 1) throw new TrashError('duplicate-artifact', `session ${sessionId} has duplicate placements`);
				item.purge.push({ sessionId, source: found[0] ?? null, staged: join(this.deps.kitRoot, 'pending-purge', `${encoded}__${randomUUID()}`) });
			}
			await this.ledger.write(state);
		}
		for (const row of item.purge) {
			if (row.source !== null && await stat(row.source).then(() => true, () => false)) await relocate(row.source, row.staged);
			if (this.deps.projcacheRoot) await rm(join(this.deps.projcacheRoot, `${row.sessionId}.json`), { force: true });
			await adapter.purgeSession?.(row.sessionId);
			await adapter.unpinSession(row.sessionId);
			await adapter.unarchiveSession(row.sessionId);
			await this.deps.vault?.dropSession?.(row.sessionId);
		}
		if (item.kind === 'workspace') await adapter.deleteWorkspace(item.id2);
		for (const row of item.purge) await rm(row.staged, { recursive: true, force: true });
		state.items = state.items.filter(row => row.id !== itemId);
		await this.ledger.write(state);
		return { ok: true, purged: sessionIds };
	}

	/** TTL sweep (§11 T5). With autoPurge, expired items are hard-deleted; otherwise reported. */
	async sweep({ now = this.now() } = {}) {
		const state = await this.ledger.read();
		const settings = this.deps.settings?.() ?? {};
		const ttlDays = settings.ttlDays ?? 30;
		const auto = settings.autoPurge === true;
		const report = { expired: [], purged: [], skipped: [] };
		for (const item of state.items) {
			const trashedAt = Date.parse(item.trashedAt);
			if (!Number.isFinite(trashedAt) || now - trashedAt < ttlDays * DAY) continue;
			report.expired.push({ itemId: item.id, kind: item.kind, targetId: item.id2 });
			if (!auto) continue;
			try { await this.purge(item.id); report.purged.push(item.id); }
			catch (error) { report.skipped.push({ itemId: item.id, reason: String(error?.message ?? error) }); }
		}
		return report;
	}
}

function publicItem(item) {
	return { itemId: item.id, kind: item.kind, targetId: item.id2, trashedAt: item.trashedAt, snapshot: item.snapshot, source: item.source ?? 'toolbox' };
}
