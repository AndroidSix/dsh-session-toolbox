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
function historySession() {
 const messages = [message('user', '早期问题', { id: 'u1' }), message('assistant', '早期回答', { id: 'a1' }), message('user', '未来问题，不应泄漏', { id: 'u2' }), message('assistant', '未来回答，不应泄漏', { id: 'a2' })];
 const events = [
  { seq: 1, type: 'user/message', data: messages[0] },
  { seq: 2, type: 'assistant/message', data: { turn: 1, message: messages[1] } },
  { ...end(3), data: { turn: 1, reason: { kind: 'completed' } } },
  { seq: 4, type: 'user/message', data: messages[2] },
  { seq: 5, type: 'assistant/message', data: { turn: 2, message: messages[3] } },
  { ...end(6), data: { turn: 2, reason: { kind: 'completed' } } },
 ];
 return { ...session(), deriveMessages: () => messages, snapshotEvents: () => events };
}
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

test('independent model settings are paired, bounded strings and old settings need no migration', () => {
 assert.deepEqual(guardSettings({}, 'settings').nextTasks, { enabled: true });
 assert.deepEqual(guardSettings({ nextTasks: { provider: ' local ', model: ' small ' } }, 'settings').nextTasks, { enabled: true, provider: 'local', model: 'small' });
 assert.equal(guardSettings({ nextTasks: { provider: '', model: '' } }, 'settings').nextTasks.provider, '');
 for (const nextTasks of [[], 'local', { provider: 'local' }, { model: 'small' }, { provider: 1, model: 'small' }, { provider: 'local', model: null }, { provider: 'local', model: 'x'.repeat(257) }, { provider: 'local\nsecret', model: 'small' }]) {
  assert.throws(() => guardSettings({ nextTasks }, 'settings'), /nextTasks/);
 }
});

test('independent model overrides only auxiliary calls and accounts usage to the selected route', async t => {
 const s = session(); const original = s.requestHeader();
 const { engine, calls } = await fixture(t, { settings: () => ({ nextTasks: { provider: 'local', model: 'small' } }) });
 await engine.complete(s, end(20));
 assert.equal(calls[0].provider, 'local'); assert.equal(calls[0].model, 'small');
 assert.deepEqual(s.requestHeader(), original);
 const summary = await engine.summary();
 assert.equal(summary.models[0].provider, 'local'); assert.equal(summary.models[0].model, 'small');
 assert.equal(summary.models[0].totalTokens, 325); assert.equal(summary.recent[0].customModel, true);
 s.requestHeader = () => { assert.fail('an explicit auxiliary route must not need a session model'); };
 await engine.complete(s, end(21)); assert.equal(calls.length, 2);
});

test('manual generation with auto OFF uses the same independent model', async t => {
 const s = historySession();
 const { engine, calls } = await fixture(t, { settings: () => ({ nextTasks: { enabled: false, provider: 'local', model: 'small' } }), sessions: () => ({ get: () => s }) });
 await engine.complete(s, end(3)); assert.equal(calls.length, 0);
 await engine.request('s', 3); await engine.tail;
 assert.equal(calls[0].provider, 'local'); assert.equal(calls[0].model, 'small');
});

test('independent model failures are safe, explicit and never fall back or retry', async t => {
 for (const [error, reason] of [
  [{ code: 'NO_ADAPTER' }, 'model-unavailable'], [{ status: 404 }, 'model-unavailable'],
  [{ code: 'INVALID_CREDENTIAL' }, 'credentials'], [{ code: 'RATE_LIMIT' }, 'rate-limit'],
  [{ code: 'HTTP_ERROR', failure: { status: 404 } }, 'model-unavailable'],
  [{ status: 401 }, 'credentials'], [{ status: 429 }, 'rate-limit'],
 ]) {
  const attempts = [];
  const { engine } = await fixture(t, { settings: () => ({ nextTasks: { provider: 'local', model: 'small' } }), llm: () => ({ prepareCall(config) {
   attempts.push(config); throw Object.assign(new Error('SECRET https://private.example'), error);
  } }) });
  await engine.complete(session(), end(9)); await engine.complete(session(), end(9));
  assert.equal(engine.state('s').reason, reason); assert.equal(engine.state('s').customModel, true);
  assert.equal(attempts.length, 1); assert.equal(attempts[0].provider, 'local');
  const summary = await engine.summary(); assert.equal(summary.totals.failed, 1);
  assert(!JSON.stringify(summary).includes('SECRET')); assert(!JSON.stringify(summary).includes('private.example'));
 }
});

