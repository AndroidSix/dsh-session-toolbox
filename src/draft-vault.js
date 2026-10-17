/**
 * Draft vault (§4-§9): mirrors image drafts into IndexedDB and replays them
 * through the official paste pipeline. No official internals are touched:
 * capture listens at document-level `paste`/`drop`/file-input `change` (never
 * preventing or stopping the native flow), persistence is browser IndexedDB,
 * and restore re-dispatches a ClipboardEvent carrying a synthetic
 * `clipboardData` (Chromium ignores the ClipboardEventInit clipboardData and
 * exposes it only as a prototype accessor, so the property is shadowed with a
 * defined own property — the official handler only reads `items`/`getData`,
 * verified against the shipped build).
 *
 * Idempotency is DOM-based and safe by construction:
 * - seeding only happens into an EMPTY attachment rail;
 * - a seed is confirmed by the official handler calling preventDefault() (its
 *   documented contract for accepted files);
 * - rail dropping to zero while the session view is mounted means "sent or
 *   user-deleted" (§ FR3: both delete the backups); the view unmounting keeps
 *   them — that is exactly the loss this vault repairs.
 */

export const DB_NAME = 'dsh-session-kit-vault';
export const STORE = 'blobs';
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // the official per-image admission cap
export const DEFAULT_LIMITS = Object.freeze({ enabled: true, maxSizeBytes: 200 * 1024 * 1024, ttlDays: 7 });

export function isImageFile(file) {
	return file !== undefined && IMAGE_TYPES.includes(file.type) && file.size > 0 && file.size <= MAX_FILE_BYTES;
}

/** sha256 hex of bytes; crypto.subtle is absent on non-secure origins → size/name fallback hash. */
export async function contentHash(file) {
	if (globalThis.crypto?.subtle !== undefined) {
		try {
			const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
			return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
		} catch { /* fall through */ }
	}
	return `weak:${file.size}:${file.name}:${file.lastModified}`;
}

function openDb() {
	if (typeof indexedDB === 'undefined') throw new Error('IndexedDB unavailable');
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'key' });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
	});
}

/** Resolve with the request result; reject with its error. */
function done(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('vault storage request failed'));
	});
}

function storeOp(database, mode, run) {
	return new Promise((resolve, reject) => {
		let outcome;
		const transaction = database.transaction(STORE, mode);
		transaction.onabort = () => reject(transaction.error ?? new Error('vault transaction aborted'));
		transaction.onerror = () => reject(transaction.error ?? new Error('vault transaction failed'));
		try { outcome = run(transaction.objectStore(STORE)); } catch (error) { reject(error); return; }
		Promise.resolve(outcome).then(resolve, reject);
	});
}

function emitter() {
	const listeners = new Map();
	return {
		on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
		off(event, fn) { listeners.get(event)?.delete(fn); },
		emit(event, detail) { for (const fn of [...(listeners.get(event) ?? [])]) { try { fn(detail); } catch {} } },
	};
}

function fakeClipboardData(files) {
	const items = files.map(f => ({ kind: 'file', type: f.type, getAsFile: () => f }));
	return { items, files, length: files.length, types: ['Files'], getData: () => '', setData: () => false, clearData: () => {} };
}

async function blobToFile(record) {
	if (record.blob instanceof File) return record.blob;
	const blob = record.blob instanceof Blob ? record.blob : new Blob([record.blob ?? new Uint8Array()], { type: record.type });
	return new File([blob], record.name ?? '', { type: record.type, lastModified: record.createdAt });
}

/**
 * @param options - {endpoint, log, now, fetchImpl}
 */
