import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSidebar, installSidebar } from '../src/sidebar.mjs';

test('group filtering excludes foreign sessions from native ungrouped/flat lists and preserves metadata', () => {
 const workspaces = { phase: 'ready', items: [{ workspaceId: 'a', sessionIds: ['1'] }, { workspaceId: 'b', sessionIds: ['2'] }] };
 const sessions = { phase: 'ready', ids: ['1', '2', '3'], byId: { 1: { cwd: '/a' }, 2: { cwd: '/b' }, 3: {} }, projectionsBySession: { 1: {}, 2: {}, 3: {} } };
 const groups = [{ id: 'g', workspaceIds: ['a'] }];
 assert.equal(filterSidebar(workspaces, sessions, groups, '').sessions, sessions);
 const chosen = filterSidebar(workspaces, sessions, groups, 'g');
 assert.deepEqual(chosen.workspaces.items.map(row => row.workspaceId), ['a']);
 assert.deepEqual(chosen.sessions.ids, ['1']);
 assert.deepEqual(Object.keys(chosen.sessions.byId), ['1']);
 assert.deepEqual(Object.keys(chosen.sessions.projectionsBySession), ['1']);
 assert.equal(chosen.sessions.phase, 'ready');
 const ungrouped = filterSidebar(workspaces, sessions, groups, 'ungrouped');
 assert.deepEqual(ungrouped.workspaces.items.map(row => row.workspaceId), ['b']);
 assert.deepEqual(ungrouped.sessions.ids, ['2', '3']);
 assert.deepEqual(sessions.ids, ['1', '2', '3'], 'never mutate the native snapshot');
});

test('sidebar decoration keeps the native component/store and mirrors child slots with disposal', () => {
 const native = { component() {}, options: { priority: 0 }, inject() {}, store: {}, locale: 'native', children: { 'sidebar.workspaces.session.menu.item': { kind: 'list', scope: 'root', inject: { hooks: {} } } } };
 const child = { component() {}, options: { id: 'archive', order: 1, priority: 0 }, inject() {}, locale: 'native' };
 const rows = new Map([['sidebar.workspaces', [native]], ['sidebar.workspaces.session.menu.item', [child]]]);
 const subscriptions = new Map(), registrations = [], effects = [];
 const ctx = { effect: fn => { effects.push(fn()); }, slots: {
  entries: name => rows.get(name) ?? [],
  inject: (name, fn) => fn(),
  register: (spec, component) => { const row = { spec, component, disposed: false }; registrations.push(row); return () => { row.disposed = true; }; },
  subscribe: (name, fn) => { subscriptions.set(name, fn); return () => subscriptions.delete(name); },
 } };
 const factory = received => { assert.equal(received, native); return function Decorated() {}; };
 installSidebar(ctx, factory);
 const parent = registrations[0];
 assert.equal(parent.spec.name, 'sidebar.workspaces');
 assert.ok(parent.spec.priority < 0);
 assert.equal(parent.spec.store, native.store);
 assert.equal(parent.spec.inject, native.inject);
 const [mirroredName] = Object.keys(parent.spec.children);
 assert.notEqual(mirroredName, 'sidebar.workspaces.session.menu.item');
 assert.equal(parent.spec.children[mirroredName].inject, native.children['sidebar.workspaces.session.menu.item'].inject);
 assert.equal(registrations[1].component, child.component);
 assert.equal(registrations[1].spec.name, mirroredName);
 const added = { component() {}, options: { id: 'other', priority: 0 } };
 rows.get('sidebar.workspaces.session.menu.item').push(added);
 subscriptions.get('sidebar.workspaces.session.menu.item')();
 assert.equal(registrations.at(-1).component, added.component);
 rows.set('sidebar.workspaces.session.menu.item', []);
 subscriptions.get('sidebar.workspaces.session.menu.item')();
 assert.ok(registrations.slice(1).every(row => row.disposed));
 for (const dispose of effects.reverse()) dispose?.();
 assert.equal(subscriptions.size, 0);
 assert.equal(parent.disposed, true);
});

