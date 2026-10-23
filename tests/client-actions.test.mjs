import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import pkg from '../package.json' with { type: 'json' };
import { translate } from '../src/locale.mjs';

async function client() {
	let entry;
	let values = [];
	const effects = [], updates = [], initialized = [], timers = new Map();
	let clock = 0, timerId = 0;
	const events = new Map();
	const render = (type, props) => ({ type, props });
	const native = Object.fromEntries(['MenuItemButton', 'Modal', 'Button', 'IconFolderOpenOutlineRegular', 'IconArchiveOutlineRegular'].map(name => [name, name]));
	const react = { useState: initial => { const value = values.length ? values.shift() : typeof initial === 'function' ? initial() : initial; initialized.push(value); return [value, value => updates.push(value)]; }, useRef: value => ({ current: value }), useEffect: (run, deps) => effects.push({ run, deps }), useMemo: fn => fn(), useSyncExternalStore: (_subscribe, read) => read() };
	const sandbox = vm.createContext({ console, setTimeout: (run, delay) => { const id = ++timerId; timers.set(id, { run, at: clock + delay }); return id; }, clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
		CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
		window: { __ModuleLoader__: { load: value => { entry = value; } }, dispatchEvent(event) { events.get(event.type)?.(event); }, addEventListener: (type, listener) => events.set(type, listener), removeEventListener() {} },
		fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ pluginVersion: pkg.version, key: 'k', projects: [], settings: {} }) }),
	});
	vm.runInContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox);
	const plugin = entry.factory(id => {
		if (id === 'react') return react;
		if (id === 'react-dom') return { createPortal: (children, target) => ({ type: 'Portal', props: { children, target } }) };
		if (id === 'react/jsx-runtime') return { jsx: render, jsxs: render, Fragment: 'Fragment' };
		if (id === '@deepseek-ai/dsh-client-ui-primitives') return native;
		throw new Error(id);
	});
	return { plugin, states: next => { values = next; }, native, fetch: fn => { sandbox.fetch = async (...args) => {
   const result = await fn(...args);
   if (args[1]?.method === 'POST') return result;
   return { ...result, text: async () => JSON.stringify({ pluginVersion: pkg.version, ...JSON.parse(await result.text()) }) };
  }; }, effects, updates, initialized,
		tick: ms => { clock += ms; for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.run(); } } };
}

function installManager(c, manager) {
 c.plugin.apply({ get() {}, effect: fn => fn(), locale: { register() {} }, slots: { inject() {} },
  inject(names, run) { if (names.includes('remote.pluginManager')) run({ get: () => ({ pluginManager: manager }), effect: fn => fn() }); },
 });
}

test('updated browser repairs a legacy host before sending nextTasks.generate, sharing one reload', async () => {
 const c = await client(); let version = '0.1.38', reloads = 0;
 const writes = [];
 installManager(c, {
  listBundles: async () => [{ name: 'dsh-session-toolbox', version: pkg.version, enabled: true, installed: true }],
  setBundleEnabled: async (name, enabled) => {
   assert.equal(name, 'dsh-session-toolbox'); assert.equal(enabled, true);
   reloads++; await new Promise(resolve => setImmediate(resolve)); version = pkg.version;
   return { application: 'applied' };
  },
 });
 await new Promise(resolve => setImmediate(resolve));
 c.fetch(async (_url, options) => {
  if (!options?.body) return { ok: true, status: 200, text: async () => JSON.stringify({ pluginVersion: version, key: version, projects: [] }) };
  const action = JSON.parse(options.body); writes.push(action.type);
  assert.equal(options.headers['x-session-toolbox-key'], pkg.version, 'use the rotated key from the new host');
  return { ok: version === pkg.version, status: version === pkg.version ? 200 : 400, text: async () => JSON.stringify(version === pkg.version ? { accepted: true } : { error: `操作失败：未知的操作类型：${action.type}` }) };
 });
 await c.plugin.loadState();
 assert.equal(reloads, 0, 'snapshot polling alone never reloads a plugin');
 await assert.rejects(c.plugin.callHost({type:'nextTasks.get',sessionId:'fixture'}),/版本不一致/);
 assert.equal(reloads,0,'background candidate reads must not initiate recovery');
 assert.equal(writes.length,0);
 const results = await Promise.all(Array.from({ length: 3 }, () => c.plugin.callHost({ type: 'nextTasks.generate', sessionId: 'fixture', seq: 4 })));
 assert(results.every(result => result.accepted)); assert.equal(reloads, 1);
 assert.deepEqual(writes, Array(3).fill('nextTasks.generate'));
});

