import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHandler, dispatch } from '../src/api.mjs';

function fakeRes() {
	const res = { status: 0, headers: {}, body: '' };
	res.writeHead = (status, headers) => { res.status = status; Object.assign(res.headers, headers); };
	res.end = text => { res.body = text; };
	return res;
}
function fakeReq({ method = 'GET', host = '127.0.0.1:19387', remote = '127.0.0.1', origin, key, body, contentType = 'application/json' } = {}) {
	const req = { method, headers: { host }, socket: { remoteAddress: remote } };
	if (origin !== undefined) req.headers.origin = origin;
	if (key !== undefined) req.headers['x-session-toolbox-key'] = key;
	if (contentType !== undefined) req.headers['content-type'] = contentType;
	if (body !== undefined) req[Symbol.asyncIterator] = async function* () { yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); };
	return req;
}

/** Minimal kit double: only what the handler touches. */
function kitDouble() {
	const calls = [];
	return {
		calls,
		state: async () => ({ pluginVersion: 'test', settings: {}, journal: null, trash: [], vault: { records: 0, bytes: 0 }, key: undefined }),
		action: async input => { calls.push(input); return { echo: input.type }; },
	};
}

test('manual suggestion dispatch forwards the selected turn without exposing generation through GET', async () => {
 const calls = [], kit = { nextTasks: { state: id => ({ status: 'idle', id }), request: async (id, seq) => { calls.push({ id, seq }); return { status: 'generating', seq, manual: true }; } } };
 assert.equal((await dispatch(kit, { type: 'nextTasks.get', sessionId: 's' })).status, 'idle'); assert.equal(calls.length, 0);
 const result = await dispatch(kit, { type: 'nextTasks.generate', sessionId: 's', seq: 12 });
 assert.equal(result.status, 'generating'); assert.deepEqual(calls, [{ id: 's', seq: 12 }]);
});

test('model catalog dispatch forwards the provider without generating suggestions', async () => {
 const kit = { nextTasks: { catalog: async provider => ({ provider, models: [] }), request() { assert.fail('catalog must not generate'); } } };
 assert.deepEqual(await dispatch(kit, { type: 'nextTasks.models', provider: 'local' }), { provider: 'local', models: [] });
});

test('GET serves the snapshot and the write key only to loopback', async () => {
	const kit = kitDouble();
	const handler = apiHandler(kit);
	const res = fakeRes();
	await handler(fakeReq(), res);
	assert.equal(res.status, 200);
	const body = JSON.parse(res.body);
	assert.equal(typeof body.key, 'string');
	assert.ok(body.key.length > 20);
});

test('non-loopback host, socket, cross-site origin and sec-fetch-site are refused', async () => {
	const handler = apiHandler(kitDouble());
	for (const req of [
		fakeReq({ host: 'evil.example' }),
		fakeReq({ remote: '10.0.0.5' }),
		fakeReq({ origin: 'https://evil.example' }),
		fakeReq(), (r => r)(0),
	]) {
		if (req === 0) continue;
		const res = fakeRes();
		await handler(req, res);
		if (req.headers.origin === 'https://evil.example' || req.socket.remoteAddress === '10.0.0.5' || req.headers.host === 'evil.example') assert.equal(res.status, 403);
	}
	const crossSite = fakeRes();
	await handler({ method: 'GET', headers: { host: '127.0.0.1', 'sec-fetch-site': 'cross-site' }, socket: { remoteAddress: '127.0.0.1' } }, crossSite);
	assert.equal(crossSite.status, 403);
});

test('POST requires the key, JSON, and bounded body', async () => {
	const kit = kitDouble();
	const handler = apiHandler(kit);
	const probe = fakeRes();
	await handler(fakeReq(), probe);
	const key = JSON.parse(probe.body).key;
	const noKey = fakeRes();
	await handler(fakeReq({ method: 'POST', body: { type: 'trash.list' } }), noKey);
	assert.equal(noKey.status, 401);
	const badKey = fakeRes();
	await handler(fakeReq({ method: 'POST', key: 'x'.repeat(40), body: {} }), badKey);
	assert.equal(badKey.status, 401);
	const noJson = fakeRes();
	await handler(fakeReq({ method: 'POST', key, body: 'hi', contentType: 'text/plain' }), noJson);
	assert.equal(noJson.status, 415);
	const big = fakeRes();
	await handler(fakeReq({ method: 'POST', key, contentType: 'application/json', body: 'x'.repeat(5 * 1024 * 1024) }), big);
	assert.equal(big.status, 413);
	const badJson = fakeRes();
	await handler(fakeReq({ method: 'POST', key, body: '{oops', contentType: 'application/json' }), badJson);
	assert.equal(badJson.status, 400);
	const ok = fakeRes();
	await handler(fakeReq({ method: 'POST', key, body: { type: 'trash.list' } }), ok);
	assert.equal(ok.status, 200);
	assert.deepEqual(kit.calls, [{ type: 'trash.list' }]);
});

