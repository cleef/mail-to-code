// Real Codex, synthetic scope facts and in-memory business adapters only.
// No Gmail transport, Git/PR operation, production service or live task is used.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigSchema} from '../dist/src/config.js';
import {Runner,OUTPUT_SCHEMA,ResultSchema} from '../dist/src/runner.js';
import {ScopeDecisionSchema,scopeInventory,SCOPE_GUIDANCE,validateScope} from '../dist/src/scope.js';
import {ProfileSchema} from '../dist/src/profile.js';
import {Store} from '../dist/src/store.js';
import {MultiController} from '../dist/src/multi-controller.js';
import {planManifest} from '../dist/src/multi-work.js';
import {ReplyInterpreter} from '../dist/src/reply-interpreter.js';
process.umask(0o077);
const root=await mkdtemp(join(tmpdir(),'mail-scope-acceptance-'));
const config=ConfigSchema.parse({gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',dataDir:root,projectsRoot:root,productDocs:join(root,'records'),timeoutSeconds:90});
const profile=ProfileSchema.parse({});
const target=(id,extra={})=>({projectId:id,identity:'identity-'+id,path:join(root,id),relativePath:id,displayName:{web:'示例 Web 与接口',mini:'示例手机小程序',records:'示例产品记录',reference:'参考服务'}[id],github:'example-org/'+id,baseBranch:'main',baseSha:'base-'+id,profile,profileVersion:'profile-'+id,manualMerge:false,worktree:join(root,'work-'+id),...extra});
const s={id:'SYNTHETIC-SCOPE',title:'合成手稿标签',subject:'合成手稿标签',repo:'web',state:'QUEUED',blockedPhase:'develop',createdAt:'now',initialMessageId:'initial',initialRfcId:'<initial@example.test>',initialThreadId:'thread',threadId:'thread',summary:'已批准同版本设计与三个仓库；每端实施与产品证据回填。',targets:[target('web'),target('mini'),target('records',{auxiliary:true,recordEvidence:true})],references:[target('reference')],mergeOrder:['web','mini','records'],documentVersion:'doc-v1',revision:0,cancellationEpoch:0,workflow:{stageId:'stage-1',number:1,confirmed:true,confirmedPlan:'已批准同版本设计与三个仓库；每端实施与产品证据回填。',proposal:{decision:'propose_step',kind:'implementation',name:'实施',rationale:'同版本已确认',deliverables:['两端实现和记录'],acceptance:['独立检查']},history:[]}};
s.planManifest=planManifest(s);
const base={outcome:'implementation_ready',summary:'合成执行器已完成当前 Web 源码修改，其他两个已批准仓库由控制器后续处理。',questions:[],requiresBackend:true,screenshotTargets:[]};
const report={cases:[],sent:0,businessExecuted:0};const runner=new Runner(config);let legacyDecision;
const cases=[
 {name:'legacy approved handoffs',result:{...base,requestedProjects:['示例手机小程序：完成标签交互、列表分页及验证','示例产品记录：获取各端 PR 和界面证据后回填']},expected:'within_approved_scope'},
 {name:'invalid identity repaired',result:{...base,scopeDecision:{decision:'within_approved_scope',reason:'继续手机端',requests:[{projectId:'mini',identity:'incorrect',path:null,role:'modify',reason:'既有工作'}],questions:[]}},expected:'within_approved_scope'},
 {name:'genuine new repository',result:{...base,requestedProjects:['新增仓库目录 backend，需要修改新接口；此前没有批准该仓库。']},expected:'propose_scope_change'},
 {name:'reference becomes writable',result:{...base,requestedProjects:['原本只读的参考服务 reference 现在必须修改接口实现。']},expected:'propose_scope_change'},
 {name:'mixed approved and new repositories',result:{...base,requestedProjects:['继续已批准的示例手机小程序','新增仓库目录 backend，修改接口实现']},expected:'propose_scope_change'},
 {name:'missing human-only fact',result:{...base,requestedProjects:['新增系统只在负责人尚未提供的私人电脑目录中，当前项目根目录和清单不存在该系统。需要负责人给出它的实际目录或可读源码位置；不得猜测。']},expected:'need_context'}
];
try{
 for(const c of cases){
  const original=structuredClone(c.result),d=await runner.resolveScope(s,c.result,new AbortController().signal);
  assert.equal(d.decision,c.expected,c.name);validateScope(s,d);assert.deepEqual(c.result,original);
  if(c.expected==='within_approved_scope')assert.deepEqual(d.questions,[]);
  if(c.name==='legacy approved handoffs'){legacyDecision=d;assert.deepEqual(new Set(d.requests.map(r=>r.projectId)),new Set(['mini','records']));}
  report.cases.push({name:c.name,ok:true,decision:d});await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({name:c.name,ok:true,decision:d.decision}));
 }
 const fresh=await runner.interpret(root,OUTPUT_SCHEMA,`${SCOPE_GUIDANCE}\n这是完整的合成事实，不读文件、不调用工具。当前执行器已经完成 Web 源码修改；只如实汇总，不执行业务。返回完整开发结果，outcome=implementation_ready；profileProposal=null、pendingChecks=[]、mergeOrder=[]、screenshotTargets=[]。同版本 doc-v1 设计和本阶段 START 已明确确认，文档里的待确认字样是旧标记，不能再问。还需控制器推进已经批准的手机端和产品记录，当前仓库不能写它们。当前仓库ID=web；批准清单：${JSON.stringify(scopeInventory(s))}。中文回复，无真实问题。`,new AbortController().signal);
 if(fresh.profileProposal===null)delete fresh.profileProposal;
 const parsed=ResultSchema.parse(fresh);assert.equal(parsed.outcome,'implementation_ready');assert.equal(parsed.scopeDecision.decision,'within_approved_scope');validateScope(s,parsed.scopeDecision);assert.deepEqual(parsed.questions,[]);
 report.cases.push({name:'fresh executor contract and confirmed document',ok:true,decision:parsed.scopeDecision});
 // Run the actual controller branch with the real model's normalized handoff.
 const store=new Store(join(root,'controller.sqlite'));store.set('schema_version','7');
 const registry={entries:new Map([...s.targets,...s.references].map(t=>[t.projectId,{...t,alias:t.projectId,version:t.profileVersion,ready:true}])),approve(){},get(id){return this.entries.get(id);},refresh:async()=>{},changed:()=>false,documents:async()=>({version:'doc-v1',text:'同版本已确认',files:[],missing:[]}),resolve:async(path)=>[...s.targets,...s.references].find(t=>t.path===path)};
 const called=[],evidence=[];
 const forbidden=async()=>{throw Error('BUSINESS_OPERATION_FORBIDDEN');};
 const work={verifyPlan:async(session)=>{assert.equal(session.planManifest,planManifest(session));},prepare:async()=>{},updateBase:async()=>{},run:async(session,t)=>{called.push(t.projectId);return {...base,scopeDecision:t.projectId==='web'?legacyDecision:{decision:'within_approved_scope',reason:'当前仓库完成',requests:[],questions:[]}};},resolveScope:(session,t,result,signal)=>runner.resolveScope({...session,repo:t.projectId},result,signal),review:async(session,t)=>{t.reviewSha='synthetic-head-'+t.projectId;t.prNumber=1;t.prUrl='https://github.com/example-org/'+t.projectId+'/pull/1';t.checks=['synthetic independent check'];},productEvidence:async(session,t)=>{evidence.push(t.projectId);},interpretReply:(session,context,signal)=>new ReplyInterpreter(config).interpret(session,context,signal),merge:forbidden,deploy:forbidden};
 const controller=new MultiController(config,store,{send:forbidden},{},registry,work);
 controller.startBusiness=()=>undefined;
 s.state='WAITING_START';s.workflow.confirmed=false;
 const parent=store.notify(s,'plan',s.summary);parent.status='sent';parent.identityStatus='verified';parent.rfcMessageId='<scope-plan@example.test>';store.saveMail(parent);s.planNotice=parent.id;store.save(s);const snapshot=structuredClone(parent),manifest=s.planManifest;
 const input={id:'start-reply',rfcId:'<start-reply@example.test>',inReplyTo:parent.rfcMessageId,threadId:'thread',subject:s.subject,text:'好，Great, go',from:config.ownerAddress,trusted:true};
 controller.handle(input);controller.handle(input);await controller.startNext();
 const starts=store.jobs().filter(j=>j.kind==='develop');assert.equal(starts.length,1,'Concrete START was not uniquely accepted');assert.equal(store.session(s.id).pendingStart,true);
 assert.equal(store.jobs().filter(j=>j.reply?.incoming.id===input.id).length,1,'Duplicate receipt replayed');
 assert.ok(!store.jobs().some(j=>['merge','deploy'].includes(j.kind)),'START widened external authorization');
 report.cases.push({name:'short reply binds one START without merge/deploy authority',ok:true});
 const job=starts[0];job.status='running';store.saveJob(job);await controller.executeMulti(job,new AbortController().signal);
 assert.equal(store.session(s.id).state,'WAITING_REVIEW');assert.deepEqual(called,['web','mini']);assert.deepEqual(evidence,['records']);assert.equal(store.session(s.id).planManifest,manifest);assert.equal(store.session(s.id).workflow.confirmed,true);assert.deepEqual(store.mail(parent.id),snapshot);assert.ok(!store.jobs().some(j=>j.status==='queued'&&['plan','merge','deploy'].includes(j.kind)));
 await controller.startNext();assert.equal(store.mails().filter(m=>m.kind==='plan').length,1);assert.ok(store.session(s.id).reviewNotice,'Review interpretation did not produce the bound review');store.recover();assert.deepEqual(called,['web','mini']);assert.deepEqual(store.mail(parent.id),snapshot);
 report.cases.push({name:'actual controller continues three approved repositories',ok:true,called,evidence,planNotices:1});await controller.stop();store.close();
 await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.cases.length,report:join(root,'report.json'),sent:0,businessExecuted:0}));
}catch(e){await writeFile(join(root,'report.json'),JSON.stringify({...report,error:e.message},null,2));console.error(JSON.stringify({ok:false,report:join(root,'report.json'),error:e.message}));throw e;}