test('changing the auxiliary route cancels in-flight work and clears old cached candidates without replay', async t => {
 let settings = { nextTasks: { provider: 'local', model: 'first' } }, started, signal;
 const { engine, calls } = await fixture(t, { settings: () => settings, stream: async function* (request) {
  signal = request.signal; started = true;
  yield { type: 'usage', usage };
  await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
 } });
 const pending = engine.complete(session(), end(8)); while (!started) await new Promise(resolve => setImmediate(resolve));
 engine.configure(); assert.equal(signal.aborted, false);
 settings = { nextTasks: { provider: 'local', model: 'second' } }; engine.configure();
 assert.equal(signal.aborted, true);
 await pending; await engine.cacheTail;
 assert.equal(signal.aborted, true); assert.equal(engine.states.size, 0);
 assert.deepEqual((await engine.cache.read()).items, []);
 assert.equal(calls.length, 1); assert.equal((await engine.summary()).totals.cancelled, 1);
});

test('cached candidates only restore under the same auxiliary route, with legacy defaults preserved', async t => {
 const nextTasks = { provider: 'local', model: 'small' };
 const { engine, root } = await fixture(t, { settings: () => ({ nextTasks }) });
 await engine.complete(session(), end(4));
 const reload = config => new NextTasks({ root, settings: () => ({ nextTasks: config }), llm: () => ({ prepareCall() { assert.fail('restoration must never call a model'); } }) });
 const same = reload(nextTasks); await same.restore(); assert.equal(same.state('s').status, 'ready'); await same.dispose();
 const different = reload({ provider: 'local', model: 'other' }); await different.restore(); assert.equal(different.state('s').status, 'idle'); await different.dispose();
});

test('auxiliary timeout is a visible failure, not a user cancellation', async t => {
 const { engine } = await fixture(t, { timeoutMs: 15, stream: async function* (request) {
  await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
 } });
 const keepAlive = setTimeout(() => {}, 1000); t.after(() => clearTimeout(keepAlive));
 await engine.complete(session(), end(1));
 assert.equal(engine.state('s').status, 'failed'); assert.equal(engine.state('s').reason, 'timeout');
 const { totals } = await engine.summary(); assert.equal(totals.failed, 1); assert.equal(totals.cancelled, 0);
});

test('a slow adapter cannot hold preparation beyond the auxiliary deadline or dispatch late', async t => {
 let release;
 const { engine } = await fixture(t, { timeoutMs: 10, llm: () => ({ prepareCall: () => new Promise(resolve => { release = () => resolve({ config: {}, stream() { assert.fail('late preparation must never dispatch'); } }); }) }) });
 const pending = engine.complete(session(), end(2));
 const fallback = setTimeout(() => release(), 250); t.after(() => clearTimeout(fallback));
 await new Promise(resolve => setTimeout(resolve, 100));
 const status = engine.state('s').status; release(); await pending;
 assert.equal(status, 'failed'); assert.equal(engine.state('s').reason, 'timeout');
});

test('structured stream failures preserve safe categories and provider usage', async t => {
 const { engine } = await fixture(t, { stream: async function* () {
  yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429, message: 'SECRET' } } };
 } });
 await engine.complete(session(), end(3));
 assert.equal(engine.state('s').reason, 'rate-limit');
 const summary = await engine.summary(); assert.equal(summary.totals.totalTokens, 325); assert(!JSON.stringify(summary).includes('SECRET'));
});

