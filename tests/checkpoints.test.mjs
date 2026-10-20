import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, stat, chmod, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import { Checkpoints, checkpointMessage, installCheckpoints } from '../src/checkpoints.mjs';
const exec = promisify(execFile);

async function setup(t, options = {}) {
 const base = await realpath(await mkdtemp(join(tmpdir(), 'sk-checkpoint-')));
 t.after(() => rm(base, { recursive: true, force: true }));
 const cwd = join(base, 'project'); await mkdir(cwd);
 const checkpoints = new Checkpoints({ root: join(base, 'kit'), ...options });
 const file = name => join(cwd, name);
 const run = (seq, next, sessionId = 'session-a') => checkpoints.run({ cwd, sessionId, seq }, next);
 const preview = seq => checkpoints.preview('session-a', seq);
 const restore = async seq => checkpoints.restore('session-a', seq, (await preview(seq)).id);
 return { base, cwd, file, checkpoints, run, preview, restore };
}

test('message action distinguishes empty, changed, restored, incomplete and still-running checkpoints', async t => {
 const f = await setup(t), status = seq => f.checkpoints.status('session-a', seq);
 assert.deepEqual(await status(1), { action: 'edit', tracked: false });
 await writeFile(f.file('a'), 'before'); await f.run(10, async () => {});
 assert.deepEqual(await status(10), { action: 'edit', tracked: true });
 await f.run(20, () => writeFile(f.file('a'), 'after'));
 assert.deepEqual(await status(10), { action: 'restore', seq: 10 });
 assert.deepEqual(await status(15), { action: 'restore', seq: 20 }, 'an earlier text-only message can restore subsequent recorded changes');
 await f.restore(10); assert.equal((await status(10)).action, 'edit');
 let finish; const running = f.run(30, () => new Promise(resolve => { finish = resolve; }));
 while (!finish) await new Promise(resolve => setImmediate(resolve));
 assert.equal((await status(30)).action, 'pending'); finish(); await running;
 assert.equal((await status(30)).action, 'edit');
 await f.checkpoints.run({ cwd: f.cwd, sessionId: 'session-a', seq: 40, unsafe: () => 'incomplete' }, async () => {});
 assert.deepEqual(await status(40), { action: 'restore', seq: 40, error: 'incomplete' });
 await assert.rejects(status(-1), /无效/);
});

test('net zero changes use edit, but interrupted restores retain the restore action', async t => {
 const f = await setup(t); await writeFile(f.file('a'), 'before');
 await f.run(1, () => writeFile(f.file('a'), 'after')); await f.run(2, () => writeFile(f.file('a'), 'before'));
 assert.equal((await f.checkpoints.status('session-a', 1)).action, 'edit');
 assert.equal((await f.checkpoints.status('session-a', 2)).action, 'restore');
 const index = await f.checkpoints.doc.read(); index.pending = { anchorId: index.records[0].id, cwd: f.cwd, ids: [], changes: [] }; await f.checkpoints.doc.write(index);
 assert.equal((await f.checkpoints.status('session-a', 1)).action, 'restore');
});

test('restore covers modified, created, deleted and binary files from this message onward; preserves unrelated files', async t => {
 const f = await setup(t);
 await writeFile(f.file('a'), 'original'); await writeFile(f.file('deleted'), 'keep'); await writeFile(f.file('binary'), Buffer.from([0, 1, 255]));
 await f.run(10, async () => { await writeFile(f.file('a'), 'one'); await writeFile(f.file('new'), 'created'); await rm(f.file('deleted')); });
 await f.run(20, async () => { await writeFile(f.file('a'), 'two'); await writeFile(f.file('binary'), Buffer.from([0, 9, 255])); });
 await writeFile(f.file('manual'), 'manual edit');
 assert.equal((await f.preview(10)).files.length, 4);
 const restarted = new Checkpoints({ root: join(f.base, 'kit') });
 const p = await restarted.preview('session-a', 10); await restarted.restore('session-a', 10, p.id);
 assert.equal(await readFile(f.file('a'), 'utf8'), 'original'); assert.equal(await readFile(f.file('deleted'), 'utf8'), 'keep');
 assert.deepEqual(await readFile(f.file('binary')), Buffer.from([0, 1, 255]));
 await assert.rejects(readFile(f.file('new')), { code: 'ENOENT' });
 assert.equal(await readFile(f.file('manual'), 'utf8'), 'manual edit');
 await assert.rejects(f.preview(20), /已经恢复/);
});

