/**
 * dsh-session-toolbox browser plugin: management page (§4 FR5/FR6, §10 MR6, §11
 * TB2), session context-menu entries, the input-dock vault badge, and the
 * draft vault itself (capture + IndexedDB + synthetic-paste restore; route A).
 * Every official surface is probed (`ctx.get?.`, guarded registrations); no
 * path here may take the native composer down with it (NFR3).
 */
import { useEffect, useState, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import pkg from '../package.json' with { type: 'json' };
const pluginVersion = pkg.version;
import { MenuItemButton, Modal, Button, Tooltip, UserTextRun, IconFolderOpenOutlineRegular, IconArchiveOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { REPLY_SOURCE, REPLY_TEXT_NODE, readReply, insertReply, withoutReply, messageReply, messageSequence, replySource, replyTextRule, installReplyNodes, selectedReply } from './reply.mjs';
import { createCandidateView, candidatesForTurn } from './next-tasks-view.mjs';
import { createVault } from './draft-vault.js';
import { orderedGroups, UNGROUPED } from './group-order.mjs';
import { filterSidebar, installSidebar, mirroredSlot, sidebarLayout, protectProjectMenu, sessionProjectDrag, groupOrderDrag } from './sidebar.mjs';

export const name = 'dsh-session-toolbox-client';
// `locale` is a real service, so it must be injected before use: cordis throws
// on property access for a service that was never injected (it does not return
// undefined), which is what surfaced as "cannot get property \"locale\" without
// inject" on the plugin page.
export const inject = ['slots', 'locale', 'sessions', 'conversation'];
export const NS = 'dsh-session-toolbox';
const ENDPOINT = `/.well-known/${NS}`;

/**
 * Broadcast a one-line notice to the toolbox page after the dialog closes.
 *
 * The context menu opens MoveDialog outside the page tree, so a local setState
 * cannot reach the panel; a window event keeps the message visible where the
 * user can act on it without coupling the two components.
 */
export const NOTICE_EVENT = 'dsh-session-toolbox:notice';
function dispatchNotice(message) {
	try { window.dispatchEvent(new CustomEvent(NOTICE_EVENT, { detail: message })); } catch { /* ignore */ }
}

let vault; // browser-side singleton (IndexedDB + host manifest)
let directoryPicker; // ctx.get('directoryPicker') probed at apply time
let conversationService;
let replyAvailable = false;
let sessionsService; // ctx.sessions — injected above, used by the manual refresh
/** @type {{ running: boolean }} */
export const refreshState = { running: false };
const store = { state: null, error: '', overlay: null, listeners: new Set() };
function showOverlay(request) { store.overlay = request; for (const listener of store.listeners) listener(); }

async function readResponse(res) {
	let next;
	try { next = JSON.parse(await res.text()); }
	catch { throw new Error(`插件后台未就绪（HTTP ${res.status}）；安装或重启期间会自动重试`); }
	if (next === null || typeof next !== 'object' || Array.isArray(next)) throw new Error('插件后台返回了无效数据');
	if (!res.ok) throw new Error(next.error ?? `操作失败（HTTP ${res.status}）`);
	return next;
}

/** GET the shared snapshot; also (re)binds the write key the host rotates. */
export let sessionKey = '';
let stateRequest = 0;
export async function loadState() {
	const request = ++stateRequest;
	try {
		const next = await readResponse(await fetch(ENDPOINT, { cache: 'no-store' }));
		// Bootstrap authorization even when a concurrent snapshot supersedes this
		// read. Otherwise every mounting message can retry with an empty key.
		if (!sessionKey && next.key) sessionKey = next.key;
		if (request !== stateRequest) return store.state;
		store.state = next; store.error = ''; sessionKey = next.key ?? sessionKey;
		vault?.setLimits(next.settings?.draftVault ?? {});
	} catch (error) { if (request !== stateRequest) return store.state; store.error = error.message; }
	for (const listener of store.listeners) listener();
	return store.state;
}
let keyRequest;
function ensureSessionKey(force = false) {
 if (sessionKey && !force) return Promise.resolve();
 if (!keyRequest) keyRequest = loadState().finally(() => { keyRequest = null; });
 return keyRequest;
}
export async function callHost(input) {
	if (input.type === 'vault.sweep') {
		if (!vault) throw new Error('草稿保险箱尚未就绪');
		const report = await vault.sweep();
		await vault.syncHost();
		return report;
	}
	await ensureSessionKey();
	const post = () => fetch(ENDPOINT, {
		method: 'POST', cache: 'no-store',
		headers: { 'content-type': 'application/json', 'x-session-toolbox-key': sessionKey },
		body: JSON.stringify(input),
	});
	let response = await post();
	if (response.status === 401) { await ensureSessionKey(true); response = await post(); }
	const res = await readResponse(response);
	sessionKey = res.key ?? sessionKey;
	if (['move', 'move.complete', 'move.rollback', 'workspace.edit', 'workspace.complete', 'trash.session', 'trash.workspace', 'trash.restore', 'trash.purge'].includes(input.type)) {
		try { await refreshSessionList(); }
		catch (error) { dispatchNotice(`操作已完成，但列表刷新失败：${error.message}`); }
	}
	return res;
}

/**
 * Re-pull the host's session list so sidebar rows reflect the current placement.
 *
 * `sessions.refresh()` is the official baseline pull the sidebar snapshot is
 * built from; calling it refreshes the list for every session without touching
 * any conversation or restarting DSH. Falls back to a clear error when the host
 * build does not expose it.
 */
export async function refreshSessionList() {
	const service = sessionsService;
	if (service === undefined) throw new Error('当前 DSH 未提供会话服务，无法刷新');
	if (typeof service.refresh !== 'function') throw new Error('当前 DSH 版本的会话服务不支持刷新');
	refreshState.running = true;
	try { await service.refresh(); }
	finally { refreshState.running = false; }
	await loadState();
}

export function apply(ctx) {
	directoryPicker = ctx.get?.('directoryPicker');
	// Injected service: `refresh()` re-pulls the session list baseline from the
	// host, which is what makes a moved/restored row appear without a restart.
	sessionsService = ctx.sessions;
 conversationService = ctx.conversation;
	// Native archive/membership changes arrive on the public Workspace store.
	// Keep counts and the archive pool current even when our own menu was not used.
	const workspaceList = ctx.get?.('workspaces')?.list;
	if (typeof workspaceList?.subscribe === 'function') ctx.effect(() => workspaceList.subscribe(() => { void loadState(); }));
	const vaultInstance = vault = createVault({
		endpoint: ENDPOINT,
		getInput: sessionId => {
			const binding = sessionsService?.binding?.(sessionId);
			const conversation = ctx.conversation;
			if (!binding || !conversation?.input?.for) return undefined;
			return { store: conversation.input.for(binding.ctx).state, resolve: ids => conversation.resolveDraftAttachments(ids) };
		},
		log: (level, message) => { try { (level === 'error' ? console.warn : console.log)(`[${NS}]`, message); } catch {} },
	});
	void loadState();
	const timer = setInterval(() => void loadState(), 30000);
	const onVaultChange = () => { void loadState(); };
	vaultInstance.on('change', onVaultChange);
	ctx.effect(() => () => { clearInterval(timer); vaultInstance.off('change', onVaultChange); vaultInstance.stop(); });
	void vaultInstance.start().catch(error => sayRow(`草稿保险箱启动失败：${error.message}`));
	// `locale` is injected above, so the service is guaranteed here; registering
	// inside ctx.effect keeps the dictionaries disposable across hot reloads
	// (same shape as the official client plugins).
	ctx.effect(() => ctx.locale.register(NS, {
		zh: { 'menu.move': '切换到其它项目…', 'menu.trash': '归档到归档池', ...workspaceChinese },
		en: { 'menu.move': 'Move to another project…', 'menu.trash': 'Archive', ...workspaceEnglish },
	}), 'session-toolbox: dictionaries');

 if (typeof ctx.inject === 'function') ctx.inject(['inputTriggers'], scope => scope.effect(() => {
  const triggers = scope.get?.('inputTriggers');
  if (typeof triggers?.registerSource !== 'function') return;
  const release = triggers.registerSource(replySource()); replyAvailable = true;
  return () => { replyAvailable = false; release(); };
 }));
 if (typeof ctx.inject === 'function') ctx.inject(['uiConversation'], scope => {
  if (typeof scope.get?.('uiConversation')?.userText?.register !== 'function') return;
  scope.effect(() => scope.get('uiConversation').userText.register(replyTextRule()));
  scope.slots.inject('conversation.user.text.node', () => scope.slots.register({ name: 'conversation.user.text.node', key: REPLY_TEXT_NODE, priority: 50, locale: NS }, SentReplyCard));
 });
 installReplyNodes(ctx, (native, mirrors) => props => <ReplyMessage {...props} Native={native.component} mirrors={mirrors} toolboxT={ctx.locale.bind?.(NS)} />);
 ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'session-toolbox-reply', order: 1, locale: NS }, ReplyPreview));
 ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'session-toolbox-edit-draft', order: 2, locale: NS }, EditDraftNotice));
 ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'session-toolbox-next-tasks', order: 20, locale: NS }, NextTaskController));

	installSidebar(ctx, native => props => <GroupedSidebar {...props} toolboxT={ctx.locale.bind?.(NS)} Native={native.component} />);

	// Keyed slot (one occupant = package name): the plugin settings page.
	ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: NS, locale: NS }, KitPage));
	// Session context menu: move + trash entries beside the official four.
	ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'session-toolbox-move', order: 500, locale: NS }, MoveSessionMenuItem));
	ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'session-toolbox-trash', order: 600, locale: NS }, TrashSessionMenuItem));
	// Input dock badge (§4 FR5): how many image drafts are backed up here.
	ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'session-toolbox-dialog', order: 500, locale: NS }, ToolboxOverlay));
	ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'session-toolbox-selection', order: 510, locale: NS }, SelectionReplyMenu));
	ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'session-toolbox-vault-badge', order: 5, locale: NS }, VaultBadge));
}

function useKit() {
	const [, bump] = useState(0);
	useEffect(() => {
		const listener = () => bump(n => n + 1);
		store.listeners.add(listener);
		void loadState();
		return () => store.listeners.delete(listener);
	}, []);
	return store;
}

const styles = `
.sk{--sk-accent:var(--dsw-alias-state-active-primary,#3a71db);--sk-border:var(--dsw-alias-border-l2,#444);--sk-bg:var(--dsw-alias-bg-layer-1,#202020);--sk-card:var(--dsw-alias-bg-module-platform,#282828);--sk-text:var(--dsw-alias-label-primary,#f4f4f4);--sk-muted:var(--dsw-alias-label-secondary,#b0b0b0);color:var(--sk-text);font:inherit;font-size:14px;line-height:1.6;max-width:1120px}
.sk *{box-sizing:border-box}.sk h2,.sk h3,.sk p{margin:0}.sk h2{font-size:22px}.sk h3{font-size:16px}.sk .muted,.sk small{color:var(--sk-muted)}
.sk .box{border:1px solid var(--sk-border);border-radius:12px;padding:18px 20px;background:var(--sk-card);display:flex;flex-direction:column;gap:14px}
.sk .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.sk.stack,.sk .stack{display:flex;flex-direction:column;gap:16px}
.sk .community{padding:10px 14px;border:1px solid var(--sk-border);border-radius:8px;background:var(--sk-card)}.sk .community a{color:var(--sk-accent);font-weight:500;text-decoration:underline;text-underline-offset:3px}.sk .community a:hover{opacity:.8}.sk .community a:focus-visible{outline:2px solid var(--sk-accent);outline-offset:4px;border-radius:2px}
.sk button,.sk input,.sk select{font:inherit;color:inherit;border:1px solid var(--sk-border);border-radius:8px;background:var(--sk-bg);min-height:36px;padding:7px 12px}
.sk button{cursor:pointer}.sk button:hover{background:var(--sk-card)}.sk button:disabled{opacity:.45;cursor:default}
.sk button.primary{background:var(--sk-accent);color:#fff;border-color:transparent}
.sk table{width:100%;border-collapse:collapse;font-size:13px}.sk th,.sk td{border-bottom:1px solid var(--sk-border);padding:8px;text-align:left}.sk th{color:var(--sk-muted);font-weight:500}
.sk .error{color:var(--dsw-alias-state-error-primary,#ef9393)}.sk .good{color:var(--dsw-alias-state-success-primary,#77ca9d)}
.sk .pill{border:1px solid var(--sk-border);border-radius:100px;padding:2px 10px;font-size:12px;background:var(--sk-bg);display:inline-block}
.sk .mono{font:12px ui-monospace,monospace;overflow-wrap:anywhere}
.sk input.grow{flex:1;min-width:0}
.sk-dialog-body{max-height:calc(100dvh - 160px);overflow-y:auto;overscroll-behavior:contain;padding-right:4px}.sk-dialog-body>*{flex-shrink:0}
`;

