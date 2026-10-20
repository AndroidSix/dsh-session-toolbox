import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextTasks, nextTaskContext, normalizeNextTaskUsage, parseNextTasks, installNextTasks } from '../src/next-tasks.mjs';
import { guardSettings } from '../src/store.mjs';

const usage = { inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 5, outputTokens: 20, reasoningTokens: 3, totalTokens: 325 };
const message = (role, text, rest = {}) => ({ role, source: { kind: role === 'user' ? 'user' : 'model' }, content: [{ type: 'text', text }], ...rest });
function session(id = 's') { return { id, header: {}, deriveMessages: () => [message('user', '请完成测试'), message('assistant', '已完成测试')], requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }; }
const end = seq => ({ type: 'turn/end', seq, data: { reason: { kind: 'completed' } } });
async function fixture(t, options = {}) {
 const root = await mkdtemp(join(tmpdir(), 'sk-next-'));
 let enabled = true; const calls = [];
 const llm = { async prepareCall(config, signal, configure) {
  const selected = configure(config, { reasoning: { efforts: [{ id: 'none' }] } });
  return { config: selected, stream: async function* (request) {
   calls.push(request);
   if (options.stream) { yield* options.stream(request); return; }
   yield { type: 'reasoning-delta', index: 0, text: 'NEVER SHOW REASONING' };
   yield { type: 'text-delta', index: 1, text: '["补充集成测试", "检查性能"]' };
   yield { type: 'block-end', index: 1, block: { type: 'text', text: '["补充集成测试", "检查性能"]' } };
   yield { type: 'usage', usage };
   yield { type: 'finish', reason: { kind: 'stop' } };
  } };
 } };
 const engine = new NextTasks({ root, settings: () => ({ nextTasks: { enabled } }), llm: () => llm, ...options });
 t.after(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });
 return { root, engine, calls, disable: () => { enabled = false; engine.configure(); } };
}

test('next tasks defaults ON, setting is validated, candidates are bounded and parsed as text', () => {
 assert.equal(guardSettings({}, 'settings').nextTasks.enabled, true);
 assert.equal(guardSettings({ nextTasks: { enabled: false } }, 'settings').nextTasks.enabled, false);
 assert.throws(() => guardSettings({ nextTasks: { enabled: 'true' } }, 'settings'), /boolean/);
 assert.deepEqual(parseNextTasks('```json\n["A", "A", "B", "C", "D"]\n```'), ['A', 'B', 'C']);
 assert.throws(() => parseNextTasks('[{}]'));
 assert.equal(normalizeNextTaskUsage(usage).totalTokens, 325, 'cache must be included once; reasoning is part of output');
 assert.equal(normalizeNextTaskUsage({ ...usage, totalTokens: 120 }), null);
 assert.equal(normalizeNextTaskUsage({ inputTokens: 10, outputTokens: 3 }), null, 'unknown totals never become invented zero-cost usage');
});

test('context is bounded canonical text; hidden reasoning, tools, attachments and deleted bodies never enter the request', () => {
 const s = session();
 s.deriveMessages = () => [message('user', 'DELETED ORIGINAL'), ...Array.from({ length: 15 }, (_, i) => message(i % 2 ? 'assistant' : 'user', '中'.repeat(2400))), message('user', '[Message deleted]'), message('assistant', '最后回复', { content: [{ type: 'text', text: '最后回复' }, { type: 'reasoning', text: 'SECRET' }, { type: 'tool-call', arguments: 'SECRET_TOOL' }, { type: 'image', url: 'SECRET_IMAGE' }] })];
 const text = nextTaskContext(s);
 assert(Buffer.byteLength(text) <= 12000); assert(!/SECRET|DELETED ORIGINAL|Message deleted/.test(text)); assert(JSON.parse(text).length <= 6);
 assert.equal(nextTaskContext({ deriveMessages: () => [message('assistant', 'only assistant')] }), null);
});

test('completed turn generates once, uses its model, never appends chat, and persists independent usage across reload', async t => {
 const { root, engine, calls } = await fixture(t); const s = session();
 s.append = () => assert.fail('auxiliary suggestions must never append chat events');
 await engine.complete(s, end(10)); await engine.complete(s, end(10));
 assert.equal(calls.length, 1); assert.equal(calls[0].provider, 'p'); assert.equal(calls[0].maxTokens, 600); assert.equal(calls[0].reasoningEffort, 'none'); assert.equal(calls[0].purpose, 'session-toolbox-next-tasks'); assert.equal(calls[0].tools, undefined);
 assert.deepEqual(engine.state('s').candidates, ['补充集成测试', '检查性能']);
 const summary = await engine.summary(); assert.equal(summary.totals.calls, 1); assert.equal(summary.totals.completed, 1); assert.equal(summary.totals.totalTokens, 325); assert.equal(summary.models[0].cacheReadTokens, 200); assert.equal(summary.days.length, 1);
 assert(!JSON.stringify(summary).includes('已完成测试'), 'usage documents contain no chat text');
 const reload = new NextTasks({ root, settings: () => ({}), llm: () => ({ prepareCall() {} }) });
 await engine.dispose(); await reload.restore();
 assert.equal((await reload.summary()).totals.totalTokens, 325);
 assert.deepEqual(reload.state('s').candidates, ['补充集成测试', '检查性能'], 'completed candidates survive a hot update');
 await reload.complete(s, end(10)); assert.equal(calls.length, 1, 'restoration and repeated events never reissue a paid request');
 await reload.dispose();
});

