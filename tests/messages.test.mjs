import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageTools } from '../src/messages.mjs';
import { messageSequence } from '../src/reply.mjs';

function setup({ type = 'user/message', content = [{ type: 'text', text: 'delete me' }], source = 'user', current = true, busy = false } = {}) {
 const message = { id: 'original', role: type === 'user/message' ? 'user' : 'assistant', source: { kind: source }, content };
 const events = [{ type, seq: 0, data: type === 'user/message' ? message : { message }, surfaceOp: 'append' }];
 let flushes = 0, fail = false;
 const session = { snapshotEvents: () => events, surface: { nodes: current ? [0] : [] }, append: (type, data, opts) => { const e = { type, seq: events.length, data, ...opts }; events.push(e); session.surface.nodes = [e.seq]; return e; }, deriveMessages: () => session.surface.nodes.includes(0) ? [message] : [] };
 const store = { get: () => session, flush: async () => { flushes++; if (fail) throw new Error('flush failed'); } };
 const tools = new MessageTools({ sessions: () => store, busy: async () => busy });
 return { tools, session, store, events, fail: value => { fail = value; }, flushes: () => flushes };
}

test('delete appends a native neutral replacement, flushes and removes only the selected original message from model input', async () => {
 const f = setup(); const result = await f.tools.delete('s', 0);
 assert.deepEqual(result, { seqs: [0], removedFromContext: true }); assert.equal(f.events[0].data.content[0].text, 'delete me', 'original log is immutable');
 assert.deepEqual(f.events[1].surfaceOp, { op: 'replace', startSeq: 0, endSeq: 0 }); assert.deepEqual(f.events[1].sourceEventSeqs, [0]);
 assert.equal(f.events[1].type, 'user/message'); assert.deepEqual(f.events[1].data.content, [{ type: 'text', text: '[Message deleted]' }]); assert.equal(f.flushes(), 1);
 await f.tools.delete('s', 0); assert.equal(f.events.length, 2, 'repeated clicks are idempotent');
 const restarted = new MessageTools({ sessions: () => f.store, busy: async () => false }); assert.deepEqual(restarted.list('s'), { seqs: [0] });
});

test('delete refuses busy sessions, tool-bearing assistant messages, injected messages and compacted history', async () => {
 for (const [options, pattern] of [[{ busy: true }, /仍在运行/], [{ type: 'assistant/message', content: [{ type: 'tool-call' }] }, /配对/], [{ source: 'runtime' }, /宿主注入/], [{ current: false }, /合并进摘要/], [{ type: 'tool/result' }, /仅支持删除/]]) {
  const f = setup(options); await assert.rejects(f.tools.delete('s', 0), pattern); assert.equal(f.events.length, 1);
 }
 const f = setup(); f.tools.idle = () => false; await assert.rejects(f.tools.delete('s', 0), /刚刚开始/); assert.equal(f.events.length, 1);
 await assert.rejects(f.tools.delete('s', -1), /无效/);
});

test('flush failure can be retried without appending another replacement', async () => {
 const f = setup(); f.fail(true); await assert.rejects(f.tools.delete('s', 0), /flush failed/); f.fail(false);
 await f.tools.delete('s', 0); assert.equal(f.events.length, 2); assert.equal(f.flushes(), 2);
});

test('assistant body and footer share the durable message identity rather than synthetic UI anchors', () => {
 assert.equal(messageSequence({ kind: 'user', anchorSeq: 9 }), 9);
 assert.equal(messageSequence({ kind: 'assistant-step', anchorSeq: 12, data: { finalNode: { seq: 99 } } }), 99);
 assert.equal(messageSequence({ kind: 'turn-tail', anchorSeq: 100.5, data: { closing: { finalNode: { seq: 99 } } } }), 99);
 assert.equal(messageSequence({ kind: 'assistant-step', anchorSeq: 12, data: {} }), undefined);
});