export function KitPage({ t } = {}) {
	const { state, error } = useKit();
	const [busy, setBusy] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [feedback, setFeedback] = useState('');
	const say = message => { setFeedback(message); setTimeout(() => setFeedback(''), 8000); };
	// The context menu's dialog lives outside this tree; it reports completion
	// through a window event, and the panel refetches so the project list and the
	// moved session's placement are current without a DSH restart.
	useEffect(() => {
		const onNotice = event => {
			const message = typeof event?.detail === 'string' ? event.detail : '';
			if (message) say(message);
			void loadState().catch(() => {});
		};
		window.addEventListener(NOTICE_EVENT, onNotice);
		return () => window.removeEventListener(NOTICE_EVENT, onNotice);
	}, []);
	const act = async (input, ok) => {
		setBusy(true);
		try { const result = await callHost(input); if (result.deferred) say(result.note ?? '迁移账本尚待完成，请在恢复区继续处理'); else if (ok) say(ok); await loadState(); setBusy(false); return result; }
		catch (err) { say(`失败：${err.message}`); setBusy(false); throw err; }
	};
	const settings = state?.settings;
	return (
		<div className="sk stack">
			<style>{styles}</style>
			<h2>会话工具箱</h2>
			<div className="row community">
				<a href="https://qm.qq.com/q/eQC7OQXQe4" target="_blank" rel="noopener noreferrer">{text(t, 'community.join')}</a>
				<span className="muted">{text(t, 'community.name')} · {text(t, 'community.number')} <strong>1124103038</strong></span>
			</div>
			<p className="muted">草稿保险箱 · 会话切换项目 · 归档池 — v{pluginVersion}。数据仅存本机（浏览器 IndexedDB + ~/.dsh/session-toolbox/）。</p>
			<div className="row">
				<button disabled={busy || refreshing} onClick={() => {
					setRefreshing(true);
					void refreshSessionList()
						.then(() => say('会话列表已刷新；迁移或还原过的会话应出现在新项目下'))
						.catch(err => say(`刷新失败：${err.message}`))
						.finally(() => setRefreshing(false));
				}}>{refreshing ? '刷新中…' : '刷新会话列表'}</button>
				<span className="muted">迁移或还原会话后，若侧栏没变化，点这里重新拉取列表（不影响任何会话内容）。</span>
			</div>
			{error ? <p className="error">后台连接失败：{error}</p> : null}
			{feedback ? <p className="good">{feedback}</p> : null}
			<NextTaskSettings state={state} act={act} busy={busy} />
			<section className="box">
				<h3>草稿保险箱（图片草稿持久化）</h3>
				{settings ? (
					<>
						<div className="row">
							<label className="row"><input type="checkbox" checked={settings.draftVault?.enabled !== false} disabled={busy}
								onChange={e => void act({ type: 'settings.update', patch: { draftVault: { ...settings.draftVault, enabled: e.target.checked } } }, e.target.checked ? '已启用草稿保险箱' : '已停用草稿保险箱（保留已有备份）').catch(() => {})} /> 启用</label>
							<span className="pill">容量 {Math.round((settings.draftVault?.maxSizeBytes ?? 0) / 1048576)} MB</span>
							<span className="pill">保留 {settings.draftVault?.ttlDays ?? 7} 天</span>
						</div>
						<div className="row">
							<span className="muted">清单：已备份 {state?.vault?.records ?? 0} 项 · 约 {fmtBytes(state?.vault?.bytes ?? 0)}（图片字节在 IndexedDB，超出上限按最旧清理，事件会显示在这里）</span>
						</div>
						{vault?.lastNotice ? <p className="muted">{vault.lastNotice}</p> : null}
						<div className="row"><button disabled={busy} onClick={() => void act({ type: 'vault.sweep' }, '已按 TTL/容量清理').catch(() => {})}>立即整理</button></div>
					</>
				) : <p className="muted">等待后台数据…</p>}
			</section>
			<WorkspaceSection state={state} t={t} />
			<MoveSection act={act} busy={busy} say={say} state={state} />
			<TrashSection act={act} busy={busy} say={say} state={state} />
		</div>
	);
}

function MoveSection({ act, busy, say, state }) {
	const [sessionId, setSessionId] = useState('');
	const [toCwd, setToCwd] = useState('');
	const [createTarget, setCreateTarget] = useState(false);
	const [plan, setPlan] = useState(null);
	const journal = state?.journal;
	// Known projects, so the target can be picked by name instead of typed as a path.
	const projects = state?.projects ?? [];
	// Which project the typed session currently belongs to (computed host-side).
	const [fromProject, setFromProject] = useState(null);
	useEffect(() => {
		if (!sessionId) { setFromProject(null); return; }
		let alive = true;
		void callHost({ type: 'project.of', sessionId })
			.then(result => { if (alive) setFromProject(result?.project ?? null); })
			.catch(() => { if (alive) setFromProject(null); });
		return () => { alive = false; };
	}, [sessionId]);
	const pick = async () => {
		try {
			const result = await directoryPicker?.pick?.();
			const value = result?.ok ? result.value : undefined;
			if (typeof value === 'string' && value) setToCwd(value);
			else say('当前 DSH 未提供目录选择器（或已取消），请手动输入绝对路径');
		} catch (error) { say(`目录选择失败：${error.message}`); }
	};
	return (
		<section className="box">
			<h3>会话切换项目</h3>
			{journal && <p className="error">存在未完成的迁移：{journal.sessionId} → {journal.toCwd}（已完成 {journal.done?.join('/') || '无'}）。
				<button disabled={busy} onClick={() => void act({ type: 'move.complete' }, '迁移已前滚完成').catch(() => {})}>完成</button>
				{' '}<button disabled={busy} onClick={() => void act({ type: 'move.rollback' }, '迁移已回滚').catch(() => {})}>回滚</button></p>}
			<div className="row">
				<input className="grow mono" placeholder="session-…（或从会话右键菜单发起）" value={sessionId} onChange={e => { setSessionId(e.target.value); setPlan(null); }} />
				{projects.length > 0 && (
					<select className="grow" value={projects.some(p => p.path === toCwd) ? toCwd : ''}
						onChange={e => { setToCwd(e.target.value); setPlan(null); }}>
						<option value="">选择目标项目…</option>
						{projects.map(project => (
							<option key={project.id} value={project.path} disabled={fromProject?.path === project.path}>
								{project.title}（{project.sessions} 个会话）{fromProject?.path === project.path ? ' — 当前项目' : ''}
							</option>
						))}
					</select>
				)}
				<input className="grow mono" placeholder="目标项目绝对路径" value={toCwd} onChange={e => { setToCwd(e.target.value); setPlan(null); }} />
				<button onClick={() => void pick()} disabled={busy}>浏览…</button>
			</div>
			{sessionId && (
				<p className="muted">
					当前项目：{fromProject === null ? '（未找到该会话，或它不属于任何项目）'
						: <><strong>{fromProject.title}</strong>{' '}<span className="mono">{fromProject.path}</span></>}
				</p>
			)}
			<label className="row"><input type="checkbox" checked={createTarget} onChange={e => { setCreateTarget(e.target.checked); setPlan(null); }} /> 目标不存在时创建</label>
			<div className="row">
				<button disabled={busy || !sessionId || !toCwd} onClick={() => { setPlan(null); void act({ type: 'preflight', sessionId, toCwd, createTarget }).then(setPlan).catch(() => {}); }}>体检</button>
				<button className="primary" disabled={busy || plan?.toProject === undefined} onClick={() => void act({ type: 'move', sessionId, toCwd, createTarget }, '迁移完成，已刷新会话列表').catch(() => {})}>迁移</button>
			</div>
			{plan?.toProject && (
				<pre className="mono muted" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify({ 从: plan.fromCwd, 到: plan.toCwd, 原目录: plan.fromProject, 新目录: plan.toProject, 日志文件: plan.logName }, null, 2)}</pre>
			)}
			<p className="muted">只改 DSH 内部归属与会话头；历史不变，旧消息中的绝对路径仍指向原项目（已知语义）。会话空闲且无排队消息时，自动释放写入句柄后迁移，无需重启 DSH。</p>
		</section>
	);
}

function TrashSection({ act, busy, say, state }) {
	const items = state?.trash ?? [];
	return (
		<section className="box">
			<h3>归档池</h3>
			<p className="muted">
				这里同时显示 DSH 原生归档和通过工具箱归档的会话。工具箱归档额外保存<b>项目归属、列表位置与置顶状态</b>；原生归档按当前项目归属还原，原始归档时间和归档前置顶状态不可追溯，也不参与到期自动删除。
				归档项目则保留全部会话日志，只移除项目注册表项。彻底删除会先移入暂存目录再清理，中断可用 CLI 检出。
			</p>
			{items.length === 0 ? <p className="muted">（空）</p> : (
				<table>
					<thead><tr><th>类型</th><th>对象</th><th>标题 / 路径</th><th>入池时间</th><th /></tr></thead>
					<tbody>{items.map(item => (
						<tr key={item.itemId}>
							<td>{item.source === 'native' ? '会话（原生归档）' : item.kind === 'session' ? '会话' : '项目'}</td>
							<td className="mono">{shortId(item.targetId)}</td>
							<td className="mono">{item.kind === 'session' ? item.snapshot.title || '（无标题）' : item.snapshot.path}</td>
							<td>{item.trashedAt ? new Date(item.trashedAt).toLocaleString('zh-CN', { hour12: false }) : '未知（原生归档）'}</td>
							<td className="row">
								<button disabled={busy} onClick={() => void act({ type: 'trash.restore', itemId: item.itemId }, '已还原到原位').catch(() => {})}>还原</button>
								<button disabled={busy} onClick={() => showOverlay({ kind: 'purge', itemId: item.itemId, title: item.snapshot.title || item.snapshot.path || item.targetId })}>彻底删除</button>
							</td>
						</tr>))}
					</tbody>
				</table>
			)}
			<div className="row">
				<span className="muted">保留 {state?.settings?.trash?.ttlDays ?? 30} 天；到期自动移出{state?.settings?.trash?.autoPurge ? '（已开）' : '（未开，仅提醒）'}。</span>
				<button disabled={busy} onClick={() => void act({ type: 'settings.update', patch: { trash: { ...state?.settings?.trash, autoPurge: !(state?.settings?.trash?.autoPurge) } } }, '策略已更新').catch(() => {})}>切换自动清理</button>
				<button disabled={busy} onClick={() => void act({ type: 'trash.sweep' }, '已按 TTL 巡检').catch(() => {})}>巡检到期项</button>
			</div>
		</section>
	);
}

const shortId = id => String(id).length > 18 ? `${String(id).slice(0, 8)}…${String(id).slice(-6)}` : String(id);
const fmtBytes = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

/** Menu entry: move this session to another project (§10 MR6). */
export function MoveSessionMenuItem({ sessionId, useMenuOpenState, t }) {
	const [, setMenuOpen] = useMenuOpenState?.() ?? [false, () => {}];
	return <MenuItemButton separatorBefore icon={<IconFolderOpenOutlineRegular size={14} />} onSelect={() => {
		setMenuOpen(false);
		showOverlay({ kind: 'move', sessionId });
	}}>{t ? t('menu.move') : '切换到其它项目…'}</MenuItemButton>;
}

export function TrashSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, t }) {
	const [, setMenuOpen] = useMenuOpenState?.() ?? [false, () => {}];
	return <MenuItemButton icon={<IconArchiveOutlineRegular size={14} />} onSelect={() => {
		setMenuOpen(false);
		showOverlay({ kind: 'archive', sessionId, title: displayTitle || sessionId });
	}}>{t ? t('menu.trash') : '归档到归档池'}</MenuItemButton>;
}
function sayRow(message) { store.error = message; for (const listener of store.listeners) listener(); }

/** Keep dialogs in the shell: menu rows are unmounted as soon as the menu closes. */
export function ToolboxOverlay({ t } = {}) {
	const { overlay } = useKit();
	if (!overlay) return null;
	const close = () => showOverlay(null);
	if (overlay.kind === 'groups') return <GroupsDialog close={close} t={t} />;
	if (overlay.kind === 'group-move') return <MoveGroupDialog key={overlay.workspaceId} workspaceId={overlay.workspaceId} close={close} t={t} />;
	if (overlay.kind === 'workspace') return <WorkspaceDialog key={overlay.workspaceId} workspaceId={overlay.workspaceId} close={close} t={t} />;
	if (overlay.kind === 'move') return <MoveDialog key={overlay.sessionId} sessionId={overlay.sessionId} close={close} />;
	if (overlay.kind === 'checkpoint') return <CheckpointDialog key={`${overlay.sessionId}:${overlay.seq}`} request={overlay} close={close} t={t} />;
	if (overlay.kind === 'message-delete') return <DeleteMessageDialog key={`${overlay.sessionId}:${overlay.seq}`} request={overlay} close={close} t={t} />;
	return <TrashDialog key={overlay.itemId || overlay.sessionId} request={overlay} close={close} />;
}

function TrashDialog({ request, close }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const purge = request.kind === 'purge';
	const dismiss = () => { if (!busy) close(); };
	const submit = async () => {
		setBusy(true); setError('');
		try {
			await callHost(purge ? { type: 'trash.purge', itemId: request.itemId } : { type: 'trash.session', sessionId: request.sessionId });
			await loadState();
			close();
		} catch (reason) { setError(reason.message); setBusy(false); }
	};
	return <Modal open onClose={dismiss} closeLabel="关闭" title={purge ? '彻底删除' : '归档到归档池'}
		description={purge ? `将永久删除「${request.title}」的会话记录，此操作无法还原。` : `归档「${request.title}」后，可在工具箱归档池中还原。`}
		footer={<><Button variant="outline" disabled={busy} onClick={dismiss}>取消</Button><Button variant="outline" disabled={busy} onClick={() => void submit()}>{busy ? '处理中…' : purge ? '确认彻底删除' : '确认归档'}</Button></>}>
		{error ? <p role="alert">{error}</p> : null}
	</Modal>;
}