test('later checkpoint restores to the state before that message, keeping earlier changes', async t => {
 const f = await setup(t); await writeFile(f.file('a'), 'original');
 await f.run(10, () => writeFile(f.file('a'), 'first')); await f.run(20, () => writeFile(f.file('a'), 'second'));
 await f.restore(20); assert.equal(await readFile(f.file('a'), 'utf8'), 'first');
 await f.restore(10); assert.equal(await readFile(f.file('a'), 'utf8'), 'original');
});

test('manual changes to a target block the entire restore before any files are mutated', async t => {
 const f = await setup(t); await writeFile(f.file('a'), 'before'); await writeFile(f.file('b'), 'before');
 await f.run(1, async () => { await writeFile(f.file('a'), 'agent'); await writeFile(f.file('b'), 'agent'); });
 await writeFile(f.file('b'), 'manual');
 const p = await f.preview(1); assert.deepEqual(p.conflicts, ['b']);
 await assert.rejects(f.checkpoints.restore('session-a', 1, p.id), /文件已被/);
 assert.equal(await readFile(f.file('a'), 'utf8'), 'agent'); assert.equal(await readFile(f.file('b'), 'utf8'), 'manual');
});

test('manual edits between tools or messages are never silently rolled back', async t => {
 const f = await setup(t); await writeFile(f.file('a'), 'zero');
 await f.run(1, () => writeFile(f.file('a'), 'one')); await writeFile(f.file('a'), 'manual');
 await f.run(2, () => writeFile(f.file('a'), 'two'));
 await assert.rejects(f.preview(1), /外部修改/);
 await f.restore(2); assert.equal(await readFile(f.file('a'), 'utf8'), 'manual');
 await f.run(1, () => writeFile(f.file('a'), 'three')); await assert.rejects(f.preview(1), /其他来源/);
});

test('other conversations touching the same files cause a conflict', async t => {
 const f = await setup(t); await writeFile(f.file('a'), 'zero');
 await f.run(1, () => writeFile(f.file('a'), 'one'));
 await f.run(5, () => writeFile(f.file('a'), 'two'), 'session-b');
 await assert.rejects(f.preview(1), /其他会话/);
});

test('busy project and overlapping tool executions cannot be restored', async t => {
 let busy = false; const f = await setup(t, { busy: async () => busy });
 await writeFile(f.file('a'), 'before'); await f.run(1, () => writeFile(f.file('a'), 'after'));
 busy = true; await assert.rejects(f.preview(1), /仍有任务/); busy = false;
 let finish; const running = f.run(2, () => new Promise(resolve => { finish = resolve; }));
 while (!finish) await new Promise(resolve => setImmediate(resolve));
 await assert.rejects(f.preview(1), /仍有任务/);
 await f.run(3, () => writeFile(f.file('a'), 'parallel')); finish(); await running;
 await assert.rejects(f.preview(2), /并行/);
});

test('restore interruption resumes from durable blobs after a fresh engine, without overwriting external edits', async t => {
 const f = await setup(t); await writeFile(f.file('a'), 'before'); await writeFile(f.file('b'), 'before');
 await f.run(1, async () => { await writeFile(f.file('a'), 'after'); await writeFile(f.file('b'), 'after'); });
 const write = f.checkpoints.write.bind(f.checkpoints); let count = 0;
 f.checkpoints.write = async (...args) => { if (++count === 2) throw new Error('injected disk failure'); return write(...args); };
 await assert.rejects(f.restore(1), /injected/);
 const restarted = new Checkpoints({ root: join(f.base, 'kit') });
 assert.equal((await restarted.preview('session-a', 1)).pending, true);
 await assert.rejects(restarted.run({ cwd: f.cwd, sessionId: 'other', seq: 2 }, () => writeFile(f.file('b'), 'oops')), /未完成/);
 await restarted.restore('session-a', 1, (await restarted.preview('session-a', 1)).id);
 assert.equal(await readFile(f.file('a'), 'utf8'), 'before'); assert.equal(await readFile(f.file('b'), 'utf8'), 'before');
});

