import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function client() {
	let entry;
	let values = [];
	const events = new Map();
	const render = (type, props) => ({ type, props });
	const native = Object.fromEntries(['MenuItemButton', 'Modal', 'Button', 'IconFolderOpenOutlineRegular', 'IconArchiveOutlineRegular'].map(name => [name, name]));
	const react = { useState: initial => [values.length ? values.shift() : initial, () => {}], useRef: () => ({ current: null }), useEffect: () => {}, useMemo: fn => fn() };
	const sandbox = vm.createContext({ console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
		CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
		window: { __ModuleLoader__: { load: value => { entry = value; } }, dispatchEvent(event) { events.get(event.type)?.(event); }, addEventListener: (type, listener) => events.set(type, listener), removeEventListener() {} },
		fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ key: 'k', projects: [], settings: {} }) }),
	});
	vm.runInContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox);
	const plugin = entry.factory(id => {
		if (id === 'react') return react;
		if (id === 'react-dom') return { createPortal: (children, target) => ({ type: 'Portal', props: { children, target } }) };
		if (id === 'react/jsx-runtime') return { jsx: render, jsxs: render, Fragment: 'Fragment' };
		if (id === '@deepseek-ai/dsh-client-ui-primitives') return native;
		throw new Error(id);
	});
	return { plugin, states: next => { values = next; }, native, fetch: fn => { sandbox.fetch = fn; } };
}
function find(node, predicate) {
	if (!node || typeof node !== 'object') return undefined;
	if (predicate(node)) return node;
	for (const child of [node.props?.children].flat(Infinity)) { const result = find(child, predicate); if (result) return result; }
}

test('panel preflight uses the parent action and does not reference an undefined busy setter', async () => {
	const c = await client();
	const section = find(c.plugin.KitPage(), node => node.type?.name === 'MoveSection');
	const calls = [];
	c.states(['session-example', '/target', false, null, null]);
	const tree = section.type({ ...section.props, act: async input => { calls.push(input.type); return { toProject: '--target--' }; } });
	const button = find(tree, node => node.type === 'button' && node.props.children === '体检');
	assert.doesNotThrow(() => button.props.onClick());
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(calls, ['preflight']);
});

test('session menu uses the native menu item and closes its owning menu', async () => {
	const c = await client();
	const open = [];
	const row = c.plugin.MoveSessionMenuItem({ sessionId: 'session-example', useMenuOpenState: () => [true, next => open.push(next)] });
	assert.equal(row.type, c.native.MenuItemButton);
	row.props.onSelect();
	assert.deepEqual(open, [false]);
	assert.equal(c.plugin.ToolboxOverlay().type, c.plugin.MoveDialog, 'dialog belongs to shell.overlay, outside the closing menu');
});

test('a late snapshot cannot replace the project counts read after a move', async () => {
	const c = await client();
	let finishOld;
	c.fetch(() => new Promise(resolve => { finishOld = resolve; }));
	const old = c.plugin.loadState();
	c.fetch(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ projects: [{ id: 'A', sessions: 1 }, { id: 'B', sessions: 4 }] }) }));
	await c.plugin.loadState();
	finishOld({ ok: true, status: 200, text: async () => JSON.stringify({ projects: [{ id: 'A', sessions: 2 }, { id: 'B', sessions: 3 }] }) });
	const latest = await old;
	assert.deepEqual(Array.from(latest.projects, row => row.sessions), [1, 4]);
});

test('native workspace notifications refresh the pool and project counts, and unsubscribe on unload', async () => {
	const c = await client();
	let changed, reads = 0, disposed = false;
	const disposers = [];
	c.fetch(async () => { reads++; return { ok: true, status: 200, text: async () => JSON.stringify({ projects: [], settings: {} }) }; });
	c.plugin.apply({
		get: name => name === 'workspaces' ? { list: { subscribe: fn => { changed = fn; return () => { disposed = true; }; } } } : undefined,
		effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
		locale: { register: () => () => {} }, slots: { inject() {} },
	});
	await new Promise(resolve => setImmediate(resolve));
	const before = reads;
	assert.equal(typeof changed, 'function');
	changed();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(reads, before + 1);
	for (const dispose of disposers.reverse()) await dispose();
	assert.equal(disposed, true);
});

