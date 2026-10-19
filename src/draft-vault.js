/**
 * Draft vault (§4-§9): mirrors image drafts into IndexedDB and replays them
 * through the official paste pipeline. No official internals are touched:
 * the public SessionInput store supplies admitted attachments and remains
 * observed across navigation. Older hosts fall back to read-only DOM capture.
 * Browser IndexedDB holds bytes; restore uses the official paste pipeline.
 * Native attachment ids are checked before DOM thumbnails, which may render
 * late. No host attachment registry or input method is patched.
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
		let outcome, result;
		const transaction = database.transaction(STORE, mode);
		transaction.oncomplete = () => resolve(result);
		transaction.onabort = () => reject(transaction.error ?? new Error('vault transaction aborted'));
		transaction.onerror = () => reject(transaction.error ?? new Error('vault transaction failed'));
		try { outcome = run(transaction.objectStore(STORE)); } catch (error) { reject(error); return; }
		Promise.resolve(outcome).then(value => { result = value; }, reject);
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
	let captureCleanup = () => {};
	let generation = 0;
	const inputs = new Map();
	const seeded = new WeakMap();
	const seeding = new WeakSet();
	let storageQueue = Promise.resolve();
	const serialize = task => {
		const next = storageQueue.then(task);
		storageQueue = next.catch(() => {});
		return next;
	};

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
	async function syncHost(attempt = 0) {
		const endpoint = options.endpoint ?? '/.well-known/dsh-session-toolbox';
		try {
			if (hostKey === '') {
				const probe = await fetchImpl(endpoint, { cache: 'no-store' });
				hostKey = (await probe.json()).key ?? '';
			}
			const records = (await allRecords()).filter(record => !record.sentAt).slice(-2000).map(({ key, sessionId, attachmentId, name, size, hash, seeded, createdAt, sentAt }) =>
				({ key, sessionId, attachmentId, name, size, hash, seeded, createdAt, sentAt: sentAt ?? 0 }));
			const response = await fetchImpl(endpoint, { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-session-toolbox-key': hostKey },
				body: JSON.stringify({ type: 'vault.sync', records }) });
			if (response.status === 401) { hostKey = ''; if (attempt === 0) await syncHost(1); }
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
	async function intakeImages(sessionId, files) {
		if (!limits.enabled || sessionId === undefined || sessionId === '') return;
		const existing = (await allRecords()).filter(record => record.sessionId === sessionId && !record.sentAt);
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
		await sweep();
		if (added > 0) notice(`已备份 ${added} 张草稿图片（会话 ${sessionId.slice(-6)}）`);
		await syncHost();
		changed();
	}

	const intake = (sessionId, files) => serialize(() => intakeImages(sessionId, files));

	const readImages = event => [...(event.clipboardData?.files ?? event.dataTransfer?.files ?? [])].filter(isImageFile);
	const fileInputImages = event => {
		const target = event.target;
		if (typeof HTMLInputElement === 'undefined' || !(target instanceof HTMLInputElement) || target.type !== 'file' || target.files === null) return [];
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

	// Observe the public SessionInput state, whose lifetime spans navigation.
	// DOM thumbnails can lag behind admission and disappear on unmount; neither
	// event means that the native input has lost its attachments.
	function inputFor(sessionId) {
		try { return options.getInput?.(sessionId); }
		catch (error) { log('warn', `native input unavailable: ${error.message}`); return undefined; }
	}
	function observeInput(sessionId) {
		const input = inputFor(sessionId);
		if (!input?.store?.subscribe) return false;
		if (inputs.get(sessionId)?.store === input.store) return true;
		inputs.get(sessionId)?.dispose();
		const observation = { store: input.store, dispose: () => {} };
		const current = () => inputs.get(sessionId) === observation;
		let previous = new Set();
		const update = () => {
			if (!current()) return;
			// Copy descriptors synchronously: the host releases them after sending.
			const ids = input.store.getSnapshot()?.attachmentIds ?? [];
			const files = input.resolve(ids).filter(a => a.kind === 'image' && isImageFile(a.file)).map(a => a.file);
			void serialize(async () => {
				if (!current()) return;
				const active = new Set(await Promise.all(files.map(contentHash)));
				if (!current()) return;
				let retired = false;
				for (const record of await allRecords()) {
					if (!current()) return;
					if (record.sessionId === sessionId && !record.sentAt && previous.has(record.hash) && !active.has(record.hash)) {
						await putRecord({ ...record, sentAt: now() });
						retired = true;
					}
				}
				previous = active;
				if (!current()) return;
				if (files.length) await intakeImages(sessionId, files);
				else if (retired) { await syncHost(); changed(); }
			}).catch(error => log('warn', `native draft sync failed: ${error.message}`));
		};
		// A remount creates a new native binding. Already queued callbacks from
		// its predecessor must never re-capture files after the new input sends.
		inputs.set(sessionId, observation);
		observation.dispose = input.store.subscribe(update);
		update();
		return true;
	}

	// ---- FR2 restore -----------------------------------------------------------
	async function seedSession(sessionId = currentSession()) {
		if (!sessionId || !limits.enabled || sessionId !== currentSession()) return false;
		const editor = composerRoot();
		if (editor === undefined || seeding.has(editor)) return false;
		const rail = attachmentRail(editor);
		if (rail === undefined) return false;
		if (rail.length > 0 || (inputFor(sessionId)?.store.getSnapshot()?.attachmentIds?.length ?? 0) > 0) return true;
		seeding.add(editor);
		try {
			const delivered = seeded.get(editor) ?? new Set();
			const hashes = new Set();
			const pending = (await allRecords()).filter(record => {
				if (record.sessionId !== sessionId || record.sentAt || delivered.has(record.hash) || hashes.has(record.hash)) return false;
				hashes.add(record.hash);
				return true;
			});
			if (pending.length === 0) return true;
			const files = [];
			for (const record of pending) files.push(await blobToFile(record));
			// IndexedDB/blob reads may outlive a switch to another conversation.
			if (!limits.enabled || sessionId !== currentSession() || editor !== composerRoot() || editor.isConnected === false) return false;
			if ((attachmentRail(editor)?.length ?? 0) > 0 || (inputFor(sessionId)?.store.getSnapshot()?.attachmentIds?.length ?? 0) > 0) return true;
			const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
			Object.defineProperty(event, 'clipboardData', { value: fakeClipboardData(files) });
			Object.defineProperty(event, SEED_MARKER, { value: true });
			editor.dispatchEvent(event);
			const accepted = event.defaultPrevented === true;
			if (accepted) {
				for (const record of pending) delivered.add(record.hash);
				seeded.set(editor, delivered);
				notice(`已恢复 ${files.length} 张草稿图片（会话 ${sessionId.slice(-6)}）`);
			} else log('warn', 'synthetic paste was not accepted; backup retained for retry');
			changed();
			return accepted;
		} finally { seeding.delete(editor); }
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
				await serialize(() => retireSession(sessionId, 'sent'));
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
		let boundSession = '', boundEditor, dispose = () => {}, timer;
		const sync = () => {
			const sessionId = currentSession(), editor = composerRoot();
			if (sessionId === boundSession && editor === boundEditor) return;
			clearTimeout(timer);
			dispose();
			if (boundEditor) seeded.delete(boundEditor);
			boundSession = sessionId;
			boundEditor = editor;
			if (!sessionId || !editor) return;
			dispose = observeInput(sessionId) ? () => {} : watchSession(sessionId, editor);
			timer = setTimeout(() => void seedSession(sessionId).catch(error => log('warn', `vault seed failed: ${error.message}`)), 120);
			void sweep().catch(() => {});
		};
		sync();
		const interval = setInterval(sync, 1000);
		const observer = typeof MutationObserver === 'function' ? new MutationObserver(sync) : null;
		observer?.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-conversation-session'] });
		return () => { observer?.disconnect(); clearInterval(interval); clearTimeout(timer); dispose(); };
	}

	return {
		on: bus.on, off: bus.off,
		get lastNotice() { return lastNotice; },
		currentSession,
		records: allRecords,
		countFor: async sessionId => {
			const records = await allRecords();
			return records.filter(record => !record.sentAt && (!sessionId || record.sessionId === sessionId)).length;
		},
		start: async ({ limits: override } = {}) => {
			if (started || typeof document === 'undefined') return false;
			started = true;
			const startGeneration = ++generation;
			if (override !== undefined) limits = { ...limits, ...override };
			else {
				try {
					const res = await fetchImpl(`${options.endpoint ?? '/.well-known/dsh-session-toolbox'}`, { cache: 'no-store' });
					const next = await res.json();
					limits = { ...limits, ...(next.settings?.draftVault ?? {}) };
				} catch { /* defaults hold */ }
			}
			if (!started || generation !== startGeneration) return false;
			const capture = event => {
				if (event[SEED_MARKER] === true || observeInput(currentSession())) return;
				void intake(currentSession(), readImages(event)).catch(() => {});
			};
			document.addEventListener('paste', capture, true);
			document.addEventListener('drop', capture, true);
			const change = event => { if (!observeInput(currentSession())) void intake(currentSession(), fileInputImages(event)).catch(() => {}); };
			document.addEventListener('change', change, true);
			captureCleanup = () => {
				document.removeEventListener('paste', capture, true);
				document.removeEventListener('drop', capture, true);
				document.removeEventListener('change', change, true);
			};
			teardown = watchMounts();
			void sweep().catch(() => {});
			log('info', 'draft vault started');
			return true;
		},
		stop: () => {
			started = false; generation++; captureCleanup(); teardown?.(); teardown = null;
			for (const input of inputs.values()) input.dispose();
			inputs.clear();
		},
		setLimits: next => {
			const updated = { ...limits, ...next };
			if (JSON.stringify(updated) === JSON.stringify(limits)) return;
			limits = updated;
			void serialize(sweep).then(syncHost).catch(error => log('warn', error.message));
		},
		sweep,
		seedSession,
		/** Retire a session's unsent drafts (called when its images were sent). */
		retire: (sessionId = currentSession(), reason = 'sent') => serialize(() => retireSession(sessionId, reason)),
		syncHost,
		intake,
		watchMounts,
	};
}