test('Git ignored files, excluded secrets and build output are untouched and Git index stays unchanged', async t => {
 const f = await setup(t); await exec('git', ['init', f.cwd]);
 await writeFile(f.file('.gitignore'), 'ignored\n'); await writeFile(f.file('a'), 'staged');
 await exec('git', ['-C', f.cwd, 'add', 'a', '.gitignore']);
 const index = await readFile(f.file('.git/index'));
 await writeFile(f.file('a'), 'unstaged'); await writeFile(f.file('ignored'), 'old'); await writeFile(f.file('.env'), 'old');
 await f.run(1, async () => { await writeFile(f.file('a'), 'agent'); await writeFile(f.file('ignored'), 'new'); await writeFile(f.file('.env'), 'new'); });
 await f.restore(1);
 assert.equal(await readFile(f.file('a'), 'utf8'), 'unstaged'); assert.equal(await readFile(f.file('ignored'), 'utf8'), 'new'); assert.equal(await readFile(f.file('.env'), 'utf8'), 'new');
 assert.deepEqual(await readFile(f.file('.git/index')), index);
});

test('symlink replacement of a parent refuses restore and never writes outside the original project', async t => {
 if (process.platform === 'win32') { t.skip('symlink privileges vary on Windows'); return; }
 const f = await setup(t); await mkdir(f.file('sub')); await writeFile(f.file('sub/a'), 'before');
 await f.run(1, () => writeFile(f.file('sub/a'), 'after'));
 const outside = join(f.base, 'outside'); await mkdir(outside); await writeFile(join(outside, 'a'), 'outside');
 await rm(f.file('sub'), { recursive: true }); await symlink(outside, f.file('sub'));
 await assert.rejects(f.preview(1), /符号链接/); assert.equal(await readFile(join(outside, 'a'), 'utf8'), 'outside');
});

test('corrupt backup is detected before mutation; modes are restored on supported platforms', async t => {
 const f = await setup(t); await writeFile(f.file('a'), 'before'); if (process.platform !== 'win32') await chmod(f.file('a'), 0o755);
 await f.run(1, async () => { await writeFile(f.file('a'), 'after'); if (process.platform !== 'win32') await chmod(f.file('a'), 0o644); });
 const index = await f.checkpoints.doc.read(), before = index.records[0].changes[0].before;
 const blob = join(f.base, 'kit/checkpoints/blobs', before.hash); await writeFile(blob, 'corrupt');
 await assert.rejects(f.restore(1), /数据损坏/); assert.equal(await readFile(f.file('a'), 'utf8'), 'after');
 await writeFile(blob, 'before'); await f.restore(1);
 if (process.platform !== 'win32') assert.equal((await stat(f.file('a'))).mode & 0o777, 0o755);
});

test('oversized snapshots visibly disable restoration without stopping the tool', async t => {
 const f = await setup(t, { limits: { fileBytes: 3 } }); await writeFile(f.file('a'), 'too large');
 const outcome = await f.run(1, async () => { await writeFile(f.file('b'), 'tool still runs'); return 42; });
 assert.equal(outcome, 42); await assert.rejects(f.preview(1), /大小限制/);
});

