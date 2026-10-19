import test from 'node:test';
import { symbols } from '@deepseek-ai/cordis';
import assert from 'node:assert/strict';
import { createSessionMaintenance } from '../src/session-maintenance.mjs';
function world() {
 const calls = []; let loaded = true;
 const session = {header:{origin:'user'}};
 const metadata={label:'agentLoop.scope(session-example)'};
 const dispose=async()=>{calls.push('dispose');loaded=false;};dispose[symbols.effect]=metadata;
 const agent = {id:'session-example',session,status:'idle',inbox:{nextTurn:[],nextStep:[]},ctx:{fiber:{parent:{fiber:{getEffects:()=>[metadata],_disposables:[dispose]}}}}};
 const sessions = {get:()=>loaded?session:undefined,flush:async()=>calls.push('flush')};
 const persistence = {open:async()=>{calls.push('claim');return{close:async()=>calls.push('close')};},acquireLease:async(id,cwd,dir)=>{calls.push(`lock:${dir}`);return{release:async()=>calls.push(`unlock:${dir}`)};}};
 const services = {sessions,sessionPersistence:persistence,agents:{get:()=>agent,roots:()=>[agent],isOwnedBy:(id,owner)=>owner===undefined}};
 const ctx={get:key=>services[key],waterfall:async()=>[],fiber:{}};
 return {calls,agent,sessions,persistence,ctx,run:(job)=>createSessionMaintenance(ctx)('session-example',job)};
}
test('loaded root agent drains and releases before a scoped write claim; target lock survives operation',async()=>{
 const w=world();await w.run(async lease=>{await lease.protectDirectory('/target');await lease.protectDirectory('/target');w.calls.push('move');});
 assert.deepEqual(w.calls,['flush','dispose','claim','lock:/target','move','unlock:/target','close']);
});
test('running or queued sessions are never disposed or moved',async()=>{
 for(const change of [a=>a.status='running',a=>a.inbox.nextTurn.push({}),a=>a.inbox.nextStep.push({})]){
 const w=world();change(w.agent);await assert.rejects(w.run(()=>assert.fail('moved')),/运行|排队/);assert.deepEqual(w.calls,[]);
 }
});
test('a prompt admitted while flushing prevents disposal',async()=>{
 const w=world();w.sessions.flush=async()=>{w.agent.status='running';};await assert.rejects(w.run(()=>assert.fail('moved')),/运行/);assert.deepEqual(w.calls,[]);
});
test('operation failure releases both locks and preserves the original error',async()=>{
 const w=world(),error=new Error('disk full');await assert.rejects(w.run(async lease=>{await lease.protectDirectory('/target');throw error;}),e=>e===error);assert.deepEqual(w.calls.slice(-2),['unlock:/target','close']);
});
test('host without directory leases keeps the offline fallback',()=>{
 const w=world();delete w.persistence.acquireLease;assert.equal(createSessionMaintenance(w.ctx),undefined);
});


test('unknown host lifecycle layouts fail before flushing or changing the agent',async()=>{
 const w=world();delete w.agent.ctx.fiber.parent.fiber._disposables;
 await assert.rejects(w.run(()=>assert.fail('moved')),/独立释放能力/);assert.deepEqual(w.calls,[]);
});

test('retired-only crash recovery locks its artifact and releases it on failure',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const retired=await mkdtemp(join(tmpdir(),'sk-maintenance-'));t.after(()=>rm(retired,{recursive:true,force:true}));
 const w=world();w.sessions.get=()=>undefined;w.persistence.open=async()=>{throw Object.assign(new Error('missing'),{name:'SessionPersistenceNotFoundError'});};
 const error=new Error('recovery failed');await assert.rejects(createSessionMaintenance(w.ctx)('session-example',async()=>{throw error;},{retired}),e=>e===error);
 assert.deepEqual(w.calls,[`lock:${retired}`,`unlock:${retired}`]);
});

test('missing log without an existing recovery artifact cannot bypass writer ownership',async()=>{
 const w=world();w.sessions.get=()=>undefined;w.persistence.open=async()=>{throw Object.assign(new Error('missing'),{name:'SessionPersistenceNotFoundError'});};
 await assert.rejects(createSessionMaintenance(w.ctx)('session-example',()=>assert.fail('moved'),{retired:'/nonexistent-toolbox-fixture'}),/missing/);assert.deepEqual(w.calls,[]);
});
