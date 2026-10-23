/**
 * dsh-session-toolbox browser plugin: management page (§4 FR5/FR6, §10 MR6, §11
 * TB2), session context-menu entries, the input-dock vault badge, and the
 * draft vault itself (capture + IndexedDB + synthetic-paste restore; route A).
 * Every official surface is probed (`ctx.get?.`, guarded registrations); no
 * path here may take the native composer down with it (NFR3).
 */
import { useEffect, useState, useRef, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import pkg from '../package.json' with { type: 'json' };
const pluginVersion = pkg.version;
import { MenuItemButton, Modal, Button, Tooltip, UserTextRun, IconFolderOpenOutlineRegular, IconArchiveOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { REPLY_SOURCE, REPLY_TEXT_NODE, readReply, insertReply, withoutReply, messageReply, messageSequence, replySource, replyTextRule, installReplyNodes, selectedReply } from './reply.mjs';
import { createCandidateView, candidatesForTurn } from './next-tasks-view.mjs';
import { createVault } from './draft-vault.js';
import { orderedGroups, UNGROUPED } from './group-order.mjs';
import { dictionaries, resolveLanguage, translate } from './locale.mjs';
import { NextTaskModelSettings } from './next-task-model-settings.jsx';
export { NextTaskModelSettings } from './next-task-model-settings.jsx';
const workspaceChinese = dictionaries.zh;
import { createHostVersionGuard } from './host-version.mjs';
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
let pluginManager;
let localeService;
/** @type {{ running: boolean }} */
export const refreshState = { running: false };
const store = { state: null, error: '', overlay: null, listeners: new Set() };
function showOverlay(request) { store.overlay = request; for (const listener of store.listeners) listener(); }

async function readResponse(res) {
	let next;
	try { next = JSON.parse(await res.text()); }
	catch { throw new Error(uiText('error.backend', { status: res.status })); }
	if (next === null || typeof next !== 'object' || Array.isArray(next)) throw new Error(uiText('error.response'));
	if (!res.ok) throw new Error(next.error ?? uiText('error.http', { status: res.status }));
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
const ensureHostVersion = createHostVersionGuard({ version: pluginVersion, name: NS, manager: () => pluginManager, readState: loadState, t: (key, values) => text(undefined, key, values) });
const backgroundReads = new Set(['nextTasks.get', 'nextTasks.models', 'checkpoint.status', 'message.list', 'project.of', 'trash.list']);
function ensureSessionKey(force = false) {
 if (sessionKey && !force) return Promise.resolve();
 if (!keyRequest) keyRequest = loadState().finally(() => { keyRequest = null; });
 return keyRequest;
}
export async function callHost(input) {
	if (input.type === 'vault.sweep') {
		if (!vault) throw new Error(uiText('error.vault'));
		const report = await vault.sweep();
		await vault.syncHost();
		return report;
	}
	await ensureSessionKey();
	await ensureHostVersion(store.state, !backgroundReads.has(input.type));
	const post = () => fetch(ENDPOINT, {
		method: 'POST', cache: 'no-store',
		headers: { 'content-type': 'application/json', 'x-session-toolbox-key': sessionKey },
		body: JSON.stringify(input),
	});
	let response = await post();
	if (response.status === 401) { await ensureSessionKey(true); await ensureHostVersion(store.state, !backgroundReads.has(input.type)); response = await post(); }
	const res = await readResponse(response);
	sessionKey = res.key ?? sessionKey;
	if (['move', 'move.complete', 'move.rollback', 'workspace.edit', 'workspace.complete', 'trash.session', 'trash.workspace', 'trash.restore', 'trash.purge'].includes(input.type)) {
		try { await refreshSessionList(); }
		catch (error) { dispatchNotice(uiText('error.refreshAfterWrite', { error: error.message })); }
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
	if (service === undefined) throw new Error(uiText('error.sessions'));
	if (typeof service.refresh !== 'function') throw new Error(uiText('error.refresh'));
	refreshState.running = true;
	try { await service.refresh(); }
	finally { refreshState.running = false; }
	await loadState();
}

export function apply(ctx) {
 localeService = ctx.locale;
 if (typeof localeService?.subscribe === 'function') ctx.effect(() => localeService.subscribe(() => { for (const listener of store.listeners) listener(); }));
	// Optional: hosts without the manager retain the rest of the plugin. Use the
	// public Remote API, with its declared injection, for update reconciliation.
	ctx.inject?.(['remote', 'remote.pluginManager'], scope => {
		const service = scope.get('remote').pluginManager;
		pluginManager = service;
		scope.effect(() => () => { if (pluginManager === service) pluginManager = undefined; });
	});
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
		t: (key, values) => text(undefined, key, values),
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
	void vaultInstance.start().catch(error => sayRow(uiText('error.vaultStart', { error: error.message })));
	// `locale` is injected above, so the service is guaranteed here; registering
	// inside ctx.effect keeps the dictionaries disposable across hot reloads
	// (same shape as the official client plugins).
	ctx.effect(() => ctx.locale.register(NS, {
		zh: dictionaries.zh,
		en: dictionaries.en,
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
.sk{--sk-accent:var(--dsw-alias-state-active-primary,#3a71db);--sk-border:var(--dsw-alias-border-l2,#444);--sk-bg:var(--dsw-alias-bg-layer-1,#202020);--sk-card:var(--dsw-alias-bg-module-platform,#282828);--sk-text:var(--dsw-alias-label-primary,#f4f4f4);--sk-muted:var(--dsw-alias-label-secondary,#b0b0b0);color:var(--sk-text);font:inherit;font-size:13px;line-height:1.5;max-width:1120px;min-width:0}
.sk *{box-sizing:border-box}.sk h2,.sk h3,.sk p{margin:0}.sk h2{font-size:22px}.sk h3{font-size:16px}.sk .muted,.sk small{color:var(--sk-muted)}
.sk .box{border:1px solid var(--sk-border);border-radius:10px;padding:14px 16px;background:var(--sk-card);display:flex;flex-direction:column;gap:10px;min-width:0}
.sk .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.sk.stack,.sk .stack{display:flex;flex-direction:column;gap:12px}
.sk .community{padding:10px 14px;border:1px solid var(--sk-border);border-radius:8px;background:var(--sk-card)}.sk .community a{color:var(--sk-accent);font-weight:500;text-decoration:underline;text-underline-offset:3px}.sk .community a:hover{opacity:.8}.sk .community a:focus-visible{outline:2px solid var(--sk-accent);outline-offset:4px;border-radius:2px}
.sk button,.sk input,.sk select{font:inherit;color:inherit;border:1px solid var(--sk-border);border-radius:8px;background:var(--sk-bg);min-height:36px;padding:7px 12px}
.sk button{cursor:pointer}.sk button:hover{background:var(--sk-card)}.sk button:disabled{opacity:.45;cursor:default}
.sk button.primary{background:var(--sk-accent);color:#fff;border-color:transparent}
.sk table{width:100%;border-collapse:collapse;font-size:13px}.sk th,.sk td{border-bottom:1px solid var(--sk-border);padding:8px;text-align:left}.sk th{color:var(--sk-muted);font-weight:500}
.sk .error{color:var(--dsw-alias-state-error-primary,#ef9393)}.sk .good{color:var(--dsw-alias-state-success-primary,#77ca9d)}
.sk .pill{border:1px solid var(--sk-border);border-radius:100px;padding:2px 10px;font-size:12px;background:var(--sk-bg);display:inline-block}
.sk .mono{font:12px ui-monospace,monospace;overflow-wrap:anywhere}
.sk input.grow{flex:1;min-width:0}
.sk select.grow{flex:1;min-width:0;max-width:100%}.sk input[type=checkbox]{min-height:0;padding:0;accent-color:var(--sk-accent)}
.sk :is(button,input,select,summary):focus-visible{outline:2px solid var(--sk-accent);outline-offset:3px}
.sk-header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.sk-header-title{display:flex;align-items:center;gap:10px}.sk-header-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.sk .sk-header h2{font-size:20px;letter-spacing:-.3px}
.sk .community{padding:8px 12px;border-radius:7px;font-size:12px}.sk .sk-caption{font-size:12px;line-height:1.5}.sk .sk-notice{padding:8px 12px;border:1px solid var(--sk-border);border-radius:7px;overflow-wrap:anywhere}
.sk-page-grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:12px;align-items:start}.sk-column{display:flex;flex-direction:column;gap:12px;min-width:0}
.sk-field{display:flex;flex-direction:column;gap:4px;min-width:0}.sk-field>span{font-size:12px;color:var(--sk-muted)}.sk-field :is(input,select){width:100%;min-width:0}
.sk-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.sk-model-form{display:flex;flex-direction:column;gap:8px}.sk-model-mode .sk-field{flex:1}.sk-model-mode{align-items:flex-end!important}
.sk-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0;padding:10px 0;border-block:1px solid var(--sk-border)}.sk-metrics>div{min-width:0}.sk-metrics dt{font-size:11px;color:var(--sk-muted)}.sk-metrics dd{font-size:19px;font-weight:600;line-height:1.3;font-variant-numeric:tabular-nums;margin:3px 0 0;overflow-wrap:anywhere}
.sk details>summary{cursor:pointer;color:var(--sk-muted);font-size:12px;min-height:28px;display:list-item;align-content:center}.sk details[open]>summary{margin-bottom:8px}.sk-table-scroll{max-width:100%;overflow-x:auto}.sk .sk-section-heading{display:flex;gap:8px;align-items:center;justify-content:space-between}.sk-archive td{overflow-wrap:anywhere;max-width:280px}
@container toolbox-page (max-width:760px){.sk-page-grid{grid-template-columns:1fr}}
.sk-page{container:toolbox-page / inline-size;width:100%}
@media(max-width:760px){.sk-page-grid{grid-template-columns:1fr}}
@media(max-width:440px){.sk .box{padding:12px}.sk-fields{grid-template-columns:1fr}.sk-header-tools{width:100%}.sk-header-tools>label{flex:1}.sk-header-tools select{max-width:100%}.sk-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.sk .community{gap:6px 10px}}
@media(pointer:coarse){.sk :is(button,select,input:not([type=checkbox]),summary){min-height:44px}.sk label.row{min-height:44px}}
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
		try { const result = await callHost(input); if (result.deferred) say(result.note ?? uiText('move.deferred')); else if (ok) say(ok); await loadState(); setBusy(false); return result; }
		catch (err) { say(text(t, 'common.failed', { error: err.message })); setBusy(false); throw err; }
	};
	const settings = state?.settings;
	return (
		<div className="sk stack sk-page" lang={activeLanguage()}>
			<style>{styles}</style>
			<header className="sk-header"><div><div className="sk-header-title"><h2>{text(t, 'page.title')}</h2><span className="pill">v{pluginVersion}</span></div><p className="muted sk-caption">{text(t, 'page.subtitle')}</p></div>
			 <div className="sk-header-tools"><label className="row"><span className="muted sk-caption">{text(t, 'page.language')}</span><select aria-label={text(t, 'page.language')} value={settings?.language ?? 'auto'} disabled={busy || !settings} onChange={event => { setFeedback(''); void act({ type: 'settings.update', patch: { language: event.target.value } }).catch(() => {}); }}><option value="auto">{text(t, 'page.followLanguage')}</option><option value="zh">中文</option><option value="en">English</option></select></label>
			 <button disabled={busy || refreshing} title={text(t, 'page.refreshHelp')} onClick={() => { setRefreshing(true); void refreshSessionList().then(() => say(text(t, 'page.refreshed'))).catch(err => say(text(t, 'common.failed', { error: err.message }))).finally(() => setRefreshing(false)); }}>{text(t, refreshing ? 'page.refreshing' : 'page.refresh')}</button></div>
			</header>
			<div className="row community">
				<a href="https://qm.qq.com/q/eQC7OQXQe4" target="_blank" rel="noopener noreferrer">{text(t, 'community.join')}</a>
				<span className="muted">{text(t, 'community.name')} · {text(t, 'community.number')} <strong>1124103038</strong></span>
				<a href="https://github.com/AndroidSix/dsh-session-toolbox" target="_blank" rel="noopener noreferrer">{text(t, 'community.repository')}</a>
				<span className="muted">{text(t, 'community.star')}</span>
			</div>
			{error ? <p className="error sk-notice" role="alert">{text(t, 'page.connection', { error })}</p> : null}
			{feedback ? <p className="good sk-notice" role="status">{feedback}</p> : null}
			<div className="sk-page-grid"><div className="sk-column"><NextTaskSettings state={state} act={act} busy={busy} /><WorkspaceSection state={state} t={t} /></div><div className="sk-column">
			<section className="box">
				<h3>{text(t, 'vault.title')}</h3>
				{settings ? (
					<>
						<div className="row">
							<label className="row"><input type="checkbox" checked={settings.draftVault?.enabled !== false} disabled={busy}
								onChange={e => void act({ type: 'settings.update', patch: { draftVault: { ...settings.draftVault, enabled: e.target.checked } } }, text(t, e.target.checked ? 'vault.on' : 'vault.off')).catch(() => {})} /> {text(t, 'vault.enabled')}</label>
						</div>
						<div className="row">
							<strong>{text(t, 'vault.summary', { count: state?.vault?.records ?? 0, size: fmtBytes(state?.vault?.bytes ?? 0) })}</strong>
						</div>
						<p className="muted sk-caption">{text(t, 'vault.policy', { size: Math.round((settings.draftVault?.maxSizeBytes ?? 0) / 1048576), days: settings.draftVault?.ttlDays ?? 7 })}</p>
						<p className="muted sk-caption">{text(t, 'vault.help')}</p>
						{vault?.lastNotice ? <p className="muted">{vault.lastNotice}</p> : null}
						<div className="row"><button disabled={busy} onClick={() => void act({ type: 'vault.sweep' }, text(t, 'vault.swept')).catch(() => {})}>{text(t, 'vault.sweep')}</button></div>
					</>
				) : <p className="muted">{text(t, 'common.loading')}</p>}
			</section>
			<MoveSection act={act} busy={busy} say={say} state={state} />
			</div></div>
			<TrashSection act={act} busy={busy} say={say} state={state} />
			<p className="muted sk-caption">{text(t, 'page.privacy')}</p>
		</div>
	);
}

function MoveSection({ act, busy, say, state }) {
 const [sessionId, setSessionId] = useState(''), [toCwd, setToCwd] = useState('');
 const [createTarget, setCreateTarget] = useState(false), [plan, setPlan] = useState(null);
 const [fromProject, setFromProject] = useState(null);
 const projects = state?.projects ?? [], journal = state?.journal;
 useEffect(() => {
  if (!sessionId) { setFromProject(null); return; }
  let alive = true;
  void callHost({ type: 'project.of', sessionId }).then(result => { if (alive) setFromProject(result?.project ?? null); }).catch(() => { if (alive) setFromProject(null); });
  return () => { alive = false; };
 }, [sessionId]);
 const pick = async () => {
  try { const result = await directoryPicker?.pick?.(); if (result?.ok && typeof result.value === 'string') { setToCwd(result.value); setPlan(null); } else say(uiText('move.pickerUnavailable')); }
  catch (error) { say(uiText('common.failed', { error: error.message })); }
 };
 return <section className="box"><h3>{uiText('move.title')}</h3>
  {journal && <div className="stack"><p className="error">{uiText('move.pending')} <span className="mono">{journal.sessionId} → {journal.toCwd}</span></p><div className="row"><button disabled={busy} onClick={() => void act({ type: 'move.complete' }, uiText('move.completed')).catch(() => {})}>{uiText('move.complete')}</button><button disabled={busy} onClick={() => void act({ type: 'move.rollback' }, uiText('move.rolledBack')).catch(() => {})}>{uiText('move.rollback')}</button></div></div>}
  <label className="sk-field"><span>{uiText('move.session')}</span><input className="mono" placeholder={uiText('move.sessionPlaceholder')} value={sessionId} onChange={event => { setSessionId(event.target.value); setPlan(null); }} /></label>
  {projects.length > 0 && <label className="sk-field"><span>{uiText('move.target')}</span><select value={projects.some(project => project.path === toCwd) ? toCwd : ''} onChange={event => { setToCwd(event.target.value); setPlan(null); }}><option value="">{uiText('move.select')}</option>{projects.map(project => <option key={project.id} value={project.path} disabled={fromProject?.path === project.path}>{project.title} ({project.sessions}){fromProject?.path === project.path ? uiText('move.currentSuffix') : ''}</option>)}</select></label>}
  <label className="sk-field"><span>{uiText('move.path')}</span><div className="row"><input className="grow mono" placeholder={uiText('move.pathPlaceholder')} value={toCwd} onChange={event => { setToCwd(event.target.value); setPlan(null); }} /><button type="button" onClick={() => void pick()} disabled={busy}>{uiText('project.browse')}</button></div></label>
  {sessionId && <p className="muted sk-caption">{uiText('move.current')}: {fromProject ? <><strong>{fromProject.title}</strong> <span className="mono">{fromProject.path}</span></> : uiText('move.unknown')}</p>}
  <div className="row"><label className="row"><input type="checkbox" checked={createTarget} onChange={event => { setCreateTarget(event.target.checked); setPlan(null); }} />{uiText('move.create')}</label><button disabled={busy || !sessionId || !toCwd} onClick={() => { setPlan(null); void act({ type: 'preflight', sessionId, toCwd, createTarget }).then(setPlan).catch(() => {}); }}>{uiText('move.preflight')}</button><button className="primary" disabled={busy || plan?.toProject === undefined} onClick={() => void act({ type: 'move', sessionId, toCwd, createTarget }, uiText('move.done')).catch(() => {})}>{uiText('move.submit')}</button></div>
  {plan?.toProject && <pre className="mono muted" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify({ from: plan.fromCwd, to: plan.toCwd, fromProject: plan.fromProject, toProject: plan.toProject, logFile: plan.logName }, null, 2)}</pre>}
  <details><summary>{uiText('common.details')}</summary><p className="muted sk-caption">{uiText('move.help')}</p></details>
 </section>;
}

function TrashSection({ act, busy, state }) {
 const items = state?.trash ?? [];
 return <section className="box sk-archive"><div className="sk-section-heading"><h3>{uiText('trash.title')} <span className="pill">{items.length}</span></h3><details><summary>{uiText('common.details')}</summary><p className="muted sk-caption">{uiText('trash.help')}</p></details></div>
  {items.length === 0 ? <p className="muted sk-caption">{uiText('trash.empty')}</p> : <div className="sk-table-scroll"><table><thead><tr>{['trash.type', 'trash.object', 'trash.path', 'trash.date', 'common.actions'].map(key => <th key={key}>{uiText(key)}</th>)}</tr></thead><tbody>{items.map(item => <tr key={item.itemId}>
   <td>{uiText(item.source === 'native' ? 'trash.native' : item.kind === 'session' ? 'trash.chat' : 'trash.project')}</td><td className="mono">{shortId(item.targetId)}</td><td className="mono">{item.kind === 'session' ? item.snapshot.title || uiText('trash.untitled') : item.snapshot.path}</td><td>{item.trashedAt ? new Date(item.trashedAt).toLocaleString(activeLanguage(), { hour12: false }) : uiText('trash.unknownDate')}</td>
   <td><div className="row"><button disabled={busy} onClick={() => void act({ type: 'trash.restore', itemId: item.itemId }, uiText('trash.restored')).catch(() => {})}>{uiText('trash.restore')}</button><button disabled={busy} onClick={() => showOverlay({ kind: 'purge', itemId: item.itemId, title: item.snapshot.title || item.snapshot.path || item.targetId })}>{uiText('trash.delete')}</button></div></td>
  </tr>)}</tbody></table></div>}
  <div className="row"><span className="muted sk-caption">{uiText('trash.policy', { days: state?.settings?.trash?.ttlDays ?? 30 })}</span><label className="row"><input type="checkbox" checked={Boolean(state?.settings?.trash?.autoPurge)} disabled={busy || !state?.settings} onChange={event => void act({ type: 'settings.update', patch: { trash: { autoPurge: event.target.checked } } }, uiText('common.saved')).catch(() => {})} />{uiText('trash.auto')}</label><button disabled={busy} onClick={() => void act({ type: 'trash.sweep' }, uiText('trash.swept')).catch(() => {})}>{uiText('trash.sweep')}</button></div>
 </section>;
}

const shortId = id => String(id).length > 18 ? `${String(id).slice(0, 8)}…${String(id).slice(-6)}` : String(id);
const fmtBytes = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

/** Menu entry: move this session to another project (§10 MR6). */
export function MoveSessionMenuItem({ sessionId, useMenuOpenState, t }) {
 useLanguage();
	const [, setMenuOpen] = useMenuOpenState?.() ?? [false, () => {}];
	return <MenuItemButton separatorBefore icon={<IconFolderOpenOutlineRegular size={14} />} onSelect={() => {
		setMenuOpen(false);
		showOverlay({ kind: 'move', sessionId });
	}}>{text(t, 'menu.move')}</MenuItemButton>;
}

export function TrashSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, t }) {
 useLanguage();
	const [, setMenuOpen] = useMenuOpenState?.() ?? [false, () => {}];
	return <MenuItemButton icon={<IconArchiveOutlineRegular size={14} />} onSelect={() => {
		setMenuOpen(false);
		showOverlay({ kind: 'archive', sessionId, title: displayTitle || sessionId });
	}}>{text(t, 'menu.trash')}</MenuItemButton>;
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
	return <Modal open onClose={dismiss} closeLabel={uiText('common.close')} title={uiText(purge ? 'trash.delete' : 'menu.trash')}
		description={uiText(purge ? 'trash.deleteHelp' : 'trash.archiveHelp', { title: request.title })}
		footer={<><Button variant="outline" disabled={busy} onClick={dismiss}>{uiText('common.cancel')}</Button><Button variant="outline" disabled={busy} onClick={() => void submit()}>{uiText(busy ? 'common.busy' : purge ? 'trash.confirmDelete' : 'trash.confirmArchive')}</Button></>}>
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
				? uiText('move.deferred')
				: uiText('move.done'));
		}
		catch (err) { setError(err.message); setBusy(false); }
	};
	const valid = /^\/|^[A-Za-z]:[\\/]/.test(toCwd);
	return (
		<Modal open onClose={() => { if (!busy) close(); }} closeLabel={uiText('common.close')} title={uiText('move.title')}
			footer={<><Button variant="outline" disabled={busy} onClick={close}>{uiText('common.cancel')}</Button><Button variant="primary" disabled={busy || !valid || fromProject?.path === toCwd} onClick={() => void submit()}>{uiText(busy ? 'move.moving' : 'move.checkAndMove')}</Button></>}>
			<div className="sk stack"><style>{styles}</style>
				<p className="muted mono">{sessionId}</p>
				<p className="muted">{uiText('move.current')}: {fromProject ? <><strong>{fromProject.title}</strong> <span className="mono">{fromProject.path}</span></> : uiText('move.unknown')}</p>
				{projects.length > 0 && <label className="stack">{uiText('move.target')}
					<select value={projects.some(p => p.path === toCwd) ? toCwd : ''} onChange={e => setToCwd(e.target.value)} disabled={busy}>
						<option value="">{uiText('move.select')}</option>
						{projects.map(project => <option key={project.id} value={project.path} disabled={fromProject?.path === project.path}>{project.title} ({project.sessions}){fromProject?.path === project.path ? uiText('move.currentSuffix') : ''}</option>)}
					</select>
				</label>}
				<label className="stack">{uiText('move.path')}<input className="mono" value={toCwd} onChange={e => setToCwd(e.target.value)} disabled={busy} placeholder={uiText('move.pathPlaceholder')} /></label>
				<label className="row"><input type="checkbox" checked={createTarget} onChange={e => setCreateTarget(e.target.checked)} disabled={busy} /> {uiText('move.create')}</label>
				{error ? <p className="error" role="alert">{error}</p> : null}
				<p className="muted">{uiText('move.help')}</p>
			</div>
		</Modal>
	);
}

/** Input-dock badge (§4 FR5): how many image drafts are backed up for this session. */
export function VaultBadge({ sessionId }) {
 useLanguage();
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
	const currentNotice = vault?.lastNotice ?? notice;
	return <span className="sk"><span className="pill" title={uiText('vault.badgeHelp', { count }) + (currentNotice ? ` · ${currentNotice}` : '')}>{uiText('vault.badge', { count })}</span></span>;
}

function activeLanguage() { return resolveLanguage(store.state?.settings?.language, localeService?.getSnapshot?.()?.active); }
const text = (_t, key, values) => translate(activeLanguage(), key, values);
const subscribeLanguage = listener => { store.listeners.add(listener); return () => store.listeners.delete(listener); };
function useLanguage() { return useSyncExternalStore(subscribeLanguage, activeLanguage, activeLanguage); }

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
 const sessionDrag = useMemo(() => sessionProjectDrag({ read: () => dragSnapshot.current, move: callHost, report: setSessionFeedback, t: (key, values) => text(undefined, key, values) }), []);
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
  {sessionFeedback && <p role={sessionFeedback.error ? 'alert' : 'status'} style={{ padding: '0 12px', fontSize: 12 }}>{sessionFeedback.busy ? uiText('move.moving') : sessionFeedback.message}</p>}
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
 if (!replyWritable(sessionId) || snapshot?.phase !== 'plain') throw new Error(uiText('input.notReady'));
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
 useLanguage();
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
 useLanguage();
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
 useLanguage();
 const [result, setResult] = useState(() => candidateView.get(sessionId)), [error, setError] = useState('');
 useEffect(() => { setResult(candidateView.get(sessionId)); return candidateView.subscribe(sessionId, setResult); }, [sessionId]);
 const candidates = candidatesForTurn(result, seq);
 if (!candidates.length) {
  if (result?.seq !== seq || !['generating', 'ready', 'failed', 'unavailable', 'cancelled', 'error'].includes(result?.status)) return null;
  const key = result.status === 'generating' ? 'nextTasks.generating' : result.status === 'ready' ? 'nextTasks.empty' : result.status === 'unavailable' ? 'nextTasks.unavailable' : 'nextTasks.failed';
  const reasonKey = `nextTasks.reason.${result.reason}`;
  return <div data-toolbox-next-status className="sk-next-status"><style>{conversationExtrasStyle}</style><span role="status">{text(t, key)}{Object.hasOwn(workspaceChinese, reasonKey) ? ` · ${text(t, reasonKey)}` : ''}{result.customModel && ['failed', 'unavailable'].includes(result.status) ? ` · ${text(t, 'nextTasks.noFallback')}` : ''}</span><button type="button" className="sk-extras-close" aria-label={text(t, 'nextTasks.dismiss')} onClick={() => candidateView.dismiss(sessionId)}><CloseIcon /></button></div>;
 }
 return <section data-toolbox-next-tasks className="sk-next-tasks" aria-label={text(t, 'nextTasks.title')}>
  <style>{conversationExtrasStyle}</style>
  <div className="sk-next-heading"><span>{text(t, 'nextTasks.title')}</span><button className="sk-extras-close" type="button" aria-label={text(t, 'nextTasks.dismiss')} title={text(t, 'nextTasks.dismiss')} onClick={() => candidateView.dismiss(sessionId)}><CloseIcon /></button></div>
  <div className="sk-next-options">{candidates.map(value => <button className="sk-next-task" type="button" key={value} onClick={() => { try { fillComposer(sessionId, value); candidateView.dismiss(sessionId); setError(''); } catch (reason) { setError(reason.message); } }}><span>{value}</span><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><path d="M3 8h9M8 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" /></svg></button>)}</div>
  {error && <span role="alert">{error}</span>}
 </section>;
}

const uiText = (key, values) => text(undefined, key, values);
const readModelCatalog = provider => callHost({ type: 'nextTasks.models', provider });
export function NextTaskSettings({ state, act, busy }) {
 useLanguage();
 const usage = state?.nextTasks, totals = usage?.totals;
 const lastFailure = usage?.recent?.[0]?.status === 'failed' ? usage.recent[0] : null;
 const number = value => Number(value ?? 0).toLocaleString(activeLanguage());
 return <section className="box" data-toolbox-next-settings><h3>{uiText('nextTasks.settings')}</h3>
  <label className="row"><input type="checkbox" checked={state?.settings?.nextTasks?.enabled !== false} disabled={busy || !state?.settings} onChange={event => void act({ type: 'settings.update', patch: { nextTasks: { enabled: event.target.checked } } }, uiText(event.target.checked ? 'nextTasks.enabled' : 'nextTasks.disabled')).catch(() => {})} /> {uiText('nextTasks.auto')}</label>
  <p className="muted sk-caption">{uiText('nextTasks.help')}</p>
  <NextTaskModelSettings settings={state?.settings?.nextTasks} act={act} busy={busy} readCatalog={readModelCatalog} t={uiText} />
  {usage?.available === false && <p className="error" role="status">{uiText('nextTasks.noService')}</p>}
  {lastFailure && <p className="error sk-caption" role="status">{uiText('nextTasks.failure', { reason: uiText(`nextTasks.reason.${lastFailure.reason ?? 'model-call'}`) })}{lastFailure.customModel ? ` · ${uiText('nextTasks.noFallback')}` : ''}</p>}
  {totals && <><dl className="sk-metrics">{[['usage.calls', totals.calls], ['usage.completed', totals.completed], ['usage.failed', totals.failed], ['usage.total', totals.totalTokens]].map(([key, value]) => <div key={key}><dt>{uiText(key)}</dt><dd>{number(value)}</dd></div>)}</dl>
   <details><summary>{uiText('usage.details')}</summary><div className="stack">
    <p className="muted sk-caption">{uiText('usage.cancelled')} {number(totals.cancelled)} · {uiText('usage.unreported')} {number(totals.unreported)} · {uiText('usage.pending')} {number(usage.pending)}</p>
    <p className="muted sk-caption">{uiText('usage.input')} {number(totals.inputTokens)} · {uiText('usage.cache')} {number(totals.cacheReadTokens)} / {number(totals.cacheWriteTokens)} · {uiText('usage.output')} {number(totals.outputTokens)} ({uiText('usage.reasoning')} {number(totals.reasoningTokens)})</p>
    {!!usage.models?.length && <div className="sk-table-scroll"><table><thead><tr>{['common.model', 'usage.calls', 'usage.input', 'usage.cache', 'usage.output', 'usage.total'].map(key => <th key={key}>{uiText(key)}</th>)}</tr></thead><tbody>{usage.models.map(row => <tr key={`${row.provider}:${row.model}`}><td className="mono">{row.provider} / {row.model}</td><td>{number(row.calls)}</td><td>{number(row.inputTokens)}</td><td>{number(row.cacheReadTokens)} / {number(row.cacheWriteTokens)}</td><td>{number(row.outputTokens)}</td><td>{number(row.totalTokens)}</td></tr>)}</tbody></table></div>}
    {!!usage.days?.length && <details><summary>{uiText('usage.days')}</summary><div className="sk-table-scroll"><table><thead><tr>{['usage.date', 'usage.calls', 'usage.total', 'usage.unreported'].map(key => <th key={key}>{uiText(key)}</th>)}</tr></thead><tbody>{usage.days.map(row => <tr key={row.date}><td>{row.date}</td><td>{number(row.calls)}</td><td>{number(row.totalTokens)}</td><td>{number(row.unreported)}</td></tr>)}</tbody></table></div></details>}
    <p className="muted sk-caption">{uiText('usage.help')}</p>
   </div></details>
  </>}
  <details><summary>{uiText('common.details')}</summary><p className="muted sk-caption">{uiText('nextTasks.limits')}</p></details>
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
 useLanguage();
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
   insertReply(input, quote, `${label} · ${text(toolboxT, quote.role === 'user' ? 'reply.user' : 'reply.assistant')}`, replyCarets.get(input), uiText);
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
 useLanguage();
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
 useLanguage();
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
 useLanguage();
 const [busy, setBusy] = useState(false), [error, setError] = useState('');
 const locked = useRef(false);
 const remove = async () => {
  if (locked.current) return;
  locked.current = true; setBusy(true); setError('');
  try {
   if (!replyWritable(request.sessionId)) throw new Error(text(t, 'reply.unavailable'));
   const result = await callHost({ type: 'message.delete', sessionId: request.sessionId, seq: request.seq });
   if (!result.removedFromContext) throw new Error(uiText('error.contextDelete'));
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
 useLanguage();
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
 useLanguage();
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
   insertReply(input, { role: menu.role, text: menu.text }, text(t, 'reply.selection'), replyCarets.get(input), uiText);
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
 useLanguage();
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
 const cancel = occurrence => { try { input.setDraft(withoutReply(input.state.getSnapshot(), occurrence, uiText)); input.persistCurrentDraft?.(); input.focus?.(); setError(''); } catch (reason) { setError(reason.message); } };
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
 return <section className="box"><h3>{text(t, 'groups.pageTitle')}</h3>
  <p className="muted">{text(t, 'groups.summary', { groups: (state?.groups?.length ?? 0) + 1, projects: state?.projects?.length ?? 0 })}</p>
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
