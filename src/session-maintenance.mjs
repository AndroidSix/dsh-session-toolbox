import { stat } from 'node:fs/promises';
import { symbols } from '@deepseek-ai/cordis';
/** DSH 0.2 compatibility seam: borrow one labeled lifecycle disposer, never edit registries.
 * Cordis exposes effect metadata publicly but not its matching disposer lookup.
 * Probe the exact metadata identity and refuse unknown layouts before any teardown.
 */
export function sessionDisposer(agent) {
 const owner = agent?.ctx?.fiber?.parent?.fiber;
 const label = `agentLoop.scope(${agent?.id})`;
 const metadata = owner?.getEffects?.().filter(effect => effect.label === label);
 if (metadata?.length !== 1 || typeof owner?._disposables?.[Symbol.iterator] !== 'function') return undefined;
 const matches = [...owner._disposables].filter(dispose => typeof dispose === 'function' && dispose[symbols.effect] === metadata[0]);
 return matches.length === 1 ? matches[0] : undefined;
}
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function createSessionMaintenance(ctx) {
	const persistence = ctx.get('sessionPersistence');
	if (typeof persistence?.open !== 'function' || typeof persistence?.acquireLease !== 'function') return undefined;
	return async (sessionId, operation, recovery) => {
		const sessions = ctx.get('sessions');
		const active = async () => {
			const activities = await ctx.waterfall?.('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
			if (Array.isArray(activities) && activities.length) fail('session-busy', '会话仍有运行中的任务，请等待完成后再迁移');
		};
		await active();
		const session = sessions?.get?.(sessionId);
		if (session) {
			const agent = ctx.get('agents')?.get?.(sessionId);
			const dispose = sessionDisposer(agent);
			const assertIdle = () => {
				if (!agent || agent.session !== session || typeof dispose !== 'function') fail('session-loaded', '当前宿主未提供该会话的独立释放能力，暂时无法在线迁移');
				const roots = ctx.get('agents')?.roots?.();
				if (session.header.origin === 'subagent' || roots && !roots.includes(agent)) fail('session-owned', '子会话请在所属任务结束后再迁移');
				if (agent.status !== 'idle') fail('session-busy', '会话刚刚开始运行，请等待完成后再迁移');
				if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) fail('session-queued', '会话还有排队消息，请先发送或移除排队消息再迁移');
			};
			assertIdle();
			await sessions.flush(session);
			await active();
			assertIdle();
			if (sessions.get(sessionId) !== session) fail('session-changed', '会话实例已改变，请重试迁移');
			// The complete host lifecycle drains the driver and closes the write handle
			// before removing the agent/session. Disposing the scope fiber alone cannot do this.
			await dispose();
			if (sessions.get(sessionId) !== undefined) fail('session-loaded', '会话尚未完成释放，请稍后重试');
		}
		// A normal write handle reserves the id against concurrent native resumes.
		// Do not append/flush through it: its header still names the source placement.
		let handle;
  try { handle = await persistence.open(sessionId, 'write'); }
  catch (error) {
   if (!recovery?.retired || error.name !== 'SessionPersistenceNotFoundError' || !await stat(recovery.retired).then(() => true, () => false)) throw error;
  }
  const guards = new Map();
		let result, failure;
		try {
			if (recovery?.retired && await stat(recovery.retired).then(() => true, () => false)) guards.set(recovery.retired, await persistence.acquireLease(sessionId, undefined, recovery.retired));
			if (sessions?.get?.(sessionId)) fail('session-loaded', '会话被其他操作重新打开，请重试迁移');
			result = await operation({
				protectDirectory: async path => {
					if (!guards.has(path)) guards.set(path, await persistence.acquireLease(sessionId, undefined, path));
				},
			});
		} catch (error) { failure = error; }
		const releases = await Promise.allSettled([...guards.values()].map(guard => guard.release()));
		try { await handle?.close(); } catch (error) { releases.push({ status: 'rejected', reason: error }); }
		const errors = releases.filter(row => row.status === 'rejected').map(row => row.reason);
		if (failure && !errors.length) throw failure;
		if (failure) errors.unshift(failure);
		if (errors.length) throw new AggregateError(errors, '会话迁移或写锁释放失败，请保留迁移日志后重试');
		return result;
	};
}
