import test from 'node:test';
import assert from 'node:assert/strict';
import { createVault as createVaultImpl, isImageFile, contentHash, MAX_FILE_BYTES, DEFAULT_LIMITS } from '../src/draft-vault.js';
import { translate } from '../src/locale.mjs';

const vaults = [];
function createVault(options) { const vault = createVaultImpl(options); vaults.push(vault); return vault; }

/** ---- minimal browser doubles (Node has File/Blob but no DOM/IndexedDB) ---- */
class FakeClipboardEvent {
	constructor(type, init = {}) {
		this.type = type;
		this.bubbles = init.bubbles === true;
		this.cancelable = init.cancelable !== false;
		this.defaultPrevented = false;
		this.target = undefined;
	}
	preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
}

function makeIndexedDb() {
	const tables = new Map();
	const storeFor = name => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
	return {
		open() {
			const request = {};
			setImmediate(() => {
				request.result = {
					objectStoreNames: { contains: () => true },
					createObjectStore: () => ({}),
					transaction(store) {
						const map = storeFor(store);
						const tx = { oncomplete: null, onerror: null, onabort: null };
						const objectStore = {
							put(value) { const r = request2(clone(value), tx); map.set(value.key, clone(value)); return r; },
							delete(key) { const r = request2(true, tx); map.delete(key); return r; },
							getAll() { return request2([...map.values()].map(clone), tx); },
						};
						return Object.assign(tx, { objectStore: () => objectStore });
					},
				};
				request.onupgradeneeded?.();
				request.onsuccess?.();
			});
			return request;
		},
	};
	function request2(value, tx) {
		const request = { result: value };
		setImmediate(() => { request.onsuccess?.(); setImmediate(() => tx.oncomplete?.()); });
		return request;
	}
	function clone(record) { return { ...record }; }
}

/**
 * Composer stub shaped like the real DOM: the composer seat
 * (`[data-composer-seat]`, also carrying `data-conversation-region="composer"`)
 * holds the attachment cards, and the conversation scope sits above it. The old
 * stub only answered the `conversation-content` selector, so every attachment
 * lookup silently used the parentElement fallback and the vault could never see
 * the cards — which is exactly why the first duplicate-image fix missed.
 */
function makeEditor(railImgs = []) {
	const listeners = [];
	const seat = {
		querySelectorAll: selector => selector === 'img' ? railImgs : [],
	};
	const scope = { isConnected: true, querySelectorAll: () => [] };
	return {
		listeners,
		isConnected: true,
		addEventListener: (type, fn) => { if (type === 'paste') listeners.push(fn); },
		dispatchEvent(event) {
			event.target = this;
			for (const fn of listeners) fn(event);
			return event.defaultPrevented;
		},
		focus() {},
		closest: selector => {
			if (selector.includes('composer-seat') || selector.includes('conversation-region')) return seat;
			if (selector.includes('conversation-content')) return scope;
			return undefined;
		},
		parentElement: { parentElement: { parentElement: { querySelectorAll: () => railImgs } } },
	};
}

/** The official handler contract as a test double: items→getAsFile→preventDefault. */
function officialPasteHandler(editor, taken) {
	editor.addEventListener('paste', event => {
		const data = event.clipboardData;
		if (data === undefined) return;
		const files = [...data.items].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
		if (files.length > 0) { taken.push(...files); event.preventDefault(); }
	});
}

function browser(editor, sessionId = 'session-aaaa') {
	const saved = { paste: [], drop: [], change: [] };
	globalThis.ClipboardEvent = FakeClipboardEvent;
	globalThis.indexedDB = makeIndexedDb();
	globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true };
	globalThis.document = {
		addEventListener: (type, fn) => { (saved[type] ??= []).push(fn); },
		removeEventListener() {},
		querySelector: selector => selector === '[data-conversation-session]'
			? (editor === undefined ? null : { getAttribute: () => sessionId })
			: selector === '[data-conversation-session] [contenteditable="true"]' ? editor : null,
		documentElement: {},
	};
	return saved;
}
function teardown() {
	delete globalThis.ClipboardEvent;
	delete globalThis.indexedDB;
	delete globalThis.window;
	delete globalThis.document;
	delete globalThis.MutationObserver;
}
const pngFile = (name = 'shot.png', size = 1024) => new File([new Uint8Array(size)], name, { type: 'image/png' });