export function MoveDialog({ sessionId, close }) {
	const [toCwd, setToCwd] = useState('');
	const [createTarget, setCreateTarget] = useState(false);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	// Same project picker as the panel: the dialog is what the context menu opens,
	// so it must not fall back to typing a path by hand.
	const { state } = useKit();
	const projects = state?.projects ?? [];
	const [fromProject, setFromProject] = useState(null);
	useEffect(() => {
		let alive = true;
		void callHost({ type: 'project.of', sessionId })
			.then(result => { if (alive) setFromProject(result?.project ?? null); })
			.catch(() => { if (alive) setFromProject(null); });
		return () => { alive = false; };
	}, [sessionId]);
	const submit = async () => {
		setBusy(true); setError('');
		try {
			const result = await callHost({ type: 'move', sessionId, toCwd, createTarget });
			// The host has already re-read the session headers. The sidebar list is a
			// server-driven snapshot, so the row appears there on the next refresh; say
			// that plainly instead of closing on a silent success.
			close();
			dispatchNotice(result?.deferred
				? '文件已迁移，但项目账本尚未完成；请在工具箱点击完成或回滚'
				: '迁移完成，已刷新会话列表');
		}
		catch (err) { setError(err.message); setBusy(false); }
	};
	const valid = /^\/|^[A-Za-z]:[\\/]/.test(toCwd);
	return (
		<Modal open onClose={() => { if (!busy) close(); }} closeLabel="关闭" title="会话切换到其它项目"
			footer={<><Button variant="outline" disabled={busy} onClick={close}>取消</Button><Button variant="primary" disabled={busy || !valid || fromProject?.path === toCwd} onClick={() => void submit()}>{busy ? '迁移中…' : '体检并迁移'}</Button></>}>
			<div className="sk stack"><style>{styles}</style>
				<p className="muted mono">{sessionId}</p>
				<p className="muted">当前项目：{fromProject ? <><strong>{fromProject.title}</strong> <span className="mono">{fromProject.path}</span></> : '（未找到项目）'}</p>
				{projects.length > 0 && <label className="stack">目标项目
					<select value={projects.some(p => p.path === toCwd) ? toCwd : ''} onChange={e => setToCwd(e.target.value)} disabled={busy}>
						<option value="">选择目标项目…</option>
						{projects.map(project => <option key={project.id} value={project.path} disabled={fromProject?.path === project.path}>{project.title}（{project.sessions} 个会话）{fromProject?.path === project.path ? ' — 当前项目' : ''}</option>)}
					</select>
				</label>}
				<label className="stack">目标目录<input className="mono" value={toCwd} onChange={e => setToCwd(e.target.value)} disabled={busy} placeholder="目标项目绝对路径" /></label>
				<label className="row"><input type="checkbox" checked={createTarget} onChange={e => setCreateTarget(e.target.checked)} disabled={busy} /> 目录不存在时创建</label>
				{error ? <p className="error" role="alert">{error}</p> : null}
				<p className="muted">会话需空闲且没有排队消息。插件会完成写入并释放句柄后迁移，无需重启 DSH。</p>
			</div>
		</Modal>
	);
}

/** Input-dock badge (§4 FR5): how many image drafts are backed up for this session. */
export function VaultBadge({ sessionId }) {
	const [count, setCount] = useState(0);
	const [notice, setNotice] = useState('');
	useEffect(() => {
		if (vault === undefined) return;
		let live = true;
		const sync = async () => {
			try { const value = await vault.countFor(sessionId ?? vault.currentSession()); if (live) setCount(value); }
			catch { if (live) setCount(0); }
			if (live) setNotice(vault.lastNotice ?? '');
		};
		void sync();
		const listener = () => void sync();
		vault.on('change', listener);
		window.addEventListener(`${NS}-notice`, listener);
		const timer = setInterval(listener, 20000);
		return () => { live = false; vault.off('change', listener); window.removeEventListener(`${NS}-notice`, listener); clearInterval(timer); };
	}, [sessionId]);
	if (count === 0) return null; // the notice channel serves the panel; the badge anchors per-session counts
	return <span className="sk"><span className="pill" title={`本会话有 ${count} 张图片草稿已备份（切换会话/刷新/重启后可恢复）${notice ? `｜最近：${notice}` : ''}`}>🛟 草稿备份 {count}</span></span>;
}

const workspaceChinese = {
 'message.delete': '删除这条消息', 'message.deleteHelp': '从会话界面和后续 AI 上下文中移除这条消息，不撤销文件修改。其它消息仍可能包含相关信息。原始日志保留用于完整性校验，此操作不提供界面撤销。', 'message.deleteConfirm': '确认删除消息', 'message.deleted': '消息已删除，已从后续 AI 上下文移除',
 'reply.selection': '引用所选内容', 'reply.copy': '复制',
 'nextTasks.generate': '生成任务联想（单独统计 token）', 'nextTasks.regenerate': '重新生成任务联想（单独统计 token）',
 'checkpoint.action': '恢复检查点', 'checkpoint.help': '撤销这条消息及之后的文件修改，保留全部聊天记录。仅支持已保存的本地项目文件，忽略 Git 忽略文件、依赖、构建和环境文件。工具运行期间请避免手动修改同一项目，该时段的写入无法区分来源。',
 'checkpoint.loading': '正在检查文件…', 'checkpoint.restore': '确认恢复文件', 'checkpoint.conflicts': '以下文件又被修改过，请先处理冲突：', 'checkpoint.empty': '没有需要恢复的文件。', 'checkpoint.done': '文件已恢复，聊天记录已保留。', 'checkpoint.retry': '重新检查',
 'nextTasks.title': '接下来', 'nextTasks.empty': '本轮没有合适的后续建议', 'nextTasks.unavailable': '本轮未生成后续建议', 'nextTasks.reason.credentials': '模型凭据或权限无效', 'nextTasks.reason.rate-limit': '模型服务限流', 'nextTasks.reason.format': '模型返回的候选格式无效', 'nextTasks.reason.output-limit': '达到候选输出上限', 'nextTasks.reason.model-call': '模型调用未完成', 'nextTasks.reason.model-unconfigured': '会话未配置可用模型', 'nextTasks.reason.context': '缺少可用于联想的问答文字', 'nextTasks.reason.busy': '会话仍在运行或收尾', 'nextTasks.reason.host-state': '无法读取会话状态', 'nextTasks.reason.cancelled': '候选生成已取消', 'nextTasks.dismiss': '收起建议', 'reply.fromUser': '引用用户消息', 'reply.fromAssistant': '引用助手回复', 'nextTasks.generating': '正在生成后续任务候选…', 'nextTasks.failed': '后续任务候选生成失败（不会自动重试）', 'message.inComposer': '历史文字已载入输入框，可编辑并添加截图。', 'message.restoreDraft': '恢复原草稿文字', 'message.edit': '编辑并重新发送',
 'reply.action': '引用回复', 'reply.cancel': '取消引用', 'reply.user': '用户', 'reply.assistant': '助手', 'reply.unavailable': '当前输入框暂不支持引用回复',
 'community.join': '加入 QQ 交流群 ↗', 'community.name': 'AndroidSix 的开源项目交流群', 'community.number': '群号',
 'groups.title': '项目分组', 'groups.all': '全部项目', 'groups.none': '未分组', 'groups.manage': '管理项目与分组',
 'groups.reorder': '拖动分组标题调整顺序；也可聚焦后按 Alt/Option + ↑/↓。未分组也可自由排序。', 'groups.move': '移入分组…', 'groups.drop': '可将项目拖到分组标题，或从项目菜单选择“移入分组”。', 'groups.name': '分组名称', 'groups.create': '新建分组', 'groups.rename': '重命名', 'groups.delete': '删除分组',
 'groups.help': '每个项目可归入一个分组；删除分组会将其中项目恢复为未分组。侧栏按“分组 → 项目 → 会话”展开，原生搜索仍搜索全部会话。',
 'groups.intro': '整理项目归属，侧栏会同步更新。', 'groups.list': '分组', 'groups.projects': '项目', 'groups.empty': '这个分组还没有项目', 'groups.emptyHelp': '在“全部项目”中为项目选择所属分组。', 'groups.sortHelp': '拖动分组或点击箭头排序，与侧栏同步。', 'groups.up': '上移', 'groups.down': '下移', 'groups.saved': '分组变更自动保存', 'groups.sessions': '个会话',
 'project.groupHelp': '分组选择后立即保存；名称和路径点击“保存”后生效。', 'project.editGroup': '编辑项目', 'project.edit': '编辑项目', 'project.title': '项目名称', 'project.path': '项目目录', 'project.browse': '浏览…',
 'project.help': '选择已有代码目录。保存后，将该项目的全部已有会话一起迁入新路径，保留顺序、归档及置顶状态；代码文件不会搬动，历史消息中的路径保持原样。会话必须空闲且没有排队消息。',
 'project.resume': '继续迁移', 'project.pending': '项目迁移尚未完成，请继续迁移。',
 'common.save': '保存', 'common.cancel': '取消', 'common.close': '关闭', 'common.busy': '处理中…', 'common.loading': '正在加载项目…',
};
const workspaceEnglish = {
 'message.delete': 'Delete this message', 'message.deleteHelp': 'Remove this message from the chat and future AI context. File changes are kept. Other messages may still contain related information. Original logs are retained for integrity; there is no UI undo.', 'message.deleteConfirm': 'Delete message', 'message.deleted': 'Message deleted from the chat and future AI context',
 'reply.selection': 'Quote selection', 'reply.copy': 'Copy',
 'nextTasks.generate': 'Generate next steps (tokens tracked separately)', 'nextTasks.regenerate': 'Regenerate next steps (tokens tracked separately)',
 'checkpoint.action': 'Restore checkpoint', 'checkpoint.help': 'Undo file changes from this message onward; keep all chat messages. Saved local project files only; Git-ignored files, dependencies, build output and environment files are excluded. Avoid manual edits while tools run: changes made during execution cannot be attributed separately.',
 'checkpoint.loading': 'Checking files…', 'checkpoint.restore': 'Restore files', 'checkpoint.conflicts': 'These files changed again. Resolve conflicts first:', 'checkpoint.empty': 'No files need restoring.', 'checkpoint.done': 'Files restored. Chat history was kept.', 'checkpoint.retry': 'Check again',
 'nextTasks.title': 'Next steps', 'nextTasks.empty': 'No useful next steps for this answer', 'nextTasks.unavailable': 'No suggestions generated for this answer', 'nextTasks.reason.credentials': 'Invalid model credentials or permissions', 'nextTasks.reason.rate-limit': 'Model rate limit reached', 'nextTasks.reason.format': 'Invalid suggestion format returned by the model', 'nextTasks.reason.output-limit': 'Suggestion output limit reached', 'nextTasks.reason.model-call': 'Model call did not complete', 'nextTasks.reason.model-unconfigured': 'No model configured for this chat', 'nextTasks.reason.context': 'No suitable question and answer text', 'nextTasks.reason.busy': 'Chat is still running or finishing', 'nextTasks.reason.host-state': 'Unable to read chat state', 'nextTasks.reason.cancelled': 'Suggestion generation cancelled', 'nextTasks.dismiss': 'Dismiss suggestions', 'reply.fromUser': 'Quoted message', 'reply.fromAssistant': 'Quoted reply', 'nextTasks.generating': 'Generating next task suggestions…', 'nextTasks.failed': 'Suggestions failed (no automatic retry)', 'message.inComposer': 'History text loaded into the composer. Edit it and add images.', 'message.restoreDraft': 'Restore previous draft text', 'message.edit': 'Edit and resend',
 'reply.action': 'Quote reply', 'reply.cancel': 'Cancel quote', 'reply.user': 'User', 'reply.assistant': 'Assistant', 'reply.unavailable': 'Quote reply is unavailable for this composer',
 'community.join': 'Join the QQ community ↗', 'community.name': 'AndroidSix open-source projects', 'community.number': 'Group',
 'groups.title': 'Project groups', 'groups.all': 'All projects', 'groups.none': 'Ungrouped', 'groups.manage': 'Manage projects and groups',
 'groups.reorder': 'Drag group headings to reorder, or focus and press Alt/Option + ↑/↓. Ungrouped can also be reordered.', 'groups.move': 'Move to group…', 'groups.drop': 'Drag a project onto a group heading, or choose Move to group from its menu.', 'groups.name': 'Group name', 'groups.create': 'New group', 'groups.rename': 'Rename', 'groups.delete': 'Delete group',
 'groups.help': 'Each project belongs to one group. Deleting a group leaves its projects ungrouped. The sidebar nests projects under collapsible groups; native search still searches all chats.',
 'groups.intro': 'Organize your projects. The sidebar updates automatically.', 'groups.list': 'Groups', 'groups.projects': 'Projects', 'groups.empty': 'No projects in this group', 'groups.emptyHelp': 'Choose a group for a project in All projects.', 'groups.sortHelp': 'Drag groups or use the arrows to reorder. Synced with the sidebar.', 'groups.up': 'Move up', 'groups.down': 'Move down', 'groups.saved': 'Group changes save automatically', 'groups.sessions': 'chats',
 'project.groupHelp': 'Group changes save immediately. Name and directory changes apply when you click Save.', 'project.editGroup': 'Edit project', 'project.edit': 'Edit project', 'project.title': 'Project name', 'project.path': 'Project directory', 'project.browse': 'Browse…',
 'project.help': 'Choose an existing code directory. Saving moves all existing chats to the new path and keeps their order, archive and pin state. Code files and paths in past messages stay as they are. Chats must be idle with no queued messages; the host releases their writer before migration.',
 'project.resume': 'Resume migration', 'project.pending': 'Project migration is incomplete. Resume it to continue.',
 'common.save': 'Save', 'common.cancel': 'Cancel', 'common.close': 'Close', 'common.busy': 'Working…', 'common.loading': 'Loading projects…',
};
const text = (t, key) => t ? t(key) : workspaceChinese[key];

