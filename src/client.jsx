/**
 * dsh-session-toolbox browser plugin: management page (§4 FR5/FR6, §10 MR6, §11
 * TB2), session context-menu entries, the input-dock vault badge, and the
 * draft vault itself (capture + IndexedDB + synthetic-paste restore; route A).
 * Every official surface is probed (`ctx.get?.`, guarded registrations); no
 * path here may take the native composer down with it (NFR3).
 */
import { useEffect, useRef, useState } from 'react';
import pkg from '../package.json' with { type: 'json' };
const pluginVersion = pkg.version;
import { createVault } from './draft-vault.js';

export const name = 'dsh-session-toolbox-client';
export const inject = ['slots'];
export const NS = 'dsh-session-toolbox';
const ENDPOINT = `/.well-known/${NS}`;

let vault; // browser-side singleton (IndexedDB + host manifest)
let directoryPicker; // ctx.get('directoryPicker') probed at apply time
const store = { state: null, error: '', listeners: new Set() };

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
export async function loadState() {
	try {
		const next = await readResponse(await fetch(ENDPOINT, { cache: 'no-store' }));
		store.state = next; store.error = ''; sessionKey = next.key ?? sessionKey;
	} catch (error) { store.error = error.message; }
	for (const listener of store.listeners) listener();
	return store.state;
}
export async function callHost(input) {
	if (!sessionKey) await loadState();
	const res = await readResponse(await fetch(ENDPOINT, {
		method: 'POST', cache: 'no-store',
		headers: { 'content-type': 'application/json', 'x-session-toolbox-key': sessionKey },
		body: JSON.stringify(input),
	}));
	sessionKey = res.key ?? sessionKey;
	for (const listener of store.listeners) listener();
	return res;
}