test.afterEach(() => { for (const vault of vaults.splice(0)) vault.stop(); teardown(); });

test('isImageFile accepts the four official types up to 10MB', () => {
	assert.equal(isImageFile(pngFile()), true);
	assert.equal(isImageFile(new File(['x'], 'a.txt', { type: 'text/plain' })), false);
	const huge = pngFile('big.png');
	Object.defineProperty(huge, 'size', { value: MAX_FILE_BYTES + 1 });
	assert.equal(isImageFile(huge), false);
	assert.equal(isImageFile(new File([], 'e.png', { type: 'image/png' })), false);
});

test('contentHash is deterministic for identical bytes', async () => {
	const a = await contentHash(pngFile('a.png'));
	const b = await contentHash(pngFile('b.png'));
	assert.match(a, /^[0-9a-f]{64}$/);
	assert.equal(a, b);
});

test('capture listeners register at document level; intake persists to IndexedDB', async () => {
	const editor = makeEditor();
	const saved = browser(editor);
	const vault = createVault({ endpoint: '/api', log: () => {}, fetchImpl: async () => Response.json({ settings: {}, key: 'k' }) });
	const ok = await vault.start({ limits: { enabled: true } });
	assert.equal(ok, true);
	assert.ok(saved.paste.length > 0 && saved.drop.length > 0 && saved.change.length > 0);
	await vault.intake('session-aaaa', [pngFile(), new File(['x'], 'a.txt', { type: 'text/plain' })]);
	const records = await vault.records();
	assert.equal(records.length, 1, 'only the image is vaulted');
	assert.equal(records[0].sessionId, 'session-aaaa');
	assert.equal(records[0].blob instanceof File, true);
	vault.stop();
});

test('draft notices use the live plugin language without changing saved records', async () => {
 browser(makeEditor()); let language = 'en';
 const vault = createVault({ t: (key, values) => translate(language, key, values), fetchImpl: async () => Response.json({ settings: {}, key: 'k' }) });
 await vault.start(); await vault.intake('session-aaaa', [pngFile()]);
 assert.match(vault.lastNotice, /Backed up 1/);
 language = 'zh'; assert.match(vault.lastNotice, /已备份 1/);
 assert.equal((await vault.records()).length, 1);
});

test('seedSession replays a synthetic ClipboardEvent the official handler accepts', async () => {
	const editor = makeEditor();
	browser(editor);
	globalThis.MutationObserver = class { observe() {} disconnect() {} };
	const vault = createVault({ endpoint: '/api', log: () => {}, fetchImpl: async () => Response.json({ settings: {}, key: 'k' }) });
	await vault.start({ limits: { enabled: true } });
	await vault.intake('session-aaaa', [pngFile('x.png')]);
	const taken = [];
	officialPasteHandler(editor, taken);
	const accepted = await vault.seedSession('session-aaaa');
	assert.equal(accepted, true, 'synthetic clipboardData.items must satisfy the official handler');
	assert.equal(taken.length, 1);
	assert.equal(taken[0].type, 'image/png');
	assert.equal(taken[0].name, 'x.png');
	vault.stop();
});

test('intake dedupes identical bytes for the same session', async () => {
	const editor = makeEditor();
	browser(editor);
	const vault = createVault({ endpoint: '/api', log: () => {}, fetchImpl: async () => Response.json({ settings: {}, key: 'k' }) });
	await vault.start({ limits: { enabled: true } });
	await vault.intake('session-aaaa', [pngFile('same.png')]);
	await vault.intake('session-aaaa', [pngFile('same-copy.png')]);
	assert.equal((await vault.records()).length, 1, 'the same image must not be vaulted twice');
	await vault.intake('session-aaaa', [new File([new Uint8Array(2048)], 'other.png', { type: 'image/png' })]);
	assert.equal((await vault.records()).length, 2, 'a different image still lands');
	vault.stop();
});

