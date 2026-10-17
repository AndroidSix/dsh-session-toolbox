import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrashEngine, TrashError } from '../src/trash.mjs';
import { JsonDocument, guardLedger } from '../src/store.mjs';
import { encodeSegment, projectKey } from '../src/paths.mjs';
import { sessionArtifact } from './helpers/zstd-frames.mjs';

const S1 = 'session-aaaaaaaa-0000-0000-0000-000000000001';
const S2 = 'session-aaaaaaaa-0000-0000-0000-000000000002';
const S3 = 'session-aaaaaaaa-0000-0000-0000-000000000003';

/**
 * In-memory registry mirroring the shipped WorkspaceRegistry semantics:
 * attach prepends, sessionIds getter prunes ids that live elsewhere, pin/archive
 * are mutually exclusive, delete keeps nothing but the row.
 */
function fakeRegistry({ workspaces, archived = [], pinned = [] }) {
	const rows = workspaces.map(row => ({ ...row, sessionIds: [...row.sessionIds] }));
	const state = {
		archivedSessionIds: [...archived],
		pinnedSessionIds: [...pinned],
		rowsFor: id => rows.find(row => row.sessionIds.includes(id)),
		list: () => rows.map(row => entity(row)),
		get: id => { const row = rows.find(r => r.id === id); return row === undefined ? undefined : entity(row); },
		sessionKnown: async id => true,
		archiveSession: async id => { if (!state.archivedSessionIds.includes(id)) state.archivedSessionIds.push(id); state.pinnedSessionIds = state.pinnedSessionIds.filter(x => x !== id); },
		unarchiveSession: async id => { state.archivedSessionIds = state.archivedSessionIds.filter(x => x !== id); },
		pinSession: async id => { if (state.archivedSessionIds.includes(id)) throw new Error('cannot pin archived'); if (!state.pinnedSessionIds.includes(id)) state.pinnedSessionIds.unshift(id); },
		unpinSession: async id => { state.pinnedSessionIds = state.pinnedSessionIds.filter(x => x !== id); },
		delete: async id => { const at = rows.findIndex(r => r.id === id); if (at >= 0) rows.splice(at, 1); },
		create: async (path, title) => {
			let row = rows.find(r => r.path === path);
			if (row === undefined) { row = { id: `ws-${rows.length + 1}-${Math.random().toString(36).slice(2, 6)}`, path, title: title ?? path.split('/').at(-1), sessionIds: [] }; rows.push(row); }
			return entity(row);
		},
		insertBefore: async (id, beforeId) => {
			const at = rows.findIndex(r => r.id === id);
			const anchor = rows.findIndex(r => r.id === beforeId);
			if (at < 0 || anchor < 0 || id === beforeId) return;
			const [row] = rows.splice(at, 1);
			rows.splice(anchor, 0, row);
		},
	};
	function entity(row) {
		return {
			id: row.id, path: row.path, title: row.title,
			get sessionIds() { return row.sessionIds.filter(id => state.rowsFor(id)?.path === row.path); },
			attachSession: async id => { const owner = state.rowsFor(id); if (owner !== undefined && owner !== row) await owner.detachSession(id); if (!row.sessionIds.includes(id)) row.sessionIds.unshift(id); },
			detachSession: async id => { row.sessionIds = row.sessionIds.filter(x => x !== id); },
			insertSessionBefore: async (id, beforeId) => {
				if (!row.sessionIds.includes(id) || !row.sessionIds.includes(beforeId) || id === beforeId) return;
				const without = row.sessionIds.filter(x => x !== id);
				const at = without.indexOf(beforeId);
				row.sessionIds = [...without.slice(0, at), id, ...without.slice(at)];
			},
		};
	}
	return state;
}

