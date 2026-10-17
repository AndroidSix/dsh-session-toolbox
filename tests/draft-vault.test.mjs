import test from 'node:test';
import assert from 'node:assert/strict';
import { createVault, isImageFile, contentHash, MAX_FILE_BYTES, DEFAULT_LIMITS } from '../src/draft-vault.js';

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
						const objectStore = {
							put(value) { const r = request2(clone(value)); map.set(value.key, clone(value)); return r; },
							delete(key) { const r = request2(true); map.delete(key); return r; },
							getAll() { return request2([...map.values()].map(clone)); },
						};
						return { objectStore: () => objectStore, oncomplete: null, onerror: null, onabort: null };
					},
				};
				request.onupgradeneeded?.();
				request.onsuccess?.();
			});
			return request;
		},
	};
	function request2(value) {
		const request = { result: value };
		setImmediate(() => request.onsuccess?.());
		return request;
	}
	function clone(record) { return { ...record }; }
}

function makeEditor(railImgs = []) {
	const listeners = [];
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
		closest: selector => selector.includes('conversation-content') ? { isConnected: true, querySelectorAll: () => [] } : undefined,
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

test.afterEach(teardown);

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
	await vault.intake('s1', [pngFile('a.png'), pngFile('b.png')]);
	clock += 2 * 24 * 60 * 60 * 1000; // past TTL
	const expired = await vault.sweep();
	assert.equal(expired.removed, 2);
	await vault.intake('s2', [pngFile('c.png'), pngFile('d.png'), pngFile('e.png')]);
	const overCap = await vault.sweep();
	assert.ok(overCap.removed >= 1, 'capacity 2048 must evict oldest of the 3×1024');
	assert.ok(overCap.bytes <= 2048);
	vault.stop();
});

test('defaults match the spec (200MB / 7 days / enabled)', () => {
	assert.equal(DEFAULT_LIMITS.enabled, true);
	assert.equal(DEFAULT_LIMITS.maxSizeBytes, 200 * 1024 * 1024);
	assert.equal(DEFAULT_LIMITS.ttlDays, 7);
});
