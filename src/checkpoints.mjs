/** Local, Git-independent file history around awaited agent tool executions. */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, chmod } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { JsonDocument } from './store.mjs';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const excluded = name => /^(?:\.git|\.hg|\.svn|node_modules|\.DS_Store|\.dsh|\.ssh|\.aws|\.env(?:\..*)?|dist|build|coverage|\.next|\.cache|__pycache__|\.venv)$/.test(name);
const same = (a, b) => (a?.hash ?? null) === (b?.hash ?? null) && (a?.mode ?? null) === (b?.mode ?? null);
const failure = message => new Error(message);
const inside = (root, file) => { const rel = relative(root, file); return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
const planId = plan => hash(JSON.stringify({ anchor: plan.anchor.id, ids: plan.pending?.ids ?? plan.rows.map(row => row.id), changes: plan.changes }));

export function checkpointMessage(session) {
 return session?.snapshotEvents?.().findLast(event => event.type === 'user/message' && event.data?.source?.kind === 'user')?.seq;
}

export class Checkpoints {
 constructor({ root, busy = async () => false, limits = {} }) {
  this.root = join(root, 'checkpoints');
  this.doc = new JsonDocument(this.root, 'index.json', { version: 1, records: [], pending: null });
  this.busy = busy;
  this.limits = { files: 10000, fileBytes: 8 * 1024 * 1024, snapshotBytes: 64 * 1024 * 1024, storageBytes: 256 * 1024 * 1024, ...limits };
  this.active = new Set(); this.tail = Promise.resolve(); this.disposed = false;
 }
 serial(fn) { const result = this.tail.then(fn); this.tail = result.catch(() => {}); return result; }
 async prune(index) {
  if (index.pending) return;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const active = row => [...this.active].some(token => token.sessionId === row.sessionId && token.seq === row.seq);
  const kept = index.records.filter(row => active(row) || Date.parse(row.createdAt) >= cutoff);
  const excess = Math.max(0, kept.length - 100);
  let removed = 0;
  const records = kept.filter(row => {
   if (active(row) || removed >= excess) return true;
   removed++; return false;
  });
  if (records.length === index.records.length) return;
  index.records = records; await this.doc.write(index);
  const references = new Set(records.flatMap(row => row.changes.flatMap(change => [change.before?.hash, change.after?.hash])).filter(Boolean));
  const dir = join(this.root, 'blobs');
  for (const name of await readdir(dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) if (/^[a-f0-9]{64}$/.test(name) && !references.has(name)) await rm(join(dir, name));
 }
 async path(cwd, path) {
  if (typeof path !== 'string' || !inside(cwd, resolve(cwd, path)) || path.split(/[\\/]/).some(excluded)) throw failure('检查点包含不支持的文件路径');
  const file = resolve(cwd, path);
  let parent = dirname(file);
  while (parent !== cwd) {
   try { if (await realpath(parent) !== parent) throw failure('检查点路径经过符号链接，无法安全恢复'); break; }
   catch (error) { if (error.code !== 'ENOENT') throw error; parent = dirname(parent); }
  }
  return file;
 }
 async file(cwd, path) {
  const file = await this.path(cwd, path);
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.nlink > 1) throw failure(`不支持符号链接、目录或硬链接：${path}`);
  if (info.size > this.limits.fileBytes) throw failure(`文件超过检查点大小限制：${path}`);
  const bytes = await readFile(file);
  if (bytes.length > this.limits.fileBytes) throw failure(`文件超过检查点大小限制：${path}`);
  return { hash: hash(bytes), mode: info.mode & 0o777, bytes };
 }
 async snapshot(cwd) {
  let paths;
  try {
   paths = (await exec('git', ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'], { maxBuffer: 4 * 1024 * 1024 })).stdout.split('\0').filter(Boolean);
  } catch (error) {
   if (error.code !== 'ENOENT' && error.code !== 128) throw error;
   paths = [];
   const walk = async dir => {
    for (const entry of await readdir(join(cwd, dir), { withFileTypes: true })) {
     if (excluded(entry.name)) continue;
     const path = dir ? join(dir, entry.name) : entry.name;
     if (entry.isDirectory()) await walk(path);
     else paths.push(path);
     if (paths.length > this.limits.files) throw failure('项目文件太多，无法完整建立检查点');
    }
   };
   await walk('');
  }
  paths = [...new Set(paths)].filter(path => !path.split(/[\\/]/).some(excluded));
  if (paths.length > this.limits.files) throw failure('项目文件太多，无法完整建立检查点');
  const result = new Map(); let size = 0;
  for (const path of paths) {
   const file = await this.file(cwd, path);
   if (file) { size += file.bytes.length; if (size > this.limits.snapshotBytes) throw failure('项目超过检查点总大小限制'); result.set(path, file); }
  }
  return result;
 }
 async blobs(files) {
  const dir = join(this.root, 'blobs'); await mkdir(dir, { recursive: true, mode: 0o700 });
  let size = 0; const names = new Set(await readdir(dir));
  for (const name of names) size += (await lstat(join(dir, name))).size;
  for (const file of files) {
   if (!file || names.has(file.hash)) continue;
   if (size + file.bytes.length > this.limits.storageBytes) throw failure('检查点存储已达到 256 MiB 上限；本轮无法保证完整恢复');
   const handle = await open(join(dir, file.hash), 'wx', 0o600);
   try { await handle.writeFile(file.bytes); await handle.sync(); } finally { await handle.close(); }
   names.add(file.hash); size += file.bytes.length;
  }
 }
 async record(token, before, after, reason) {
  const index = await this.doc.read();
  let row = index.records.find(row => row.sessionId === token.sessionId && row.seq === token.seq);
  if (!row) { row = { id: randomUUID(), sessionId: token.sessionId, seq: token.seq, cwd: token.cwd, createdAt: new Date().toISOString(), changes: [], restored: false }; index.records.push(row); }
  if (row.restored) return;
  if (row.cwd !== token.cwd) reason = '该消息执行中更换了工作目录，无法完整恢复';
  if (token.overlap) reason = '同一项目存在并行工具调用，无法准确区分修改归属';
  if (reason) row.error = reason;
  if (before && after && !row.error) {
   const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => !same(before.get(path), after.get(path)));
   await this.blobs(changed.flatMap(path => [before.get(path), after.get(path)]));
   const reference = value => value ? { hash: value.hash, mode: value.mode } : null;
   for (const path of changed) {
    const previous = row.changes.find(change => change.path === path);
    if (previous) {
     if (!same(previous.after, before.get(path))) { row.error = '本轮修改期间文件被其他来源改动，无法安全恢复'; break; }
     previous.after = reference(after.get(path));
    } else row.changes.push({ path, before: reference(before.get(path)), after: reference(after.get(path)) });
   }
  }
  await this.doc.write(index);
  await this.prune(index);
 }
 async run({ sessionId, seq, cwd, unsafe }, next) {
  if (this.disposed || this.fault || !Number.isSafeInteger(seq) || !isAbsolute(cwd ?? '')) return next();
  try { cwd = await realpath(cwd); } catch { return next(); }
  if (cwd === resolve(cwd, '..') || cwd === homedir() || cwd === this.root || inside(cwd, this.root)) return next();
  const token = { sessionId, seq, cwd, overlap: false };
  let group;
  try { await this.serial(async () => {
   const index = await this.doc.read();
   if (index.pending && (index.pending.cwd === cwd || inside(cwd, index.pending.cwd) || inside(index.pending.cwd, cwd))) throw Object.assign(failure('项目有未完成的检查点恢复，请先在原消息处重试恢复'), { code: 'checkpoint-pending' });
   await this.prune(index);
   const sibling = [...this.active].find(other => other.cwd === cwd && other.sessionId === sessionId && other.seq === seq);
   group = sibling?.group ?? { count: 0, before: undefined, error: undefined, overlap: false };
   token.group = group; group.count++;
   for (const other of this.active) if (other.group !== group && (other.cwd === cwd || inside(cwd, other.cwd) || inside(other.cwd, cwd))) { other.group.overlap = true; group.overlap = true; }
   this.active.add(token);
   if (!sibling) { try { group.before = await this.snapshot(cwd); } catch (error) { group.error = error.message; } }
  }); } catch (error) {
   this.active.delete(token);
   if (error.code === 'checkpoint-pending') throw error;
   this.fault = error.message;
   return next();
  }
  try { return await next(); }
  finally {
   await this.serial(async () => {
    try {
     let after;
     group.error ||= await unsafe?.();
     if (--group.count > 0) return;
     token.overlap = group.overlap;
     if (!group.error) { try { after = await this.snapshot(cwd); } catch (error) { group.error = error.message; } }
     await this.record(token, group.before, after, group.error);
    } catch (error) {
     // A failed postimage must never leave an older, apparently restorable row.
     try { await this.record(token, null, null, error.message); } catch (storageError) { this.fault = storageError.message; }
    } finally { this.active.delete(token); }
   });
  }
 }
 /** Cheap action discovery: never mistake an incomplete snapshot for an empty one. */
 async status(sessionId, seq) {
  return this.serial(async () => {
   if (typeof sessionId !== 'string' || !Number.isSafeInteger(seq) || seq < 0) throw failure('无效的消息检查点');
   if (this.fault) return { action: 'restore', error: `检查点存储不可用：${this.fault}` };
   const index = await this.doc.read();
   if (index.pending) return { action: 'restore', seq, pending: true };
   if ([...this.active].some(token => token.sessionId === sessionId && token.seq >= seq)) return { action: 'pending' };
   const rows = index.records.filter(row => row.sessionId === sessionId && row.seq >= seq && !row.restored).sort((a,b) => a.seq - b.seq);
   if (!rows.length) return { action: 'edit', tracked: false };
   const invalid = rows.find(row => row.error);
   if (invalid) return { action: 'restore', seq: rows[0].seq, error: invalid.error };
   const combined = new Map();
   for (const row of rows) for (const change of row.changes) {
    const previous = combined.get(change.path);
    if (previous && !same(previous.after, change.before)) return { action: 'restore', seq: rows[0].seq };
    combined.set(change.path, { before: previous ? previous.before : change.before, after: change.after });
   }
   return [...combined.values()].some(change => !same(change.before, change.after)) ? { action: 'restore', seq: rows[0].seq } : { action: 'edit', tracked: true };
  });
 }
 async plan(sessionId, seq) {
  if (this.fault) throw failure(`检查点存储不可用，已暂停自动快照：${this.fault}`);
  if (typeof sessionId !== 'string' || !Number.isSafeInteger(seq) || seq < 0) throw failure('无效的消息检查点');
  const index = await this.doc.read();
  const anchor = index.records.find(row => row.sessionId === sessionId && row.seq === seq);
  if (!anchor) throw failure('这条消息没有保存文件检查点；仅支持启用功能后执行过工具的消息');
  if (index.pending) {
   if (index.pending.anchorId !== anchor.id) throw failure('请先重试并完成上一次检查点恢复');
   return { index, anchor, pending: index.pending, rows: [], changes: index.pending.changes };
  }
  if (anchor.restored) throw failure('这条消息的修改已经恢复');
  const rows = index.records.filter(row => row.sessionId === sessionId && row.seq >= seq && !row.restored).sort((a,b) => a.seq - b.seq);
  if (rows.some(row => row.cwd !== anchor.cwd)) throw failure('后续消息已更换项目路径，无法跨目录恢复');
  const invalid = rows.find(row => row.error); if (invalid) throw failure(invalid.error);
  const combined = new Map();
  for (const row of rows) for (const change of row.changes) {
   const previous = combined.get(change.path);
   if (previous && !same(previous.after, change.before)) throw failure(`消息之间存在外部修改：${change.path}`);
   combined.set(change.path, { path: change.path, before: previous ? previous.before : change.before, after: change.after });
  }
  const changes = [...combined.values()].filter(change => !same(change.before, change.after));
  // A different conversation touching a target after the anchor is also a conflict,
  // even if it happened to write identical bytes.
  for (const row of index.records) if (row.sessionId !== sessionId && !row.restored && row.cwd === anchor.cwd && row.createdAt >= anchor.createdAt && row.changes.some(change => combined.has(change.path))) throw failure('其他会话也修改过这些文件，请先处理冲突');
  return { index, anchor, rows, changes };
 }
 async assertIdle(cwd) {
  if ([...this.active].some(token => token.cwd === cwd || inside(cwd, token.cwd) || inside(token.cwd, cwd)) || await this.busy(cwd)) throw failure('项目仍有任务或终端运行，请等待结束后恢复检查点');
  if (await realpath(cwd) !== cwd) throw failure('项目路径已经改变，无法恢复检查点');
 }
 async preview(sessionId, seq) {
  return this.serial(async () => {
   const plan = await this.plan(sessionId, seq); await this.assertIdle(plan.anchor.cwd);
   const files = [], conflicts = [];
   for (const change of plan.changes) {
    const current = await this.file(plan.anchor.cwd, change.path);
    if (!same(current, change.after) && !(plan.pending && same(current, change.before))) conflicts.push(change.path);
    files.push({ path: change.path, action: change.before ? change.after ? 'modify' : 'restore' : 'delete' });
   }
   return { id: planId(plan), files, conflicts, pending: Boolean(plan.pending) };
  });
 }
 async write(cwd, change) {
  const file = await this.path(cwd, change.path);
  if (change.before === null) { await rm(file); return; }
  if (!/^[a-f0-9]{64}$/.test(change.before.hash)) throw failure('检查点文件索引损坏');
  const bytes = await readFile(join(this.root, 'blobs', change.before.hash));
  if (hash(bytes) !== change.before.hash) throw failure('检查点文件数据校验失败');
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.dsh-restore-${randomUUID()}`);
  try {
   const handle = await open(temporary, 'wx', 0o600);
   try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
   await chmod(temporary, change.before.mode);
   await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
 }
 async restore(sessionId, seq, id) {
  return this.serial(async () => {
   const plan = await this.plan(sessionId, seq), cwd = plan.anchor.cwd;
   if (planId(plan) !== id) throw failure('检查点已改变，请重新预览');
   await this.assertIdle(cwd);
   // Validate every target and every backup before the first mutation.
   for (const change of plan.changes) {
    const current = await this.file(cwd, change.path);
    if (!same(current, change.after) && !(plan.pending && same(current, change.before))) throw failure(`文件已被手动或其他任务修改：${change.path}`);
    for (const ref of [change.before, change.after]) if (ref) {
     if (!/^[a-f0-9]{64}$/.test(ref.hash) || hash(await readFile(join(this.root, 'blobs', ref.hash))) !== ref.hash) throw failure('检查点文件数据损坏，未恢复任何文件');
    }
   }
   const pending = plan.index.pending ?? { anchorId: plan.anchor.id, cwd, ids: plan.rows.map(row => row.id), changes: plan.changes };
   plan.index.pending = pending; await this.doc.write(plan.index);
   for (const change of pending.changes) {
    const current = await this.file(cwd, change.path);
    if (same(current, change.before)) continue;
    if (!same(current, change.after)) throw failure(`恢复期间文件被修改：${change.path}；请保留检查点并处理冲突`);
    await this.write(cwd, change);
   }
   for (const row of plan.index.records) if (pending.ids.includes(row.id)) row.restored = true;
   plan.index.pending = null; await this.doc.write(plan.index);
   return { restored: pending.changes.length };
  });
 }
}

export function installCheckpoints(ctx, checkpoints) {
 ctx.on?.('tools/execute', async (execution, next) => {
  if (!execution.agent || execution.parent !== undefined) return next();
  const session = execution.agent.session;
  const cwd = ctx.get('workingDirectory')?.get?.(session) ?? session.header?.cwd;
  return checkpoints.run({ sessionId: session.id, seq: checkpointMessage(session), cwd,
   unsafe: () => ctx.get('terminals')?.list?.(execution.agent).some(terminal => terminal.status.kind === 'running') ? '本轮存在持续运行的后台终端，无法保证记录全部修改；暂不支持恢复该轮' : undefined,
  }, next);
 });
 ctx.effect(() => () => { checkpoints.disposed = true; return checkpoints.tail; });
}
