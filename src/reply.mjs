import { translate } from './locale.mjs';
const defaultText = (key, values) => translate('zh', key, values);

export const REPLY_SOURCE = 'dsh-session-toolbox.reply';
export const REPLY_TEXT_NODE = 'dsh-session-toolbox.quote';
/** Recognize only the exact quote envelope emitted by our serializer. */
export function sentReply(text) {
 if (typeof text !== 'string') return null;
 // Native sending trims the message, including a final quote's blank separator.
 const boundary = text.indexOf('\n\n'), end = boundary < 0 ? text.length : boundary;
 const [header, ...lines] = text.slice(0, end).split('\n');
 if (!['> Assistant', '> User'].includes(header) || !lines.length || lines.some(line => !line.startsWith('> ') && !(boundary < 0 && line === '>'))) return null;
 return { role: header === '> User' ? 'user' : 'assistant', text: lines.map(line => line.slice(2)).join('\n'), end: boundary < 0 ? end : end + 2 };
}
export function replyTextRule() {
 return { id: REPLY_TEXT_NODE, order: -100, match(text, from, context) {
  if (context.read('toolboxQuoteBody')) return;
  const marker = /> (?:Assistant|User)\n> /g; marker.lastIndex = from;
  for (let match; (match = marker.exec(text));) {
   const quote = sentReply(text.slice(match.index)); if (!quote) continue;
   return { id: REPLY_TEXT_NODE, start: match.index, end: match.index + quote.end, data: { role: quote.role, text: quote.text } };
  }
 } };
}
/** Capture the selection before a context menu takes focus; never mix chats or editable text. */
export function selectedReply(selection) {
 if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
 const element = node => node?.nodeType === 1 ? node : node?.parentElement;
 const range = selection.getRangeAt(0), start = element(range.startContainer), end = element(range.endContainer);
 if (start?.closest('input,textarea,[contenteditable="true"]') || end?.closest('input,textarea,[contenteditable="true"]')) return null;
 const surface = start?.closest('[data-conversation-session]'), flow = start?.closest('[data-chat-flow-kind]');
 if (!surface || !flow || !surface.contains(end) || end?.closest('[data-chat-flow-kind]') !== flow) return null;
 const kind = flow.getAttribute('data-chat-flow-kind');
 if (!['user', 'steering', 'assistant-step', 'assistant', 'assistant-message', 'turn-process', 'turn-tail', 'text'].includes(kind)) return null;
 const text = selection.toString(); if (!text.trim()) return null;
 return { surface, sessionId: surface.getAttribute('data-conversation-session'), role: ['user', 'steering'].includes(kind) ? 'user' : 'assistant', text };
}
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
export function withoutReply(snapshot, occurrence, t = defaultText) {
 let text = snapshot.draft ?? '';
 const removed = (snapshot.occurrences ?? []).filter(row => row.source === REPLY_SOURCE && (!occurrence || (occurrence.occurrenceId !== undefined ? row.occurrenceId === occurrence.occurrenceId : row.offset === occurrence.offset && row.ref === occurrence.ref)));
 let references = (snapshot.occurrences ?? []).map(referenceFields);
 for (const quote of removed.sort((a,b) => b.offset-a.offset)) {
  const end = quote.offset + quote.length;
  // Never delete user text if a future host no longer publishes matching spans.
  if (text.slice(quote.offset, end) !== quote.clipboardText) throw new Error(t('reply.mismatch'));
  text = text.slice(0, quote.offset) + text.slice(end);
  references = references.filter(row => row.offset !== quote.offset || row.source !== REPLY_SOURCE).map(row => row.offset >= end ? { ...row, offset: row.offset - quote.length } : row);
 }
 return { text, references };
}
export function withReply(snapshot, quote, label, offset = 0, t = defaultText) {
 if (snapshot.phase !== 'plain') throw new Error(t('input.notReady'));
 const ref = JSON.stringify({ version: 1, ...quote });
 const content = quoteText(readReply(ref)), draft = { text: snapshot.draft ?? '', references: (snapshot.occurrences ?? []).map(referenceFields) };
 const at = Math.max(0, Math.min(offset, draft.text.length));
 return { text: draft.text.slice(0, at) + content + draft.text.slice(at), references: [{ source: REPLY_SOURCE, ref, offset: at, length: content.length, label, appearance: 'session', clipboardText: content }, ...draft.references.map(row => ({ ...row, offset: row.offset >= at ? row.offset + content.length : row.offset }))].sort((a,b) => a.offset-b.offset) };
}
/** Insert through the native chip API so its caret follows the insertion, not the draft end.
 * Native detect coordinates count every reference chip as one character. */
export function insertReply(input, quote, label, savedSpan, t = defaultText) {
 const snapshot = input.state.getSnapshot();
 if (snapshot.phase !== 'plain') throw new Error(t('input.notReady'));
 if (typeof input.insertReference !== 'function') {
  input.setDraft(withReply(snapshot, quote, label, (snapshot.draft ?? '').length, t));
 } else {
  const occurrences = [...(snapshot.occurrences ?? [])].sort((a,b) => a.offset-b.offset);
  const end = (snapshot.draft ?? '').length - occurrences.reduce((sum,row) => sum + row.length - 1, 0);
  const at = savedSpan?.draftRev === snapshot.draftRev ? Math.max(0, Math.min(savedSpan.end, end)) : end;
  const ref = JSON.stringify({ version: 1, ...quote }), clipboardText = quoteText(readReply(ref));
  if (!input.insertReference({ source: REPLY_SOURCE, ref, label, appearance: 'session', clipboardText }, { start: at, end: at, draftRev: input.state.getSnapshot().draftRev })) throw new Error(t('reply.changed'));
 }
 input.persistCurrentDraft?.(); input.focus?.();
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

export function messageSequence(node) {
 const value = ['user', 'steering'].includes(node?.kind) ? node.anchorSeq : node?.kind === 'assistant-step' ? node.data?.finalNode?.seq : node?.kind === 'turn-tail' ? node.data?.closing?.finalNode?.seq : undefined;
 return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
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
    const entries = ctx.slots.entries(name).filter(entry => ['user', 'steering', 'turn-tail', 'assistant-step'].includes(entry.options.key) && !owned.has(entry.component));
    for (const [entry, release] of copies) if (!entries.includes(entry)) { release(); copies.delete(entry); }
    for (const native of entries) {
     if (copies.has(native)) continue;
     const releases = [], mirrors = new Map();
     try {
      for (const [child, spec] of Object.entries(native.children ?? {})) {
       const mirror = `session-toolbox.reply.${child}`; mirrors.set(child, mirror);
       if (spec.scope !== 'session' || !['list', 'single'].includes(spec.kind)) throw new Error(`Unsupported reply child slot: ${child}`);
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
