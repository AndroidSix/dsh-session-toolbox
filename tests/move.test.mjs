import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { MoveEngine, MovePreflightError } from '../src/move.mjs';
import { JsonDocument, guardJournal } from '../src/store.mjs';
import { encodeSegment, projectKey } from '../src/paths.mjs';
import { readHeader, scanFrames } from '../src/session-log.mjs';
import { sessionArtifact } from './helpers/zstd-frames.mjs';

const ID = 'session-11111111-2222-3333-4444-555555555555';
const OTHER = 'session-99999999-8888-7777-6666-555555555555';
const eventPayloads = buffer => scanFrames(buffer).slice(1).map(f => zstdDecompressSync(buffer.subarray(f.start, f.end)).toString('utf8'));

/** Isolated world: fake DSH home with two placements + injected capabilities. */
async function world(t, { live = [], ledgerError = null } = {}) {
	const base = await mkdtemp(join(tmpdir(), 'sk-move-'));
	const home = join(base, 'dsh');
	const sessionsRoot = join(home, 'sessions');
	const projcacheRoot = join(home, 'storages', 'session_projcache', 'sessions');
	const root = join(home, 'session-toolbox');
	// Canonical spellings (Windows realpath returns backslashes): same as the host's cwd stamps.
	const real = await realpath(base);
	const fromCwd = await realpath(await mkdir(join(real, 'project-a'), { recursive: true }).then(() => join(real, 'project-a')));
	const toCwd = await realpath(await mkdir(join(real, 'project-b'), { recursive: true }).then(() => join(real, 'project-b')));
	await mkdir(projcacheRoot, { recursive: true });
	const dir = join(sessionsRoot, projectKey(fromCwd), encodeSegment(ID));
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'session.v4.jsonl.zstd'),
		sessionArtifact({ type: 'session', version: 4, id: ID, createdAt: 5, cwd: fromCwd, isSeeded: false },
			['{"seq":1,"type":"turn/start"}\n', '{"seq":2,"type":"turn/complete"}\n']));
	await writeFile(join(dir, 'session.lock'), '');
	await writeFile(join(projcacheRoot, `${ID}.json`), JSON.stringify({ identity: { cwd: fromCwd } }));
	const otherDir = join(sessionsRoot, projectKey(fromCwd), encodeSegment(OTHER));
	await mkdir(otherDir, { recursive: true });
	await writeFile(join(otherDir, 'session.v4.jsonl.zstd'), sessionArtifact({ type: 'session', version: 4, id: OTHER, cwd: fromCwd }, []));
	const ledgerCalls = [];
	const journalDoc = new JsonDocument(root, 'journal.json', { version: 1, active: null }, guardJournal);
	const capabilities = {
		sessionLive: sessionId => live.includes(sessionId),
		listHeaders: async () => [{ id: ID, cwd: fromCwd, version: 4 }, { id: OTHER, cwd: fromCwd, version: 4 }],
		refreshHeaderCache: async () => {},
		moveLedger: async (...args) => { ledgerCalls.push(args); if (ledgerError !== null) throw ledgerError; },
		resyncIndex: async () => {},
	};
	// Simulate an idle session: logs untouched for over the churn window.
	const idle = new Date(Date.now() - 5 * 60_000);
	await utimes(join(dir, 'session.v4.jsonl.zstd'), idle, idle);
	await utimes(join(otherDir, 'session.v4.jsonl.zstd'), idle, idle);
	const engine = new MoveEngine({ root, sessionsRoot, projcacheRoot, journal: journalDoc, capabilities });
	t.after(() => rm(base, { recursive: true, force: true }));
	return { engine, root, sessionsRoot, projcacheRoot, fromCwd, toCwd, dir, otherDir, ledgerCalls, journalDoc, capabilities };
}

