import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.mjs';
import { encodeSegment, projectKey } from '../src/paths.mjs';
import { readHeader } from '../src/session-log.mjs';
import { sessionArtifact } from './helpers/zstd-frames.mjs';

const ID = 'session-11111111-2222-3333-4444-555555555555';
const S2 = 'session-aaaaaaaa-0000-0000-0000-000000000002';

/** Minimal cordis context double (same shape as dsh-multi-router startup tests). */
function fakeCtx(services = {}) {
	const disposers = [];
	const provided = new Map();
	const routes = { registered: [], handler: null };
	const webServer = { register: options => { routes.registered.push(options.path); routes.handler = options.handler; return () => {}; } };
	const log = [];
	// cordis effect(): run the callback now; a returned function is the disposer.
	const effect = cb => {
		const result = typeof cb === 'function' ? cb() : undefined;
		if (typeof result === 'function') disposers.push(result);
	};
	return {
		get: name => services[name] ?? provided.get(name),
		provide: (name, value) => { provided.set(name, value); },
		log,
		on() {}, emit() {},
		effect,
		inject: (ids, cb) => { if (ids.includes('webServer')) cb({ effect, webServer }); },
		logger: { info: (...a) => log.push(['info', ...a]), warn: (...a) => log.push(['warn', ...a]), error: (...a) => log.push(['error', ...a]) },
		routes,
		disposeAll: async () => { for (const d of disposers.reverse()) await d?.(); },
	};
}

/** Registry double with the shipped attach-prepends / account-pruning semantics. */
function fakeRegistry(initialHeaders = []) {
	const rows = new Map([['ws-a', { id: 'ws-a', path: '/project-a', title: 'A', sessionIds: [ID, S2] }]]);
	const archived = [], pinned = [];
	const headers = { list: initialHeaders };
	const ownerOf = id => [...rows.values()].find(r => r.sessionIds.includes(id));
	const entity = row => row && ({ id: row.id, path: row.path, title: row.title,
		sessionIds: row.sessionIds.filter(id => ownerOf(id)?.path === row.path),
		attachSession: async id => { const owner = ownerOf(id); if (owner !== undefined && owner !== row) owner.sessionIds = owner.sessionIds.filter(x => x !== id); if (!row.sessionIds.includes(id)) row.sessionIds.unshift(id); },
		detachSession: async id => { row.sessionIds = row.sessionIds.filter(x => x !== id); },
		insertSessionBefore: async (id, beforeId) => {
			if (!row.sessionIds.includes(id) || !row.sessionIds.includes(beforeId) || id === beforeId) return;
			const without = row.sessionIds.filter(x => x !== id);
			const at = without.indexOf(beforeId);
			row.sessionIds = [...without.slice(0, at), id, ...without.slice(at)];
		},
	});
	return {
		setHeaders: list => { headers.list = list; },
		archivedSessionIds: archived, pinnedSessionIds: pinned,
		list: () => [...rows.values()].map(entity),
		get: id => entity(rows.get(id)),
		sessionKnown: async id => ownerOf(id) !== undefined || archived.includes(id),
		archiveSession: async id => { if (!archived.includes(id)) archived.push(id); const p = pinned.indexOf(id); if (p >= 0) pinned.splice(p, 1); },
		unarchiveSession: async id => { const i = archived.indexOf(id); if (i >= 0) archived.splice(i, 1); },
		pinSession: async id => { if (archived.includes(id)) throw new Error('cannot pin archived'); if (!pinned.includes(id)) pinned.unshift(id); },
		unpinSession: async id => { const i = pinned.indexOf(id); if (i >= 0) pinned.splice(i, 1); },
		delete: async id => rows.delete(id),
		create: async (path, title) => { let row = [...rows.values()].find(r => r.path === path); if (row === undefined) { row = { id: `ws-${rows.size}`, path, title: title ?? 'new', sessionIds: [] }; rows.set(row.id, row); } return entity(row); },
		resolveByPath: async path => entity([...rows.values()].find(r => r.path === path)),
		insertBefore: async () => {},
		replaceHeaderIndex: async () => {},
		listStoredHeaders: async () => headers.list,
	};
}

async function boot(t, { services = {}, files = true } = {}) {
	const base = await realpath(await mkdtemp(join(tmpdir(), 'sk-startup-')));
	const dshHome = join(base, 'dsh');
	const sessionsRoot = join(dshHome, 'sessions');
	const projcacheRoot = join(dshHome, 'storages', 'session_projcache', 'sessions');
	const root = join(dshHome, 'session-kit');
	const from = join(base, 'project-a'), to = join(base, 'project-b');
	if (files) {
		await mkdir(from, { recursive: true }); await mkdir(to, { recursive: true });
		await mkdir(projcacheRoot, { recursive: true });
		const artifact = join(sessionsRoot, projectKey(from), encodeSegment(ID));
		await mkdir(artifact, { recursive: true });
		const logFile = join(artifact, 'session.v4.jsonl.zstd');
		await writeFile(logFile, sessionArtifact({ type: 'session', version: 4, id: ID, cwd: from }, ['{"seq":1,"type":"turn/start"}\n']));
		// Idle session: the churn guard refuses logs written within the last 10s.
		const idle = new Date(Date.now() - 5 * 60_000);
		const { utimes } = await import('node:fs/promises');
		await utimes(logFile, idle, idle);
		await mkdir(join(sessionsRoot, projectKey(from), encodeSegment(S2)), { recursive: true });
		await writeFile(join(projcacheRoot, `${ID}.json`), '{}');
	}
	const ctx = fakeCtx(services);
	return { base, dshHome, sessionsRoot, projcacheRoot, root, from, to, ctx,
		cleanup: async () => { await ctx.disposeAll(); await rm(base, { recursive: true, force: true }); } };
}