test('version mismatch refuses writes when the installed bundle differs or reconciliation fails', async () => {
 for (const installedVersion of ['different', pkg.version]) {
  const c = await client(); let reloads = 0, writes = 0;
  installManager(c, { listBundles: async () => [{ name: 'dsh-session-toolbox', version: installedVersion, installed: true, enabled: true }],
   setBundleEnabled: async () => { reloads++; return { application: 'failed' }; },
  });
  await new Promise(resolve => setImmediate(resolve));
  c.fetch(async (_url, options) => { if(options?.body) writes++; return {ok:true,status:200,text:async()=>JSON.stringify({ pluginVersion:'0.1.38',key:'old' })}; });
  await c.plugin.loadState();
  await assert.rejects(c.plugin.callHost({ type: 'nextTasks.generate', sessionId: 'fixture', seq: 4 }), /版本不一致|重新加载未生效/);
  await assert.rejects(c.plugin.callHost({ type: 'nextTasks.generate', sessionId: 'fixture', seq: 4 }), /版本不一致|重新加载未生效/);
  assert.equal(writes, 0); assert.equal(reloads, installedVersion === pkg.version ? 1 : 0);
 }
});

test('a successful reconciliation must also change the running host; an unavailable manager never receives a write', async () => {
 for (const available of [false, true]) {
  const c = await client(); let writes = 0, reloads = 0;
  if (available) installManager(c, { listBundles: async () => [{ name:'dsh-session-toolbox',version:pkg.version,enabled:true,installed:true }],
   setBundleEnabled: async () => { reloads++; return {application:'applied'}; },
  });
  await new Promise(resolve => setImmediate(resolve));
  c.fetch(async (_url, options) => { if(options?.body)writes++;return {ok:true,status:200,text:async()=>JSON.stringify({pluginVersion:null,key:'legacy'})}; });
  await c.plugin.loadState();
  await assert.rejects(c.plugin.callHost({type:'nextTasks.generate',sessionId:'fixture',seq:4}), /版本不一致/);
  assert.equal(writes,0);assert.equal(reloads,available?1:0);
 }
});

test('an aligned host and a model failure never trigger a plugin reload', async () => {
 const c=await client();let reloads=0;
 installManager(c,{listBundles:async()=>{reloads++;return [];},setBundleEnabled:async()=>{reloads++;}});
 await new Promise(resolve=>setImmediate(resolve));
 c.fetch(async (_url,options)=>options?.body?{ok:false,status:400,text:async()=>JSON.stringify({error:'模型返回的候选格式无效'})}:{ok:true,status:200,text:async()=>JSON.stringify({pluginVersion:pkg.version,key:'current'})});
 await c.plugin.loadState();
 await assert.rejects(c.plugin.callHost({type:'nextTasks.generate',sessionId:'fixture',seq:4}),/候选格式无效/);
 assert.equal(reloads,0);
});

test('switching from a draft to an empty chat never dismisses the destination suggestions using the old draft', async () => {
 const c = await client();
 const inputs = Object.fromEntries(['draft', 'empty'].map(id => [id, { state: { getSnapshot: () => ({ phase: 'plain', draft: id === 'draft' ? 'unfinished question' : '', attachmentIds: [] }) } }]));
 c.plugin.apply({ sessions: { binding: id => ({ ctx: id }) }, conversation: { input: { for: id => inputs[id] } }, get() {}, effect: fn => fn(), locale: { register() {} }, slots: { inject() {} } });
 c.plugin.NextTaskController({ sessionId: 'draft' });
 const previous = c.initialized.at(-1);
 c.effects.length = 0;
 // React can reuse the component and its state before the input subscription effect runs.
 c.states([0, previous]);
 c.plugin.NextTaskController({ sessionId: 'empty' });
 const dismissal = c.effects.find(effect => effect.deps?.[0] === 'empty');
 assert.equal(dismissal.deps[1], false, 'the empty destination must not inherit the old chat editing state');
});
function find(node, predicate) {
	if (!node || typeof node !== 'object') return undefined;
	if (predicate(node)) return node;
	for (const child of [node.props?.children, node.props?.footer].flat(Infinity)) { const result = find(child, predicate); if (result) return result; }
}

