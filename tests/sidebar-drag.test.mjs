import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionProjectDrag } from '../src/sidebar.mjs';

function fixture(move = async () => ({ ok: true })) {
 const snapshot = { workspaces: [{ workspaceId: 'a', sessionIds: ['s'] }, { workspaceId: 'b', sessionIds: [] }],
  projects: [{ id: 'a', path: '/a', title: 'A' }, { id: 'b', path: '/b', title: 'B' }], sessions: { byId: { s: {} } }, archived: [], blocked: false };
 const row = key => ({ draggable: true, attrs: new Map([['data-row-key', key]]), getAttribute(name) { return this.attrs.get(name); },
  setAttribute(name, value) { this.attrs.set(name, value); }, removeAttribute(name) { this.attrs.delete(name); }, contains(node) { return node === this; },
  closest(selector) { return selector.includes(key.split(':')[0] + ':') ? this : null; } });
 const source = row('session:s'), a = row('workspace:a'), b = row('workspace:b');
 const data = new Map(), reports = [], calls = [];
 const transfer = { types: [], setData(key, value) { data.set(key, value); this.types = [...data.keys()]; }, getData: key => data.get(key) ?? '' };
 const event = target => ({ target, dataTransfer: transfer, prevented: false, stopped: false,
  preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
 const drag = sessionProjectDrag({ read: () => snapshot, move: async input => { calls.push(input); return move(input); }, report: value => reports.push(value) });
 return { snapshot, source, a, b, transfer, event, drag, calls, reports };
}

test('native session drag onto a project header migrates once and consumes stale native sorting', async () => {
 const f = fixture();
 f.drag.start(f.event(f.source));
 f.transfer.setData('text/plain', 's'); // native handler still owns its drag payload
 const over = f.event(f.b); f.drag.over(over);
 assert.equal(over.prevented, true); assert.equal(over.stopped, true);
 assert.equal(f.transfer.dropEffect, 'move'); assert(f.b.attrs.has('data-toolbox-session-drop'));
 await f.drag.drop(f.event(f.b));
 assert.deepEqual(f.calls, [{ type: 'move', sessionId: 's', toCwd: '/b', createTarget: false }]);
 assert.equal(f.transfer.getData('text/plain'), 's');
 assert.equal(f.b.attrs.has('data-toolbox-session-drop'), false);
 f.drag.end(); assert.equal(f.drag.suppressOrder, true, 'native dragend must not commit its last source-project marker');
 await Promise.resolve(); assert.equal(f.drag.suppressOrder, true, 'a checkpoint between capture and bubble must keep the guard');
 await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(f.drag.suppressOrder, false);
 assert.equal(f.reports.at(-1).message, '已切换到项目「B」');
});

test('same-project and non-project drops do not migrate; native session ordering remains available', async () => {
 const f = fixture(); f.drag.start(f.event(f.source));
 const same = f.event(f.a); f.drag.over(same); assert.equal(same.dataTransfer.dropEffect, 'none');
 await f.drag.drop(same); assert.equal(f.calls.length, 0);
 f.drag.end(); await Promise.resolve();
 f.drag.start(f.event(f.source));
 const sibling = f.event(f.source); f.drag.over(sibling); await f.drag.drop(sibling);
 assert.equal(sibling.prevented, false); assert.equal(sibling.stopped, false); assert.equal(f.drag.suppressOrder, false);
 f.drag.end(); await Promise.resolve();
});

test('foreign drags, blank or archived sessions, blocked migrations and removed targets cannot migrate', async () => {
 for (const change of [f => {}, f => { f.snapshot.sessions.byId.s.blank = true; }, f => { f.snapshot.archived = ['s']; }, f => { f.snapshot.blocked = true; }]) {
  const f = fixture(); change(f);
  if (f.snapshot.blocked || f.snapshot.archived.length || f.snapshot.sessions.byId.s.blank) f.drag.start(f.event(f.source));
  f.transfer.setData('text/plain', 's');
  const drop = f.event(f.b); await f.drag.drop(drop); assert.equal(f.calls.length, 0); assert.equal(drop.stopped, false);
 }
 const f = fixture(); f.drag.start(f.event(f.source)); f.drag.over(f.event(f.b));
 f.snapshot.projects = []; await f.drag.drop(f.event(f.b)); assert.equal(f.calls.length, 0);
 f.drag.dispose(); assert.equal(f.b.attrs.has('data-toolbox-session-drop'), false);
});

test('a pending move prevents duplicate drops and host refusal remains visible without mutating membership', async () => {
 let reject;
 const f = fixture(() => new Promise((resolve, fail) => { reject = fail; }));
 f.drag.start(f.event(f.source)); const first = f.drag.drop(f.event(f.b));
 await f.drag.drop(f.event(f.b)); assert.equal(f.calls.length, 1);
 reject(new Error('会话仍在运行，请等待结束')); await first;
 assert.equal(f.reports.at(-1).error, true); assert.equal(f.reports.at(-1).message, '会话仍在运行，请等待结束');
 assert.deepEqual(f.snapshot.workspaces[0].sessionIds, ['s']);
 f.drag.start(f.event(f.source)); const again = f.drag.drop(f.event(f.b));
 reject(new Error('仍在运行')); await again; assert.equal(f.calls.length, 2);
});
