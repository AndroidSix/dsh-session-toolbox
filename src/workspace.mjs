import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { orderedGroups, UNGROUPED } from './group-order.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function titleOf(value) {
	if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) fail('bad-name', '名称不能为空，且最多 80 个字符 / Name must contain 1–80 characters');
	return value.trim();
}

export function guardGroups(value) {
	if (value.version !== 1 || !Array.isArray(value.groups)) fail('groups-invalid', '项目分组数据格式无效');
	if (value.ungroupedIndex !== undefined && (!Number.isInteger(value.ungroupedIndex) || value.ungroupedIndex < 0 || value.ungroupedIndex > value.groups.length)) fail('groups-invalid', '未分组排序位置无效');
	const ids = new Set(), members = new Set();
	for (const group of value.groups) {
		if (typeof group.id !== 'string' || !group.id || group.id === UNGROUPED || ids.has(group.id) || !Array.isArray(group.workspaceIds)) fail('groups-invalid', '项目分组数据格式无效');
		titleOf(group.title); ids.add(group.id);
		for (const id of group.workspaceIds) {
			if (typeof id !== 'string' || !id || members.has(id)) fail('groups-invalid', '项目分组包含重复或无效项目');
			members.add(id);
		}
	}
	return value;
}

export function guardWorkspaceJournal(value) {
	if (value.version !== 1 || value.active !== null && (!value.active || typeof value.active.workspaceId !== 'string' || typeof value.active.fromCwd !== 'string' || typeof value.active.toCwd !== 'string' || typeof value.active.title !== 'string' || !Array.isArray(value.active.sessionIds) || !Array.isArray(value.active.moved))) fail('workspace-journal-invalid', '项目迁移日志无效，请保留文件并检查');
	return value;
}