test('plugin language follows the live DSH locale unless explicitly overridden, without changing DSH', async () => {
 const c = await client(); let hostLanguage = 'en', listener, language = 'auto';
 const actions = [];
 c.plugin.apply({ get() {}, effect: fn => fn(), slots: { inject() {} }, locale: {
  register() {}, getSnapshot: () => ({ active: hostLanguage }), subscribe: callback => { listener = callback; return () => {}; },
  setLocale() { assert.fail('plugin preferences must never change the DSH language'); },
 } });
 c.fetch(async (_url, options) => {
  if (options?.body) { const action = JSON.parse(options.body); actions.push(action); language = action.patch.language; }
  return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'k', settings: { language }, projects: [] }) };
 });
 await c.plugin.loadState();
 let page = c.plugin.KitPage();
 assert.equal(find(page, node => node.type === 'h2').props.children, 'Session Toolbox');
 assert.equal(find(page, node => node.type === 'select' && node.props['aria-label'] === 'Interface language').props.value, 'auto');
 hostLanguage = 'zh'; listener(); page = c.plugin.KitPage();
 assert.equal(find(page, node => node.type === 'h2').props.children, '会话工具箱');
 const selector = find(page, node => node.type === 'select' && node.props['aria-label'] === '界面语言');
 selector.props.onChange({ target: { value: 'en' } }); await new Promise(resolve => setImmediate(resolve));
 assert.equal(actions[0].type, 'settings.update'); assert.equal(actions[0].patch.language, 'en');
 page = c.plugin.KitPage(); assert.equal(find(page, node => node.type === 'h2').props.children, 'Session Toolbox');
 assert.equal(hostLanguage, 'zh');
});

test('model settings save a trimmed paired route, reset to following and reject partial routes', async () => {
 const c = await client(), actions = [], settings = { provider: 'old', model: 'large' };
 const render = draft => { c.states([draft, { providers: [], models: [], loading: false }, '']); return c.plugin.NextTaskModelSettings({ settings, act: async action => actions.push(action), readCatalog: async () => ({}), t: key => translate('en', key) }); };
 const submit = async tree => { tree.props.onSubmit({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve)); };
 await submit(render({ custom: true, provider: ' local ', model: ' small ' }));
 assert.deepEqual(JSON.parse(JSON.stringify(actions[0])), { type: 'settings.update', patch: { nextTasks: { provider: 'local', model: 'small' } } });
 await submit(render({ custom: false, provider: 'old', model: 'large' }));
 assert.equal(actions[1].patch.nextTasks.provider, ''); assert.equal(actions[1].patch.nextTasks.model, '');
 const invalid = render({ custom: true, provider: 'local', model: '' });
 assert.equal(find(invalid, node => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
 await submit(invalid); assert.equal(actions.length, 2);
 assert(c.updates.includes('Enter both a provider ID and a model ID.'));
});

test('model catalog reads are debounced, never generate suggestions and discard obsolete results', async () => {
 const c = await client(), reads = []; let release;
 c.states([{ custom: true, provider: 'local', model: '' }, { providers: [], models: [], loading: false }, '']);
 c.plugin.NextTaskModelSettings({ settings: {}, act: () => assert.fail('catalog must not save settings'), readCatalog: provider => { reads.push(provider); return new Promise(resolve => { release = resolve; }); }, t: key => translate('en', key) });
 const effect = c.effects.find(effect => effect.deps?.[0] === true);
 const cleanup = effect.run(); assert.equal(reads.length, 0); c.tick(250); assert.deepEqual(reads, ['local']);
 cleanup(); const before = c.updates.length;
 release({ providers: [], models: [{ id: 'old', name: 'Old' }] }); await new Promise(resolve => setImmediate(resolve));
 assert.equal(c.updates.length, before, 'an obsolete provider catalog must not overwrite current choices');
});

test('empty checkpoint uses an edit icon, changes keep restore, and action is checked again on click', async () => {
 const c = await client(); let latest = { action: 'edit', tracked: true };
 let draft;
 c.plugin.apply({ sessions: { binding: () => ({ session: { getSnapshot: () => ({ subagent: null, removed: false }) }, ctx: {} }) }, conversation: { input: { for: () => ({ state: { getSnapshot: () => ({ phase: 'plain', draft: '' }) }, setDraft: value => { draft = value; } }) } }, get() {}, effect: fn => fn(), locale: { register() {} }, slots: { inject() {} } });
 c.fetch(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ...latest, key: 'k' }) }));
 const render = status => { c.states([status, '', false]); return c.plugin.MessageAction({ sessionId: 's', node: { kind: 'user', anchorSeq: 9, data: { content: [{ type: 'text', text: 'original' }] } }, canWrite: true }); };
 let tree = render({ action: 'edit' });
 const button = find(tree, node => node.type === 'button'); assert.equal(button.props['aria-label'], '编辑并重新发送');
 await button.props.onClick(); await new Promise(resolve => setImmediate(resolve));
 assert.equal(draft.text, 'original');
 latest = { action: 'restore', seq: 20 };
 await button.props.onClick(); await new Promise(resolve => setImmediate(resolve));
 const overlay = c.plugin.ToolboxOverlay(); assert.equal(overlay.type, c.plugin.CheckpointDialog); assert.equal(overlay.props.request.seq, 20);
 tree = render(latest); assert.equal(find(tree, node => node.type === 'button').props['aria-label'], '恢复检查点');
 tree = render({ action: 'pending' }); assert.equal(find(tree, node => node.type === 'button').props.disabled, true);
});

