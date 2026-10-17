/**
 * DSH session-storage path algebra. Mirrors `projectKey` / `encodeSegment` /
 * `projectDir` / `sessionDir` from `@deepseek-ai/dsh-session-persistence-jsonl`
 * (which does not export them). Every implementation is verified against the
 * live layout by `verifyEncoders` before any mutation runs, so a future official
 * change to the encoding rules fails closed (§10 MN3) instead of corrupting data.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** The `undefined` cwd bucket: sessions whose stored header carries no cwd. */
export const NO_CWD_DIR = '_no-cwd';

/** Encode one id/path segment: safe code units stay literal, everything else becomes `~XXXX`. */
export function encodeSegment(raw) {
	if (raw.length === 0) throw new Error('cannot encode an empty path segment');
	if (raw === '.') return '~002E';
	if (raw === '..') return '~002E~002E';
	let out = '';
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
	}
	return out;
}

/**
 * Build the readable project directory key for a canonical cwd, exactly like the
 * official backend: separators collapse to one `-`, unsafe units escape as `~XXXX`,
 * the whole key is wrapped in `--…--` and bounded to 251 readable characters.
 */
export function projectKey(cwd) {
	if (cwd.length === 0) throw new Error('cannot encode an empty project path');
	let readable = '';
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === '/' || ch === '\\' || ch === ':') {
			if (!separatorRun) readable += '-';
			separatorRun = true;
		} else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

export function projectDir(root, cwd) {
	return cwd === undefined ? join(root, NO_CWD_DIR) : join(root, projectKey(cwd));
}

export function sessionDir(root, cwd, id) {
	return join(projectDir(root, cwd), encodeSegment(id));
}

const LOG_BASENAMES = ['session.jsonl', 'session.v1.jsonl', 'session.v2.jsonl', 'session.v3.jsonl', 'session.v4.jsonl',
	'session.jsonl.zstd', 'session.v1.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v4.jsonl.zstd'];

/** Locate the authoritative session log inside one session directory (highest generation wins). */
export async function findLogFile(dir) {
	const entries = await readdir(dir);
	const present = LOG_BASENAMES.filter(name => entries.includes(name));
	if (present.length === 0) return undefined;
	// Compression-suffixed generations outrank the bare same-generation name; then highest version.
	const zstd = present.filter(name => name.endsWith('.zstd'));
	const pool = zstd.length > 0 ? zstd : present;
	return pool.sort((left, right) => right.length - left.length || right.localeCompare(left))[0];
}

/** One candidate location for a session id, checked cheaply (directory stat only). */
export async function sessionDirExists(root, cwd, id) {
	try { return (await stat(join(sessionDir(root, cwd, id)))).isDirectory(); } catch { return false; }
}

/**
 * Prove our local encoders agree with the shipped layout before anything writes:
 * for every provided {cwd, id, observedProjectDir, observedSessionDir} sample
 * (taken from headers the host itself enumerated), the directory derived by
 * projectKey/encodeSegment must match the observed path relative to the root.
 * @param samples - observed placement of stored sessions.
 * @param root - absolute sessions root; samples carry root-relative dirs.
 * @returns whether every sample reproduces.
 */
export function verifyEncoders(samples, root) {
	if (samples.length === 0) return false;
	return samples.every(({ cwd, id, project, dir }) =>
		join(root, project, dir) === sessionDir(root, cwd, id) && join(root, project) === projectDir(root, cwd));
}
