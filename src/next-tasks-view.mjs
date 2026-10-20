/** Session-scoped presentation state, shared by the composer observer and turn footers. */
export function createCandidateView(storage) {
 const sessions = new Map();
 const key = id => `dsh-session-toolbox:next-hidden:${id}`;
 const state = id => {
  if (!sessions.has(id)) {
   let hidden;
   try { const raw = storage?.getItem(key(id)); if (raw !== null && raw !== undefined) hidden = Number(raw); } catch { /* storage can be disabled */ }
   sessions.set(id, { value: null, hidden, listeners: new Set() });
  }
  return sessions.get(id);
 };
 const notify = row => { for (const listener of row.listeners) listener(row.value); };
 return {
  get: id => state(id).value,
  subscribe(id, listener) { const row = state(id); row.listeners.add(listener); return () => row.listeners.delete(listener); },
  publish(id, value) {
   const row = state(id);
   const next = value?.seq === row.hidden ? null : value;
   if (JSON.stringify(row.value) === JSON.stringify(next)) return;
   row.value = next; notify(row);
  },
  dismiss(id) {
   const row = state(id);
   if (!Number.isSafeInteger(row.value?.seq)) return;
   row.hidden = row.value.seq; row.value = null;
   try { storage?.setItem(key(id), String(row.hidden)); } catch { /* ephemeral fallback */ }
   notify(row);
  },
 };
}

export function candidatesForTurn(result, seq) {
 return result?.status === 'ready' && result.seq === seq && Array.isArray(result.candidates) ? result.candidates : [];
}
