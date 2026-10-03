import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {simpleParser} from 'mailparser';
import {Store} from '../src/store.js';
import {ProfileSchema} from '../src/profile.js';
import {ConfigSchema} from '../src/config.js';
import {GmailClient} from '../src/gmail.js';
import {Delivery} from '../src/delivery.js';
import {approvalVersion,bindingValid} from '../src/approval.js';
import {MailBriefSchema} from '../src/mail-brief.js';
import {ANALYSIS_OUTPUT_SCHEMA} from '../src/analysis.js';
import {OUTPUT_SCHEMA} from '../src/runner.js';
import {readable,renderPresentation,verifyPresentation} from '../src/mail-presentation.js';
import type {Session,RepoExecution,MailBlock} from '../src/types.js';
const sha='f89ef729982b8b21c6ad723df97850ad194bd5dd';
function target(projectId:string):RepoExecution{return {projectId,identity:projectId,path:'/synthetic/'+projectId,github:'example-org/'+projectId,displayName:projectId,baseBranch:'main',baseSha:sha,profileVersion:'a'.repeat(64),manualMerge:false,profile:ProfileSchema.parse({kind:projectId==='mini'?'taro':'generic',install:[{executable:'npm',args:['ci']}],build:[{executable:'npm',args:['run','build:h5']}],checks:[{executable:'npm',args:['test']}]}),pendingChecks:['iOS / Android 真机验收']};}
function task():Session{return {id:'synthetic',title:'示例笔记：图片缓存',subject:'隔离任务',repo:'sampleapp',createdAt:'now',initialMessageId:'initial',initialRfcId:'<initial>',initialThreadId:'thread',state:'WAITING_START',revision:3,cancellationEpoch:0,summary:'数据库图片改为私有目录，鉴权后传输；仅已处理的图片迁移。',planManifest:'b'.repeat(64),documentVersion:'c'.repeat(64),targets:[target('sampleapp'),target('mini')],references:[target('docs')],mergeOrder:['sampleapp','mini'],workflow:{stageId:'s2',number:2,history:[],proposal:{decision:'propose_step',kind:'implementation',name:'图片交付',rationale:'文档已合并',deliverables:['示例应用私有文件存储、迁移、鉴权与网页重试','小程序私人缓存、重验证与分享临时文件清理'],acceptance:['鉴权在缓存重验证之前','分享不缓存；撤销后拒绝访问','文件与数据库联合备份恢复和回滚'] }},mailBrief:{goal:'本次建议：确认图片交付方案并开始阶段 2。',choices:[{category:'product',topic:'产品体验',choice:'私人缓存；分享 no-store',reason:'加快私人重复访问，分享重验权限',tradeoff:'分享重复访问仍需传输'},{category:'technical',topic:'图片交付',choice:'应用鉴权，再由 Nginx 内部传输',reason:'文件不能公开直访',tradeoff:'迁移与备份同时覆盖文件和数据库'}],changes:['补充网页失败重试']}};}
test('Scope change facts survive plan summarization while old sent and pending snapshots stay immutable',()=>{
 const store=new Store(':memory:');try{
  const s=task(),pending=store.notify(s,'plan','old pending'),sent=store.notify(s,'plan','old sent');sent.status='sent';store.saveMail(sent);
  const before=[structuredClone(pending),structuredClone(sent)],change={reason:'新增服务端接口需要扩大修改范围',changes:['参考服务：reference → modify；实现新接口']};
  const current=store.notify(s,'plan','summary can omit details',[],{preserveBinding:true,scopeChange:change});
  assert.match(current.text,/reference → modify/);assert.match(current.text,/新增服务端接口/);assert.ok(current.presentation!.html.includes('范围变化'));change.changes[0]='mutated caller data';assert.ok(!current.text.includes('mutated'));
  for(const previous of before){assert.deepEqual(store.mail(previous.id),previous);verifyPresentation(previous.presentation!,previous.summary,previous.attachments);}
  assert.equal(current.approvalBinding!.version,approvalVersion(s,'START'));
 }finally{store.close();}
});
test('Codex analysis and development outputs require a bounded readable mail brief; legacy mocks remain compatible',()=>{
 for(const schema of [ANALYSIS_OUTPUT_SCHEMA,OUTPUT_SCHEMA]){assert.ok(schema.required.includes('mailBrief'));assert.equal(schema.properties.mailBrief.additionalProperties,false);}
 assert.equal(MailBriefSchema.safeParse(task().mailBrief).success,true);assert.equal(MailBriefSchema.safeParse({...task().mailBrief,goal:'x'.repeat(1201)}).success,false);
 assert.equal(MailBriefSchema.safeParse({...task().mailBrief,status:'DONE'}).success,false);
});
test('Plans contain product/technical tradeoffs, complete scope, acceptance and questions without raw execution metadata',()=>{
 const store=new Store(':memory:');try{const s=task(),m=store.notify(s,'plan','unused legacy config');s.planNotice=m.id;
 assert.ok(m.presentation);assert.ok(m.text.startsWith('Feature name(description)'));for(const value of ['方案要点：产品','方案要点：技术','网页重试','分享临时文件清理','联合备份恢复','docs | 只读参考','sampleapp | 修改','mini | 修改','计划验证；尚未运行','待人工验证','确认按本次方案实施'])assert.ok(m.text.includes(value),value);
 for(const value of [sha,s.planManifest!,s.documentVersion!,'npm ci','"runtime"','配置版本','方案清单'])assert.ok(!m.text.includes(value),value);
 assert.equal(m.approvalBinding!.version,approvalVersion(s,'START'));assert.equal(s.targets![0].baseSha,sha);assert.equal(s.targets![0].profileVersion.length,64);
 }finally{store.close();}
});
test('Review shows every repository and real results; display tails never weaken approval versions',()=>{
 const store=new Store(':memory:');try{const s=task();s.state='WAITING_REVIEW';s.reviewManifest='d'.repeat(64);s.targets![0].reviewSha=sha;s.targets![0].checks=['npm run typecheck ✓','npm test passed','/apps/image/: 200'];s.targets![0].resultSummary='完成私有文件写入与清理；增加迁移回滚入口';s.targets![1].checks=['manual check queued'];
 const m=store.notify(s,'review',s.summary);s.reviewNotice=m.id;
 assert.match(m.text,/Review #3/);assert.match(m.text,/sampleapp \| 4bd5dd/);assert.ok(m.text.includes('完成私有文件写入与清理'));assert.ok(!m.text.includes(sha));assert.match(m.text,/已通过/);assert.match(m.text,/已记录；不代表通过/);assert.match(m.text,/H5 截图只验证界面/);
 assert.equal(bindingValid(s,m.approvalBinding),true);s.targets![0].reviewSha='0'.repeat(34)+sha.slice(-6);assert.equal(bindingValid(s,m.approvalBinding),false);assert.equal(s.targets![0].reviewSha.slice(-6),sha.slice(-6));
 }finally{store.close();}
});
test('Updates keep changes compact, clarification keeps all questions, and failures/merges never fake completion',()=>{
 const store=new Store(':memory:');try{const s=task();
 const help=store.notify(s,'help','已处理独立事项；剩余两个问题。',[],{questions:[{text:'文件保留七天还是三十天？',kind:'choice',dependsOn:[]},{text:'持久卷位置在哪里？',kind:'open',dependsOn:[]}]});assert.match(help.text,/文件保留七天/);assert.match(help.text,/持久卷位置/);assert.ok(!help.text.includes('验收重点'));
 const status=store.notify(s,'status','暂未出现新的阶段结果');assert.match(status.text,/补充网页失败重试/);assert.ok(!status.text.includes('方案要点：技术'));
 s.state='FAILED';s.lastError='文件写入故障；未完成实施';const failed=store.notify(s,'failure',s.lastError);assert.match(failed.text,/失败／结果待核对/);assert.ok(!failed.text.includes('DONE'));
 s.state='MERGED';s.targets![0].mergeSha=sha;const merged=store.notify(s,'merge','已合并，生产尚未部署。');assert.match(merged.text,/代码已合并，未部署/);assert.ok(!merged.text.includes('DONE（已部署）'));
 s.workflow!.proposal!.kind='documentation';const docs=store.notify(s,'merge','文档合并完成，下一阶段等待新的 START');assert.match(docs.text,/文档已合并；实现进度见阶段摘要/);
 }finally{store.close();}
});
test('Missing briefs fall back to real stage/summary records; nested JSON and legacy fingerprints are removed',()=>{
 const store=new Store(':memory:');try{const s=task();delete s.mailBrief;const m=store.notify(s,'plan','');assert.match(m.text,/仅已处理的图片迁移/);assert.match(m.text,/联合备份恢复/);
 const raw='新变化\n配置版本：'+'a'.repeat(64)+'\n'+JSON.stringify(s.targets![0].profile,null,2)+'\n提交 '+sha+'\n仍需选择目录';const clean=readable(raw);assert.ok(!clean.includes('"runtime"'));assert.ok(!clean.includes('"env"'));assert.ok(!clean.includes('配置版本'));assert.ok(clean.includes('4bd5dd'));assert.ok(clean.includes('仍需选择目录'));
 assert.equal(readable('普通 {花括号} 与 [设计] 文本'),'普通 {花括号} 与 [设计] 文本');assert.equal(readable('返回 [200,304]；{"共享缓存":false}'),'返回 200、304；共享缓存：否');
 }finally{store.close();}
});
test('Controller explains actual dependency/service/write-scope changes even if Codex says no change',()=>{
 const store=new Store(':memory:');try{const s=task(),first=store.notify(s,'plan','');s.targets![0].profile.packageSources=['packages.example.test'];s.targets![0].profile.services=[{name:'test-db',image:'mysql@sha256:'+'e'.repeat(64),args:[],env:{},health:['ready']}];s.mailBrief!.changes=[];s.targets![0].profileVersion='f'.repeat(64);
 const changed=store.notify(s,'plan','');assert.match(changed.text,/与上一封相比已变化/);assert.match(changed.text,/packages.example.test/);assert.match(changed.text,/test-db/);assert.ok(!changed.text.includes('e'.repeat(64)));
 s.references=[];s.targets!.push(target('docs'));const scope=store.notify(s,'plan','');assert.match(scope.text,/docs \| 与上一封相比已变化/);
 assert.notEqual(first.approvalBinding!.version,changed.approvalBinding!.version); // realistic config changes are fenced by profileVersion, not formatting
 }finally{store.close();}
});
test('HTML escapes every cell/paragraph; only existing CID images are allowed with text equivalents',()=>{
 const s=task();s.title='<img src=x onerror=bad>';const store=new Store(':memory:');try{const m=store.notify(s,'plan','');assert.match(m.presentation!.html,/&lt;img/);assert.ok(!m.presentation!.html.includes('<img src=x'));
 const blocks:MailBlock[]=[{kind:'table',title:'<script>',headers:['&'],rows:[['<svg onload=bad>']]},{kind:'image',cid:'proof@test',caption:'真实截图说明；不靠图片批准'}];
 assert.throws(()=>renderPresentation(m.summary,blocks),/MAIL_IMAGE_REFERENCE/);const out=renderPresentation(m.summary,blocks,[{path:'/artifact/proof.png',filename:'proof.png',cid:'proof@test'}]);assert.ok(out.text.includes('不靠图片批准'));assert.match(out.html,/&lt;svg/);assert.match(out.html,/alt="真实截图说明/);
 assert.throws(()=>renderPresentation(undefined,[{kind:'image',cid:'javascript:bad',caption:'bad'}],[{path:'/x',filename:'x',cid:'javascript:bad'}]),/MAIL_IMAGE_REFERENCE/);
 assert.throws(()=>verifyPresentation({...m.presentation!,html:m.presentation!.html+'<script>bad</script>'},m.summary,[]),/SNAPSHOT_MISMATCH/);
 }finally{store.close();}
});
test('Snapshots survive restart/live changes and MIME resend with identical body/identity; legacy has no presentation',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'mail-presentation-'))),store=new Store(join(root,'state.sqlite'));store.set('schema_version','6');let restarted:Store|undefined;
 try{const s=task(),m=store.notify(s,'plan','');store.save(s);const saved=structuredClone(m);s.title='new';s.state='DONE';s.targets=[];store.save(s);m.status='uncertain';store.saveMail(m);store.close();restarted=new Store(join(root,'state.sqlite'));assert.equal(restarted.get('schema_version'),'6');assert.deepEqual(restarted.mail(m.id)!.presentation,saved.presentation);assert.equal(restarted.mail(m.id)!.text,saved.text);
 const config=ConfigSchema.parse({gmailAddress:'agent@gmail.com',ownerAddress:'owner@example.test',dataDir:root});const client=new (GmailClient as any)(config,{});const wires:string[]=[];client.request=async(_p:string,_method:string,data:any)=>{wires.push(data.raw);return {id:'sent',threadId:'thread'};};
 const send={to:config.ownerAddress,subject:s.subject,text:saved.text,summary:saved.summary,presentation:saved.presentation,messageId:saved.id,deliveryMarker:saved.deliveryMarker,inReplyTo:'<parent>',references:['<parent>'],attachments:[]};await client.send(send);await client.send(send);
 for(const wire of wires){const delivery:Delivery=new Delivery(config,restarted,{read:async()=>({id:'sent',threadId:'thread',raw:wire,labelIds:['SENT']})} as any);assert.equal((await delivery.inspect(saved,{...s,subject:send.subject},'sent')).rfcMessageId,saved.id);const mime=await simpleParser(Buffer.from(wire,'base64url'));assert.equal(mime.text!.trim(),(saved.text+'\n\n[MAIL-REF: '+saved.deliveryMarker+']').trim());assert.equal(mime.messageId,saved.id);assert.equal(mime.inReplyTo,'<parent>');assert.equal((String(mime.html).match(/Feature name\(description\)/g)||[]).length,1);assert.match(String(mime.html),/方案要点：产品/);}
 const artifact=join(root,'artifacts','proof.png');await mkdir(join(root,'artifacts'));await writeFile(artifact,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=','base64'));
 const image=restarted.notify(task(),'review','synthetic',[{path:artifact,filename:'proof.png',cid:'proof@test'}]);await client.send({...send,text:image.text,summary:image.summary,presentation:image.presentation,messageId:image.id,deliveryMarker:image.deliveryMarker,attachments:image.attachments});const pictured=await simpleParser(Buffer.from(wires.at(-1)!,'base64url'),{skipImageLinks:true});assert.equal(pictured.attachments[0].cid,'proof@test');assert.match(pictured.text!,/图片仅作视觉证据/);assert.match(String(pictured.html),/cid:proof@test/);
 await assert.rejects(client.send({...send,text:'changed'}),/MAIL_TEXT_SNAPSHOT_MISMATCH/);
 await client.send({to:config.ownerAddress,subject:'old',text:'历史正文 '+sha,messageId:'<legacy>'});const legacy=await simpleParser(Buffer.from(wires.at(-1)!,'base64url'));assert.equal(legacy.text!.trim(),'历史正文 '+sha);
 }finally{try{store.close();}catch{}restarted?.close();await rm(root,{recursive:true,force:true});}
});
test('Replanning retains existing implementation; documentation Review and legacy single-repo checks are truthful',()=>{
 const store=new Store(':memory:');try{const s=task();s.targets![0].worktree='/retained';const plan=store.notify(s,'plan','');assert.match(plan.text,/已有阶段工作保留/);assert.ok(!plan.text.includes('本阶段尚未开始实施'));
 s.state='WAITING_REVIEW';s.workflow!.proposal!.kind='documentation';const docs=store.notify(s,'review','');assert.match(docs.text,/文档合并后仅规划下一阶段/);assert.ok(!docs.text.includes('代码合并后'));
 delete s.targets;delete s.references;delete s.workflow;s.checks=['npm test ✓'];s.reviewSha=sha;const legacy=store.notify(s,'review','');assert.match(legacy.text,/sampleapp \| 自动化测试 \| 已通过/);assert.match(legacy.text,/4bd5dd/);
 }finally{store.close();}
});
test('Independent review preserves planned acceptance checks until evidence resolves them',async()=>{
 const {MultiWork}=await import('../src/multi-work.js');const s=task(),t=s.targets![0];t.worktree='/isolated';t.pendingChecks=['图片 API 故障注入','iOS 真机'];
 const work=new MultiWork({} as any,{} as any);work.adapters=()=>({git:{verifyScope:async()=>{},commit:async()=>sha,push:async()=>{}},runtime:{run:async()=>['npm test passed']},evidence:{capture:async()=>({checks:[],attachments:[]})},github:{ensurePr:async()=>{}}}) as any;
 await work.review(s,t,{outcome:'implementation_ready',summary:'完成代码',questions:[],requiresBackend:false,screenshotTargets:[],pendingChecks:[]},new AbortController().signal);
 assert.ok(t.pendingChecks!.includes('图片 API 故障注入'));assert.ok(t.pendingChecks!.includes('iOS 真机'));assert.equal(t.checks![0],'npm test passed');
});
