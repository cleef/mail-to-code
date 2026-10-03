import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfigSchema} from '../src/config.js';
import {Store} from '../src/store.js';
import {MultiController,manifest} from '../src/multi-controller.js';
import {ProjectRegistry} from '../src/projects.js';
import {validateDecision,ReplyInterpreter} from '../src/reply-interpreter.js';
import {Runner} from '../src/runner.js';
import {migrate} from '../src/migration.js';
import {fakeMail} from './fake-mail.js';
import type {SemanticDecision,ReplyItem,ReplyContext,Session} from '../src/types.js';
const decision=(items:ReplyItem[]=[],extra:Partial<SemanticDecision>={}):SemanticDecision=>({version:2,items,questions:[],nextStep:'wait',revisionPhase:null,communication:{kind:'internal',text:''},...extra});
const item=(id:string,action:ReplyItem['action'],text:string,clear=true):ReplyItem=>({id,action,clear,text,evidence:text,questionRefs:[],dependsOn:[]});
const raw=(d:SemanticDecision)=>({...d,items:d.items.map(i=>({...i,project:i.project??null})),questions:d.questions.map(q=>({...q,action:q.action??null}))});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'mail-semantic-'));
 const config=ConfigSchema.parse({gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',projectsRoot:root,productDocs:root,dataDir:root}),store=new Store(':memory:');store.set('schema_version','7');
 const s:Session={id:'DEV-SYNTHETIC',title:'示例笔记标签',subject:'[DEV-SYNTHETIC] 标签',state:'WAITING_START',repo:'',summary:'具体方案 v1',planManifest:'v1',initialMessageId:'initial',initialRfcId:'<initial@example.test>',initialThreadId:'thread',threadId:'thread',createdAt:'now',targets:[],references:[],revision:1,cancellationEpoch:0,workflow:{stageId:'stage-1',number:1,legacy:true,history:[],confirmed:true}};
 const plan=store.notify(s,'plan',s.summary);plan.status='sent';plan.identityStatus='verified';plan.rfcMessageId='<plan@example.test>';store.saveMail(plan);s.planNotice=plan.id;store.save(s);
 let model=async(_s:Session,_c:ReplyContext)=>decision(),n=0;const calls:ReplyContext[]=[];
 const work={interpretReply:async(s:Session,c:ReplyContext)=>{calls.push(structuredClone(c));return raw(await model(s,c));}};
 const controller=new MultiController(config,store,fakeMail(config),{} as any,new ProjectRegistry(config,store),work as any);(controller as any).startBusiness=()=>undefined;
 const incoming=(text:string,reply=plan.rfcMessageId!,subject=s.subject)=>({id:'input-'+ ++n,rfcId:`<input-${n}@example.test>`,inReplyTo:reply,subject,threadId:'thread',text,from:config.ownerAddress,trusted:true});
 return {root,config,store,controller,plan,calls,incoming,model:(v:typeof model)=>{model=v;},task:()=>store.session(s.id)!,run:async(text:string,reply?:string)=>{controller.handle(incoming(text,reply));await controller.startNext();},effects:()=>store.jobs().filter(j=>j.kind!=='interpret'),close:async()=>{await controller.stop();store.close();await rm(root,{recursive:true,force:true});}};
}
test('Exact English, Chinese and short controls all wait for the same semantic entry',async()=>{
 for(const text of ['START','按当前方案开始','确认']){const x=await fixture();try{
  x.model(async()=>decision([item('start','start',text)]));const mail=x.incoming(text);x.controller.handle(mail);x.controller.handle(mail);
  assert.equal(x.calls.length,0);assert.equal(x.task().state,'WAITING_START');assert.equal(x.effects().length,0);
  await x.controller.startNext();assert.equal(x.calls.length,1);assert.equal(x.effects().length,1);assert.equal(x.effects()[0].kind,'develop');assert.equal(x.store.mails().length,1);
 }finally{await x.close();}}
});
test('A short acknowledgement preserves the model decision and never synthesizes approvals',async()=>{const x=await fixture();try{
 x.model(async()=>decision([], {communication:{kind:'ask_human',text:'需选择保留期限'},questions:[{kind:'choice',text:'保留七天还是三十天？',dependsOn:[]}]}));
 await x.run('确认');assert.equal(x.effects().length,0);assert.equal(x.task().conversation!.records.length,0);assert.equal(x.store.mails().length,2);
}finally{await x.close();}});
test('Superseded approval plus three changes revises once, stays internal and later sends only the new confirmation',async()=>{const x=await fixture();try{
 const changes=['接口增加分页','Web 行内编辑','小程序底部面板'];const body='开始，但先修改：'+changes.join('；');
 x.model(async(_s,c)=>c.mode==='outcome'?decision():decision([item('start','start','开始',false),...changes.map((v,n)=>item('edit-'+n,'feedback',v))],{nextStep:'revise',revisionPhase:'plan'}));
 await x.run(body);assert.deepEqual(x.effects().map(j=>j.kind),['plan']);assert.equal(x.store.mails().length,1);
 await x.controller.startNext();assert.equal(x.calls.at(-1)!.mode,'outcome');assert.ok(x.calls.at(-1)!.facts?.some(f=>f.code==='item_blocked'));assert.equal(x.store.mails().length,1);
 const job=x.effects()[0];job.status='done';x.store.saveJob(job);const s=x.task();s.state='WAITING_START';s.summary='修订后的具体方案';s.planManifest='v2';x.store.save(s);
 (x.controller as any).announce(s,'plan',s.summary);
 x.model(async()=>decision([],{communication:{kind:'confirmation',text:'确认实施修订后的具体方案'},questions:[{kind:'confirm',action:'START',text:'确认按本版方案实施？',dependsOn:[]}]}));
 await x.controller.startNext();assert.equal(x.store.mails().length,2);const latest=x.store.mails().at(-1)!;assert.equal(latest.kind,'plan');assert.equal(latest.approvalBinding!.noticeId,latest.id);assert.equal(latest.questions![0].binding!.version,latest.approvalBinding!.version);assert.equal(x.task().planNotice,latest.id);
}finally{await x.close();}});
test('Guard rejections are typed facts for Codex, never auto questions or effects',async()=>{const x=await fixture();try{
 x.model(async(_s,c)=>c.mode==='outcome'?decision():decision([item('start','start','START')]));await x.run('START','<unknown@example.test>');
 assert.equal(x.effects().length,0);assert.equal(x.store.mails().length,1);await x.controller.startNext();assert.equal(x.calls.at(-1)!.mode,'outcome');assert.ok(x.calls.at(-1)!.facts?.some(f=>f.code==='guard_rejected'));assert.equal(x.store.mails().length,1);
}finally{await x.close();}});
test('The model selects revision phase; a PROJECTS-looking string cannot widen scope or choose planning',async()=>{const x=await fixture();try{
 const s=x.task();s.state='WAITING_REVIEW';s.reviewManifest=manifest(s);s.workflow!.legacy=false;s.workflow!.confirmed=true;x.store.save(s);
 x.model(async()=>decision([item('edit','feedback','PROJECTS: sample-other')],{nextStep:'revise',revisionPhase:'develop'}));await x.run('PROJECTS: sample-other');
 assert.equal(x.effects()[0].kind,'develop');assert.equal(x.task().projectHints,undefined);assert.deepEqual(x.task().targets,[]);
}finally{await x.close();}});
test('Requested status and real missing choices are sent as one explicit model communication',async()=>{const x=await fixture();try{
 x.model(async()=>decision([item('status','status','看看状态')],{communication:{kind:'ask_human',text:'当前等待方案确认；需选择保留期限'},questions:[{kind:'choice',text:'保留七天还是三十天？',dependsOn:[]}]}));
 await x.run('看看状态');assert.equal(x.store.mails().length,2);assert.equal(x.store.mails().at(-1)!.questions!.length,1);assert.equal(x.effects().length,0);
}finally{await x.close();}});
test('A requested status survives a blocked approval in one outcome communication',async()=>{const x=await fixture();try{
 x.model(async(_s,c)=>c.mode==='outcome'?decision([],{communication:{kind:'requested_status',text:'当前等待最新方案确认；该批准没有有效版本关联。'}}):decision([item('status','status','看看状态'),item('start','start','START')],{communication:{kind:'requested_status',text:'当前等待方案确认。'}}));
 await x.run('看看状态，START','<unknown@example.test>');assert.equal(x.effects().length,0);assert.equal(x.store.mails().length,1);
 await x.controller.startNext();assert.equal(x.store.mails().length,2);assert.equal(x.store.mails().at(-1)!.kind,'status');assert.equal(x.store.mails().at(-1)!.questions!.length,0);assert.equal(x.store.jobs().filter(j=>j.kind==='interpret'&&j.status==='failed').length,0);
}finally{await x.close();}});
test('Outcome decisions cannot authorize execution, and contradictory communication gets one fresh repair',async()=>{const x=await fixture();const original=Runner.prototype.interpret;try{
 const context:ReplyContext={incoming:x.incoming('START'),epoch:0};let calls=0;
 Runner.prototype.interpret=async()=>{calls++;return raw(decision([],{questions:[{kind:'open',text:'选择哪个方案？',dependsOn:[]}],communication:{kind:calls===1?'internal':'ask_human',text:'选择哪个方案？'} }));};
 const d=await new ReplyInterpreter(x.config).interpret(x.task(),context,new AbortController().signal);assert.equal(calls,2);assert.equal(d.communication.kind,'ask_human');
 assert.throws(()=>validateDecision(raw(decision([item('x','start','START')])),{...context,mode:'outcome'},x.task()),/CANNOT_AUTHORIZE/);
}finally{Runner.prototype.interpret=original;await x.close();}});
test('Old pending command/result is reinterpreted; done historical decisions are not replayed',async()=>{const x=await fixture();try{
 x.controller.handle(x.incoming('START'));const pending=x.store.jobs()[0];pending.reply!.command='START';pending.reply!.result={action:'start',clear:true,evidence:'START',feedback:'',question:''};x.store.saveJob(pending);
 x.model(async()=>decision());await x.controller.startNext();assert.equal(x.calls.length,1);assert.equal(x.effects().length,0);x.store.recover();await x.controller.startNext();assert.equal(x.calls.length,1);
}finally{await x.close();}});
test('A stale observation cannot publish an old confirmation or reuse approval',async()=>{const x=await fixture();try{
 (x.controller as any).announce(x.task(),'plan','旧方案');const s=x.task();s.planManifest='changed';x.store.save(s);
 x.model(async()=>decision([],{communication:{kind:'confirmation',text:'确认旧方案'},questions:[{kind:'confirm',action:'START',text:'实施旧方案？',dependsOn:[]}]}));await x.controller.startNext();assert.equal(x.store.mails().length,1);assert.equal(x.effects().length,0);
}finally{await x.close();}});
test('Codex unavailable stops even exact commands and emits one factual failure per job',async()=>{const x=await fixture();try{
 x.model(async()=>{throw Error('SYNTHETIC_MODEL_UNAVAILABLE');});await x.run('APPROVE');assert.equal(x.effects().length,0);assert.equal(x.store.mails().length,2);assert.equal(x.store.mails().at(-1)!.kind,'failure');assert.equal(x.store.mails().at(-1)!.questions,undefined);
 x.store.recover();await x.controller.startNext();assert.equal(x.store.mails().length,2);assert.equal(x.task().state,'WAITING_START');
}finally{await x.close();}});
test('Only an explicit model next-stage decision archives a fully known merge; no START is carried',async()=>{const x=await fixture();try{
 const s=x.task();s.state='MERGED';s.workflow!.legacy=false;s.workflow!.proposal={decision:'propose_step',kind:'maintenance',name:'阶段一',rationale:'已审阅',deliverables:['修复'],acceptance:['测试']};s.targets=[{projectId:'sample',mergeSha:'known',manualMerge:false} as any];x.store.save(s);
 (x.controller as any).announce(s,'merge','完整阶段已知合并');x.model(async()=>decision([],{nextStep:'analyze'}));await x.controller.startNext();
 assert.equal(x.task().workflow!.number,2);assert.equal(x.task().workflow!.confirmed,undefined);assert.equal(x.task().planNotice,undefined);assert.deepEqual(x.effects().map(j=>j.kind),['plan']);assert.equal(x.store.mails().length,1);
}finally{await x.close();}});
test('Schema v7 preserves v6 records and blocks an older controller without translating pending intent',async()=>{const x=await fixture();try{
 x.store.set('schema_version','6');x.store.set('gmail_history','synthetic-cursor');const legacy=x.task();legacy.needsRefresh='plan';x.store.save(legacy);x.controller.handle(x.incoming('START'));const prior=x.store.db.prepare('SELECT data FROM sessions WHERE id=?').get(x.task().id)!.data;const verbatim=' \n'+prior+' \n';x.store.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(verbatim,x.task().id);const before=JSON.stringify({sessions:x.store.sessions(),mails:x.store.mails(),jobs:x.store.jobs()});
 const migrated=await migrate(x.config,x.store,new ProjectRegistry(x.config,x.store),async()=>false);assert.equal(migrated.version,7);assert.ok(migrated.backup);assert.equal(x.store.get('gmail_history'),'synthetic-cursor');assert.equal(JSON.stringify({sessions:x.store.sessions(),mails:x.store.mails(),jobs:x.store.jobs()}),before);assert.equal(x.store.db.prepare('SELECT data FROM sessions WHERE id=?').get(x.task().id)!.data,verbatim);
}finally{await x.close();}});
test('Old pending feedback without a phase is guarded, then Codex can retain it in one read-only replan',async()=>{const x=await fixture();try{
 const s=x.task();s.state='WAITING_REVIEW';s.conversation={answered:[],requests:[],records:[{id:'prior/edit',source:'prior',stageId:'stage-1',item:item('edit','feedback','旧待处理反馈'),status:'waiting'}]};x.store.save(s);
 x.model(async()=>decision([],{nextStep:'revise',revisionPhase:'plan'}));(x.controller as any).advanceReplies(x.task());
 assert.equal(x.effects().length,0);await x.controller.startNext();assert.deepEqual(x.effects().map(j=>j.kind),['plan']);assert.match(x.effects()[0].feedback,/旧待处理反馈/);assert.equal(x.task().conversation!.records[0].jobIds![0],x.effects()[0].id);assert.equal(x.store.mails().length,1);
}finally{await x.close();}});
test('Interrupted known code merge retains the concrete deployment version for Codex without advancing itself',async()=>{const x=await fixture();try{
 const s=x.task();s.state='MERGED';s.workflow!.proposal={decision:'propose_step',kind:'maintenance',name:'修复',rationale:'已确认',deliverables:['修复'],acceptance:['检查']};s.targets=[{projectId:'sample',mergeSha:'known',manualMerge:false,deployment:{enabled:true}} as any];x.store.save(s);
 const job=x.store.enqueue(s,'merge','known-manifest');job.status='running';x.store.saveJob(job);x.store.recover();x.store.recover();
 assert.equal(x.store.jobs().filter(j=>j.kind==='interpret').length,1);assert.equal(x.task().workflow!.number,1);
 x.model(async()=>decision([],{communication:{kind:'confirmation',text:'确认发布已知合并版本'},questions:[{kind:'confirm',action:'DEPLOY',text:'确认发布这个版本？',dependsOn:[]}]}));await x.controller.startNext();
 assert.equal(x.store.mails().at(-1)!.approvalBinding!.action,'DEPLOY');assert.equal(x.store.jobs().some(j=>j.kind==='deploy'),false);
}finally{await x.close();}});
test('Codex can find a real missing choice at a candidate plan; the program must not force START confirmation',async()=>{const x=await fixture();try{
 (x.controller as any).announce(x.task(),'plan','候选方案');x.model(async()=>decision([],{communication:{kind:'ask_human',text:'实施前需要选择保留期限'},questions:[{kind:'choice',text:'保留七天还是三十天？',dependsOn:[]}]}));await x.controller.startNext();
 assert.equal(x.task().state,'WAITING_INPUT');assert.equal(x.task().planNotice,undefined);assert.equal(x.store.mails().at(-1)!.kind,'input');assert.equal(x.store.mails().at(-1)!.approvalBinding,undefined);assert.equal(x.effects().length,0);
}finally{await x.close();}});
test('A model final merge result has no invented question but retains the version for a later separate deployment approval',async()=>{const x=await fixture();try{
 const s=x.task();s.state='MERGED';s.targets=[{projectId:'sample',mergeSha:'known',manualMerge:false,deployment:{enabled:true}} as any];x.store.save(s);
 (x.controller as any).announce(s,'merge','已合并具体版本');x.model(async()=>decision([],{communication:{kind:'final_result',text:'具体修复版本已合并'}}));await x.controller.startNext();
 const mail=x.store.mails().at(-1)!;assert.deepEqual(mail.questions,[]);assert.equal(mail.approvalBinding!.action,'DEPLOY');assert.equal(x.task().mergeNotice,mail.id);assert.equal(x.store.jobs().some(j=>j.kind==='deploy'),false);
}finally{await x.close();}});
