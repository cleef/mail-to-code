// Real persistent Codex and direct CLI, isolated synthetic files. Never create Gmail/GitHub clients.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,cp,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ConfigSchema} from '../dist/src/config.js';
import {AsyncStore} from '../dist/src/async-store.js';
import {AsyncBridge,asyncPolicy,ASYNC_CONTRACT,ASYNC_CODEX_VERSION} from '../dist/src/async-cli.js';
import {execute} from '../dist/src/process.js';
import {git} from '../dist/src/git.js';
import {disabledMcpPolicy,shellEnvironment} from '../dist/src/runner.js';
process.umask(0o077);
const command=process.env.ASYNC_CODEX_COMMAND||'codex';
assert.equal((await execute(command,['--version'])).stdout.trim(),`codex-cli ${ASYNC_CODEX_VERSION}`);
const root=await realpath(await mkdtemp(join(tmpdir(),'mail-async-acceptance-'))),projectsRoot=join(root,'projects'),dataDir=join(root,'state'),guideDir=join(root,'private-guides');
await Promise.all([mkdir(projectsRoot),mkdir(dataDir),mkdir(guideDir)]);
// Avoid loading operator-edited private guides into a synthetic report.
process.env.MAIL_TO_CODE_CONFIG_DIR=guideDir;
const config=ConfigSchema.parse({gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',projectsRoot,dataDir,codexCommand:command,timeoutSeconds:180,controllerRepository:'example/controller',previewEnabled:false});
const store=new AsyncStore(join(dataDir,'synthetic.sqlite')),incoming={id:'synthetic-1',threadId:'synthetic-thread',rfcId:'<synthetic-1@example.test>',inReplyTo:'',subject:'Synthetic three-repository build repair',text:'继续已批准的三个仓库工作，修复 Web 的 TypeScript 编译失败，更新 mini 和 records 的分页说明并验证。技术细节由你决定，PC 默认10条、小程序6条。禁止合并、部署和真实邮件。',from:config.ownerAddress,trusted:true};
const c=store.intake(incoming,'synthetic MIME',incoming.text),featureDir=join(dataDir,'async-cli','features',c.id),worktrees=join(featureDir,'worktrees');await mkdir(worktrees,{recursive:true});
const scopes=[];
for(const name of ['web','mini','records']){
  const path=join(projectsRoot,name),tree=join(worktrees,name);await mkdir(path);await git(path,['init','-b','main']);await git(path,['config','user.name','Synthetic']);await git(path,['config','user.email','synthetic@example.test']);await git(path,['remote','add','origin',`https://github.com/example/${name}.git`]);
  await writeFile(join(path,'README.md'),'# Synthetic '+name+'\n');await writeFile(join(path,'AGENTS.md'),'Only edit synthetic task files. No production or network operations.\n');
  await writeFile(join(path,'.gitignore'),'node_modules/\n');
  if(name==='web'){await writeFile(join(path,'tags.ts'),`export const split = (text: string) => Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text), item => item.segment);\n`);await writeFile(join(path,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2020',lib:['ES2020','DOM'],noEmit:true,strict:true},include:['tags.ts']}));}
  else await writeFile(join(path,'pagination.md'),'# Pagination\nImplementation pending.\n');
  await git(path,['add','.']);await git(path,['commit','-m','Synthetic baseline']);await git(path,['worktree','add','-b','codex/synthetic',tree]);
  config.repositories[name]={path,github:`example/${name}`,baseBranch:'main',mergeMethod:'merge',checks:[]};
  const id=c.id+'-'+createHash('sha256').update(JSON.stringify(`example/${name}`)).digest('hex').slice(0,8);
  store.put('project',c.id+':'+path,{id,repo:name,title:incoming.subject,subject:incoming.subject,state:'RUNNING',summary:'',createdAt:c.createdAt,initialMessageId:incoming.id,initialRfcId:incoming.rfcId,initialThreadId:incoming.threadId,cancellationEpoch:0,revision:1,worktree:tree,branch:'codex/synthetic',baseSha:await git(tree,['rev-parse','HEAD'])});
  scopes.push({path,identity:`example/${name}`,role:name==='records'?'product_record':'modify'});
}
store.put('scope',c.id,scopes);
const web=join(worktrees,'web'),compiler=join(web,'node_modules/typescript/lib');await cp(fileURLToPath(new URL('../node_modules/typescript/lib',import.meta.url)),compiler,{recursive:true});
const compilerCommand=[join(compiler,'tsc.js'),'--project',join(web,'tsconfig.json')];
await assert.rejects(execute(process.execPath,compilerCommand),e=>e.stdout.includes('TS2339'));
const directDir=join(root,'direct'),directTrees=join(directDir,'async-cli','features','direct','worktrees');await mkdir(directTrees,{recursive:true});for(const name of ['web','mini','records'])await cp(join(worktrees,name),join(directTrees,name),{recursive:true});
const instruction=`These are synthetic approved worktrees: ${JSON.stringify(Object.fromEntries(['web','mini','records'].map(n=>[n,join(worktrees,n)])))}. The compiler is ${join(compiler,'tsc.js')}; use ${process.execPath}. First run the current Web TypeScript compiler and observe its TS2339 failure, then fix it and rerun successfully. Keep target ES2020; add the appropriate Intl lib. Update both mini/pagination.md and records/pagination.md to specify server-side filtering before stable descending pagination (updatedAt plus id), mobile default6 and PC default10, reset on filter changes and ignore late responses. Old unpaginated clients need an adaptation/release plan. No human question is needed. Do not call grant_scope or record_authorization (scope already approved), project_pr, project_merge or project_deploy. Write FEATURE.md, and queue exactly one final-result email through queue_mail. The fixture mail transport cannot send anything. Complete the work without stopping for another prompt.`;
const e=store.input(incoming.id);e.fullText=incoming.text+'\n'+instruction;store.saveInput(e);
const mail={profile:async()=>{throw Error('REAL_MAIL_DISABLED');},history:async()=>{throw Error('REAL_MAIL_DISABLED');},search:async()=>{throw Error('REAL_MAIL_DISABLED');},read:async()=>{throw Error('REAL_MAIL_DISABLED');},send:async()=>{throw Error('REAL_MAIL_DISABLED');}};
const bridge=new AsyncBridge(config,store,mail),started=Date.now();
try{
  await bridge.dispatch(c);
  const deadline=Date.now()+360000;
  while(store.conversation(c.id).activeTurn&&Date.now()<deadline){await new Promise(r=>setTimeout(r,1000));if(store.conversation(c.id).error)throw Error(store.conversation(c.id).error);}
  assert.equal(store.conversation(c.id).activeTurn,undefined,'Codex did not finish synthetic work');
  await execute(process.execPath,compilerCommand);
  for(const n of ['mini','records']){const text=await readFile(join(worktrees,n,'pagination.md'),'utf8');assert.ok(text.includes('6')&&text.includes('10')&&!text.includes('Implementation pending'));}
  assert.equal(store.mails().length,1,'Unnecessary discussion or intermediate email');
  assert.equal(store.all('request').length,0,'Unnecessary execution approval');
  assert.deepEqual(store.get('scope',c.id),scopes);
  assert.ok((await readFile(join(featureDir,'notes','FEATURE.md'),'utf8')).length>100);
  const bridgeMs=Date.now()-started;
  const recordBefore=await readFile(join(worktrees,'records','pagination.md'),'utf8');
  // Resume the same thread with a small natural follow-up. No interpreter and no new scope grant.
  store.intake({...incoming,id:'synthetic-2',inReplyTo:incoming.rfcId,rfcId:'<synthetic-2@example.test>',text:'在记录中补充取消编辑保留原标签的说明。完成后内部记录即可，不需要邮件。'},'synthetic MIME','在 records/pagination.md 补充取消编辑保留原标签；完成后内部记录即可，不需要邮件。');
  const thread=store.conversation(c.id).codexThread;await bridge.stop();
  const resumed=new AsyncBridge(config,store,mail);try{await resumed.dispatch(store.conversation(c.id));const until=Date.now()+120000;while(store.conversation(c.id).activeTurn&&Date.now()<until)await new Promise(r=>setTimeout(r,1000));assert.equal(store.conversation(c.id).codexThread,thread);assert.equal(store.conversation(c.id).activeTurn,undefined);assert.equal(store.mails().length,1);const recordAfter=await readFile(join(worktrees,'records','pagination.md'),'utf8');assert.notEqual(recordAfter,recordBefore);assert.ok(recordAfter.includes('取消')||/cancel/i.test(recordAfter));}finally{await resumed.stop();}
  await Promise.all(['input','notes'].map(n=>mkdir(join(directDir,'async-cli','features','direct',n),{recursive:true})));
  const directConfig={...config,dataDir:directDir},directC={...c,id:'direct'},servers=JSON.parse((await execute(command,['mcp','list','--json'])).stdout);
  const directInstruction=instruction.replaceAll(worktrees,directTrees).replace('Write FEATURE.md, and queue exactly one final-result email through queue_mail.','Write a completion note to '+join(directTrees,'RESULT.md')+'. Do not send mail; there is no mail tool.');
  const directStarted=Date.now();
  await execute(command,['exec',...asyncPolicy(directConfig,directC),...disabledMcpPolicy(servers),'--skip-git-repo-check','--json','--cd',projectsRoot,ASYNC_CONTRACT+'\n'+directInstruction],{cwd:projectsRoot,env:shellEnvironment(),timeoutMs:240000,onStdout:()=>{}});
  await execute(process.execPath,[join(directTrees,'web/node_modules/typescript/lib/tsc.js'),'--project',join(directTrees,'web','tsconfig.json')]);
  const report={codexVersion:ASYNC_CODEX_VERSION,bridge:{humanPrompts:1,followUpPrompts:1,queuedMails:1,scopeConfirmations:0,firstTaskMs:bridgeMs,persistentThread:true},direct:{humanPrompts:1,firstTaskMs:Date.now()-directStarted},realMailSent:0,businessEffects:0,checks:['real TS2339 observed and fixed','three approved repositories completed','no repeated START','same thread after restart','no intermediate mail','direct CLI comparison']};
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({root,...report},null,2));
}catch(e){if(e.diagnostic)console.error(e.diagnostic);throw e;}finally{await bridge.stop();store.close();}