/** Keep native rows mounted. Portals add group headings and menu entries to public DOM seats. */
export function GroupedSidebar({ Native, ...props }) {
 const { state } = useKit();
 const root = useRef(null), projectMenu = useRef(null);
 const [list, setList] = useState(null), [menu, setMenu] = useState(null), [collapsed, setCollapsed] = useState({});
 const [dropGroup, setDropGroup] = useState(null), [groupError, setGroupError] = useState('');
 const [sessionFeedback, setSessionFeedback] = useState(null);
 useEffect(() => {
  if (!sessionFeedback || sessionFeedback.busy) return;
  const timer = setTimeout(() => setSessionFeedback(null), sessionFeedback.error ? 8000 : 4000);
  return () => clearTimeout(timer);
 }, [sessionFeedback]);
 const [groupInsertion, setGroupInsertion] = useState(null);
 const movingGroup = useRef(false);
 const groups = state?.groups ?? [];
 const workspaces = props.useWorkspaces(value => value);
 const sessions = props.useSessions(value => value);
 const dragSnapshot = useRef(null);
 dragSnapshot.current = { workspaces: workspaces.items, projects: state?.projects ?? [], sessions,
  archived: workspaces.archivedSessionIds, blocked: !!state?.journal || !!state?.workspaceMove || state?.settings?.move?.enabled === false || typeof props.actions?.setSessionOrder !== 'function' };
 const sessionDrag = useMemo(() => sessionProjectDrag({ read: () => dragSnapshot.current, move: callHost, report: setSessionFeedback }), []);
 useEffect(() => () => sessionDrag.dispose(), [sessionDrag]);
 const groupSnapshot = useRef(null);
 const headings = useMemo(() => orderedGroups(groups, state?.ungroupedIndex).map(group => group.id === UNGROUPED ? { ...group, title: text(props.toolboxT, 'groups.none') } : group), [groups, state?.ungroupedIndex, props.toolboxT]);
 groupSnapshot.current = { groups: headings, blocked: !!state?.workspaceMove || !!state?.journal };
 const groupDrag = useMemo(() => groupOrderDrag({ read: () => groupSnapshot.current,
  move: async input => { await callHost(input); await loadState(); }, preview: setGroupInsertion, report: setGroupError }), []);
 const view = props.useStore(value => value.groupBy);
 const grouped = props.wide && view !== 'flat' && !!state;
 const layout = useMemo(() => sidebarLayout(workspaces.items, groups, state?.ungroupedIndex), [workspaces, groups, state?.ungroupedIndex]);
 useEffect(() => {
  const discover = () => {
   const row = root.current?.querySelector('[data-row-key^="workspace:"]');
   setList(row?.closest('[role="tree"]') ?? null);
   const seat = projectMenu.current;
   const nativeMenu = seat?.button?.isConnected && [...document.querySelectorAll('[role="menu"]')].find(element => element.textContent.includes(props.t('delete.workspace')));
   const visible = nativeMenu?.querySelector('[role="presentation"]');
   setMenu(previous => {
    if (visible) return previous?.target === visible && previous.workspaceId === seat.workspaceId ? previous : { ...seat, target: visible };
    return null;
   });
  };
  const observer = new MutationObserver(discover);
  observer.observe(document.body, { childList: true, subtree: true }); discover();
  return () => observer.disconnect();
 }, []);
 const capture = event => {
  const button = event.target.closest?.('button');
  const row = button?.closest('[data-row-key^="workspace:"]');
  if (!row) return;
  const workspaceId = row.getAttribute('data-row-key').slice('workspace:'.length);
  const workspace = workspaces.items.find(item => item.workspaceId === workspaceId);
  if (workspace && button.getAttribute('aria-label') === props.t('actions.workspace.aria', { name: row.textContent.trim() })) projectMenu.current = { workspaceId, button };
 };
 useEffect(() => {
  if (!menu) return;
  const element = menu.target.closest('[role="menu"]');
  if (!element) return;
  element.setAttribute('data-toolbox-project-menu', '');
  const release = protectProjectMenu(document, menu.button, element, () => { if (element.isConnected) menu.button.click(); });
  return () => { release(); element.removeAttribute('data-toolbox-project-menu'); };
 }, [menu]);
 const moveGroup = async (workspaceId, groupId) => {
  if (movingGroup.current || state?.workspaceMove || !workspaces.items.some(row => row.workspaceId === workspaceId)) return;
  movingGroup.current = true; setGroupError('');
  try { await callHost({ type: 'group.assign', workspaceId, groupId: groupId === 'ungrouped' ? '' : groupId }); await loadState(); }
  catch (error) { setGroupError(error.message); }
  finally { movingGroup.current = false; setDropGroup(null); }
 };
 const openEditor = (kind = 'workspace') => {
  const id = menu.workspaceId;
  menu.button.click(); projectMenu.current = null; setMenu(null);
  showOverlay({ kind, workspaceId: id });
 };
 const projectedWorkspaces = useMemo(() => grouped ? { ...workspaces, items: layout.map(row => row.workspace) } : workspaces, [grouped, workspaces, layout]);
 const nativeProps = { ...props,
  actions: props.actions && { ...props.actions, setSessionOrder: (...args) => { if (!sessionDrag.suppressOrder) return props.actions.setSessionOrder(...args); } },
  useWorkspaces: selector => selector(projectedWorkspaces),
  useStore: selector => props.useStore(value => selector(grouped && value.groupBy === 'workspace-tree' ? { ...value, groupBy: 'workspace' } : value)),
  renderSlot: (name, ...args) => props.renderSlot(mirroredSlot(name), ...args),
 };
 const rules = grouped && list ? layout.map(({ workspace, group }) => {
  const selector = `.sk-sidebar [role="tree"]>div:has([data-row-key=${JSON.stringify('workspace:' + workspace.workspaceId)}])`;
  return `${selector}{order:${group * 2 + 1};padding-left:12px;${collapsed[headings[group].id] ? 'display:none!important;' : ''}}`;
 }).join('') : '';
 return <div className="sk-sidebar" ref={root} onClickCapture={capture} onDragStartCapture={event => {
   if (groupDrag.start(event)) return;
   sessionDrag.start(event);
   if (event.target.closest?.('[data-row-key^="session:"]')) return;
   const row = event.target.closest?.('[data-row-key^="workspace:"]');
   const id = row?.getAttribute('data-row-key').slice('workspace:'.length);
   if (workspaces.items.some(item => item.workspaceId === id)) event.dataTransfer.setData('application/x-dsh-toolbox-workspace', id);
  }} onDragOverCapture={event => { if (!groupDrag.over(event)) sessionDrag.over(event); }}
   onDragLeaveCapture={event => { groupDrag.leave(event); sessionDrag.leave(event); }}
   onDropCapture={event => { void groupDrag.drop(event); void sessionDrag.drop(event); }}
   onDragEndCapture={event => { groupDrag.end(event); sessionDrag.end(); setDropGroup(null); }}>
  <style>{`.sk-sidebar [data-toolbox-session-drop]{background:var(--dsw-alias-interactive-bg-hover);outline:1px solid var(--dsw-alias-state-active-primary);outline-offset:-1px;border-radius:6px}`}</style>
  <style>{`.sk-sidebar{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}.sk-groupbar{display:flex;gap:4px;padding:4px 12px;align-items:center;color:var(--dsw-alias-label-secondary);font-size:12px}.sk-groupbar span{flex:1}.sk-group-heading{position:relative;display:flex;align-items:center;gap:6px;min-height:32px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:0 8px}[data-toolbox-project-menu]{min-width:172px!important}[data-toolbox-project-menu] [role="menuitem"]>span:last-child{white-space:nowrap;overflow:visible}.sk-group-heading[data-drop="true"]{background:var(--dsw-alias-interactive-bg-hover);outline:1px solid var(--dsw-alias-state-active-primary);border-radius:6px}.sk-group-heading[draggable="true"]{cursor:grab}.sk-group-heading[draggable="true"]>button:first-child{cursor:inherit}.sk-group-heading[data-insertion]::after{content:"";position:absolute;left:8px;right:8px;height:2px;border-radius:1px;background:var(--dsw-alias-state-active-primary);pointer-events:none}.sk-group-heading[data-insertion="before"]::after{top:0}.sk-group-heading[data-insertion="after"]::after{bottom:0}.sk-group-heading button:focus-visible{outline:2px solid var(--dsw-alias-state-active-primary);outline-offset:-2px}.sk-group-heading>button:first-child{flex:1;text-align:left}.sk-group-heading button{background:transparent;color:inherit;border:0;border-radius:6px;cursor:pointer;padding:5px}.sk-group-heading button:hover{background:var(--dsw-alias-interactive-bg-hover)}${rules}`}</style>
  <div className="sk-groupbar"><span>{text(props.toolboxT, 'groups.title')}</span><Button variant="ghost" title={text(props.toolboxT, 'groups.manage')} aria-label={text(props.toolboxT, 'groups.manage')} onClick={() => showOverlay({ kind: 'groups' })}>…</Button></div>
  {groupError && <p role="alert">{groupError}</p>}
  {sessionFeedback && <p role={sessionFeedback.error ? 'alert' : 'status'} style={{ padding: '0 12px', fontSize: 12 }}>{sessionFeedback.busy ? '正在切换项目…' : sessionFeedback.message}</p>}
  <Native {...nativeProps} />
  {grouped && list && createPortal(<>
   <style>{`.sk-sidebar div:has(>.sk-group-heading){display:flex;flex-direction:column}.sk-sidebar [role="tree"]>div:has([data-row-key="workspace:"]){order:${headings.findIndex(group => group.id === UNGROUPED) * 2 + 1};${collapsed.ungrouped ? 'display:none!important;' : ''}}`}</style>
   {headings.map((group, index) => <div className="sk-group-heading" key={group.id} style={{ order: index * 2 }} data-toolbox-group={group.id} data-drop={dropGroup === group.id}
    draggable={!state?.workspaceMove && !state?.journal}
    data-insertion={groupInsertion?.groupId === group.id ? groupInsertion.edge : undefined}
    title={`${text(props.toolboxT, 'groups.reorder')} ${text(props.toolboxT, 'groups.drop')}`}
    onDragOver={event => { if (!state?.workspaceMove && event.dataTransfer.types.includes('application/x-dsh-toolbox-workspace')) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropGroup(group.id); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDropGroup(null); }}
    onDrop={event => { const id = event.dataTransfer.getData('application/x-dsh-toolbox-workspace'); if (!id) return; event.preventDefault(); event.stopPropagation(); void moveGroup(id, group.id); }}>
    <button aria-expanded={!collapsed[group.id]} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
     onKeyDown={event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); void groupDrag.step(group.id, event.key === 'ArrowUp' ? -1 : 1); } }} onClick={() => setCollapsed(value => ({ ...value, [group.id]: !value[group.id] }))}>{collapsed[group.id] ? '▸' : '▾'} {group.title} <span>({layout.filter(row => row.group === index).length})</span></button>
    <button aria-label={`${group.title} — ${text(props.toolboxT, 'groups.manage')}`} onClick={() => showOverlay({ kind: 'groups' })}>…</button>
   </div>)}
  </>, list)}
  {menu && createPortal(<div data-toolbox-project-actions style={{ display: 'contents' }}>
   <MenuItemButton onSelect={() => openEditor()} icon={<IconFolderOpenOutlineRegular />}>{text(props.toolboxT, 'project.editGroup')}</MenuItemButton>
   <MenuItemButton onSelect={() => openEditor('group-move')} icon={<IconFolderOpenOutlineRegular />}>{text(props.toolboxT, 'groups.move')}</MenuItemButton>
  </div>, menu.target)}
 </div>;
}

