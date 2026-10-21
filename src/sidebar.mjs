import { orderedGroups, UNGROUPED } from './group-order.mjs';

/** Restrict both projections: otherwise filtered projects leak into native "ungrouped". */
export function filterSidebar(workspaces, sessions, groups, selected) {
 if (!selected) return { workspaces, sessions };
 const members = new Set(selected === 'ungrouped' ? groups.flatMap(row => row.workspaceIds) : groups.find(row => row.id === selected)?.workspaceIds ?? []);
 const items = workspaces.items.filter(row => selected === 'ungrouped' ? !members.has(row.workspaceId) : members.has(row.workspaceId));
 const allowed = new Set(items.flatMap(row => row.sessionIds));
 const accounted = new Set(workspaces.items.flatMap(row => row.sessionIds));
 const ids = sessions.ids.filter(id => allowed.has(id) || selected === 'ungrouped' && !accounted.has(id));
 const keep = new Set(ids);
 return { workspaces: { ...workspaces, items }, sessions: { ...sessions, ids,
  byId: Object.fromEntries(Object.entries(sessions.byId).filter(([id]) => keep.has(id))),
  projectionsBySession: Object.fromEntries(Object.entries(sessions.projectionsBySession ?? {}).filter(([id]) => keep.has(id))),
 } };
}
export const mirroredSlot = name => `session-toolbox.${name}`;

const GROUP_DRAG = 'application/x-dsh-toolbox-group';
/** Group sorting owns its MIME and capture events, leaving native project and
 * session sorting untouched. Save only on drop; keep the drag source mounted. */
export function groupOrderDrag({ read, move, preview, report }) {
 let source, moving = false;
 const heading = event => event.target.closest?.('[data-toolbox-group]');
 const ours = event => !!source && Array.from(event.dataTransfer?.types ?? []).includes(GROUP_DRAG);
 const consume = event => { event.preventDefault(); event.stopPropagation(); };
 const destination = event => {
  const row = heading(event), snapshot = read(), id = row?.getAttribute('data-toolbox-group');
  if (moving || snapshot.blocked || !row || !snapshot.groups.some(group => group.id === source)) return;
  const at = snapshot.groups.findIndex(group => group.id === id);
  if (at < 0) return;
  const bounds = row.getBoundingClientRect(), after = event.clientY >= bounds.top + bounds.height / 2;
  return { groupId: id, edge: after ? 'after' : 'before', beforeGroupId: after ? snapshot.groups[at + 1]?.id ?? '' : id };
 };
 const commit = async (id, beforeGroupId) => {
  const snapshot = read(), at = snapshot.groups.findIndex(group => group.id === id);
  if (moving || snapshot.blocked || at < 0 || beforeGroupId === id || (snapshot.groups[at + 1]?.id ?? '') === beforeGroupId) return;
  moving = true; report('');
  try { await move({ type: 'group.move', groupId: id, beforeGroupId }); }
  catch (error) { report(error.message); }
  finally { moving = false; preview(null); }
 };
 return {
  start(event) {
   const row = heading(event);
   if (!row) return false;
   event.stopPropagation();
   const id = row.getAttribute('data-toolbox-group'), snapshot = read();
   if (moving || snapshot.blocked || !snapshot.groups.some(group => group.id === id)) { event.preventDefault(); return true; }
   source = id; preview(null);
   event.dataTransfer.setData(GROUP_DRAG, id); event.dataTransfer.effectAllowed = 'move';
   return true;
  },
  over(event) {
   if (!ours(event)) return false;
   consume(event);
   const target = destination(event);
   event.dataTransfer.dropEffect = target ? 'move' : 'none'; preview(target ?? null);
   return true;
  },
  leave(event) { if (ours(event) && !heading(event)?.contains(event.relatedTarget)) preview(null); },
  async drop(event) {
   if (!ours(event)) return;
   consume(event);
   const target = destination(event), id = source;
   source = undefined; preview(null);
   if (target && event.dataTransfer.getData(GROUP_DRAG) === id) await commit(id, target.beforeGroupId);
  },
  end(event) { if (source) event?.stopPropagation(); source = undefined; preview(null); },
  step(id, direction) {
   const groups = read().groups, at = groups.findIndex(group => group.id === id);
   if (at < 0 || at + direction < 0 || at + direction >= groups.length) return;
   return commit(id, direction < 0 ? groups[at - 1].id : groups[at + 2]?.id ?? '');
  },
 };
}

const SESSION_DRAG = 'application/x-dsh-toolbox-session';
/** Extend native session sorting with project-header drops. Keep native dragend
 * cleanup, but suppress its last hovered insertion marker after a project drop. */
