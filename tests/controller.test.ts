import {fakeMail} from './fake-mail.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Controller, type Work } from '../src/controller.js';
import { ConfigSchema } from '../src/config.js';
import { git } from '../src/git.js';
import type { Incoming, Session } from '../src/types.js';
import type { RunResult } from '../src/runner.js';
import { GmailError } from '../src/gmail.js';

const config=ConfigSchema.parse({gmailAddress:'agent@gmail.com',ownerAddress:'owner@qq.com',repositories:{sampleapp:{path:'/repo',github:'example-org/sampleapp'}}});
const result=(outcome:RunResult['outcome']):RunResult=>({outcome,summary:'已经完成',questions:[],requiresBackend:false,screenshotTargets:[]});
function message(id:string,text:string,reply='',subject='NEW sampleapp: 优化'):Incoming{return {id,threadId:'incoming-thread',rfcId:`<${id}@qq.com>`,inReplyTo:reply,subject,text,from:config.ownerAddress,trusted:true};}
async function setup(){
  const store=new Store(':memory:'),dir=await mkdtemp(join(tmpdir(),'mail-to-code-test-'));await git(dir,['init']);await git(dir,['config','user.name','test']);await git(dir,['config','user.email','test@example.com']);await writeFile(join(dir,'file'),'fixture');await git(dir,['add','.']);await git(dir,['commit','-m','fixture']);const head=await git(dir,['rev-parse','HEAD']);
  let merged=0,deployed=0,runs=0,sends=0;const phases:string[]=[];
  const work:Work={prepare:async s=>{s.worktree=dir;},run:async(s,phase,feedback,signal,onThread)=>{runs++;phases.push(phase);onThread('codex-task-id');return result(phase==='plan'?'plan_ready':'implementation_ready');},updateBase:async()=>false,verifyScope:async()=>{},commit:async()=>head,build:async()=>['build passed'],push:async()=>{},capture:async()=>({attachments:[],checks:['render passed'],directory:dir}),ensurePr:async s=>{s.prNumber=1;s.prUrl='https://github.com/example-org/sampleapp/pull/1';},merge:async()=>{merged++;return 'merge-sha';},deploy:async()=>{deployed++;},reconcile:async()=>true};
  const mail=fakeMail(config,()=>{sends++;});
  const controller=new Controller(config,store,mail,work);
  const cleanup=async()=>{await controller.stop();store.close();await rm(dir,{recursive:true,force:true});};
  return {store,controller,work,mail,phases,cleanup,counts:()=>({merged,deployed,runs,sends}),session:()=>store.sessions()[0]};
}
test('NEW -> plan discussion -> START -> review -> revise -> APPROVE -> separate DEPLOY',async()=>{
  const x=await setup();try{
    x.controller.handle(message('new','改一下'));x.controller.handle(message('new','改一下'));assert.equal(x.store.sessions().length,1);assert.equal(x.store.jobs().length,1);
    await x.controller.startNext();assert.equal(x.session().state,'WAITING_START');
    await x.controller.flush();await x.controller.flush();const firstPlan=x.session().planNotice!;
    x.controller.handle(message('feedback','方案补充',firstPlan,'Re: '+x.session().subject));await x.controller.startNext();await x.controller.flush();
    x.controller.handle(message('stale','START',firstPlan,'Re: '+x.session().subject));assert.equal(x.store.jobs().filter(j=>j.status==='queued').length,0);
    const latest=x.session().planNotice!;x.controller.handle(message('start','START',latest,'Re: '+x.session().subject));await x.controller.startNext();assert.equal(x.session().state,'WAITING_REVIEW');
    while(x.store.mails().some(m=>m.status==='pending'))await x.controller.flush();const oldReview=x.session().reviewNotice!;
    x.controller.handle(message('revise','小一点',oldReview,'Re: '+x.session().subject));await x.controller.startNext();while(x.store.mails().some(m=>m.status==='pending'))await x.controller.flush();
    x.controller.handle(message('old-approve','APPROVE',oldReview,'Re: '+x.session().subject));assert.equal(x.counts().merged,0);
    x.controller.handle(message('approve','APPROVE',x.session().reviewNotice!,'Re: '+x.session().subject));await x.controller.startNext();assert.equal(x.session().state,'MERGED');assert.equal(x.counts().merged,1);assert.equal(x.counts().deployed,0);
    while(x.store.mails().some(m=>m.status==='pending'))await x.controller.flush();
    x.controller.handle(message('deploy','DEPLOY',x.session().mergeNotice!,'Re: '+x.session().subject));await x.controller.startNext();assert.equal(x.session().state,'DONE');assert.equal(x.counts().deployed,1);
  }finally{await x.cleanup();}
});
test('invalid routing and untrusted messages cannot create work',async()=>{
  const x=await setup();try{x.controller.handle({...message('spoof','do stuff'),trusted:false});assert.equal(x.store.sessions().length,0);x.controller.handle(message('new','task'));const s=x.session();
    const other={...s,id:'DEV-20260930-999',initialThreadId:'other-thread',subject:'[DEV-20260930-999] other'};x.store.save(other);
    x.controller.handle({...message('mismatch','START','','Re: '+other.subject),threadId:s.initialThreadId});assert.equal(x.store.jobs().length,1);
  }finally{await x.cleanup();}
});
test('queued feedback prevents approval while work is running; CANCEL fences late results',async()=>{
  const x=await setup();try{
    let release:(r:RunResult)=>void=()=>{};x.work.run=async()=>new Promise(resolve=>{release=resolve;});
    x.controller.handle(message('new','task'));const pending=x.controller.startNext()!;await new Promise(r=>setImmediate(r));
    x.controller.handle(message('next','反馈','','Re: '+x.session().subject));assert.equal(x.store.jobs().filter(j=>j.status==='queued').length,1);
    x.controller.handle(message('cancel','CANCEL','','Re: '+x.session().subject));release(result('plan_ready'));await pending;
    assert.equal(x.session().state,'CANCELLED');assert.equal(x.store.jobs().some(j=>j.status==='queued'),false);assert.equal(x.store.mails().some(m=>m.kind==='plan'),false);
  }finally{await x.cleanup();}
});
test('backend-dependent result is blocked without review',async()=>{
  const x=await setup();try{x.work.run=async()=>({...result('blocked'),requiresBackend:true,summary:'需要数据库'});x.controller.handle(message('new','task'));await x.controller.startNext();assert.equal(x.session().state,'WAITING_INPUT');assert.equal(x.store.mails().some(m=>m.kind==='review'),false);}finally{await x.cleanup();}
});
test('uncertain send is reconciled, never automatically resent',async()=>{
  const x=await setup();try{x.controller.handle(message('new','task'));let attempts=0;x.mail.send=async()=>{attempts++;throw new Error('network timeout');};await x.controller.flush();assert.equal(x.store.mails()[0].status,'uncertain');await x.controller.flush();assert.equal(attempts,1);
    const out=x.store.mails()[0];x.mail.record({subject:x.session().subject,text:out.text,deliveryMarker:out.deliveryMarker},'existing');x.mail.search=async()=>[{id:'existing',threadId:'canonical'}] as never;out.identityCheckedAt=undefined;x.store.saveMail(out);await x.controller.flush();assert.equal(x.store.mails()[0].status,'sent');assert.equal(attempts,1);
  }finally{await x.cleanup();}
});
test('history baseline skips old email; expired cursor performs bounded deduplicated backfill',async()=>{
  const x=await setup();try{let queries=0;x.mail.search=async()=>{queries++;return [];};await x.controller.poll();assert.equal(queries,0);assert.equal(x.store.get('gmail_history'),'100');x.mail.history=async()=>{throw new GmailError(404,'expired');};await x.controller.poll();assert.equal(queries,1);assert.equal(x.store.get('gmail_history'),'100');}finally{await x.cleanup();}
});
test('restart preserves work and marks interrupted effects for reconciliation',async()=>{
  const x=await setup();try{x.controller.handle(message('new','task'));const s=x.session(),job=x.store.jobs()[0];job.kind='deploy';job.status='running';x.store.saveJob(job);s.state='DEPLOYING';s.deployUncertain=true;x.store.save(s);const mail=x.store.mails()[0];mail.status='sending';x.store.saveMail(mail);x.store.recover();assert.equal(x.session().deployUncertain,true);assert.equal(x.session().state,'FAILED');assert.equal(x.store.mails()[0].status,'uncertain');
    x.controller.handle(message('retry','RETRY','','Re: '+x.session().subject));assert.equal(x.store.jobs().some(j=>j.status==='queued'),false);
  }finally{await x.cleanup();}
});
test('feedback before initial planning cannot skip START',async()=>{
  const x=await setup();try{x.controller.handle(message('new','task'));x.controller.handle(message('early','补充需求','','Re: '+x.session().subject));assert.deepEqual(x.store.jobs().map(j=>j.kind),['plan','plan']);}finally{await x.cleanup();}
});
test('merge conflict or failed test produces failure and no review/production action',async()=>{
  const x=await setup();try{x.controller.handle(message('new','task','', 'NEW sampleapp RUN: task'));x.work.build=async()=>{throw new Error('TEST_FAILED');};await x.controller.startNext();assert.equal(x.session().state,'FAILED');assert.equal(x.store.mails().some(m=>m.kind==='review'),false);assert.equal(x.counts().deployed,0);}finally{await x.cleanup();}
});
test('CANCEL while merging fences late merge notifications and all future deployment',async()=>{
  const x=await setup();try{
    x.controller.handle(message('new','task','','NEW sampleapp RUN: task'));await x.controller.startNext();
    while(x.store.mails().some(m=>m.status==='pending'))await x.controller.flush();
    let finish:(sha:string)=>void=()=>{},began:()=>void=()=>{};const started=new Promise<void>(r=>began=r);
    x.work.merge=async()=>{began();return new Promise<string>(r=>finish=r);};
    x.controller.handle(message('approve','APPROVE',x.session().reviewNotice!,'Re: '+x.session().subject));const pending=x.controller.startNext()!;await started;
    x.controller.handle(message('cancel','CANCEL','','Re: '+x.session().subject));finish('already-approved-merge');await pending;
    assert.equal(x.session().state,'CANCELLED');assert.equal(x.store.mails().some(m=>m.kind==='merge'),false);assert.equal(x.counts().deployed,0);
  }finally{await x.cleanup();}
});
test('CANCEL is allowed after merge, but rejected after the first production effect',async()=>{
  const x=await setup();try{
    x.controller.handle(message('new','task'));const s=x.session();s.state='MERGED';s.mergeSha='approved';x.store.save(s);
    x.controller.handle(message('cancel','CANCEL','','Re: '+s.subject));assert.equal(x.session().state,'CANCELLED');assert.equal(x.session().mergeSha,'approved');
    s.state='DEPLOYING';s.deployUncertain=true;x.store.save(s);x.controller.handle(message('too-late','CANCEL','','Re: '+s.subject));assert.equal(x.session().state,'DEPLOYING');
  }finally{await x.cleanup();}
});

test('Deleted history messages do not pin the cursor or prevent later trusted mail',async()=>{const x=await setup();try{x.store.set('gmail_history','100');x.mail.history=async()=>({messages:[{id:'gone',threadId:'gone-thread'},{id:'live',threadId:'incoming-thread'}],cursor:'110'}) as never;x.mail.read=async(id?:string)=>{if(id==='gone')throw new GmailError(404,'deleted');const raw=Buffer.from(`From: ${config.ownerAddress}\r\nTo: ${config.gmailAddress}\r\nSubject: NEW sampleapp: live\r\nMessage-ID: <live@qq.com>\r\nAuthentication-Results: mx.google.com; dkim=pass header.d=qq.com; dmarc=pass header.from=qq.com\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nlive requirement`).toString('base64url');return {id:'live',threadId:'incoming-thread',raw};};await x.controller.poll();assert.equal(x.store.get('gmail_history'),'110');assert.equal(x.store.seen('gone'),true);assert.equal(x.store.sessions().length,1);assert.equal(x.store.jobs()[0].kind,'plan');}finally{await x.cleanup();}});