test('business errors surface with their message and stay on 500/400 channel', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'sk-api-'));
	const kit = { state: async () => ({}), action: async () => { throw new Error('会话正忙'); } };
	const handler = apiHandler(kit);
	const probe = fakeRes();
	await handler(fakeReq(), probe);
	const key = JSON.parse(probe.body).key;
	const res = fakeRes();
	await handler(fakeReq({ method: 'POST', key, body: { type: 'move' } }), res);
	assert.equal(res.status, 500);
	assert.match(JSON.parse(res.body).error, /会话正忙/);
	await rm(dir, { recursive: true, force: true });
});

test('dispatch routes the whole command vocabulary', async () => {
	const log = [];
	const kit = {
		move: { preflight: async input => { log.push(['preflight', input]); return { plan: true }; }, move: async plan => { log.push(['move', plan]); return { ok: true }; }, rollback: async () => ({ rolled: 1 }), complete: async () => ({ completed: 1 }) },
		trash: { items: async () => [1], trashSession: async (id, opts) => ({ id, opts }), trashWorkspace: async (id, opts) => ({ id, opts }), restore: async itemId => ({ itemId }), purge: async itemId => ({ itemId }), sweep: async () => ({ expired: [] }) },
		updateSettings: async patch => patch,
		manifest: { update: fn => fn({ version: 1, records: [{ sessionId: 's', attachmentId: 'a', createdAt: Date.now() }] }) },
		settings: { read: async () => ({ draftVault: { ttlDays: 7 } }) },
	};
	assert.deepEqual(await dispatch(kit, { type: 'preflight', sessionId: 's', toCwd: '/t' }), { plan: true });
	assert.deepEqual(await dispatch(kit, { type: 'move', sessionId: 's', toCwd: '/t' }), { ok: true });
	assert.deepEqual(await dispatch(kit, { type: 'move.rollback' }), { rolled: 1 });
	assert.deepEqual(await dispatch(kit, { type: 'trash.list' }), { items: [1] });
	assert.deepEqual(await dispatch(kit, { type: 'trash.session', sessionId: 's' }), { id: 's', opts: { force: false } });
	assert.deepEqual(await dispatch(kit, { type: 'trash.restore', itemId: 'i' }), { itemId: 'i' });
	assert.deepEqual(await dispatch(kit, { type: 'settings.update', patch: { a: 1 } }), { settings: { a: 1 } });
	const swept = await dispatch(kit, { type: 'vault.sweep' });
	assert.equal(swept.records, 1);
	await assert.rejects(dispatch(kit, { type: 'nonsense' }), /未知/);
});

test('loopback host parsing accepts IPv6 and rejects loopback-looking public names', async () => {
	const handler = apiHandler({ state: async () => ({ ready: true }) });
	for (const host of ['[::1]:19387', 'localhost:19387', '127.0.0.1:19387']) {
		const req = fakeReq(); req.headers.host = host;
		const res = fakeRes(); await handler(req, res);
		assert.equal(res.status, 200, host);
	}
	for (const host of ['', '127.evil.example:19387', '127.0.0.1.evil.example:19387']) {
		const req = fakeReq(); req.headers.host = host;
		const res = fakeRes(); await handler(req, res);
		assert.equal(res.status, 403, host);
	}
});

test('workspace and group operations route through the shared host dispatch', async () => {
 const calls = [];
 const kit = { workspace: Object.fromEntries(['createGroup', 'renameGroup', 'deleteGroup', 'assignGroup', 'edit', 'complete'].map(name => [name, async (...args) => { calls.push([name, ...args]); return { ok: true }; }])) };
 for (const input of [
  { type: 'group.create', title: 'Work' }, { type: 'group.rename', groupId: 'g', title: 'Team' },
  { type: 'group.delete', groupId: 'g' }, { type: 'group.assign', workspaceId: 'w', groupId: 'g' },
  { type: 'workspace.edit', workspaceId: 'w', path: '/new', title: 'New' }, { type: 'workspace.complete' },
 ]) assert.equal((await dispatch(kit, input)).ok, true);
 assert.deepEqual(calls.map(row => row[0]), ['createGroup', 'renameGroup', 'deleteGroup', 'assignGroup', 'edit', 'complete']);
 assert.deepEqual(calls[4][1], { workspaceId: 'w', path: '/new', title: 'New' });
});
