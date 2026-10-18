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

export const DB_NAME = 'dsh-session-toolbox-vault';
export const STORE = 'blobs';
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** Marks our own synthetic paste so it is not re-captured as a new draft. */
const SEED_MARKER = Symbol.for('dsh-session-toolbox.seed');

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
		try { globalThis.window?.dispatchEvent?.(new CustomEvent('dsh-session-toolbox-notice', { detail: message })); } catch { /* test envs */ }
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
		const endpoint = options.endpoint ?? '/.well-known/dsh-session-toolbox';
		try {
			if (hostKey === '') {
				const probe = await fetchImpl(endpoint, { cache: 'no-store' });
				hostKey = (await probe.json()).key ?? '';
			}
			const records = (await allRecords()).slice(-500).map(({ key, sessionId, attachmentId, name, size, hash, seeded, createdAt, sentAt }) =>
				({ key, sessionId, attachmentId, name, size, hash, seeded, createdAt, sentAt: sentAt ?? 0 }));
			await fetchImpl(endpoint, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-session-toolbox-key': hostKey },
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
		const existing = (await allRecords()).filter(record => record.sessionId === sessionId);
		const seen = new Set(existing.map(record => record.hash));
		let added = 0;
		for (const item of files) {
			if (!isImageFile(item)) continue;
			const hash = await contentHash(item);
			if (seen.has(hash)) continue; // same image already held for this session
			seen.add(hash);
			const id = (globalThis.crypto?.randomUUID?.() ?? `id-${now()}-${Math.random().toString(36).slice(2)}`);
			const record = { key: `${sessionId}__${id}`, sessionId, attachmentId: id,
				name: item.name || '', type: item.type, size: item.size, hash, createdAt: now(), sentAt: 0, seeded: false };
			record.blob = item;
			await putRecord(record);
			added += 1;
		}
		if (added > 0) notice(`已备份 ${added} 张草稿图片（会话 ${sessionId.slice(-6)}）`);
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
	/**
	 * Image cards currently sitting in the composer.
	 *
	 * The official composer region is `[data-composer-seat]` (carrying
	 * `data-conversation-region="composer"`); the old selector also looked for a
	 * `data-composer-bar` attribute that the current UI never emits, which made
	 * every lookup fall through to a brittle parentElement walk and usually
	 * return zero cards. A zero rail in turn defeated both the send detector and
	 * the "composer already holds them" guard.
	 */
	function attachmentRail(editor) {
		const seat = editor?.closest?.('[data-composer-seat], [data-conversation-region="composer"]');
		const root = seat ?? editor?.parentElement?.parentElement?.parentElement;
		if (root?.querySelectorAll === undefined) return undefined;
		return [...root.querySelectorAll('img')].filter(img => {
			const src = img.getAttribute?.('src') ?? '';
			return src.startsWith('blob:') || src.startsWith('data:image/');
		});
	}

	// ---- FR2 restore -----------------------------------------------------------
	async function seedSession(sessionId = currentSession()) {
		if (sessionId === undefined || sessionId === '' || !limits.enabled) return false;
		const editor = composerRoot();
		if (editor === undefined) return false;
		const rail = attachmentRail(editor);
		if (rail === undefined) return false;
		if (rail.length > 0) return true; // non-empty: official still holds them (or was seeded before)
		// Never resurrect images that already travelled with a sent message. Two
		// independent guards: an explicit sent flag, and a "already handed back to
		// the composer" flag so a single batch is dispatched at most once even if
		// the rail probe misses the cards.
		const pending = (await allRecords()).filter(record => record.sessionId === sessionId && !record.sentAt && !record.delivered);
		if (pending.length === 0) return true;
		const files = [];
		for (const record of pending) {
			try { files.push(await blobToFile(record)); }
			catch { await dropRecord(record.key); } // unreadable backup — drop and move on
		}
		if (files.length === 0) { changed(); return false; }
		const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'clipboardData', { value: fakeClipboardData(files) });
		// Mark as a restore so our own intake (which observes the same event)
		// never stores the replayed images as a second fresh draft.
		try { Object.defineProperty(event, SEED_MARKER, { value: true }); } catch { /* ignore */ }
		try { editor.focus?.(); } catch { /* ignore */ }
		editor.dispatchEvent(event);
		const accepted = event.defaultPrevented === true;
		if (accepted) notice(`已恢复 ${files.length} 张草稿图片（会话 ${sessionId.slice(-6)}）`);
		else log('warn', 'synthetic paste was not accepted; vault stays idle for this session');
		// A restore hands the images back to the official composer; they now live
		// there (and will be retired when sent), so keep a single copy in the vault.
		if (accepted) for (const record of pending) await putRecord({ ...record, seeded: true, delivered: now() });
		changed();
		return accepted;
	}

	// ---- FR3 lifecycle ---------------------------------------------------------
	/**
	 * Mark a session's backed-up drafts as already sent, so they are never
	 * replayed into the composer again.
	 *
	 * Inferring "sent" from the attachment rail reaching zero used to miss the
	 * common case: the rail is already empty by the time the session mounts
	 * again, so the transition never happened while we were watching and the
	 * old images were restored on every switch. Observing the composer while it
	 * is mounted (below) plus this explicit retirement keeps the vault honest.
	 */
	async function retireSession(sessionId, reason) {
		let retired = 0;
		for (const record of await allRecords()) {
			if (record.sessionId !== sessionId || record.sentAt) continue;
			await putRecord({ ...record, sentAt: now() });
			retired += 1;
		}
		if (retired > 0) {
			notice(reason === 'sent'
				? `本会话草稿已随消息发送，${retired} 张备份不再恢复`
				: `本会话草稿已清空，${retired} 张备份不再恢复`);
			void syncHost();
		}
		changed();
		return retired;
	}

	function watchSession(sessionId, editor) {
		let rail = attachmentRail(editor)?.length ?? 0;
		const scope = editor.closest?.('[data-conversation-content]') ?? editor;
		const check = async () => {
			const next = attachmentRail(editor)?.length ?? rail;
			if (next === rail) return;
			if (rail > 0 && next === 0 && scope?.isConnected === true) {
				// Cards disappeared while the composer was mounted: the message was
				// sent (or the user removed them), so retire the backups for good.
				await retireSession(sessionId, 'sent');
			}
			rail = next;
			changed();
		};
		if (typeof MutationObserver !== 'function') return () => {};
		const observer = new MutationObserver(() => void check());
		observer.observe(scope, { subtree: true, childList: true });

		// Belt and braces: listen for the send gesture itself, so a fast unmount
		// (enter then immediately switch away) still retires the drafts.
		const onKeyDown = event => {
			if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
			const target = event.target;
			if (target?.closest?.('[data-conversation-session]') === null || target?.closest?.('[data-conversation-session]') === undefined) return;
			if ((attachmentRail(editor)?.length ?? 0) > 0) void retireSession(sessionId, 'sent');
		};
		document.addEventListener('keydown', onKeyDown, true);
		return () => { observer.disconnect(); document.removeEventListener('keydown', onKeyDown, true); };
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
					const res = await fetchImpl(`${options.endpoint ?? '/.well-known/dsh-session-toolbox'}`, { cache: 'no-store' });
					const next = await res.json();
					limits = { ...limits, ...(next.settings?.draftVault ?? {}) };
				} catch { /* defaults hold */ }
			}
			const capture = event => {
				if (event[SEED_MARKER] === true) return;
				void intake(currentSession(), readImages(event)).catch(() => {});
			};
			document.addEventListener('paste', capture, true);
			document.addEventListener('drop', capture, true);
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
		/** Retire a session's unsent drafts (called when its images were sent). */
		retire: async (sessionId = currentSession(), reason = 'sent') => retireSession(sessionId, reason),
		intake,
		watchMounts,
	};
}
