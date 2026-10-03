import {validateScope,ScopeResolutionError} from './scope.js';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Controller, safeError } from './controller.js';
import { ProjectRegistry, digest, type PreparedProject } from './projects.js';
import { ProjectMemoryService } from './memory.js';
import { validateProfile } from './profile.js';
import type { Session, Incoming, Job, RepoExecution } from './types.js';
import type { RunResult } from './runner.js';
import { planManifest, type MultiWork } from './multi-work.js';
import {currentBinding,replyBinding,bindingValid,approvalVersion} from './approval.js';
import {ensureWorkflow,readWorkflowGuide,stageBinding,stageLabel,advanceCompletedStage,WorkflowProposalSchema} from './workflow.js';
import {isSemanticDecision,validateDecision} from './reply-interpreter.js';
import type {SemanticDecision,ExecutionFact,MailQuestion,QuestionInput,ReplyContext,ApprovalBinding} from './types.js';
const fingerprint = (t: RepoExecution) => digest({ profile: t.profile, baseBranch: t.baseBranch, mergeMethod: t.mergeMethod || 'merge', deployment: t.deployment });
export function manifest(s: Session) { return digest({ ...stageBinding(s), documents: s.documentVersion, order: s.mergeOrder, references:(s.references||[]).map(t=>({identity:t.identity,base:t.baseSha,profile:t.profileVersion})), targets: s.targets!.map(t => ({ identity: t.identity,...(s.workflow&&!s.workflow.legacy?{mode:t.auxiliary?'evidence':'model',evidence:!!t.recordEvidence}:{}), profile: t.profileVersion, base: t.baseSha, head: t.reviewSha, pr: t.prNumber, checks: t.checks, pending: t.pendingChecks, merged: t.mergeSha, deploy: t.deployment })) }); }
export class MultiController extends Controller {
    private collectedHelp?:string[];
    private collectedStatus?:string[];
    private intentActive?: {job:Job;abort:AbortController;promise:Promise<void>};
    private multiActive?: {
        job: Job;
        abort: AbortController;
        promise: Promise<void>;
    };
    constructor(...args: [
        ...ConstructorParameters<typeof Controller>,
        ProjectRegistry,
        MultiWork
    ]) { const [config, store, mail, legacy, registry, multiWork] = args; super(config, store, mail, legacy); this.registry = registry; this.multiWork = multiWork; }
    readonly registry: ProjectRegistry;
    readonly multiWork: MultiWork;
    private pending(s: Session) { return this.store.jobs().some(j => j.sessionId === s.id && j.kind!=='interpret' && ['queued', 'running'].includes(j.status)); }
    private validReply(s: Session, notice: string | undefined, reply: string) { return !!notice && notice === reply && this.store.mail(notice)?.status === 'sent' && !this.pending(s); }
    private assertVersions(s: Session, plan = false) { for (const t of s.targets!) {
        const p = this.registry.get(t.projectId);
        if (p.identity !== t.identity || p.version !== (plan ? s.planRegistryVersions?.[t.projectId] : t.profileVersion))
            throw new Error(`项目 ${t.projectId} 的配置或身份已变化，请回复意见获取新方案`);
    } }
    private assertReferences(s:Session){for(const t of s.references||[])if(this.registry.changed(t))throw new Error('只读参考配置变化，需新方案和 START');}
    override handle(incoming: Incoming) {
        this.store.transaction(() => {
            if (this.store.seen(incoming.id))
                return;
            if (!incoming.trusted) {
                this.store.remember(incoming.id, incoming.rfcId, incoming.threadId, undefined, incoming.reason || 'rejected');
                return;
            }
            const candidates = new Set<string>(), id = /\[(DEV-\d{8}-\d+)\]/.exec(incoming.subject)?.[1];
            if (id && this.store.session(id))
                candidates.add(id);
            const reply = this.store.replyMail(incoming.inReplyTo);
            for(const ref of incoming.references||[]){const linked=this.store.replyMail(ref);if(linked)candidates.add(linked.sessionId);}
            if (reply)
                candidates.add(reply.sessionId);
            for (const s of this.store.sessions())
                if (s.threadId === incoming.threadId || s.initialThreadId === incoming.threadId)
                    candidates.add(s.id);
            const prior = this.store.inboundSession(incoming.inReplyTo, incoming.threadId);
            if (prior)
                candidates.add(prior);
            if (candidates.size > 1) {
                this.store.remember(incoming.id, incoming.rfcId, incoming.threadId, undefined, 'routing_conflict');
                return;
            }
            let s = candidates.size ? this.store.session([...candidates][0]) : undefined;
            if (s?.system)
                s = undefined;
            if (!s) {
                const taskId=this.store.newId(), title=incoming.subject.trim()||'新需求';
                s={id:taskId,repo:'',title,state:'QUEUED',subject:`[${taskId}] ${title}`,createdAt:new Date().toISOString(),initialMessageId:incoming.id,initialRfcId:incoming.rfcId,initialThreadId:incoming.threadId,threadId:incoming.threadId,summary:incoming.text||title,originalRequest:incoming.subject+'\n'+incoming.text,targets:[],references:[],mergeOrder:[],blockedPhase:'plan',cancellationEpoch:0,revision:0};
                ensureWorkflow(s);this.store.save(s);
                this.store.recordProgress(s,'ack','已接收，等待 Codex 理解新邮件。');
                this.enqueueReply(s,incoming);
                const job=this.store.jobs().at(-1)!;job.reply!.mode='intake';
                if(id||incoming.inReplyTo)job.reply!.facts=[{code:'guard_rejected',text:'回复指向的任务或通知不存在；不可据此授予执行权限。'}];
                this.store.saveJob(job);
            } else {
                this.advanceReplies(s);
                this.enqueueReply(s,incoming);
            }
            this.store.remember(incoming.id, incoming.rfcId, incoming.threadId, s?.id, s ? 'accepted' : 'unrouted');
            if (s)
                this.store.event(s.id, 'mail_received', { messageId: incoming.id });
        });
    }
    private multiFeedback(s: Session, text: string, phase:'plan'|'develop') {
        if(!['plan','develop'].includes(phase)){this.help(s,'旧待处理反馈缺少 Codex 的阶段决策，不能据此写入。');return;}
        if (s.mergeUncertain||s.targets?.some(t=>t.deployUncertain)||s.targets?.some(t => t.mergeSha) || ['MERGING', 'MERGED', 'DEPLOYING', 'DONE', 'CANCELLED'].includes(s.state)) {
            this.help(s,'已进入合并阶段的仓库只读；额外修改请作为后续需求提出。');
            return;
        }
        // The model selects the phase; guards may refuse but cannot reinterpret feedback.
        if(phase==='develop'&&(s.workflow&&!s.workflow.confirmed&&!s.workflow.legacy||[...(s.targets||[]),...(s.references||[])].some(t=>this.registry.entries.has(t.projectId)&&this.registry.changed(t)))){
            this.help(s,'修改尚未绑定有效确认范围或配置已变化；需要先规划并重新确认。');return;
        }
        s.reviewNotice = undefined;
        s.planNotice = undefined;
        s.lastError = undefined;
        s.blockedPhase = phase;
        this.store.save(s);
        this.store.enqueue(s, s.blockedPhase, text);
    }
    private control(s: Session, command: string, reply: string, project?: string) {
        const refuse = (v: string) => this.help(s,v);
        if (command === 'STATUS') {
            const text=s.lastError?`当前阻塞：${s.lastError}`:`当前状态：${s.state}。${s.mailBrief?.changes.length?'最近变化见下方。':'暂无新的阶段变化。'}`;
            if(this.collectedStatus)this.collectedStatus.push(text);this.store.recordProgress(s,'status-requested',text);
            return;
        }
        if (command === 'CANCEL') {
            if (s.targets?.some(t => t.deployUncertain || t.deployed)) {
                refuse('已进入生产发布，先核对各项目的发布结果。');
                return;
            }
            s.cancellationEpoch++;
            s.state = 'CANCELLED';
            this.store.save(s);
            for (const j of this.store.jobs().filter(j => j.sessionId === s.id && j.status === 'queued')) {
                j.status = 'cancelled';
                this.store.saveJob(j);
            }

            if (this.multiActive?.job.sessionId === s.id)
                this.multiActive.abort.abort();
            this.store.recordProgress(s,'cancel','任务已取消，保留已有分支与已知外部结果。');
            return;
        }
        if (command === 'START') {
            if (s.state !== 'WAITING_START' || !this.validReply(s, s.planNotice, reply)) {
                refuse('无法开始：当前不是等待确认方案，或回复未关联有效最新方案，或有待处理工作。');
                return;
            }
            s.pendingStart=true;
            s.state = 'QUEUED';
            s.blockedPhase = 'develop';
            s.profileVersions = Object.fromEntries(s.targets!.map(t => [t.projectId, t.profileVersion]));
            this.store.save(s);
            this.store.enqueue(s, 'develop', `实施确认方案：\n${s.summary}`);
            return;
        }
        if (command === 'APPROVE') {
            if (s.targets?.some(t => t.manualMerge)) {
                refuse('包含 mail-to-code 自身，整批 PR 必须手动合并；邮件不会合并、升级或重启服务。');
                return;
            }
            if (s.state !== 'WAITING_REVIEW' || !this.validReply(s, s.reviewNotice, reply) || s.reviewManifest !== manifest(s)) {
                refuse('无法合并：需要有效最新 Review，全部版本一致且没有待处理工作。');
                return;
            }
            s.state = 'MERGING';
            this.store.save(s);
            this.store.enqueue(s, 'merge', s.reviewManifest!);
            return;
        }
        if (command === 'DEPLOY') {
            if (!['MERGED', 'DONE'].includes(s.state) || !this.validReply(s, s.mergeNotice, reply)) {
                refuse('无法发布：需要回复有效最新合并通知，提交与发布目标必须一致。');
                return;
            }
            const targets = s.targets!;
            if (!project && targets.length > 1) {
                refuse('跨仓库任务请使用 DEPLOY <项目别名>。');
                return;
            }
            const t = targets.find(t => t.projectId === (project || s.repo));
            if (!t?.mergeSha || t.manualMerge) {
                refuse('该目标未合并，或没有启用发布 adapter。');
                return;
            }
            if (t.deployed) {
                refuse('该提交已发布。');
                return;
            }
            s.deployTarget = t.projectId;
            s.state = 'DEPLOYING';
            this.store.save(s);
            this.store.enqueue(s, 'deploy', t.projectId);
            return;
        }
        if (command === 'RETRY') {
            const failed=this.store.jobs().find(j=>j.sessionId===s.id&&j.kind==='interpret'&&j.status==='failed');
            if(failed&&s.state!=='CANCELLED'){failed.status='queued';this.store.saveJob(failed);return;}
            if (s.state !== 'FAILED' || !s.failedKind || this.pending(s)) {
                refuse('当前无可重试阶段。');
                return;
            }
            if (s.targets?.some(t => t.deployUncertain) || s.mergeUncertain) {
                refuse('外部操作结果不确定，管理员先运行 reconcile。');
                return;
            }
            if (s.failedKind === 'merge') {
                s.reviewNotice = undefined;
                s.state = 'QUEUED';
                this.store.save(s);
                this.store.enqueue(s, 'develop', '__REVALIDATE__');
                this.store.recordProgress(s,'revalidation','合并批准已失效；重新验证剩余 PR 后发送新 Review。');
                return;
            }
            this.store.enqueue(s, s.failedKind==='develop'&&s.blockedPhase==='plan'?'plan':s.failedKind, s.failedKind === 'deploy' ? s.deployTarget! : s.summary);
        }
    }
    private earlierReply(job:Job){const jobs=this.store.jobs(),index=jobs.findIndex(j=>j.id===job.id);return jobs.slice(0,index).some(j=>j.sessionId===job.sessionId&&j.kind==='interpret'&&!['done','cancelled'].includes(j.status));}
    private intentPending(id:string){return this.store.jobs().some(j=>j.sessionId===id&&j.kind==='interpret'&&['queued','running'].includes(j.status));}
    private enqueueReply(s:Session,incoming:Incoming){
        const job=this.store.enqueue(s,'interpret',incoming.text);
        const parent=this.store.replyMail(incoming.inReplyTo);
        job.reply={incoming:structuredClone(incoming),epoch:s.cancellationEpoch,stageId:s.workflow?.stageId,binding:replyBinding(this.store,s,incoming.inReplyTo),parent:parent?.status==='sent'&&parent.sessionId===s.id&&parent.identityStatus==='verified'?{id:parent.id,text:parent.text,questions:(parent.questions||[]).filter(q=>!s.conversation?.answered.includes(q.id))}:undefined};job.reply.previous=this.store.mails().filter(m=>m.sessionId===s.id&&m.id!==parent?.id&&m.status==='sent'&&m.identityStatus==='verified').slice(-4).map(m=>({id:m.id,text:m.text,questions:(m.questions||[]).filter(q=>!s.conversation?.answered.includes(q.id))}));this.store.saveJob(job);
    }
    private decisionSnapshot(s:Session){return digest({state:s.state,epoch:s.cancellationEpoch,stage:s.workflow?.stageId,plan:approvalVersion(s,'START'),review:approvalVersion(s,'APPROVE'),merge:approvalVersion(s,'DEPLOY')});}
    private observe(s:Session,facts:ExecutionFact[],candidate?:ReplyContext['candidate']){
        const job=this.store.enqueue(s,'interpret','理解执行事实并决定是否需要人回复');
        job.reply={mode:'outcome',facts,candidate,snapshot:this.decisionSnapshot(s),epoch:s.cancellationEpoch,stageId:s.workflow?.stageId,incoming:{id:job.id,rfcId:'',inReplyTo:'',threadId:s.threadId||s.initialThreadId,subject:s.subject,text:'',from:this.config.ownerAddress,trusted:true}};
        this.store.saveJob(job);return job;
    }
    private help(s:Session,text:string){
        if(this.collectedHelp){this.collectedHelp.push(text);return;}
        this.store.recordProgress(s,'guard-rejected',text);
        this.observe(s,[{code:'guard_rejected',text}]);
    }
    private input(s:Session,text:string,questions:QuestionInput[]){this.observe(s,[{code:'outcome',text}],{kind:'input',text,questions});}
    private announce(s:Session,kind:string,text:string,attachments:import('./types.js').Attachment[]=[],scopeChange?:import('./types.js').ScopeChange){
        const action=kind==='plan'?'START':kind==='review'?'APPROVE':kind==='merge'&&s.workflow?.proposal?.kind!=='documentation'?'DEPLOY':undefined;
        this.observe(s,[{code:'outcome',text}],{kind,text,attachments,scopeChange,action,version:action?approvalVersion(s,action):undefined});
    }
    private communicate(s:Session,decision:SemanticDecision,context:ReplyContext){
        this.store.recordProgress(s,'semantic-decision',JSON.stringify({communication:decision.communication,nextStep:decision.nextStep,questions:decision.questions}));
        if(decision.communication.kind==='internal')return;
        const candidate=context.candidate;
        if(decision.communication.kind==='ask_human'&&candidate&&['plan','review'].includes(candidate.kind)){s.state='WAITING_INPUT';s.blockedPhase=candidate.kind==='plan'?'plan':'develop';s.planNotice=undefined;s.reviewNotice=undefined;this.store.save(s);}
        const action=decision.communication.kind==='confirmation'||decision.communication.kind==='final_result'&&candidate?.kind==='merge'?candidate?.action:undefined;
        if(action&&candidate?.version!==approvalVersion(s,action))throw Error('REPLY_CONFIRMATION_STALE');
        const kind=action?candidate!.kind:decision.communication.kind==='requested_status'?(candidate?.kind==='projects'?'projects':'status'):decision.communication.kind==='final_result'?(candidate?.kind||'result'):(candidate&&['plan','review'].includes(candidate.kind)?'input':candidate&&['input','config-change','failure'].includes(candidate.kind)?candidate.kind:'help');
        const existing=currentBinding(s);
        const mail=this.store.notify(s,kind,decision.communication.text,candidate?.attachments||[],{preserveBinding:!!action,scopeChange:action==='START'?candidate?.scopeChange:undefined,binding:action?undefined:existing,questions:decision.questions.map(q=>({...q,dependsOn:q.dependsOn.map(id=>context.incoming.id+'/'+id),binding:q.action===existing?.action?existing:undefined}))});
        if(action){if(action==='START')s.planNotice=mail.id;else if(action==='APPROVE')s.reviewNotice=mail.id;else s.mergeNotice=mail.id;this.store.save(s);}
    }
    private applyCommand(s:Session,command:string,binding:ApprovalBinding|undefined,rawReply:string,project?:string){
        if(['START','APPROVE','DEPLOY'].includes(command)){
            if(this.store.jobs().some(j=>j.sessionId===s.id&&j.kind==='interpret'&&j.status==='failed')){this.help(s,'有尚未完成的回复理解；请先 RETRY 重试，或 CANCEL 取消，不能跳过反馈批准。');return;}
            const states=command==='START'?['WAITING_START']:command==='APPROVE'?['WAITING_REVIEW']:['MERGED','DONE'];
            if(!states.includes(s.state)){this.help(s,`当前阶段不允许 ${command}：${s.state}。`);return;}
            if(this.pending(s)){this.help(s,'任务正在执行或有待处理工作；完成后请确认新的版本通知。');return;}
            if(!binding||binding.action!==command||!bindingValid(s,binding)){
                const pending=this.store.mails().some(m=>m.sessionId===s.id&&m.status==='sent'&&m.identityStatus==='pending');
                this.help(s,pending&&!binding?'邮件身份仍待核对，暂不能确认操作；不会重发原邮件。':'回复没有绑定有效最新版本；旧通知或其他操作的确认不能沿用。');return;
            }
            rawReply=binding.noticeId;
        }
        this.control(s,command,rawReply,project);
    }
    private startBusiness():Promise<void>|undefined{
        if(this.multiActive||this.stopped)return;
        this.store.transaction(()=>{for(const s of this.store.sessions())if(s.conversation)this.advanceReplies(s);});
        const job=this.store.transaction(()=>{if(this.store.jobs().some(j=>j.kind!=='interpret'&&j.status==='running'))return;const next=this.store.jobs().find(j=>j.kind!=='interpret'&&j.status==='queued'&&!this.intentPending(j.sessionId)&&!this.store.jobs().some(r=>r.sessionId===j.sessionId&&r.kind==='interpret'&&r.status==='failed'));if(next){next.status='running';this.store.saveJob(next);}return next;});
        if(!job)return;
        const abort=new AbortController(),promise=this.executeMulti(job,abort.signal).finally(()=>{this.multiActive=undefined;});this.multiActive={job,abort,promise};return promise;
    }
    override startNext():Promise<void>|undefined{
        if(this.stopped)return;
        if(!this.intentActive){const job=this.store.jobs().find(j=>j.kind==='interpret'&&j.status==='queued'&&!(j.reply?.mode==='outcome'&&this.store.jobs().some(b=>b.sessionId===j.sessionId&&b.kind!=='interpret'&&b.status==='running'))&&!(j.reply?.waitingForEarlier&&this.earlierReply(j)));if(job){job.status='running';this.store.saveJob(job);const abort=new AbortController();const promise=this.executeReply(job,abort.signal).finally(()=>{this.intentActive=undefined;}).then(async()=>{await this.startBusiness();});this.intentActive={job,abort,promise};return promise;}}
        return this.startBusiness();
    }
    private acceptDecision(s:Session,job:Job,decision:SemanticDecision,context:ReplyContext){
        if(context.mode==='outcome'){
            if(decision.nextStep!=='wait'){
                if(s.state==='CANCELLED'||s.mergeUncertain||s.targets?.some(t=>t.deployUncertain))throw Error('REPLY_NEXT_STAGE_GUARD');
                if(decision.nextStep==='revise'&&decision.revisionPhase!=='plan')throw Error('REPLY_OUTCOME_CANNOT_AUTHORIZE');
                if(!this.pending(s)){
                    if(['MERGED','DONE'].includes(s.state)&&!advanceCompletedStage(s))throw Error('REPLY_NEXT_STAGE_GUARD');
                    s.planNotice=undefined;s.reviewNotice=undefined;this.store.save(s);
                    const retained=s.conversation?.records.filter(r=>context.facts?.some(f=>f.itemId===r.id)&&r.item.action==='feedback'&&r.item.clear&&r.status==='blocked'&&!r.jobIds?.length)||[];
                    const plan=this.store.enqueue(s,'plan','Codex 根据执行事实决定只读规划；已有成果保留，写入需要当前阶段有效授权。\n'+retained.map(r=>r.item.text||r.item.evidence).join('\n'));
                    for(const r of retained){r.revisionPhase='plan';r.status='queued';r.jobIds=[plan.id];}this.store.save(s);
                }
            }
            this.communicate(s,decision,context);return;
        }
        s.conversation ||= {records:[],requests:[],answered:[]};
        const c=s.conversation;
        const modifies=decision.items.some(i=>i.clear&&i.action==='feedback');
        const cancels=decision.items.some(i=>i.clear&&i.action==='cancel');
        const controls=decision.items.some(i=>i.clear&&['start','approve','deploy'].includes(i.action));
        for(const item of decision.items){
            const id=context.incoming.id+'/'+item.id;if(c.records.some(r=>r.id===id))continue;
            const allQuestions=[...(context.parent?.questions||[]),...(context.previous||[]).flatMap(m=>m.questions)];
            const referenced=item.questionRefs.map(id=>allQuestions.find(q=>q.id===id)).filter((q):q is MailQuestion=>!!q);
            const binding=context.parent?.questions.find(q=>item.questionRefs.includes(q.id)&&q.kind==='confirm'&&q.action===item.action.toUpperCase())?.binding||context.binding;
            let reason=!item.clear||item.action==='clarify'?'Codex 标记该事项尚不明确':undefined;
            if(item.questionRefs.some(id=>c.answered.includes(id)))reason='关联问题已处理，不重复执行';
            if(modifies&&['start','approve','deploy'].includes(item.action))reason='本轮修改使当前交付物的批准失效';
            if(cancels&&controls&&['cancel','start','approve','deploy'].includes(item.action))reason='取消与批准执行同时出现，不能执行冲突动作';
            c.records.push({id,source:context.incoming.id,stageId:context.stageId,item:structuredClone(item),dependencies:referenced.flatMap(q=>q.dependsOn),binding,status:reason?'blocked':'accepted',reason,revisionPhase:decision.revisionPhase||undefined});
        }
        this.store.save(s);this.collectedHelp=[];this.collectedStatus=[];
        try{this.advanceReplies(s);}finally{
            const notes=this.collectedHelp!;this.collectedHelp=undefined;this.collectedStatus=undefined;
            const fresh=this.store.session(s.id)!;
            const records=fresh.conversation!.records.filter(r=>r.source===context.incoming.id);
            for(const r of records.filter(r=>r.status==='blocked'))r.factReported=true;this.store.save(fresh);
            const facts:ExecutionFact[]=[...records.filter(r=>r.status==='blocked').map(r=>({code:'item_blocked' as const,itemId:r.id,item:r.item,text:r.reason!})),...notes.map(text=>({code:'guard_rejected' as const,text}))];
            this.store.recordProgress(fresh,'reply-receipt',JSON.stringify(records));
            if(facts.length){this.observe(fresh,facts,{kind:'reply-reconciliation',text:decision.communication.text,questions:structuredClone(decision.questions),sourceDecision:decision});}
            else this.communicate(fresh,decision,context);
            if(decision.nextStep==='analyze'&&!this.pending(fresh)&&fresh.state!=='CANCELLED'){
                if(['MERGED','DONE'].includes(fresh.state)&&!advanceCompletedStage(fresh))throw Error('REPLY_NEXT_STAGE_GUARD');
                fresh.planNotice=undefined;fresh.reviewNotice=undefined;this.store.save(fresh);this.store.enqueue(fresh,'plan',fresh.originalRequest||fresh.summary);
            }
        }
    }
    private advanceReplies(s:Session){
        const c=s.conversation;if(!c)return;
        const ownsCollection=this.collectedHelp===undefined;if(ownsCollection)this.collectedHelp=[];
        const jobs=this.store.jobs();
        for(const r of c.records.filter(r=>r.status==='queued')){
            const effects=(r.jobIds||[]).map(id=>jobs.find(j=>j.id===id));
            if(effects.some(j=>!j||['failed','cancelled'].includes(j.status))){r.status='blocked';r.reason='前置执行失败或结果待核实，不能继续依赖动作。';}
            else if(effects.length&&effects.every(j=>j!.status==='done'))r.status='done';
        }
        for(const r of c.records.filter(r=>['accepted','waiting'].includes(r.status))){
            // A previous iteration may have queued this item in a feedback batch.
            if(!['accepted','waiting'].includes(r.status))continue;
            if(s.state==='CANCELLED'&&r.item.action!=='status'){r.status='blocked';r.reason='任务已取消';continue;}
            const dependencies=[...r.item.dependsOn.map(id=>r.source+'/'+id),...(r.dependencies||[])].map(id=>c.records.find(d=>d.id===id));
            if(dependencies.some(d=>!d||d.status==='blocked')){r.status='blocked';r.reason='依赖事项未获批准或执行失败';continue;}
            if(dependencies.some(d=>d!.status!=='done')){r.status='waiting';continue;}
            if(r.item.action==='future'){
                if(!c.requests.some(q=>q.id===r.id))c.requests.push({id:r.id,text:r.item.text||r.item.evidence,source:r.source,stageId:r.stageId});
                r.status='done';for(const q of r.item.questionRefs)if(!c.answered.includes(q))c.answered.push(q);continue;
            }
            if(r.stageId&&r.stageId!==s.workflow?.stageId){r.status='blocked';r.reason='阶段已变化，需确认新方案';continue;}
            const immediate=['status','cancel','retry'].includes(r.item.action);
            const sourceJob=this.store.jobs().find(j=>j.reply?.incoming.id===r.source);
            if(!immediate&&(this.pending(s)||sourceJob&&this.earlierReply(sourceJob))){r.status='waiting';continue;}
            const before=this.store.jobs().map(j=>({id:j.id,status:j.status}));
            // Independent changes from one reply describe one revised delivery.
            // Retain each item, but bind them to the same job and completion.
            // Unmet dependencies and control actions are never folded into it.
            const batch=r.item.action==='feedback'?c.records.filter(q=>
                q.source===r.source&&q.stageId===r.stageId&&q.item.action==='feedback'&&
                ['accepted','waiting'].includes(q.status)&&
                [...q.item.dependsOn.map(id=>q.source+'/'+id),...(q.dependencies||[])].every(id=>c.records.find(d=>d.id===id)?.status==='done')
            ):[r];
            if(r.item.action==='feedback')this.multiFeedback(s,batch.map(q=>q.item.text||q.item.evidence).join('\n\n'),r.revisionPhase!);
            else if(r.item.action==='catalog'){s.system=true;this.store.save(s);this.store.enqueue(s,'catalog','');}
            else this.applyCommand(s,r.item.action.toUpperCase(),r.binding,r.binding?.noticeId||'',r.item.project);
            const added=this.store.jobs().filter(j=>j.sessionId===s.id&&(j.kind!=='interpret'||r.item.action==='retry')&&j.status==='queued'&&!before.some(b=>b.id===j.id&&b.status==='queued'));
            for(const record of batch){
                record.jobIds=added.map(j=>j.id);
                if(added.length)record.status='queued';
                else if(record.item.action==='status'||record.item.action==='cancel'&&(s as Session).state==='CANCELLED')record.status='done';
                else{record.status='blocked';record.reason='当前阶段、版本或权限不允许执行此事项';}
                if(['queued','done'].includes(record.status))for(const q of record.item.questionRefs)if(!c.answered.includes(q))c.answered.push(q);
            }
        }
        this.store.save(s);
        if(ownsCollection){
            const notes=this.collectedHelp!;this.collectedHelp=undefined;
            const blocked=c.records.filter(r=>r.status==='blocked'&&!r.factReported);
            for(const r of blocked)r.factReported=true;this.store.save(s);
            const facts:ExecutionFact[]=[...blocked.map(r=>({code:'item_blocked' as const,itemId:r.id,item:r.item,text:r.reason||'执行被守卫阻止'})),...notes.map(text=>({code:'guard_rejected' as const,text}))];
            if(facts.length)this.observe(s,facts);
        }
    }
    private async executeReply(job:Job,signal:AbortSignal){
        try{
            const context=job.reply;if(!context)throw Error('REPLY_CONTEXT_MISSING');
            const snapshot=this.store.session(job.sessionId)!;
            if(snapshot.cancellationEpoch!==context.epoch||(context.stageId&&context.stageId!==snapshot.workflow?.stageId)){job.status='cancelled';this.store.saveJob(job);return;}
            // Old pending command/result envelopes are reinterpreted. Applied jobs are never replayed.
            const result=isSemanticDecision(context.result)?context.result:await this.multiWork.interpretReply(snapshot,context,signal);
            signal.throwIfAborted();
            const decision=validateDecision(JSON.parse(JSON.stringify(result,(_k,v)=>v===undefined?null:v)),context,snapshot);
            context.result=decision;delete context.command;delete context.project;this.store.saveJob(job);
            this.store.transaction(()=>{
                const s=this.store.session(job.sessionId)!;
                if(s.cancellationEpoch!==context.epoch||(context.stageId&&context.stageId!==s.workflow?.stageId)){job.status='cancelled';this.store.saveJob(job);return;}
                if(context.mode==='outcome'&&context.snapshot&&context.snapshot!==this.decisionSnapshot(s)){job.status='done';this.store.saveJob(job);this.store.recordProgress(s,'stale-observation','执行事实已被后续版本替代，不发送旧确认。');return;}
                const immediate=decision.items.length>0&&decision.items.every(i=>['status','cancel','retry'].includes(i.action));
                if(this.earlierReply(job)&&!immediate){context.waitingForEarlier=true;job.status='queued';this.store.saveJob(job);this.store.recordProgress(s,'reply-waiting','等待先前回复处理');return;}
                context.waitingForEarlier=false;
                this.acceptDecision(s,job,decision,context);
                job.status='done';this.store.saveJob(job);this.store.event(s.id,'reply_interpreted',{messageId:context.incoming.id,action:decision.items.map(i=>i.action),communication:decision.communication.kind});
            });
        }catch(e){
            const saved=this.store.jobs().find(j=>j.id===job.id)!;if(saved.status==='cancelled')return;
            job.status=this.store.session(job.sessionId)?.state==='CANCELLED'?'cancelled':signal.aborted?'queued':'failed';this.store.saveJob(job);
            this.store.run(job.id,job.sessionId,{kind:'interpret',status:job.status,error:safeError(e)});
            if(!signal.aborted&&!this.store.get('semantic-failure:'+job.id)){this.store.notify(this.store.session(job.sessionId)!,'failure','Codex 理解未完成：'+safeError(e)+'。本次未完成的语义动作已停止；管理员检查服务后重试。');this.store.set('semantic-failure:'+job.id,'1');}
        }
    }
    private async analyzePlan(s:Session,job:Job,signal:AbortSignal,save:()=>void,alive:()=>Session){
        const currentFeedback=s.conversation?.records.filter(r=>r.stageId===s.workflow?.stageId&&r.item.clear&&r.item.action==='feedback'&&['queued','done','waiting','accepted'].includes(r.status)).slice(-12).map(r=>r.item.text||r.item.evidence).join('\n').slice(-24000);
        if(currentFeedback)job.feedback+='\n本阶段已接受的相关修改意见（按回复顺序）：\n'+currentFeedback;
        job.feedback += (s.conversation?.requests.length?'\n已确认的后续要求（不是执行授权）：\n'+s.conversation.requests.map(r=>r.text).join('\n'):'');
        const workflow=ensureWorkflow(s);workflow.legacy=false;workflow.guide=await readWorkflowGuide();workflow.confirmed=false;
        s.state='PLANNING';s.blockedPhase='plan';s.planNotice=undefined;s.reviewNotice=undefined;s.pendingStart=false;s.planningLocked=false;s.planningSnapshots={};save();
        const existing=new Map([...(s.targets||[]),...(s.references||[])].map(t=>[t.identity,t]));
        const baselines=new Map<string,string>();
        const prepared=new Map<string,PreparedProject>();
        const docsPath=await realpath(this.config.productDocs).catch(()=>this.config.productDocs);
        const input=(summary:string,questions:QuestionInput[])=>{s.state='WAITING_INPUT';s.summary=summary;save();this.input(s,summary,questions);};
        for(let round=0;round<3;round++){
            const result=await this.multiWork.analyze(s,job.feedback,signal,id=>{alive();s.analysisThreadId=id;save();});alive();
            s.analysisCandidates=result.projects.map(p=>({path:p.path,displayName:p.displayName,role:p.role}));save();
            await new ProjectMemoryService(this.config,this.store).observe(s,result,this.registry,job.id+':'+round,job.feedback).catch(()=>this.store.event(s.id,'memory_update_failed',{stage:'analysis'}));alive();
            const proposal=WorkflowProposalSchema.parse(result.workflow);
            s.mailBrief=result.mailBrief;
            if(proposal.decision==='clarify'||result.outcome!=='plan_ready'||proposal.decision!=='complete'&&result.questions.length){input(result.summary,result.questions);return;}
            if(proposal.decision==='complete'){
                if((s.targets||[]).some(t=>t.worktree&&!t.mergeSha)){input(result.summary,['仍有未合并阶段成果，请先审阅或明确取消，不能将其标为完成。']);return;}
                s.state='DONE';s.summary=result.summary;save();this.announce(s,'complete',result.summary+'\n已完成阶段：'+workflow.history.map(h=>h.proposal.name).join(' → ')+'\n未执行额外开发、合并或发布。');return;
            }
            if(!proposal.deliverables.length||!proposal.acceptance.length)throw Error('阶段方案必须声明交付物和验收方式');
            workflow.proposal=proposal;
            if(s.explicitProductId&&result.productId&&s.explicitProductId!==result.productId){input(result.summary,[`邮件指定 ${s.explicitProductId}，分析提出 ${result.productId}，请确认产品。`]);return;}
            const productId=s.explicitProductId||result.productId;
            const targets:RepoExecution[]=[],references:RepoExecution[]=[],versions:Record<string,string>={},pathMap=new Map<string,string>();
            for(const candidate of result.projects){
                if(candidate.path.startsWith('/')||candidate.path.split(/[\\/]/).includes('..'))throw new Error('分析项目路径必须在项目根目录内');
                let p=prepared.get(candidate.path);
                if(!p){p=await this.multiWork.prepareProject(candidate.path,this.registry,signal);prepared.set(candidate.path,p);}
                const isDocs=p.path===docsPath;
                if(candidate.role==='product_record'&&(!isDocs||!productId))throw new Error('产品记录仅允许配置中的产品文档仓库 及已确定产品 ID');
                let t={...existing.get(p.identity),...this.registry.target(p),displayName:candidate.displayName,relativePath:p.relativePath!};
                if(candidate.profileProposal&&s.planningLocked){
                    if(this.config.profiles[p.alias]&&digest(candidate.profileProposal)!==digest(p.profile))throw new Error('外部执行配置与方案不一致，需更新配置后重新确认');
                    if(p.profile.kind!=='generic'&&candidate.profileProposal.kind!==p.profile.kind)throw new Error('已识别项目必须保留构建/证据分类');
                    t.profile=validateProfile(candidate.profileProposal);
                    t.profileSource=this.config.profiles[p.alias]?'external':digest(t.profile)===digest(p.profile)?p.profileSource:'proposal';
                    t.profileVersion=fingerprint(t);
                }
                t.pendingChecks=[...t.profile.pendingChecks,...candidate.pendingChecks];t.auxiliary=!!productId&&isDocs&&candidate.role==='product_record'&&proposal.kind!=='documentation';t.recordEvidence=!!productId&&isDocs&&proposal.kind!=='documentation';
                versions[t.projectId]=p.version;pathMap.set(candidate.path,t.projectId);
                const destination=candidate.role==='reference'&&!t.auxiliary?references:targets;
                if([...targets,...references].some(r=>r.identity===t.identity))throw new Error('方案仓库重复，需明确读写角色');
                destination.push(t);
            }
            if(proposal.kind==='documentation'&&(!targets.length||targets.some(t=>t.path!==docsPath)))throw Error('文档阶段只能声明已配置的产品文档仓库 为写入目标');
            if(productId&&proposal.kind!=='documentation'&&!targets.some(t=>t.path===docsPath)){
                let p=prepared.get(this.config.productDocs);if(!p){p=await this.multiWork.prepareProject(this.config.productDocs,this.registry,signal);prepared.set(this.config.productDocs,p);}const t={...existing.get(p.identity),...this.registry.target(p),auxiliary:true,recordEvidence:true,displayName:'产品记录',relativePath:p.relativePath!};
                for(let i=references.length-1;i>=0;i--)if(references[i].identity===t.identity)references.splice(i,1);
                targets.push(t);versions[t.projectId]=p.version;pathMap.set(t.relativePath,t.projectId);
            }
            targets.sort((a,b)=>Number(a.path===docsPath)-Number(b.path===docsPath));
            if(!targets.length){input(result.summary,['需要确定至少一个修改项目，请描述要修改的应用或提供目录。']);return;}
            const prior=digest({targets:(s.targets||[]).map(t=>({path:t.path,version:t.profileVersion})),refs:(s.references||[]).map(t=>({path:t.path,version:t.profileVersion})),productId:s.productId,documents:s.documentVersion});
            s.productId=productId;
            const d=await this.registry.documents(productId,targets.find(t=>t.path===docsPath)?.baseSha);s.documentVersion=d.version;workflow.documents=d;
            const order=result.mergeOrder.length?result.mergeOrder.map(path=>pathMap.get(path)):targets.map(t=>t.projectId);
            const ids=targets.map(t=>t.projectId);
            // Auto-added product evidence always follows the code repositories.
            for(const t of targets.filter(t=>t.auxiliary))if(!order.includes(t.projectId))order.push(t.projectId);
            if(order.some(id=>!id||!ids.includes(id))||new Set(order).size!==ids.length||order.length!==ids.length)throw new Error('合并顺序必须包含全部修改仓库');
            const previouslyLocked=s.planningLocked,signature=digest({targets:targets.map(t=>({path:t.path,version:t.profileVersion})),refs:references.map(t=>({path:t.path,version:t.profileVersion})),productId,documents:d.version});
            s.targets=targets;s.references=references;s.repo=targets.find(t=>!t.auxiliary)?.projectId||targets[0].projectId;
            s.mergeOrder=[...order.filter(id=>targets.find(t=>t.projectId===id)?.path!==docsPath),...order.filter(id=>targets.find(t=>t.projectId===id)?.path===docsPath)] as string[];
            s.planRegistryVersions=versions;s.summary=result.summary;
            if(!previouslyLocked||signature!==prior){
                s.planningSnapshots={};
                for(const t of [...targets,...references]){s.planningSnapshots[t.relativePath!]=t.baselineSnapshot!;baselines.set(t.identity,t.baseSha!);}
                s.planningLocked=true;save();continue;
            }
            // Recheck baseline after analysis to prevent publishing a plan for a moving target.
            for(const t of [...targets,...references]){
                t.baseSha=baselines.get(t.identity);
            }
            const missing:string[]=[];
            for(const t of targets)try{await this.multiWork.validate(s,t,signal);}catch(e){missing.push((t.displayName||t.projectId)+': '+safeError(e));}
            s.planManifest=planManifest(s);save();
            if(missing.length){input(result.summary,['接入条件缺失：',...missing]);return;}
            await this.multiWork.verifyPlan(s,this.registry,signal);alive();
            s.state='WAITING_START';this.announce(s,'plan',s.summary+(job.scopeChange?'\n范围变化：\n'+job.scopeChange.changes.join('\n')+'\n原因与影响：'+job.scopeChange.reason+'\n已有成果保留；新范围在本版本 START 后才可执行。':''),[],job.scopeChange);save();return;
        }
        input(s.summary,['分析连续改变项目或配置，尚未形成稳定方案，请补充范围。']);
    }
    private async executeMulti(job: Job, signal: AbortSignal) {
        let s = this.store.session(job.sessionId)!;
        if(job.stageId&&job.stageId!==s.workflow?.stageId){job.status='cancelled';this.store.saveJob(job);return;}
        const epoch = s.cancellationEpoch;
        const alive = () => { signal.throwIfAborted(); const latest = this.store.session(s.id)!; if (latest.cancellationEpoch !== epoch || latest.state === 'CANCELLED')
            throw new Error('CANCELLED'); return latest; };
        const save = () => { const latest = alive(); s.threadId = latest.threadId; s.conversation = latest.conversation; this.store.save(s); };
        const docs = async () => { const d = await this.registry.documents(s.productId,undefined,{sync:true,signal}); if (s.documentVersion && s.documentVersion !== d.version && !(s.workflow?.legacy&&s.documentVersion===d.legacyVersion))
            throw new Error('产品文档版本变化，需新的方案和 START'); return d; };
        try {
            this.store.run(job.id, s.id, { kind: job.kind, status: 'running', startedAt: new Date().toISOString() });
            if(job.kind==='catalog'){
                await this.registry.scan(true,{sync:true,signal});alive();this.announce(s,'projects',this.registry.list());job.status='done';this.store.saveJob(job);return;
            }
            if(job.kind==='plan'){
                if(job.kind==='plan'){await this.analyzePlan(s,job,signal,save,alive);job.status='done';this.store.saveJob(job);this.store.run(job.id,s.id,{kind:'plan',status:'done'});return;}
            }
            if(s.pendingStart){
                try{await this.multiWork.verifyPlan(s,this.registry,signal);alive();for(const t of s.targets!)this.registry.approve(t);s.pendingStart=false;if(s.workflow){s.workflow.confirmed=true;s.workflow.confirmedPlan=s.summary;}s.profileVersions=Object.fromEntries(s.targets!.map(t=>[t.projectId,t.profileVersion]));save();}
                catch(e){alive();s.pendingStart=false;s.planNotice=undefined;s.state='QUEUED';s.blockedPhase='plan';save();this.store.enqueue(s,'plan',s.summary+'\nSTART 核对失败：'+safeError(e));this.store.recordProgress(s,'plan-stale',safeError(e)+'\n已重新分析；旧 START 失效，请等待新方案。');job.status='done';this.store.saveJob(job);return;}
            }
            await this.registry.refresh([...(s.targets||[]),...(s.references||[])],{sync:true,signal});
            if(job.kind==='develop'&&!s.targets?.some(t=>t.mergeSha)&&[...(s.targets||[]),...(s.references||[])].some(t=>this.registry.changed(t))){
                s.state='QUEUED';s.blockedPhase='plan';s.reviewNotice=undefined;s.planNotice=undefined;save();
                this.store.enqueue(s,'plan',job.feedback+'\n配置已变化，重新分析并等待新 START。');
                this.store.recordProgress(s,'plan-stale','项目配置或参考范围已变化，旧批准失效，正在重新分析。');
                job.status='done';this.store.saveJob(job);return;
            }
            this.assertReferences(s);
            if(s.workflow?.proposal?.kind==='documentation'){const docsPath=await realpath(this.config.productDocs);if(s.targets?.some(t=>t.path!==docsPath))throw Error('文档阶段写入范围无效');}
            if (job.kind === 'merge') {
                this.assertVersions(s);
                await docs();
                if (s.targets!.some(t => t.manualMerge) || s.reviewManifest !== job.feedback || manifest(s) !== job.feedback)
                    throw new Error('Review manifest changed');
                // Check all repositories before any effect. Expected head SHA is also passed to GitHub at each merge.
                for (const t of s.targets!)
                    if (!t.mergeSha) {
                        const merged = await this.multiWork.inspect(s, t, signal);
                        if (merged)
                            t.mergeSha = merged;
                        save();
                    }
                for (const alias of s.mergeOrder!) {
                    const t = s.targets!.find(t => t.projectId === alias)!;
                    if (t.mergeSha)
                        continue;
                    alive();
                    s.mergeUncertain = alias;
                    save();
                    const sha = await this.multiWork.merge(s, t, signal);
                    // Preserve known external results even if cancellation raced the network response.
                    const current = this.store.session(s.id)!;
                    current.targets!.find(r => r.projectId === alias)!.mergeSha = sha;
                    current.mergeUncertain = undefined;
                    this.store.save(current);
                    t.mergeSha = sha;
                    s.mergeUncertain = undefined;
                    save();
                }
                s.state = 'MERGED';
                s.partialMerge = false;
                s.summary = s.targets!.map(t => `${t.projectId}: ${t.prUrl}\nMerged commit: ${t.mergeSha}`).join('\n\n');
                this.announce(s,'merge',s.summary);
                save();
            }
            else if (job.kind === 'deploy') {
                const t = s.targets!.find(t => t.projectId === job.feedback)!;
                if(!t?.mergeSha || t.manualMerge)throw new Error('Deployment target invalid');
                if(this.registry.changed(t)){
                    const p=this.registry.get(t.projectId);t.deployment=p.deployment;t.profile=structuredClone(p.profile);t.profileVersion=p.version;
                    s.state='MERGED';this.announce(s,'merge',`发布配置已变化：${t.displayName||t.projectId}\n提交：${t.mergeSha}\n发布域名：${t.deployment?.domain||'未配置'}；${t.deployment?.enabled?'发布已启用':'发布未启用'}\n请回复本通知 DEPLOY ${t.projectId} 重新授权。`);save();job.status='done';this.store.saveJob(job);return;
                }
                if(!t.deployment?.enabled)throw new Error('发布 adapter 未启用');
                await this.multiWork.deploy(s, t, signal);
                alive();
                s.state = s.targets!.filter(t => t.deployment?.enabled).every(t => t.deployed) ? 'DONE' : 'MERGED';
                save();
                this.announce(s, 'deployed', `${t.projectId} 已发布并验证提交 ${t.mergeSha}`);
            }
            else {
                const phase='develop', revalidate=job.feedback==='__REVALIDATE__';
                s.state='RUNNING';s.blockedPhase=phase;s.reviewNotice=undefined;s.planNotice=undefined;save();
                const d=await docs();if(!s.documentVersion)s.documentVersion=d.version;this.assertVersions(s);
                if(!revalidate&&s.targets!.some(t=>!this.registry.get(t.projectId).ready))throw new Error('接入配置未确认，需要新的方案和 START');
                await new ProjectMemoryService(this.config,this.store).confirm(s,this.registry,job.id).catch(()=>this.store.event(s.id,'memory_update_failed',{stage:'confirmation'}));alive();
                // Establish every worktree before running any repository so cross-repository reads are explicit.
                for (const t of s.targets!) {
                    if (!t.mergeSha) {
                        await this.multiWork.prepare(s, t, signal);
                        save();
                    }
                }
                const summaries: string[] = [];
                s.revision += 1;
                for (const t of s.targets!) {
                    if (t.mergeSha) {
                        summaries.push(`${t.projectId}: 已合并 ${t.mergeSha}，本任务只读`);
                        continue;
                    }
                    t.checks=undefined;
                    await this.multiWork.updateBase(s,t,signal);
                    await this.registry.resolve(t.path,{sha:t.baseSha,signal});
                    if(this.registry.changed(t)){
                        s.state='QUEUED';s.blockedPhase='plan';s.planNotice=undefined;s.reviewNotice=undefined;save();
                        this.store.enqueue(s,'plan',job.feedback+'\n同步后的执行配置变化；已有 worktree 和会话保留，需新 START。');
                        this.store.recordProgress(s,'plan-stale','主分支同步后配置变化，正在重新分析；旧批准失效。');
                        job.status='done';this.store.saveJob(job);return;
                    }
                    const result: RunResult = revalidate || t.auxiliary && phase === 'develop' ? { outcome: 'implementation_ready', summary: revalidate ? '重新验证剩余仓库' : '回填产品证据', questions: [], requiresBackend: false, screenshotTargets: [] } : await this.multiWork.run(s, t, phase, `${job.feedback}\n\n确认仓库集合：${s.targets!.map(t => t.projectId).join(', ')}\n产品文档版本：${d.version}\n${d.text}`, signal, id => { alive(); t.thread = id; save(); });
                    alive();
                    if(!revalidate){t.mailBrief=result.mailBrief;t.resultSummary=result.summary;}
                    summaries.push(`${t.projectId}: ${result.summary}`);
                    if (result.profileProposal && digest(result.profileProposal) !== digest(t.profile)) {
                        s.summary = summaries.join('\n\n');
                        s.state = 'WAITING_INPUT';
                        s.blockedPhase = 'plan';
                        save();
                        this.announce(s, 'config-change', `执行配置需要变化；回复意见重新生成方案并 START，不沿用原配置批准。`);
                        break;
                    }
                    const scope=await this.multiWork.resolveScope(s,t,result,signal);alive();
                    if(scope){
                        const changes=validateScope(s,scope);
                        this.store.event(s.id,'scope_decision',{projectId:t.projectId,decision:scope.decision,reason:scope.reason,changes});
                        if(scope.decision==='propose_scope_change'){
                            s.summary=summaries.join('\n\n');s.state='WAITING_INPUT';s.blockedPhase='plan';save();
                            const next=this.store.enqueue(s,'plan',job.feedback+'\nCodex 提出的真实范围变化：'+JSON.stringify(scope)+'\n当前仓库执行事实（只读规划必须保留真实阻塞，不能当作完成）：'+JSON.stringify({outcome:result.outcome,summary:result.summary,questions:result.questions,pendingChecks:result.pendingChecks||[]}));
                            next.scopeChange={reason:scope.reason,changes};this.store.saveJob(next);
                            this.store.recordProgress(s,'scope','真实范围变化，正在只读规划；已有成果保留，新范围需新的 START。\n'+changes.join('\n'));break;
                        }
                        if(scope.decision==='need_context'){
                            s.summary=summaries.join('\n\n');s.state='WAITING_INPUT';save();
                            this.input(s,scope.reason,[...result.questions,...scope.questions]);break;
                        }
                    }
                    if (['blocked', 'needs_input'].includes(result.outcome)) {
                        s.summary = summaries.join('\n\n');
                        s.state = 'WAITING_INPUT';
                        save();
                        this.input(s,s.summary,result.questions);
                        break;
                    }
                    if(result.outcome!=='implementation_ready')throw new Error('Unexpected development outcome');
                    if(t.auxiliary||t.recordEvidence)await this.multiWork.productEvidence(s,t,signal);
                    await this.multiWork.review(s,t,result,signal);save();
                }
                if (s.state !== 'WAITING_INPUT') {
                    s.summary = summaries.join('\n\n');
                    const ids = s.targets!.map(t => t.projectId), order = [...new Set([...(s.mergeOrder || []), ...ids])].filter(id => ids.includes(id));
                    s.mergeOrder = [...order.filter(id=>s.targets!.find(t=>t.projectId===id)?.path!==this.config.productDocs), ...order.filter(id=>s.targets!.find(t=>t.projectId===id)?.path===this.config.productDocs)];
                        s.state = 'WAITING_REVIEW';
                        s.partialMerge = s.targets!.some(t => !!t.mergeSha);
                        s.blockedPhase = undefined;
                        s.reviewManifest = manifest(s);
                        this.announce(s, 'review', s.summary, s.targets!.flatMap(t => t.attachments || []));
                    save();
                }
            }
            this.store.transaction(()=>{
                const completedStage=s.workflow?.stageId;
                job.status='done';this.store.saveJob(job);
                this.store.run(job.id,s.id,{kind:job.kind,status:'done',stage:completedStage,finishedAt:new Date().toISOString(),manifest:s.reviewManifest});
            });
        }
        catch (e) {
            const details = e as {
                stdout?: string;
                stderr?: string;
            };
            if (details.stdout || details.stderr) {
                try {
                    const directory = join(this.config.dataDir, 'runs', s.id, job.id);
                    await mkdir(directory, { recursive: true, mode: 0o700 });
                    await writeFile(join(directory, 'failure.json'), JSON.stringify({ error: safeError(e), stdout: details.stdout, stderr: details.stderr }), { mode: 0o600 });
                }
                catch { }
            }
            const current = this.store.session(s.id)!;
            job.status = current.state === 'CANCELLED' ? 'cancelled' : 'failed';
            this.store.saveJob(job);
            this.store.run(job.id, s.id, { kind: job.kind, status: job.status, error: safeError(e), finishedAt: new Date().toISOString() });
            if (current.state === 'CANCELLED')
                return;
            current.state = 'FAILED';
            current.failedKind = job.kind;
            current.lastError = safeError(e);
            if (/产品文档|配置或身份|配置.*变化/.test(current.lastError))
                current.blockedPhase = 'plan';
            if (job.kind === 'merge') {
                current.reviewNotice = undefined;
                current.partialMerge = current.targets!.some(t => !!t.mergeSha);
            }
            if (job.kind === 'merge' && current.mergeUncertain) {
                try {
                    const t = current.targets!.find(t => t.projectId === current.mergeUncertain)!;
                    const merged = await this.multiWork.inspect(current, t, new AbortController().signal, true);
                    if (merged)
                        t.mergeSha = merged;
                    current.mergeUncertain = undefined;
                }
                catch { }
            }
            this.store.save(current);
            if (job.kind === 'merge' && !current.mergeUncertain) {
                current.state = 'QUEUED';
                this.store.save(current);
                this.store.enqueue(current, 'develop', '__REVALIDATE__');
            }
            if(e instanceof ScopeResolutionError){this.store.recordProgress(current,'scope-invalid',current.lastError);return;}
            this.announce(current, 'failure', `${current.id}: ${current.lastError}\n${current.targets!.map(t => `${t.projectId}: ${t.mergeSha ? '已合并 ' + t.mergeSha : '尚未合并'}`).join('\n')}\n${job.kind === 'merge' ? '旧批准失效；先核对不确定结果，再 RETRY 重新验证并等待新 APPROVE。' : '修复条件后 RETRY，或回复补充意见。'}`);
        }
    }
    override async stop() { this.stopped = true; if(this.intentActive)this.intentActive.abort.abort(); if (this.multiActive) {
        this.multiActive.abort.abort();
        await this.multiActive.promise;
    } if(this.intentActive)await this.intentActive.promise; }
}
