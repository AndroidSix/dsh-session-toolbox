import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrashEngine, TrashError } from '../src/trash.mjs';
import { registryAdapter } from '../src/index.mjs';
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
			if (at < 0 || id === beforeId) return;
			const [row] = rows.splice(at, 1);
			const anchor = beforeId === undefined ? rows.length : rows.findIndex(r => r.id === beforeId);
			rows.splice(anchor, 0, row);
		},
	};
	function entity(row) {
		return {
			id: row.id, path: row.path, title: row.title,
			get sessionIds() { return row.sessionIds.filter(id => state.rowsFor(id)?.path === row.path); },
			attachSession: async id => { const owner = state.rowsFor(id); if (owner !== undefined && owner !== row) owner.sessionIds = owner.sessionIds.filter(x => x !== id); if (!row.sessionIds.includes(id)) row.sessionIds.unshift(id); },
			detachSession: async id => { row.sessionIds = row.sessionIds.filter(x => x !== id); },
			insertSessionBefore: async (id, beforeId) => {
				if (!row.sessionIds.includes(id) || (beforeId !== undefined && !row.sessionIds.includes(beforeId)) || id === beforeId) return;
				const without = row.sessionIds.filter(x => x !== id);
				const at = beforeId === undefined ? without.length : without.indexOf(beforeId);
				row.sessionIds = [...without.slice(0, at), id, ...without.slice(at)];
			},
		};
	}
	return state;
}

const adapterFor = registry => registryAdapter({ get: name => name === 'workspaceRegistry' ? registry : undefined });

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

test('native archives appear without duplication and restore through the pool', async t => {
	const w = await world(t);
	await w.registry.archiveSession(S1);
	const items = await w.engine.items();
	assert.equal(items.length, 1, 'the native archive button must populate the pool');
	assert.equal(items[0].targetId, S1);
	assert.equal(items[0].source, 'native');
	assert.equal(items[0].trashedAt, null, 'the original archive time is unknown');
	assert.equal((await w.ledger.read()).items.length, 0, 'native archives are not enrolled in automatic deletion');
	await w.engine.restore(items[0].itemId);
	assert.equal(w.registry.archivedSessionIds.includes(S1), false);
	assert.equal((await w.engine.items()).length, 0);
	const item = await w.engine.trashSession(S2);
	assert.equal((await w.engine.items()).length, 1, 'plugin archives must not appear twice');
	await w.engine.restore(item.itemId);
	await w.engine.trashWorkspace('ws-a');
	assert.equal((await w.engine.items()).length, 1, 'project members must not appear as separate native archives');
});

test('native archives stay outside TTL deletion and can be explicitly purged', async t => {
	const w = await world(t);
	await w.registry.archiveSession(S1);
	const item = (await w.engine.items())[0];
	w.settings.autoPurge = true;
	w.advance(100);
	assert.deepEqual((await w.engine.sweep()).purged, []);
	assert.equal((await w.engine.items()).length, 1);
	await w.engine.purge(item.itemId);
	assert.equal((await w.engine.items()).length, 0);
	assert.equal(await stat(join(w.sessionsRoot, projectKey(w.a), encodeSegment(S1))).then(() => true, () => false), false);
	assert.ok(await stat(join(w.sessionsRoot, projectKey(w.a), encodeSegment(S2))));
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

test('all archive-pool mutations respect an unresolved move, including an empty workspace', async t => {
	const w = await world(t);
	const archived = await w.engine.trashSession(S1);
	const empty = await w.registry.create(join(w.a, 'empty'), 'empty');
	const blocked = new TrashEngine({ ...w.engine.deps, journal: async () => ({ sessionId: S2 }) });
	await assert.rejects(blocked.trashWorkspace(empty.id), error => error.code === 'journal-active');
	await assert.rejects(blocked.restore(archived.itemId), error => error.code === 'journal-active');
});

test('purge bookkeeping failure retains staged bytes and can be retried', async t => {
	const w = await world(t);
	const item = await w.engine.trashSession(S1);
	const adapter = { ...w.engine.deps.adapter, purgeSession: async () => { throw new Error('registry unavailable'); } };
	const engine = new TrashEngine({ ...w.engine.deps, adapter });
	await assert.rejects(engine.purge(item.itemId), /registry unavailable/);
	const pending = (await w.ledger.read()).items[0];
	assert.ok((await readFile(join(pending.purge[0].staged, 'session.v4.jsonl.zstd'))).length > 0);
	adapter.purgeSession = async () => {};
	await engine.purge(item.itemId);
	assert.equal((await engine.items()).length, 0);
	assert.equal(await stat(pending.purge[0].staged).then(() => true, () => false), false);
});

test('a failed restore keeps its ledger entry for a later retry', async t => {
	const w = await world(t);
	const item = await w.engine.trashWorkspace('ws-a');
	const adapter = { ...w.engine.deps.adapter, restoreWorkspace: async () => { throw new Error('attach rejected'); } };
	const engine = new TrashEngine({ ...w.engine.deps, adapter });
	await assert.rejects(engine.restore(item.itemId), /attach rejected/);
	assert.equal((await engine.items()).length, 1);
});

test('archive is not applied if its recovery snapshot cannot be written', async t => {
	const w = await world(t);
	w.engine.ledger.write = async () => { throw new Error('disk full'); };
	await assert.rejects(w.engine.trashSession(S1), /disk full/);
	assert.equal(w.registry.archivedSessionIds.includes(S1), false);
});

test('native archive labels read the public title snapshot for placed and orphaned sessions', async () => {
	const registry = fakeRegistry({ workspaces: [{ id: 'ws-a', path: '/a', title: 'A', sessionIds: [S1] }] });
	const adapter = registryAdapter({ get: name => name === 'workspaceRegistry' ? registry : name === 'sessionQuery'
		? { readTitle: async id => ({ title: id === S1 ? '已归档的会话' : '原项目已删除的会话', eventSeq: 7, source: { kind: 'user' } }) } : undefined });
	const placed = await adapter.locateSession(S1);
	assert.equal(placed.title, '已归档的会话');
	assert.equal(placed.workspaceId, 'ws-a');
	const orphaned = await adapter.locateSession(S2);
	assert.equal(orphaned.title, '原项目已删除的会话');
	assert.equal(orphaned.workspaceId, null);
});
