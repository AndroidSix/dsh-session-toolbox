import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as host from '../src/index.mjs';

/**
 * Boots the plugin inside a REAL cordis kernel (no fakes for the lifecycle):
 * proves the export shape, effect discipline, inject/provide timing, and the
 * loopback route end to end against genuine context plumbing.
 */
test('real cordis kernel: plugin boots, registers the route, serves state', async t => {
	const dir = await mkdtemp(join(tmpdir(), 'sk-kernel-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const ctx = new Context({});
	ctx.logger.level = 'silent';
	// The host app always provides webServer; emulate the seam cordis resolves.
	const routes = [];
	ctx.provide('webServer', {
		register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); }; },
	});
	const fiber = await ctx.plugin({ id: 'dsh-session-kit-v1-test', name: host.name, inject: host.inject, Config: host.Config, apply: (scoped, config) => host.apply(scoped, config) });
	assert.equal(routes.length, 1, 'route registered through ctx.inject([webServer])');
	const kit = ctx.get('sessionKit');
	assert.ok(kit, 'kit service provided');
	const res = capture();
	await routes[0].handler({ method: 'GET', headers: { host: '127.0.0.1:19387' }, socket: { remoteAddress: '127.0.0.1' } }, res);
	assert.equal(res.status, 200);
	const state = JSON.parse(res.body);
	assert.equal(typeof state.key, 'string');
	assert.equal(state.capabilities.workspaceRegistry, false);
	// A POST through the real kernel plumbing must dispatch to a real action.
	const key = state.key;
	const posted = capture();
	await routes[0].handler({ method: 'POST', headers: { host: '127.0.0.1:19387', 'content-type': 'application/json', 'x-session-kit-key': key },
		socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ type: 'trash.list' })); } }, posted);
	assert.deepEqual(JSON.parse(posted.body).items, []);
	// dispose: the plugin fiber's effects must tear down cleanly.
	await fiber.dispose();
	assert.equal(ctx.get('sessionKit'), undefined, 'service dies with the plugin fiber');
	assert.equal(routes.length, 0, 'route unregistered via the effect disposer');
	void dir;
});

function capture() {
	return { status: 0, body: '', writeHead(status) { this.status = status; }, end(text) { this.body = text; } };
}