function replyInput(sessionId) {
 try {
  const binding = sessionsService?.binding?.(sessionId);
  if (!binding || typeof conversationService?.input?.for !== 'function') return;
  return conversationService.input.for(binding.ctx);
 } catch { return undefined; }
}
function replyWritable(sessionId) {
 try {
  const value = sessionsService?.binding?.(sessionId)?.session?.getSnapshot?.();
  return Boolean(value && !value.removed && (value.subagent === null || value.subagent?.address?.mode === 'continuable'));
 } catch { return false; }
}
function useReplyInput(sessionId, phaseOnly = false) {
 const input = replyInput(sessionId);
 const read = () => { const value = input?.state?.getSnapshot?.(); return phaseOnly ? value?.phase : value; };
 const [snapshot, setSnapshot] = useState(() => ({ input, value: read() }));
 useEffect(() => {
  const sync = () => setSnapshot({ input, value: read() }); sync();
  return input?.state?.subscribe?.(sync);
 }, [input, phaseOnly]);
 // A reused composer must never expose the previous chat's draft for one render.
 return [input, snapshot.input === input ? snapshot.value : read()];
}
const editDrafts = new Map();
const DRAFT_CHANGED = 'dsh-session-toolbox:edit-draft';
function announceDraft() { window.dispatchEvent(new CustomEvent(DRAFT_CHANGED)); }
/** Programmatic writes preserve native attachments and semantic reference chips. */
export function fillComposer(sessionId, value, replace = false) {
 const input = replyInput(sessionId), snapshot = input?.state?.getSnapshot?.();
 if (!replyWritable(sessionId) || snapshot?.phase !== 'plain') throw new Error('请等待当前会话输入框就绪');
 // Image-only history has no text to load. Keep the existing draft intact.
 if (replace && !value.trim()) { input.focus?.(); return; }
 const draft = input.draftSnapshot ?? { text: snapshot.draft ?? '', references: (snapshot.occurrences ?? []).map(({ source, ref, offset, length, label, clipboardText, appearance, invalid }) => ({ source, ref, offset, length, label, clipboardText, ...(appearance === undefined ? {} : { appearance }), ...(invalid === undefined ? {} : { invalid }) })) };
 if (replace) {
  if (draft.text && !editDrafts.has(sessionId)) editDrafts.set(sessionId, draft);
  input.setDraft({ text: value, references: [] });
 } else {
  input.setDraft({ ...draft, text: draft.text ? `${draft.text}\n\n${value}` : value });
 }
 input.persistCurrentDraft?.(); input.focus?.(); announceDraft();
}
export function EditDraftNotice({ sessionId, t }) {
 const [input, snapshot] = useReplyInput(sessionId), [, update] = useState(0);
 const [error, setError] = useState('');
 useEffect(() => { const refresh = () => update(value => value + 1); window.addEventListener(DRAFT_CHANGED, refresh); return () => window.removeEventListener(DRAFT_CHANGED, refresh); }, []);
 useEffect(() => { if (snapshot?.phase === 'plain' && !snapshot.draft && editDrafts.delete(sessionId)) announceDraft(); }, [sessionId, snapshot?.draft, snapshot?.phase]);
 if (!editDrafts.has(sessionId)) return null;
 return <div data-toolbox-edit-draft className="sk-reply-preview"><style>{replyStyle}</style><div>{text(t, 'message.inComposer')}</div><Button variant="ghost" disabled={snapshot?.phase !== 'plain'} onClick={() => {
  try { if (!replyWritable(sessionId) || input.state.getSnapshot().phase !== 'plain') return; input.setDraft(editDrafts.get(sessionId)); input.persistCurrentDraft?.(); input.focus?.(); editDrafts.delete(sessionId); announceDraft(); } catch (reason) { setError(reason.message); }
 }}>{text(t, 'message.restoreDraft')}</Button>{error && <span role="alert">{error}</span>}</div>;
}
const candidateView = createCandidateView({ getItem: key => window.sessionStorage?.getItem(key), setItem: (key, value) => window.sessionStorage?.setItem(key, value) });
export function NextTaskAction({ sessionId, seq, canWrite, running, t }) {
 const [result, setResult] = useState(() => candidateView.get(sessionId)), [pending, setPending] = useState(false), [error, setError] = useState('');
 const locked = useRef(false);
 useEffect(() => { setResult(candidateView.get(sessionId)); return candidateView.subscribe(sessionId, setResult); }, [sessionId]);
 const generating = pending || result?.status === 'generating';
 const label = text(t, generating ? 'nextTasks.generating' : result?.seq === seq && result.status === 'ready' ? 'nextTasks.regenerate' : 'nextTasks.generate');
 return <><Tooltip label={label} side="bottom"><button type="button" className="sk-reply-button" data-toolbox-next-generate aria-label={label} aria-busy={generating} disabled={!canWrite || running || generating} onClick={async () => {
  if (locked.current || !canWrite || running || generating) return;
  locked.current = true; setPending(true); setError('');
  try { candidateView.reveal(sessionId, await callHost({ type: 'nextTasks.generate', sessionId, seq })); }
  catch (reason) { setError(reason.message); }
  finally { locked.current = false; setPending(false); }
 }}><NextTaskIcon busy={generating} /></button></Tooltip>{error && <span className="sk-next-action-error" role="alert">{error}</span>}</>;
}
/** Observe only once per composer. Candidate buttons belong to their answer footer. */
export function NextTaskController({ sessionId, useSession }) {
 const { state } = useKit();
 const [, snapshot] = useReplyInput(sessionId);
 const running = useSession ? useSession(value => value.running) : false;
 const enabled = state?.settings?.nextTasks?.enabled !== false;
 const editing = Boolean(snapshot?.draft?.trim() || snapshot?.attachmentIds?.length);
 const editingRef = useRef(editing); editingRef.current = editing;
 useEffect(() => { if (editing) candidateView.dismiss(sessionId); }, [sessionId, editing, snapshot?.draft, JSON.stringify(snapshot?.attachmentIds ?? [])]);
 useEffect(() => {
  let live = true, pending = false;
  if (running) candidateView.publish(sessionId, null);
  const refresh = async () => {
   if (running || pending) return;
   pending = true;
   try {
    const next = await callHost({ type: 'nextTasks.get', sessionId });
    if (live) { candidateView.publish(sessionId, next); if (editingRef.current && !next.manual) candidateView.dismiss(sessionId); }
   } catch { if (live) candidateView.publish(sessionId, null); }
   finally { pending = false; }
  };
  void refresh(); const timer = !running ? setInterval(refresh, 3000) : undefined;
  return () => { live = false; clearInterval(timer); };
 }, [sessionId, enabled, running]);
 return null;
}
export function NextTaskCandidates({ sessionId, seq, t }) {
 const [result, setResult] = useState(() => candidateView.get(sessionId)), [error, setError] = useState('');
 useEffect(() => { setResult(candidateView.get(sessionId)); return candidateView.subscribe(sessionId, setResult); }, [sessionId]);
 const candidates = candidatesForTurn(result, seq);
 if (!candidates.length) {
  if (result?.seq !== seq || !['generating', 'ready', 'failed', 'unavailable', 'cancelled', 'error'].includes(result?.status)) return null;
  const key = result.status === 'generating' ? 'nextTasks.generating' : result.status === 'ready' ? 'nextTasks.empty' : result.status === 'unavailable' ? 'nextTasks.unavailable' : 'nextTasks.failed';
  const reasonKey = `nextTasks.reason.${result.reason}`;
  return <div data-toolbox-next-status className="sk-next-status"><style>{conversationExtrasStyle}</style><span role="status">{text(t, key)}{Object.hasOwn(workspaceChinese, reasonKey) ? ` · ${text(t, reasonKey)}` : ''}</span><button type="button" className="sk-extras-close" aria-label={text(t, 'nextTasks.dismiss')} onClick={() => candidateView.dismiss(sessionId)}><CloseIcon /></button></div>;
 }
 return <section data-toolbox-next-tasks className="sk-next-tasks" aria-label={text(t, 'nextTasks.title')}>
  <style>{conversationExtrasStyle}</style>
  <div className="sk-next-heading"><span>{text(t, 'nextTasks.title')}</span><button className="sk-extras-close" type="button" aria-label={text(t, 'nextTasks.dismiss')} title={text(t, 'nextTasks.dismiss')} onClick={() => candidateView.dismiss(sessionId)}><CloseIcon /></button></div>
  <div className="sk-next-options">{candidates.map(value => <button className="sk-next-task" type="button" key={value} onClick={() => { try { fillComposer(sessionId, value); candidateView.dismiss(sessionId); setError(''); } catch (reason) { setError(reason.message); } }}><span>{value}</span><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><path d="M3 8h9M8 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" /></svg></button>)}</div>
  {error && <span role="alert">{error}</span>}
 </section>;
}

function NextTaskSettings({ state, act, busy }) {
 const usage = state?.nextTasks, totals = usage?.totals;
 const lastFailure = usage?.recent?.[0]?.status === 'failed' ? usage.recent[0] : null;
 const number = value => Number(value ?? 0).toLocaleString();
 return <section className="box" data-toolbox-next-settings><h3>接下来任务联想</h3>
  <label className="row"><input type="checkbox" checked={state?.settings?.nextTasks?.enabled !== false} disabled={busy || !state?.settings} onChange={event => void act({ type: 'settings.update', patch: { nextTasks: { enabled: event.target.checked } } }, event.target.checked ? '已开启任务联想' : '已关闭任务联想并取消待生成请求').catch(() => {})} /> 问答结束后生成候选（默认开启）</label>
  <p className="muted">每轮正常结束后额外调用一次该会话的模型；取最近最多 6 条可见文字（不含图片、工具和思考过程），输入上限 12 KB，输出上限 600 token。点击候选填入输入框，已有草稿会保留，由你决定是否发送。失败不自动重试。</p>
  {usage?.available === false && <p className="error">当前 DSH 未提供模型调用接口，暂不生成。</p>}
  {lastFailure && <p className="error" role="status">最近一次联想失败：{text(undefined, `nextTasks.reason.${lastFailure.reason ?? 'model-call'}`) ?? text(undefined, 'nextTasks.reason.model-call')}。不会自动重试，可检查模型配置后点击回答末尾的星光图标手动重试。</p>}
  {totals && <><div className="row"><span className="pill">调用 {number(totals.calls)}</span><span className="pill">成功 {number(totals.completed)}</span><span className="pill">失败 {number(totals.failed)} / 取消 {number(totals.cancelled)}</span><span className="pill">已报告总 token {number(totals.totalTokens)}</span></div>
   <p className="muted">独立记录本功能的模型用量，不计入会话消息统计。未缓存输入 {number(totals.inputTokens)} · 缓存读取 {number(totals.cacheReadTokens)} · 缓存写入 {number(totals.cacheWriteTokens)} · 输出 {number(totals.outputTokens)}（含思考 {number(totals.reasoningTokens)}）。按服务商报告统计；缺少完整用量 {number(totals.unreported)} 次，尚未结算 {number(usage.pending)} 次，消耗未计入总数。日期按 UTC 记录。</p>
   {!!usage.models?.length && <div style={{ overflowX: 'auto' }}><table><thead><tr><th>模型</th><th>调用</th><th>未缓存输入</th><th>缓存读 / 写</th><th>输出</th><th>已报告总 token</th></tr></thead><tbody>{usage.models.map(row => <tr key={`${row.provider}:${row.model}`}><td>{row.provider} / {row.model}</td><td>{number(row.calls)}</td><td>{number(row.inputTokens)}</td><td>{number(row.cacheReadTokens)} / {number(row.cacheWriteTokens)}</td><td>{number(row.outputTokens)}</td><td>{number(row.totalTokens)}</td></tr>)}</tbody></table></div>}
   {!!usage.days?.length && <details><summary>最近 90 天消耗</summary><table><thead><tr><th>日期（UTC）</th><th>调用</th><th>已报告总 token</th><th>缺少用量</th></tr></thead><tbody>{[...usage.days].reverse().map(row => <tr key={row.date}><td>{row.date}</td><td>{number(row.calls)}</td><td>{number(row.totalTokens)}</td><td>{number(row.unreported)}</td></tr>)}</tbody></table></details>}
  </>}
 </section>;
}
const deletedMessages = new Map();
function deletedStore(id) {
 if (!deletedMessages.has(id)) deletedMessages.set(id, { seqs: new Set(), listeners: new Set(), revision: 0 });
 return deletedMessages.get(id);
}
function publishDeleted(id, seqs) {
 const state = deletedStore(id); state.revision++; state.seqs = new Set(seqs);
 for (const listener of state.listeners) listener(state.seqs);
}
function refreshDeleted(id) {
 const state = deletedStore(id);
 if (state.loading) return state.loading;
 const revision = state.revision;
 state.loading = callHost({ type: 'message.list', sessionId: id }).then(value => { if (state.revision === revision) publishDeleted(id, value.seqs ?? []); }).catch(() => {
  if (state.listeners.size && !state.retry) state.retry = setTimeout(() => { state.retry = undefined; void refreshDeleted(id); }, 1500);
 }).finally(() => { state.loading = null; });
 return state.loading;
}
function useDeletedMessages(id, running) {
 const state = deletedStore(id), [seqs, setSeqs] = useState(state.seqs);
 useEffect(() => {
  state.listeners.add(setSeqs); setSeqs(state.seqs); void refreshDeleted(id);
  const refresh = () => { void refreshDeleted(id); }; window.addEventListener('focus', refresh);
  return () => { state.listeners.delete(setSeqs); if (!state.listeners.size) { clearTimeout(state.retry); state.retry = undefined; } window.removeEventListener('focus', refresh); };
 }, [id, running]);
 return seqs;
}
const replyStyle = `
.sk-next-spinner{transform-origin:8px 8px;animation:sk-next-spin 900ms linear infinite}
@keyframes sk-next-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.sk-next-spinner{animation:none}}
.sk-next-action-error{max-width:220px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.sk-reply-button:focus-visible{outline:2px solid var(--dsw-alias-state-active-primary);outline-offset:2px}
.sk-reply-button{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:5px;background:transparent;border:0;border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-tertiary);cursor:pointer}.sk-reply-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.sk-reply-button:disabled{opacity:.4;cursor:default}.sk-reply-preview{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;background:var(--dsw-alias-bg-module-platform)}.sk-reply-preview>div{min-width:0;flex:1;border-left:2px solid var(--dsw-alias-label-tertiary);padding-left:10px}.sk-reply-preview p{margin:4px 0 0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:pre-wrap;overflow-wrap:anywhere}.sk-reply-preview strong{font-size:12px;font-weight:500}`;
const replyCarets = new WeakMap();
export function ReplyMessage({ Native, mirrors, toolboxT, ...props }) {
 const root = useRef(null), [target, setTarget] = useState(null), [error, setError] = useState('');
 const [input, phase] = useReplyInput(props.sessionId, true);
 const quote = messageReply(props.node);
 const canWrite = props.useSession ? props.useSession(value => !value.removed && (value.subagent === null || value.subagent?.address?.mode === 'continuable')) : false;
 const running = props.useSession ? props.useSession(value => value.running) : false;
 const seq = messageSequence(props.node), deleted = useDeletedMessages(props.sessionId, running).has(seq);
 useEffect(() => {
  if (deleted) { setTarget(null); return; }
  const discover = () => setTarget(root.current?.querySelector('[data-clock]') ?? null);
  const observer = new MutationObserver(discover); if (root.current) observer.observe(root.current, { childList: true, subtree: true }); discover();
  return () => observer.disconnect();
 }, [deleted]);
 const label = text(toolboxT, 'reply.action');
 const reply = () => {
  try {
   if (!replyAvailable || !input || !canWrite) throw new Error(text(toolboxT, 'reply.unavailable'));
   insertReply(input, quote, `${label} · ${text(toolboxT, quote.role === 'user' ? 'reply.user' : 'reply.assistant')}`, replyCarets.get(input));
   setError('');
  } catch (reason) { setError(reason.message); }
 };
 const nativeProps = { ...props, renderSlot: (name, ...args) => props.renderSlot(mirrors.get(name) ?? name, ...args) };
 if (deleted) return null;
 return <div ref={root} style={{ display: 'contents' }}><Native {...nativeProps} /><style>{replyStyle}</style>
  {target && createPortal(<>{quote?.role === 'assistant' && props.node?.kind === 'turn-tail' && Number.isSafeInteger(props.node.data?.seq) && <NextTaskAction sessionId={props.sessionId} seq={props.node.data.seq} canWrite={canWrite} running={running} t={toolboxT} />}
   {quote && <Tooltip label={label} side="bottom"><button type="button" className="sk-reply-button" aria-label={label} disabled={!replyAvailable || !input || !canWrite || phase !== 'plain'} onClick={reply}><QuoteIcon /></button></Tooltip>}
   {['user', 'steering'].includes(props.node?.kind) && Number.isSafeInteger(props.node.anchorSeq) && <MessageAction sessionId={props.sessionId} node={props.node} canWrite={canWrite} running={running} t={toolboxT} />}
   {seq !== undefined && <Tooltip label={text(toolboxT, 'message.delete')} side="bottom"><button type="button" className="sk-reply-button" aria-label={text(toolboxT, 'message.delete')} disabled={!canWrite || running} onClick={() => showOverlay({ kind: 'message-delete', sessionId: props.sessionId, seq })}><DeleteIcon /></button></Tooltip>}
  </>, target)}
  {props.node?.kind === 'turn-tail' && <NextTaskCandidates sessionId={props.sessionId} seq={props.node.data?.seq} t={toolboxT} />}
  {error && <span role="alert">{error}</span>}
 </div>;
}
export function QuoteIcon() {
 return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.15" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M5 8h2v2H5V8c0-1.3.6-2.3 1.6-2.7M9 8h2v2H9V8c0-1.3.6-2.3 1.6-2.7" strokeLinejoin="round" /></svg>;
}
function NextTaskIcon({ busy }) {
 return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.15" aria-hidden="true">{busy ? <><circle cx="8" cy="8" r="5.5" opacity=".25" /><path className="sk-next-spinner" d="M8 2.5A5.5 5.5 0 0 1 13.5 8" strokeLinecap="round" /></> : <><path d="m6.5 3 1.2 3.8 3.8 1.2-3.8 1.2L6.5 13 5.3 9.2 1.5 8l3.8-1.2L6.5 3Z" strokeLinejoin="round" /><path d="m12.5 1 .6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6.6-1.9Z" strokeLinejoin="round" /></>}</svg>;
}
function CloseIcon() {
 return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" strokeLinecap="round" /></svg>;
}
const conversationExtrasStyle = `
.sk-next-status{display:flex;align-items:center;gap:8px;margin:12px 0 4px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px}.sk-next-status>span{min-width:0}.sk-next-status>button{flex:none}
.sk-next-tasks{max-width:640px;min-width:0;margin:18px 0 4px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px}
.sk-next-heading{display:flex;align-items:center;gap:12px;margin-bottom:8px;color:var(--dsw-alias-label-secondary);font-size:12px}.sk-next-heading>span{flex:1}
.sk-next-options{display:flex;flex-direction:column;align-items:flex-start;gap:7px}
.sk-next-task{box-sizing:border-box;display:inline-flex;align-items:center;gap:12px;max-width:100%;min-height:34px;padding:7px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;line-height:20px;text-align:left;cursor:pointer;transition:background 120ms,color 120ms,border-color 120ms}
.sk-next-task>span{min-width:0;overflow-wrap:anywhere}.sk-next-task>svg{flex:none;color:var(--dsw-alias-label-tertiary)}.sk-next-task:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-label-quaternary,var(--dsw-alias-border-l2))}
.sk-extras-close{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:26px;width:26px;height:26px;padding:5px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.sk-extras-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sk-next-task:focus-visible,.sk-extras-close:focus-visible,.sk-sent-quote-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-active-primary);outline-offset:3px}
.sk-next-task:disabled,.sk-extras-close:disabled{opacity:.45;cursor:default}
.sk-quote-list{box-sizing:border-box;order:-1;display:flex;flex-direction:column;gap:6px;min-width:0;max-height:180px;overflow-y:auto;margin:4px 12px 0;padding:3px}
.sk-quote-draft{display:flex;flex:none;align-items:flex-start;gap:10px;min-width:0;padding:10px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);box-sizing:border-box}
.sk-quote-mark{display:flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;color:var(--dsw-alias-label-secondary)}
.sk-quote-copy{flex:1;min-width:0;border-left:2px solid var(--dsw-alias-state-active-primary);padding-left:10px}.sk-quote-label{display:block;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}
.sk-quote-excerpt{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;white-space:pre-wrap;line-height:20px;margin-top:3px}
.sk-sent-quote{box-sizing:border-box;display:block;min-width:0;margin:0 0 10px;padding:9px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);border-left:2px solid var(--dsw-alias-state-active-primary);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;white-space:normal}
.sk-sent-quote-toggle{display:flex;align-items:center;gap:7px;width:100%;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;text-align:left;cursor:pointer}.sk-sent-quote-toggle>svg{flex:none}.sk-sent-quote-toggle>span{flex:1}.sk-sent-quote-toggle svg:last-child{color:var(--dsw-alias-label-tertiary);transition:transform 120ms}.sk-sent-quote[data-expanded=true] .sk-sent-quote-toggle svg:last-child{transform:rotate(180deg)}
.sk-sent-quote .sk-quote-excerpt{-webkit-line-clamp:3}.sk-sent-quote[data-expanded=true] .sk-quote-excerpt{display:block}
@media(prefers-reduced-motion:reduce){.sk-next-task,.sk-sent-quote-toggle svg:last-child{transition:none}}
`;

