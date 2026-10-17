/**
 * Session-to-project move (§10). The engine is capability-injected: the host
 * wires it to `workspaceRegistry` / `sessionPersistence` / `sessionQuery`, the
 * CLI wires an offline ledger over `workspace.json`. Phases are journaled so an
 * interrupted move is detected on startup and rolled back or completed
 * deterministically (§10 MR2/MR3, MN1).
 *
 * Critical-section ordering (§10.6): backup → stage new artifact (header
 * rewritten + fsynced) → commit placement → ledger → caches. The store never
 * exposes a window where one id exists in two project directories, and the
 * ledger runs only after placement is consistent, so `attachSession`'s
 * header-cwd validation holds by construction.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { encodeSegment, findLogFile, projectKey, verifyEncoders } from './paths.mjs';
import { readHeader, rewriteHeaderFrame } from './session-log.mjs';

export const PHASES = ['backup', 'rewrite', 'commit', 'ledger', 'projcache', 'index'];

export class MovePreflightError extends Error {
	code;
	details;
	constructor(code, message, details = {}) {
		super(message);
		this.name = 'MovePreflightError';
		this.code = code;
		this.details = details;
	}
}

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

async function fsyncFile(path) {
	const handle = await open(path, constants.O_WRONLY);
	try { await handle.sync(); } finally { await handle.close(); }
}

export async function writeOwned(file, data, mode = 0o600) {
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temp, data, { mode, flag: 'wx' });
	await rename(temp, file);
	return file;
}

/**
 * Move a directory between the sessions store and the kit working areas.
 * `rename` is the atomic same-volume path; a cross-device layout (unusual, but
 * possible when DSH_HOME points at a separate mount) falls back to a
 * copy-then-remove so a move never dead-ends half-published.
 */
export async function relocate(source, target) {
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	try {
		await rename(source, target);
		return;
	} catch (error) {
		if (error.code !== 'EXDEV') throw error;
	}
	const { cp } = await import('node:fs/promises');
	await cp(source, target, { recursive: true, errorOnExist: true, force: false });
	await rm(source, { recursive: true, force: true });
}

/**
 * @param deps - {root (kit dir), sessionsRoot, projcacheRoot, journal: JsonDocument,
 *                 capabilities: {sessionLive, listHeaders, moveLedger, resyncIndex, refreshHeaderCache}, now}
 */
export class MoveEngine {
	constructor(deps) {
		this.root = deps.root;
		this.sessionsRoot = deps.sessionsRoot;
		this.projcacheRoot = deps.projcacheRoot;
		this.journal = deps.journal;
		this.caps = deps.capabilities ?? {};
		this.now = deps.now ?? (() => Date.now());
	}

	async readJournal() { return (await this.journal.read()).active ?? null; }
	async writeJournal(entry) { await this.journal.write({ version: 1, active: entry }); }

	/** List every journaled placement hazard for status surfaces. */
	async recoverable() { return await this.readJournal() !== null; }

