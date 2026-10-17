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

	async items() { return (await this.ledger.read()).items.map(publicItem); }

	#guardFree(id) {
		if (typeof this.deps.journal === 'function' && this.deps.journal() !== null) {
			throw new TrashError('journal-active', 'a journaled move is unresolved; finish or roll it back first');
		}
		const live = this.deps.sessions?.() ?? [];
		if (live.includes(id)) throw new TrashError('session-busy', `session ${id} is live; open it and stop its work first`);
	}

	#find(state, predicate) { return state.items.find(predicate); }

	/** §11 TB3: trash one session (archive + ledger; already-archived sessions only enter the bin). */
	async trashSession(sessionId, { force = false } = {}) {
		this.#guardFree(sessionId);
		const adapter = this.deps.adapter;
		const state = await this.ledger.read();
		if (this.#find(state, item => item.kind === 'session' && item.id2 === sessionId)) throw new TrashError('already-trashed', 'this session is already in the trash bin');
		if (!await adapter.sessionKnown(sessionId)) throw new TrashError('session-unknown', `session ${sessionId} is unknown to the registry`);
		const archived = await adapter.archivedSet();
		const pinned = await adapter.pinnedSet();
		const { workspaceId, beforeId, title } = await adapter.locateSession(sessionId);
		if (!archived.has(sessionId)) await adapter.archiveSession(sessionId, force ? { stopActivity: true } : {});
		const item = {
			id: randomUUID(), kind: 'session', id2: sessionId, trashedAt: new Date(this.now()).toISOString(),
			snapshot: { sessionId, workspaceId: workspaceId ?? null, beforeId: beforeId ?? null,
				previouslyArchived: archived.has(sessionId), previouslyPinned: pinned.has(sessionId), title: title ?? null },
		};
		state.items.push(item);
		await this.ledger.write(state);
		return { ok: true, itemId: item.id };
	}

	/** §11 TB4: trash a project (archive all its sessions, snapshot order/state, delete registration). */
	async trashWorkspace(workspaceId, { force = false } = {}) {
		const adapter = this.deps.adapter;
		const state = await this.ledger.read();
		if (this.#find(state, item => item.kind === 'workspace' && item.id2 === workspaceId)) throw new TrashError('already-trashed', 'this project is already in the trash bin');
		const snapshot = await adapter.workspaceSnapshot(workspaceId);
		if (snapshot === undefined) throw new TrashError('workspace-unknown', `workspace ${workspaceId} not found`);
		const live = new Set(this.deps.sessions?.() ?? []);
		if (!force && snapshot.sessions.some(row => live.has(row.sessionId))) throw new TrashError('workspace-busy', 'the project has live sessions; use force to stop and trash them');
		for (const row of snapshot.sessions) {
			if (row.previouslyArchived) continue;
			await adapter.archiveSession(row.sessionId, live.has(row.sessionId) ? { stopActivity: true } : {});
		}
		const item = { id: randomUUID(), kind: 'workspace', id2: workspaceId, trashedAt: new Date(this.now()).toISOString(), snapshot };
		state.items.push(item);
		await this.ledger.write(state);
		await adapter.deleteWorkspace(workspaceId);
		return { ok: true, itemId: item.id };
	}

	/** §11 TB5 idempotent restore: converge to the snapshot; failures propagate so the item survives for retry. */
	async restore(itemId) {
		const adapter = this.deps.adapter;
		const state = await this.ledger.read();
		const item = this.#find(state, row => row.id === itemId);
		if (item === undefined) throw new TrashError('item-unknown', `no trash item ${itemId}`);
		if (item.kind === 'session') await this.#restoreSession(adapter, item.snapshot);
		else await this.#restoreWorkspace(adapter, item.snapshot);
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
			if (row.previouslyPinned && !row.previouslyArchived) await adapter.pinSession(row.sessionId).catch(() => {});
		}
	}

	/** §11 TB6: hard-delete with staging so a crash never yields a half-deleted state. */
	async purge(itemId) {
		const adapter = this.deps.adapter;
		const state = await this.ledger.read();
		const item = this.#find(state, row => row.id === itemId);
		if (item === undefined) throw new TrashError('item-unknown', `no trash item ${itemId}`);
		const sessionIds = item.kind === 'session' ? [item.snapshot.sessionId] : item.snapshot.sessions.map(row => row.sessionId);
		for (const sessionId of sessionIds) this.#guardFree(sessionId);
		for (const sessionId of sessionIds) {
			await this.#stageArtifact(sessionId);
			if (adapter.purgeSession) await adapter.purgeSession(sessionId);
		}
		for (const sessionId of sessionIds) {
			await adapter.unpinSession(sessionId).catch(() => {});
			await adapter.unarchiveSession(sessionId).catch(() => {});
		}
		if (item.kind === 'workspace') await adapter.deleteWorkspace(item.id2).catch(() => {});
		if (this.deps.vault?.dropSession) for (const sessionId of sessionIds) await this.deps.vault.dropSession(sessionId);
		state.items = state.items.filter(row => row.id !== itemId);
		await this.ledger.write(state);
		return { ok: true, purged: sessionIds };
	}

	async #stageArtifact(sessionId) {
		const encoded = encodeSegment(sessionId);
		const root = this.deps.sessionsRoot;
		let found;
		for (const project of await readdir(root).catch(() => [])) {
			if (project.startsWith('.')) continue;
			try { if ((await stat(join(root, project, encoded))).isDirectory()) { found = join(root, project, encoded); break; } } catch {}
		}
		if (found === undefined) return; // already staged away (idempotent)
		const staged = join(this.deps.kitRoot, 'pending-purge', `${sessionId}__${this.now()}`);
		await relocate(found, staged);
		if (this.deps.projcacheRoot) await rm(join(this.deps.projcacheRoot, `${sessionId}.json`), { force: true });
		// Durable placement done; only now drop the real bytes.
		await rm(staged, { recursive: true, force: true });
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
	return { itemId: item.id, kind: item.kind, targetId: item.id2, trashedAt: item.trashedAt, snapshot: item.snapshot };
}