test('restoring a draft does not re-capture it as a fresh copy', async () => {
	const editor = makeEditor();
	const saved = browser(editor);
	globalThis.MutationObserver = class { observe() {} disconnect() {} };
	const vault = createVault({ endpoint: '/api', log: () => {}, fetchImpl: async () => Response.json({ settings: {}, key: 'k' }) });
	await vault.start({ limits: { enabled: true } });
	await vault.intake('session-aaaa', [pngFile('only.png')]);
	assert.equal(saved.paste.length, 1, 'one document-level paste listener');

	// What seedSession dispatches: a marked synthetic paste carrying the same image.
	const restoreMarker = Symbol.for('dsh-session-toolbox.seed');
	const replay = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
	Object.defineProperty(replay, 'clipboardData', { value: { files: [pngFile('only.png')], items: [] } });
	Object.defineProperty(replay, restoreMarker, { value: true });
	for (const listener of saved.paste) listener(replay);
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal((await vault.records()).length, 1, 'a marked replay must not be stored again');

	// A genuine user paste of the same bytes is also deduped.
	const genuine = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
	Object.defineProperty(genuine, 'clipboardData', { value: { files: [pngFile('only.png')], items: [] } });
	for (const listener of saved.paste) listener(genuine);
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal((await vault.records()).length, 1, 'identical bytes never duplicate');
	vault.stop();
});

test('composer attachments are detected through the real seat structure', async () => {
	// Cards live inside [data-composer-seat]; the vault must see them, otherwise
	// "sent" can never be detected and drafts get replayed on every switch.
	const cards = [{ getAttribute: () => 'blob:https://x/1' }, { getAttribute: () => 'blob:https://x/2' }];
	const editor = makeEditor(cards);
	browser(editor);
	globalThis.MutationObserver = class { observe() {} disconnect() {} };
	const vault = createVault({ endpoint: '/api', log: () => {}, fetchImpl: async () => Response.json({ settings: {}, key: 'k' }) });
	await vault.start({ limits: { enabled: true } });
	// A non-empty composer must not be seeded into (official still holds the cards).
	await vault.intake('session-aaaa', [pngFile('held.png')]);
	const accepted = await vault.seedSession('session-aaaa');
	assert.equal(accepted, true);
	const records = await vault.records();
	assert.equal(records.length, 1);
	assert.equal(records[0].delivered ?? 0, 0, 'nothing was handed to the composer');
	vault.stop();
});

test('a draft that was sent is never replayed into the composer again', async () => {
	const editor = makeEditor();
	browser(editor);
	globalThis.MutationObserver = class { observe() {} disconnect() {} };
	const vault = createVault({ endpoint: '/api', log: () => {}, fetchImpl: async () => Response.json({ settings: {}, key: 'k' }) });
	await vault.start({ limits: { enabled: true } });
	await vault.intake('session-aaaa', [pngFile('sent.png')]);
	assert.equal((await vault.records()).length, 1);
	// The message goes out: the vault retires the backup (sentAt set).
	await vault.retire('session-aaaa');
	assert.equal((await vault.records())[0].sentAt > 0, true, 'record must be marked sent');
	// Switching away and back must not resurrect it, even though the rail is empty.
	const taken = [];
	officialPasteHandler(editor, taken);
	const accepted = await vault.seedSession('session-aaaa');
	assert.equal(taken.length, 0, 'a sent image must not be pasted back');
	assert.equal(accepted, true, 'nothing to restore is a success, not a failure');
	vault.stop();
});

test('seedSession refuses a non-empty rail and is a no-op with an empty vault', async () => {
	const editor = makeEditor([{ getAttribute: () => 'blob:http://x' }]);
	browser(editor);
	globalThis.MutationObserver = class { observe() {} disconnect() {} };
	const vault = createVault({ endpoint: '/api', log: () => {}, fetchImpl: async () => Response.json({ settings: {}, key: 'k' }) });
	await vault.start({ limits: { enabled: true } });
	// Non-empty rail: the official registry still holds the images; seeding is a no-op that must report success (idempotent).
	assert.equal(await vault.seedSession('session-aaaa'), true, 'non-empty rail means official still holds them');
	await vault.intake('session-aaaa', [pngFile()]);
	assert.equal(await vault.seedSession('session-aaaa'), true, 'still refuses to double-seed');
	vault.stop();
});