test('model catalog is read-only, strips provider metadata and gracefully supports older hosts', async t => {
 let listings = 0;
 const { engine } = await fixture(t, { llm: () => ({
  prepareCall() { assert.fail('catalog reads must never make paid calls'); },
  listProviders: () => [{ id: 'local', name: 'Local', apiKey: 'SECRET' }],
  listModels: async provider => { listings++; assert.equal(provider, 'local'); return [{ id: 'small', name: 'Small', headers: { token: 'SECRET' } }]; },
 }) });
 assert.deepEqual(await engine.catalog(), { providers: [{ id: 'local', name: 'Local' }], models: [] });
 assert.equal(listings, 0);
 assert.deepEqual(await engine.catalog('local'), { providers: [{ id: 'local', name: 'Local' }], models: [{ id: 'small', name: 'Small' }] });
 engine.llm = () => ({ prepareCall() {} });
 assert.equal((await engine.catalog()).reason, 'model-catalog');
 engine.llm = () => ({ listProviders: () => [], listModels() { throw new Error('SECRET'); } });
 const failed = await engine.catalog('local'); assert.equal(failed.reason, 'model-catalog'); assert(!JSON.stringify(failed).includes('SECRET'));
});

test('context is bounded canonical text; hidden reasoning, tools, attachments and deleted bodies never enter the request', () => {
 const s = session();
 s.deriveMessages = () => [message('user', 'DELETED ORIGINAL'), ...Array.from({ length: 15 }, (_, i) => message(i % 2 ? 'assistant' : 'user', '中'.repeat(2400))), message('user', '[Message deleted]'), message('assistant', '最后回复', { content: [{ type: 'text', text: '最后回复' }, { type: 'reasoning', text: 'SECRET' }, { type: 'tool-call', arguments: 'SECRET_TOOL' }, { type: 'image', url: 'SECRET_IMAGE' }] })];
 const text = nextTaskContext(s);
 assert(Buffer.byteLength(text) <= 12000); assert(!/SECRET|DELETED ORIGINAL|Message deleted/.test(text)); assert(JSON.parse(text).length <= 6);
 assert.equal(nextTaskContext({ deriveMessages: () => [message('assistant', 'only assistant')] }), null);
});

test('formatted model candidates remain usable instead of showing a format failure', async t => {
 const text = '以下是接下来可以做的事：\n```JSON\n["补充边界测试", "检查键盘操作"]\n```';
 const { engine, calls } = await fixture(t, { stream: async function* () {
  yield { type: 'text-delta', index: 0, text: text.slice(0, 18) };
  yield { type: 'text-delta', index: 0, text: text.slice(18) };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: 'stop' } };
 } });
 await engine.complete(session(), end(12));
 assert.equal(engine.state('s').status, 'ready', 'a valid array with a model preamble must not become reason=format');
 assert.deepEqual(engine.state('s').candidates, ['补充边界测试', '检查键盘操作']);
 assert.equal(calls.length, 1);
 const { totals } = await engine.summary();
 assert.equal(totals.completed, 1); assert.equal(totals.totalTokens, 325);
});

test('candidate parsing tolerates one JSON payload and known wrappers, preserving empty results and escaped delimiters', () => {
 const candidates = ['检查 [a] 与 {b}', '验证 "引号" 与 \\ 路径'];
 const json = JSON.stringify(candidates);
 for (const text of [json, `\uFEFF${json}`, `建议如下：${json}\n以上供选择。`, `建议：\n\`\`\`JSON\n${json}\n\`\`\`\n请选择。`, ...['candidates', 'suggestions', 'nextTasks', 'next_tasks'].map(key => JSON.stringify({ [key]: candidates }))]) {
  assert.deepEqual(parseNextTasks(text), candidates);
 }
 for (const text of ['[]', '{"suggestions":[]}', '没有合适的后续任务：\n```json\n[]\n```']) assert.deepEqual(parseNextTasks(text), []);
 assert.deepEqual(parseNextTasks('["A", " A ", "B", "C", "D"]'), ['A', 'B', 'C']);
});

test('candidate parsing rejects malformed, ambiguous and unstructured responses instead of inventing candidates', () => {
 for (const text of ['', '已完成，无需继续。', '1. 普通答复\n2. 普通答复', '["A",]', '["A"', '[{}]', '["A", 1]', '{"answer":["A"]}', '{"suggestions":["A"],"candidates":["B"]}', '{"suggestions":[{"text":"A"}]}', '建议：["A"] 或者 ["B"]', '```json\n["A"]\n```\n```json\n["B"]\n```', '```javascript\n["A"]\n```', '```json\n["A"]\n```\n["B"]', '{"broken": ["A"]', 'x'.repeat(16385)]) {
  assert.throws(() => parseNextTasks(text), { code: 'invalid-candidates' }, text.slice(0, 100));
 }
});