test('happy path: artifact relocates, header rewrites, ledger + caches updated, journal cleared', async t => {
	const w = await world(t);
	const before = await readFile(join(w.dir, 'session.v4.jsonl.zstd'));
	const result = await w.engine.move(await w.engine.preflight({ sessionId: ID, toCwd: w.toCwd }));
	assert.equal(result.ok, true);
	assert.equal(result.deferredLedger, false);
	const newDir = join(w.sessionsRoot, projectKey(w.toCwd), encodeSegment(ID));
	const after = await readFile(join(newDir, 'session.v4.jsonl.zstd'));
	assert.equal(readHeader(after).header.cwd, w.toCwd);
	assert.deepEqual(eventPayloads(after), eventPayloads(before)); // events byte-preserved
	assert.equal(await stat(w.dir).then(() => true, () => false), false);
	assert.ok((await readdir(w.otherDir)).includes('session.v4.jsonl.zstd')); // foreign session untouched
	assert.equal((await readdir(newDir)).includes('session.lock'), false);
	assert.equal(await stat(join(w.projcacheRoot, `${ID}.json`)).then(() => true, () => false), false);
	assert.deepEqual(w.ledgerCalls, [[ID, w.fromCwd, w.toCwd]]);
	assert.equal((await w.journalDoc.read()).active, null);
});

test('an idle loaded session moves without a DSH restart using a scoped maintenance lease', async t => {
	const w = await world(t);
	let loaded = true, leases = 0;
	w.capabilities.sessionLoaded = () => loaded;
	w.capabilities.sessionMaintenance = async (sessionId, operation) => {
		assert.equal(sessionId, ID);
		leases++;
		loaded = false; // host flushes and closes the writer before file placement changes
		try { return await operation(); }
		finally { loaded = true; } // subsequent opens use the migrated header
	};
	const before = await readFile(join(w.dir, 'session.v4.jsonl.zstd'));
	await w.engine.move(await w.engine.preflight({ sessionId: ID, toCwd: w.toCwd }));
	assert.equal(leases, 1);
	assert.equal(loaded, true);
	const after = await readFile(join(w.sessionsRoot, projectKey(w.toCwd), encodeSegment(ID), 'session.v4.jsonl.zstd'));
	assert.equal(readHeader(after).header.cwd, w.toCwd);
	assert.deepEqual(eventPayloads(after), eventPayloads(before));
});

test('a freshly-written (churning) log is refused to avoid orphaning appends', async t => {
	const w = await world(t);
	// Leave the log at now (default harness backdates it); re-touch to simulate an active appender.
	const now = new Date();
	await utimes(join(w.dir, 'session.v4.jsonl.zstd'), now, now);
	await assert.rejects(w.engine.preflight({ sessionId: ID, toCwd: w.toCwd }), e => e.code === 'session-churning');
});

test('a session can move A → B → A immediately, including after the engine restarts', async t => {
	const w = await world(t);
	const original = await readFile(join(w.dir, 'session.v4.jsonl.zstd'));
	let cwd = w.fromCwd;
	w.capabilities.listHeaders = async () => [{ id: ID, cwd, version: 4 }, { id: OTHER, cwd: w.fromCwd, version: 4 }];
	w.capabilities.moveLedger = async (_id, _from, to) => { cwd = to; };
	await w.engine.move(await w.engine.preflight({ sessionId: ID, toCwd: w.toCwd }));
	const restarted = new MoveEngine({ root: w.root, sessionsRoot: w.sessionsRoot, projcacheRoot: w.projcacheRoot, journal: w.journalDoc, capabilities: w.capabilities });
	await restarted.move(await restarted.preflight({ sessionId: ID, toCwd: w.fromCwd }));
	assert.equal(cwd, w.fromCwd);
	assert.deepEqual(await readFile(join(w.dir, 'session.v4.jsonl.zstd')), original);
	const now = new Date();
	await utimes(join(w.dir, 'session.v4.jsonl.zstd'), now, now);
	await assert.rejects(restarted.preflight({ sessionId: ID, toCwd: w.toCwd }), e => e.code === 'session-churning', 'external writes after a move must still block relocation');
});

