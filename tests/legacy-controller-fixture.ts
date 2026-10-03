// Historical actor fixture for transport/recovery regression tests; never shipped as a live entry.
import type { Config } from '../src/config.js';
import { Store } from '../src/store.js';
import { GmailError, type GmailClient } from '../src/gmail.js';
import {directive} from './legacy-command-fixture.js';
import type { Incoming, Session, Job, Outbound, Attachment } from '../src/types.js';
import type { RunResult } from '../src/runner.js';
import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {Delivery} from '../src/delivery.js';

import {Controller as TransportController,safeError,type Work} from '../src/controller.js';
export type {Work} from '../src/controller.js';
export class Controller extends TransportController {
  private active?:{job:Job;abort:AbortController;promise:Promise<void>};
  handle(incoming:Incoming) {
    this.store.transaction(()=>{
      if(this.store.seen(incoming.id))return;
      if(!incoming.trusted){this.store.remember(incoming.id,incoming.rfcId,incoming.threadId,undefined,incoming.reason||'rejected');return;}
      const candidates=new Set<string>();
      const id=/\[(DEV-\d{8}-\d+)\]/.exec(incoming.subject)?.[1];if(id&&this.store.session(id))candidates.add(id);
      const reply=this.store.replyMail(incoming.inReplyTo);if(reply)candidates.add(reply.sessionId);
      for(const s of this.store.sessions())if(s.threadId===incoming.threadId||s.initialThreadId===incoming.threadId)candidates.add(s.id);
      const prior=this.store.inboundSession(incoming.inReplyTo,incoming.threadId);if(prior)candidates.add(prior);
      if(candidates.size>1){this.store.remember(incoming.id,incoming.rfcId,incoming.threadId,undefined,'routing_conflict');return;}
      let session=candidates.size?this.store.session([...candidates][0]):undefined;
      const action=directive(incoming.subject,incoming.text,Boolean(session));
      if(!session){
        if(action.type!=='new'){this.store.remember(incoming.id,incoming.rfcId,incoming.threadId,undefined,'unrouted');return;}
        const taskId=this.store.newId(),productId=/^PRODUCT:\s*([A-Z][A-Z0-9_-]*-\d+)\s*$/mi.exec(incoming.text)?.[1];
        session={id:taskId,repo:action.repo,title:action.title,state:'QUEUED',subject:`[${taskId}] ${action.title}`,createdAt:new Date().toISOString(),initialMessageId:incoming.id,initialRfcId:incoming.rfcId,initialThreadId:incoming.threadId,summary:incoming.text,productId,blockedPhase:action.run?'develop':'plan',cancellationEpoch:0,revision:0};
        this.store.save(session);this.store.recordProgress(session,'ack',`已收到 ${taskId}：${action.title}\n${action.run?'直接开发并生成截图。':'先分析方案；收到方案后回复 START 开始开发。'}\n回复 STATUS 查询状态，CANCEL 取消。`);
        this.store.enqueue(session,action.run?'develop':'plan',incoming.text);
      }else if(action.type==='invalid'){this.store.notify(session,'help',action.reason);}
      else if(action.type==='feedback')this.feedback(session,action.text);
      else if(action.type==='command')this.command(session,action.command,this.store.replyMail(incoming.inReplyTo)?.id||incoming.inReplyTo);
      this.store.remember(incoming.id,incoming.rfcId,incoming.threadId,session.id,'accepted');this.store.event(session.id,'mail_received',{messageId:incoming.id,type:action.type});
    });
  }
  private hasWork(session:Session){return this.store.jobs().some(j=>j.sessionId===session.id&&['queued','running'].includes(j.status));}
  private latest(session:Session,notice:string|undefined,replyTo:string){return Boolean(notice&&notice===replyTo&&this.store.mail(notice)?.status==='sent'&&!this.hasWork(session));}
  private feedback(session:Session,text:string){
    if(session.mergeSha||['MERGING','MERGED','DEPLOYING','DONE','CANCELLED'].includes(session.state)){this.store.notify(session,'help','当前阶段不接受修改；请使用 NEW <project>: 标题 创建新任务。');return;}
    const phase=session.state==='PLANNING'||session.state==='WAITING_START'||session.blockedPhase==='plan'?'plan':'develop';
    session.reviewNotice=undefined;session.planNotice=undefined;session.lastError=undefined;this.store.save(session);this.store.enqueue(session,phase,text);
  }
  private command(s:Session,command:string,replyTo:string){
    const refuse=(text:string)=>this.store.notify(s,'help',text);
    switch(command){
      case 'STATUS': this.store.notify(s,'status',`${s.id}: ${s.state}\n${s.summary}\n${s.prUrl||''}\n${s.lastError||''}`);return;
      case 'CANCEL':
        if(s.state==='DONE'||s.deployUncertain){refuse('已经开始生产发布，不能取消已发生的操作；先核对生产结果。');return;}
        const merging=s.state==='MERGING';
        s.cancellationEpoch++;s.state='CANCELLED';this.store.save(s);
        for(const j of this.store.jobs().filter(j=>j.sessionId===s.id&&j.status==='queued')){j.status='cancelled';this.store.saveJob(j);}
        if(this.active?.job.sessionId===s.id)this.active.abort.abort();this.store.notify(s,'cancelled',merging?`已停止后续执行，分支和证据保留。已发出的合并请求无法撤回，请核对 ${s.prUrl}；不会继续发布。`:'任务已取消；分支、已发生的合并和已有证据保留。');return;
      case 'START':
        if(s.state!=='WAITING_START'||!this.latest(s,s.planNotice,replyTo)){refuse('请直接回复最新方案邮件中的 START；旧方案或正在执行的任务不能启动。');return;}
        s.state='QUEUED';s.blockedPhase='develop';this.store.save(s);this.store.enqueue(s,'develop',`已确认最新方案：\n${s.summary}`);return;
      case 'APPROVE':
        if(s.state!=='WAITING_REVIEW'||!this.latest(s,s.reviewNotice,replyTo)){refuse('请直接回复最新 Review 邮件 APPROVE；版本已变更或任务仍在执行。');return;}
        s.state='MERGING';this.store.save(s);this.store.enqueue(s,'merge','');return;
      case 'DEPLOY':
        if(s.state!=='MERGED'||!this.latest(s,s.mergeNotice,replyTo)){refuse('请直接回复最新合并结果邮件 DEPLOY；必须先合并，并确认其中的提交版本。');return;}
        s.state='DEPLOYING';this.store.save(s);this.store.enqueue(s,'deploy','');return;
      case 'RETRY':
        if(s.state!=='FAILED'||!s.failedKind||this.hasWork(s)){refuse('当前没有可重试的失败阶段。');return;}
        if(s.deployUncertain){refuse('生产发布结果尚不确定；先由管理员运行 reconcile-deploy 核对，不会盲目重发部署。');return;}
        this.store.enqueue(s,s.failedKind,s.summary);return;
    }
  }
  startNext():Promise<void>|undefined {
    if(this.active||this.stopped)return;
    const job=this.store.jobs().find(j=>j.status==='queued');if(!job)return;
    const abort=new AbortController();job.status='running';this.store.saveJob(job);
    const promise=this.runJob(job,abort.signal).finally(()=>{this.active=undefined;});this.active={job,abort,promise};return promise;
  }
  private async runJob(job:Job,signal:AbortSignal) {
    let s=this.store.session(job.sessionId)!;const epoch=s.cancellationEpoch;
    const runInfo:Record<string,unknown>={kind:job.kind,status:'running',startedAt:new Date().toISOString(),cancellationEpoch:epoch};
    this.store.run(job.id,s.id,runInfo);
    const alive=()=>{const current=this.store.session(s.id)!;if(current.cancellationEpoch!==epoch||current.state==='CANCELLED'||signal.aborted)throw new Error('CANCELLED');return current;};
    const save=()=>{const current=alive();s.thread=current.thread;s.threadId=current.threadId;s.cancellationEpoch=current.cancellationEpoch;this.store.save(s);};
    try{
      if(job.kind==='merge'){
        if(!s.reviewSha||!s.prNumber)throw new Error('Missing reviewed PR');
        const local=await import('../src/git.js').then(m=>m.git(s.worktree!,['rev-parse','HEAD'],{signal}));if(local!==s.reviewSha)throw new Error('Review head changed');alive();
        try{s.mergeSha=await this.work.merge(s,signal);}catch(e){alive();if(safeError(e)==='BASE_ADVANCED'){
          s.state='QUEUED';s.reviewNotice=undefined;this.store.save(s);this.store.enqueue(s,'develop','主分支已推进，请合入最新主分支并重新验证，保留当前功能；生成新的 Review。');this.store.recordProgress(s,'revalidation','主分支已推进；重新测试、截图和 Review 后再批准。');job.status='done';this.store.saveJob(job);this.store.run(job.id,s.id,{...runInfo,status:'revalidate',finishedAt:new Date().toISOString()});return;
        }throw e;}
        alive();s.state='MERGED';s.summary=`已合并 ${s.prUrl}\n提交：${s.mergeSha}`;
        s.mergeNotice=this.store.notify(s,'merge',`${s.summary}\n生产尚未发布。要发布这个提交，请直接回复 DEPLOY。`).id;save();
      }else if(job.kind==='deploy'){
        s.state='DEPLOYING';save();await this.work.deploy(s,signal);alive();s.state='DONE';s.deployUncertain=false;
        this.store.notify(s,'deployed',`生产发布完成并通过检查。\n提交：${s.mergeSha}\nhttps://${this.config.repositories[s.repo].deployment?.domain}`);save();
      }else{
        if(job.kind==='catalog'||job.kind==='interpret')throw new Error('Job requires multi-project controller');
        const phase=job.kind;s.state=phase==='plan'?'PLANNING':'RUNNING';s.blockedPhase=phase;save();
        if(s.productId&&!this.config.productDocs)throw new Error('Product document checkout is not configured');
        await this.work.prepare(s,signal);save();
        if(phase==='develop'){await this.work.updateBase(s,signal);save();}
        const result=await this.work.run(s,phase,job.feedback,signal,id=>{const current=alive();current.thread=id;this.store.save(current);s.thread=id;});
        runInfo.outcome=result.outcome;runInfo.thread=s.thread;
        alive();s.summary=result.summary;
        s.mailBrief=result.mailBrief;
        if(result.requiresBackend||result.outcome==='blocked'){s.state='WAITING_INPUT';s.blockedPhase=phase;this.store.notify(s,'blocked',`${result.summary}\n${result.questions.join('\n')}\n首版不接入生产后端或数据库。回复补充信息/调整范围，或 CANCEL。`);save();}
        else if(result.outcome==='needs_input'){s.state='WAITING_INPUT';s.blockedPhase=phase;this.store.notify(s,'input',`${result.summary}\n\n${result.questions.join('\n')}\n请直接回复补充信息。`);save();}
        else if(phase==='plan'){
          if(result.outcome!=='plan_ready')throw new Error('Unexpected planning outcome');
          s.state='WAITING_START';s.planNotice=this.store.notify(s,'plan',`${result.summary}\n\n直接回复 START 开始实施，或回复意见继续讨论方案。`).id;save();
        }else{
          if(result.outcome!=='implementation_ready')throw new Error('Unexpected development outcome');
          await this.work.verifyScope(s,signal);alive();s.reviewSha=await this.work.commit(s,signal);save();
          const checks=await this.work.build(s,signal);alive();s.reviewSha=await this.work.commit(s,signal);s.revision++;
          const preview=await this.work.capture(s,result,signal);alive();await this.work.push(s,signal);alive();await this.work.ensurePr(s,[...checks,...preview.checks],signal);alive();
          s.checks=[...checks,...preview.checks];runInfo.checks=s.checks;runInfo.artifacts=preview.directory;
          const productPr=await this.work.productRecord?.(s,preview.attachments);alive();
          s.state='WAITING_REVIEW';s.blockedPhase=undefined;
          s.reviewNotice=this.store.notify(s,'review',`${s.id} · Review #${s.revision}\n\n${result.summary}\n\nPR：${s.prUrl}\n提交：${s.reviewSha}\n${productPr?`产品记录 PR：${productPr}\n`:''}\n测试：\n${[...checks,...preview.checks].join('\n')}\n\n截图见下方及附件。\n直接回复 APPROVE 合并这个版本；回复文字意见继续修改。生产发布需合并后另回 DEPLOY。`,preview.attachments).id;save();
        }
      }
      job.status='done';this.store.saveJob(job);this.store.event(s.id,'job_completed',{kind:job.kind});
      this.store.run(job.id,s.id,{...runInfo,status:'done',finishedAt:new Date().toISOString(),reviewSha:s.reviewSha,mergeSha:s.mergeSha});
    }catch(e){const current=this.store.session(s.id)!;job.status=current.state==='CANCELLED'?'cancelled':'failed';this.store.saveJob(job);
      const detail=e as {stdout?:string;stderr?:string};
      if(detail.stdout||detail.stderr){try{const directory=join(this.config.dataDir,'runs',s.id,job.id);await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,'failure.json');await writeFile(path,JSON.stringify({error:safeError(e),stdout:detail.stdout,stderr:detail.stderr}),{mode:0o600});runInfo.diagnostics=path;}catch{runInfo.diagnostics='unavailable';}}
      this.store.run(job.id,s.id,{...runInfo,status:job.status,finishedAt:new Date().toISOString(),error:safeError(e)});
      if(current.state==='CANCELLED')return;
      current.state='FAILED';current.failedKind=job.kind;current.lastError=safeError(e);
      // The adapter persists deployUncertain immediately before the first
      // production effect. Missing config/build failures are safe to retry.
      this.store.save(current);this.store.notify(current,'failure',`${current.id} 执行失败：${current.lastError}\n${current.deployUncertain?'生产结果需要核对，暂不自动重试。':'修复条件后回复 RETRY，或回复意见调整任务。'}`);this.store.event(current.id,'job_failed',{kind:job.kind,error:current.lastError});
    }
  }
  async stop(){this.stopped=true;if(this.active){this.active.abort.abort();await this.active.promise;}}
}