test('stream assembly preserves JSON across text blocks without duplicating final blocks or reading reasoning', async t => {
 const { engine } = await fixture(t, { stream: async function* () {
  yield { type: 'reasoning-delta', index: 0, text: '["not a candidate"]' };
  yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'not a candidate' } };
  yield { type: 'text-delta', index: 1, text: '建议：\n' };
  yield { type: 'block-end', index: 1, block: { type: 'text', text: '建议：\n' } };
  yield { type: 'text-delta', index: 2, text: '{"suggestions":[' };
  yield { type: 'text-delta', index: 2, text: '"补充测试"]}' };
  yield { type: 'block-end', index: 2, block: { type: 'text', text: '{"suggestions":["补充测试"]}' } };
  yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: 'stop' } };
 } });
 await engine.complete(session(), end(14));
 assert.deepEqual(engine.state('s').candidates, ['补充测试']);
});

test('a genuinely invalid model response remains a visible format failure with usage counted once and no retry', async t => {
 const { engine, calls } = await fixture(t, { stream: async function* () {
  yield { type: 'text-delta', index: 0, text: '普通回答，没有候选数据。' };
  yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: 'stop' } };
 } });
 await engine.complete(session(), end(15)); await engine.complete(session(), end(15));
 assert.equal(engine.state('s').status, 'failed'); assert.equal(engine.state('s').reason, 'format');
 assert.equal(calls.length, 1); const summary = await engine.summary();
 assert.equal(summary.totals.failed, 1); assert.equal(summary.totals.totalTokens, 325);
 assert(!JSON.stringify(summary).includes('普通回答'));
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

test('manual generation works with auto OFF, targets the selected historical answer and restores its cache without paid replay', async t => {
 const s = historySession();
 const { root, engine, calls, disable } = await fixture(t, { sessions: () => ({ get: id => id === s.id ? s : undefined }) });
 disable();
 const state = await engine.request('s', 3);
 assert.equal(state.status, 'generating'); assert.equal(state.manual, true);
 await engine.tail;
 assert.equal(engine.state('s').status, 'ready'); assert.equal(engine.state('s').seq, 3);
 assert.equal(calls.length, 1);
 const context = calls[0].messages[0].content[0].text;
 assert(context.includes('早期问题')); assert(context.includes('早期回答')); assert(!context.includes('未来'));
 const reload = new NextTasks({ root, settings: () => ({ nextTasks: { enabled: false } }), llm: () => ({ prepareCall() { assert.fail('restore must not dispatch'); } }) });
 await reload.restore(); assert.equal(reload.state('s').status, 'ready'); assert.equal(reload.state('s').manual, true); await reload.dispose();
 await engine.request('s', 3); await engine.tail;
 assert.equal(calls.length, 2, 'another explicit click may regenerate');
 assert.equal((await engine.summary()).totals.completed, 2);
});

test('manual retries count once, concurrent clicks share the job and a different answer cannot replace active generation', async t => {
 const s = historySession(); let release, attempts = 0;
 const { engine, calls } = await fixture(t, { sessions: () => ({ get: () => s }), stream: async function* () {
  if (++attempts === 1) yield { type: 'text-delta', index: 0, text: 'invalid model reply' };
  else { await new Promise(resolve => { release = resolve; }); yield { type: 'text-delta', index: 0, text: '["重新生成成功"]' }; }
  yield { type: 'usage', usage }; yield { type: 'finish', reason: { kind: 'stop' } };
 } });
 await engine.request('s', 3); await engine.tail; assert.equal(engine.state('s').reason, 'format');
 await engine.request('s', 3); while (!release) await new Promise(resolve => setImmediate(resolve));
 const duplicate = await engine.request('s', 3); assert.equal(duplicate.status, 'generating');
 await assert.rejects(() => engine.request('s', 6), /正在生成/);
 release(); await engine.tail;
 assert.equal(calls.length, 2); assert.deepEqual(engine.state('s').candidates, ['重新生成成功']);
 const { totals } = await engine.summary(); assert.equal(totals.failed, 1); assert.equal(totals.completed, 1); assert.equal(totals.totalTokens, 650);
});

