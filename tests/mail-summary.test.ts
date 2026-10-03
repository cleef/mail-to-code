import test from 'node:test';
import assert from 'node:assert/strict';
import {simpleParser} from 'mailparser';
import {ConfigSchema} from '../src/config.js';
import {GmailClient} from '../src/gmail.js';
import {Store} from '../src/store.js';
import {createSummary,summaryText,summaryHtml} from '../src/mail-summary.js';
import type {Session,RepoExecution,WorkflowStage} from '../src/types.js';
const target=(projectId:string,prUrl?:string,branch?:string):RepoExecution=>({projectId,github:'example-org/'+projectId,prUrl,branch} as RepoExecution);
function task():Session{return {id:'TEST',subject:'TEST',createdAt:'now',initialMessageId:'initial',initialRfcId:'<initial>',initialThreadId:'thread',revision:0,cancellationEpoch:0,title:'示例笔记：优化图片加载与缓存',state:'WAITING_START',repo:'',summary:'方案已完成，等待新的 START',workflow:{stageId:'TEST-s2',number:2,proposal:{decision:'propose_step',kind:'implementation',name:'图片交付实施',rationale:'文档已合并',deliverables:['实现'],acceptance:['测试']},history:[{id:'TEST-s1',number:1,proposal:{decision:'propose_step',kind:'documentation',name:'PRD / Design',rationale:'需求',deliverables:['PRD','Design'],acceptance:['审阅']},targets:[{...target('product-records','https://github.com/example-org/product-records/pull/5'),mergeSha:'merged'}]} as WorkflowStage]},targets:[]} as Session;}
test('Task summary uses real completed stages and current phase; planned artifacts never appear',()=>{
 const s=task(),summary=createSummary(s)!;
 assert.equal(summary.rows.length,2);assert.match(summary.rows[0].phase,/PRD \/ Design.*阶段 1/);assert.equal(summary.rows[0].status,'DONE（已合并）');assert.equal(summary.rows[0].deliveries[0].url,'https://github.com/example-org/product-records/pull/5');
 assert.match(summary.rows[1].phase,/Implementation.*阶段 2/);assert.equal(summary.rows[1].current,true);assert.match(summary.rows[1].status,/WAITING_START/);assert.deepEqual(summary.rows[1].deliveries,[]);assert.match(summaryText(summary),/尚未创建分支／PR/);
 s.targets=[target('sampleapp',undefined,'codex/images'),target('mini','https://github.com/example-org/mini/pull/12')];assert.match(summaryText(createSummary(s)!),/sampleapp: codex\/images.*mini PR #12/);
 const legacy={...s,workflow:undefined,state:'WAITING_REVIEW' as const};assert.match(createSummary(legacy)!.rows[0].phase,/Review/);assert.ok(!createSummary(legacy)!.rows[0].phase.includes('PRD'));
});
test('Every task notification snapshots its summary once; resend and changed live state do not rewrite it',()=>{
 const store=new Store(':memory:');try{
  const s=task();store.save(s);const kinds=['plan','input','help','review','merge','failure','status'];
  const mails=kinds.map(k=>store.notify(s,k,'中文正文'));const snapshots=mails.map(m=>JSON.stringify(m));
  s.title='改变名称';s.state='DONE';s.targets=[{...target('sampleapp','https://github.com/example-org/sampleapp/pull/99'),mergeSha:'sha',deployed:true}];store.save(s);
  for(const [n,m] of mails.entries()){assert.ok(store.mail(m.id)!.text.startsWith('Feature name(description)'));assert.equal(JSON.stringify(store.mail(m.id)),snapshots[n]);m.status='uncertain';store.saveMail(m);assert.deepEqual(store.mail(m.id)!.summary,JSON.parse(snapshots[n]).summary);}
  const old=store.notify(s,'help','旧正文');delete old.summary;delete old.presentation;old.text='旧正文';store.saveMail(old);assert.equal(store.mail(old.id)!.text,'旧正文');
  assert.equal(store.notify({...s,system:true},'projects','库存').summary,undefined);
 }finally{store.close();}
});
test('Merge and deploy states remain distinct, including partially deployed multi-repository tasks',()=>{
 const s=task();s.targets=[{...target('one'),mergeSha:'one',deployment:{enabled:true} as any,deployed:true},{...target('two'),mergeSha:'two',deployment:{enabled:true} as any}];
 for(const state of ['PLANNING','WAITING_START','RUNNING','WAITING_REVIEW','MERGING','FAILED'] as const){s.state=state;const current=createSummary(s)!.rows.at(-1)!;assert.ok(current.status.startsWith(state));assert.ok(!current.status.includes('DONE'));}
 s.state='MERGED';assert.match(createSummary(s)!.rows.at(-1)!.status,/未部署/);s.state='DONE';assert.match(createSummary(s)!.rows.at(-1)!.status,/部分仓库已部署/);s.targets[1].deployed=true;assert.match(createSummary(s)!.rows.at(-1)!.status,/DONE（已部署）/);
});
test('HTML uses an inline table with wrapping, escapes Chinese/long names and rejects unsafe links',()=>{
 const s=task();s.title='<script>测试&"长名称'.repeat(10);s.targets=[target('one','javascript:alert(1)'),target('two','https://github.com/other/repo/pull/3'),target('three',undefined,'<img onerror=bad>')];
 const h=summaryHtml(createSummary(s)!);assert.ok(h.startsWith('<table'));assert.match(h,/table-layout:fixed/);assert.match(h,/overflow-wrap:anywhere/);assert.match(h,/font-weight:600/);assert.match(h,/&lt;script&gt;/);assert.ok(!h.includes('<script>'));assert.ok(!h.includes('javascript:'));assert.ok(!h.includes('github.com/other'));assert.ok(!h.includes('<img'));assert.match(h,/PR 链接无效/);
});
test('Actual multipart MIME carries equivalent plain/table content plus unchanged identity and marker',async()=>{
 const config=ConfigSchema.parse({gmailAddress:'agent@gmail.com',ownerAddress:'owner@qq.com',projectsRoot:'/tmp',productDocs:'/tmp',dataDir:'/tmp/mail-test'});
 const client=new (GmailClient as any)(config,{});let wire:any;
 client.request=async(path:string,method:string,body:any)=>{wire=body;return {id:'sent',threadId:'thread'};};
 const summary=createSummary(task())!,text=summaryText(summary)+'本次只规划实施，等待 START。',marker='a1234567-1234-1234-1234-123456789abc';
 await client.send({to:config.ownerAddress,subject:'中文任务',text,summary,messageId:'<snapshot@mail-to-code.local>',inReplyTo:'<parent@gmail.com>',references:['<parent@gmail.com>'],deliveryMarker:marker,threadId:'thread'});
 const mime=await simpleParser(Buffer.from(wire.raw,'base64url'));assert.equal(mime.messageId,'<snapshot@mail-to-code.local>');assert.equal(mime.inReplyTo,'<parent@gmail.com>');assert.equal(mime.headers.get('x-mail-to-code-delivery'),marker);assert.equal(wire.threadId,'thread');
 assert.equal(mime.text?.trim(),(text+'\n\n[MAIL-REF: '+marker+']').trim());assert.ok(String(mime.html).includes('<table'));assert.equal((String(mime.html).match(/Feature name\(description\)/g)||[]).length,1);assert.match(String(mime.html),/等待 START/);
});
