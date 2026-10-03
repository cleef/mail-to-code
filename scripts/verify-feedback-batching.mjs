// Real Codex interpretation with synthetic state; no mailbox or business effects.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigSchema} from '../dist/src/config.js';
import {Store} from '../dist/src/store.js';
import {MultiController} from '../dist/src/multi-controller.js';
import {ProjectRegistry} from '../dist/src/projects.js';
import {ReplyInterpreter} from '../dist/src/reply-interpreter.js';

process.umask(0o077);
const root=await mkdtemp(join(tmpdir(),'feedback-batching-acceptance-'));
const config=ConfigSchema.parse({gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',dataDir:root,projectsRoot:root,productDocs:root});
const store=new Store(join(root,'state.sqlite'));store.set('schema_version','7');
const s={id:'SYNTHETIC-FEEDBACK',title:'示例笔记标签设计',subject:'示例笔记标签设计',repo:'',state:'WAITING_INPUT',blockedPhase:'plan',createdAt:'now',initialMessageId:'initial',initialRfcId:'<initial@example.test>',initialThreadId:'synthetic',summary:'当前仅讨论标签 PRD/Design，尚未生成可确认方案。请回答筛选、管理、命名和编辑交互四项问题。',targets:[],references:[],revision:0,cancellationEpoch:0,workflow:{stageId:'synthetic-stage',number:1,history:[],confirmed:true}};
store.save(s);
const parent=store.notify(s,'input',s.summary,[],{questions:['多标签怎样筛选？','提供哪些管理功能？','命名去重怎样处理？','两端怎样编辑标签？'].map(text=>({text,kind:'open',dependsOn:[]}))});
parent.status='sent';parent.identityStatus='verified';parent.rfcMessageId='<parent@example.test>';store.saveMail(parent);
const text='1. 多标签筛选采用交集，未选择时显示全部。\n2. 只支持创建、复用和单篇移除标签，暂不做统一重命名和删除。\n3. 去掉首尾空格，拒绝空名称，同账户同名直接复用，账户之间隔离。\n4. Design 补充 Web 弹窗和小程序底部面板的草图，包含搜索、创建、移除、取消、保存失败重试。';
const incoming={id:'synthetic-reply',rfcId:'<reply@example.test>',threadId:'synthetic',inReplyTo:parent.rfcMessageId,subject:s.subject,text,from:config.ownerAddress,trusted:true};
const controller=new MultiController(config,store,{send:async()=>{throw Error('REAL_EMAIL_FORBIDDEN');}}, {},new ProjectRegistry(config,store),{interpretReply:(session,context,signal)=>new ReplyInterpreter(config).interpret(session,context,signal)});
controller.startBusiness=()=>undefined;
try{
 controller.handle(incoming);controller.handle(incoming);await controller.startNext();
 const interpret=store.jobs().filter(j=>j.kind==='interpret');assert.equal(interpret.length,1);assert.equal(interpret[0].status,'done',store.mails().at(-1)?.text);
 const records=store.session(s.id).conversation.records;
 assert.ok(records.length>0);assert.ok(records.every(r=>r.item.action==='feedback'&&r.status==='queued'));
 const effects=store.jobs().filter(j=>j.kind!=='interpret');assert.equal(effects.length,1);assert.equal(effects[0].kind,'plan');
 assert.ok(records.every(r=>r.jobIds.length===1&&r.jobIds[0]===effects[0].id));assert.equal(store.mails().length,1);
 effects[0].status='done';store.saveJob(effects[0]);
 for(let n=0;n<4;n++)store.transaction(()=>controller.advanceReplies(store.session(s.id)));
 assert.ok(store.session(s.id).conversation.records.every(r=>r.status==='done'));assert.equal(store.jobs().filter(j=>j.kind==='plan').length,1);
 const report={passed:true,interpretedItems:records.length,planJobs:1,extraReceiptMails:0,duplicateIntakeReplayed:false,sent:0,businessExecuted:0};
 await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({...report,report:join(root,'report.json')}));
}finally{await controller.stop();store.close();}