test('real Cordis hook wraps top-level tools, including failed tools, without changing the session log', async t => {
 const f = await setup(t); const ctx = new Context({}); ctx.logger.level = 'silent';
 const plugin = await ctx.plugin({ name: 'test-checkpoints', apply: scope => installCheckpoints(scope, f.checkpoints) });
 t.after(() => plugin.dispose());
 const events = [{ type: 'user/message', seq: 9, data: { source: { kind: 'user' } } }, { type: 'user/message', seq: 10, data: { source: { kind: 'runtime-context' } } }];
 const session = { id: 'session-a', header: { cwd: f.cwd }, snapshotEvents: () => events };
 assert.equal(checkpointMessage(session), 9); const original = structuredClone(events);
 await writeFile(f.file('a'), 'before');
 await assert.rejects(ctx.waterfall('tools/execute', { agent: { session } }, async () => { await writeFile(f.file('a'), 'after'); throw new Error('tool failed'); }), /tool failed/);
 assert.deepEqual(events, original); await f.restore(9); assert.equal(await readFile(f.file('a'), 'utf8'), 'before');
 await ctx.waterfall('tools/execute', { agent: { session }, parent: 'nested' }, () => Promise.resolve('nested'));
 assert.equal((await f.checkpoints.doc.read()).records.length, 1);
});

test('a new turn after preview requires previewing the changed restore plan again', async t => {
 const f = await setup(t); await writeFile(f.file('a'), 'before'); await f.run(1, () => writeFile(f.file('a'), 'after'));
 const preview = await f.preview(1); await f.run(2, () => writeFile(f.file('new'), 'unreviewed'));
 await assert.rejects(f.checkpoints.restore('session-a', 1, preview.id), /重新预览/);
 assert.equal(await readFile(f.file('a'), 'utf8'), 'after'); assert.equal(await readFile(f.file('new'), 'utf8'), 'unreviewed');
});

test('background terminal activity marks a checkpoint incomplete without breaking execution', async t => {
 const f = await setup(t); await writeFile(f.file('a'), 'before');
 await f.checkpoints.run({ cwd: f.cwd, sessionId: 'session-a', seq: 1, unsafe: () => 'background terminal' }, () => writeFile(f.file('a'), 'after'));
 await assert.rejects(f.preview(1), /background terminal/);
});

test('parallel tools in the same message share one checkpoint and restore all their changes', async t => {
 const f = await setup(t); await writeFile(f.file('a'), 'before');
 let finish; const one = f.run(1, async () => { await writeFile(f.file('a'), 'after'); await new Promise(resolve => { finish = resolve; }); });
 while (!finish) await new Promise(resolve => setImmediate(resolve));
 await f.run(1, () => writeFile(f.file('b'), 'new'));
 finish(); await one;
 assert.equal((await f.preview(1)).files.length, 2); await f.restore(1);
 assert.equal(await readFile(f.file('a'), 'utf8'), 'before'); await assert.rejects(readFile(f.file('b')), { code: 'ENOENT' });
});

test('expired snapshots are collected on capture and current snapshots remain usable', async t => {
 const f = await setup(t); await writeFile(f.file('a'), 'before'); await f.run(1, () => writeFile(f.file('a'), 'after'));
 const index = await f.checkpoints.doc.read(), old = index.records[0].changes[0].before.hash;
 index.records[0].createdAt = '2000-01-01T00:00:00.000Z'; await f.checkpoints.doc.write(index);
 await f.run(2, () => writeFile(f.file('a'), 'new'));
 await assert.rejects(f.preview(1), /没有保存/); await assert.rejects(readFile(join(f.base, 'kit/checkpoints/blobs', old)), { code: 'ENOENT' });
 await f.restore(2); assert.equal(await readFile(f.file('a'), 'utf8'), 'after');
});

test('storage failures do not mask the original tool result and disable unsafe old snapshots', async t => {
 const f = await setup(t); await writeFile(f.file('a'), 'before'); await f.run(1, () => writeFile(f.file('a'), 'after'));
 f.checkpoints.doc.write = async () => { throw new Error('disk full'); };
 assert.equal(await f.run(2, async () => { await writeFile(f.file('a'), 'unrecorded'); return 42; }), 42);
 await assert.rejects(f.preview(1), /存储不可用/);
});