test('preflight fails closed on busy / unknown / same-target / missing-target / bad id', async t => {
	const busy = await world(t, { live: [ID] });
	await assert.rejects(busy.engine.preflight({ sessionId: ID, toCwd: busy.toCwd }), e => e.code === 'session-busy');
	const w = await world(t);
	await assert.rejects(w.engine.preflight({ sessionId: 'session-nope-nope-nope', toCwd: w.toCwd }), e => e.code === 'session-unknown');
	await assert.rejects(w.engine.preflight({ sessionId: ID, toCwd: w.fromCwd }), e => e.code === 'same-target');
	await assert.rejects(w.engine.preflight({ sessionId: ID, toCwd: join(w.root, 'nowhere' + Date.now()) }), e => e.code === 'target-missing');
	await assert.rejects(w.engine.preflight({ sessionId: 'not-a-session', toCwd: w.toCwd }), MovePreflightError);
	await assert.rejects(w.engine.preflight({ sessionId: ID, toCwd: 'relative/path' }), e => e.code === 'bad-request');
});

test('createTarget creates nested directories before moving', async t => {
	const w = await world(t);
	const target = join(w.fromCwd, 'nested', 'new-project');
	const plan = await w.engine.preflight({ sessionId: ID, toCwd: target, createTarget: true });
	await w.engine.move(plan);
	assert.ok((await stat(join(w.sessionsRoot, projectKey(plan.toCwd), encodeSegment(ID)))).isDirectory());
});

test('duplicate placement across two project dirs is refused', async t => {
	const w = await world(t);
	const second = join(w.sessionsRoot, projectKey(w.toCwd), encodeSegment(ID));
	await mkdir(second, { recursive: true });
	await writeFile(join(second, 'session.lock'), '');
	await assert.rejects(w.engine.preflight({ sessionId: ID, toCwd: join(w.root, 'elsewhere') }), e => e.code === 'duplicate-artifact');
});

test('active journal blocks every new operation', async t => {
	const w = await world(t);
	await w.journalDoc.write({ version: 1, active: { sessionId: ID, fromCwd: '/a', toCwd: '/b', done: ['backup'], startedAt: 'x' } });
	await assert.rejects(w.engine.preflight({ sessionId: ID, toCwd: w.toCwd }), e => e.code === 'journal-active');
});

test('ledger failure defers the move; complete() in a fresh engine finishes it', async t => {
	const w = await world(t, { ledgerError: new Error("session header carries no cwd to validate against") });
	const result = await w.engine.move(await w.engine.preflight({ sessionId: ID, toCwd: w.toCwd }));
	assert.equal(result.ok, true);
	assert.equal(result.deferred, true);
	// artifact moved already; journal kept as the retry marker
	const newDir = join(w.sessionsRoot, projectKey(w.toCwd), encodeSegment(ID));
	assert.ok((await stat(join(newDir, 'session.v4.jsonl.zstd'))).isFile());
	assert.notEqual((await w.journalDoc.read()).active, null);
	// fresh process, healthy ledger: complete retries only the undone phases and clears
	const revived = new MoveEngine({ root: w.root, sessionsRoot: w.sessionsRoot, projcacheRoot: w.projcacheRoot,
		journal: w.journalDoc, capabilities: { ...w.capabilities, moveLedger: async (...args) => { w.ledgerCalls.push(args); }, listHeaders: async () => [{ id: ID, cwd: w.toCwd }] } });
	const done = await revived.complete();
	assert.equal(done.ok, true);
	assert.notEqual(done.deferred, true);
	assert.equal((await w.journalDoc.read()).active, null);
	assert.equal(w.ledgerCalls.length, 2);
});

test('persistently failing ledger keeps the journal and backups alive for rollback', async t => {
	const w = await world(t, { ledgerError: new Error('attach rejected') });
	await w.engine.move(await w.engine.preflight({ sessionId: ID, toCwd: w.toCwd }));
	// complete with the ledger still failing: deferred, journal retained
	const sick = new MoveEngine({ root: w.root, sessionsRoot: w.sessionsRoot, projcacheRoot: w.projcacheRoot,
		journal: w.journalDoc, capabilities: { ...w.capabilities, moveLedger: async () => { throw new Error('still rejected'); } } });
	const again = await sick.complete();
	assert.equal(again.deferred, true);
	assert.notEqual((await w.journalDoc.read()).active, null);
	assert.ok((await stat(join(w.root, 'backups', `${ID}.orig`))).isFile(), 'original backup kept while unresolved');
	// rollback from the deferred state converges fully: artifact back, journal + backups gone
	sick.caps.moveLedger = async () => {}; // source ledger repair is now required too
	const rolled = await sick.rollback();
	assert.equal(rolled.ok, true);
	assert.ok((await stat(join(w.dir, 'session.v4.jsonl.zstd'))).isFile());
	assert.equal((await w.journalDoc.read()).active, null);
});