test('a disabled vault neither captures nor seeds', async () => {
	const editor = makeEditor();
	browser(editor);
	globalThis.MutationObserver = class { observe() {} disconnect() {} };
	const vault = createVault({ endpoint: '/api', log: () => {}, fetchImpl: async () => Response.json({ settings: { draftVault: { enabled: false } }, key: 'k' }) });
	await vault.start();
	await vault.intake('session-aaaa', [pngFile()]);
	assert.equal((await vault.records()).length, 0);
	assert.equal(await vault.seedSession('session-aaaa'), false);
	vault.stop();
});

test('sweep enforces TTL then LRU capacity', async () => {
	browser(makeEditor());
	globalThis.MutationObserver = class { observe() {} disconnect() {} };
	let clock = 1_000_000;
	const vault = createVault({ endpoint: '/api', now: () => clock, log: () => {}, fetchImpl: async () => Response.json({ settings: {}, key: 'k' }) });
	await vault.start({ limits: { enabled: true, ttlDays: 1, maxSizeBytes: 2048 } });
	// distinct bytes: identical images are deduped per session (§ draft intake)
	const distinct = (name, seed) => new File([new Uint8Array(1024).fill(seed)], name, { type: 'image/png' });
	await vault.intake('s1', [distinct('a.png', 1), distinct('b.png', 2)]);
	clock += 2 * 24 * 60 * 60 * 1000; // past TTL
	const expired = await vault.sweep();
	assert.equal(expired.removed, 2);
	await vault.intake('s2', [distinct('c.png', 3), distinct('d.png', 4), distinct('e.png', 5)]);
	const overCap = await vault.sweep();
	assert.equal((await vault.records()).filter(record => record.sessionId === 's2').length, 2, 'capacity is enforced during intake');
	assert.ok(overCap.bytes <= 2048);
	vault.stop();
});

test('defaults match the spec (200MB / 7 days / enabled)', () => {
	assert.equal(DEFAULT_LIMITS.enabled, true);
	assert.equal(DEFAULT_LIMITS.maxSizeBytes, 200 * 1024 * 1024);
	assert.equal(DEFAULT_LIMITS.ttlDays, 7);
});

test('an unsent image can be restored again after refreshing the browser', async () => {
	const editor = makeEditor();
	browser(editor);
	const options = { fetchImpl: async () => Response.json({ settings: {}, key: 'k' }) };
	const first = createVault(options);
	const taken = [];
	officialPasteHandler(editor, taken);
	await first.intake('session-aaaa', [pngFile()]);
	await first.seedSession('session-aaaa');
	const reloaded = createVault(options); // same IndexedDB, fresh browser lifecycle
	await reloaded.seedSession('session-aaaa');
	assert.equal(taken.length, 2, 'unsent backup must survive more than one restore');
});

test('pasting the same image after sending creates a new pending draft', async () => {
	browser(makeEditor());
	const vault = createVault();
	await vault.intake('session-aaaa', [pngFile()]);
	await vault.retire('session-aaaa');
	await vault.intake('session-aaaa', [pngFile()]);
	assert.equal((await vault.records()).filter(record => !record.sentAt).length, 1);
});

test('stop removes capture listeners and restart does not duplicate them', async () => {
	const saved = browser(makeEditor());
	document.removeEventListener = (type, listener) => { saved[type] = saved[type].filter(fn => fn !== listener); };
	const vault = createVault({ fetchImpl: async () => Response.json({ settings: {}, key: 'k' }) });
	await vault.start();
	vault.stop();
	assert.equal(saved.paste.length + saved.drop.length + saved.change.length, 0);
	await vault.start();
	vault.stop();
});

function nativeInput() {
	let attachments = [];
	const listeners = new Set();
	return {
		store: { getSnapshot: () => ({ attachmentIds: attachments.map(a => a.id) }), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } },
		resolve: () => attachments,
		set(next) { attachments = next; for (const listener of listeners) listener(); },
	};
}
const settle = () => new Promise(resolve => setTimeout(resolve, 40));