	/**
	 * Fail-closed feasibility check (§10 MR1). Returns the plan or throws
	 * MovePreflightError with a stable code; never touches anything.
	 */
	async preflight({ sessionId, toCwd, createTarget = false }) {
		if (typeof sessionId !== 'string' || !sessionId.startsWith('session-')) throw new MovePreflightError('bad-request', 'sessionId must look like session-<uuid>');
		if (typeof toCwd !== 'string' || (!toCwd.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(toCwd))) throw new MovePreflightError('bad-request', 'toCwd must be an absolute path');
		if (await this.readJournal() !== null) throw new MovePreflightError('journal-active', 'another move is journaled; complete or roll it back first');
		if (this.caps.sessionLive?.(sessionId)) throw new MovePreflightError('session-busy', `session ${sessionId} is live; stop its work before moving`);
		const headers = await this.caps.listHeaders();
		const header = headers.find(row => row.id === sessionId);
		if (header === undefined) throw new MovePreflightError('session-unknown', `no stored session ${sessionId}`);
		if (typeof header.version === 'number' && header.version < 4) throw new MovePreflightError('format-legacy', `stored log is format v${header.version}; open the session once in DSH so the host migrates it, then retry`);

		// Locate the authoritative directory by scanning project dirs — never trust a computed path alone.
		const encoded = encodeSegment(sessionId);
		const entries = await readdir(this.sessionsRoot, { withFileTypes: true }).catch(error => {
			if (error.code === 'ENOENT') return [];
			throw error;
		});
		const projects = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name);
		const found = [];
		for (const project of projects) {
			try { if ((await stat(join(this.sessionsRoot, project, encoded))).isDirectory()) found.push(project); } catch {}
		}
		if (found.length > 1) throw new MovePreflightError('duplicate-artifact', `session ${sessionId} lives in ${found.length} project directories; refusing to guess`);
		if (found.length === 0) throw new MovePreflightError('artifact-missing', `session ${sessionId} has no session directory under any project`);
		const fromProject = found[0];
		const logName = await findLogFile(join(this.sessionsRoot, fromProject, encoded));
		if (logName === undefined) throw new MovePreflightError('artifact-missing', `session directory for ${sessionId} holds no session log`);
		if (header.cwd !== undefined && fromProject !== projectKey(header.cwd)) {
			// §10 MN3: the layout changed in a way this build cannot follow.
			throw new MovePreflightError('unknown-layout', `cwd '${header.cwd}' should live at '${projectKey(header.cwd)}' but the artifact was observed at '${fromProject}'`);
		}
		const fromCwd = header.cwd;
		let canonicalTo;
		try { canonicalTo = await realpath(toCwd.replace(/[/\\]+$/, '') || toCwd); } catch { canonicalTo = undefined; }
		if (canonicalTo === undefined) {
			if (!createTarget) throw new MovePreflightError('target-missing', `target directory ${toCwd} does not exist (choose create to make it)`);
			await mkdir(toCwd, { recursive: true });
			canonicalTo = await realpath(toCwd);
		}
		if (fromCwd !== undefined && canonicalTo === fromCwd) throw new MovePreflightError('same-target', 'the session already belongs to that project');
		const samples = headers.filter(row => row.cwd !== undefined).slice(0, 5)
			.map(row => ({ cwd: row.cwd, id: row.id, project: projectKey(row.cwd), dir: encodeSegment(row.id) }));
		if (samples.length > 0 && !verifyEncoders(samples, this.sessionsRoot)) {
			throw new MovePreflightError('unknown-layout', 'project-key / segment encoders disagree with the shipped layout; refusing to write');
		}
		return {
			sessionId, fromCwd: fromCwd ?? null, toCwd: canonicalTo,
			fromProject, toProject: projectKey(canonicalTo),
			dir: join(this.sessionsRoot, fromProject, encoded),
			newDir: join(this.sessionsRoot, projectKey(canonicalTo), encoded),
			logName,
			startedAt: new Date(this.now()).toISOString(),
		};
	}

	async #stage(entry, phase) {
		if (!entry.done.includes(phase)) { entry.done = [...entry.done, phase]; await this.writeJournal(entry); }
	}

	/** Execute the whole move; on failure the journal survives for rollback/complete. */
	async move(plan) {
		const entry = { ...plan, done: [], deferredLedger: false,
			backup: join(this.root, 'backups', `${plan.sessionId}.orig`),
			stagedNew: join(this.root, 'backups', `${plan.sessionId}.new`),
			retired: join(this.root, 'pending-purge', `${plan.sessionId}__${this.now()}`) };
		await this.writeJournal(entry);
		try {
			await this.phaseBackup(entry);
			await this.phaseRewrite(entry);
			await this.phaseCommit(entry);
			await this.phaseLedger(entry);
			await this.phaseProjcache(entry);
			await this.phaseIndex(entry);
		} catch (error) {
			error.journal = await this.readJournal();
			throw error;
		}
		// A deferred ledger (same-process stale header cache) keeps the journal alive
		// as the retry marker: the artifact is already moved, and the next process —
		// or move.complete — converges the accounting (§10 MR3).
		if (entry.deferredLedger === true) {
			await this.writeJournal(entry);
			return { ok: true, deferred: true, sessionId: entry.sessionId, toCwd: entry.toCwd,
				note: '文件已迁移；DSH 账本将在下次启动或 move.complete 时收敛' };
		}
		await this.#finish(entry);
		return { ok: true, sessionId: entry.sessionId, toCwd: entry.toCwd, deferredLedger: entry.deferredLedger === true };
	}

	async #finish(entry) {
		await this.writeJournal(null);
		await rm(entry.backup, { force: true });
		await rm(entry.stagedNew, { force: true });
		if (entry.retired !== undefined) await rm(entry.retired, { recursive: true, force: true });
	}

	async phaseBackup(entry) {
		const source = await readFile(join(entry.dir, entry.logName));
		await writeOwned(entry.backup, source);
		entry.sourceHash = sha256(source);
		await this.#stage(entry, 'backup');
	}

	async phaseRewrite(entry) {
		const source = await readFile(entry.backup);
		if (sha256(source) !== entry.sourceHash) throw new MovePreflightError('source-changed', 'the session log changed between backup and rewrite');
		const current = readHeader(source);
		if (current.header.id !== entry.sessionId) throw new MovePreflightError('artifact-mismatch', `log header id '${current.header.id}' does not name ${entry.sessionId}`);
		const rewritten = rewriteHeaderFrame(source, entry.toCwd);
		readHeader(rewritten); // parse + walk validation of our own output before staging
		if (sha256(rewritten) === entry.sourceHash) throw new MovePreflightError('rewrite-noop', 'header rewrite produced identical bytes');
		await writeOwned(entry.stagedNew, rewritten);
		await fsyncFile(entry.stagedNew);
		await this.#stage(entry, 'rewrite');
	}

	async phaseCommit(entry) {
		// Retire first, then publish: the id is never simultaneously discoverable in two project dirs.
		await relocate(entry.dir, entry.retired);
		await mkdir(entry.newDir, { recursive: true, mode: 0o700 });
		await writeOwned(join(entry.newDir, entry.logName), await readFile(entry.stagedNew));
		await fsyncFile(join(entry.newDir, entry.logName));
		// Carry non-log artifacts (session-local files); never resurrect a stale lock.
		for (const name of await readdir(entry.retired).catch(() => [])) {
			if (name === entry.logName || name === 'session.lock') continue;
			await rename(join(entry.retired, name), join(entry.newDir, name)).catch(() => {});
		}
		await rm(join(entry.newDir, 'session.lock'), { force: true });
		await this.#stage(entry, 'commit');
	}

	async phaseLedger(entry) {
		if (this.caps.moveLedger === undefined) { entry.deferredLedger = true; await this.#stage(entry, 'ledger'); return; }
		try {
			await this.caps.refreshHeaderCache?.();
			await this.caps.moveLedger(entry.sessionId, entry.fromCwd ?? undefined, entry.toCwd);
			entry.deferredLedger = false;
		} catch (error) {
			// The registry's header/pin caches can lag a same-process move. Leaving the
			// journal's ledger phase undone lets startup recovery re-run it in a fresh
			// process where the caches are cold (§10 MR3/MR4).
			entry.deferredLedger = true;
			entry.ledgerError = String(error?.message ?? error);
		}
		await this.#stage(entry, 'ledger');
	}

	async phaseProjcache(entry) {
		if (this.projcacheRoot !== undefined) await rm(join(this.projcacheRoot, `${entry.sessionId}.json`), { force: true });
		await this.#stage(entry, 'projcache');
	}

	async phaseIndex(entry) {
		await this.caps.resyncIndex?.();
		await this.#stage(entry, 'index');
	}

	/** Undo completed phases in reverse (§10 MR3). */
	async rollback() {
		const entry = await this.readJournal();
		if (entry === null) throw new MovePreflightError('no-journal', 'no journaled move to roll back');
		if (entry.done.includes('commit')) {
			await rm(entry.newDir, { recursive: true, force: true });
			await mkdir(dirname(entry.dir), { recursive: true, mode: 0o700 });
			if (entry.retired !== undefined) await relocate(entry.retired, entry.dir);
			else throw new MovePreflightError('journal-order', 'committed journal lost its retired directory');
		}
		if (entry.deferredLedger !== true && entry.done.includes('ledger') && this.caps.moveLedger !== undefined) {
			await this.caps.moveLedger(entry.sessionId, entry.toCwd, entry.fromCwd ?? undefined).catch(() => {});
			await this.caps.refreshHeaderCache?.().catch(() => {});
		}
		if (this.projcacheRoot !== undefined) await rm(join(this.projcacheRoot, `${entry.sessionId}.json`), { force: true });
		await this.caps.resyncIndex?.().catch(() => {});
		await this.#finish({ ...entry, retired: entry.done.includes('commit') ? undefined : entry.retired });
		return { ok: true, rolledBack: entry.done };
	}

	/** Resume a journaled move from its first missing phase (post-crash forward roll). */
	async complete() {
		const entry = await this.readJournal();
		if (entry === null) throw new MovePreflightError('no-journal', 'no journaled move to complete');
		const runs = { backup: e => this.phaseBackup(e), rewrite: e => this.phaseRewrite(e), commit: e => this.phaseCommit(e),
			ledger: e => this.phaseLedger(e), projcache: e => this.phaseProjcache(e), index: e => this.phaseIndex(e) };
		for (const phase of PHASES) {
			if (entry.done.includes(phase)) {
				// A deferred ledger from a previous attempt deserves another try in
				// this (fresh) process where the registry caches are cold.
				if (phase === 'ledger' && entry.deferredLedger === true) await runs.ledger(entry);
				continue;
			}
			if (phase !== 'backup' && !entry.done.includes('backup')) throw new MovePreflightError('journal-order', `journal skipped '${phase}' before completing 'backup'`);
			await runs[phase](entry);
		}
		// Still-deferred accounting keeps the journal (and every backup) alive as
		// the convergence pointer; rollback remains available (§10 MR3).
		if (entry.deferredLedger === true) {
			await this.writeJournal(entry);
			return { ok: true, deferred: true, sessionId: entry.sessionId, toCwd: entry.toCwd, ledgerError: entry.ledgerError,
				note: '文件已迁移但 DSH 账本仍未收敛；重启 DSH 后再次点完成，或选择回滚' };
		}
		await this.#finish(entry);
		return { ok: true, sessionId: entry.sessionId, toCwd: entry.toCwd };
	}
}
