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


test('native queue decoration follows late registration and unloads without replacing handlers', async () => {
 const { installQueueSteering } = await import('../src/sidebar.mjs');
 const entries=[],registered=[],effects=[];let changed;
 const ctx={effect:fn=>{effects.push(fn());},slots:{entries:()=>entries,inject:(name,fn)=>fn(),subscribe:(name,fn)=>{changed=fn;return()=>{};},register:(options,component)=>{const row={options,component,disposed:false};registered.push(row);return()=>{row.disposed=true;};}}};
 installQueueSteering(ctx, entry => function Decorated(){});
 assert.equal(registered.length,0);
 const native={options:{id:'queue',order:20},component(){},inject(){}};entries.push(native);changed();
 assert.equal(registered.length,1);assert.equal(registered[0].options.inject,native.inject);
 changed();assert.equal(registered.length,1);
 effects.forEach(dispose=>dispose?.());assert.equal(registered[0].disposed,true);
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
