import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceTools, guardGroups, guardWorkspaceJournal } from '../src/workspace.mjs';
import { JsonDocument, guardJournal } from '../src/store.mjs';
import { MoveEngine } from '../src/move.mjs';
import { readHeader } from '../src/session-log.mjs';
import { projectKey, encodeSegment } from '../src/paths.mjs';
import { sessionArtifact } from './helpers/zstd-frames.mjs';

async function world(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'sk-workspace-')));
	t.after(() => rm(root, { recursive: true, force: true }));
	const from = join(root, 'a'), to = join(root, 'b'), sessionsRoot = join(root, 'sessions');
	await mkdir(from); await mkdir(to);
	const ids = ['session-a', 'session-b'];
	const original = new Map();
	for (const id of ids) {
		const path = join(sessionsRoot, projectKey(from), encodeSegment(id));
		await mkdir(path, { recursive: true });
		const bytes = sessionArtifact({ type: 'session', version: 4, id, cwd: from }, ['{"seq":1,"type":"test"}\n']);
		original.set(id, bytes);
		const file = join(path, 'session.v4.jsonl.zstd');
		await writeFile(file, bytes);
		await utimes(file, new Date(1), new Date(1));
	}
	const rows = [{ id: 'A', path: from, title: 'Project A', sessionIds: [...ids] }, { id: 'C', path: root, title: 'C', sessionIds: [] }];
	const entity = row => row && ({
		...row, sessionIds: [...row.sessionIds],
		setTitle: async title => { row.title = title; },
		detachSession: async id => { row.sessionIds = row.sessionIds.filter(x => x !== id); },
		attachSession: async id => { if (!row.sessionIds.includes(id)) row.sessionIds.unshift(id); },
		insertSessionBefore: async (id, anchor) => { row.sessionIds = row.sessionIds.filter(x => x !== id); row.sessionIds.splice(anchor === undefined ? row.sessionIds.length : row.sessionIds.indexOf(anchor), 0, id); },
	});
	const registry = {
		list: () => rows.map(entity), get: id => entity(rows.find(row => row.id === id)),
		archivedSessionIds: ['session-b'], pinnedSessionIds: ['session-a'],
		create: async (path, title) => { const row = { id: `ws-${rows.length}`, path, title, sessionIds: [] }; rows.unshift(row); return entity(row); },
		delete: async id => { rows.splice(rows.findIndex(row => row.id === id), 1); },
		insertBefore: async (id, anchor) => { const [row] = rows.splice(rows.findIndex(row => row.id === id), 1); rows.splice(anchor === undefined ? rows.length : rows.findIndex(row => row.id === anchor), 0, row); },
	};
	const listHeaders = async () => {
		const headers = [];
		for (const project of await readdir(sessionsRoot)) for (const id of ids) {
			const bytes = await readFile(join(sessionsRoot, project, encodeSegment(id), 'session.v4.jsonl.zstd')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
			if (bytes) headers.push(readHeader(bytes).header);
		}
		return headers;
	};
	const move = new MoveEngine({ root, sessionsRoot, journal: new JsonDocument(root, 'move.json', { version: 1, active: null }, guardJournal), capabilities: {
		listHeaders, sessionLoaded: () => false,
		moveLedger: async (id, fromCwd, toCwd) => { await registry.list().find(row => row.path === fromCwd)?.detachSession(id); await registry.list().find(row => row.path === toCwd)?.attachSession(id); },
	} });
	const groups = new JsonDocument(root, 'groups.json', { version: 1, groups: [] }, guardGroups);
	const journal = new JsonDocument(root, 'workspace.json', { version: 1, active: null }, guardWorkspaceJournal);
	const deps = { registry: () => registry, move, groups, journal };
	return { root, from, to, ids, original, registry, move, groups, journal, deps, tools: new WorkspaceTools(deps), sessionsRoot };
}

test('groups persist, assign projects exclusively, rename and delete without deleting projects', async t => {
	const w = await world(t);
	const a = await w.tools.createGroup('Work'), b = await w.tools.createGroup('Personal');
	await w.tools.assignGroup('A', a.id);
	await w.tools.assignGroup('A', b.id);
	await w.tools.renameGroup(b.id, 'Private');
	assert.deepEqual((await w.groups.read()).groups.map(row => [row.title, row.workspaceIds]), [['Work', []], ['Private', ['A']]]);
	await assert.rejects(w.tools.assignGroup('missing', a.id), /项目|workspace/);
	await assert.rejects(w.tools.createGroup(' '), /名称|name/);
	await assert.rejects(w.tools.createGroup('Work'), /已存在|exists/);
	await w.tools.deleteGroup(b.id);
	assert.ok(w.registry.get('A'));
});