/** The same surface src/index.mjs registryAdapter(ctx) exposes over the fake. */
function adapterFor(registry) {
	return {
		sessionKnown: id => registry.sessionKnown(id),
		archivedSet: async () => new Set(registry.archivedSessionIds),
		pinnedSet: async () => new Set(registry.pinnedSessionIds),
		locateSession: async sessionId => {
			for (const entity of registry.list()) {
				const ids = entity.sessionIds;
				if (!ids.includes(sessionId)) continue;
				const at = ids.indexOf(sessionId);
				return { workspaceId: entity.id, beforeId: at + 1 < ids.length ? ids[at + 1] : null, title: null };
			}
			return { workspaceId: null, beforeId: null, title: null };
		},
		workspaceSnapshot: async workspaceId => {
			const entity = registry.get(workspaceId);
			if (entity === undefined) return undefined;
			const ids = entity.sessionIds;
			const archived = new Set(registry.archivedSessionIds);
			const pinned = new Set(registry.pinnedSessionIds);
			const order = registry.list().map(row => row.id);
			const at = order.indexOf(entity.id);
			return { workspaceId: entity.id, path: entity.path, title: entity.title, beforeId: at > 0 ? order[at - 1] : null,
				sessions: ids.map((sessionId, index) => ({ sessionId, previouslyArchived: archived.has(sessionId), previouslyPinned: pinned.has(sessionId), beforeId: index + 1 < ids.length ? ids[index + 1] : null })) };
		},
		archiveSession: (id, opts) => registry.archiveSession(id, opts),
		unarchiveSession: id => registry.unarchiveSession(id),
		pinSession: id => registry.pinSession(id),
		unpinSession: id => registry.unpinSession(id),
		deleteWorkspace: id => registry.delete(id),
		repairSlot: async (sessionId, workspaceId, beforeId) => {
			const entity = registry.get(workspaceId);
			if (entity === undefined) return;
			if (!entity.sessionIds.includes(sessionId)) await entity.attachSession(sessionId);
			if (beforeId !== null && entity.sessionIds.includes(beforeId)) await entity.insertSessionBefore(sessionId, beforeId);
		},
		restoreWorkspace: async snapshot => {
			let entity = registry.list().find(row => row.path === snapshot.path);
			if (entity === undefined) entity = await registry.create(snapshot.path, snapshot.title);
			for (const s of [...snapshot.sessions].reverse()) await entity.attachSession(s.sessionId).catch(() => {});
			if (snapshot.beforeId !== null && snapshot.beforeId !== entity.id) await registry.insertBefore(entity.id, snapshot.beforeId);
			return entity;
		},
		purgeSession: async () => 'unavailable',
	};
}

async function world(t) {
	const base = await mkdtemp(join(tmpdir(), 'sk-trash-'));
	const sessionsRoot = join(base, 'sessions');
	const projcacheRoot = join(base, 'projcache');
	const kitRoot = join(base, 'kit');
	const a = join(base, 'project-a'), b = join(base, 'project-b');
	await mkdir(projcacheRoot, { recursive: true });
	for (const [cwd, ids] of [[a, [S1, S2]], [b, [S3]]]) {
		await mkdir(cwd, { recursive: true });
		for (const id of ids) {
			const dir = join(sessionsRoot, projectKey(cwd), encodeSegment(id));
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, 'session.v4.jsonl.zstd'), sessionArtifact({ type: 'session', version: 4, id, cwd }, ['{"seq":1}\n']));
			await writeFile(join(projcacheRoot, `${id}.json`), JSON.stringify({ identity: { cwd } }));
		}
	}
	const registry = fakeRegistry({ workspaces: [{ id: 'ws-a', path: a, title: 'A', sessionIds: [S1, S2] }, { id: 'ws-b', path: b, title: 'B', sessionIds: [S3] }] });
	const ledger = new JsonDocument(kitRoot, 'trash.json', { version: 1, items: [] }, guardLedger);
	const settings = { ttlDays: 30, autoPurge: false };
	let clock = Date.now();
	const engine = new TrashEngine({ adapter: adapterFor(registry), sessions: () => [], sessionsRoot, projcacheRoot, kitRoot, ledger,
		journal: () => null, settings: () => settings, now: () => clock });
	t.after(() => rm(base, { recursive: true, force: true }));
	return { engine, registry, ledger, sessionsRoot, projcacheRoot, kitRoot, a, b, settings, advance: days => { clock += days * 24 * 60 * 60 * 1000; } };
}

test('trashSession archives + records snapshot; restore reverses both', async t => {
	const w = await world(t);
	const res = await w.engine.trashSession(S1);
	assert.equal(w.registry.archivedSessionIds.includes(S1), true);
	const items = await w.engine.items();
	assert.equal(items.length, 1);
	assert.equal(items[0].snapshot.workspaceId, 'ws-a');
	assert.equal(items[0].snapshot.beforeId, S2, 'S1 sat before S2');
	await assert.rejects(w.engine.trashSession(S1), e => e.code === 'already-trashed');
	await w.engine.restore(res.itemId);
	assert.equal(w.registry.archivedSessionIds.includes(S1), false);
	assert.equal((await w.engine.items()).length, 0);
	assert.deepEqual(w.registry.get('ws-a').sessionIds, [S1, S2], 'position restored');
});

