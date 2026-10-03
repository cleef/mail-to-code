import {installSemanticFixture,drainObservations,wire,synthetic} from './semantic-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigSchema} from '../src/config.js';
import {Store} from '../src/store.js';
import {MultiController,manifest} from '../src/multi-controller.js';
import {ProjectRegistry} from '../src/projects.js';
import {validateDecision as validateSemanticDecision,ReplyInterpreter} from '../src/reply-interpreter.js';
import {currentBinding} from '../src/approval.js';
import {migrate} from '../src/migration.js';
import {Runner} from '../src/runner.js';
import {fakeMail} from './fake-mail.js';
import {ProfileSchema} from '../src/profile.js';
import type {Session,Incoming,ReplyDecision,ReplyItem,ReplyContext} from '../src/types.js';
const item=(id:string,action:ReplyItem['action'],evidence:string,text=evidence,dependsOn:string[]=[]):ReplyItem=>({id,action,clear:true,evidence,text,questionRefs:[],dependsOn});
const validateDecision=(raw:any,c:ReplyContext,s:Session)=>validateSemanticDecision(JSON.parse(JSON.stringify(wire(raw),(_k,v)=>v===undefined?null:v)),c,s);
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'mail-conversation-'));
 const config=ConfigSchema.parse({gmailAddress:'a@gmail.com',ownerAddress:'o@qq.com',projectsRoot:root,productDocs:root,dataDir:join(root,'state')}),store=new Store(':memory:');store.migrate(s=>s);store.set('schema_version','6');
 const s:Session={id:'DEV-20261003-999',title:'示例笔记：图片缓存',subject:'[DEV-20261003-999] 图片缓存',repo:'',state:'WAITING_REVIEW',createdAt:'now',initialMessageId:'initial',initialRfcId:'<initial@qq.com>',initialThreadId:'thread',summary:'当前已审阅文档',targets:[],references:[],revision:1,cancellationEpoch:0,workflow:{stageId:'stage-1',number:1,history:[],confirmed:true}};
 s.reviewManifest=manifest(s);const m=store.notify(s,'review','Review 完整清单');s.reviewNotice=m.id;store.save(s);m.status='sent';m.identityStatus='verified';m.rfcMessageId='<review@gmail.test>';store.saveMail(m);
 let decision:ReplyDecision={items:[],questions:[]};const work={interpretReply:async()=>decision};const controller=new MultiController(config,store,fakeMail(config),{} as any,new ProjectRegistry(config,store),work as any);
 installSemanticFixture(work,store);drainObservations(controller,store);
 (controller as any).startBusiness=()=>undefined;
 let n=0;const incoming=(text:string,reply=m.rfcMessageId!):Incoming=>({id:'incoming-'+ ++n,rfcId:`<in-${n}@qq.com>`,threadId:'thread',inReplyTo:reply,subject:s.subject,text,from:'o@qq.com',trusted:true});
 return {root,store,config,controller,m,incoming,set:(d:ReplyDecision)=>{decision=d;},task:()=>store.session(s.id)!,pending:()=>store.jobs().filter(j=>j.kind!=='interpret'&&j.status==='queued'),run:async(text:string,reply?:string)=>{controller.handle(incoming(text,reply));await controller.startNext();},cleanup:async()=>{await controller.stop();store.close();await rm(root,{recursive:true,force:true});}};
}
test('Merge plus future implementation approves current Review once and retains requirements after dependency completes',async()=>{
 const x=await fixture();try{
  x.set({items:[item('merge','approve','先合并PR'),item('next','future','然后开始实现','生成下一阶段实现方案',['merge'])],questions:[]});
  const input=x.incoming('先合并PR，然后开始实现');x.controller.handle(input);x.controller.handle(input);await x.controller.startNext();
  assert.equal(x.pending().length,1);assert.equal(x.pending()[0].kind,'merge');assert.equal(x.task().conversation!.records[1].status,'waiting');
  const j=x.pending()[0];j.status='done';x.store.saveJob(j);const s=x.task();s.state='QUEUED';s.workflow!.stageId='stage-2';s.workflow!.number=2;x.store.save(s);
  x.store.transaction(()=>(x.controller as any).advanceReplies(x.task()));
  assert.equal(x.task().conversation!.requests[0].text,'生成下一阶段实现方案');assert.equal(x.task().conversation!.records[1].status,'done');
  assert.equal(x.store.jobs().some(j=>j.kind==='develop'),false);
  x.store.recover();x.store.transaction(()=>(x.controller as any).advanceReplies(x.task()));assert.equal(x.task().conversation!.requests.length,1);
 }finally{await x.cleanup();}
});
test('Short confirmation confirms all concrete parent questions and leaves choices unanswered',async()=>{
 const x=await fixture();try{
  x.m.questions!.push({id:'future-question',text:'合并后规划缓存实现',kind:'confirm',action:'future',dependsOn:[]},{id:'choose',text:'保留旧文件多久？',kind:'choice',dependsOn:[]});x.store.saveMail(x.m);
  const context:ReplyContext={incoming:x.incoming('确认'),epoch:0,binding:currentBinding(x.task()),parent:{id:x.m.id,text:x.m.text,questions:x.m.questions!}};
  const d=validateDecision({items:[{...item('approve','approve','确认'),project:undefined,questionRefs:[x.m.questions![0].id]},{...item('future','future','确认'),project:undefined,questionRefs:['future-question']}],questions:[{text:'保留旧文件多久？',kind:'choice',dependsOn:[]}]},context,x.task());assert.deepEqual(d.items.map(i=>i.action),['approve','future']);assert.equal(d.questions[0].kind,'choice');
  x.set(d);await x.run('确认');assert.equal(x.pending()[0].kind,'merge');assert.equal(x.task().conversation!.requests.length,1);
  const help=x.store.mails().at(-1)!;assert.equal(help.questions!.length,1);assert.match(help.text,/保留旧文件多久/);assert.ok(!help.text.includes('Review 完整清单'));
 }finally{await x.cleanup();}
});
test('Independent status is handled while unresolved and conflicting actions alone are held',async()=>{
 const x=await fixture();try{
  x.set({items:[item('status','status','看看状态'),{...item('merge','approve','再合并'),clear:false}],questions:[{text:'希望批准哪个版本？',kind:'open',dependsOn:[]}]});await x.run('看看状态，再合并');
  assert.equal(x.task().conversation!.records[0].status,'done');assert.equal(x.task().conversation!.records[1].status,'blocked');assert.equal(x.pending().length,0);
 }finally{await x.cleanup();}
});
test('Current changes block approval, whereas future changes can coexist with approval',async()=>{
 const x=await fixture();try{
  x.set({items:[item('merge','approve','同意合并'),item('edit','feedback','但先修改设计')],questions:[]});await x.run('同意合并，但先修改设计');
  assert.equal(x.pending()[0].kind,'develop');assert.ok(!x.pending().some(j=>j.kind==='merge'));assert.equal(x.task().conversation!.records[0].status,'blocked');
 }finally{await x.cleanup();}
});
test('Four independent feedback items produce one ready plan and keep its approval valid',async()=>{
 const x=await fixture();try{
  const s=x.task();s.state='WAITING_INPUT';s.blockedPhase='plan';s.reviewNotice=undefined;x.store.save(s);
  const texts=['采用交集筛选','只提供单篇标签增删','明确命名去重规则','提供两端编辑草图'];
  x.set({items:texts.map((text,n)=>item(String(n), 'feedback',text)),questions:[]});
  const input=x.incoming(texts.join('\n'));x.controller.handle(input);x.controller.handle(input);await x.controller.startNext();
  assert.equal(x.pending().length,1);const job=x.pending()[0];assert.equal(job.kind,'plan');for(const text of texts)assert.ok(job.feedback.includes(text));
  assert.equal(x.store.mails().filter(m=>m.kind==='help').length,0);
  assert.ok(x.task().conversation!.records.every(r=>r.status==='queued'&&r.jobIds?.[0]===job.id));
  let analyses=0;
  const p={alias:'app',identity:'synthetic-app',path:join(x.root,'app'),relativePath:'app',github:'example-org/app',baseBranch:'main',profile:ProfileSchema.parse({}),profileSource:'proposal',version:'profile',baselineSha:'base',snapshotPath:join(x.root,'snapshot'),ready:true,manualMerge:false};
  Object.assign(x.controller.multiWork,{
   analyze:async(_s:Session,text:string)=>{analyses++;for(const expected of texts)assert.ok(text.includes(expected));return {outcome:'plan_ready',summary:'统一方案',questions:[],projects:[{path:'app',displayName:'App',role:'modify',pendingChecks:[]}],mergeOrder:['app'],workflow:{decision:'propose_step',kind:'maintenance',name:'修改',rationale:'反馈已合并',deliverables:['修改'],acceptance:['检查']}};},
   prepareProject:async()=>p,validate:async()=>{},verifyPlan:async()=>{}
  });
  job.status='running';x.store.saveJob(job);await (x.controller as any).executeMulti(job,new AbortController().signal);await x.controller.startNext();
  assert.equal(analyses,2); // Initial and pinned-baseline analysis within one job.
  assert.equal(x.task().state,'WAITING_START');assert.equal(x.store.mails().filter(m=>m.kind==='plan').length,1);
  const notice=x.task().planNotice;while(x.store.mails().some(m=>m.status==='pending'))await x.controller.flush();
  for(let n=0;n<4;n++)x.store.transaction(()=>(x.controller as any).advanceReplies(x.task()));
  assert.equal(x.store.jobs().filter(j=>j.kind==='plan').length,1);assert.ok(x.task().conversation!.records.every(r=>r.status==='done'));assert.equal(x.task().planNotice,notice);
  x.set({items:[item('start','start','START')],questions:[]});await x.run('START',notice);assert.equal(x.pending().filter(j=>j.kind==='develop').length,1);
 }finally{await x.cleanup();}
});
test('A shared feedback job survives restart and all its items fail together without replay',async()=>{
 const x=await fixture();try{
  x.set({items:[item('a','feedback','调整标题'),item('b','feedback','调整布局')],questions:[]});await x.run('调整标题，调整布局');
  const job=x.pending()[0];job.status='running';x.store.saveJob(job);x.store.recover();
  x.store.transaction(()=>(x.controller as any).advanceReplies(x.task()));
  assert.equal(x.task().state,'FAILED');assert.ok(x.task().conversation!.records.every(r=>r.status==='blocked'));assert.equal(x.pending().length,0);assert.equal(x.store.jobs().filter(j=>j.kind==='develop').length,1);
  await x.run('START');assert.equal(x.pending().length,0);
 }finally{await x.cleanup();}
});
test('Feedback batching preserves unmet dependencies, blocked items and separate source emails',async()=>{
 const x=await fixture();try{
  x.set({items:[item('a','feedback','调整标题'),item('b','feedback','随后改布局','随后改布局',['a']),{...item('c','feedback','尚未明确'),clear:false}],questions:[{text:'请说明第三个修改',kind:'open',dependsOn:[]}]});await x.run('调整标题，随后改布局，尚未明确');
  assert.equal(x.pending().length,1);assert.deepEqual(x.task().conversation!.records.map(r=>r.status),['queued','waiting','blocked']);
  assert.equal(x.store.mails().filter(m=>m.kind==='help').length,1);
  const first=x.pending()[0];first.status='done';x.store.saveJob(first);x.store.transaction(()=>(x.controller as any).advanceReplies(x.task()));
  assert.equal(x.pending().length,1);assert.equal(x.pending()[0].feedback,'随后改布局');assert.equal(x.task().conversation!.records[2].status,'blocked');
  x.set({items:[item('d','feedback','另一封邮件修改')],questions:[]});await x.run('另一封邮件修改');
  assert.equal(x.task().conversation!.records[3].status,'waiting');const second=x.pending()[0];second.status='done';x.store.saveJob(second);x.store.transaction(()=>(x.controller as any).advanceReplies(x.task()));
  assert.equal(x.pending().length,1);assert.equal(x.pending()[0].feedback,'另一封邮件修改');
 }finally{await x.cleanup();}
});
test('Project declarations stay model data without changing controller scope by keyword',async()=>{
 const x=await fixture();try{
  x.set({items:[item('a','feedback','PROJECTS: one'),item('b','feedback','PROJECTS: two')],questions:[]});await x.run('PROJECTS: one\nPROJECTS: two');
  assert.equal(x.task().projectHints,undefined);assert.equal(x.pending().length,1);assert.ok(x.pending()[0].feedback.includes('PROJECTS: one'));assert.ok(x.pending()[0].feedback.includes('PROJECTS: two'));
 }finally{await x.cleanup();}
});
test('Bare reply to legacy mail requests a fresh concrete confirmation; stale structured replies cannot approve',async()=>{
 const x=await fixture();try{
  const context:ReplyContext={incoming:x.incoming('确认'),epoch:0,binding:currentBinding(x.task())};
  const d=validateDecision({items:[],questions:[{text:'确认合并当前具体 Review？',kind:'confirm',action:'APPROVE',dependsOn:[]}]},context,x.task());assert.equal(d.items.length,0);assert.equal(d.questions[0].kind,'confirm');x.set(d);await x.run('确认');assert.equal(x.pending().length,0);
  const help=x.store.mails().at(-1)!;help.status='sent';help.identityStatus='verified';help.rfcMessageId='<fresh-help@gmail.test>';x.store.saveMail(help);
  const stale=x.task();stale.reviewManifest='changed';x.store.save(stale);
  const approved=validateDecision({items:[{...item('approve','approve','确认'),project:undefined,questionRefs:[help.questions![0].id]}],questions:[]},{...context,parent:{id:help.id,text:help.text,questions:help.questions!}},x.task());x.set(approved);await x.run('确认',help.rfcMessageId);assert.equal(x.pending().length,0);assert.equal(x.task().state,'WAITING_REVIEW');
 }finally{await x.cleanup();}
});
test('Failed dependency and cancellation prevent deferred requests and repeated effects',async()=>{
 const x=await fixture();try{
  x.set({items:[item('merge','approve','合并'),item('next','future','再实现','实现',['merge'])],questions:[]});await x.run('合并，再实现');
  const j=x.pending()[0];j.status='failed';x.store.saveJob(j);x.store.transaction(()=>(x.controller as any).advanceReplies(x.task()));
  assert.equal(x.task().conversation!.records[1].status,'blocked');assert.equal(x.task().conversation!.requests.length,0);
 }finally{await x.cleanup();}
});
test('Schema blocks forged references, cycles, unknown projects and quotation-only evidence',async()=>{
 const x=await fixture();try{
  const c:ReplyContext={incoming:x.incoming('修改标题'),epoch:0};const raw=(i:ReplyItem)=>({items:[{...i,project:i.project||null}],questions:[]});
  assert.throws(()=>validateDecision(raw(item('a','approve','合并')),c,x.task()),/EVIDENCE/);
  assert.throws(()=>validateDecision(raw({...item('a','feedback','修改标题'),questionRefs:['forged']}),c,x.task()),/REFERENCE/);
  assert.throws(()=>validateDecision(raw({...item('a','feedback','修改标题'),project:'outside'}),c,x.task()),/PROJECT/);
  assert.throws(()=>validateDecision({items:[{...item('a','feedback','修改标题','',['b']),project:undefined},{...item('b','future','修改标题','',['a']),project:undefined}],questions:[]},c,x.task()),/CYCLE/);
 }finally{await x.cleanup();}
});
test('Interpreter includes verified parent, unresolved items and future requests in its independent context',async()=>{
 const x=await fixture();const original=Runner.prototype.interpret;let prompt='';try{
  Runner.prototype.interpret=async(_d,_s,p)=>{prompt=p;return wire({items:[{...item('future','future','下一步','下一步'),project:undefined}],questions:[]});};
  const context:ReplyContext={incoming:x.incoming('下一步'),epoch:0,parent:{id:x.m.id,text:'之前的问题：确认合并文档？',questions:x.m.questions!}};
  await new ReplyInterpreter(x.config).interpret(x.task(),context,new AbortController().signal);assert.match(prompt,/之前的问题/);assert.match(prompt,/可以讨论多个事项/);assert.ok(!prompt.includes('多个控制动作返回 clarify'));
 }finally{Runner.prototype.interpret=original;await x.cleanup();}
});
test('Interpreter repairs an invalid reference once in a fresh read-only run within the original deadline',async()=>{
 const x=await fixture(),original=Runner.prototype.interpret;const calls:{dir:string;signal:AbortSignal;prompt:string}[]=[];
 try{
  Runner.prototype.interpret=async(dir,_schema,prompt,signal)=>{calls.push({dir,signal,prompt});return wire({items:[{...item('edit','feedback','修改标题'),project:undefined,questionRefs:[calls.length===1?'q1':x.m.questions![0].id]}],questions:[]});};
  const context:ReplyContext={incoming:x.incoming('修改标题'),epoch:0,parent:{id:x.m.id,text:x.m.text,questions:x.m.questions!}};
  const d=await new ReplyInterpreter(x.config).interpret(x.task(),context,new AbortController().signal);
  assert.ok('items' in d);assert.equal(calls.length,2);assert.equal(calls[1].dir,join(calls[0].dir,'repair'));assert.equal(calls[0].signal,calls[1].signal);assert.match(calls[1].prompt,/REPLY_REFERENCE_INVALID/);
  assert.equal(JSON.parse(await readFile(join(calls[0].dir,'validation-error.json'),'utf8')).reason,'REPLY_REFERENCE_INVALID');
 }finally{Runner.prototype.interpret=original;await x.cleanup();}
});
test('Interpreter rejects repeated invalid evidence and never retries transport failures',async()=>{
 const x=await fixture(),original=Runner.prototype.interpret;let calls=0;
 try{
  Runner.prototype.interpret=async()=>{calls++;return wire({items:[{...item('approve','approve','不在正文的授权'),project:undefined}],questions:[]});};
  const context:ReplyContext={incoming:x.incoming('修改标题'),epoch:0};
  await assert.rejects(new ReplyInterpreter(x.config).interpret(x.task(),context,new AbortController().signal),/REPLY_EVIDENCE_INVALID/);assert.equal(calls,2);assert.equal(x.pending().length,0);
  calls=0;Runner.prototype.interpret=async()=>{calls++;throw Error('CODEX_TIMEOUT');};
  await assert.rejects(new ReplyInterpreter(x.config).interpret(x.task(),context,new AbortController().signal),/CODEX_TIMEOUT/);assert.equal(calls,1);
 }finally{Runner.prototype.interpret=original;await x.cleanup();}
});
test('v5 to v6 preserves tasks, mail snapshots, decisions and approvals without replay',async()=>{
 const x=await fixture();try{
  x.store.set('schema_version','5');const before=JSON.stringify({sessions:x.store.sessions(),mails:x.store.mails(),jobs:x.store.jobs()});const b=currentBinding(x.task());
  const r=await migrate(x.config,x.store,new ProjectRegistry(x.config,x.store),async()=>false);assert.equal(r.version,7);assert.equal(JSON.stringify({sessions:x.store.sessions(),mails:x.store.mails(),jobs:x.store.jobs()}),before);assert.deepEqual(currentBinding(x.task()),b);assert.ok((await readFile(r.backup!)).length);
 }finally{await x.cleanup();}
});
test('A later phase request after a code Review archives only a fully known merge and queues read-only planning',async()=>{
 const x=await fixture();try{
  const s=x.task();s.workflow!.proposal={decision:'propose_step',kind:'maintenance',name:'修复',rationale:'修复已审阅',deliverables:['修复PR'],acceptance:['测试']};s.state='MERGED';s.targets=[{projectId:'app',mergeSha:'merged',manualMerge:false} as any];x.store.save(s);
  x.set({items:[item('next','future','下一阶段加缓存')],questions:[]});await x.run('下一阶段加缓存');(x.controller as any).observe(x.task(),[{code:'outcome',text:'完整阶段已合并，用户请求下阶段'}],{kind:'next-stage',text:'规划下阶段'});await x.controller.startNext();
  assert.equal(x.task().workflow!.number,2);assert.equal(x.task().workflow!.history.length,1);assert.deepEqual(x.pending().map(j=>j.kind),['plan']);assert.equal(x.task().planNotice,undefined);assert.equal(x.task().conversation!.requests.length,1);
  x.store.recover();x.store.transaction(()=>(x.controller as any).advanceReplies(x.task()));assert.equal(x.pending().length,1);
 }finally{await x.cleanup();}
});
test('Older related questions explain partial answers but never grant control authorization',()=>{
 const parent={id:'direct',text:'当前状态',questions:[]},previous=[{id:'older',text:'旧 Review',questions:[{id:'old/q',text:'旧合并',kind:'confirm' as const,action:'APPROVE' as const,dependsOn:[]}]}];
 const context={incoming:{text:'问当前状态并确认'} as Incoming,epoch:0,parent,previous};
 assert.throws(()=>validateDecision({items:[{...item('a','approve','确认'),project:undefined,questionRefs:['old/q']}],questions:[]},context,{targets:[]} as unknown as Session),/NOT_DIRECT/);
 const d=validateDecision({items:[{...item('s','status','问当前状态'),project:undefined,questionRefs:['old/q']}],questions:[]},context,{targets:[]} as unknown as Session);assert.equal(d.items[0].action,'status');
});
test('Direct English START cannot overtake a durably waiting current-plan modification',async()=>{
 const x=await fixture();try{
  const s=x.task();s.state='WAITING_START';s.planNotice=x.m.id;s.planManifest='plan';s.reviewNotice=undefined;s.conversation={answered:[],requests:[],records:[{id:'prior/edit',source:'prior',stageId:s.workflow!.stageId,item:item('edit','feedback','修改当前标题'),status:'waiting',revisionPhase:'plan'}]};x.store.save(s);
  await x.run('START');assert.equal(x.pending().some(j=>j.kind==='develop'),false);assert.equal(x.pending().filter(j=>j.kind==='plan').length,1);
 }finally{await x.cleanup();}
});
test('Item ledgers and queued effects commit atomically and roll back together on failure',async()=>{
 const x=await fixture();try{
  const original=x.store.enqueue.bind(x.store);x.store.enqueue=(s,kind,feedback)=>{const j=original(s,kind,feedback);if(kind==='merge')throw Error('synthetic transaction failure');return j;};
  x.set({items:[item('merge','approve','同意合并')],questions:[]});await x.run('同意合并');assert.equal(x.task().conversation,undefined);assert.equal(x.task().state,'WAITING_REVIEW');assert.equal(x.pending().length,0);assert.equal(x.store.jobs()[0].status,'failed');
 }finally{await x.cleanup();}
});
test('Replanning carries all accepted current-stage answers plus later requirements without authorization',async()=>{
 const x=await fixture();try{
  const s=x.task();s.conversation={answered:[],requests:[{id:'next',text:'分享不缓存',source:'prior',stageId:'stage-1'}],records:[{id:'earlier/a',source:'earlier',stageId:'stage-1',item:item('a','feedback','文件保留7天'),status:'done'},{id:'current/b',source:'current',stageId:'stage-1',item:item('b','feedback','使用持久卷'),status:'queued'}]};x.store.save(s);
  let feedback='';(x.controller.multiWork as any).analyze=async(_s:Session,text:string)=>{feedback=text;return {outcome:'needs_input',summary:'待补充',questions:['还有哪个配置？'],projects:[],workflow:{decision:'clarify',kind:'maintenance',name:'配置',rationale:'待补充',deliverables:[],acceptance:[]}};};
  const job=x.store.enqueue(s,'plan','使用持久卷');await (x.controller as any).analyzePlan(s,job,new AbortController().signal,()=>x.store.save(s),()=>s);await x.controller.startNext();
  assert.match(feedback,/文件保留7天/);assert.match(feedback,/使用持久卷/);assert.match(feedback,/分享不缓存/);assert.match(feedback,/不是执行授权/);assert.equal(x.task().state,'WAITING_INPUT');assert.equal(x.store.mails().at(-1)!.questions![0].kind,'open');
 }finally{await x.cleanup();}
});
test('A plan_ready result with unresolved questions asks them together before offering START',async()=>{
 const x=await fixture();try{
  const s=x.task();(x.controller.multiWork as any).analyze=async()=>({outcome:'plan_ready',summary:'仍有两个取舍',questions:['选择7天还是30天？','使用哪个持久卷？'],projects:[],workflow:{decision:'propose_step',kind:'implementation',name:'实现',rationale:'需要选择',deliverables:['代码'],acceptance:['测试']}});
  const j=x.store.enqueue(s,'plan','分析');await (x.controller as any).analyzePlan(s,j,new AbortController().signal,()=>x.store.save(s),()=>s);await x.controller.startNext();
  assert.equal(x.task().state,'WAITING_INPUT');const m=x.store.mails().at(-1)!;assert.equal(m.questions!.length,2);assert.ok(m.questions!.every(q=>q.kind==='open'));assert.equal(m.approvalBinding,undefined);
 }finally{await x.cleanup();}
});