export function SentReplyCard({ node, t }) {
 const [expanded, setExpanded] = useState(false);
 const quote = node.data;
 return <span data-toolbox-sent-reply className="sk-sent-quote" data-expanded={expanded}><style>{conversationExtrasStyle}</style>
  <button className="sk-sent-quote-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><QuoteIcon /><span>{text(t, quote.role === 'user' ? 'reply.fromUser' : 'reply.fromAssistant')}</span><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
  <span className="sk-quote-excerpt"><UserTextRun text={quote.text} /></span>
 </span>;
}
function RestoreIcon() {
 return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M6 3 2 6.5 6 10M2.5 6.5H10a4 4 0 0 1 0 8H8" /></svg>;
}

const CHECKPOINT_CHANGED = 'dsh-session-toolbox:checkpoint-changed';
export function MessageAction({ sessionId, node, canWrite, running, t }) {
 const [status, setStatus] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
 const locked = useRef(false);
 useEffect(() => {
  let live = true, revision = 0;
  setStatus(null); setError('');
  const refresh = () => {
   const request = ++revision;
   return callHost({ type: 'checkpoint.status', sessionId, seq: node.anchorSeq }).then(value => { if (live && request === revision) { setStatus(value); setError(''); } }).catch(reason => { if (live && request === revision) { setStatus(null); setError(reason.message); } });
  };
  void refresh();
  window.addEventListener(CHECKPOINT_CHANGED, refresh); window.addEventListener('focus', refresh);
  const timer = running ? setInterval(refresh, 3000) : undefined;
  return () => { live = false; revision++; clearInterval(timer); window.removeEventListener(CHECKPOINT_CHANGED, refresh); window.removeEventListener('focus', refresh); };
 }, [sessionId, node.anchorSeq, running]);
 const edit = status?.action === 'edit';
 const label = text(t, edit ? 'message.edit' : status ? 'checkpoint.action' : 'checkpoint.loading');
 const open = async () => {
  if (locked.current || !canWrite) return;
  locked.current = true; setBusy(true); setError('');
  try {
   const latest = await callHost({ type: 'checkpoint.status', sessionId, seq: node.anchorSeq }); setStatus(latest);
   if (latest.action === 'pending') return;
   if (latest.action === 'edit') fillComposer(sessionId, messageReply(node)?.text ?? '', true);
   else showOverlay({ kind: 'checkpoint', sessionId, seq: latest.seq ?? node.anchorSeq });
  } catch (reason) { setError(reason.message); }
  finally { locked.current = false; setBusy(false); }
 };
 return <><Tooltip label={error || label} side="bottom"><button type="button" className="sk-reply-button" aria-label={label} disabled={!canWrite || busy || (!status && !error) || status?.action === 'pending'} onClick={() => void open()}>{edit ? <EditIcon /> : <RestoreIcon />}</button></Tooltip>{error && <span role="alert">{error}</span>}</>;
}
function EditIcon() {
 return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><path d="m10.5 2.5 3 3M3 10l7.7-7.7a1.4 1.4 0 0 1 2 2L5 12l-3 1 1-3Z" strokeLinejoin="round" /></svg>;
}
function GroupOrderIcon({ down = false }) {
 return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={down ? 'M8 3v10m-4-4 4 4 4-4' : 'M8 13V3M4 7l4-4 4 4'} /></svg>;
}
function DeleteIcon() {
 return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><path d="M2.5 4.5h11M6 4V2.5h4V4M4 4.5l.7 9h6.6l.7-9M6.5 6.5v5M9.5 6.5v5" strokeLinejoin="round" /></svg>;
}
export function DeleteMessageDialog({ request, close, t }) {
 const [busy, setBusy] = useState(false), [error, setError] = useState('');
 const locked = useRef(false);
 const remove = async () => {
  if (locked.current) return;
  locked.current = true; setBusy(true); setError('');
  try {
   if (!replyWritable(request.sessionId)) throw new Error(text(t, 'reply.unavailable'));
   const result = await callHost({ type: 'message.delete', sessionId: request.sessionId, seq: request.seq });
   if (!result.removedFromContext) throw new Error('宿主尚未确认移除上下文，请重试');
   publishDeleted(request.sessionId, result.seqs); close(); dispatchNotice(text(t, 'message.deleted'));
  } catch (reason) { setError(reason.message); }
  finally { locked.current = false; setBusy(false); }
 };
 const dismiss = () => { if (!locked.current) close(); };
 return <Modal open title={text(t, 'message.delete')} description={text(t, 'message.deleteHelp')} closeLabel={text(t, 'common.close')} onClose={dismiss}
  footer={<><Button variant="outline" disabled={busy} onClick={dismiss}>{text(t, 'common.cancel')}</Button><Button variant="primary" style={{ background: 'var(--dsw-alias-state-error-primary,#c93636)', color: '#fff', borderColor: 'transparent' }} disabled={busy} onClick={() => void remove()}>{text(t, busy ? 'common.busy' : 'message.deleteConfirm')}</Button></>}>
  {error && <p role="alert">{error}</p>}
 </Modal>;
}

export function CheckpointDialog({ request, close, t }) {
 const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState(false), [revision, setRevision] = useState(0);
 useEffect(() => {
  let live = true; setPreview(null); setError('');
  callHost({ type: 'checkpoint.preview', sessionId: request.sessionId, seq: request.seq }).then(value => { if (live) setPreview(value); }).catch(reason => { if (live) setError(reason.message); });
  return () => { live = false; };
 }, [request.sessionId, request.seq, revision]);
 const restore = async () => {
  if (busy || !preview || preview.conflicts.length || !preview.files.length) return;
  setBusy(true); setError('');
  try { await callHost({ type: 'checkpoint.restore', sessionId: request.sessionId, seq: request.seq, id: preview.id }); setDone(true); window.dispatchEvent(new CustomEvent(CHECKPOINT_CHANGED)); }
  catch (reason) { setError(reason.message); setPreview(null); }
  finally { setBusy(false); }
 };
 const dismiss = () => { if (!busy) close(); };
 return <Modal open title={text(t, 'checkpoint.action')} description={text(t, 'checkpoint.help')} closeLabel={text(t, 'common.close')} onClose={dismiss}
  footer={<><Button variant="outline" disabled={busy} onClick={dismiss}>{text(t, done ? 'common.close' : 'common.cancel')}</Button>{!done && <><Button variant="outline" disabled={busy} onClick={() => setRevision(value => value + 1)}>{text(t, 'checkpoint.retry')}</Button><Button disabled={busy || !preview?.files.length || preview?.conflicts.length > 0} onClick={() => void restore()}>{text(t, busy ? 'common.busy' : 'checkpoint.restore')}</Button></>}</>}>
  <div className="sk"><style>{styles}</style>
   {done ? <p role="status">{text(t, 'checkpoint.done')}</p> : <>{!preview && !error && <p role="status">{text(t, 'checkpoint.loading')}</p>}
    {preview && (preview.files.length ? <ul style={{ maxHeight: '40vh', overflow: 'auto', overflowWrap: 'anywhere' }}>{preview.files.map(file => <li key={file.path}><code>{file.path}</code> <span className="muted">{({ modify: '↶', restore: '+', delete: '−' })[file.action]}</span></li>)}</ul> : <p>{text(t, 'checkpoint.empty')}</p>)}
    {preview?.conflicts.length > 0 && <div role="alert"><p>{text(t, 'checkpoint.conflicts')}</p><ul>{preview.conflicts.map(path => <li key={path}><code>{path}</code></li>)}</ul></div>}</>}
   {error && <p role="alert">{error}</p>}
  </div>
 </Modal>;
}