test('pinned sessions stay pinned across trash/restore; archive drops pin per official rules', async t => {
	const w = await world(t);
	await w.registry.pinSession(S1);
	const res = await w.engine.trashSession(S1);
	assert.equal(w.registry.pinnedSessionIds.includes(S1), false, 'official rule: archiving drops the pin');
	const items = await w.engine.items();
	assert.equal(items[0].snapshot.previouslyPinned, true);
	await w.engine.restore(res.itemId);
	assert.equal(w.registry.pinnedSessionIds.includes(S1), true, 'pin restored from snapshot');
});

test('previouslyArchived sessions enter the bin without double-archiving and restore keeps them archived', async t => {
	const w = await world(t);
	await w.registry.archiveSession(S2);
	const res = await w.engine.trashSession(S2);
	const items = await w.engine.items();
	assert.equal(items[0].snapshot.previouslyArchived, true);
	await w.engine.restore(res.itemId);
	assert.equal(w.registry.archivedSessionIds.includes(S2), true, 'user archive state survives the bin round-trip');
});

test('trashWorkspace archives all, deletes registration; restore is idempotent even after bootstrap recreated it', async t => {
	const w = await world(t);
	const res = await w.engine.trashWorkspace('ws-a');
	assert.equal(w.registry.get('ws-a'), undefined);
	assert.deepEqual([...w.registry.archivedSessionIds].sort(), [S1, S2].sort());
	// bootstrap-like recreation with only the non-archived residue (none here) — path exists again
	const recreated = await w.registry.create(w.a, 'A-bootstrap');
	const done = await w.engine.restore(res.itemId);
	assert.equal(done.ok, true);
	const restored = w.registry.list().find(row => row.path === w.a);
	assert.equal(restored.id, recreated.id, 'existing registration reused');
	assert.deepEqual(restored.sessionIds, [S1, S2], 'order restored');
	assert.equal(w.registry.archivedSessionIds.length, 0, 'archive residue cleared');
});

test('live sessions are refused before any write', async t => {
	const w = await world(t);
	const engine = new TrashEngine({ ...w.engine.deps, sessions: () => [S1] });
	await assert.rejects(engine.trashSession(S1), e => e.code === 'session-busy');
	await assert.rejects(engine.trashWorkspace('ws-a'), e => e.code === 'workspace-busy');
	assert.equal((await engine.items()).length, 0);
});

test('an unresolved move journal blocks trash operations', async t => {
	const w = await world(t);
	const blocked = new TrashEngine({ ...w.engine.deps, journal: () => ({ sessionId: S1 }) });
	await assert.rejects(blocked.trashSession(S2), e => e.code === 'journal-active');
	await assert.rejects(blocked.trashSession(S2), TrashError);
});

test('purge removes artifacts + projcache + ledger item; neighbours intact', async t => {
	const w = await world(t);
	const res = await w.engine.trashSession(S1);
	await w.engine.purge(res.itemId);
	let found = false;
	for (const project of await readdir(w.sessionsRoot)) {
		try { await stat(join(w.sessionsRoot, project, encodeSegment(S1))); found = true; } catch {}
	}
	assert.equal(found, false);
	assert.equal((await w.engine.items()).length, 0);
	assert.equal(await stat(join(w.projcacheRoot, `${S1}.json`)).then(() => true, () => false), false);
	assert.ok((await readFile(join(w.sessionsRoot, projectKey(w.a), encodeSegment(S2), 'session.v4.jsonl.zstd'))).length > 0);
});

test('purge of a trashed workspace removes all its sessions', async t => {
	const w = await world(t);
	const res = await w.engine.trashWorkspace('ws-a');
	const gone = await w.engine.purge(res.itemId);
	assert.deepEqual(gone.purged.sort(), [S1, S2].sort());
	for (const project of await readdir(w.sessionsRoot)) {
		for (const id of [S1, S2]) {
			const missing = await stat(join(w.sessionsRoot, project, encodeSegment(id))).then(() => false, () => true);
			assert.ok(missing, `${id} gone from ${project}`);
		}
	}
});

test('sweep reports expired items; autoPurge purges them', async t => {
	const w = await world(t);
	const res = await w.engine.trashSession(S1);
	let report = await w.engine.sweep();
	assert.equal(report.expired.length, 0);
	w.advance(31);
	report = await w.engine.sweep();
	assert.equal(report.expired.length, 1);
	assert.equal((await w.engine.items()).length, 1, 'expired but kept until autoPurge');
	w.settings.autoPurge = true;
	report = await w.engine.sweep();
	assert.deepEqual(report.purged, [res.itemId]);
	assert.equal((await w.engine.items()).length, 0);
});