test('Accepted edits plus future requirements keep one queued revision and an internal receipt only',async()=>{
 const x=await fixture();try{
  const original=x.store.mails();
  x.set({items:[item('edit','feedback','简化编辑交互'),item('later','future','将来支持分页')],questions:[]});
  const mail=x.incoming('简化编辑交互，将来支持分页');x.controller.handle(mail);x.controller.handle(mail);await x.controller.startNext();
  assert.deepEqual(x.store.mails(),original);assert.equal(x.pending().length,1);
  assert.deepEqual(x.task().conversation!.records.map(r=>r.status),['queued','done']);assert.equal(x.task().conversation!.requests[0].text,'将来支持分页');
  const receipts=x.store.db.prepare("SELECT data FROM events WHERE event='notification_internal'").all().map(row=>JSON.parse(String(row.data)));
  assert.equal(receipts.filter(e=>e.kind==='reply-receipt').length,1);assert.equal(receipts[0].kind,'reply-receipt');assert.match(receipts[0].text,/将来支持分页/);assert.equal(receipts[0].stageId,'stage-1');
 }finally{await x.cleanup();}
});
test('Natural approval and future request queue one merge without an extra confirmation email',async()=>{
 const x=await fixture();try{
  const original=x.store.mails();x.set({items:[item('merge','approve','同意合并'),item('later','future','合并后规划缓存','规划缓存',['merge'])],questions:[]});
  await x.run('同意合并，合并后规划缓存');assert.deepEqual(x.store.mails(),original);assert.deepEqual(x.pending().map(j=>j.kind),['merge']);
  assert.equal(x.task().conversation!.records[1].status,'waiting');
 }finally{await x.cleanup();}
});
test('Natural status sends one response; mixed unresolved questions are included in that response',async()=>{
 const x=await fixture();try{
  x.set({items:[item('status','status','看看状态')],questions:[]});await x.run('看看状态');
  assert.equal(x.store.mails().length,2);assert.equal(x.store.mails().at(-1)!.kind,'status');assert.match(x.store.mails().at(-1)!.text,/WAITING_REVIEW/);
  x.set({items:[item('status','status','看看状态'),{...item('edit','feedback','另一个修改'),clear:false}],questions:[{text:'具体要改哪个界面？',kind:'open',dependsOn:[]}]});await x.run('看看状态，另一个修改');
  assert.equal(x.store.mails().length,3);const reply=x.store.mails().at(-1)!;assert.match(reply.text,/WAITING_REVIEW/);assert.match(reply.text,/具体要改哪个界面/);assert.ok(reply.questions!.some(q=>q.text==='具体要改哪个界面？'));assert.ok(reply.questions!.every(q=>q.kind==='open'));
 }finally{await x.cleanup();}
});
test('Future requirements alone stay durable without emailing a receipt or authorizing implementation',async()=>{
 const x=await fixture();try{
  const original=x.store.mails();const binding=currentBinding(x.task());x.set({items:[item('later','future','下一阶段增加搜索')],questions:[]});await x.run('下一阶段增加搜索');
  assert.deepEqual(x.store.mails(),original);assert.deepEqual(currentBinding(x.task()),binding);assert.equal(x.pending().length,0);assert.equal(x.task().conversation!.requests.length,1);
 }finally{await x.cleanup();}
});
