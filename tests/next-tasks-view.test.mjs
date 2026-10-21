import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandidateView, candidatesForTurn } from '../src/next-tasks-view.mjs';

test('suggestions belong only to their completed answer, never older footers or partial generations', () => {
 const ready = { status: 'ready', seq: 20, candidates: ['Follow up'] };
 assert.deepEqual(candidatesForTurn(ready, 20), ['Follow up']);
 assert.deepEqual(candidatesForTurn(ready, 10), []);
 assert.deepEqual(candidatesForTurn({ ...ready, status: 'generating' }, 20), []);
});

test('selection, typing and dismissal hide that turn across remount/reload while later answers can show suggestions', () => {
 const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
 const view = createCandidateView(storage), changes = [];
 const unsubscribe = view.subscribe('s', value => changes.push(value));
 const ready = { status: 'ready', seq: 20, candidates: ['Follow up'] };
 view.publish('s', ready); view.publish('s', structuredClone(ready)); assert.equal(changes.length, 1, 'unchanged polls must not rerender every message');
 view.dismiss('s'); assert.equal(view.get('s'), null);
 view.publish('s', ready); assert.equal(view.get('s'), null, 'polling cannot resurrect dismissed suggestions');
 const reload = createCandidateView(storage); reload.publish('s', ready); assert.equal(reload.get('s'), null);
 reload.publish('other', ready); assert.deepEqual(reload.get('other'), ready, 'sessions stay isolated');
 reload.publish('s', { ...ready, seq: 40 }); assert.equal(reload.get('s').seq, 40);
 unsubscribe(); view.publish('s', { ...ready, seq: 50 }); assert.equal(changes.length, 2);
});

test('disabled storage does not break presentation or in-memory dismissal', () => {
 const view = createCandidateView({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
 view.publish('s', { seq: 5, status: 'ready' }); view.dismiss('s'); view.publish('s', { seq: 5, status: 'ready' }); assert.equal(view.get('s'), null);
});

test('explicit manual generation reveals a previously dismissed turn and stays visible after remount', () => {
 const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
 const view = createCandidateView(storage), ready = { seq: 5, status: 'ready', candidates: ['继续测试'] };
 view.publish('s', ready); view.dismiss('s'); assert.equal(view.get('s'), null);
 view.reveal('s', { seq: 5, status: 'generating', manual: true }); assert.equal(view.get('s').status, 'generating');
 view.publish('s', { ...ready, manual: true }); assert.deepEqual(view.get('s').candidates, ['继续测试']);
 const reload = createCandidateView(storage); reload.publish('s', ready); assert.equal(reload.get('s').seq, 5);
});