test('manual generation rejects invalid, busy, subagent, aborted and deleted/compacted answers without a paid request', async t => {
 const s = historySession(); let busy = true;
 const { engine, calls } = await fixture(t, { sessions: () => ({ get: id => id === 's' ? s : undefined }), busy: () => busy });
 await assert.rejects(() => engine.request('missing', 3), /打开此会话/);
 await assert.rejects(() => engine.request('s', '3'), /无效/);
 await assert.rejects(() => engine.request('s', 3), /仍在运行/); busy = false;
 await assert.rejects(() => engine.request('s', 2), /正常结束/);
 s.header.origin = 'subagent'; await assert.rejects(() => engine.request('s', 3), /子代理/); s.header.origin = undefined;
 const events = s.snapshotEvents(); events[2].data.reason.kind = 'aborted'; await assert.rejects(() => engine.request('s', 3), /正常结束/); events[2].data.reason.kind = 'completed';
 s.deriveMessages = () => []; await assert.rejects(() => engine.request('s', 3), /已删除/);
 assert.equal(calls.length, 0);
});

test('saving unrelated settings while auto is already OFF keeps manual generation; switching auto from ON to OFF cancels it', async t => {
 const s = historySession(); let started, release, signal;
 const { engine, disable } = await fixture(t, { sessions: () => ({ get: () => s }), stream: async function* (request) {
  signal = request.signal; started = true;
  await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }); });
  yield { type: 'text-delta', index: 0, text: '["继续"]' }; yield { type: 'finish', reason: { kind: 'stop' } };
 } });
 disable(); await engine.request('s', 3); while (!started) await new Promise(resolve => setImmediate(resolve));
 engine.configure(); assert.equal(signal.aborted, false); assert.equal(engine.state('s').status, 'generating');
 engine.settings = () => ({ nextTasks: { enabled: true } }); engine.configure();
 engine.settings = () => ({ nextTasks: { enabled: false } }); engine.configure();
 assert.equal(signal.aborted, true); release(); await engine.tail;
 assert.equal((await engine.summary()).totals.cancelled, 1);
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

test('a newly installed observer generates after a completed turn takes longer than 150ms to become idle', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 let busy = true;
 const { engine, calls } = await fixture(t, { busy: () => busy });
 const observers = new Map();
 installNextTasks({ on: (name, fn) => observers.set(name, fn), effect: fn => fn() }, engine);
 observers.get('session/event')(session(), end(42));
 t.mock.timers.tick(150); await new Promise(resolve => setImmediate(resolve));
 assert.equal(calls.length, 0, 'never call the model while the host is still finalizing');
 busy = false;
 t.mock.timers.tick(300); await new Promise(resolve => setImmediate(resolve));
 await engine.tail;
 assert.equal(calls.length, 1, 'normal completion must not be silently lost during host cleanup');
 assert.equal(engine.state('s').status, 'ready');
});

test('a newer prompt or disabling cancels idle waiting, and prolonged busy state does not issue paid requests', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 let busy = true;
 const { engine, calls, disable } = await fixture(t, { busy: () => busy });
 engine.schedule(session(), end(10));
 for(let n=0;n<3;n++){t.mock.timers.tick(150);await new Promise(resolve=>setImmediate(resolve));}
 engine.invalidate('s');busy=false;t.mock.timers.tick(150);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,0);
 busy=true;engine.schedule(session(),end(12));
 for(let n=0;n<100;n++){t.mock.timers.tick(150);await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(engine.timers.size,0);assert.equal(engine.state('s').reason,'busy');assert.equal(calls.length,0);
 engine.schedule(session(),end(14));disable();busy=false;t.mock.timers.tick(1000);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,0);
});

test('provider failures disclose a safe reason without storing request text, credentials or raw errors', async t => {
 const {engine} = await fixture(t,{llm:()=>({prepareCall(){throw Object.assign(new Error('SECRET_TOKEN https://private.example/request-body'),{status:401});}})});
 await engine.complete(session(),end(10));
 assert.equal(engine.state('s').reason,'credentials');assert.equal(engine.state('s').status,'failed');
 const summary=await engine.summary();assert.equal(summary.recent[0].reason,'credentials');assert.equal(summary.totals.failed,1);assert.equal(summary.totals.unreported,0);
 assert(!JSON.stringify(summary).includes('SECRET_TOKEN'));assert(!JSON.stringify(summary).includes('private.example'));
});
