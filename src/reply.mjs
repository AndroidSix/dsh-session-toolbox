export const REPLY_SOURCE = 'dsh-session-toolbox.reply';
export function readReply(ref) {
 const value = JSON.parse(ref);
 if (value?.version !== 1 || !['user', 'assistant'].includes(value.role) || typeof value.text !== 'string' || !value.text.trim()) throw new Error('Invalid message quote');
 return { role: value.role, text: value.text };
}
export function quoteText(quote) {
 return `> ${quote.role === 'assistant' ? 'Assistant' : 'User'}\n${quote.text.replace(/\r\n?/g, '\n').split('\n').map(line => '> ' + line).join('\n')}\n\n`;
}
export function replySource() {
 return { name: REPLY_SOURCE, trigger: '@', showGroupTitle: false, candidates: async () => [],
  codec: { clipboardText: ref => quoteText(readReply(ref)), serialize: async ref => quoteText(readReply(ref)) } };
}
const referenceFields = ({ source, ref, offset, length, label, clipboardText, appearance, invalid }) => ({ source, ref, offset, length, label, clipboardText, ...(appearance === undefined ? {} : { appearance }), ...(invalid === undefined ? {} : { invalid }) });
export function withoutReply(snapshot) {
 let text = snapshot.draft ?? '', references = (snapshot.occurrences ?? []).map(referenceFields);
 for (const quote of references.filter(row => row.source === REPLY_SOURCE).sort((a,b) => b.offset-a.offset)) {
  const end = quote.offset + quote.length;
  // Never delete user text if a future host no longer publishes matching spans.
  if (text.slice(quote.offset, end) !== quote.clipboardText) throw new Error('Message quote no longer matches the draft');
  text = text.slice(0, quote.offset) + text.slice(end);
  references = references.filter(row => row !== quote).map(row => row.offset >= end ? { ...row, offset: row.offset - quote.length } : row);
 }
 return { text, references };
}
export function withReply(snapshot, quote, label) {
 if (snapshot.phase !== 'plain') throw new Error('请等待输入框就绪后再引用 / Wait until the composer is ready');
 const ref = JSON.stringify({ version: 1, ...quote });
 const content = quoteText(readReply(ref)), draft = withoutReply(snapshot);
 return { text: content + draft.text, references: [{ source: REPLY_SOURCE, ref, offset: 0, length: content.length, label, appearance: 'session', clipboardText: content }, ...draft.references.map(row => ({ ...row, offset: row.offset + content.length }))] };
}
export function messageReply(node) {
 if (['user', 'steering'].includes(node?.kind)) {
  const content = node.data?.content;
  const text = typeof content === 'string' ? content : (Array.isArray(content) ? content : []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  return text.trim() ? { role: 'user', text } : null;
 }
 const blocks = node?.data?.closing?.blocks ?? [];
 const text = blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n');
 return text.trim() ? { role: 'assistant', text } : null;
}

/** Decorate the public keyed user/turn-tail seats; mirror only their declared
 * child slots so feedback and native message actions keep their original owners. */
export function installReplyNodes(ctx, makeComponent) {
 if (typeof ctx.slots.entries !== 'function' || typeof ctx.slots.subscribe !== 'function') return;
 const name = 'conversation.chat.node';
 ctx.slots.inject(name, () => ctx.effect(() => {
  const owned = new Set(), copies = new Map(); let syncing = false;
  const sync = () => {
   if (syncing) return;
   syncing = true;
   try {
    const entries = ctx.slots.entries(name).filter(entry => ['user', 'steering', 'turn-tail'].includes(entry.options.key) && !owned.has(entry.component));
    for (const [entry, release] of copies) if (!entries.includes(entry)) { release(); copies.delete(entry); }
    for (const native of entries) {
     if (copies.has(native)) continue;
     const releases = [], mirrors = new Map();
     try {
      for (const [child, spec] of Object.entries(native.children ?? {})) {
       const mirror = `session-toolbox.reply.${child}`; mirrors.set(child, mirror);
       if (spec.scope !== 'session' || spec.kind !== 'list') throw new Error(`Unsupported reply child slot: ${child}`);
      }
      const component = makeComponent(native, mirrors); owned.add(component);
      releases.push(ctx.slots.register({ ...native.options, name, priority: (native.options.priority ?? 0) - 10, store: native.store, inject: native.inject, locale: native.locale,
       ...(mirrors.size ? { children: Object.fromEntries([...mirrors].map(([child, mirror]) => [mirror, native.children[child]])) } : {}),
      }, component));
      for (const [child, mirror] of mirrors) {
       const mirrored = new Map();
       const update = () => {
        const children = ctx.slots.entries(child);
        for (const [entry, release] of mirrored) if (!children.includes(entry)) { release(); mirrored.delete(entry); }
        for (const entry of children) if (!mirrored.has(entry) && !entry.children) mirrored.set(entry, ctx.slots.register({ ...entry.options, name: mirror, store: entry.store, inject: entry.inject, locale: entry.locale }, entry.component));
       };
       releases.push(() => { for (const release of mirrored.values()) release(); });
       update(); releases.push(ctx.slots.subscribe(child, update));
      }
      copies.set(native, () => { for (const release of releases.reverse()) release?.(); });
     } catch (error) { for (const release of releases.reverse()) release?.(); console.warn('[dsh-session-toolbox] Reply renderer unavailable', error); }
    }
   } finally { syncing = false; }
  };
  const unsubscribe = ctx.slots.subscribe(name, sync); sync();
  return () => { unsubscribe(); for (const release of copies.values()) release(); };
 }));
}