test('edit loads the native composer, restores its previous semantic draft and appends candidates without sending or dropping attachments', async () => {
 const c = await client(); let draft = { text: 'draft @file', references: [{ source: 'file', offset: 6, length: 5, ref: 'f' }] }, phase = 'plain', persisted = 0, focused = 0;
 const attachments = ['screenshot'];
 const input = { state: { getSnapshot: () => ({ phase, draft: draft.text, attachmentIds: attachments }) }, get draftSnapshot() { return draft; }, setDraft: value => { draft = value; }, persistCurrentDraft: () => persisted++, focus: () => focused++ };
 c.plugin.apply({ sessions: { binding: id => { assert.equal(id, 'selected'); return { session: { getSnapshot: () => ({ subagent: null, removed: false }) }, ctx: {} }; } }, conversation: { input: { for: () => input } }, get() {}, effect: fn => fn(), locale: { register() {} }, slots: { inject() {} } });
 c.plugin.fillComposer('selected', 'original history text', true); assert.equal(draft.text, 'original history text'); assert.equal(focused, 1);
 const tree = c.plugin.EditDraftNotice({ sessionId: 'selected' });
 find(tree, node => node.type === c.native.Button).props.onClick(); assert.equal(draft.text, 'draft @file'); assert.equal(draft.references[0].source, 'file');
 c.plugin.fillComposer('selected', '', true); assert.equal(draft.text, 'draft @file', 'editing image-only history must not wipe current text');
 c.plugin.fillComposer('selected', 'next task'); assert.equal(draft.text, 'draft @file\n\nnext task'); assert.equal(draft.references[0].offset, 6); assert.deepEqual(attachments, ['screenshot']); assert.equal(persisted, 3);
 phase = 'submitting'; assert.throws(() => c.plugin.fillComposer('selected', 'blocked'), /就绪/); assert.equal(persisted, 3);
});

test('message delete waits for confirmation and host context removal before dismissing; failures remain visible', async () => {
 const c = await client(), calls = [], closed = [];
 c.plugin.apply({ sessions: { binding: () => ({ session: { getSnapshot: () => ({ removed: false, subagent: null }) } }) }, conversation: {}, get() {}, effect: fn => fn(), locale: { register() {} }, slots: { inject() {} } });
 let accepted = false;
 c.fetch(async (_url, options) => {
  if (options?.body) calls.push(JSON.parse(options.body));
  return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'k', removedFromContext: accepted, seqs: [7] }) };
 });
 c.states([false, '']); const tree = c.plugin.DeleteMessageDialog({ request: { sessionId: 'selected', seq: 7 }, close: () => closed.push(true) });
 assert.equal(calls.length, 0, 'opening the dialog must not delete');
 const button = find(tree, node => node.type === c.native.Button && node.props.children === '确认删除消息');
 assert.equal(button.props.variant, 'primary'); assert.match(button.props.style.background, /error/);
 button.props.onClick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed.length, 0); assert(c.updates.some(value => typeof value === 'string' && value.includes('尚未确认')));
 accepted = true; button.props.onClick(); button.props.onClick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed.length, 1); assert.equal(calls.length, 2);
 assert.equal(calls[1].type, 'message.delete'); assert.equal(calls[1].seq, 7);
});

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

