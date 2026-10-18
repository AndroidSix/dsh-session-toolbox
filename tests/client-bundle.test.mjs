import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Contract test for the built client bundle: it must load under DSH's browser
 * module loader (`window.__ModuleLoader__.load({id, factory})`), export the
 * cordis plugin shape, and register the expected slots. Runs in a bare vm
 * context offering only browser globals — anything sneaking Node built-ins in
 * fails loudly, like a hardened renderer would.
 */
function loadSandbox() {
	const loaded = [];
	return {
		loaded,
		sandbox: vm.createContext({
			console,
			setTimeout: () => 0,
			clearTimeout: () => {},
			setInterval: () => 0,
			clearInterval: () => {},
			CustomEvent: class { },
			URL: globalThis.URL,
			fetch: async () => { throw new Error('offline test'); },
			window: { __ModuleLoader__: { load: entry => loaded.push(entry) }, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true },
		}),
	};
}

async function clientSource() {
	return readFile(join(root, 'lib', 'client.js'), 'utf8');
}

async function loadClient() {
	const { loaded, sandbox } = loadSandbox();
	vm.runInContext(await clientSource(), sandbox);
	return loaded[0];
}

test('client bundle carries the module-loader envelope', async () => {
	const source = await clientSource();
	assert.ok(source.startsWith('window.__ModuleLoader__.load({'), 'must be the loader envelope first');
	assert.match(source, /id:\s*"dsh-session-toolbox"/);
	assert.ok(source.includes('return module.exports'), 'factory must return exports');
});

test('client plugin exports name/inject/apply and registers the expected slots', async () => {
	const entry = await loadClient();
	assert.equal(entry.id, 'dsh-session-toolbox');
	const react = { createElement: () => null, Fragment: 'Fragment', useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }) };
	const plugin = entry.factory(id => {
		if (id === 'react') return react;
		if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' };
		throw new Error(`unexpected require: ${id}`);
	});
	assert.equal(typeof plugin.apply, 'function');
	assert.equal(plugin.inject.includes('slots'), true);
	// cordis throws on property access for a service that was never injected, so
	// every service the client touches must be declared here (locale included).
	assert.equal(plugin.inject.includes('locale'), true, 'locale must be injected before ctx.locale is read');
	const registered = [];
	// Strict context: mirrors cordis' reflect handler, where reading a service
	// property that was never injected throws instead of yielding undefined.
	// This is what caught the shipped "cannot get property \"locale\" without
	// inject" failure on the plugin page.
	const builtins = {
		get: () => undefined,
		effect: cb => { cb(); },
		inject: () => () => {},
		provide: () => {},
		on: () => () => {},
	};
	const services = {
		slots: { inject: (name, fn) => { fn(); }, register: spec => { registered.push(spec); return () => {}; } },
		locale: { register: () => () => {} },
	};
	const ctx = new Proxy(builtins, {
		get(target, prop) {
			if (typeof prop === 'symbol' || prop === 'then' || String(prop).startsWith('_')) return Reflect.get(target, prop);
			if (Reflect.has(target, prop)) return Reflect.get(target, prop);
			if (plugin.inject.includes(prop)) return services[prop];
			throw new Error(`cannot get property "${String(prop)}" without inject`);
		},
	});
	plugin.apply(ctx);
	const names = new Set(registered.map(row => row.name));
	assert.deepEqual(names, new Set(['plugins.bundle.config', 'sidebar.workspaces.session.menu.item', 'conversation.input.dock']));
	assert.ok(registered.some(r => r.name === 'sidebar.workspaces.session.menu.item' && r.id === 'session-toolbox-move'));
	assert.ok(registered.some(r => r.name === 'sidebar.workspaces.session.menu.item' && r.id === 'session-toolbox-trash'));
	assert.ok(registered.some(r => r.name === 'plugins.bundle.config' && r.key === 'dsh-session-toolbox'));
	assert.ok(registered.some(r => r.name === 'conversation.input.dock' && r.id === 'session-toolbox-vault-badge'));
});

test('client bundle never references Node-only globals', async () => {
	const source = await clientSource();
	assert.equal(/process\.[a-zA-Z]/.test(source), false, 'no process.*');
	assert.equal(/__dirname|__filename/.test(source), false, 'no __dirname/__filename');
	assert.equal(/require\(["']node:/.test(source), false, 'no node: specifiers');
	// Only the two browser-safe externals may be required; assert exact set.
	const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]);
	assert.deepEqual([...new Set(required)].sort(), ['react', 'react/jsx-runtime']);
});