export function createVault(options = {}) {
	const log = options.log ?? (() => {});
	const now = options.now ?? (() => Date.now());
	const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
	const bus = emitter();
	let dbPromise = null;
	let limits = { ...DEFAULT_LIMITS };
	let lastNotice = '';
	let started = false;
	let teardown = null;
	let hostKey = '';

	const db = () => dbPromise ??= openDb();
	function notice(message) {
		lastNotice = message;
		bus.emit('notice', message);
		try { globalThis.window?.dispatchEvent?.(new CustomEvent('dsh-session-kit-notice', { detail: message })); } catch { /* test envs */ }
	}
	function changed() { bus.emit('change'); }

	// ---- IndexedDB CRUD -----------------------------------------------------
	const allRecords = async () => {
		const database = await db();
		return await storeOp(database, 'readonly', store => done(store.getAll()));
	};
	const putRecord = async record => {
		const database = await db();
		await storeOp(database, 'readwrite', store => done(store.put(record)));
	};
	const dropRecord = async key => {
		const database = await db();
		await storeOp(database, 'readwrite', store => done(store.delete(key)));
	};

	/** Best-effort host manifest mirror (status display only; failures invisible). */
	async function syncHost() {
		const endpoint = options.endpoint ?? '/.well-known/dsh-session-kit';
		try {
			if (hostKey === '') {
				const probe = await fetchImpl(endpoint, { cache: 'no-store' });
				hostKey = (await probe.json()).key ?? '';
			}
			const records = (await allRecords()).slice(-500).map(({ key, sessionId, attachmentId, name, size, hash, seeded, createdAt }) =>
				({ key, sessionId, attachmentId, name, size, hash, seeded, createdAt }));
			await fetchImpl(endpoint, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-session-kit-key': hostKey },
				body: JSON.stringify({ type: 'vault.sync', records }) });
		} catch { /* the manifest is cosmetic; the vault itself is IndexedDB */ }
	}

	// ---- FR4 capacity + TTL --------------------------------------------------
	async function sweep() {
		const records = await allRecords();
		const ttlMs = limits.ttlDays * 24 * 60 * 60 * 1000;
		const keep = [];
		const remove = [];
		for (const record of records) (now() - (record.createdAt ?? 0) > ttlMs ? remove : keep).push(record);
		keep.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
		let bytes = keep.reduce((total, record) => total + (record.size ?? 0), 0);
		while (bytes > limits.maxSizeBytes && keep.length > 0) {
			const oldest = keep.shift();
			bytes -= oldest.size ?? 0;
			remove.push(oldest);
		}
		for (const record of remove) await dropRecord(record.key);
		if (remove.length > 0) notice(`草稿保险箱已清理 ${remove.length} 项（超期/超容量）`);
		changed();
		return { removed: remove.length, kept: keep.length, bytes };
	}

	// ---- FR1 capture ---------------------------------------------------------
	async function intake(sessionId, files) {
		if (!limits.enabled || sessionId === undefined || sessionId === '') return;
		for (const item of files) {
			if (!isImageFile(item)) continue;
			const id = (globalThis.crypto?.randomUUID?.() ?? `id-${now()}-${Math.random().toString(36).slice(2)}`);
			const record = { key: `${sessionId}__${id}`, sessionId, attachmentId: id,
				name: item.name || '', type: item.type, size: item.size, hash: await contentHash(item), createdAt: now(), seeded: false };
			record.blob = item;
			await putRecord(record);
			notice(`已备份 1 张草稿图片（会话 ${sessionId.slice(-6)}）`);
		}
		void syncHost();
	}

	const readImages = event => [...(event.clipboardData?.files ?? event.dataTransfer?.files ?? [])].filter(isImageFile);
	const fileInputImages = event => {
		const target = event.target;
		if (!(target instanceof HTMLInputElement) || target.type !== 'file' || target.files === null) return [];
		return [...target.files].filter(isImageFile);
	};

	// ---- DOM discovery (official composer markers) ----------------------------
	function currentSession() {
		return document.querySelector?.('[data-conversation-session]')?.getAttribute?.('data-conversation-session') ?? '';
	}
	function composerRoot() {
		return document.querySelector?.('[data-conversation-session] [contenteditable="true"]') ?? undefined;
	}
	function attachmentRail(editor) {
		// Official structure: attachment cards are imgs with blob: srcs sitting
		// above the contenteditable root inside the composer bar subtree.
		const bar = editor?.closest?.('[data-composer-bar], [data-conversation-region="composer"]') ?? editor?.parentElement?.parentElement?.parentElement;
		if (bar?.querySelectorAll === undefined) return undefined;
		return [...bar.querySelectorAll('img')].filter(img => img.getAttribute?.('src')?.startsWith('blob:'));
	}

	// ---- FR2 restore -----------------------------------------------------------
	async function seedSession(sessionId = currentSession()) {
		if (sessionId === undefined || sessionId === '' || !limits.enabled) return false;
		const editor = composerRoot();
		if (editor === undefined) return false;
		const rail = attachmentRail(editor);
		if (rail === undefined) return false;
		if (rail.length > 0) return true; // non-empty: official still holds them (or was seeded before)
		const pending = (await allRecords()).filter(record => record.sessionId === sessionId);
		if (pending.length === 0) return true;
		const files = [];
		for (const record of pending) {
			try { files.push(await blobToFile(record)); }
			catch { await dropRecord(record.key); } // unreadable backup — drop and move on
		}
		if (files.length === 0) { changed(); return false; }
		const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'clipboardData', { value: fakeClipboardData(files) });
		try { editor.focus?.(); } catch { /* ignore */ }
		editor.dispatchEvent(event);
		const accepted = event.defaultPrevented === true;
		if (accepted) notice(`已恢复 ${files.length} 张草稿图片（会话 ${sessionId.slice(-6)}）`);
		else log('warn', 'synthetic paste was not accepted; vault stays idle for this session');
		changed();
		return accepted;
	}

	// ---- FR3 lifecycle ---------------------------------------------------------
	function watchSession(sessionId, editor) {
		let rail = attachmentRail(editor)?.length ?? 0;
		const scope = editor.closest?.('[data-conversation-content]') ?? editor;
		const check = async () => {
			const next = attachmentRail(editor)?.length ?? rail;
			if (next === rail) return;
			if (rail > 0 && next === 0 && scope?.isConnected === true) {
				// Sent or manually removed while mounted → backups retire (§ FR3).
				for (const record of await allRecords()) if (record.sessionId === sessionId) await dropRecord(record.key);
				notice('本会话草稿图片已清空，备份同步移除');
				void syncHost();
			}
			rail = next;
			changed();
		};
		if (typeof MutationObserver !== 'function') return () => {};
		const observer = new MutationObserver(() => void check());
		observer.observe(scope, { subtree: true, childList: true });
		return () => observer.disconnect();
	}

	function watchMounts() {
		let boundSession = '', dispose = () => {};
		const sync = async () => {
			const sessionId = currentSession();
			const editor = composerRoot();
			if (sessionId === '' || editor === undefined) return;
			if (sessionId === boundSession && editor.isConnected !== false) return;
			boundSession = sessionId;
			dispose();
			dispose = watchSession(sessionId, editor);
			setTimeout(() => void seedSession(sessionId).catch(error => log('warn', `vault seed failed: ${error.message}`)), 120);
			void sweep().catch(() => {});
		};
		const interval = setInterval(() => void sync(), 5000);
		if (typeof MutationObserver !== 'function') return () => clearInterval(interval);
		const observer = new MutationObserver(() => void sync());
		observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-conversation-session'] });
		return () => { observer.disconnect(); clearInterval(interval); dispose(); };
	}

	return {
		on: bus.on, off: bus.off,
		get lastNotice() { return lastNotice; },
		currentSession,
		records: allRecords,
		countFor: async sessionId => {
			const records = await allRecords();
			return sessionId === undefined || sessionId === '' ? records.length : records.filter(record => record.sessionId === sessionId).length;
		},
		start: async ({ limits: override } = {}) => {
			if (started || typeof document === 'undefined') return false;
			started = true;
			if (override !== undefined) limits = { ...limits, ...override };
			else {
				try {
					const res = await fetchImpl(`${options.endpoint ?? '/.well-known/dsh-session-kit'}`, { cache: 'no-store' });
					const next = await res.json();
					limits = { ...limits, ...(next.settings?.draftVault ?? {}) };
				} catch { /* defaults hold */ }
			}
			document.addEventListener('paste', event => void intake(currentSession(), readImages(event)).catch(() => {}), true);
			document.addEventListener('drop', event => void intake(currentSession(), readImages(event)).catch(() => {}), true);
			document.addEventListener('change', event => void intake(currentSession(), fileInputImages(event)).catch(() => {}), true);
			teardown = watchMounts();
			void sweep().catch(() => {});
			log('info', 'draft vault started');
			return true;
		},
		stop: () => { if (started) { started = false; teardown?.(); teardown = null; } },
		setLimits: next => {
			limits = { ...limits, ...next };
			if (limits.enabled === false) void (async () => { for (const record of await allRecords()) await dropRecord(record.key); notice('草稿保险箱已停用，存量已清空'); })();
		},
		sweep,
		seedSession,
		intake,
		watchMounts,
	};
}
