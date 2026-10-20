/**
 * Loopback management endpoint, same trust model as dsh-multi-router: exact
 * `/.well-known` route, host-header + socket must be loopback, Origin/
 * Sec-Fetch-Site cross-site rejected, writes need the per-process random key
 * the GET hands out (timing-safe compare). The handler is framework-free so the
 * host wires it into `ctx.webServer.register` and the CLI can call it directly.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const API_PATH = '/.well-known/dsh-session-toolbox';
const MAX_BODY = 4 * 1024 * 1024;

class ApiError extends Error {
	status;
	constructor(status, message) { super(message); this.status = status; }
}

const json = (res, status, value) => {
	res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
	res.end(JSON.stringify(value));
};

const hostIsLoopback = host => {
	if (!/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?$/i.test(String(host ?? ''))) return false;
	try {
		const { hostname } = new URL(`http://${host}`);
		return hostname === 'localhost' || hostname === '[::1]' || isIP(hostname) === 4 && hostname.startsWith('127.');
	} catch { return false; }
};

/**
 * @param kit - {state(): snapshot, action(input): result, move, trash, settings, vaultManifest}
 */
export function apiHandler(kit) {
	const key = randomBytes(32).toString('base64url');
	return async (req, res) => {
		try {
			const remote = req.socket?.remoteAddress;
			if (!hostIsLoopback(req.headers.host) || (remote && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote))) throw new ApiError(403, '仅允许本机请求');
			const origin = req.headers.origin;
			if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new ApiError(403, '来源无效');
			if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, '来源无效');
			if (req.method === 'GET') { json(res, 200, { ...await kit.state(), key }); return; }
			if (req.method !== 'POST') throw new ApiError(405, '方法无效');
			const actual = Buffer.from(String(req.headers['x-session-toolbox-key'] ?? '')), expected = Buffer.from(key);
			if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApiError(401, '请刷新面板后重试');
			if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] ?? ''))) throw new ApiError(415, '需要 JSON');
			let size = 0; const chunks = [];
			for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new ApiError(413, '请求过大'); chunks.push(chunk); }
			let input;
			try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'JSON 无效'); }
			if (input === null || typeof input !== 'object' || typeof input.type !== 'string') throw new ApiError(400, '缺少操作类型');
			json(res, 200, { ...await kit.action(input), key });
		} catch (error) {
			json(res, error instanceof ApiError ? error.status : 500, { error: error instanceof ApiError ? error.message : `操作失败：${error?.message ?? error}` });
		}
	};
}

/** Shared dispatch so the host, the CLI and tests all speak one vocabulary. */
export async function dispatch(kit, input) {
	if (['preflight', 'move'].includes(input.type) && (await kit.settings?.read())?.move?.enabled === false) {
		throw Object.assign(new Error('会话迁移功能已停用'), { code: 'feature-disabled' });
	}
	switch (input.type) {
		case 'nextTasks.get': return kit.nextTasks.state(String(input.sessionId ?? ''));
		case 'message.list': return kit.messages.list(String(input.sessionId ?? ''));
		case 'message.delete': {
			const result = await kit.messages.delete(String(input.sessionId ?? ''), input.seq);
			kit.nextTasks?.invalidate(String(input.sessionId ?? ''));
			return result;
		}
		case 'checkpoint.status': return await kit.checkpoints.status(String(input.sessionId ?? ''), input.seq);
		case 'checkpoint.preview': return await kit.checkpoints.preview(String(input.sessionId ?? ''), input.seq);
		case 'checkpoint.restore': return await kit.checkpoints.restore(String(input.sessionId ?? ''), input.seq, input.id);
		case 'group.create': return await kit.workspace.createGroup(input.title);
		case 'group.rename': return await kit.workspace.renameGroup(String(input.groupId ?? ''), input.title);
		case 'group.delete': return await kit.workspace.deleteGroup(String(input.groupId ?? ''));
		case 'group.assign': return await kit.workspace.assignGroup(String(input.workspaceId ?? ''), String(input.groupId ?? ''));
		case 'workspace.edit': {
			if ((await kit.settings?.read())?.move?.enabled === false && kit.workspace.row(input.workspaceId).path !== input.path) throw Object.assign(new Error('会话迁移功能已停用'), { code: 'feature-disabled' });
			return await kit.workspace.edit({ workspaceId: String(input.workspaceId ?? ''), path: input.path, title: input.title });
		}
		case 'workspace.complete': return await kit.workspace.complete();
		case 'preflight': return await kit.move.preflight({ sessionId: String(input.sessionId ?? ''), toCwd: String(input.toCwd ?? ''), createTarget: input.createTarget === true });
		case 'move': return await kit.move.move(await kit.move.preflight({ sessionId: String(input.sessionId ?? ''), toCwd: String(input.toCwd ?? ''), createTarget: input.createTarget === true }));
		case 'move.rollback': return await kit.move.rollback();
		case 'move.complete': return await kit.move.complete();
		case 'trash.list': return { items: await kit.trash.items() };
		case 'trash.session': return await kit.trash.trashSession(String(input.sessionId ?? ''), { force: input.force === true });
		case 'trash.workspace': return await kit.trash.trashWorkspace(String(input.workspaceId ?? ''), { force: input.force === true });
		case 'trash.restore': return await kit.trash.restore(String(input.itemId ?? ''));
		case 'trash.purge': return await kit.trash.purge(String(input.itemId ?? ''));
		case 'trash.sweep': return await kit.trash.sweep();
		case 'project.of': return { project: await kit.projectOf(String(input.sessionId ?? '')) };
		case 'settings.update': return { settings: await kit.updateSettings(input.patch ?? {}) };
		case 'vault.sync': return { records: (await kit.vaultSync(Array.isArray(input.records) ? input.records : [])).records.length };
		case 'vault.sweep': {
			const settings = await kit.settings.read();
			const ttlMs = (settings.draftVault?.ttlDays ?? 7) * 24 * 60 * 60 * 1000;
			const manifest = await kit.manifest.update(current => ({
				version: 1,
				records: current.records.filter(record => Date.now() - (record.createdAt ?? 0) <= ttlMs),
			}));
			return { records: manifest.records.length };
		}
		default: throw new Error(`未知的操作类型：${input.type}`);
	}
}