test('group hierarchy orders actual projects once and retains unassigned projects', async () => {
 const { sidebarLayout } = await import('../src/sidebar.mjs');
 const rows = [{workspaceId:'c'},{workspaceId:'b'},{workspaceId:'a'},{workspaceId:'d'}];
 const layout = sidebarLayout(rows,[{id:'g',workspaceIds:['a','b']},{id:'h',workspaceIds:['c','a']}]);
 assert.deepEqual(layout.map(row=>[row.workspace.workspaceId,row.group]),[['b',0],['a',0],['c',1],['d',2]]);
 assert.equal(layout[0].workspace,rows[1]);
});


test('project menu keeps pointer transitions between the native anchor and portal inside one boundary', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const { protectProjectMenu } = await import('../src/sidebar.mjs');
 const listeners=new Map(),doc={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const anchor={contains:n=>n==='anchor'},menu={contains:n=>['native','toolbox'].includes(n)};
 let closed=0;
 const release=protectProjectMenu(doc,anchor,menu,()=>{closed++;});
 for(const [target,relatedTarget]of [['anchor','toolbox'],['native','toolbox'],['toolbox','native']]){
  let stopped=false;listeners.get('pointerout')({target,relatedTarget,stopPropagation:()=>{stopped=true;}});assert.equal(stopped,true);
 }
 let stopped=false;listeners.get('pointerout')({target:'native',relatedTarget:'outside',stopPropagation:()=>{stopped=true;}});assert.equal(stopped,true);
 t.mock.timers.tick(100);listeners.get('pointerover')({target:'toolbox'});t.mock.timers.tick(200);assert.equal(closed,0,'crossing the anchor gap must cancel closure on entry');
 listeners.get('pointerout')({target:'toolbox',relatedTarget:'outside',stopPropagation(){}});t.mock.timers.tick(180);assert.equal(closed,1,'leaving the whole menu still closes it');
 release();assert.equal(listeners.size,0);
});

