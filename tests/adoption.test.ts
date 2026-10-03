import test from'node:test';import assert from'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';
import{Store}from'../src/store.js';import{ConfigSchema,configDir}from'../src/config.js';import{adoptConfig}from'../src/adoption.js';import type{Session}from'../src/types.js';import{currentBinding}from'../src/approval.js';
test('Offline adoption preserves immutable delivery/history and work; requires new approvals and is idempotent',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mail-adoption-'));const store=new Store(join(dir,'state.sqlite'));store.set('schema_version','7');store.set('gmail_history','cursor');
 const config=ConfigSchema.parse({gmailAddress:'agent@gmail.com',ownerAddress:'owner@example.test',dataDir:dir,controllerRepository:'example-org/controller',profiles:{app:{checks:[{executable:'node',args:['--version']}]}}});
 const s={id:'task',title:'Test',subject:'Test',state:'WAITING_REVIEW',repo:'app',summary:'Keep changes',createdAt:'now',initialMessageId:'initial',initialRfcId:'<initial>',initialThreadId:'mail-thread',revision:2,cancellationEpoch:0,targets:[{projectId:'app',identity:'stable',path:'/synthetic/app',github:'example-org/app',baseBranch:'main',profile:config.profiles.app,profileVersion:'old',manualMerge:false,worktree:'/saved/tree',thread:'codex-thread',prUrl:'https://github.com/example-org/app/pull/1',prNumber:1,reviewSha:'abc'}],workflow:{stageId:'stage-2',number:2,history:[]}}as Session;
 const out=store.notify(s,'review','Original');out.status='sent';out.rfcMessageId='<delivered>';out.identityStatus='verified';store.saveMail(out);s.reviewNotice=out.id;store.save(s);
 const before=store.mails();const preview=await adoptConfig(config,store,true);assert.equal(preview.affected.length,1);assert.deepEqual(store.session('task'),s);assert.equal(store.jobs().length,0);
 try{await adoptConfig(config,store);const after=store.session('task')!;assert.deepEqual(store.mails(),before);assert.equal(store.get('gmail_history'),'cursor');assert.equal(after.targets![0].thread,'codex-thread');assert.equal(after.targets![0].worktree,'/saved/tree');assert.equal(after.targets![0].reviewSha,'abc');assert.equal(after.workflow!.stageId,'stage-2');assert.equal(currentBinding(after),undefined);assert.equal(after.state,'QUEUED');assert.equal(store.jobs()[0].kind,'plan');assert.equal(store.jobs().some(j=>['develop','merge','deploy'].includes(j.kind)),false);
 const job=store.jobs()[0];job.status='done';store.saveJob(job);await adoptConfig(config,store);assert.equal(store.jobs().length,1);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('Configuration path defaults to operator home and supports an explicit private directory',()=>{const old=process.env.MAIL_TO_CODE_CONFIG_DIR;try{delete process.env.MAIL_TO_CODE_CONFIG_DIR;assert.ok(configDir().endsWith('/.config/mail-to-code'));process.env.MAIL_TO_CODE_CONFIG_DIR='/synthetic/private';assert.equal(configDir(),'/synthetic/private');}finally{if(old===undefined)delete process.env.MAIL_TO_CODE_CONFIG_DIR;else process.env.MAIL_TO_CODE_CONFIG_DIR=old;}});

test('Deployment restores declared generated files and rejects all undeclared source changes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mail-generated-'));const tree=join(root,'tree');await mkdir(tree);
 const {git}=await import('../src/git.js');const {RuntimeAdapter}=await import('../src/runtime.js');const{ProfileSchema}=await import('../src/profile.js');
 await git(tree,['init','-b','main']);await git(tree,['config','user.name','test']);await git(tree,['config','user.email','test@example.test']);await writeFile(join(tree,'generated.txt'),'approved');await git(tree,['add','.']);await git(tree,['commit','-m','fixture']);
 const config=ConfigSchema.parse({gmailAddress:'agent@gmail.com',ownerAddress:'owner@example.test',dataDir:join(root,'data')});let extra=false;
 const runner={check:async()=>{await writeFile(join(tree,'generated.txt'),'rebuilt');if(extra)await writeFile(join(tree,'unapproved.txt'),'bad');return{stdout:'ok'};}};
 const adapter=new RuntimeAdapter(config,runner as never);adapter.verify=async()=>{};const profile=ProfileSchema.parse({build:[{executable:'node',args:['--version']}],generatedFiles:['generated.txt']});
 try{await adapter.run(tree,profile,new AbortController().signal,true);assert.equal(await readFile(join(tree,'generated.txt'),'utf8'),'approved');assert.equal(await git(tree,['status','--porcelain']),'');extra=true;await assert.rejects(adapter.run(tree,profile,new AbortController().signal,true),/unapproved source/);}finally{await rm(root,{recursive:true,force:true});}
});