test('concurrent message mounts share one key bootstrap and never POST with an empty authorization key', async () => {
 const c = await client(); let reads = 0, release;
 const writes = [];
 c.fetch(async (_url, options) => {
  if (!options?.body) { reads++; await new Promise(resolve => { release = resolve; }); return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'ready', projects: [] }) }; }
  writes.push(options.headers['x-session-toolbox-key']); return { ok: true, status: 200, text: async () => JSON.stringify({ seqs: [] }) };
 });
 const requests = Array.from({ length: 20 }, () => c.plugin.callHost({ type: 'message.list', sessionId: 's' }));
 assert.equal(reads, 1); release(); await Promise.all(requests); assert.equal(writes.length, 20); assert(writes.every(key => key === 'ready'));
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

test('plugin leaves the official queue entry and its handlers untouched', async () => {
 const c = await client(), registered = [], NativeQueue = () => {}, updateQueue = () => {};
 const original = { options: { name: 'conversation.input.dock', id: 'queue' }, component: NativeQueue, inject: () => ({ updateQueue }) };
 c.plugin.apply({ get() {}, effect: fn => fn(), locale: { register: () => () => {} }, sessions: {},
  slots: { entries: name => name === 'conversation.input.dock' ? [original] : [], subscribe: () => () => {},
   inject: (_name, run) => run(), register: (spec, component) => { registered.push({ spec, component }); return () => {}; } },
 });
 assert.equal(registered.some(row => ['queue', 'session-toolbox-steer'].includes(row.spec.id)), false);
 assert.equal(original.component, NativeQueue); assert.equal(original.inject().updateQueue, updateQueue);
 assert.equal(c.plugin.SteerQueueButton, undefined); assert.equal(c.plugin.NativeSteerQueue, undefined);
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


test('sidebar move feedback expires after completion, keeps busy visible and cancels old notice timers', async () => {
 const c = await client();
 const render = feedback => {
  c.effects.length = 0;
  c.states([0, null, null, {}, null, '', feedback]);
  c.plugin.GroupedSidebar({ Native() {}, useWorkspaces: fn => fn({ items: [] }), useSessions: fn => fn({ byId: {} }), useStore: fn => fn({ groupBy: 'workspace' }) });
  const effect = c.effects.find(effect => effect.deps?.[0] === feedback);
  assert.ok(effect, 'completed move feedback needs an expiry effect');
  return effect.run();
 };
 render({ busy: true, message: '' }); c.tick(10000); assert.deepEqual(c.updates, []);
 const first = render({ busy: false, message: '已切换到项目「A」' });
 c.tick(3000); assert.deepEqual(c.updates, []); first();
 const second = render({ busy: false, message: '已切换到项目「B」' });
 c.tick(1000); assert.deepEqual(c.updates, [], 'the old notice must not dismiss the new one');
 c.tick(3000); assert.deepEqual(c.updates, [null]); second();
 c.updates.length = 0;
 const failure = render({ busy: false, message: '迁移失败', error: true });
 c.tick(7999); assert.deepEqual(c.updates, []); c.tick(1); assert.deepEqual(c.updates, [null]); failure();
 c.updates.length = 0;
 const unmount = render({ busy: false, message: '完成' }); unmount(); c.tick(10000); assert.deepEqual(c.updates, []);
});

test('group manager uses shared ordering for arrows, keeps the selection, disables boundaries and prevents duplicate pending moves', async () => {
 const c = await client(), writes = [];
 let release;
 const snapshot = { key: 'ready', groups: ['a', 'b', 'c'].map(id => ({ id, title: id.toUpperCase(), workspaceIds: [] })), projects: [] };
 c.fetch(async (_url, options) => {
  if (options?.body) { writes.push(JSON.parse(options.body)); await new Promise(resolve => { release = resolve; }); }
  return { ok: true, status: 200, text: async () => JSON.stringify(snapshot) };
 });
 await c.plugin.loadState();
 c.states([0, '', '', false, '', 'b', null]);
 const tree = c.plugin.GroupsDialog({ close() {} });
 const button = label => find(tree, node => node.type === c.native.Button && node.props['aria-label'] === label);
 assert.equal(button('A — 上移').props.disabled, true);
 assert.equal(button('C — 下移').props.disabled, false);
 assert.equal(button('未分组 — 下移').props.disabled, true);
 assert.equal(button('B — 上移').props.disabled, false);
 const nav = find(tree, node => node.type === 'nav');
 assert.equal(typeof nav.props.onDragStartCapture, 'function');
 assert.equal(typeof nav.props.onDropCapture, 'function');
 assert.equal(find(tree, node => node.props?.['data-toolbox-group'] === 'ungrouped').props.draggable, true);
 const selected = find(tree, node => node.props?.className === 'sk-group-filter' && node.props['aria-pressed']);
 assert.equal(selected.props.children[0].props.children, 'B');
 button('B — 上移').props.onClick(); button('B — 下移').props.onClick();
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(writes.length, 1); assert.equal(writes[0].type, 'group.move'); assert.equal(writes[0].groupId, 'b'); assert.equal(writes[0].beforeGroupId, 'a');
 release(); await new Promise(resolve => setImmediate(resolve));
 assert.equal(c.updates.some(value => value === null), true, 'drop marker clears');
 assert.equal(c.updates.includes(''), true, 'previous error clears');
 assert.equal(c.updates.includes('b'), false, 'reordering must not change the selected filter');
 c.states([0, '', '', true, '', 'b', null]);
 const busy = c.plugin.GroupsDialog({ close() {} });
 assert.equal(find(busy, node => node.type === c.native.Button && node.props['aria-label'] === 'B — 下移').props.disabled, true);
 assert.equal(find(busy, node => node.props?.['data-toolbox-group'] === 'b').props.draggable, false);
});

test('next-task status is visible at its own answer when generating or failed, without leaking error payloads', async () => {
 const c=await client();
 for(const result of [{seq:8,status:'generating',candidates:[]},{seq:8,status:'failed',reason:'credentials',candidates:[]},{seq:8,status:'ready',candidates:[]}]){
  c.states([result,'']);const tree=c.plugin.NextTaskCandidates({sessionId:'s',seq:8});assert.ok(tree,'generation and failures must not silently disappear');
  assert.equal(find(tree,node=>node.props?.role==='status')!==undefined,true);
 }
 c.states([{seq:8,status:'failed',reason:'credentials',candidates:[]},'']);assert.equal(c.plugin.NextTaskCandidates({sessionId:'s',seq:7}),null);
});

test('manual next-task icon forwards the selected answer once, prevents rapid double clicks and disables while chat runs', async () => {
 const c = await client(), calls = []; let release;
 c.fetch(async (_url, options) => {
  if (!options?.body) return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'k' }) };
  calls.push(JSON.parse(options.body)); await new Promise(resolve => { release = resolve; });
  return { ok: true, status: 200, text: async () => JSON.stringify({ key: 'k', status: 'generating', seq: 8, manual: true }) };
 });
 c.states([null, false, '']);
 const tree = c.plugin.NextTaskAction({ sessionId: 's', seq: 8, canWrite: true, running: false });
 const button = find(tree, node => node.type === 'button');
 assert.match(button.props['aria-label'], /生成任务联想/); assert.equal(button.props.disabled, false);
 assert.equal(typeof button.props.children.type, 'function', 'action uses an icon without a text label');
 const first = button.props.onClick(), duplicate = button.props.onClick();
 while (!release) await new Promise(resolve => setImmediate(resolve));
 release(); await Promise.all([first, duplicate]);
 assert.equal(calls.length, 1); assert.equal(calls[0].type, 'nextTasks.generate'); assert.equal(calls[0].seq, 8);
 for (const props of [{ running: true, canWrite: true }, { running: false, canWrite: false }]) {
  c.states([null, false, '']); const disabled = c.plugin.NextTaskAction({ sessionId: 's', seq: 8, ...props });
  const action = find(disabled, node => node.type === 'button'); assert.equal(action.props.disabled, true); await action.props.onClick();
 }
 assert.equal(calls.length, 1);
});