test('manual steering sends the original durable queue item once without cancelling the turn', async () => {
 const c = await client();
 let release;
 const calls = [];
 const props = { phase: 'ready', readOnly: false, sessionId: 'session-a',
  useSession: selector => selector({ running: true, subagent: null }),
  useProjection: () => ({ 'next-turn': [{ id: 'q1', content: [{ type: 'text', text: 'continue' }] }, { id: 'q2' }] }),
  updateQueue: (...args) => { calls.push(args); return new Promise(resolve => { release = resolve; }); },
 };
 const tree = c.plugin.SteerQueueButton(props);
 const button = find(tree, node => node.type === c.native.Button);
 assert.equal(button.props.disabled, false);
 const first = button.props.onClick();
 await button.props.onClick();
 assert.equal(calls.length, 1);
 assert.equal(calls[0][0], 'q1');
 assert.equal(calls[0][1].kind, 'steer');
 release(); await first;
 assert.equal(c.plugin.SteerQueueButton({ ...props, useProjection: () => ({}) }), null);
 const idle = c.plugin.SteerQueueButton({ ...props, useSession: selector => selector({ running: false, subagent: null }) });
 assert.equal(find(idle, node => node.type === c.native.Button).props.disabled, true);
});

test('steering is disabled for disconnected/read-only/locked sessions and uses scoped public API', async () => {
 const c = await client();
 const base = { useSession: fn => fn({ running: true, subagent: null }), useProjection: () => ({ 'next-turn': [{ id: 'queued' }] }), updateQueue() {} };
 for (const change of [{ phase: 'pending' }, { readOnly: true }, { updateQueue: undefined }, { useSession: fn => fn({ running: true, subagent: { address: { mode: 'readonly' } } }) }]) {
  assert.equal(find(c.plugin.SteerQueueButton({ ...base, ...change }), node => node.type === c.native.Button).props.disabled, true);
 }
 const registered = [], calls = [];
 c.plugin.apply({ get() {}, effect: fn => fn(), locale: { register: () => () => {} },
  slots: { inject: (name, fn) => fn(), register: (spec, component) => { registered.push({ spec, component }); return () => {}; } },
  sessions: { scope: id => { calls.push(['scope', id]); return { get: name => { assert.equal(name, 'conversation'); return { updateQueue: (...args) => calls.push(args) }; } }; } },
 });
 const row = registered.find(row => row.component === c.plugin.SteerQueueButton);
 await row.spec.inject('session-scope').updateQueue('queued', { kind: 'steer' });
 assert.deepEqual(calls.map(row => row[0]), ['scope', 'queued']);
});

test('sidebar hierarchy retains all native sessions and forwards native menus and actions', async () => {
 const c = await client();
 c.fetch(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ groups: [{ id: 'g', title: 'Group', workspaceIds: ['a'] }], projects: [] }) }));
 await c.plugin.loadState();
 const workspaces = { items: [{ workspaceId: 'a', sessionIds: ['1'] }, { workspaceId: 'b', sessionIds: ['2'] }] };
 const sessions = { ids: ['1', '2'], byId: { 1: {}, 2: {} } };
 c.states([]);
 const rendered = [], open = () => {};
 function Native() {}
 const tree = c.plugin.GroupedSidebar({ Native, open, wide: true, useStore: fn => fn({groupBy:'workspace'}), useWorkspaces: fn => fn(workspaces), useSessions: fn => fn(sessions), renderSlot: (...args) => rendered.push(args) });
 const child = find(tree, node => node.type === Native);
 assert.equal(child.props.open, open);
 assert.equal(child.props.useWorkspaces(value => value.items), child.props.useWorkspaces(value => value.items), 'native effects require stable projected workspace snapshots');
 assert.deepEqual(Array.from(child.props.useSessions(value => value).ids), ['1', '2']);
 child.props.renderSlot('sidebar.workspaces.session.menu.item', { sessionId: '1' }, { hookContext: {} });
 assert.equal(rendered[0][0], 'session-toolbox.sidebar.workspaces.session.menu.item');
 assert.equal(rendered[0][1].sessionId, '1');
});


test('row steering keeps native queue handlers and localizes the visible action', async () => {
 const c=await client(); function Native() {} const updateQueue=()=>{};
 const tree=c.plugin.NativeSteerQueue({Native,updateQueue,t:key=>key,toolboxT:key=>key==='queue.rowSteer'?'引导':key});
 const native=find(tree,node=>node.type===Native);
 assert.equal(native.props.updateQueue,updateQueue);
 assert.equal(native.props.t('queue.steer'),'引导');
 assert.equal(native.props.t('queue.remove'),'queue.remove');
});