test('crash after backup+rewrite: original untouched; complete() publishes', async t => {
	const w = await world(t);
	const plan = await w.engine.preflight({ sessionId: ID, toCwd: w.toCwd });
	const entry = { ...plan, done: [], deferredLedger: false,
		backup: join(w.root, 'backups', `${ID}.orig`), stagedNew: join(w.root, 'backups', `${ID}.new`), retired: join(w.root, 'pending-purge', `${ID}__1`) };
	await w.engine.phaseBackup(entry);
	await w.engine.phaseRewrite(entry);
	// … process dies … journal holds backup+rewrite done, original still in place
	assert.ok((await stat(join(w.dir, 'session.v4.jsonl.zstd'))).isFile());
	const revived = new MoveEngine({ root: w.root, sessionsRoot: w.sessionsRoot, projcacheRoot: w.projcacheRoot,
		journal: w.journalDoc, capabilities: { ...w.capabilities, listHeaders: async () => [{ id: ID, cwd: w.fromCwd }] } });
	const done = await revived.complete();
	assert.equal(done.ok, true);
	const after = await readFile(join(w.sessionsRoot, projectKey(plan.toCwd), encodeSegment(ID), 'session.v4.jsonl.zstd'));
	assert.equal(readHeader(after).header.cwd, plan.toCwd);
	assert.equal((await w.journalDoc.read()).active, null);
});

test('rollback after commit restores exact original bytes and placement', async t => {
	const w = await world(t);
	const original = await readFile(join(w.dir, 'session.v4.jsonl.zstd'));
	const plan = await w.engine.preflight({ sessionId: ID, toCwd: w.toCwd });
	// drive phases manually to stop right after commit
	const entry = { ...plan, done: [], deferredLedger: false,
		backup: join(w.root, 'backups', `${ID}.orig`), stagedNew: join(w.root, 'backups', `${ID}.new`), retired: join(w.root, 'pending-purge', `${ID}__${Date.now()}`) };
	await w.engine.writeJournal(entry);
	await w.engine.phaseBackup(entry);
	await w.engine.phaseRewrite(entry);
	await w.engine.phaseCommit(entry);
	const rolled = await w.engine.rollback();
	assert.equal(rolled.ok, true);
	const restored = await readFile(join(w.dir, 'session.v4.jsonl.zstd'));
	assert.deepEqual(restored, original);
	assert.equal((await w.journalDoc.read()).active, null);
	assert.equal(await stat(join(w.sessionsRoot, projectKey(w.toCwd), encodeSegment(ID))).then(() => true, () => false), false);
});

test('rollback before commit simply discards staged work', async t => {
	const w = await world(t);
	const plan = await w.engine.preflight({ sessionId: ID, toCwd: w.toCwd });
	const entry = { ...plan, done: ['backup', 'rewrite'], deferredLedger: false,
		backup: join(w.root, 'backups', `${ID}.orig`), stagedNew: join(w.root, 'backups', `${ID}.new`) };
	await w.engine.writeJournal(entry);
	const rolled = await w.engine.rollback();
	assert.equal(rolled.ok, true);
	assert.ok((await stat(join(w.dir, 'session.v4.jsonl.zstd'))).isFile());
	assert.equal((await w.journalDoc.read()).active, null);
});

test('async idle check does not reject an idle session as busy', async t => {
	const w = await world(t);
	w.capabilities.sessionLive = async () => false;
	assert.equal((await w.engine.preflight({ sessionId: ID, toCwd: w.toCwd })).sessionId, ID);
});

