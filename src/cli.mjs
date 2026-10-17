/**
 * CLI: run moves/trash maintenance while DSH is stopped, or when no host is
 * available. Ledger operations here mirror `hostCapabilities().moveLedger`
 * against `~/.dsh/storages/workspace.json` directly (offline mode), with the
 * same two-step order (source detach → target create/attach) and the registry
 * invariants preserved (§10 MR2 step 2, §11.1-2).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { MoveEngine } from './move.mjs';
import { TrashEngine } from './trash.mjs';
import { guardJournal, guardLedger, JsonDocument } from './store.mjs';
import { writeOwned } from './move.mjs';
import { encodeSegment, projectKey } from './paths.mjs';
import { apiHandler, dispatch } from './api.mjs';

export const defaultKitRoot = () => join(resolveDshHome(), 'session-kit');

/** Offline ledger over workspace.json (host stopped). */
export class OfflineLedger {
	constructor(workspaceFile) {
		this.file = workspaceFile;
	}
	async #read() {
		try { return JSON.parse(await readFile(this.file, 'utf8')); }
		catch (error) { if (error.code === 'ENOENT') return { unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } }; throw error; }
	}
	#write(state) { return writeOwned(this.file, JSON.stringify(state, null, 2), 0o600); }
	async moveLedger(sessionId, fromCwd, toCwd) {
		const state = await this.#read();
		const workspaces = state.tables?.workspaces ?? {};
		for (const [id, record] of Object.entries(workspaces)) {
			if (record.sessionIds.includes(sessionId)) record.sessionIds = record.sessionIds.filter(row => row !== sessionId);
		}
		const target = Object.entries(workspaces).find(([, record]) => record.path === toCwd);
		if (target === undefined) {
			const id = crypto.randomUUID();
			workspaces[id] = { path: toCwd, title: (toCwd.split('/').filter(Boolean).at(-1) ?? toCwd), sessionIds: [sessionId], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
			state.global.workspaceIds.unshift(id);
		} else {
			const [id, record] = target;
			if (!record.sessionIds.includes(sessionId)) record.sessionIds.unshift(sessionId);
			record.updatedAt = new Date().toISOString();
		}
		await this.#write(state);
	}
	async resyncIndex() { return 'skipped-offline'; }
	async listStoredHeaders() {
		const state = await this.#read();
		return Object.values(state.tables?.workspaces ?? {}).flatMap(record => record.sessionIds.map(id => ({ id, cwd: record.path })));
	}
}

export function buildKit({ root = defaultKitRoot(), dshHome = resolveDshHome(), ledger = new OfflineLedger(join(dshHome, 'storages', 'workspace.json')), now = () => Date.now() } = {}) {
	const settingsDoc = new JsonDocument(root, 'session-kit.json', { version: 1 });
	const journalDoc = new JsonDocument(root, 'journal.json', { version: 1, active: null }, guardJournal);
	const ledgerDoc = new JsonDocument(root, 'trash.json', { version: 1, items: [] }, guardLedger);
	const manifestDoc = new JsonDocument(root, 'vault-manifest.json', { version: 1, records: [] });
	let lastSettings = { trash: {} };
	const move = new MoveEngine({
		root,
		sessionsRoot: join(dshHome, 'sessions'),
		projcacheRoot: join(dshHome, 'storages', 'session_projcache', 'sessions'),
		journal: journalDoc,
		capabilities: { listHeaders: () => ledger.listStoredHeaders(), moveLedger: (...args) => ledger.moveLedger(...args), resyncIndex: () => ledger.resyncIndex() },
		now,
	});
	const trash = new TrashEngine({
		adapter: offlineAdapter(ledger),
		sessionsRoot: join(dshHome, 'sessions'),
		projcacheRoot: join(dshHome, 'storages', 'session_projcache', 'sessions'),
		kitRoot: root,
		ledger: ledgerDoc,
		journal: () => null,
		settings: () => lastSettings.trash ?? {},
		now,
	});
	const kit = {
		move, trash, journalDoc, settingsDoc, manifestDoc,
		updateSettings: async patch => { const next = await settingsDoc.update(current => ({ ...current, ...patch })); lastSettings = next; return next; },
		state: async () => ({
			pluginVersion: 'cli', settings: await settingsDoc.read(),
			journal: (await journalDoc.read()).active, trash: await trash.items(),
		}),
		action: input => dispatch(kit, input),
	};
	return kit;
}

function offlineAdapter(ledger) {
	return {
		sessionKnown: async () => true,
		archivedSet: async () => new Set(),
		pinnedSet: async () => new Set(),
		locateSession: async () => ({ workspaceId: null, beforeId: null, title: null }),
		workspaceSnapshot: async () => undefined,
		archiveSession: async () => { throw new Error('offline trash sessions require a running DSH for archive semantics'); },
		unarchiveSession: async () => {},
		pinSession: async () => {},
		unpinSession: async () => {},
		deleteWorkspace: async () => {},
		repairSlot: async () => {},
		restoreWorkspace: async () => {},
		purgeSession: async () => 'offline',
	};
}

const USAGE = `dsh-session-kit — 草稿保险箱 / 会话切换项目 / 回收站（CLI：在 DSH 停止时执行离线维护）

用法：
  dsh-session-kit status
  dsh-session-kit move --session <session-…> --to <绝对路径> [--create] [--root <kit目录>]
  dsh-session-kit recover            # 完成(前滚)被中断的迁移；先尝试，失败再回滚
  dsh-session-kit rollback
  dsh-session-kit trash-purge --item <itemId>

注意：CLI 直写 <DSH_HOME>/storages/workspace.json 作为离线账本镜像；运行中的
DSH 请优先通过插件面板操作（宿主 RPC 与内存索引更准）。执行 move 前请完全退出
DSH，move 完成后重启一次，宿主会按新的 header 重建索引。`;

export async function main(argv) {
	const { parseArgs } = await import('node:util');
	const { values, positionals } = parseArgs({ args: argv, options: {
		session: { type: 'string' }, to: { type: 'string' }, root: { type: 'string' }, create: { type: 'boolean' },
		item: { type: 'string' }, 'dry-run': { type: 'boolean' },
	}, allowPositionals: true });
	const command = positionals[0];
	const kit = buildKit({ root: values.root });
	const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
	try {
		switch (command) {
			case 'status': print(await kit.state()); return 0;
			case 'move': {
				if (!values.session || !values.to) throw new Error('需要 --session 与 --to');
				if (values['dry-run']) { print({ plan: await kit.move.preflight({ sessionId: values.session, toCwd: values.to, createTarget: values.create === true }) }); return 0; }
				print(await kit.action({ type: 'move', sessionId: values.session, toCwd: values.to, createTarget: values.create === true }));
				return 0;
			}
			case 'recover': {
				try { print(await kit.move.complete()); }
				catch (error) { print({ completedFailed: String(error?.message ?? error), rollback: await kit.move.rollback() }); }
				return 0;
			}
			case 'rollback': print(await kit.move.rollback()); return 0;
			case 'trash-purge': {
				if (!values.item) throw new Error('需要 --item');
				print(await kit.trash.purge(values.item));
				return 0;
			}
			default: process.stderr.write(`${USAGE}\n`); return command === undefined ? 0 : 2;
		}
	} catch (error) {
		process.stderr.write(`${JSON.stringify({ error: String(error?.message ?? error), code: error?.code, journal: error?.journal })}\n`);
		return 1;
	}
}

export { apiHandler };

if (process.argv[1] !== undefined && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
	process.exitCode = await main(process.argv.slice(2));
}
