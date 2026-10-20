import test from 'node:test';import assert from 'node:assert/strict';
const module=()=>import('../src/reply.mjs');
test('the final quote still renders when native sending trims its trailing blank lines', async () => {
 const { quoteText, replyTextRule } = await module();
 const first = { role: 'user', text: '第一条' }, last = { role: 'assistant', text: '最后一条\n第二行' };
 const wire = ('问题 ' + quoteText(first) + ' ' + quoteText(last)).trim();
 const rule = replyTextRule(), a = rule.match(wire, 0, { read: () => false }), b = rule.match(wire, a.end, { read: () => false });
 assert.ok(b, 'the quote at end of the trimmed native message must not become raw Markdown');
 assert.deepEqual(b.data, last); assert.equal(b.end, wire.length);
});
test('sent quote rendering recognizes the exact original wire format, leaving the rest of the prompt unchanged', async () => {
 const { sentReply, replyTextRule, quoteText } = await module();
 const quote = { role: 'assistant', text: '第一行\n\n> 嵌套引用\n最后一行' }, prefix = quoteText(quote), prompt = prefix + 'MY QUESTION @file';
 assert.deepEqual(sentReply(prompt), { ...quote, end: prefix.length });
 const node = replyTextRule().match(prompt, 0, { read: () => false });
 assert.equal(node.end, prefix.length); assert.deepEqual(node.data, quote); assert.equal(prompt.slice(node.end), 'MY QUESTION @file');
 assert.equal(replyTextRule().match(prompt, 1, { read: () => false }), undefined);
 assert.equal(replyTextRule().match(prompt, 0, { read: () => true }), undefined, 'native quote body can still apply secret/reference rules without recursively quoting itself');
 assert.equal(sentReply('> Assistant\nordinary text\n\nquestion'), null); assert.equal(sentReply('ordinary\n\ntext'), null);
 const inline = 'before ' + prefix + 'after', embedded = replyTextRule().match(inline, 0, { read: () => false });
 assert.equal(embedded.start, 7); assert.equal(inline.slice(embedded.end), 'after'); assert.deepEqual(embedded.data, quote);
});
test('native quote insertion follows the saved caret, rejects stale positions, and maps existing reference chips safely', async () => {
 const { insertReply, quoteText, REPLY_SOURCE } = await module();
 const quote = { role: 'assistant', text: 'new quote' }, calls = [];
 let snapshot = { phase: 'plain', draft: '前😀后', draftRev: 12, occurrences: [], attachmentIds: ['image'] };
 const input = { state: { getSnapshot: () => snapshot }, insertReference: (ref,span) => { calls.push({ ref, span }); return true; }, persistCurrentDraft: () => calls.push('persist'), focus: () => calls.push('focus') };
 insertReply(input, quote, '引用', { start: 3, end: 3, draftRev: 12 });
 assert.equal(calls[0].span.start, 3); assert.equal(calls[0].span.end, 3); assert.equal(calls[0].ref.clipboardText, quoteText(quote)); assert.deepEqual(calls.slice(-2), ['persist','focus']);
 calls.length=0; insertReply(input, quote, '引用', { start: 0, end: 0, draftRev: 11 }); assert.equal(calls[0].span.start, 4, 'stale caret appends without overwriting newer text');
 const old = quoteText({ role: 'user', text: 'old' });
 snapshot = { ...snapshot, draft: 'fileA'+old+'右fileB', draftRev: 20, occurrences: [
  { source:'file',offset:0,length:5,clipboardText:'fileA' },
  { source:REPLY_SOURCE,offset:5,length:old.length,clipboardText:old },
  { source:'file',offset:old.length+6,length:5,clipboardText:'fileB' },
 ] };
 calls.length=0; insertReply(input, quote, '引用', { start: 3, end: 3, draftRev: 20 });
 assert.equal(calls[0].span.start, 3); assert.equal(calls[0].span.draftRev, 20);
 assert.equal(snapshot.draft,'fileA'+old+'右fileB'); assert.deepEqual(snapshot.attachmentIds,['image']);
 assert.equal(snapshot.occurrences.length,3,'existing quote and file references must not be removed');
});
test('reply drafts accumulate quotes while preserving typed text, other references and the original snapshot',async()=>{
 const {withReply,withoutReply,readReply,REPLY_SOURCE}=await module();
 const snapshot={draft:'文件 draft',phase:'plain',attachmentIds:['image-1'],occurrences:[{source:'file',ref:'@file',offset:0,length:2,label:'文件',clipboardText:'文件'}]};
 const first=withReply(snapshot,{role:'user',text:'一行\n第二行'},'引用');
 assert.equal(first.references.length,2);assert.equal(first.references[1].source,'file');assert.equal(first.text.slice(first.references[1].offset),'文件 draft');
 const second=withReply({draft:first.text,occurrences:first.references,phase:'plain'},{role:'assistant',text:'答复'},'引用',first.text.length);
 assert.equal(second.references.filter(r=>r.source===REPLY_SOURCE).length,2);assert.equal(readReply(second.references.at(-1).ref).text,'答复');
 const cleared=withoutReply({draft:second.text,occurrences:second.references,phase:'plain'});
 assert.equal(cleared.text,snapshot.draft);assert.deepEqual(cleared.references,snapshot.occurrences);assert.deepEqual(snapshot.attachmentIds,['image-1']);
});
test('cancelling one quote keeps identical quotes, text and file references across shifted offsets',async()=>{
 const {withReply,withoutReply,REPLY_SOURCE}=await module();
 const original={draft:'文件 原稿',phase:'plain',occurrences:[{source:'file',ref:'file',offset:0,length:2,label:'文件',clipboardText:'文件'}]};
 const a=withReply(original,{role:'user',text:'same'},'引用',2);
 const b=withReply({phase:'plain',draft:a.text,occurrences:a.references},{role:'user',text:'same'},'引用',a.text.length);
 const snapshot={draft:b.text,occurrences:b.references.map((row,index)=>({...row,occurrenceId:index+10}))};
 const quotes=snapshot.occurrences.filter(row=>row.source===REPLY_SOURCE),target=quotes[1];
 const removed=withoutReply(snapshot,target);assert.equal(removed.references.filter(row=>row.source===REPLY_SOURCE).length,1);
 assert.equal(removed.text,a.text);assert.equal(removed.references[0].source,'file');
 // IDs remain authoritative after another chip changes this quote's offset.
 const shifted={draft:'prefix '+snapshot.draft,occurrences:snapshot.occurrences.map(row=>({...row,offset:row.offset+7}))};
 assert.equal(withoutReply(shifted,target).text,'prefix '+a.text);
 const gone=withoutReply(shifted,{...target,occurrenceId:999});assert.equal(gone.text,shifted.draft);assert.equal(gone.references.length,3);
 const corrupt={...snapshot,draft:'broken'+snapshot.draft.slice(6)};assert.throws(()=>withoutReply(corrupt,quotes[0]),/no longer matches/);
});
test('multiple quoted messages survive serialization and render as separate cards around draft text',async()=>{
 const {withReply,replySource,replyTextRule,REPLY_SOURCE}=await module();
 const a=withReply({draft:'前后',phase:'plain'},{role:'user',text:'第一条'},'引用',1);
 const b=withReply({draft:a.text,occurrences:a.references,phase:'plain'},{role:'assistant',text:'第二条\n换行'},'引用',a.text.length);
 const restored=JSON.parse(JSON.stringify(b)),quotes=restored.references.filter(row=>row.source===REPLY_SOURCE);
 for(const row of quotes)assert.equal(await replySource().codec.serialize(row.ref),row.clipboardText);
 const rule=replyTextRule(),first=rule.match(restored.text,0,{read:()=>false}),second=rule.match(restored.text,first.end,{read:()=>false});
 assert.equal(restored.text.slice(0,first.start),'前');assert.equal(restored.text.slice(first.end,second.start),'后');
 assert.equal(first.data.text,'第一条');assert.equal(second.data.text,'第二条\n换行');assert.equal(rule.match(restored.text,second.end,{read:()=>false}),undefined);
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

test('selection quote keeps exact text and role, and refuses cross-chat, cross-message and editable selections',async()=>{
 const {selectedReply}=await module();
 const surface={contains:node=>node!==outside,getAttribute:()=> 'session-selection'};
 const flow={getAttribute:()=> 'assistant-step'};
 const element=(editable=false,parentFlow=flow)=>({nodeType:1,closest:selector=>selector.startsWith('input')?(editable?{}:null):selector==='[data-conversation-session]'?surface:parentFlow});
 const start=element(),end=element(),outside=element();
 const selection={isCollapsed:false,rangeCount:1,toString:()=> '  所选的一段\n代码  ',getRangeAt:()=>({startContainer:{parentElement:start},endContainer:end})};
 const quote=selectedReply(selection);assert.equal(quote.text,'  所选的一段\n代码  ');assert.equal(quote.role,'assistant');assert.equal(quote.sessionId,'session-selection');
 flow.getAttribute=()=> 'user';assert.equal(selectedReply(selection).role,'user');
 selection.getRangeAt=()=>({startContainer:start,endContainer:outside});assert.equal(selectedReply(selection),null);
 selection.getRangeAt=()=>({startContainer:start,endContainer:element(false,{})});assert.equal(selectedReply(selection),null);
 selection.getRangeAt=()=>({startContainer:element(true),endContainer:end});assert.equal(selectedReply(selection),null);
 selection.isCollapsed=true;assert.equal(selectedReply(selection),null);
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
