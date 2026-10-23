/**
 * Plugin-owned durable documents under `<DSH_HOME>/session-toolbox/`. All writes go
 * through `@deepseek-ai/dsh-atomic-write` (`writeFileAtomic` inside `withFileLock`)
 * with owner-only modes, mirroring the host's durability discipline. Corrupt
 * files are never auto-reset: they fail loud and surface in status.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write';

export const DEFAULT_SETTINGS = Object.freeze({
	version: 1,
	language: 'auto',
	draftVault: { enabled: true, maxSizeBytes: 200 * 1024 * 1024, ttlDays: 7 },
	trash: { ttlDays: 30, autoPurge: false },
	move: { enabled: true },
	nextTasks: { enabled: true },
});

const OWNED = { mode: 0o600, dirMode: 0o700 };

function mergeSettings(raw) {
	return {
		version: 1,
		language: raw.language ?? DEFAULT_SETTINGS.language,
		draftVault: { ...DEFAULT_SETTINGS.draftVault, ...(raw.draftVault ?? {}) },
		trash: { ...DEFAULT_SETTINGS.trash, ...(raw.trash ?? {}) },
		move: { ...DEFAULT_SETTINGS.move, ...(raw.move ?? {}) },
		nextTasks: { ...DEFAULT_SETTINGS.nextTasks, ...(raw.nextTasks ?? {}) },
	};
}

const positiveInt = value => Number.isSafeInteger(value) && value > 0;

/** One durable JSON document: locked read-modify-write + schema guard. */
export class JsonDocument {
	file;
	#fallback;
	#guard;
	constructor(root, name, fallback, guard) {
		this.file = join(root, name);
		this.#fallback = fallback;
		this.#guard = guard;
	}
	async read() {
		let value;
		try {
			value = JSON.parse(await readFile(this.file, 'utf8'));
		} catch (error) {
			if (error.code === 'ENOENT') value = structuredClone(this.#fallback);
			else if (error instanceof SyntaxError) throw new Error(`session-toolbox: corrupt JSON in ${this.file}: ${error.message}`, { cause: error });
			else throw error;
		}
		if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`session-toolbox: ${this.file} is not a JSON object`);
		return this.#guard === undefined ? value : this.#guard(value, this.file);
	}
	async write(value) {
		this.#guard?.(value, this.file);
		// The lock sibling is created before writeFileAtomic's own mkdir, so the
		// parent directory must already exist for withFileLock.
		await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
		await withFileLock(this.file, () => writeFileAtomic(this.file, JSON.stringify(value, null, 2), OWNED));
		return value;
	}
	/** Serialized read-modify-write; `fn` returning undefined aborts without writing. */
	async update(fn) {
		await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
		return withFileLock(this.file, async () => {
			const current = await this.read();
			const next = fn(current);
			if (next === undefined) return current;
			this.#guard?.(next, this.file);
			await writeFileAtomic(this.file, JSON.stringify(next, null, 2), OWNED);
			return next;
		});
	}
}

export function guardSettings(value, file) {
	if (value.version !== undefined && value.version !== 1) throw new Error(`session-toolbox: unsupported settings version in ${file}: ${String(value.version)}`);
	if (value.language !== undefined && !['auto', 'zh', 'en'].includes(value.language)) throw new Error(`session-toolbox: settings.language must be auto, zh or en (${file})`);
	if (value.move?.enabled !== undefined && typeof value.move.enabled !== 'boolean') throw new Error(`session-toolbox: settings.move.enabled must be boolean (${file})`);
	if (value.nextTasks?.enabled !== undefined && typeof value.nextTasks.enabled !== 'boolean') throw new Error(`session-toolbox: settings.nextTasks.enabled must be boolean (${file})`);
	if (value.nextTasks !== undefined && (value.nextTasks === null || typeof value.nextTasks !== 'object' || Array.isArray(value.nextTasks))) throw new Error(`session-toolbox: settings.nextTasks must be an object (${file})`);
	const nextTasks = { ...value.nextTasks };
	for (const key of ['provider', 'model']) {
		if (nextTasks[key] === undefined) continue;
		if (typeof nextTasks[key] !== 'string' || nextTasks[key].length > 256 || /[\u0000-\u001f\u007f]/.test(nextTasks[key])) throw new Error(`session-toolbox: settings.nextTasks.${key} must be a string of at most 256 characters without control characters (${file})`);
		nextTasks[key] = nextTasks[key].trim();
	}
	if (Boolean(nextTasks.provider) !== Boolean(nextTasks.model)) throw new Error(`session-toolbox: settings.nextTasks.provider and model must be configured together (${file})`);
	const draft = value.draftVault ?? {};
	if (draft.enabled !== undefined && typeof draft.enabled !== 'boolean') throw new Error(`session-toolbox: settings.draftVault.enabled must be boolean (${file})`);
	if (draft.maxSizeBytes !== undefined && !positiveInt(draft.maxSizeBytes)) throw new Error(`session-toolbox: settings.draftVault.maxSizeBytes must be a positive safe integer (${file})`);
	if (draft.ttlDays !== undefined && !positiveInt(draft.ttlDays)) throw new Error(`session-toolbox: settings.draftVault.ttlDays must be a positive integer (${file})`);
	const trash = value.trash ?? {};
	if (trash.ttlDays !== undefined && !positiveInt(trash.ttlDays)) throw new Error(`session-toolbox: settings.trash.ttlDays must be a positive integer (${file})`);
	if (trash.autoPurge !== undefined && typeof trash.autoPurge !== 'boolean') throw new Error(`session-toolbox: settings.trash.autoPurge must be boolean (${file})`);
	return mergeSettings({ ...value, nextTasks });
}

export function guardJournal(value, file) {
	if (value.version !== 1) throw new Error(`session-toolbox: unsupported journal version in ${file}: ${String(value.version)}`);
	const entry = value.active;
	if (entry === null || entry === undefined) return value;
	if (typeof entry.sessionId !== 'string' || typeof entry.fromCwd !== 'string' && entry.fromCwd !== null || typeof entry.toCwd !== 'string') {
		throw new Error(`session-toolbox: malformed move journal (${file})`);
	}
	if (!Array.isArray(entry.done) || typeof entry.startedAt !== 'string') throw new Error(`session-toolbox: move journal lacks done/startedAt (${file})`);
	return value;
}

export function guardLedger(value, file) {
	if (value.version !== 1) throw new Error(`session-toolbox: unsupported ledger version in ${file}: ${String(value.version)}`);
	if (!Array.isArray(value.items)) throw new Error(`session-toolbox: trash ledger has no items array (${file})`);
	for (const item of value.items) {
		if ((item.kind !== 'session' && item.kind !== 'workspace') || typeof item.id !== 'string') throw new Error(`session-toolbox: malformed trash item (${file})`);
		if (item.snapshot === null || typeof item.snapshot !== 'object') throw new Error(`session-toolbox: trash item lacks snapshot (${file})`);
	}
	return value;
}

export function guardManifest(value, file) {
	if (value.version !== 1) throw new Error(`session-toolbox: unsupported vault manifest version in ${file}: ${String(value.version)}`);
	if (!Array.isArray(value.records)) throw new Error(`session-toolbox: vault manifest has no records array (${file})`);
	for (const record of value.records) {
		if (typeof record.sessionId !== 'string' || typeof record.attachmentId !== 'string') throw new Error(`session-toolbox: malformed vault record (${file})`);
	}
	return value;
}

export { mergeSettings, OWNED };