function groupDragFixture() {
 const groups = ['a', 'b', 'c'].map(id => ({ id, workspaceIds: [] })), calls = [], previews = [], errors = [];
 const snapshot = { groups, blocked: false };
 const node = id => ({ getAttribute: () => id, getBoundingClientRect: () => ({ top: 10, height: 32 }), contains: () => false });
 const transfer = { values: {}, types: [], setData(type, value) { this.values[type] = value; this.types.push(type); }, getData(type) { return this.values[type] ?? ''; } };
 const event = (id, y = 12) => ({ target: { closest: () => id ? node(id) : null }, clientY: y, dataTransfer: transfer, prevented: false, stopped: false,
  preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
 return { snapshot, calls, previews, errors, event, transfer };
}

test('group drag saves before/after insertion only on drop and isolates native drag payloads', async () => {
 const { groupOrderDrag } = await import('../src/sidebar.mjs'), f = groupDragFixture();
 const drag = groupOrderDrag({ read: () => f.snapshot, move: async value => f.calls.push(value), preview: value => f.previews.push(value), report: value => f.errors.push(value) });
 const native = f.event(null); f.transfer.setData('application/x-dsh-toolbox-workspace', 'project');
 assert.equal(drag.start(native), false); assert.equal(drag.over(native), false); await drag.drop(native); assert.equal(native.prevented, false);
 const start = f.event('c'); assert.equal(drag.start(start), true); assert.equal(start.stopped, true);
 const before = f.event('a'); assert.equal(drag.over(before), true); assert.deepEqual(f.previews.at(-1), { groupId: 'a', edge: 'before', beforeGroupId: 'a' });
 assert.equal(f.calls.length, 0); await drag.drop(before);
 assert.deepEqual(f.calls, [{ type: 'group.move', groupId: 'c', beforeGroupId: 'a' }]);
 drag.start(f.event('a')); const after = f.event('b', 40); drag.over(after);
 assert.deepEqual(f.previews.at(-1), { groupId: 'b', edge: 'after', beforeGroupId: 'c' });
 await drag.drop(after); assert.deepEqual(f.calls.at(-1), { type: 'group.move', groupId: 'a', beforeGroupId: 'c' });
 f.snapshot.groups.push({ id: 'ungrouped', workspaceIds: [] });
 drag.start(f.event('a')); await drag.drop(f.event('ungrouped', 40)); assert.equal(f.calls.at(-1).beforeGroupId, '');
 const ungrouped = f.event('ungrouped'); drag.start(ungrouped); assert.equal(ungrouped.prevented, false); await drag.drop(f.event('a')); assert.equal(f.calls.at(-1).groupId, 'ungrouped');
});

test('group drag handles cancellation, no-op, stale/deleted groups, busy guards and keyboard ordering', async () => {
 const { groupOrderDrag } = await import('../src/sidebar.mjs'), f = groupDragFixture();
 let fail = false;
 const drag = groupOrderDrag({ read: () => f.snapshot, move: async value => { if (fail) throw Error('save failed'); f.calls.push(value); }, preview: value => f.previews.push(value), report: value => f.errors.push(value) });
 drag.start(f.event('a')); drag.over(f.event('c')); drag.end(); await drag.drop(f.event('c')); assert.equal(f.calls.length, 0); assert.equal(f.previews.at(-1), null);
 drag.start(f.event('a')); await drag.drop(f.event('a')); assert.equal(f.calls.length, 0);
 drag.start(f.event('a')); await drag.drop(f.event('b')); assert.equal(f.calls.length, 0, 'already before b');
 drag.start(f.event('c')); f.snapshot.groups = f.snapshot.groups.filter(row => row.id !== 'c'); await drag.drop(f.event('a')); assert.equal(f.calls.length, 0);
 f.snapshot.blocked = true; const blocked = f.event('a'); drag.start(blocked); assert.equal(blocked.prevented, true); await drag.step('a', 1); assert.equal(f.calls.length, 0);
 f.snapshot.blocked = false; await drag.step('a', -1); await drag.step('b', 1); assert.equal(f.calls.length, 0);
 await drag.step('a', 1); assert.deepEqual(f.calls.at(-1), { type: 'group.move', groupId: 'a', beforeGroupId: '' });
 fail = true; await drag.step('b', -1); assert.equal(f.errors.at(-1), 'save failed'); assert.equal(f.previews.at(-1), null);
});

test('reordering groups carries their projects and preserves the native order inside each group', async () => {
 const { sidebarLayout } = await import('../src/sidebar.mjs');
 const rows = ['z', 'b', 'c', 'a'].map(workspaceId => ({ workspaceId }));
 const groups = [{ id: 'one', workspaceIds: ['a', 'b'] }, { id: 'two', workspaceIds: ['c'] }];
 assert.deepEqual(sidebarLayout(rows, [...groups].reverse()).map(row => row.workspace.workspaceId), ['c', 'b', 'a', 'z']);
 assert.deepEqual(rows.map(row => row.workspaceId), ['z', 'b', 'c', 'a']);
});

test('ungrouped project projection follows the built-in group at the top, middle and bottom', async () => {
 const { sidebarLayout } = await import('../src/sidebar.mjs');
 const groups = [{id:'a',workspaceIds:['1']},{id:'b',workspaceIds:['2']}], rows=['x','2','y','1'].map(workspaceId=>({workspaceId}));
 for (const [position,expected] of [[0,['x','y','1','2']],[1,['1','x','y','2']],[2,['1','2','x','y']]]) {
  const layout=sidebarLayout(rows,groups,position);
  assert.deepEqual(layout.map(row=>row.workspace.workspaceId),expected);
  assert(layout.filter(row=>['x','y'].includes(row.workspace.workspaceId)).every(row=>row.group===position));
 }
});
