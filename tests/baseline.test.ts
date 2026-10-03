import {fakeMail} from './fake-mail.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {git} from '../src/git.js';
import {ConfigSchema} from '../src/config.js';
import {Store} from '../src/store.js';
import {ProjectRegistry,proposeProfile} from '../src/projects.js';
import {MultiWork} from '../src/multi-work.js';
import {MultiController} from '../src/multi-controller.js';
import {ProfileSchema} from '../src/profile.js';
import type {Incoming,Session,RepoExecution} from '../src/types.js';
import type {Work} from '../src/controller.js';
import type {AnalysisResult} from '../src/analysis.js';
const signal=()=>new AbortController().signal;
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'mail-baseline-')),projects=join(root,'projects'),seed=join(root,'seed'),transport=join(root,'remote.git');
 await mkdir(projects);await mkdir(seed);await git(seed,['init','-b','main']);await git(seed,['config','user.name','test']);await git(seed,['config','user.email','test@example.com']);
 const pkg=(h5:boolean)=>JSON.stringify({scripts:{typecheck:'tsc --noEmit','build:weapp':'taro build --type weapp',test:'node --test',...(h5?{'build:h5':'taro build --type h5'}:{})}});
 await writeFile(join(seed,'package.json'),pkg(false));await git(seed,['add','.']);await git(seed,['commit','-m','old native only']);await git(root,['clone','--bare',seed,transport]);
 const repo=join(projects,'mobile-app');await git(root,['clone',transport,repo]);await git(repo,['remote','set-url','origin','https://github.com/example-org/mobile-app.git']);
 const old=await git(repo,['rev-parse','HEAD']);
 const store=new Store(join(root,'state.sqlite'));store.migrate(s=>s);
 const config=ConfigSchema.parse({gmailAddress:'a@gmail.com',ownerAddress:'o@qq.com',projectsRoot:projects,productDocs:join(projects,'product-records'),dataDir:join(root,'data'),previewEnabled:false});
 const synchronize=async(path:string,branch:string,s?:AbortSignal)=>git(path,['fetch',transport,`+refs/heads/${branch}:refs/remotes/origin/${branch}`],{signal:s});
 const registry=new ProjectRegistry(config,store,synchronize),work=new MultiWork(config,store);
 async function publish(h5:boolean,extra:Record<string,string>={}){
  await writeFile(join(seed,'package.json'),pkg(h5));if(h5){await mkdir(join(seed,'preview'),{recursive:true});await writeFile(join(seed,'preview/fixtures.json'),'{}');}
  for(const [file,text]of Object.entries(extra)){await mkdir(join(seed,file,'..'),{recursive:true});await writeFile(join(seed,file),text);}
  await git(seed,['add','.']);await git(seed,['commit','--allow-empty','-m','new baseline']);await git(seed,['push',transport,'main']);return git(seed,['rev-parse','HEAD']);
 }
 const session={id:'DEV-BASELINE',summary:'fix',targets:[],references:[]} as unknown as Session;
 let implemented=0;
 Object.assign(work,{analyze:async(s:Session,_f:string,_sig:AbortSignal,onThread:(id:string)=>void):Promise<AnalysisResult>=>{onThread('analysis-baseline');return {workflow:{decision:'propose_step',kind:'implementation',name:'实施',rationale:'测试已确认需求',deliverables:['实现'],acceptance:['检查']},outcome:'plan_ready',summary:'静态核对，未构建',questions:[],projects:[{path:'mobile-app',displayName:'示例笔记小程序',role:'modify',pendingChecks:[]}],mergeOrder:['mobile-app'],memoryProposals:[]};},prepare:async()=>{implemented++;},updateBase:async()=>{},run:async()=>{throw Error('Unexpected business implementation');}});
 // Exercise all real source/config validation, replace only external runtime/GitHub readiness probes.
 const adapters=work.adapters.bind(work);work.adapters=(s,t)=>{const a=adapters(s,t);a.runtime.verify=async()=>{};a.github.verify=async()=>{};return a;};
 const mail=fakeMail(config);
 work.interpretReply=async(s,c)=>({action:'feedback',clear:true,evidence:c.incoming.text,feedback:c.incoming.text,question:''});
 const controller=new MultiController(config,store,mail,{} as Work,registry,work);
 let count=0;const message=(body:string,reply='',subject='示例笔记小程序：只读方案'):Incoming=>({id:'mail-'+(++count),rfcId:`<${count}@qq.com>`,threadId:'canonical',inReplyTo:reply,subject,text:body,from:config.ownerAddress,trusted:true});
 const current=()=>store.sessions().find(s=>!s.system)!;
 const flush=async()=>{while(store.mails().some(m=>m.status==='pending'))await controller.flush();};
 const plan=async()=>{controller.handle(message('先给方案'));await controller.startNext();await flush();};
 return {root,repo,seed,transport,old,store,config,registry,work,session,publish,controller,message,current,flush,plan,implemented:()=>implemented,cleanup:async()=>{await controller.stop();store.close();await rm(root,{recursive:true,force:true});}};
}
test('Stale checkout and dirty package scripts cannot override fetched H5 snapshot; plan waits for START',async()=>{
 const x=await fixture();try{
  const latest=await x.publish(true);await writeFile(join(x.repo,'package.json'),'LOCAL DIRTY ONLY');
  await x.plan();const s=x.current();assert.equal(s.state,'WAITING_START');assert.equal(s.targets![0].baseSha,latest);assert.equal(s.targets![0].profileSource,'auto');
  assert.ok(s.targets![0].profile.build.some(c=>c.args.includes('build:h5')));assert.equal(s.targets![0].worktree,undefined);assert.equal(x.implemented(),0);
  assert.equal(await readFile(join(x.repo,'package.json'),'utf8'),'LOCAL DIRTY ONLY');assert.equal(await git(x.repo,['rev-parse','HEAD']),x.old);
  assert.match(x.store.mail(s.planNotice!)!.text,/类型检查、微信小程序构建、H5 构建/);assert.match(x.store.mail(s.planNotice!)!.text,/计划验证；尚未运行/);assert.ok(!x.store.mail(s.planNotice!)!.text.includes(latest));
 }finally{await x.cleanup();}
});
test('Confirmed auto profiles update when main scripts change; old START and RUN replan without worktrees',async()=>{
 const x=await fixture();try{
  await x.publish(true);await x.plan();const notice=x.current().planNotice!;
  x.registry.approve(x.current().targets![0]);await x.publish(false);
  x.controller.handle(x.message('START',notice,'Re: '+x.current().subject));await x.controller.startNext();assert.equal(x.implemented(),0);assert.equal(x.store.jobs().filter(j=>j.status==='queued'&&j.kind==='plan').length,1);
  await x.controller.startNext();assert.equal(x.current().state,'WAITING_INPUT');assert.match(x.store.mails().at(-1)!.text,/缺少 H5 构建命令/);
  const p=await new ProjectRegistry(x.config,x.store).resolve('mobile-app');assert.equal(p.profileSource,'auto');assert.equal(p.ready,false);
 }finally{await x.cleanup();}
 const y=await fixture();try{
  await y.publish(true);const p=await y.registry.resolve('mobile-app',{sync:true});y.registry.approve(y.registry.target(p));await y.publish(false);
  y.controller.handle(y.message('直接开发','','NEW mobile-app RUN: task'));await y.controller.startNext();assert.equal(y.implemented(),0);assert.equal(y.current().state,'WAITING_INPUT');assert.equal(y.store.mails().some(m=>m.kind==='run-plan'),false);const internal=y.store.db.prepare("SELECT data FROM events WHERE event='notification_internal'").all().map(row=>JSON.parse(String(row.data)));assert.ok(internal.some(e=>e.kind==='run-plan'&&/RUN 未实施/.test(e.text)));
 }finally{await y.cleanup();}
});
test('Profile source keeps external/proposal/legacy values and source-only commit does not change auto version',async()=>{
 const x=await fixture();try{
  await x.publish(true);let p=await x.registry.resolve('mobile-app',{sync:true});const version=p.version;x.registry.approve(x.registry.target(p));
  await x.publish(true,{'README.md':'new docs'});p=await x.registry.resolve('mobile-app',{sync:true});assert.equal(p.version,version);assert.equal(p.ready,true);
  const custom=ProfileSchema.parse({kind:'taro',build:[{executable:'npm',args:['run','build:weapp']}],preview:{kind:'none'}});
  for(const source of ['proposal',undefined] as const){x.store.saveProject(p.identity,{alias:p.alias,profile:custom,version:'custom',...(source?{profileSource:source}:{})});const q=await x.registry.resolve(p.path);assert.deepEqual(q.profile,custom);assert.equal(q.profileSource,source||'legacy');}
  x.config.profiles['mobile-app']=custom;p=await x.registry.resolve(p.path);assert.equal(p.profileSource,'external');assert.deepEqual(p.profile,custom);
 }finally{await x.cleanup();}
});
test('Synchronization and snapshot failures do not fall back; escaping source links are refused',async()=>{
 const x=await fixture();try{
  await x.publish(true);const offline=new ProjectRegistry(x.config,x.store,async()=>{throw Error('offline');});await assert.rejects(offline.resolve('mobile-app',{sync:true}),/同步失败.*未回退/);
  await symlink('/etc/passwd',join(x.seed,'escape'));await git(x.seed,['add','.']);await git(x.seed,['commit','-m','bad link']);await git(x.seed,['push',x.transport,'main']);await assert.rejects(x.registry.resolve('mobile-app',{sync:true}),/拒绝越界链接/);
  const source=join(x.root,'source');await mkdir(source);await symlink('/etc/passwd',join(source,'package.json'));await assert.rejects(proposeProfile('generic',source),/拒绝越界链接/);
  assert.equal(await git(x.repo,['rev-parse','HEAD']),x.old);assert.equal(x.implemented(),0);
 }finally{await x.cleanup();}
});
test('Main advancement after baseline analysis prevents publishing an actionable old plan',async()=>{
 const x=await fixture();try{
  await x.publish(true);const analyze=x.work.analyze.bind(x.work);let advanced=false;
  x.work.analyze=async(...args)=>{if(args[0].planningLocked&&!advanced){advanced=true;await x.publish(true,{'README.md':'advanced while analyzing'});}return analyze(...args);};
  await x.plan();assert.equal(x.current().state,'FAILED');assert.equal(x.current().planNotice,undefined);assert.match(x.current().lastError!,/默认分支基线变化/);assert.equal(x.implemented(),0);
 }finally{await x.cleanup();}
});
test('Existing implementation context survives automatic configuration replan and cannot continue before a new START',async()=>{
 const x=await fixture();try{
  await x.publish(true);await x.plan();const s=x.current(),t=s.targets![0];x.registry.approve(t);
  t.worktree='/retained/worktree';t.thread='retained-development-thread';s.state='WAITING_REVIEW';s.blockedPhase=undefined;x.store.save(s);
  await x.publish(false);x.controller.handle(x.message('继续修改','',s.subject));await x.controller.startNext();assert.equal(x.current().blockedPhase,'plan');assert.equal(x.implemented(),0);
  await x.controller.startNext();assert.equal(x.current().targets![0].worktree,'/retained/worktree');assert.equal(x.current().targets![0].thread,'retained-development-thread');
  await x.publish(true);x.controller.handle(x.message('恢复 H5 配置后重新分析','',s.subject));await x.controller.startNext();assert.equal(x.current().state,'WAITING_START');assert.equal(x.current().targets![0].thread,'retained-development-thread');assert.equal(x.implemented(),0);
 }finally{await x.cleanup();}
});
test('A new baseline proposal can replace legacy configuration only when latest START is accepted',async()=>{
 const x=await fixture();try{
  await x.publish(true);const p=await x.registry.resolve('mobile-app',{sync:true});const legacy=structuredClone(p.profile);legacy.build=legacy.build.filter(c=>!c.args.includes('build:h5'));
  x.store.saveProject(p.identity,{alias:p.alias,profile:legacy,version:'legacy'});
  const analyze=x.work.analyze.bind(x.work);x.work.analyze=async(...args)=>{const result=await analyze(...args);if(args[0].planningLocked)result.projects[0].profileProposal=await proposeProfile('mobile-app',args[0].planningSnapshots!['mobile-app']);return result;};
  await x.plan();assert.equal(x.current().state,'WAITING_START');assert.equal(x.current().targets![0].profileSource,'proposal');
  assert.deepEqual(x.store.project<{profile:unknown}>(p.identity)!.profile,legacy);
  x.controller.handle(x.message('START','<unknown@qq.com>','Re: '+x.current().subject));assert.deepEqual(x.store.project<{profile:unknown}>(p.identity)!.profile,legacy);
  x.controller.handle(x.message('START',x.current().planNotice,'Re: '+x.current().subject));await x.controller.startNext();const saved=x.store.project<{profile:typeof legacy;profileSource:string}>(p.identity)!;
  assert.equal(saved.profileSource,'proposal');assert.ok(saved.profile.build.some(c=>c.args.includes('build:h5')));
 }finally{await x.cleanup();}
});
test('H5 missing fixture is a precise baseline/source failure and never becomes ready for approval',async()=>{
 const x=await fixture();try{
  await x.publish(true);await git(x.seed,['rm','preview/fixtures.json']);await git(x.seed,['commit','-m','remove fixture']);await git(x.seed,['push',x.transport,'main']);
  await x.plan();assert.equal(x.current().state,'WAITING_INPUT');assert.equal(x.current().planNotice,undefined);assert.match(x.store.mails().at(-1)!.text,/默认分支缺少 H5 fixture 文件.*配置来源 auto/);
 }finally{await x.cleanup();}
});
