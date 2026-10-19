import test from 'node:test';import assert from 'node:assert/strict';
const module=()=>import('../src/reply.mjs');
test('reply draft replaces its quote while preserving typed text, other references and the original snapshot',async()=>{
 const {withReply,withoutReply,readReply,REPLY_SOURCE}=await module();
 const snapshot={draft:'文件 draft',phase:'plain',attachmentIds:['image-1'],occurrences:[{source:'file',ref:'@file',offset:0,length:2,label:'文件',clipboardText:'文件'}]};
 const first=withReply(snapshot,{role:'user',text:'一行\n第二行'},'引用');
 assert.equal(first.references.length,2);assert.equal(first.references[1].source,'file');assert.equal(first.text.slice(first.references[1].offset),'文件 draft');
 const second=withReply({draft:first.text,occurrences:first.references,phase:'plain'},{role:'assistant',text:'答复'},'引用');
 assert.equal(second.references.filter(r=>r.source===REPLY_SOURCE).length,1);assert.equal(readReply(second.references[0].ref).text,'答复');
 const cleared=withoutReply({draft:second.text,occurrences:second.references,phase:'plain'});
 assert.equal(cleared.text,snapshot.draft);assert.deepEqual(cleared.references,snapshot.occurrences);assert.deepEqual(snapshot.attachmentIds,['image-1']);
});
test('reply serializer preserves multiline quoted content across rehydration and refuses malformed references',async()=>{
 const {withReply,replySource}=await module();const quote={role:'user',text:'原文\n\n> 嵌套引用 😀'};
 const draft=JSON.parse(JSON.stringify(withReply({draft:'我的问题',phase:'plain',occurrences:[]},quote,'引用')));
 const source=replySource();const text=await source.codec.serialize(draft.references[0].ref);
 assert.match(text,/> 原文\n> \n> > 嵌套引用 😀/);assert.equal(draft.text,text+'我的问题');
 await assert.rejects(async()=>source.codec.serialize('{}'));assert.throws(()=>withReply({phase:'submitting',draft:'old'},quote,'引用'));
});
test('quote text includes visible user/assistant content, excluding reasoning and tool results',async()=>{
 const {messageReply}=await module();assert.deepEqual(messageReply({kind:'user',data:{content:[{type:'text',text:'我的消息'},{type:'image',url:'secret'}]}}),{role:'user',text:'我的消息'});
 assert.equal(messageReply({kind:'turn-tail',data:{closing:{blocks:[{kind:'reasoning',text:'private'},{kind:'text',text:'答复'}]}}}).text,'答复');
});

test('reply decoration follows late message seats and preserves native feedback children and lifecycle',async()=>{
 const {installReplyNodes}=await module();const entries=new Map(),listeners=new Map(),registered=[],effects=[];
 const ctx={effect:fn=>{effects.push(fn());},slots:{inject:(name,fn)=>fn(),entries:name=>entries.get(name)??[],subscribe:(name,fn)=>{listeners.set(name,fn);return()=>listeners.delete(name);},register:(options,component)=>{const record={options,component};registered.push(record);return()=>record.disposed=true;}}};
 installReplyNodes(ctx,(native,mirrors)=>{assert.equal(mirrors.get('conversation.chat.assistant-actions'),'session-toolbox.reply.conversation.chat.assistant-actions');return function Decorated(){};});
 assert.equal(registered.length,0);
 const native={options:{key:'turn-tail'},inject(){},store:{},locale:'native',component(){},children:{'conversation.chat.assistant-actions':{kind:'list',scope:'session'}}};
 const feedback={options:{id:'feedback'},inject(){},component(){}};
 entries.set('conversation.chat.node',[native]);entries.set('conversation.chat.assistant-actions',[feedback]);listeners.get('conversation.chat.node')();
 assert.equal(registered[0].options.inject,native.inject);assert.equal(registered[0].options.store,native.store);assert.equal(registered[1].component,feedback.component);assert.equal(registered[1].options.inject,feedback.inject);
 listeners.get('conversation.chat.node')();assert.equal(registered.length,2);
 effects.forEach(dispose=>dispose?.());assert(registered.every(row=>row.disposed));assert.equal(listeners.size,0);
});