export function sessionProjectDrag({ read, move, report }) {
 let sessionId, highlighted, resetTimer, consumed = false, moving = false;
 const clear = () => { highlighted?.removeAttribute('data-toolbox-session-drop'); highlighted = undefined; };
 const projectRow = event => event.target.closest?.('[data-row-key^="workspace:"]');
 const ours = event => !!sessionId && Array.from(event.dataTransfer?.types ?? []).includes(SESSION_DRAG);
 const target = row => {
  const snapshot = read();
  if (moving || snapshot.blocked) return;
  const id = row?.getAttribute('data-row-key')?.slice('workspace:'.length);
  const workspace = snapshot.workspaces.find(item => item.workspaceId === id);
  const project = snapshot.projects.find(item => item.id === id);
  if (!workspace || !project?.path || workspace.sessionIds.includes(sessionId)) return;
  return project;
 };
 return {
  get suppressOrder() { return consumed; },
  start(event) {
   clearTimeout(resetTimer); sessionId = undefined; consumed = false; clear();
   const row = event.target.closest?.('[data-row-key^="session:"]');
   const snapshot = read();
   const id = row?.getAttribute('data-row-key')?.slice('session:'.length);
   const session = snapshot.sessions?.byId[id];
   if (!row?.draggable || !session || session.blank || snapshot.archived?.includes(id) || snapshot.blocked || moving) return;
   sessionId = id;
   event.dataTransfer.setData(SESSION_DRAG, id);
  },
  over(event) {
   if (!ours(event)) return;
   const row = projectRow(event); clear();
   if (!row) return;
   event.preventDefault(); event.stopPropagation();
   const project = target(row);
   event.dataTransfer.dropEffect = project ? 'move' : 'none';
   if (project) { highlighted = row; row.setAttribute('data-toolbox-session-drop', ''); }
  },
  leave(event) { if (highlighted && !highlighted.contains(event.relatedTarget)) clear(); },
  async drop(event) {
   if (!ours(event)) return;
   const row = projectRow(event);
   if (!row) return;
   event.preventDefault(); event.stopPropagation(); consumed = true; clear();
   if (event.dataTransfer.getData(SESSION_DRAG) !== sessionId) return;
   const project = target(row);
   if (!project) return;
   const id = sessionId;
   moving = true; report({ busy: true, message: '' });
   try {
    const result = await move({ type: 'move', sessionId: id, toCwd: project.path, createTarget: false });
    report({ busy: false, message: result?.deferred ? '文件已迁移，但项目账本尚未完成；请在工具箱点击完成或回滚' : `已切换到项目「${project.title}」`, error: false });
   } catch (error) { report({ busy: false, message: error.message, error: true }); }
   finally { moving = false; }
  },
  end() {
   sessionId = undefined; clear();
   // React capture and bubble use separate DOM listeners; a microtask may run
   // between them. Keep the guard until the entire dragend dispatch finishes.
   resetTimer = setTimeout(() => { consumed = false; }, 0);
  },
  dispose() { clearTimeout(resetTimer); clear(); },
 };
}

/** Decorate the public entry; original ownership, store, inject and components stay intact. */
export function installSidebar(ctx, makeComponent) {
 if (typeof ctx.slots.entries !== 'function' || typeof ctx.slots.subscribe !== 'function') return;
 ctx.slots.inject('sidebar.workspaces', () => {
  const native = ctx.slots.entries('sidebar.workspaces')[0];
  if (!native?.component || !native.children || Object.values(native.children).some(spec => spec.scope !== 'root')) return;
  ctx.effect(() => {
   const dispose = [];
   try {
    dispose.push(ctx.slots.register({ ...native.options, name: 'sidebar.workspaces', priority: (native.options.priority ?? 0) - 10,
     store: native.store, inject: native.inject, locale: native.locale,
     children: Object.fromEntries(Object.entries(native.children).map(([name, spec]) => [mirroredSlot(name), spec])),
    }, makeComponent(native)));
    for (const name of Object.keys(native.children)) {
     const copies = new Map();
     const sync = () => {
      const entries = ctx.slots.entries(name);
      for (const [entry, release] of copies) if (!entries.includes(entry)) { release(); copies.delete(entry); }
      for (const entry of entries) {
       if (copies.has(entry)) continue;
       // Unknown nested declarations need explicit adaptation, never duplicate their ownership.
       if (entry.children) throw new Error(`Unsupported nested sidebar slot: ${name}`);
       copies.set(entry, ctx.slots.register({ ...entry.options, name: mirroredSlot(name), inject: entry.inject, store: entry.store, locale: entry.locale }, entry.component));
      }
     };
     dispose.push(() => { for (const release of copies.values()) release(); copies.clear(); });
     sync();
     dispose.push(ctx.slots.subscribe(name, sync));
    }
   } catch (error) {
    for (const release of dispose.reverse()) release?.();
    console.warn('[dsh-session-toolbox] Native sidebar decoration unavailable', error);
    return;
   }
   return () => { for (const release of dispose.reverse()) release?.(); };
  });
 });
}

/** Placement shared by CSS and projection order, including the built-in group. */
export function sidebarLayout(workspaces, groups, ungroupedIndex) {
 const ordered = orderedGroups(groups, ungroupedIndex);
 const ranks = new Map();
 for (const [index, group] of ordered.entries()) for (const id of group.workspaceIds) if (!ranks.has(id)) ranks.set(id, index);
 const ungrouped = ordered.findIndex(group => group.id === UNGROUPED);
 return workspaces.map((workspace, index) => ({ workspace, group: ranks.get(workspace.workspaceId) ?? ungrouped, index }))
  .sort((a, b) => a.group - b.group || a.index - b.index);
}

/** React portals have separate event ancestry. Keep the native menu's leave timer
 * from treating a transition to an added item as an exit from its anchor. */
export function protectProjectMenu(doc, anchor, menu, close) {
 let timer;
 const inside = node => !!node && (anchor.contains(node) || menu.contains(node));
 const enter = event => { if (inside(event.target)) clearTimeout(timer); };
 const leave = event => {
  if (!inside(event.target)) return;
  // Own the boundary in DOM space, including the small anchor/menu gap.
  // React cannot cancel its leave timer when entering a foreign portal.
  event.stopPropagation();
  clearTimeout(timer);
  if (!inside(event.relatedTarget)) timer = setTimeout(close, 180);
 };
 doc.addEventListener('pointerout', leave, true);
 doc.addEventListener('pointerover', enter, true);
 return () => { clearTimeout(timer); doc.removeEventListener('pointerout', leave, true); doc.removeEventListener('pointerover', enter, true); };
}