test('editing the path relocates all logs, keeps archive/pin/order/title and transfers the group', async t => {
	const w = await world(t);
	const group = await w.tools.createGroup('Work'); await w.tools.assignGroup('A', group.id);
	const result = await w.tools.edit({ workspaceId: 'A', path: w.to, title: 'Renamed' });
	assert.equal(w.registry.get('A'), undefined);
	const target = w.registry.get(result.workspaceId);
	assert.equal(target.title, 'Renamed'); assert.equal(target.path, w.to);
	assert.deepEqual(target.sessionIds, w.ids);
	assert.deepEqual(w.registry.list().map(row => row.id), [target.id, 'C']);
	assert.deepEqual(w.registry.archivedSessionIds, ['session-b']);
	assert.deepEqual(w.registry.pinnedSessionIds, ['session-a']);
	assert.deepEqual((await w.groups.read()).groups[0].workspaceIds, [target.id]);
	for (const id of w.ids) {
		const bytes = await readFile(join(w.sessionsRoot, projectKey(w.to), encodeSegment(id), 'session.v4.jsonl.zstd'));
		assert.equal(readHeader(bytes).header.cwd, w.to);
		assert.deepEqual(bytes.subarray(readHeader(bytes).frames[0].end), w.original.get(id).subarray(readHeader(w.original.get(id)).frames[0].end));
	}
	assert.equal((await w.journal.read()).active, null);
});

test('busy or loaded members and occupied targets reject before creating a replacement', async t => {
	const w = await world(t);
	w.move.caps.sessionLoaded = id => id === 'session-b';
	await assert.rejects(w.tools.edit({ workspaceId: 'A', path: w.to }), e => e.code === 'session-loaded');
	assert.equal(w.registry.list().length, 2);
	assert.equal((await w.journal.read()).active, null);
	w.move.caps.sessionLoaded = () => false;
	await assert.rejects(w.tools.edit({ workspaceId: 'A', path: w.root }), /已属于|occupied/);
});

test('a crash after moving bytes but before recording progress resumes in a new manager', async t => {
	const w = await world(t);
	const write = w.journal.write.bind(w.journal);
	let interrupted = false;
	w.journal.write = async value => {
		if (!interrupted && value.active?.moved?.length === 1) { interrupted = true; throw new Error('injected crash'); }
		return write(value);
	};
	await assert.rejects(w.tools.edit({ workspaceId: 'A', path: w.to }), /injected crash/);
	assert.ok((await w.journal.read()).active);
	w.journal.write = write;
	const result = await new WorkspaceTools(w.deps).complete();
	assert.deepEqual(w.registry.get(result.workspaceId).sessionIds, w.ids);
	assert.equal(w.registry.get('A'), undefined);
	assert.equal((await w.journal.read()).active, null);
});

test('title-only edits use the original project and do not touch logs', async t => {
	const w = await world(t);
	await w.tools.edit({ workspaceId: 'A', path: w.from, title: 'Updated' });
	assert.equal(w.registry.get('A').title, 'Updated');
	assert.equal((await w.journal.read()).active, null);
	assert.equal(w.registry.list().length, 2);
});


test('resume completes a journal for the second member before revisiting the first', async t => {
 const w = await world(t);
 const ledger = w.move.caps.moveLedger;
 let fail = true;
 w.move.caps.moveLedger = async (...args) => {
  if (args[0] === 'session-b' && fail) { fail = false; throw new Error('ledger offline'); }
  return ledger(...args);
 };
 await assert.rejects(w.tools.edit({ workspaceId: 'A', path: w.to }), /ledger|账本/);
 assert.equal((await w.move.readJournal()).sessionId, 'session-b');
 const result = await new WorkspaceTools(w.deps).complete();
 assert.deepEqual(w.registry.get(result.workspaceId).sessionIds, w.ids);
 assert.equal(await w.move.readJournal(), null);
});

test('toolbox archive recovery snapshots follow the replacement project id', async t => {
 const w = await world(t);
 const ledger = new JsonDocument(w.root, 'trash.json', { version: 1, items: [{ kind: 'session', id2: 'session-b', snapshot: { workspaceId: 'A', beforeId: 'session-a', previouslyPinned: true } }] });
 w.deps.ledger = ledger;
 const result = await new WorkspaceTools(w.deps).edit({ workspaceId: 'A', path: w.to });
 const snapshot = (await ledger.read()).items[0].snapshot;
 assert.equal(snapshot.workspaceId, result.workspaceId);
 assert.equal(snapshot.beforeId, 'session-a');
 assert.equal(snapshot.previouslyPinned, true);
});

test('resume survives deletion of the source registration before the final journal clear', async t => {
 const w = await world(t);
 const remove = w.registry.delete;
 let crash = true;
 w.registry.delete = async id => { await remove(id); if (crash) { crash = false; throw new Error('crash after delete'); } };
 await assert.rejects(w.tools.edit({ workspaceId: 'A', path: w.to }), /crash after delete/);
 assert.equal(w.registry.get('A'), undefined);
 const result = await new WorkspaceTools(w.deps).complete();
 assert.deepEqual(w.registry.get(result.workspaceId).sessionIds, w.ids);
 assert.equal(await w.tools.active(), null);
});

test('a removed original code directory does not prevent changing its project path', async t => {
 const w = await world(t);
 await rm(w.from, { recursive: true });
 const result = await w.tools.edit({ workspaceId: 'A', path: w.to });
 assert.deepEqual(w.registry.get(result.workspaceId).sessionIds, w.ids);
});
