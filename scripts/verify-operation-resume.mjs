// Real old-thread capability discovery. Synthetic files/scripts only; no Gmail,
// GitHub clients, SSH connections, backup, merge or production deployment.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfigSchema} from '../dist/src/config.js';
import {AsyncStore} from '../dist/src/async-store.js';
import {AsyncBridge,ASYNC_CONTRACT,ASYNC_CODEX_VERSION,asyncPolicy} from '../dist/src/async-cli.js';
import {AsyncTools,ASYNC_TOOLS} from '../dist/src/async-tools.js';
import {AppServer,denyInteractive} from '../dist/src/app-server.js';
import {execute} from '../dist/src/process.js';
import {git} from '../dist/src/git.js';
import {disabledMcpPolicy,shellEnvironment} from '../dist/src/runner.js';
process.umask(0o077);
const command=process.env.ASYNC_CODEX_COMMAND||'codex';
assert.equal((await execute(command,['--version'])).stdout.trim(),`codex-cli ${ASYNC_CODEX_VERSION}`);
const root=await realpath(await mkdtemp(join(tmpdir(),'mail-operation-resume-'))),projectsRoot=join(root,'projects'),dataDir=join(root,'state'),privateDirectory=join(root,'private');
await Promise.all([mkdir(projectsRoot),mkdir(dataDir),mkdir(privateDirectory,{mode:0o700})]);
const repo=join(projectsRoot,'sample');await mkdir(repo);await git(repo,['init','-b','main']);await git(repo,['remote','add','origin','https://github.com/example-org/sample.git']);
await writeFile(join(repo,'AGENTS.md'),'Synthetic fixture only. Never use real services or send email.\n');
const config=ConfigSchema.parse({engine:'async-cli',gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',projectsRoot,dataDir,codexCommand:command,controllerRepository:'example/controller',previewEnabled:false,repositories:{sample:{path:repo,github:'example-org/sample'}}});
const store=new AsyncStore(join(dataDir,'async-cli.sqlite'));
const initial={id:'seed',threadId:'synthetic-mail',rfcId:'<seed@example.test>',inReplyTo:'',subject:'Synthetic operations',text:'Record the current tooling limitation; no mail.',from:config.ownerAddress,trusted:true};
const c=store.intake(initial,'synthetic MIME',initial.text),notes=join(dataDir,'async-cli','features',c.id,'notes');
await mkdir(notes,{recursive:true});await mkdir(join(dataDir,'async-cli','features',c.id,'worktrees'),{recursive:true});await mkdir(join(dataDir,'async-cli','features',c.id,'input'),{recursive:true});
const feature=join(notes,'FEATURE.md');await writeFile(feature,'# Synthetic status\nThe previous controller has no standalone inspection or backup tool. Native shell cannot reach staging. An operator must inspect staging separately.\n');
const scope=[{path:repo,identity:'example-org/sample',role:'modify'}];store.put('scope',c.id,scope);
const servers=JSON.parse((await execute(command,['mcp','list','--json'],{env:shellEnvironment()})).stdout);
const calls=[];
const handler=async r=>{
 if(r.method!=='item/tool/call')return denyInteractive(r);
 calls.push({tool:r.params.tool,arguments:r.params.arguments});
 try{return{success:true,contentItems:[{type:'inputText',text:JSON.stringify(await new AsyncTools(config,store,store.conversation(c.id),new AbortController().signal).call(r.params.threadId,r.params.tool,r.params.arguments))}]};}
 catch(e){return{success:false,contentItems:[{type:'inputText',text:JSON.stringify({ok:false,error:e.message})}]};}
};
const create=handler=>new AppServer(command,[...asyncPolicy(config,c),...disabledMcpPolicy(servers)],projectsRoot,handler);
const old=create(handler),completed=new Set();old.on('notification',(method,p)=>{if(method==='turn/completed')completed.add(p.turn.id);});
const transport={profile:async()=>{throw Error('REAL_MAIL_DISABLED');},history:async()=>{throw Error('REAL_MAIL_DISABLED');},read:async()=>{throw Error('REAL_MAIL_DISABLED');},send:async()=>{throw Error('REAL_MAIL_DISABLED');},search:async()=>{throw Error('REAL_MAIL_DISABLED');}};
let bridge;
const awaitTurn=async(condition,seconds)=>{const deadline=Date.now()+seconds*1000;while(!condition()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,250));assert.ok(condition(),'Synthetic turn deadline exceeded');};
try{
 await old.start();
 const legacyContract=ASYNC_CONTRACT.split('\n').filter(line=>!line.startsWith('Administrator-configured production operations')).join('\n');
 const started=await old.request('thread/start',{cwd:projectsRoot,approvalPolicy:'never',developerInstructions:legacyContract+'\nFEATURE.md: '+feature,dynamicTools:ASYNC_TOOLS.filter(t=>!['project_operations','project_operation'].includes(t.name))});
 c.codexThread=started.thread.id;store.save(c);
 const seed=await old.request('turn/start',{threadId:c.codexThread,input:[{type:'text',text:'Synthetic initialization. Existing FEATURE.md correctly describes the previous controller. Reply internally with READY only. Do not use tools, edit files or send email in this initialization turn.'}]});
 await awaitTurn(()=>completed.has(seed.turn.id),120);await old.close();
 const event=store.input('seed');event.status='accepted';event.turnId=seed.turn.id;store.saveInput(event);
 const script=join(privateDirectory,'inspect'),trace=join(privateDirectory,'calls');
 await writeFile(script,`#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(trace)},'inspect\\n');console.log(JSON.stringify({ok:true,summary:'Synthetic staging inspection',evidence:{canary:'SYNTHETIC-CONTROLLED-INSPECT'}}));\n`,{mode:0o700});
 config.repositories.sample.operations={inspect:{description:'Inspect synthetic staging',target:'sample-staging',effect:'read',script,args:[],timeoutSeconds:30}};
 const reply={...initial,id:'reply',rfcId:'<reply@example.test>',inReplyTo:initial.rfcId,text:'Recheck whether you can reach staging and inspect its current configuration through the installed controller. Do only read-only inspection. Do not perform backup, merge or deployment. Record the result in FEATURE.md and finish internally; no email.'};
 store.intake(reply,'synthetic MIME',reply.text);
 const firstCalls=calls.length;
 bridge=new AsyncBridge(config,store,transport,async(_,callback)=>create(callback));
 await bridge.dispatch(store.conversation(c.id));await awaitTurn(()=>!store.conversation(c.id).activeTurn,180);
 const effects=store.all('operation'),recovered=effects.some(x=>x.input.operation==='inspect'&&x.status==='done'&&x.result?.evidence?.canary==='SYNTHETIC-CONTROLLED-INSPECT');
 const report={codexVersion:ASYNC_CODEX_VERSION,sameThread:store.conversation(c.id).codexThread===started.thread.id,recoveredInspection:recovered,inspectionExecutions:recovered?(await readFile(trace,'utf8')).trim().split('\n').length:0,queuedMails:store.mails().length,scopePreserved:JSON.stringify(store.get('scope',c.id))===JSON.stringify(scope),realMailSent:0,businessEffects:effects.filter(x=>x.input.operation!=='inspect').length,initialTools:calls.slice(0,firstCalls).map(x=>x.tool)};
 await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({root,...report},null,2));
 assert.ok(report.sameThread);assert.ok(report.scopePreserved);assert.equal(report.realMailSent,0);assert.equal(report.businessEffects,0);
 if(!process.argv.includes('--observe')){assert.ok(recovered,'Resumed Codex did not discover the installed inspection operation');assert.equal(report.inspectionExecutions,1);assert.equal(report.queuedMails,0);assert.match(await readFile(feature,'utf8'),/SYNTHETIC-CONTROLLED-INSPECT/);}
}finally{await old.close();await bridge?.stop();store.close();}