export function apply(ctx) {
	directoryPicker = ctx.get?.('directoryPicker');
	const vaultInstance = vault ??= createVault({
		endpoint: ENDPOINT,
		log: (level, message) => { try { (level === 'error' ? console.warn : console.log)(`[${NS}]`, message); } catch {} },
	});
	void loadState();
	const timer = setInterval(() => void loadState(), 30000);
	ctx.effect?.(() => () => clearInterval(timer));
	vaultInstance.on('change', () => void loadState());
	void vaultInstance.start();
	ctx.locale?.register?.(NS, {
		zh: { 'menu.move': '切换到其它项目…', 'menu.trash': '移入回收站' },
		en: { 'menu.move': 'Move to another project…', 'menu.trash': 'Move to trash' },
	});

	// Keyed slot (one occupant = package name): the plugin settings page.
	ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: NS }, KitPage));
	// Session context menu: move + trash entries beside the official four.
	ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'session-toolbox-move', order: 500, locale: NS }, MoveSessionMenuItem));
	ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'session-toolbox-trash', order: 600, locale: NS }, TrashSessionMenuItem));
	// Input dock badge (§4 FR5): how many image drafts are backed up here.
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
.sk .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.sk .stack{display:flex;flex-direction:column;gap:16px}
.sk button,.sk input,.sk select{font:inherit;color:inherit;border:1px solid var(--sk-border);border-radius:8px;background:var(--sk-bg);min-height:36px;padding:7px 12px}
.sk button{cursor:pointer}.sk button:hover{background:var(--sk-card)}.sk button:disabled{opacity:.45;cursor:default}
.sk button.primary{background:var(--sk-accent);color:#fff;border-color:transparent}
.sk table{width:100%;border-collapse:collapse;font-size:13px}.sk th,.sk td{border-bottom:1px solid var(--sk-border);padding:8px;text-align:left}.sk th{color:var(--sk-muted);font-weight:500}
.sk .error{color:var(--dsw-alias-state-error-primary,#ef9393)}.sk .good{color:var(--dsw-alias-state-success-primary,#77ca9d)}
.sk .pill{border:1px solid var(--sk-border);border-radius:100px;padding:2px 10px;font-size:12px;background:var(--sk-bg);display:inline-block}
.sk .mono{font:12px ui-monospace,monospace;overflow-wrap:anywhere}
.sk dialog{color:var(--sk-text);background:var(--sk-bg);border:1px solid var(--sk-border);border-radius:14px;width:min(560px,calc(100vw - 32px));padding:0}
.sk dialog::backdrop{background:#0007}.sk .modal-head{padding:16px 20px;border-bottom:1px solid var(--sk-border);display:flex;justify-content:space-between;align-items:center}
.sk .modal-body{padding:20px;display:flex;flex-direction:column;gap:14px}
.sk input.grow{flex:1;min-width:0}
`;

export function KitPage() {
	const { state, error } = useKit();
	const [busy, setBusy] = useState(false);
	const [feedback, setFeedback] = useState('');
	const say = message => { setFeedback(message); setTimeout(() => setFeedback(''), 8000); };
	const act = async (input, ok) => {
		setBusy(true);
		try { const result = await callHost(input); if (ok) say(ok); await loadState(); setBusy(false); return result; }
		catch (err) { say(`失败：${err.message}`); setBusy(false); throw err; }
	};
	const settings = state?.settings;
	return (
		<div className="sk">
			<style>{styles}</style>
			<h2>会话工具箱</h2>
			<p className="muted">草稿保险箱 · 会话切换项目 · 回收站 — v{pluginVersion}。数据仅存本机（浏览器 IndexedDB + ~/.dsh/session-toolbox/）。</p>
			{error ? <p className="error">后台连接失败：{error}</p> : null}
			{feedback ? <p className="good">{feedback}</p> : null}
			<section className="box">
				<h3>草稿保险箱（图片草稿持久化）</h3>
				{settings ? (
					<>
						<div className="row">
							<label className="row"><input type="checkbox" checked={settings.draftVault?.enabled !== false} disabled={busy}
								onChange={e => void act({ type: 'settings.update', patch: { draftVault: { ...settings.draftVault, enabled: e.target.checked } } }, e.target.checked ? '已启用草稿保险箱' : '已停用草稿保险箱（浏览器侧即时生效）').catch(() => {})} /> 启用</label>
							<span className="pill">容量 {Math.round((settings.draftVault?.maxSizeBytes ?? 0) / 1048576)} MB</span>
							<span className="pill">保留 {settings.draftVault?.ttlDays ?? 7} 天</span>
						</div>
						<div className="row">
							<span className="muted">清单：已备份 {state?.vault?.records ?? 0} 项 · 约 {fmtBytes(state?.vault?.bytes ?? 0)}（图片字节在 IndexedDB，超出上限按最旧清理，事件会显示在这里）</span>
						</div>
						{state?.vault?.notice ? <p className="muted">{state.vault.notice}</p> : null}
						<div className="row"><button disabled={busy} onClick={() => void act({ type: 'vault.sweep' }, '已按 TTL/容量清理').catch(() => {})}>立即整理</button></div>
					</>
				) : <p className="muted">等待后台数据…</p>}
			</section>
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
				<input className="grow mono" placeholder="目标项目绝对路径" value={toCwd} onChange={e => { setToCwd(e.target.value); setPlan(null); }} />
				<button onClick={() => void pick()} disabled={busy}>浏览…</button>
			</div>
			<label className="row"><input type="checkbox" checked={createTarget} onChange={e => setCreateTarget(e.target.checked)} /> 目标不存在时创建</label>
			<div className="row">
				<button disabled={busy || !sessionId || !toCwd} onClick={() => { setBusy(true); setPlan(null); void callHost({ type: 'preflight', sessionId, toCwd, createTarget })
					.then(result => setPlan(result)).catch(error => say(`体检失败：${error.message}`)).finally(() => setBusy(false)); }}>体检</button>
				<button className="primary" disabled={busy || plan?.toProject === undefined} onClick={() => void act({ type: 'move', sessionId, toCwd, createTarget }, '迁移完成；其它窗口请重开该会话').catch(() => {})}>迁移</button>
			</div>
			{plan?.toProject && (
				<pre className="mono muted" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify({ 从: plan.fromCwd, 到: plan.toCwd, 原目录: plan.fromProject, 新目录: plan.toProject, 日志文件: plan.logName }, null, 2)}</pre>
			)}
			<p className="muted">只改 DSH 内部归属与会话头；历史不变，旧消息中的绝对路径仍指向原项目（已知语义）。迁移前请关闭该会话。</p>
		</section>
	);
}

function TrashSection({ act, busy, say, state }) {
	const items = state?.trash ?? [];
	return (
		<section className="box">
			<h3>回收站</h3>
			<p className="muted">删除会话 = 官方归档 + 入站记录；删除项目保留全部会话日志。彻底删除会先移到暂存目录再清理，中断可用 CLI 检出。</p>
			{items.length === 0 ? <p className="muted">（空）</p> : (
				<table>
					<thead><tr><th>类型</th><th>对象</th><th>标题 / 路径</th><th>入站时间</th><th /></tr></thead>
					<tbody>{items.map(item => (
						<tr key={item.itemId}>
							<td>{item.kind === 'session' ? '会话' : '项目'}</td>
							<td className="mono">{shortId(item.targetId)}</td>
							<td className="mono">{item.kind === 'session' ? item.snapshot.title || '（无标题）' : item.snapshot.path}</td>
							<td>{new Date(item.trashedAt).toLocaleString('zh-CN', { hour12: false })}</td>
							<td className="row">
								<button disabled={busy} onClick={() => void act({ type: 'trash.restore', itemId: item.itemId }, '已还原（若处于归档态请先在列表里还原归档）').catch(() => {})}>还原</button>
								<button disabled={busy} onClick={() => void act({ type: 'trash.purge', itemId: item.itemId }, '已彻底删除').catch(() => {})}>彻底删除</button>
							</td>
						</tr>))}
					</tbody>
				</table>
			)}
			<div className="row">
				<span className="muted">保留 {state?.settings?.trash?.ttlDays ?? 30} 天；到期自动清理{state?.settings?.trash?.autoPurge ? '（已开）' : '（未开，仅提醒）'}。</span>
				<button disabled={busy} onClick={() => void act({ type: 'settings.update', patch: { trash: { ...state?.settings?.trash, autoPurge: !(state?.settings?.trash?.autoPurge) } } }, '策略已更新').catch(() => {})}>切换自动清理</button>
				<button disabled={busy} onClick={() => void act({ type: 'trash.sweep' }, '已按 TTL 巡检').catch(() => {})}>巡检到期项</button>
			</div>
		</section>
	);
}

const shortId = id => String(id).length > 18 ? `${String(id).slice(0, 8)}…${String(id).slice(-6)}` : String(id);
const fmtBytes = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

/** Menu entry: move this session to another project (§10 MR6). */
export function MoveSessionMenuItem({ sessionId, t }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button role="menuitem" onClick={() => setOpen(true)} style={menuItemStyle}>{t ? t('menu.move') : '切换到其它项目…'}</button>
			{open ? <MoveDialog sessionId={sessionId} close={() => setOpen(false)} /> : null}
		</>
	);
}

export function TrashSessionMenuItem({ sessionId, t }) {
	const [confirm, setConfirm] = useState(false);
	const [busy, setBusy] = useState(false);
	if (confirm) {
		return <button role="menuitem" disabled={busy} style={menuItemStyle} onClick={async () => {
			setBusy(true);
			try { await callHost({ type: 'trash.session', sessionId }); setConfirm(false); }
			catch { sayRow(`回收失败`); setConfirm(false); }
			setBusy(false);
		}}>确认移入回收站？（先归档）</button>;
	}
	return <button role="menuitem" style={menuItemStyle} onClick={() => setConfirm(true)}>{t ? t('menu.trash') : '移入回收站'}</button>;
}
function sayRow(message) { store.error = message; for (const listener of store.listeners) listener(); }

const menuItemStyle = { background: 'transparent', border: 'none', color: 'inherit', font: 'inherit', padding: '6px 10px', textAlign: 'left', cursor: 'pointer', width: '100%' };

export function MoveDialog({ sessionId, close }) {
	const ref = useRef(null);
	const [toCwd, setToCwd] = useState('');
	const [createTarget, setCreateTarget] = useState(false);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => { try { dialog?.close(); } catch {} }; }, []);
	const submit = async () => {
		setBusy(true); setError('');
		try { await callHost({ type: 'move', sessionId, toCwd, createTarget }); close(); }
		catch (err) { setError(err.message); setBusy(false); }
	};
	const valid = /^\/|^[A-Za-z]:[\\/]/.test(toCwd);
	return (
		<div className="sk"><style>{styles}</style>
			<dialog ref={ref} onCancel={e => { e.preventDefault(); if (!busy) close(); }}>
				<div className="modal-head"><strong>会话切换到其它项目</strong><button onClick={close} disabled={busy}>关闭</button></div>
				<div className="modal-body">
					<p className="muted mono">{sessionId}</p>
					<input autoFocus className="grow mono" placeholder="目标项目绝对路径" value={toCwd} onChange={e => setToCwd(e.target.value)} />
					<label className="row"><input type="checkbox" checked={createTarget} onChange={e => setCreateTarget(e.target.checked)} /> 目录不存在时创建</label>
					{error ? <p className="error">{error}</p> : null}
					<div className="row"><button className="primary" disabled={busy || !valid} onClick={() => void submit()}>体检并迁移</button>
						<span className="muted">会话需空闲；迁移在后台离线完成。</span></div>
				</div>
			</dialog>
		</div>
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