export function SelectionReplyMenu({ t }) {
 const [menu, setMenu] = useState(null), [error, setError] = useState('');
 const root = useRef(null);
 useEffect(() => {
  const open = event => {
   const selected = selectedReply(window.getSelection?.());
   if (!selected || !selected.surface.contains(event.target) || event.target.closest?.('input,textarea,[contenteditable="true"]')) return;
   event.preventDefault(); event.stopPropagation(); setError('');
   setMenu({ ...selected, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 208)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 110)) });
  };
  document.addEventListener('contextmenu', open, true);
  return () => document.removeEventListener('contextmenu', open, true);
 }, []);
 useEffect(() => {
  if (!menu) return;
  root.current?.querySelector('button')?.focus();
  const dismiss = event => { if (!root.current?.contains(event.target)) setMenu(null); };
  const close = () => setMenu(null);
  document.addEventListener('pointerdown', dismiss, true); window.addEventListener('scroll', close, true); window.addEventListener('resize', close);
  return () => { document.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
 }, [menu]);
 if (!menu) return null;
 const input = replyInput(menu.sessionId), available = replyAvailable && replyWritable(menu.sessionId) && input?.state.getSnapshot()?.phase === 'plain';
 const quote = () => {
  try {
   if (!available || !replyWritable(menu.sessionId) || !menu.surface.isConnected) throw new Error(text(t, 'reply.unavailable'));
   window.getSelection()?.removeAllRanges();
   insertReply(input, { role: menu.role, text: menu.text }, text(t, 'reply.selection'), replyCarets.get(input));
   setMenu(null);
  } catch (reason) { setError(reason.message); }
 };
 const keyboard = event => {
  if (event.key === 'Escape') { event.preventDefault(); setMenu(null); }
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const buttons = [...root.current.querySelectorAll('button:not(:disabled)')]; const index = buttons.indexOf(document.activeElement); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
 };
 return createPortal(<div ref={root} data-toolbox-selection-menu role="menu" aria-label={text(t, 'reply.selection')} onKeyDown={keyboard} style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 10000, width: 200, padding: 5, borderRadius: 'var(--dsw-radius-md,8px)', background: 'var(--dsw-alias-bg-module-platform,#303030)', border: '1px solid var(--dsw-alias-border-l2,#484848)', boxShadow: '0 6px 24px #0005', color: 'var(--dsw-alias-label-primary)', fontSize: 13 }}>
  <style>{`.sk-selection-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;background:transparent;color:inherit;border:0;border-radius:var(--dsw-radius-sm,6px);font:inherit;text-align:left;cursor:pointer}.sk-selection-item:hover,.sk-selection-item:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}.sk-selection-item:disabled{opacity:.4;cursor:default}`}</style>
  <button className="sk-selection-item" role="menuitem" type="button" onClick={async () => { try { await navigator.clipboard.writeText(menu.text); setMenu(null); } catch (reason) { setError(reason.message); } }}>{text(t, 'reply.copy')}</button>
  <button className="sk-selection-item" role="menuitem" type="button" disabled={!available} onClick={quote}><QuoteIcon />{text(t, 'reply.selection')}</button>
  {error && <p role="alert">{error}</p>}
 </div>, document.body);
}
export function ReplyPreview({ sessionId, t, renderFactorySlot }) {
 const [input, snapshot] = useReplyInput(sessionId);
 const [error, setError] = useState(''), [target, setTarget] = useState(null), anchor = useRef(null);
 useEffect(() => {
  if (!input?.actions?.captureInsertion) return;
  const capture = () => {
   const editor = anchor.current?.closest('[data-conversation-session]')?.querySelector('[data-composer-card] [contenteditable="true"]');
   if (editor && editor.contains(document.activeElement)) replyCarets.set(input, input.actions.captureInsertion());
  };
  // Capture before a message button or text selection takes focus away from the composer.
  document.addEventListener('pointerdown', capture, true); document.addEventListener('focusout', capture, true);
  return () => { document.removeEventListener('pointerdown', capture, true); document.removeEventListener('focusout', capture, true); replyCarets.delete(input); };
 }, [input, sessionId]);
 const quotes = (snapshot?.occurrences ?? []).filter(row => row.source === REPLY_SOURCE).flatMap(occurrence => {
  try { return [{ occurrence, quote: readReply(occurrence.ref) }]; } catch { return []; /* invalid chips remain native */ }
 });
 useEffect(() => {
  if (!quotes.length) { setTarget(null); return; }
  const surface = anchor.current?.closest('[data-conversation-session]');
  const find = () => { const card = surface?.querySelector('[data-composer-card]'); if (card) { setTarget({ sessionId, card }); return true; } return false; };
  if (find() || !surface) return;
  const observer = new MutationObserver(() => { if (find()) observer.disconnect(); }); observer.observe(surface, { childList: true, subtree: true });
  return () => observer.disconnect();
 }, [sessionId, Boolean(quotes.length)]);
 const cancel = occurrence => { try { input.setDraft(withoutReply(input.state.getSnapshot(), occurrence)); input.persistCurrentDraft?.(); input.focus?.(); setError(''); } catch (reason) { setError(reason.message); } };
 return <><span hidden ref={anchor} />{quotes.length > 0 && target?.sessionId === sessionId && createPortal(<div className="sk-quote-list" data-toolbox-replies role="region" aria-label={text(t, 'reply.action')} onMouseDown={event => event.stopPropagation()}>
  <style>{conversationExtrasStyle}</style>{quotes.map(({ occurrence, quote }, index) => <div className="sk-quote-draft" data-toolbox-reply key={occurrence.occurrenceId ?? `${occurrence.offset}:${occurrence.ref}`}>
   <span className="sk-quote-mark"><QuoteIcon /></span>
   <div className="sk-quote-copy"><strong className="sk-quote-label">{quotes.length > 1 && `${index + 1} · `}{text(t, quote.role === 'user' ? 'reply.fromUser' : 'reply.fromAssistant')}</strong><span className="sk-quote-excerpt">{typeof renderFactorySlot === 'function' ? renderFactorySlot('conversation.user.text', { text: quote.text, facts: { toolboxQuoteBody: true } }) : quote.text}</span></div>
   <button type="button" className="sk-extras-close" aria-label={`${text(t, 'reply.cancel')}${quotes.length > 1 ? ` ${index + 1}` : ''}`} title={text(t, 'reply.cancel')} disabled={snapshot.phase !== 'plain'} onClick={() => cancel(occurrence)}><CloseIcon /></button>
  </div>)}{error && <span role="alert">{error}</span>}
 </div>, target.card)}</>;
}


function WorkspaceSection({ state, t }) {
 const [busy, setBusy] = useState(false), [error, setError] = useState('');
 const resume = async () => {
  setBusy(true); setError('');
  try { await callHost({ type: 'workspace.complete' }); }
  catch (reason) { setError(reason.message); }
  finally { await loadState(); setBusy(false); }
 };
 return <section className="box"><h3>项目分组与路径 / Projects</h3>
  <p className="muted">{(state?.groups?.length ?? 0) + 1} 个分组（含未分组） · {state?.projects?.length ?? 0} 个项目。侧栏按分组展开项目，项目菜单可编辑名称、路径和分组。</p>
  <div><Button variant="outline" onClick={() => showOverlay({ kind: 'groups' })}>{text(t, 'groups.manage')}</Button></div>
  {state?.workspaceMove && <p role="status">{text(t, 'project.pending')}<br /><span className="mono">{state.workspaceMove.fromCwd} → {state.workspaceMove.toCwd}</span><br />{state.workspaceMove.moved.length} / {state.workspaceMove.sessionIds.length} <Button variant="outline" disabled={busy} onClick={() => void resume()}>{text(t, busy ? 'common.busy' : 'project.resume')}</Button></p>}
  {error && <p className="error" role="alert">{error}</p>}
 </section>;
}

const groupsStyle = `
.sk-groups-dialog{width:min(820px,calc(100vw - 40px));max-width:calc(100vw - 40px);max-height:calc(100dvh - 40px);overflow-y:auto;overscroll-behavior:contain}
.sk-groups{color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;min-width:0}
.sk-groups *{box-sizing:border-box}.sk-groups button,.sk-groups input,.sk-groups select{font:inherit}.sk-groups button{cursor:pointer}.sk-groups button:disabled{cursor:default}
.sk-groups-intro{margin:0 0 20px;color:var(--dsw-alias-label-secondary)}
.sk-groups-layout{display:grid;grid-template-columns:212px minmax(0,1fr);gap:24px;min-height:360px}
.sk-groups-sidebar{display:flex;flex-direction:column;gap:16px;min-width:0;border-right:1px solid var(--dsw-alias-border-l2);padding-right:20px}
.sk-groups-caption{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}
.sk-groups-nav{display:flex;flex-direction:column;gap:4px;max-height:300px;overflow-y:auto;min-width:0}
.sk-group-filter{display:flex;align-items:center;gap:8px;flex:none;width:100%;min-height:36px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);padding:8px 10px;text-align:left}
.sk-group-filter>span:first-child{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:1}.sk-group-count{font-size:12px;font-variant-numeric:tabular-nums;opacity:.7}
.sk-group-filter:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.sk-group-filter[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
.sk-group-filter-row{position:relative;display:flex;align-items:center;flex:none;gap:2px;border-radius:7px;min-width:0}.sk-group-filter-row:has(>.sk-group-filter[aria-pressed=true]),.sk-group-filter-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sk-group-filter-row>.sk-group-filter{flex:1;min-width:0;width:auto;gap:6px;padding:8px}.sk-group-filter-row>.sk-group-filter:hover,.sk-group-filter-row>.sk-group-filter[aria-pressed=true]{background:transparent}.sk-group-filter-row[draggable=true],.sk-group-filter-row[draggable=true]>.sk-group-filter{cursor:grab}
.sk-group-order-buttons{display:flex;align-items:center;gap:2px;padding-right:4px;flex:none}.sk-groups .sk-group-order-buttons>button{display:grid;place-items:center;width:26px;min-width:26px;height:28px;min-height:28px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary)}.sk-groups .sk-group-order-buttons>button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.sk-group-order-buttons>button:disabled{opacity:.3}
.sk-group-filter-row[data-insertion]::after{content:"";position:absolute;left:4px;right:4px;height:2px;border-radius:1px;background:var(--dsw-alias-state-active-primary);pointer-events:none}.sk-group-filter-row[data-insertion=before]::after{top:-2px}.sk-group-filter-row[data-insertion=after]::after{bottom:-2px}
.sk-groups-sort-help{margin:-6px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.sk-groups-form{display:flex;flex-direction:column;gap:8px;margin-top:auto;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2)}.sk-groups-form-actions{display:flex;gap:6px}.sk-groups-form-actions>button:first-child{flex:1}
.sk-groups input,.sk-groups select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:7px;color:var(--dsw-alias-label-primary);min-height:34px;padding:7px 9px;min-width:0;max-width:100%}.sk-groups input{width:100%}.sk-groups input::placeholder{color:var(--dsw-alias-label-tertiary)}
.sk-groups :is(button,input,select):focus-visible{outline:2px solid var(--dsw-alias-state-active-primary);outline-offset:2px}
.sk-groups-main{min-width:0;display:flex;flex-direction:column}.sk-groups-heading{display:flex;align-items:center;gap:8px;min-height:30px;margin-bottom:12px}.sk-groups-heading h3{font-size:14px;font-weight:600;line-height:22px;margin:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.sk-groups-heading>.sk-group-count{flex:1}.sk-group-actions{display:flex;align-items:center;gap:4px}.sk-group-actions>button{padding:5px 7px;min-height:28px}.sk-groups .sk-group-danger{color:var(--dsw-alias-state-error-primary)}
.sk-group-projects{max-height:min(420px,calc(100dvh - 260px));overflow-y:auto;overscroll-behavior:contain;padding:2px;min-height:0}
.sk-group-project{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l2);min-width:0}.sk-group-project:first-child{padding-top:8px}.sk-group-project:last-child{border-bottom:0}.sk-group-project>svg{flex:none;color:var(--dsw-alias-label-secondary)}
.sk-group-project-copy{min-width:0;flex:1}.sk-group-project-name{display:flex;align-items:baseline;gap:8px;min-width:0}.sk-group-project-name strong{font-size:13px;font-weight:500;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.sk-group-project-name span{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px}
.sk-group-project-path{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin-top:3px;color:var(--dsw-alias-label-secondary);font:12px/18px ui-monospace,monospace}
.sk-group-project-actions{display:flex;align-items:center;gap:6px;flex:none}.sk-group-project-actions select{width:110px;font-size:12px}.sk-group-project-actions>button{padding:7px;min-height:32px}
.sk-groups-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:220px;text-align:center;color:var(--dsw-alias-label-secondary)}.sk-groups-empty p{margin:0}.sk-groups-empty strong{color:var(--dsw-alias-label-primary);font-weight:500}.sk-groups-note{font-size:12px;color:var(--dsw-alias-label-secondary);margin:16px 0 0}.sk-groups-error{color:var(--dsw-alias-state-error-primary);margin:12px 0 0}
@media(max-width:680px){.sk-groups-layout{grid-template-columns:1fr;gap:20px;min-height:0}.sk-groups-sidebar{border:0;padding:0;gap:10px}.sk-groups-nav{max-height:180px;gap:4px}.sk-group-filter{gap:12px;max-width:100%}.sk-groups .sk-group-order-buttons>button{width:36px;height:36px}.sk-groups-sort-help{margin:0}.sk-groups-form{flex-direction:row;align-items:center;margin:0;padding:0;border:0}.sk-groups-form label{flex:1;min-width:0}.sk-groups-form label>span{display:none}.sk-groups-form-actions{flex:none}.sk-groups-caption{display:none}.sk-groups-intro{margin-bottom:16px}.sk-group-projects{max-height:max(120px,calc(100dvh - 390px))}.sk-groups-heading{margin-bottom:6px}.sk-group-project{gap:8px}.sk-group-project>svg{display:none}.sk-group-project-name{display:block}.sk-group-project-name strong{display:block}.sk-group-project-name span{font-size:12px}.sk-group-project-actions select{width:96px}}
`;