test('native input clears sent screenshots even after the conversation unmounts', async () => {
	browser(makeEditor());
	const input = nativeInput();
	const vault = createVault({ getInput: () => input, fetchImpl: async () => Response.json({ key: 'k' }) });
	await vault.start({ limits: {} });
	input.set([{ id: 'native-1', kind: 'image', file: pngFile() }]);
	await settle();
	assert.equal(await vault.countFor('session-aaaa'), 1);
	// Unmounting the visible composer must not stop the native input listener.
	document.querySelector = () => null;
	input.set([]);
	await settle();
	assert.equal(await vault.countFor('session-aaaa'), 0, 'sent screenshots cannot return on the next switch');
});

test('native drafts prevent duplicate restore before image thumbnails have rendered', async () => {
	const editor = makeEditor();
	browser(editor);
	const input = nativeInput();
	input.set([{ id: 'native-1', kind: 'image', file: pngFile() }]);
	const vault = createVault({ getInput: () => input });
	await vault.intake('session-aaaa', [pngFile()]);
	const taken = [];
	officialPasteHandler(editor, taken);
	await vault.seedSession();
	assert.equal(taken.length, 0, 'native attachment ids are authoritative while the DOM rail is still empty');
});

test('native removal retires only the removed image and failed-send restoration backs it up again', async () => {
	browser(makeEditor());
	const input = nativeInput();
	const a = { id: 'a', kind: 'image', file: pngFile() };
	const b = { id: 'b', kind: 'image', file: pngFile('b.png', 2048) };
	const vault = createVault({ getInput: () => input, fetchImpl: async () => Response.json({ key: 'k' }) });
	await vault.start({ limits: {} });
	const waitForCount = async expected => {
		const deadline = Date.now() + 1000;
		while (await vault.countFor('session-aaaa') !== expected && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
		assert.equal(await vault.countFor('session-aaaa'), expected);
	};
	input.set([a, b]); await waitForCount(2);
	input.set([b]); await waitForCount(1);
	assert.equal(await vault.countFor('session-aaaa'), 1);
	input.set([]); await waitForCount(0);
	input.set([b]); await waitForCount(1); // native failed-send path restores its rail
	assert.equal(await vault.countFor('session-aaaa'), 1);
});

test('native attachments admitted during an IndexedDB restore are not pasted twice', async () => {
	const editor = makeEditor(); browser(editor);
	const input = nativeInput();
	const vault = createVault({ getInput: () => input });
	await vault.intake('session-aaaa', [pngFile()]);
	const taken = []; officialPasteHandler(editor, taken);
	const pending = vault.seedSession();
	input.set([{ id: 'admitted-while-reading', kind: 'image', file: pngFile() }]);
	await pending;
	assert.equal(taken.length, 0);
});

test('a released input binding cannot re-backup an image sent by its replacement', async () => {
	const saved = browser(makeEditor());
	const old = nativeInput(), replacement = nativeInput();
	const image = { id: 'old-id', kind: 'image', file: pngFile('already-sent.png') };
	old.set([image]);
	let lateNotification;
	const subscribe = old.store.subscribe;
	old.store.subscribe = listener => { lateNotification = listener; return subscribe(listener); };
	let current = old;
	const vault = createVault({ getInput: () => current, fetchImpl: async () => Response.json({ key: 'k' }) });
	await vault.start(); await settle();
	assert.equal(await vault.countFor('session-aaaa'), 1);

	// Navigation replaces the native Session binding. Its imported draft has
	// fresh attachment ids; a queued notification can still hold the old input.
	replacement.set([{ ...image, id: 'replacement-id' }]);
	current = replacement;
	saved.paste[0](new ClipboardEvent('paste'));
	await settle();
	replacement.set([]); await settle();
	assert.equal(await vault.countFor('session-aaaa'), 0);
	lateNotification(); await settle();
	assert.equal(await vault.countFor('session-aaaa'), 0, 'a stale input callback must not resurrect the sent backup');
});