test('invalidating or disabling suggestions removes persisted candidates without clearing usage', async t => {
 const { root, engine, disable } = await fixture(t);
 await engine.complete(session('a'), end(2)); await engine.complete(session('b'), end(4));
 engine.invalidate('a'); await engine.cacheTail;
 const reload = () => new NextTasks({ root, settings: () => ({}), llm: () => ({ prepareCall() { assert.fail('restoring candidates must not call the model'); } }) });
 const first = reload(); await first.restore();
 assert.equal(first.state('a').status, 'idle'); assert.equal(first.state('b').status, 'ready'); await first.dispose();
 disable(); await engine.cacheTail;
 const second = reload(); await second.restore();
 assert.equal(second.state('b').status, 'idle'); assert.equal((await second.summary()).totals.calls, 2); await second.dispose();
});

test('candidate recovery is limited to recent valid results and skips disabled settings', async t => {
 const date = new Date('2026-10-20T00:00:00Z');
 const { engine } = await fixture(t, { now: () => date });
 const row = { sessionId: 'valid', seq: 10, candidates: ['Follow up'], updatedAt: date.toISOString() };
 await engine.cache.write({ version: 1, items: [row,
  { ...row, sessionId: 'expired', updatedAt: '2026-10-12T00:00:00Z' },
  { ...row, sessionId: 'future', updatedAt: '2026-10-21T00:00:00Z' },
  { ...row, sessionId: 'invalid', candidates: [null] },
  { ...row, sessionId: 'long', candidates: ['x'.repeat(241)] },
  { ...row, sessionId: 'bad-seq', seq: -1 },
 ] });
 await engine.restore(); assert.equal(engine.state('valid').status, 'ready');
 for (const id of ['expired', 'future', 'invalid', 'long', 'bad-seq']) assert.equal(engine.state(id).status, 'idle');
 engine.states.clear(); engine.settings = () => ({ nextTasks: { enabled: false } });
 await engine.restore(); assert.equal(engine.states.size, 0);
});

test('disabled, running, subagent and aborted turns generate no auxiliary requests', async t => {
 const { engine, calls, disable } = await fixture(t, { busy: () => true });
 await engine.complete(session(), end(2)); assert.equal(calls.length, 0);
 engine.busy = () => false;
 const child = session(); child.header.origin = 'subagent'; await engine.complete(child, end(3));
 await engine.complete(session(), { seq: 4, data: { reason: { kind: 'aborted' } } });
 disable(); await engine.complete(session(), end(5)); assert.equal(calls.length, 0); assert.equal(engine.state('s').status, 'disabled');
});

test('disable aborts generation, retains provider-reported usage, and prevents stale candidates or retries', async t => {
 let started, unblock;
 const first = new Promise(resolve => { started = resolve; });
 const { engine, disable, calls } = await fixture(t, { stream: async function* (request) {
  yield { type: 'usage', usage }; started();
  await new Promise(resolve => { unblock = resolve; request.signal.addEventListener('abort', resolve, { once: true }); });
  yield { type: 'text-delta', index: 0, text: '["stale candidate"]' };
  yield { type: 'finish', reason: { kind: 'stop' } };
 } });
 const pending = engine.complete(session(), end(7)); await first; disable(); unblock(); await pending;
 assert.equal(engine.state('s').status, 'disabled'); const totals = (await engine.summary()).totals;
 assert.equal(calls.length, 1); assert.equal(totals.cancelled, 1); assert.equal(totals.totalTokens, 325);
});

test('errors/missing usage are disclosed and do not retry; queued stale sessions are cancelled', async t => {
 const { engine, calls } = await fixture(t, { stream: async function* () { yield { type: 'finish', reason: { kind: 'error' } }; } });
 await engine.complete(session(), end(1)); assert.equal(engine.state('s').status, 'failed');
 assert.equal((await engine.summary()).totals.unreported, 1); assert.equal(calls.length, 1);
 let release; engine.tail = new Promise(resolve => { release = resolve; });
 const pending = engine.complete(session('another'), end(2)); engine.invalidate('another'); release(); await pending;
 assert.equal(calls.length, 1);
});

test('event observers defer generation and cancel a scheduled old turn when new work starts', async t => {
 const { engine, calls } = await fixture(t); let observe;
 installNextTasks({ on: (name, fn) => { observe = fn; }, effect: fn => fn() }, engine);
 observe(session(), end(1)); observe(session(), { type: 'turn/start' });
 await new Promise(resolve => setTimeout(resolve, 180)); assert.equal(calls.length, 0);
});
