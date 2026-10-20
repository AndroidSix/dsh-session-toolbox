import { randomUUID } from 'node:crypto';

const PREFIX = 'dsh-session-toolbox-delete:';
const marker = event => event.type === 'user/message' && event.data?.id?.startsWith(PREFIX) && event.data.content?.length === 1 && event.data.content[0]?.text === '[Message deleted]' && event.surfaceOp?.op === 'replace' && event.surfaceOp.startSeq === event.surfaceOp.endSeq && event.sourceEventSeqs?.length === 1 && event.sourceEventSeqs[0] === event.surfaceOp.startSeq;
const fail = message => { throw new Error(message); };

/** Native positional replacements remove original content from deriveMessages(),
 * without rewriting a live log or breaking tool-call/result pairings. User-role
 * replacements are legal between turns; a neutral nonempty marker keeps provider
 * history valid without resending any original text, images or replay state. */
export class MessageTools {
 constructor({ sessions, busy, idle = () => true }) { this.sessions = sessions; this.busy = busy; this.idle = idle; }
 session(id) {
  const value = this.sessions()?.get?.(id);
  if (!value?.snapshotEvents || !value.surface?.nodes || typeof value.append !== 'function' || typeof value.deriveMessages !== 'function' || typeof this.sessions()?.flush !== 'function') fail('请先打开此会话；当前宿主需要支持原生上下文替换');
  return value;
 }
 list(sessionId) {
  const session = this.sessions()?.get?.(sessionId);
  return { seqs: session?.snapshotEvents?.().filter(marker).map(event => event.sourceEventSeqs[0]) ?? [] };
 }
 async delete(sessionId, seq) {
  if (typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(seq) || seq < 0) fail('无效的历史消息');
  const session = this.session(sessionId);
  if (await this.busy(sessionId)) fail('会话仍在运行或有排队消息，请等待任务结束后再删除');
  if (this.sessions()?.get?.(sessionId) !== session) fail('会话已重新加载，请重试');
  if (!this.idle(sessionId)) fail('会话刚刚开始运行，请等待任务结束后再删除');
  const events = session.snapshotEvents();
  const existing = events.find(event => marker(event) && event.sourceEventSeqs[0] === seq);
  const original = events.find(event => event.seq === seq);
  if (!original || !['user/message', 'assistant/message'].includes(original.type) || original.surfaceOp !== 'append') fail('仅支持删除用户消息或已完成的助手消息');
  const message = original.type === 'user/message' ? original.data : original.data.message;
  if (original.type === 'user/message' && message.source?.kind !== 'user') fail('不能删除宿主注入的上下文消息');
  if (message.content.some(block => block.type === 'tool-call')) fail('这条助手消息含有工具调用，不能单独删除；工具调用和结果必须保持配对');
  if (!existing) {
   if (!session.surface.nodes.includes(seq)) fail('这条消息已被合并进摘要或替换，无法保证从摘要中单独移除；请从新会话继续');
   session.append('user/message', { id: PREFIX + randomUUID(), role: 'user', content: [{ type: 'text', text: '[Message deleted]' }], source: { kind: 'user' } }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
  }
  // Flush retries are idempotent, including a failure after the append committed.
  if (await this.sessions().flush(session) === false) fail('宿主未提供持久化监听，删除尚未确认，请重试');
  if (session.surface.nodes.includes(seq) || session.deriveMessages().some(value => value.id === message.id)) fail('宿主尚未移除这条消息的模型上下文，请重试');
  return { ...this.list(sessionId), removedFromContext: true };
 }
}
