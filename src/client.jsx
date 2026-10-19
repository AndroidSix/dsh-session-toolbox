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
import { MenuItemButton, Modal, Button, Tooltip, IconFolderOpenOutlineRegular, IconArchiveOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { REPLY_SOURCE, readReply, withReply, withoutReply, messageReply, replySource, installReplyNodes } from './reply.mjs';
import { createVault } from './draft-vault.js';
import { filterSidebar, installSidebar, mirroredSlot, sidebarLayout, installQueueSteering, protectProjectMenu, sessionProjectDrag } from './sidebar.mjs';

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
		if (request !== stateRequest) return store.state;
		store.state = next; store.error = ''; sessionKey = next.key ?? sessionKey;
		vault?.setLimits(next.settings?.draftVault ?? {});
	} catch (error) { if (request !== stateRequest) return store.state; store.error = error.message; }
	for (const listener of store.listeners) listener();
	return store.state;
}
export async function callHost(input) {
	if (input.type === 'vault.sweep') {
		if (!vault) throw new Error('草稿保险箱尚未就绪');
		const report = await vault.sweep();
		await vault.syncHost();
		return report;
	}
	if (!sessionKey) await loadState();
	const post = () => fetch(ENDPOINT, {
		method: 'POST', cache: 'no-store',
		headers: { 'content-type': 'application/json', 'x-session-toolbox-key': sessionKey },
		body: JSON.stringify(input),
	});
	let response = await post();
	if (response.status === 401) { await loadState(); response = await post(); }
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
 installReplyNodes(ctx, (native, mirrors) => props => <ReplyMessage {...props} Native={native.component} mirrors={mirrors} toolboxT={ctx.locale.bind?.(NS)} />);
 ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'session-toolbox-reply', order: 1, locale: NS }, ReplyPreview));

	installSidebar(ctx, native => props => <GroupedSidebar {...props} toolboxT={ctx.locale.bind?.(NS)} Native={native.component} />);
	installQueueSteering(ctx, native => props => <NativeSteerQueue {...props} Native={native.component} toolboxT={ctx.locale.bind?.(NS)} />);
	ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
		name: 'conversation.input.dock', id: 'session-toolbox-steer', order: 15, locale: NS,
		inject: sessionId => {
			const scope = ctx.sessions?.scope?.(sessionId);
			const conversation = scope?.get('conversation');
			return { updateQueue: typeof conversation?.updateQueue === 'function' ? (id, action) => conversation.updateQueue(id, action) : undefined };
		},
	}, SteerQueueButton));

	// Keyed slot (one occupant = package name): the plugin settings page.
	ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: NS, locale: NS }, KitPage));
	// Session context menu: move + trash entries beside the official four.
	ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'session-toolbox-move', order: 500, locale: NS }, MoveSessionMenuItem));
	ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'session-toolbox-trash', order: 600, locale: NS }, TrashSessionMenuItem));
	// Input dock badge (§4 FR5): how many image drafts are backed up here.
	ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'session-toolbox-dialog', order: 500, locale: NS }, ToolboxOverlay));
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
 'reply.action': '引用回复', 'reply.cancel': '取消引用', 'reply.user': '用户', 'reply.assistant': '助手', 'reply.unavailable': '当前输入框暂不支持引用回复',
 'community.join': '加入 QQ 交流群 ↗', 'community.name': 'AndroidSix 的开源项目交流群', 'community.number': '群号',
 'groups.title': '项目分组', 'groups.all': '全部项目', 'groups.none': '未分组', 'groups.manage': '管理项目与分组',
 'groups.move': '移入分组…', 'groups.drop': '可将项目拖到分组标题，或从项目菜单选择“移入分组”。', 'groups.name': '分组名称', 'groups.create': '新建分组', 'groups.rename': '重命名', 'groups.delete': '删除分组',
 'groups.help': '每个项目可归入一个分组；删除分组会将其中项目恢复为未分组。侧栏按“分组 → 项目 → 会话”展开，原生搜索仍搜索全部会话。',
 'project.groupHelp': '分组选择后立即保存；名称和路径点击“保存”后生效。', 'project.editGroup': '编辑项目', 'queue.rowSteer': '引导', 'project.edit': '编辑项目', 'project.title': '项目名称', 'project.path': '项目目录', 'project.browse': '浏览…',
 'project.help': '选择已有代码目录。保存后，将该项目的全部已有会话一起迁入新路径，保留顺序、归档及置顶状态；代码文件不会搬动，历史消息中的路径保持原样。会话必须空闲且没有排队消息。',
 'project.resume': '继续迁移', 'project.pending': '项目迁移尚未完成，请继续迁移。',
 'common.save': '保存', 'common.cancel': '取消', 'common.close': '关闭', 'common.busy': '处理中…', 'common.loading': '正在加载项目…',
 'queue.steer': '引导下一条', 'queue.help': '将队列第一条交给当前运行轮次，在下一可用步骤接收，当前工具继续执行。也可在原生队列每条消息旁点击“引导”。',
};
const workspaceEnglish = {
 'reply.action': 'Quote reply', 'reply.cancel': 'Cancel quote', 'reply.user': 'User', 'reply.assistant': 'Assistant', 'reply.unavailable': 'Quote reply is unavailable for this composer',
 'community.join': 'Join the QQ community ↗', 'community.name': 'AndroidSix open-source projects', 'community.number': 'Group',
 'groups.title': 'Project groups', 'groups.all': 'All projects', 'groups.none': 'Ungrouped', 'groups.manage': 'Manage projects and groups',
 'groups.move': 'Move to group…', 'groups.drop': 'Drag a project onto a group heading, or choose Move to group from its menu.', 'groups.name': 'Group name', 'groups.create': 'New group', 'groups.rename': 'Rename', 'groups.delete': 'Delete group',
 'groups.help': 'Each project belongs to one group. Deleting a group leaves its projects ungrouped. The sidebar nests projects under collapsible groups; native search still searches all chats.',
 'project.groupHelp': 'Group changes save immediately. Name and directory changes apply when you click Save.', 'project.editGroup': 'Edit project', 'queue.rowSteer': 'Steer', 'project.edit': 'Edit project', 'project.title': 'Project name', 'project.path': 'Project directory', 'project.browse': 'Browse…',
 'project.help': 'Choose an existing code directory. Saving moves all existing chats to the new path and keeps their order, archive and pin state. Code files and paths in past messages stay as they are. Chats must be idle with no queued messages; the host releases their writer before migration.',
 'project.resume': 'Resume migration', 'project.pending': 'Project migration is incomplete. Resume it to continue.',
 'common.save': 'Save', 'common.cancel': 'Cancel', 'common.close': 'Close', 'common.busy': 'Working…', 'common.loading': 'Loading projects…',
 'queue.steer': 'Steer next message', 'queue.help': 'Send the first queued message into the running turn at its next available step. Current tools keep running. Use the native queue to steer another message.',
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
 const movingGroup = useRef(false);
 const groups = state?.groups ?? [];
 const workspaces = props.useWorkspaces(value => value);
 const sessions = props.useSessions(value => value);
 const dragSnapshot = useRef(null);
 dragSnapshot.current = { workspaces: workspaces.items, projects: state?.projects ?? [], sessions,
  archived: workspaces.archivedSessionIds, blocked: !!state?.journal || !!state?.workspaceMove || state?.settings?.move?.enabled === false || typeof props.actions?.setSessionOrder !== 'function' };
 const sessionDrag = useMemo(() => sessionProjectDrag({ read: () => dragSnapshot.current, move: callHost, report: setSessionFeedback }), []);
 useEffect(() => () => sessionDrag.dispose(), [sessionDrag]);
 const view = props.useStore(value => value.groupBy);
 const grouped = props.wide && view !== 'flat' && groups.length > 0;
 const layout = useMemo(() => sidebarLayout(workspaces.items, groups), [workspaces, groups]);
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
 const headings = [...groups, { id: 'ungrouped', title: text(props.toolboxT, 'groups.none') }];
 const rules = grouped && list ? layout.map(({ workspace, group }) => {
  const selector = `.sk-sidebar [role="tree"]>div:has([data-row-key=${JSON.stringify('workspace:' + workspace.workspaceId)}])`;
  return `${selector}{order:${group * 2 + 1};padding-left:12px;${collapsed[headings[group].id] ? 'display:none!important;' : ''}}`;
 }).join('') : '';
 return <div className="sk-sidebar" ref={root} onClickCapture={capture} onDragStartCapture={event => {
   sessionDrag.start(event);
   if (event.target.closest?.('[data-row-key^="session:"]')) return;
   const row = event.target.closest?.('[data-row-key^="workspace:"]');
   const id = row?.getAttribute('data-row-key').slice('workspace:'.length);
   if (workspaces.items.some(item => item.workspaceId === id)) event.dataTransfer.setData('application/x-dsh-toolbox-workspace', id);
  }} onDragOverCapture={sessionDrag.over} onDragLeaveCapture={sessionDrag.leave} onDropCapture={sessionDrag.drop}
   onDragEndCapture={() => { sessionDrag.end(); setDropGroup(null); }}>
  <style>{`.sk-sidebar [data-toolbox-session-drop]{background:var(--dsw-alias-interactive-bg-hover);outline:1px solid var(--dsw-alias-state-active-primary);outline-offset:-1px;border-radius:6px}`}</style>
  <style>{`.sk-sidebar{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}.sk-groupbar{display:flex;gap:4px;padding:4px 12px;align-items:center;color:var(--dsw-alias-label-secondary);font-size:12px}.sk-groupbar span{flex:1}.sk-group-heading{display:flex;align-items:center;gap:6px;min-height:32px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:0 8px}[data-toolbox-project-menu]{min-width:172px!important}[data-toolbox-project-menu] [role="menuitem"]>span:last-child{white-space:nowrap;overflow:visible}.sk-group-heading[data-drop="true"]{background:var(--dsw-alias-interactive-bg-hover);outline:1px solid var(--dsw-alias-state-active-primary);border-radius:6px}.sk-group-heading>button:first-child{flex:1;text-align:left}.sk-group-heading button{background:transparent;color:inherit;border:0;border-radius:6px;cursor:pointer;padding:5px}.sk-group-heading button:hover{background:var(--dsw-alias-interactive-bg-hover)}${rules}`}</style>
  <div className="sk-groupbar"><span>{text(props.toolboxT, 'groups.title')}</span><Button variant="ghost" title={text(props.toolboxT, 'groups.manage')} aria-label={text(props.toolboxT, 'groups.manage')} onClick={() => showOverlay({ kind: 'groups' })}>…</Button></div>
  {groupError && <p role="alert">{groupError}</p>}
  {sessionFeedback && <p role={sessionFeedback.error ? 'alert' : 'status'} style={{ padding: '0 12px', fontSize: 12 }}>{sessionFeedback.busy ? '正在切换项目…' : sessionFeedback.message}</p>}
  <Native {...nativeProps} />
  {grouped && list && createPortal(<>
   <style>{`.sk-sidebar div:has(>.sk-group-heading){display:flex;flex-direction:column}.sk-sidebar [role="tree"]>div:has([data-row-key="workspace:"]){order:${groups.length * 2 + 1};${collapsed.ungrouped ? 'display:none!important;' : ''}}`}</style>
   {headings.map((group, index) => <div className="sk-group-heading" key={group.id} style={{ order: index * 2 }} data-toolbox-group={group.id} data-drop={dropGroup === group.id} title={text(props.toolboxT, 'groups.drop')}
    onDragOver={event => { if (!state?.workspaceMove && event.dataTransfer.types.includes('application/x-dsh-toolbox-workspace')) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropGroup(group.id); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDropGroup(null); }}
    onDrop={event => { const id = event.dataTransfer.getData('application/x-dsh-toolbox-workspace'); if (!id) return; event.preventDefault(); event.stopPropagation(); void moveGroup(id, group.id); }}>
    <button aria-expanded={!collapsed[group.id]} onClick={() => setCollapsed(value => ({ ...value, [group.id]: !value[group.id] }))}>{collapsed[group.id] ? '▸' : '▾'} {group.title} <span>({layout.filter(row => row.group === index).length})</span></button>
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
function useReplyInput(sessionId, phaseOnly = false) {
 const input = replyInput(sessionId);
 const read = () => { const value = input?.state?.getSnapshot?.(); return phaseOnly ? value?.phase : value; };
 const [snapshot, setSnapshot] = useState(read);
 useEffect(() => {
  const sync = () => setSnapshot(read()); sync();
  return input?.state?.subscribe?.(sync);
 }, [input, phaseOnly]);
 return [input, snapshot];
}
const replyStyle = `.sk-reply-button{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:5px;background:transparent;border:0;border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-tertiary);cursor:pointer}.sk-reply-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.sk-reply-button:disabled{opacity:.4;cursor:default}.sk-reply-preview{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;background:var(--dsw-alias-bg-module-platform)}.sk-reply-preview>div{min-width:0;flex:1;border-left:2px solid var(--dsw-alias-label-tertiary);padding-left:10px}.sk-reply-preview p{margin:4px 0 0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:pre-wrap;overflow-wrap:anywhere}.sk-reply-preview strong{font-size:12px;font-weight:500}`;
export function ReplyMessage({ Native, mirrors, toolboxT, ...props }) {
 const root = useRef(null), [target, setTarget] = useState(null), [error, setError] = useState('');
 const [input, phase] = useReplyInput(props.sessionId, true);
 const quote = messageReply(props.node);
 const canWrite = props.useSession ? props.useSession(value => !value.removed && (value.subagent === null || value.subagent?.address?.mode === 'continuable')) : false;
 useEffect(() => {
  const discover = () => setTarget(root.current?.querySelector('[data-clock]') ?? null);
  const observer = new MutationObserver(discover); if (root.current) observer.observe(root.current, { childList: true, subtree: true }); discover();
  return () => observer.disconnect();
 }, []);
 const label = text(toolboxT, 'reply.action');
 const reply = () => {
  try {
   if (!replyAvailable || !input || !canWrite) throw new Error(text(toolboxT, 'reply.unavailable'));
   input.setDraft(withReply(input.state.getSnapshot(), quote, `${label} · ${text(toolboxT, quote.role === 'user' ? 'reply.user' : 'reply.assistant')}`));
   input.persistCurrentDraft?.(); setError('');
   // Focus the same session's public contenteditable, without changing selection in another chat.
   const surface = root.current?.closest('[data-conversation-session]');
   surface?.querySelector('[data-composer-card] [contenteditable="true"]')?.focus();
  } catch (reason) { setError(reason.message); }
 };
 const nativeProps = { ...props, renderSlot: (name, ...args) => props.renderSlot(mirrors.get(name) ?? name, ...args) };
 return <div ref={root} style={{ display: 'contents' }}><Native {...nativeProps} /><style>{replyStyle}</style>
  {quote && target && createPortal(<Tooltip label={label} side="bottom"><button type="button" className="sk-reply-button" aria-label={label} disabled={!replyAvailable || !input || !canWrite || phase !== 'plain'} onClick={reply}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="M6 3 2 6.5 6 10M2.5 6.5H10a4 4 0 0 1 0 8H8" /></svg></button></Tooltip>, target)}
  {error && <span role="alert">{error}</span>}
 </div>;
}
export function ReplyPreview({ sessionId, t }) {
 const [input, snapshot] = useReplyInput(sessionId);
 const [error, setError] = useState('');
 const occurrence = snapshot?.occurrences?.find(row => row.source === REPLY_SOURCE);
 let quote; try { if (occurrence) quote = readReply(occurrence.ref); } catch { /* host marks invalid chips; do not take down the composer */ }
 if (!quote) return null;
 const cancel = () => { try { input.setDraft(withoutReply(input.state.getSnapshot())); input.persistCurrentDraft?.(); setError(''); } catch (reason) { setError(reason.message); } };
 return <div><style>{replyStyle}</style><div className="sk-reply-preview" data-toolbox-reply role="region" aria-label={text(t, 'reply.action')}>
  <div><strong>{text(t, 'reply.action')} · {text(t, quote.role === 'user' ? 'reply.user' : 'reply.assistant')}</strong><p>{quote.text}</p></div>
  <button type="button" className="sk-reply-button" aria-label={text(t, 'reply.cancel')} disabled={snapshot.phase !== 'plain'} onClick={cancel}>×</button>
 </div>{error && <p role="alert">{error}</p>}</div>;
}

export function NativeSteerQueue({ Native, toolboxT, ...props }) {
 const label = text(toolboxT, 'queue.rowSteer');
 return <><style>{`[data-queue-dock] button[aria-label="引导"],[data-queue-dock] button[aria-label="Steer"]{display:inline-flex;align-items:center;justify-content:center;width:auto;min-width:56px;gap:4px;padding:0 8px;font:inherit;font-size:12px}[data-queue-dock] button[aria-label="引导"]::after,[data-queue-dock] button[aria-label="Steer"]::after{content:attr(aria-label)}`}</style><Native {...props} t={(key, ...args) => key === 'queue.steer' ? label : props.t(key, ...args)} /></>;
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
  <p className="muted">{state?.groups?.length ?? 0} 个分组 · {state?.projects?.length ?? 0} 个项目。侧栏按分组展开项目，项目菜单可编辑名称、路径和分组。</p>
  <div><Button variant="outline" onClick={() => showOverlay({ kind: 'groups' })}>{text(t, 'groups.manage')}</Button></div>
  {state?.workspaceMove && <p role="status">{text(t, 'project.pending')}<br /><span className="mono">{state.workspaceMove.fromCwd} → {state.workspaceMove.toCwd}</span><br />{state.workspaceMove.moved.length} / {state.workspaceMove.sessionIds.length} <Button variant="outline" disabled={busy} onClick={() => void resume()}>{text(t, busy ? 'common.busy' : 'project.resume')}</Button></p>}
  {error && <p className="error" role="alert">{error}</p>}
 </section>;
}

export function GroupsDialog({ close, t }) {
 const { state } = useKit();
 const [name, setName] = useState(''), [editing, setEditing] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
 const groups = state?.groups ?? [];
 const run = async input => {
  if (busy) return;
  setBusy(true); setError('');
  try { await callHost(input); await loadState(); setName(''); setEditing(''); }
  catch (reason) { setError(reason.message); }
  finally { setBusy(false); }
 };
 return <Modal open title={text(t, 'groups.manage')} closeLabel={text(t, 'common.close')} onClose={() => { if (!busy) close(); }}>
  <div className="sk stack sk-dialog-body"><style>{styles}</style><p className="muted">{text(t, 'groups.help')}</p>
   <form className="row" onSubmit={event => { event.preventDefault(); void run({ type: editing ? 'group.rename' : 'group.create', groupId: editing, title: name }); }}>
    <input className="grow" aria-label={text(t, 'groups.name')} placeholder={text(t, 'groups.name')} maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)} />
    <Button type="submit" variant="outline" disabled={busy || !name.trim()}>{text(t, editing ? 'common.save' : 'groups.create')}</Button>
    {editing && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setEditing(''); setName(''); }}>{text(t, 'common.cancel')}</Button>}
   </form>
   {groups.map(group => <div className="row" key={group.id}><strong style={{ flex: 1 }}>{group.title}</strong>
    <Button variant="ghost" disabled={busy || !!state.workspaceMove} onClick={() => { setEditing(group.id); setName(group.title); }}>{text(t, 'groups.rename')}</Button>
    <Button variant="ghost" disabled={busy || !!state.workspaceMove} onClick={() => void run({ type: 'group.delete', groupId: group.id })}>{text(t, 'groups.delete')}</Button>
   </div>)}
   {!state ? <p role="status">{text(t, 'common.loading')}</p> : state.projects.map(project => <div className="box" key={project.id}>
    <div><strong>{project.title}</strong> · {project.sessions}<p className="muted mono">{project.path}</p></div>
    <div className="row"><select aria-label={`${project.title} — ${text(t, 'groups.title')}`} disabled={busy || !!state.workspaceMove} value={groups.find(group => group.workspaceIds.includes(project.id))?.id ?? ''} onChange={event => void run({ type: 'group.assign', workspaceId: project.id, groupId: event.target.value })}>
     <option value="">{text(t, 'groups.none')}</option>{groups.map(group => <option key={group.id} value={group.id}>{group.title}</option>)}
    </select><Button variant="outline" disabled={busy || !!state.workspaceMove} onClick={() => showOverlay({ kind: 'workspace', workspaceId: project.id })}>{text(t, 'project.edit')}</Button></div>
   </div>)}
   {state?.workspaceMove && <WorkspaceSection state={state} t={t} />}
   {error && <p role="alert" className="error">{error}</p>}
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

/** Native steer moves the same inbox row to next-step; it never cancels the running tools. */
export function SteerQueueButton({ useSession, useProjection, updateQueue, phase, readOnly, t }) {
 const inbox = useProjection('inbox');
 const running = useSession(state => state.running);
 const mutable = useSession(state => state.subagent === null || state.subagent?.address?.mode === 'continuable');
 const submissions = useSession(state => state.pendingSubmissions ?? []);
 const inChat = new Set(submissions.filter(row => row.placement === 'transcript').map(row => row.requestId));
 const queue = (inbox?.['next-turn'] ?? []).filter(row => row.source?.kind !== 'user' || !inChat.has(row.source.rpcId));
 const [busy, setBusy] = useState(false), [error, setError] = useState('');
 const sending = useRef(false);
 if (!queue.length) return null;
 const disabled = busy || !running || !mutable || readOnly === true || phase !== undefined && phase !== 'ready' || typeof updateQueue !== 'function';
 const steer = async () => {
  if (disabled || sending.current) return;
  sending.current = true; setBusy(true); setError('');
  try { await updateQueue(queue[0].id, { kind: 'steer' }); }
  catch (reason) { setError(reason.message); }
  finally { sending.current = false; setBusy(false); }
 };
 return <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
  <Button variant="outline" disabled={disabled} title={text(t, 'queue.help')} onClick={steer}>{text(t, busy ? 'common.busy' : 'queue.steer')} ({queue.length})</Button>
  {error && <span role="alert">{error}</span>}
 </div>;
}
