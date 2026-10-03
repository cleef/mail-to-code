// Synthetic isolated acceptance: real Codex, no Gmail, business adapter, deployment or live-state write.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig,ConfigSchema} from '../dist/src/config.js';
import {Store} from '../dist/src/store.js';
import {ReplyInterpreter} from '../dist/src/reply-interpreter.js';
import {MultiController,manifest} from '../dist/src/multi-controller.js';
import {ProjectRegistry} from '../dist/src/projects.js';
import {migrate} from '../dist/src/migration.js';
import {execute} from '../dist/src/process.js';
const root=await mkdtemp(join(tmpdir(),'mail-conversations-acceptance-'));process.umask(0o077);
const config=process.argv.includes('--local-synthetic')?ConfigSchema.parse({gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',dataDir:root,projectsRoot:root,productDocs:root}):{...await loadConfig(),dataDir:root};const report={directory:root,cases:[],sent:0,businessExecuted:0};
const cases=[
 {name:'multi approval + future',text:'先合并 PR，然后开始实现，私人图片开启缓存，共享图片不缓存',actions:['approve','future'],effect:'merge',future:true},
 {name:'confirmation + choice',text:'确认',extra:[{text:'下阶段方案保留分享不缓存',kind:'confirm',action:'future'},{text:'旧文件保留七天还是三十天？',kind:'choice'}],actions:['approve','future'],effect:'merge',questions:true},
 {name:'partial answer',text:'同意合并当前 Review 的完整清单；文件保留期限还没决定',extra:[{text:'旧文件保留期限是多少？',kind:'open'}],actions:['approve'],effect:'merge',questions:true},
 {name:'current change negates approval',text:'同意，但先修改当前 Design：分享图片必须 no-store',actions:['feedback'],effect:'develop',noApproval:true},
 {name:'approval + future changes',text:'同意合并当前 Review 的完整清单。下一阶段实现时增加网页加载重试',actions:['approve','future'],effect:'merge',future:true},
 {name:'negation',text:'不要合并，也不要发布；先把当前文档标题改为“图片存储与缓存设计”',actions:['feedback'],effect:'develop',noApproval:true},
 {name:'conditional approval',text:'如果明天所有测试通过再合并',noApproval:true,questions:true},
 {name:'quoted command',text:'同事说“APPROVE”，这不是我的批准，我只是问当前状态',actions:['status'],noApproval:true},
 {name:'legacy acknowledgement',text:'确认',legacy:true,noApproval:true,questions:true},
 {name:'multi clarification',text:'当前设计要修改，我还没有决定文件目录和保留期限；请一次问清楚这两个问题',noApproval:true,questions:true,minQuestions:2},
];
try{
 for(const [n,c] of cases.entries()){
  const store=new Store(join(root,`case-${n}.sqlite`));store.set('schema_version','6');
  try{
   const s={id:'SYNTHETIC-'+n,title:'示例笔记：优化图片加载与缓存',subject:'隔离验证 '+n,state:'WAITING_REVIEW',repo:'',summary:'阶段1当前完整 Review 是产品文档 PRD/Design；下一阶段实施方案尚未生成，必须新 START。当前文档检查已通过。',createdAt:'now',initialMessageId:'initial',initialRfcId:'<initial@example.test>',initialThreadId:'thread',targets:[],references:[],revision:0,cancellationEpoch:0,workflow:{stageId:'stage-1',number:1,history:[]}};
   s.reviewManifest=manifest(s);const parent=store.notify(s,'review','本次确定事项：确认合并当前完整 Review。后续只规划实施，不沿用批准。');s.reviewNotice=parent.id;store.save(s);
   if(c.legacy){delete parent.questions;delete parent.summary;delete parent.presentation;parent.text='旧 Review：APPROVE 批准合并。';}
   for(const [i,q] of (c.extra||[]).entries())parent.questions.push({id:parent.id+'/extra'+i,dependsOn:[],...q});
   parent.status='sent';parent.identityStatus='verified';parent.rfcMessageId='<parent-'+n+'@example.test>';store.saveMail(parent);
   const input={id:'input-'+n,rfcId:'<input-'+n+'@example.test>',threadId:'thread',inReplyTo:parent.rfcMessageId,subject:s.subject,text:c.text,from:config.ownerAddress,trusted:true};
   const controller=new MultiController(config,store,{send:async()=>{throw Error('REAL_EMAIL_FORBIDDEN');}}, {},new ProjectRegistry(config,store),{interpretReply:async(session,context,signal)=>{try{return await new ReplyInterpreter(config).interpret(session,context,signal);}catch(e){await writeFile(join(root,'interpreter-error.txt'),String(e.stderr||e.message),{mode:0o600});throw e;}}});
   controller.startBusiness=()=>undefined;controller.handle(input);controller.handle(input);await controller.startNext();
   const job=store.jobs().find(j=>j.kind==='interpret');assert.equal(job.status,'done','Interpretation failed: '+c.name);
   const decision=job.reply.result;assert.ok('items' in decision);const actions=decision.items.filter(i=>i.clear).map(i=>i.action);
   for(const action of c.actions||[])assert.ok(actions.includes(action),'Missing '+action+' in '+c.name+': '+actions);
   const effects=store.jobs().filter(j=>j.kind!=='interpret');if(c.effect)assert.equal(effects[0]?.kind,c.effect);
   if(c.noApproval)assert.ok(!effects.some(j=>['merge','deploy'].includes(j.kind)),c.name+' incorrectly authorized an external effect');
   if(c.questions)assert.ok(store.mails().at(-1).questions.length>=(c.minQuestions||1),c.name+' lost unresolved questions');
   if(c.future){for(const effect of effects){effect.status='done';store.saveJob(effect);}const next=store.session(s.id);next.workflow.stageId='stage-2';next.workflow.number=2;next.state='WAITING_START';store.save(next);store.transaction(()=>controller.advanceReplies(store.session(s.id)));assert.ok(store.session(s.id).conversation.requests.length);assert.ok(!store.jobs().some(j=>j.kind==='develop'));}
   assert.equal(store.jobs().filter(j=>j.kind==='interpret').length,1,'Duplicate receipt replayed');store.recover();
   report.cases.push({name:c.name,actions,effects:effects.map(j=>j.kind),unresolved:store.mails().at(-1).questions?.length||0,ok:true});
   await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report.cases.at(-1)));await controller.stop();
  }finally{store.close();}
 }
 const old=new Store(join(root,'migration.sqlite'));old.set('schema_version','5');old.set('gmail_history','synthetic-cursor');const m={id:'old-mail',sessionId:'old-task',kind:'help',text:'unchanged legacy text',status:'sent',createdAt:'now',attempts:1,attachments:[],approvalBinding:{noticeId:'old-notice',version:'old-version',action:'APPROVE'}};old.saveMail(m);const before=old.mails();const migration=await migrate(config,old,new ProjectRegistry(config,old),async()=>false);assert.equal(migration.version,6);assert.deepEqual(old.mails(),before);assert.equal(old.get('gmail_history'),'synthetic-cursor');report.migration={schema:6,legacyPreserved:true,noReplay:old.jobs().length===0};old.close();
 if(process.env.MAIL_TO_CODE_OLD_STORE){await execute(process.execPath,['--input-type=module','-e',`const {Store}=await import(${JSON.stringify('file://'+process.env.MAIL_TO_CODE_OLD_STORE)});let blocked=false;try{new Store(${JSON.stringify(join(root,'migration.sqlite'))})}catch(e){blocked=/migration required/.test(e.message)}if(!blocked)process.exit(1)`],{timeoutMs:30000});report.migration.oldControllerRejected=true;}
 await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({report:join(root,'report.json'),passed:report.cases.length,...report.migration,sent:0,businessExecuted:0}));
}catch(e){await writeFile(join(root,'report.json'),JSON.stringify({...report,error:e.message},null,2),{mode:0o600});throw e;}
