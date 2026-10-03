import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {QuestionProposalSchema,QUESTION_OUTPUT,DECISION_GUIDANCE} from '../src/questions.js';
import {ANALYSIS_OUTPUT_SCHEMA} from '../src/analysis.js';
import {OUTPUT_SCHEMA,Runner} from '../src/runner.js';
import {ReplyInterpreter} from '../src/reply-interpreter.js';
import {ConfigSchema} from '../src/config.js';
import {Store} from '../src/store.js';
import {MultiController} from '../src/multi-controller.js';
import {ProjectRegistry} from '../src/projects.js';
import {verifyPresentation} from '../src/mail-presentation.js';
import type {QuestionProposal,Session,SemanticDecision,ReplyContext} from '../src/types.js';
const choice:QuestionProposal={kind:'choice',text:'手稿默认私有还是公开？',dependsOn:[],humanReason:'公开范围涉及隐私，需要负责人决定。',options:[{id:'public',label:'默认公开',impact:'便于发现，但新手稿会公开。'},{id:'private',label:'默认私有',impact:'保护隐私，分享时增加一步。'}],recommendedOptionId:'private',recommendationReason:'推荐私有；需主动分享，但可以避免意外公开。'};
const task=():Session=>({id:'SYNTHETIC',title:'示例手稿',subject:'示例手稿',repo:'',state:'WAITING_INPUT',blockedPhase:'plan',createdAt:'now',initialMessageId:'initial',initialRfcId:'<initial@example.test>',initialThreadId:'thread',threadId:'thread',summary:'等待选择默认公开范围',targets:[],references:[],revision:0,cancellationEpoch:0,workflow:{stageId:'stage-1',number:1,history:[],confirmed:true,confirmedPlan:'same-plan'},documentVersion:'same-doc'});
const wire=(d:SemanticDecision)=>JSON.parse(JSON.stringify({...d,items:d.items.map(i=>({...i,project:i.project??null}))},(_k,v)=>v===undefined?null:v));
const internal=():SemanticDecision=>({version:2,nextStep:'wait',revisionPhase:null,communication:{kind:'internal',text:''},items:[],questions:[]});
test('Discussion options require a real reason and valid recommendation; facts and approvals have no fabricated choices',()=>{
 assert.equal(QuestionProposalSchema.safeParse(choice).success,true);
 for(const bad of [{...choice,recommendedOptionId:'missing'},{...choice,humanReason:null},{...choice,options:choice.options!.slice(0,1)},{...choice,options:[choice.options![0],choice.options![0]]},{...choice,kind:'open'},{...choice,kind:'confirm',action:'START'},{...choice,action:'DEPLOY'}])assert.equal(QuestionProposalSchema.safeParse(bad).success,false);
 const targetSelection={...choice,action:'DEPLOY',recommendedOptionId:null,recommendationReason:null};assert.equal(QuestionProposalSchema.safeParse(targetSelection).success,true);
 const legacy={text:'历史问题',kind:'choice',action:null,dependsOn:[]};const parsed=QuestionProposalSchema.parse(legacy);assert.equal(parsed.options,undefined);assert.equal(parsed.recommendedOptionId,undefined);
 const missing=QuestionProposalSchema.parse({text:'请提供本机样例文件路径',kind:'open',action:null,dependsOn:[],humanReason:'无法从当前目录确定文件位置',options:[],recommendedOptionId:null,recommendationReason:null});assert.deepEqual(missing.options,[]);assert.equal(missing.recommendationReason,undefined);
 for(const schema of [ANALYSIS_OUTPUT_SCHEMA,OUTPUT_SCHEMA])assert.equal(schema.properties.questions.items,QUESTION_OUTPUT);
});
test('Model decisions are presented as plan points, without creating human discussion',()=>{
 const store=new Store(':memory:');try{const s=task();s.mailBrief={goal:'方案已形成',changes:[],choices:['筛选与分页','接口默认值','列表状态'].map(topic=>({topic,category:'technical',choice:'采用明确默认值并处理客户端适配',reason:'保持一致行为',tradeoff:'需要验证旧客户端'}))};
 const m=store.notify(s,'input','Codex 新生成的简洁结论',[],{questions:[]});assert.match(m.text,/方案要点/);assert.ok(!m.text.includes('待讨论'));assert.ok(!m.text.includes('需要你决定'));assert.ok(!m.text.includes('执行确认'));assert.deepEqual(m.questions,[]);
 }finally{store.close();}
});
test('Discussion and execution confirmation stay separate; recommendation is first, escaped and never bound as approval',()=>{
 const store=new Store(':memory:');try{const s=task();s.state='WAITING_START';s.planManifest='v1';const safe={...choice,options:choice.options!.map(o=>o.id==='private'?{...o,label:o.label+'（推荐）'}:o),humanReason:'隐私 <script> 不可推断',recommendationReason:'选择 <private> 保护隐私'};
 const m=store.notify(s,'plan','',[],{preserveBinding:true,questions:[{text:'确认当前版本实施',kind:'confirm',action:'START',dependsOn:[]},safe]});
 assert.match(m.text,/需要你决定/);assert.match(m.text,/执行确认/);assert.match(m.text,/默认私有（推荐）/);assert.ok(!m.text.includes('（推荐）（推荐）'));assert.ok(m.text.indexOf('private |')<m.text.indexOf('public |'));assert.match(m.text,/需要你判断的原因/);assert.match(m.text,/推荐理由/);
 assert.ok(!m.questions![1].binding);assert.equal(m.questions![0].binding!.noticeId,m.id);assert.match(m.presentation!.html,/&lt;script&gt;/);assert.ok(!m.presentation!.html.includes('<script>'));verifyPresentation(m.presentation!,m.summary,[]);
 }finally{store.close();}
});
test('Structured analysis questions reach outcome decisions and parent mail with all recommendation metadata',async()=>{
 const root=await mkdtemp(join(tmpdir(),'discussion-propagation-')),store=new Store(':memory:');const config=ConfigSchema.parse({gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',dataDir:root,projectsRoot:root});const s=task();store.save(s);let observed:ReplyContext|undefined;
 const model={interpretReply:async(_s:Session,c:ReplyContext)=>{observed=c;return wire({...internal(),communication:{kind:'ask_human',text:'需决定默认公开范围'},questions:[choice]});}};
 const controller=new MultiController(config,store,{send:async()=>{throw Error('SEND_FORBIDDEN');}} as any,{} as any,new ProjectRegistry(config,store),model as any);(controller as any).startBusiness=()=>undefined;
 try{(controller as any).input(s,s.summary,[choice]);await controller.startNext();assert.deepEqual(observed!.candidate!.questions,[choice]);const m=store.mails()[0];assert.deepEqual(m.questions![0].options,choice.options);assert.equal(m.questions![0].recommendedOptionId,'private');
 m.status='sent';m.identityStatus='verified';m.rfcMessageId='<choice@example.test>';store.saveMail(m);controller.handle({id:'answer',rfcId:'<answer@example.test>',inReplyTo:m.rfcMessageId,threadId:'thread',subject:s.subject,text:'采用推荐方案',from:config.ownerAddress,trusted:true});const next=store.jobs().at(-1)!;assert.equal(next.reply!.parent!.questions[0].recommendedOptionId,'private');assert.equal(store.jobs().filter(j=>j.kind!=='interpret').length,0);
 }finally{await controller.stop();store.close();await rm(root,{recursive:true,force:true});}
});
test('A model-selected recommended answer is recorded, without executing a co-present deferred START',async()=>{
 const root=await mkdtemp(join(tmpdir(),'discussion-answer-')),store=new Store(':memory:');const config=ConfigSchema.parse({gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',dataDir:root,projectsRoot:root});const s=task();s.state='WAITING_START';s.planManifest='v1';s.workflow!.confirmed=false;delete s.workflow!.confirmedPlan;
 const mail=store.notify(s,'plan','',[],{preserveBinding:true,questions:[{text:'确认当前方案实施',kind:'confirm',action:'START',dependsOn:[]},choice]});mail.status='sent';mail.identityStatus='verified';mail.rfcMessageId='<choice@example.test>';store.saveMail(mail);s.planNotice=mail.id;store.save(s);
 const text='第2项采用推荐的私有方案；第1项暂不批准。';const model={interpretReply:async()=>wire({...internal(),nextStep:'revise',revisionPhase:'plan',items:[{id:'selection',action:'feedback',clear:true,evidence:text,text:'默认私有，需主动分享',questionRefs:[mail.questions![1].id],dependsOn:[]},{id:'deferred',action:'feedback',clear:true,evidence:'第1项暂不批准',text:'暂不批准实施',questionRefs:[mail.questions![0].id],dependsOn:[]}]})};
 const controller=new MultiController(config,store,{send:async()=>{throw Error('SEND_FORBIDDEN');}} as any,{} as any,new ProjectRegistry(config,store),model as any);(controller as any).startBusiness=()=>undefined;
 try{controller.handle({id:'answer',rfcId:'<answer@example.test>',inReplyTo:mail.rfcMessageId,threadId:'thread',subject:s.subject,text,from:config.ownerAddress,trusted:true});await controller.startNext();
 assert.deepEqual(store.jobs().filter(j=>j.kind!=='interpret').map(j=>j.kind),['plan']);const c=store.session(s.id)!.conversation!;assert.match(c.records[0].item.text,/默认私有/);assert.deepEqual(new Set(c.answered),new Set(mail.questions!.map(q=>q.id)));assert.ok(!store.session(s.id)!.workflow?.confirmedPlan);assert.ok(!c.records.some(r=>['start','approve','deploy'].includes(r.item.action)));assert.equal(store.mails().length,1);
 }finally{await controller.stop();store.close();await rm(root,{recursive:true,force:true});}
});
test('Analysis, development and reply all use the same decision policy and verified confirmation context; private guides are preserved',async()=>{
 const root=await mkdtemp(join(tmpdir(),'discussion-prompts-')),prior=process.env.MAIL_TO_CODE_CONFIG_DIR,original=(Runner.prototype as any).invoke;process.env.MAIL_TO_CODE_CONFIG_DIR=root;
 const config=ConfigSchema.parse({gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',dataDir:join(root,'data'),projectsRoot:root}),s=task();s.worktree=root;s.planManifest='same-plan';
 await writeFile(join(root,'AGENTS.md'),'Synthetic privately edited guide\n',{mode:0o600});await writeFile(join(root,'WORKFLOW.md'),'Synthetic workflow convention\n',{mode:0o600});
 const prompts:string[]=[];(Runner.prototype as any).invoke=async(_cwd:string,_thread:unknown,_policy:unknown,_schema:unknown,prompt:string)=>{prompts.push(prompt);if(prompts.length===1)return {outcome:'plan_ready',summary:'方案完整',questions:[],projects:[],productId:null,mergeOrder:[],memoryProposals:[],workflow:{decision:'propose_step',kind:'maintenance',name:'合成方案',rationale:'自主定默认值',deliverables:['方案'],acceptance:['检查']}};if(prompts.length===2)return {outcome:'implementation_ready',summary:'完成合成修改',questions:[],requiresBackend:false,screenshotTargets:[],profileProposal:null};return wire(internal());};
 try{const runner=new Runner(config),signal=new AbortController().signal;await runner.analyze(s,'生成方案',signal,()=>{});await runner.run(s,'develop','已确认方案',signal,()=>{});await new ReplyInterpreter(config).interpret(s,{epoch:0,incoming:{id:'answer',rfcId:'',inReplyTo:'',subject:s.subject,text:'采用推荐方案',threadId:'thread',from:config.ownerAddress,trusted:true}},signal);
 assert.equal(prompts.length,3);for(const p of prompts)assert.ok(p.includes(DECISION_GUIDANCE));assert.match(prompts[0],/same-doc/);assert.match(prompts[0],/same-plan/);assert.match(prompts[2],/same-doc/);assert.equal(await readFile(join(root,'AGENTS.md'),'utf8'),'Synthetic privately edited guide\n');assert.equal(await readFile(join(root,'WORKFLOW.md'),'utf8'),'Synthetic workflow convention\n');
 }finally{(Runner.prototype as any).invoke=original;if(prior===undefined)delete process.env.MAIL_TO_CODE_CONFIG_DIR;else process.env.MAIL_TO_CODE_CONFIG_DIR=prior;await rm(root,{recursive:true,force:true});}
});
test('Historical sent and pending presentations remain byte-for-byte unchanged through restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'discussion-snapshots-')),path=join(root,'state.sqlite');let store=new Store(path);store.set('schema_version','7');
 try{const s=task();store.save(s);for(const status of ['sent','pending'] as const){const id='<legacy-'+status+'@example.test>';store.saveMail({id,sessionId:s.id,kind:'input',status,text:'待讨论的选择\n旧文本',createdAt:'now',attempts:1,attachments:[],questions:[{id:id+'/q1',kind:'open',text:'历史问题',dependsOn:[]}],presentation:{version:1,blocks:[{kind:'paragraph',title:'待讨论的选择',text:'旧文本'}],text:'待讨论的选择\n旧文本',html:'<div>legacy snapshot</div>'}});}
 const before=store.db.prepare('SELECT id,data FROM outbox ORDER BY id').all();store.close();store=new Store(path);store.recover();assert.deepEqual(store.db.prepare('SELECT id,data FROM outbox ORDER BY id').all(),before);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
