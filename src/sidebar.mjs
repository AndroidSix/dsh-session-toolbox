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

/** Placement shared by CSS and projection order; unassigned projects follow named groups. */
export function sidebarLayout(workspaces, groups) {
 const ranks = new Map();
 for (const [index, group] of groups.entries()) for (const id of group.workspaceIds) if (!ranks.has(id)) ranks.set(id, index);
 return workspaces.map((workspace, index) => ({ workspace, group: ranks.get(workspace.workspaceId) ?? groups.length, index }))
  .sort((a, b) => a.group - b.group || a.index - b.index);
}

export function installQueueSteering(ctx, makeComponent) {
 if (typeof ctx.slots.entries !== 'function' || typeof ctx.slots.subscribe !== 'function') return;
 ctx.slots.inject('conversation.input.dock', () => ctx.effect(() => {
  let original, release, syncing = false;
  const owned = new Set();
  const sync = () => {
   if (syncing) return;
   const native = ctx.slots.entries('conversation.input.dock').find(entry => entry.options.id === 'queue' && !owned.has(entry.component));
   if (native === original) return;
   syncing = true;
   try {
    release?.(); release = undefined; original = native;
    if (!native?.component || native.children) return;
    const component = makeComponent(native); owned.add(component);
    release = ctx.slots.register({ ...native.options, name: 'conversation.input.dock', priority: (native.options.priority ?? 0) - 10,
     store: native.store, inject: native.inject, locale: native.locale }, component);
   } finally { syncing = false; }
  };
  const unsubscribe = ctx.slots.subscribe('conversation.input.dock', sync);
  sync();
  return () => { unsubscribe(); release?.(); };
 }));
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
