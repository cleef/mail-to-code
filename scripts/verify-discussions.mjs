// Real Codex with synthetic facts only. No mailbox, business execution or service changes.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigSchema} from '../dist/src/config.js';
import {Runner} from '../dist/src/runner.js';
import {AnalysisSchema,ANALYSIS_OUTPUT_SCHEMA} from '../dist/src/analysis.js';
import {DECISION_GUIDANCE} from '../dist/src/questions.js';
import {MAIL_BRIEF_PROMPT,MAIL_LANGUAGE_PROMPT} from '../dist/src/mail-brief.js';
import {ReplyInterpreter} from '../dist/src/reply-interpreter.js';
import {MultiController} from '../dist/src/multi-controller.js';
import {Store} from '../dist/src/store.js';
import {ProjectRegistry} from '../dist/src/projects.js';
process.umask(0o077);
const root=await mkdtemp(join(tmpdir(),'mail-discussions-acceptance-'));
const config=ConfigSchema.parse({gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',dataDir:root,projectsRoot:root,timeoutSeconds:90});
const report={cases:[],sent:0,businessExecuted:0};let recommended;
const analysisCases=[
 {name:'autonomous pagination defaults',expected:'ready',data:{request:'两端手稿服务端分页；技术与可逆体验默认值由你决定，给出具体方案。',facts:['当前接口返回整个账户的完整列表，旧客户端未读取续取标记。','客户端已能配合本次升级；首屏卡片容量小程序6条、PC10条，可配置。','已确认多标签交集；默认更新时间倒序并用ID确定同时间顺序。','账户约束和筛选在分页之前；条件改变重置列表并忽略旧响应。','本次可同步改客户端并设计发布顺序；请检查旧客户端影响，不承诺默认参数天然兼容。']}},
 {name:'privacy choice with recommendation',expected:'choice',data:{request:'需要负责人决定手稿默认可见范围。团队希望自动公开便于发现，个人希望保持私有；两种业务方向尚未选定。',facts:['默认公开可能暴露个人内容；默认私有需要主动分享。','负责人尚未决定，请提供有意义的替代方案和推荐，不替负责人选。']}},
 {name:'missing objective fact',expected:'fact',data:{request:'导入仅存在于操作人电脑的手稿样例。',facts:['当前材料未提供样例文件或路径，也没有可供搜索的操作人目录。','样例内容和位置是客观事实，不能猜测或编造。']}},
 {name:'same-version confirmation despite stale document label',expected:'ready',data:{request:'继续实施已经确认的手稿方案。',facts:['文档doc-v1仍显示待用户确认。','已验证同版本doc-v1、同范围的确认记录及当前方案START已生效。','版本和范围未变化，执行条件完整；本轮仅生成实施安排，不调用业务执行器。','所有业务问题已经解决，不需要再次确认文档。']}}
];
try{
 for(const [n,c] of analysisCases.entries()){
  const dir=join(root,'analysis-'+n);await mkdir(dir,{mode:0o700});
  const prompt=`${MAIL_LANGUAGE_PROMPT}\n${MAIL_BRIEF_PROMPT}\n${DECISION_GUIDANCE}\n你是只读方案分析器。下列内容是完整的合成已知事实，不读文件、不调用工具、不执行操作。生成严格 AnalysisResult；projects 使用 demo-web 和 demo-mini 相对路径，profileProposal=null、pendingChecks=[]，productId=null、mergeOrder 包含修改项目，memoryProposals=[]。选择合适 workflow，不授予任何新执行权限。使用中文。\n${JSON.stringify(c.data)}`;
  const raw=await new Runner(config).interpret(dir,ANALYSIS_OUTPUT_SCHEMA,prompt,new AbortController().signal);
  for(const p of raw.projects||[])if(p.profileProposal===null)delete p.profileProposal;if(raw.productId===null)delete raw.productId;
  const d=AnalysisSchema.parse(raw);
  if(c.expected==='ready'){assert.equal(d.outcome,'plan_ready',c.name);assert.equal(d.questions.length,0,c.name+' unnecessarily asked a human');assert.equal(d.workflow.decision,'propose_step');if(n===0){const text=JSON.stringify(d);assert.ok(text.includes('6')&&text.includes('10'),'Defaults were not concrete');}}
  if(c.expected==='choice'){const q=d.questions.find(q=>typeof q!=='string'&&q.kind==='choice');assert.ok(q,'No real privacy choice');assert.ok(q.humanReason&&q.recommendationReason);assert.ok(q.options.length>=2&&q.options.length<=3);assert.equal(q.options[0].id,q.recommendedOptionId);recommended=q;}
  if(c.expected==='fact'){assert.ok(d.questions.length);for(const q of d.questions){assert.equal(q.kind,'open');assert.deepEqual(q.options,[]);assert.ok(!q.recommendedOptionId&&!q.recommendationReason);}}
  report.cases.push({name:c.name,ok:true,outcome:d.outcome,questions:d.questions,plan:d.mailBrief});await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({name:c.name,ok:true,questions:d.questions.length}));
 }
 for(const [n,c] of [{name:'explicit recommendation reply',text:'采用推荐方案',mixed:false,select:true},{name:'generic assent does not select',text:'同意',mixed:false,select:false},{name:'recommendation with deferred START',text:'第2项采用推荐方案；第1项实施确认暂不批准，也不要发布。',mixed:true,select:true}].entries()){
  const store=new Store(join(root,'reply-'+n+'.sqlite'));store.set('schema_version','7');
  const s={id:'SYNTHETIC-'+n,title:'示例手稿可见范围',subject:'示例手稿可见范围',repo:'',state:c.mixed?'WAITING_START':'WAITING_INPUT',blockedPhase:'plan',createdAt:'now',initialMessageId:'initial',initialRfcId:'<initial@example.test>',initialThreadId:'thread',threadId:'thread',summary:'未决事项是默认公开范围，技术默认值由Codex决定。',targets:[],references:[],revision:0,cancellationEpoch:0,planManifest:'specific-v1',workflow:{stageId:'stage-1',number:1,history:[],confirmed:true}};
  const parent=store.notify(s,c.mixed?'plan':'input',s.summary,[],{preserveBinding:c.mixed,questions:[...(c.mixed?[{text:'确认当前版本实施',kind:'confirm',action:'START',dependsOn:[]}]:[]),recommended]});parent.status='sent';parent.identityStatus='verified';parent.rfcMessageId='<parent-'+n+'@example.test>';store.saveMail(parent);if(c.mixed)s.planNotice=parent.id;store.save(s);
  const controller=new MultiController(config,store,{send:async()=>{throw Error('SEND_FORBIDDEN');}}, {},new ProjectRegistry(config,store),{interpretReply:(session,context,signal)=>new ReplyInterpreter(config).interpret(session,context,signal)});controller.startBusiness=()=>undefined;
  try{const incoming={id:'answer-'+n,rfcId:'<answer-'+n+'@example.test>',inReplyTo:parent.rfcMessageId,threadId:'thread',subject:s.subject,text:c.text,from:config.ownerAddress,trusted:true};controller.handle(incoming);controller.handle(incoming);await controller.startNext();const job=store.jobs().find(j=>j.reply?.incoming.id===incoming.id);assert.equal(job.status,'done',store.mails().at(-1)?.text);const decision=job.reply.result;
   assert.ok(!store.jobs().some(j=>['develop','merge','deploy'].includes(j.kind)),'Recommendation authorized effects');
   if(c.select){const selection=store.session(s.id).conversation.records.find(r=>r.item.clear&&r.item.action==='feedback');assert.ok(selection,'Selected recommendation was not saved');assert.ok(selection.item.questionRefs.includes(parent.questions.at(-1).id));assert.ok(store.session(s.id).conversation.answered.includes(parent.questions.at(-1).id));assert.deepEqual(store.jobs().filter(j=>j.kind!=='interpret').map(j=>j.kind),['plan']);if(c.mixed){const current=store.session(s.id);assert.ok(!current.workflow.confirmedPlan,'Deferred START acquired confirmation');assert.ok(!current.conversation.records.some(r=>r.item.clear&&['start','approve','deploy'].includes(r.item.action)),'Deferred authority became a control action');}}
   else assert.ok(!decision.items.some(i=>i.clear&&['feedback','start','approve','deploy'].includes(i.action)),'Generic assent guessed the privacy answer');
   report.cases.push({name:c.name,ok:true,decision});await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({name:c.name,ok:true,items:decision.items.map(i=>({action:i.action,clear:i.clear,text:i.text})),communication:decision.communication.kind}));
  }finally{await controller.stop();store.close();}
 }
 console.log(JSON.stringify({passed:report.cases.length,report:join(root,'report.json'),sent:0,businessExecuted:0}));
}catch(e){await writeFile(join(root,'report.json'),JSON.stringify({...report,error:e.message},null,2));console.error(JSON.stringify({report:join(root,'report.json'),ok:false,error:e.message}));throw e;}