test('boots with zero official services and reports capabilities honestly', async t => {
	const w = await boot(t, { files: false });
	await apply(w.ctx, { configFile: w.root, dshHome: w.dshHome });
	const kit = w.ctx.get('sessionKit');
	assert.ok(kit);
	assert.equal(w.ctx.routes.registered.includes('/.well-known/dsh-session-kit'), true);
	const state = await kit.state();
	assert.deepEqual(state.capabilities, { workspaceRegistry: false, sessions: false, sessionPersistence: false, webServer: true });
	assert.equal(state.trash.length, 0);
	assert.equal(state.journal, null);
	await w.cleanup();
});

test('missing services degrade actions with visible stable errors', async t => {
	const w = await boot(t, { files: false });
	await apply(w.ctx, { configFile: w.root, dshHome: w.dshHome });
	const kit = w.ctx.get('sessionKit');
	await assert.rejects(kit.action({ type: 'trash.session', sessionId: ID }), /workspaceRegistry unavailable/);
	await assert.rejects(kit.action({ type: 'preflight', sessionId: ID, toCwd: w.to }), /no session-persistence service/);
	await w.cleanup();
});

test('a corrupt journal warns at boot instead of throwing', async t => {
	const w = await boot(t, { files: false });
	await mkdir(w.root, { recursive: true });
	await writeFile(join(w.root, 'journal.json'), '{oops');
	await apply(w.ctx, { configFile: w.root, dshHome: w.dshHome });
	const kit = w.ctx.get('sessionKit');
	assert.ok(w.ctx.log.some(([level, message]) => level === 'warn' && /journal unreadable/.test(String(message))));
	assert.ok(kit);
	await w.cleanup();
});

test('settings.update deep-merges and persists across boots', async t => {
	const w = await boot(t, { files: false });
	await apply(w.ctx, { configFile: w.root, dshHome: w.dshHome });
	const kit = w.ctx.get('sessionKit');
	await kit.updateSettings({ draftVault: { ttlDays: 3 } });
	const next = await kit.updateSettings({ trash: { autoPurge: true } });
	assert.equal(next.draftVault.ttlDays, 3);
	assert.equal(next.draftVault.enabled, true, 'defaults survive partial patches');
	assert.equal(next.trash.autoPurge, true);
	const ctx2 = fakeCtx({});
	await apply(ctx2, { configFile: w.root, dshHome: w.dshHome });
	const kit2 = ctx2.get('sessionKit');
	assert.equal((await kit2.state()).settings.trash.autoPurge, true);
	await w.cleanup();
});

test('end-to-end loopback move rewrites real files through the registered route', async t => {
	const w = await boot(t);
	const registry = fakeRegistry([{ id: ID, cwd: w.from, version: 4 }]);
	const persistence = { list: async () => [{ header: { id: ID, cwd: w.from, version: 4 }, revision: 1 }] };
	const ctx = fakeCtx({ workspaceRegistry: registry, sessions: { list: () => [] }, sessionPersistence: persistence });
	await apply(ctx, { configFile: w.root, dshHome: w.dshHome });
	const kit = ctx.get('sessionKit');
	// GET hands the snapshot + write key; POSTs need the key (loopback guards inside).
	const probe = capture();
	await ctx.routes.handler({ method: 'GET', headers: { host: '127.0.0.1:19387' }, socket: { remoteAddress: '127.0.0.1' } }, probe);
	const key = JSON.parse(probe.body).key;
	const post = async input => {
		const res = capture();
		await ctx.routes.handler({ method: 'POST', headers: { host: '127.0.0.1:19387', 'content-type': 'application/json', 'x-session-kit-key': key },
			socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(input)); } }, res);
		return { status: res.status, body: JSON.parse(res.body) };
	};
	const pre = await post({ type: 'preflight', sessionId: ID, toCwd: w.to });
	assert.equal(pre.status, 200, pre.body.error ?? '');
	assert.equal(pre.body.toProject, projectKey(w.to));
	const moved = await post({ type: 'move', sessionId: ID, toCwd: w.to });
	assert.equal(moved.status, 200);
	assert.equal(moved.body.ok, true);
	const log = await readFile(join(w.sessionsRoot, projectKey(w.to), encodeSegment(ID), 'session.v4.jsonl.zstd'));
	assert.equal(readHeader(log).header.cwd, w.to);
	// Ledger converged onto a freshly created workspace, projcache dropped, journal cleared.
	assert.deepEqual((await kit.state()).journal, null);
	const status = await post({ type: 'trash.list' });
	assert.equal(status.status, 200);
	await w.cleanup();
});

function capture() {
	return { status: 0, body: '', headers: {},
		writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers ?? {}); },
		end(text) { this.body = text; } };
}
