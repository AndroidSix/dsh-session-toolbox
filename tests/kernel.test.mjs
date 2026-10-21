import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as host from '../src/index.mjs';
import { apiHandler, API_PATH } from '../src/api.mjs';

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
	const fiber = await ctx.plugin({ id: 'dsh-session-toolbox-v1-test', name: host.name, inject: host.inject, Config: host.Config, apply: (scoped, config) => host.apply(scoped, { configFile: join(dir, 'kit'), dshHome: join(dir, 'dsh') }) });
	assert.equal(routes.length, 1, 'route registered through ctx.inject([webServer])');
	const kit = ctx.get('sessionToolbox');
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
	await routes[0].handler({ method: 'POST', headers: { host: '127.0.0.1:19387', 'content-type': 'application/json', 'x-session-toolbox-key': key },
		socket: { remoteAddress: '127.0.0.1' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify({ type: 'trash.list' })); } }, posted);
	assert.deepEqual(JSON.parse(posted.body).items, []);
	// dispose: the plugin fiber's effects must tear down cleanly.
	await fiber.dispose();
	assert.equal(ctx.get('sessionToolbox'), undefined, 'service dies with the plugin fiber');
	assert.equal(routes.length, 0, 'route unregistered via the effect disposer');
	void dir;
});

function capture() {
	return { status: 0, body: '', writeHead(status) { this.status = status; }, end(text) { this.body = text; } };
}

test('host upgrade disposes legacy routes and services before starting the new dispatcher', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'sk-upgrade-')), previousHome = process.env.DSH_HOME;
 process.env.DSH_HOME = dir;
 const ctx = new Context({}); ctx.logger.level = 'silent';
 const routes = new Map();
 ctx.provide('webServer', { register(route) {
  if (routes.has(route.path)) throw new Error(`duplicate exact route ${route.path}`);
  routes.set(route.path, route); return () => routes.delete(route.path);
 } });
 ctx.provide('llm', { prepareCall() {} });
 const legacyKit = { state: async () => ({ pluginVersion: '0.1.38' }), action: async input => { throw new Error(`未知的操作类型：${input.type}`); } };
 const legacy = await ctx.plugin({ name: 'legacy-toolbox-test', apply(scope) {
  scope.effect(() => scope.get('webServer').register({ kind: 'exact', path: '/.well-known/dsh-session-toolbox', handler: apiHandler(legacyKit) }));
  scope.provide('sessionToolbox', legacyKit);
 } });
 // This is the lifecycle performed by DSH's supported bundle reconciliation.
 // Coexisting plugin generations would conflict on both route and service.
 await legacy.dispose();
 assert.equal(routes.size, 0);
 assert.equal(ctx.get('sessionToolbox'), undefined);
 const fiber = await ctx.plugin({ name: host.name, inject: host.inject, apply: scoped => host.apply(scoped, { configFile: join(dir, 'kit'), dshHome: dir }) });
 t.after(async () => { await fiber.dispose(); await legacy.dispose(); if(previousHome === undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;await rm(dir,{recursive:true,force:true}); });
 const get = capture();await routes.get(API_PATH).handler({ method: 'GET', headers: { host: '127.0.0.1:19387' } },get);
 const {key}=JSON.parse(get.body), posted=capture();
 await routes.get(API_PATH).handler({method:'POST',headers:{host:'127.0.0.1:19387','content-type':'application/json','x-session-toolbox-key':key},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({type:'nextTasks.generate',sessionId:'fixture',seq:-1}));}},posted);
 assert.equal(JSON.parse(posted.body).error,'操作失败：无效的回答轮次','upgraded action must reach the current dispatcher, not report unknown action from the old host');
 assert.equal(JSON.parse(get.body).pluginVersion, (await import('../package.json',{with:{type:'json'}})).default.version);
});