/** Plugin groups + a resumable sequence of the existing journaled session moves. */
export class WorkspaceTools {
	constructor({ registry, move, groups, journal, ledger }) { Object.assign(this, { registry, move, groups, journal, ledger }); }
	async active() { return (await this.journal.read()).active; }
	async assertIdle() { if (await this.active()) fail('workspace-moving', '项目路径迁移尚未完成，请先继续迁移 / Resume the pending project move first'); }
	row(id) {
		const row = this.registry()?.get(id);
		if (!row) fail('workspace-unknown', '未找到该项目 / Workspace not found');
		return row;
	}
	async createGroup(title) {
		title = titleOf(title);
		const group = { id: randomUUID(), title, workspaceIds: [] };
		await this.groups.update(state => {
			if (state.groups.some(row => row.title === title)) fail('group-exists', '分组名称已存在 / Group name exists');
			return { ...state, groups: [...state.groups, group], ...(state.ungroupedIndex === state.groups.length ? { ungroupedIndex: state.ungroupedIndex + 1 } : {}) };
		});
		return group;
	}
	async renameGroup(id, title) {
		title = titleOf(title);
		await this.groups.update(state => {
			if (!state.groups.some(row => row.id === id)) fail('group-unknown', '分组不存在 / Group not found');
			if (state.groups.some(row => row.id !== id && row.title === title)) fail('group-exists', '分组名称已存在 / Group name exists');
			return { ...state, groups: state.groups.map(row => row.id === id ? { ...row, title } : row) };
		});
		return { ok: true };
	}
	async deleteGroup(id) {
		if (id === UNGROUPED) fail('group-built-in', '默认未分组不能删除 / Cannot delete the built-in group');
		await this.groups.update(state => {
			const at = state.groups.findIndex(row => row.id === id);
			return { ...state, groups: state.groups.filter(row => row.id !== id), ...(state.ungroupedIndex === undefined ? {} : { ungroupedIndex: state.ungroupedIndex - (at >= 0 && at < state.ungroupedIndex ? 1 : 0) }) };
		});
		return { ok: true };
	}
	async moveGroup(id, beforeId = '') {
		// Apply one move to the latest document; a stale sidebar must not replace
		// concurrently created groups, names or project assignments.
		await this.groups.update(state => {
			const ordered = orderedGroups(state.groups, state.ungroupedIndex), group = ordered.find(row => row.id === id);
			if (!group || beforeId && !ordered.some(row => row.id === beforeId)) fail('group-unknown', '分组不存在，请刷新后重试 / Group not found; refresh and retry');
			if (id === beforeId) return state;
			const moved = ordered.filter(row => row.id !== id);
			moved.splice(beforeId ? moved.findIndex(row => row.id === beforeId) : moved.length, 0, group);
			return { ...state, groups: moved.filter(row => row.id !== UNGROUPED), ungroupedIndex: moved.findIndex(row => row.id === UNGROUPED) };
		});
		return { ok: true };
	}
	async assignGroup(workspaceId, groupId) {
		if (groupId === UNGROUPED) groupId = '';
		this.row(workspaceId);
		await this.groups.update(state => {
			if (groupId && !state.groups.some(row => row.id === groupId)) fail('group-unknown', '分组不存在 / Group not found');
			return { ...state, groups: state.groups.map(row => ({ ...row, workspaceIds: [...row.workspaceIds.filter(id => id !== workspaceId), ...(row.id === groupId ? [workspaceId] : [])] })) };
		});
		return { ok: true };
	}
	async edit({ workspaceId, path, title, createTarget = false }) {
		await this.assertIdle();
		if (await this.move.readJournal()) fail('journal-active', '请先完成或回滚会话迁移');
		const source = this.row(workspaceId);
		title = titleOf(title ?? source.title);
		if (typeof path !== 'string' || !isAbsolute(path)) fail('bad-path', '请选择绝对路径 / Choose an absolute path');
		let toCwd;
		try { toCwd = await realpath(path); }
		catch (error) {
			if (error.code !== 'ENOENT' || !createTarget) throw error;
			await mkdir(path, { recursive: true }); toCwd = await realpath(path);
		}
		if (!(await stat(toCwd)).isDirectory()) fail('bad-path', '目标路径不是目录 / Target must be a directory');
		if (toCwd === source.path) { await source.setTitle(title); return { ok: true, workspaceId }; }
		if (this.registry().list().some(row => row.path === toCwd)) fail('target-occupied', '该路径已属于其他项目 / Target path is occupied');
		const sessionIds = [...source.sessionIds];
		// Check EVERY member before changing project accounting or any log.
		for (const sessionId of sessionIds) await this.move.preflight({ sessionId, toCwd });
		const order = this.registry().list().map(row => row.id), at = order.indexOf(workspaceId);
		await this.journal.write({ version: 1, active: { workspaceId, fromCwd: source.path, toCwd, title, sessionIds, moved: [], targetWorkspaceId: null, beforeId: order[at + 1] ?? null, startedAt: new Date().toISOString() } });
		return this.complete();
	}
	async complete() {
		const entry = await this.active();
		if (!entry) fail('no-workspace-journal', '没有待继续的项目迁移 / No pending project move');
		const registry = this.registry();
		if (!registry) fail('no-capability', '当前 DSH 不支持项目管理');
		let target = entry.targetWorkspaceId ? registry.get(entry.targetWorkspaceId) : registry.list().find(row => row.path === entry.toCwd);
		if (target && target.path !== entry.toCwd) fail('target-changed', '目标项目路径发生变化，请检查迁移日志');
		if (target?.sessionIds.some(id => !entry.sessionIds.includes(id))) fail('target-changed', '目标项目新增了其他会话，已停止合并');
		if (!target) target = await registry.create(entry.toCwd, entry.title);
		entry.targetWorkspaceId = target.id;
		await this.journal.write({ version: 1, active: entry });
		const pending = await this.move.readJournal();
		if (pending) {
			if (!entry.sessionIds.includes(pending.sessionId) || pending.toCwd !== entry.toCwd) fail('journal-conflict', '存在其他会话的迁移日志，请先检查');
			const result = await this.move.complete();
			if (result.deferred) fail('ledger-deferred', result.note);
		}
		for (const sessionId of entry.sessionIds) {
			const header = (await this.move.caps.listHeaders()).find(row => row.id === sessionId);
			if (!header) fail('session-unknown', `无法找到会话 ${sessionId}`);
			if (header.cwd !== entry.toCwd) {
				if (header.cwd !== entry.fromCwd) fail('session-changed', `会话 ${sessionId} 的项目归属已变更`);
				const result = await this.move.move(await this.move.preflight({ sessionId, toCwd: entry.toCwd }));
				if (result.deferred) fail('ledger-deferred', result.note);
			}
			if (!entry.moved.includes(sessionId)) entry.moved.push(sessionId);
			await this.journal.write({ version: 1, active: entry });
		}
		// Never remove the source registration while it owns a new/unmoved member.
		if (registry.get(entry.workspaceId)?.sessionIds.length) fail('source-changed', '原项目新增或仍有会话，请保留两个项目并检查迁移进度');
		target = registry.get(target.id);
		await target.setTitle(entry.title);
		for (const [index, sessionId] of [...entry.sessionIds].reverse().entries()) {
			const anchor = index === 0 ? undefined : entry.sessionIds[entry.sessionIds.length - index];
			await target.insertSessionBefore(sessionId, anchor);
		}
		await this.groups.update(state => ({ ...state, groups: state.groups.map(row => ({ ...row, workspaceIds: row.workspaceIds.map(id => id === entry.workspaceId ? target.id : id) })) }));
		await this.ledger?.update(state => ({ ...state, items: state.items.map(item => item.kind === 'session' && item.snapshot.workspaceId === entry.workspaceId && entry.sessionIds.includes(item.id2)
			? { ...item, snapshot: { ...item.snapshot, workspaceId: target.id } } : item) }));
		const beforeId = registry.get(entry.beforeId)?.id;
		await registry.insertBefore(target.id, beforeId);
		if (registry.get(entry.workspaceId)) await registry.delete(entry.workspaceId);
		await this.journal.write({ version: 1, active: null });
		return { ok: true, workspaceId: target.id, moved: entry.sessionIds.length };
	}
}