test('commit interruption before its journal mark rolls back placement', async t => {
	const w = await world(t);
	const plan = await w.engine.preflight({ sessionId: ID, toCwd: w.toCwd });
	const original = await readFile(join(w.dir, 'session.v4.jsonl.zstd'));
	const entry = { ...plan, done: [], backup: join(w.root, 'original'), stagedNew: join(w.root, 'new'), retired: join(w.root, 'retired') };
	await w.engine.writeJournal(entry);
	await w.engine.phaseBackup(entry);
	await w.engine.phaseRewrite(entry);
	await rename(entry.dir, entry.retired); // crash immediately after retiring source
	await w.engine.rollback();
	assert.deepEqual(await readFile(join(w.dir, 'session.v4.jsonl.zstd')), original);
});

test('rollback after publication retains session-local sidecar files', async t => {
	const w = await world(t);
	await writeFile(join(w.dir, 'notes.txt'), 'keep me');
	const plan = await w.engine.preflight({ sessionId: ID, toCwd: w.toCwd });
	const entry = { ...plan, done: [], backup: join(w.root, 'original'), stagedNew: join(w.root, 'new'), retired: join(w.root, 'retired') };
	await w.engine.writeJournal(entry);
	await w.engine.phaseBackup(entry);
	await w.engine.phaseRewrite(entry);
	await w.engine.phaseCommit(entry);
	await w.engine.rollback();
	assert.equal(await readFile(join(w.dir, 'notes.txt'), 'utf8'), 'keep me');
});

test('rollback repairs a partially detached deferred ledger and can retry after ledger failure', async t => {
	const w = await world(t, { ledgerError: new Error('attach target rejected after detach') });
	await w.engine.move(await w.engine.preflight({ sessionId: ID, toCwd: w.toCwd }));
	let fail = true;
	w.engine.caps.moveLedger = async (...args) => { w.ledgerCalls.push(args); if (fail) throw new Error('temporary registry error'); };
	await assert.rejects(w.engine.rollback(), /temporary registry error/);
	assert.equal(readHeader(await readFile(join(w.dir, 'session.v4.jsonl.zstd'))).header.cwd, w.fromCwd);
	assert.notEqual(await w.engine.readJournal(), null);
	fail = false;
	await w.engine.rollback();
	assert.deepEqual(w.ledgerCalls.at(-1), [ID, w.toCwd, w.fromCwd]);
	assert.equal(await w.engine.readJournal(), null);
});

test('commit rejects a session log modified after backup', async t => {
	const w = await world(t);
	const plan = await w.engine.preflight({ sessionId: ID, toCwd: w.toCwd });
	const entry = { ...plan, done: [], backup: join(w.root, 'orig'), stagedNew: join(w.root, 'new'), retired: join(w.root, 'retired') };
	await w.engine.phaseBackup(entry);
	await w.engine.phaseRewrite(entry);
	await writeFile(join(w.dir, entry.logName), Buffer.concat([await readFile(entry.backup), Buffer.from('new append')]));
	await assert.rejects(w.engine.phaseCommit(entry), e => e.code === 'source-changed');
	assert.equal(await stat(w.dir).then(() => true), true);
});

test('online move takes its backup after the host drained final writes and locks the target before publishing',async t=>{
 const w=await world(t);let drained;
 w.capabilities.sessionMaintenance=async(id,operation)=>{
  drained=sessionArtifact({type:'session',version:4,id:ID,createdAt:5,cwd:w.fromCwd,isSeeded:false},['{"seq":1,"type":"session/title","data":{"title":"final drained write"}}\n']);
  await writeFile(join(w.dir,'session.v4.jsonl.zstd'),drained);
  return operation({protectDirectory:async path=>{
   assert.equal(await stat(join(path,'session.v4.jsonl.zstd')).then(()=>true,()=>false),false,'lock before publishing header');
   await writeFile(join(path,'session.lock'),'kernel lease fixture');
  }});
 };
 await w.engine.move(await w.engine.preflight({sessionId:ID,toCwd:w.toCwd}));
 const target=join(w.sessionsRoot,projectKey(w.toCwd),encodeSegment(ID));
 assert.deepEqual(eventPayloads(await readFile(join(target,'session.v4.jsonl.zstd'))),eventPayloads(drained));
 assert.equal(await readFile(join(target,'session.lock'),'utf8'),'kernel lease fixture');
});