export function GroupsDialog({ close, t }) {
 const { state } = useKit();
 const [name, setName] = useState(''), [editing, setEditing] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
 const [selected, setSelected] = useState(null), nameInput = useRef(null);
 const [groupInsertion, setGroupInsertion] = useState(null), pending = useRef(false), orderSnapshot = useRef(null);
 const groups = state?.groups ?? [], projects = state?.projects ?? [];
 const ordered = useMemo(() => orderedGroups(groups, state?.ungroupedIndex), [groups, state?.ungroupedIndex]);
 const groupOf = id => groups.find(group => group.workspaceIds.includes(id))?.id ?? '';
 const selectedGroup = groups.find(group => group.id === selected);
 const visible = projects.filter(project => selected === null || groupOf(project.id) === selected);
 useEffect(() => { if (selected && state && !groups.some(group => group.id === selected)) setSelected(null); }, [state, selected]);
 useEffect(() => { if (editing) { nameInput.current?.focus(); nameInput.current?.select(); } }, [editing]);
 const blocked = busy || !state || !!state.workspaceMove || !!state.journal;
 orderSnapshot.current = { groups: ordered, blocked };
 const groupDrag = useMemo(() => groupOrderDrag({ read: () => ({ ...orderSnapshot.current, blocked: orderSnapshot.current.blocked || pending.current }),
  move: async input => {
   pending.current = true; setBusy(true);
   try { await callHost(input); await loadState(); }
   finally { pending.current = false; setBusy(false); }
  }, preview: setGroupInsertion, report: setError }), []);
 const run = async input => {
  if (blocked || pending.current) return;
  pending.current = true; setBusy(true); setError('');
  try { await callHost(input); await loadState(); if (['group.rename', 'group.create'].includes(input.type) || input.type === 'group.delete' && input.groupId === editing) { setName(''); setEditing(''); } }
  catch (reason) { setError(reason.message); }
  finally { pending.current = false; setBusy(false); }
 };
 const filters = [{ id: null, title: text(t, 'groups.all'), count: projects.length }, ...ordered.map(group => { const id = group.id === UNGROUPED ? '' : group.id; return { ...group, id, title: group.id === UNGROUPED ? text(t, 'groups.none') : group.title, count: projects.filter(project => groupOf(project.id) === id).length }; })];
 return <Modal open className="sk-groups-dialog" title={text(t, 'groups.manage')} closeLabel={text(t, 'common.close')} onClose={() => { if (!busy) close(); }}>
  <div className="sk-groups" data-toolbox-groups><style>{groupsStyle}</style>
   <p className="sk-groups-intro">{text(t, 'groups.intro')}</p>
   <div className="sk-groups-layout">
    <aside className="sk-groups-sidebar">
     <h3 className="sk-groups-caption">{text(t, 'groups.list')}</h3>
     <nav className="sk-groups-nav" aria-label={text(t, 'groups.title')} aria-describedby="sk-groups-sort-help"
      onDragStartCapture={groupDrag.start} onDragOverCapture={groupDrag.over} onDragLeaveCapture={groupDrag.leave} onDropCapture={event => void groupDrag.drop(event)} onDragEndCapture={groupDrag.end}>
      {filters.map((group, index) => <div className="sk-group-filter-row" key={group.id ?? 'all'} data-toolbox-group={group.id === null ? undefined : group.id || 'ungrouped'}
       draggable={group.id !== null && !blocked} data-insertion={group.id !== null && groupInsertion?.groupId === (group.id || 'ungrouped') ? groupInsertion.edge : undefined}>
       <button type="button" className="sk-group-filter" title={group.title} aria-pressed={selected === group.id} aria-keyshortcuts={group.id !== null ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        onKeyDown={event => { if (group.id !== null && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); void groupDrag.step(group.id || UNGROUPED, event.key === 'ArrowUp' ? -1 : 1); } }}
        onClick={() => setSelected(group.id)}><span>{group.title}</span><span className="sk-group-count">{group.count}</span></button>
       {group.id !== null && <div className="sk-group-order-buttons">
        <Button type="button" variant="ghost" title={text(t, 'groups.up')} aria-label={`${group.title} — ${text(t, 'groups.up')}`} disabled={blocked || index === 1} onClick={() => void groupDrag.step(group.id || UNGROUPED, -1)}><GroupOrderIcon /></Button>
        <Button type="button" variant="ghost" title={text(t, 'groups.down')} aria-label={`${group.title} — ${text(t, 'groups.down')}`} disabled={blocked || index === ordered.length} onClick={() => void groupDrag.step(group.id || UNGROUPED, 1)}><GroupOrderIcon down /></Button>
       </div>}
      </div>)}
     </nav>
     <p className="sk-groups-sort-help" id="sk-groups-sort-help">{text(t, 'groups.sortHelp')}</p>
     <form className="sk-groups-form" onSubmit={event => { event.preventDefault(); void run({ type: editing ? 'group.rename' : 'group.create', groupId: editing, title: name }); }}>
      <label><span className="sk-groups-caption">{text(t, editing ? 'groups.rename' : 'groups.create')}</span><input ref={nameInput} aria-label={text(t, 'groups.name')} placeholder={text(t, 'groups.name')} maxLength={80} value={name} disabled={blocked} onChange={event => setName(event.target.value)} /></label>
      <div className="sk-groups-form-actions"><Button type="submit" variant={editing ? 'primary' : 'outline'} disabled={blocked || !name.trim()}>{text(t, editing ? 'common.save' : 'groups.create')}</Button>{editing && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setEditing(''); setName(''); }}>{text(t, 'common.cancel')}</Button>}</div>
     </form>
    </aside>
    <section className="sk-groups-main" aria-label={text(t, 'groups.projects')}>
     <div className="sk-groups-heading"><h3>{selected === null ? text(t, 'groups.all') : selectedGroup?.title ?? text(t, 'groups.none')}</h3><span className="sk-group-count">{visible.length}</span>
      {selectedGroup && <div className="sk-group-actions"><Button variant="ghost" disabled={blocked} title={text(t, 'groups.rename')} aria-label={text(t, 'groups.rename')} onClick={() => { setEditing(selectedGroup.id); setName(selectedGroup.title); }}><EditIcon /></Button><Button className="sk-group-danger" variant="ghost" disabled={blocked} title={text(t, 'groups.delete') + ' · ' + text(t, 'groups.help')} aria-label={text(t, 'groups.delete')} onClick={() => void run({ type: 'group.delete', groupId: selectedGroup.id })}><DeleteIcon /></Button></div>}
     </div>
     <div className="sk-group-projects">
      {!state ? <p role="status">{text(t, 'common.loading')}</p> : visible.map(project => <div className="sk-group-project" data-toolbox-group-project key={project.id}>
       <IconFolderOpenOutlineRegular size={18} aria-hidden="true" />
       <div className="sk-group-project-copy"><div className="sk-group-project-name"><strong title={project.title}>{project.title}</strong><span>{project.sessions} {text(t, 'groups.sessions')}</span></div><span className="sk-group-project-path" title={project.path}>{project.path}</span></div>
       <div className="sk-group-project-actions"><select aria-label={`${project.title} — ${text(t, 'groups.title')}`} disabled={blocked} value={groupOf(project.id)} onChange={event => void run({ type: 'group.assign', workspaceId: project.id, groupId: event.target.value })}><option value="">{text(t, 'groups.none')}</option>{groups.map(group => <option key={group.id} value={group.id}>{group.title}</option>)}</select><Button variant="ghost" title={text(t, 'project.edit')} aria-label={`${project.title} — ${text(t, 'project.edit')}`} disabled={blocked} onClick={() => showOverlay({ kind: 'workspace', workspaceId: project.id })}><EditIcon /></Button></div>
      </div>)}
      {state && !visible.length && <div className="sk-groups-empty"><IconFolderOpenOutlineRegular size={28} aria-hidden="true" /><strong>{text(t, 'groups.empty')}</strong><p>{text(t, 'groups.emptyHelp')}</p></div>}
     </div>
     <p className="sk-groups-note">{text(t, 'groups.saved')}</p>
    </section>
   </div>
   {state?.workspaceMove && <div className="sk stack"><style>{styles}</style><WorkspaceSection state={state} t={t} /></div>}
   {error && <p role="alert" className="sk-groups-error">{error}</p>}
  </div>
 </Modal>;
}

export function MoveGroupDialog({ workspaceId, close, t }) {
 const { state } = useKit();
 const [busy, setBusy] = useState(false), [error, setError] = useState('');
 const assign = async groupId => {
  if (busy) return;
  setBusy(true); setError('');
  try { await callHost({ type: 'group.assign', workspaceId, groupId }); await loadState(); close(); }
  catch (reason) { setError(reason.message); setBusy(false); }
 };
 const selected = state?.groups?.find(group => group.workspaceIds.includes(workspaceId))?.id ?? '';
 return <Modal open title={text(t, 'groups.move')} onClose={() => { if (!busy) close(); }} closeLabel={text(t, 'common.close')}>
  <div className="sk stack"><style>{styles}</style><strong>{state?.projects?.find(project => project.id === workspaceId)?.title}</strong>
   {[...(state?.groups ?? []), { id: '', title: text(t, 'groups.none') }].map(group => <Button key={group.id} variant="outline" disabled={busy || !state || !!state.workspaceMove} aria-pressed={selected === group.id} onClick={() => void assign(group.id)}>{selected === group.id ? '✓ ' : ''}{group.title}</Button>)}
   <Button variant="ghost" disabled={busy} onClick={() => showOverlay({ kind: 'groups' })}>{text(t, 'groups.create')}</Button>
   {error && <p role="alert" className="error">{error}</p>}
  </div>
 </Modal>;
}

export function WorkspaceDialog({ workspaceId, close, t }) {
 const { state } = useKit();
 const project = state?.projects?.find(row => row.id === workspaceId);
 const [title, setTitle] = useState(project?.title ?? ''), [path, setPath] = useState(project?.path ?? '');
 const [busy, setBusy] = useState(false), [error, setError] = useState('');
 const initializedProject = useRef(project?.id);
 useEffect(() => { if (project && initializedProject.current !== project.id) { initializedProject.current = project.id; setTitle(project.title); setPath(project.path); } }, [project]);
 const submit = async () => {
  setBusy(true); setError('');
  try { await callHost({ type: 'workspace.edit', workspaceId, title, path }); await loadState(); close(); }
  catch (reason) { setError(reason.message); await loadState(); setBusy(false); }
 };
 const browse = async () => {
  try { const picked = await directoryPicker?.pick?.(); if (picked?.ok && typeof picked.value === 'string') setPath(picked.value); }
  catch (reason) { setError(reason.message); }
 };
 return <Modal open title={text(t, 'project.edit')} closeLabel={text(t, 'common.close')} onClose={() => { if (!busy) close(); }} footer={<><Button variant="outline" disabled={busy} onClick={close}>{text(t, 'common.cancel')}</Button><Button variant="primary" disabled={busy || !project || !title.trim() || !path.trim()} onClick={() => void submit()}>{text(t, busy ? 'common.busy' : 'common.save')}</Button></>}>
  <div className="sk stack"><style>{styles}</style>
   <label className="stack">{text(t, 'groups.title')}<select aria-label={text(t, 'groups.title')} disabled={busy || !!state?.workspaceMove} value={state?.groups?.find(group => group.workspaceIds.includes(workspaceId))?.id ?? ''} onChange={async event => { setBusy(true); setError(''); try { await callHost({ type: 'group.assign', workspaceId, groupId: event.target.value }); await loadState(); } catch (reason) { setError(reason.message); } finally { setBusy(false); } }}><option value="">{text(t, 'groups.none')}</option>{state?.groups?.map(group => <option key={group.id} value={group.id}>{group.title}</option>)}</select></label>
   <p className="muted">{text(t, 'project.groupHelp')}</p>
   <Button variant="ghost" disabled={busy} onClick={() => showOverlay({ kind: 'groups' })}>{text(t, 'groups.manage')}</Button>
   <label className="stack">{text(t, 'project.title')}<input value={title} maxLength={80} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
   <label className="stack">{text(t, 'project.path')}<input className="mono" value={path} disabled={busy} onChange={event => setPath(event.target.value)} /></label>
   {directoryPicker?.pick && <Button variant="outline" disabled={busy} onClick={() => void browse()}>{text(t, 'project.browse')}</Button>}
   <p className="muted">{text(t, 'project.help')}</p>
   {error && <p className="error" role="alert">{error}</p>}
   {state?.workspaceMove && <WorkspaceSection state={state} t={t} />}
  </div>
 </Modal>;
}
