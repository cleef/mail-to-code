import { join } from 'node:path';
import { writeFile,stat } from 'node:fs/promises';
import { configDir, loadConfig, privateDir, type Config } from './config.js';
import { GmailClient } from './gmail.js';
import { authorize } from './oauth.js';
import { Store } from './store.js';
import { safeError } from './controller.js';
import { Runner } from './runner.js';
import { GitHubAdapter } from './git.js';
import {ProjectRegistry} from './projects.js';
import {MultiWork} from './multi-work.js';
import {MultiController} from './multi-controller.js';
import {RuntimeAdapter} from './runtime.js';
import { readAgentGuide, initializeAgentGuide, agentGuidePath } from './agent-guide.js';
import { ProjectMemoryService } from './memory.js';
import {migrate} from './migration.js';
import {adoptConfig}from'./adoption.js';
import {acquireLease} from './lease.js';
import { execute } from './process.js';
import {Delivery} from './delivery.js';
import {currentBinding} from './approval.js';
import {readWorkflowGuide,initializeWorkflowGuide,stageLabel} from './workflow.js';

process.umask(0o077);
const command=process.argv[2]||'doctor';
async function doctor(config:Config) {
  const checks:{name:string;ok:boolean;detail?:string}[]=[];
  const check=async(name:string,fn:()=>Promise<unknown>)=>{try{await fn();checks.push({name,ok:true});}catch(e){checks.push({name,ok:false,detail:safeError(e)});}};
  await check('Agent AGENTS.md',()=>readAgentGuide());
  await check('Workflow guide',()=>readWorkflowGuide());
  await check('Codex CLI',()=>execute(config.codexCommand,['--version']));
  const catalogStore=new Store(join(config.dataDir,'state.sqlite')),registry=new ProjectRegistry(config,catalogStore);let selected=process.argv[3];await check('Project root',async()=>{await stat(config.projectsRoot);if(selected)selected=(await registry.resolve(selected,{sync:true})).alias;else await registry.scan(true,{sync:true});});
  for(const p of registry.entries.values()){if(selected&&selected!==p.alias)continue;await check(p.alias+' runtime/config',async()=>{if(p.error)throw new Error(p.error);await new RuntimeAdapter(config,new Runner(config)).verify(p.profile);});await check(p.alias+' GitHub write',()=>new GitHubAdapter({...config,repositories:{[p.alias]:{path:p.path,github:p.github,baseBranch:p.baseBranch,mergeMethod:p.mergeMethod,checks:[]}}},p.alias).verify());}if(selected&&!registry.entries.has(selected))checks.push({name:selected,ok:false,detail:'Unknown project'});catalogStore.close();
  await check('Gmail account/scopes/refresh',async()=>{const gmail=await GmailClient.create(config);await gmail.verify();});

  if([...registry.entries.values()].some(p=>(!selected||p.alias===selected)&&p.profile.preview.kind!=='none'))await check('Podman preview image',()=>execute('podman',['image','exists',config.screenshotImage]));
  await check('User linger',async()=>{const r=await execute('loginctl',['show-user',process.env.USER||'','-p','Linger']);if(!r.stdout.includes('Linger=yes'))throw new Error('Enable linger as root');});
  for(const [alias,repo]of Object.entries(config.repositories))if((!selected||selected===alias)&&repo.deployment?.enabled)await check(alias+' production SSH',()=>execute('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',repo.deployment!.host,'true'],{timeoutMs:20000}));
  const store=new Store(join(config.dataDir,'state.sqlite'));if(['2','3','4','5','6','7'].includes(store.get('schema_version')||'')&&!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='projects'").get())checks.push({name:'SQLite v2 tables',ok:false,detail:'Project registry table missing'});const stats={sessions:store.sessions().map(s=>({id:s.id,state:s.state,revision:s.revision,stage:stageLabel(s),completedStages:s.workflow?.history.map(h=>({id:h.id,name:h.proposal.name,prs:h.targets.map(t=>t.prUrl)})),deliverables:s.workflow?.proposal?.deliverables,pr:s.prUrl})),outbox:store.mails().filter(m=>m.status!=='sent').map(m=>({id:m.id,status:m.status})),pollError:store.get('poll_error'),sendError:store.get('send_error'),mailIdentities:store.mails().filter(m=>m.status==='sent'&&m.identityStatus!=='verified').map(m=>({id:m.id,status:m.identityStatus||'pending',reason:m.identityError})),interpretQueue:store.jobs().filter(j=>j.kind==='interpret'&&j.status!=='done').map(j=>({id:j.id,status:j.status,session:j.sessionId}))};store.close();
  console.log(JSON.stringify({checks,...stats},null,2));return checks.every(c=>c.ok);
}
async function main(){
  if(command==='workflow-guide'){if(process.argv[3]==='init')console.log(JSON.stringify(await initializeWorkflowGuide()));else if(!process.argv[3])console.log(JSON.stringify({version:(await readWorkflowGuide()).version}));else throw Error('workflow-guide [init]');return;}
  if(command==='agent-guide'){if(process.argv[3]==='init')console.log(JSON.stringify(await initializeAgentGuide()));else if(!process.argv[3]){await readAgentGuide();console.log(agentGuidePath());}else throw new Error('agent-guide [init]');return;}
  if(command==='init'){
    const args=process.argv.slice(3),value=(key:string)=>args[args.indexOf(key)+1];
    if(!args.includes('--gmail')||!args.includes('--owner'))throw new Error('init --gmail agent@gmail.com --owner owner@qq.com');
    await privateDir(configDir());const path=join(configDir(),'config.json');
    const config={gmailAddress:value('--gmail'),ownerAddress:value('--owner'),dataDir:'~/.local/share/mail-to-code',codexCommand:'codex',githubTokenFile:'~/.config/mail-to-code/github-token',projectsRoot:'~/projects',repositories:{},profiles:{}};
    await writeFile(path,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});await initializeAgentGuide();await initializeWorkflowGuide();console.log(`Created ${path}; add Desktop OAuth client and authorize.`);return;
  }
  const config=await loadConfig();await privateDir(config.dataDir);
  if(command==='auth'){await authorize(config);return;}
  if(command==='serve-async'||command==='serve'&&config.engine==='async-cli'){
    await (await import('./async-cli.js')).serveAsync(config);return;
  }
  if(command==='async-doctor'||command==='doctor'&&config.engine==='async-cli'){const result=await(await import('./async-cli.js')).doctorAsync(config);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=2;return;}
  if(command==='async-status'||command==='async-import'||command==='async-adopt'||command==='async-reconcile'||command==='async-reconcile-input'||command==='async-reconcile-send'){
    const {AsyncStore}=await import('./async-store.js'),{importLegacy}=await import('./async-cli.js');
    const release=command==='async-status'?async()=>{}:await acquireLease(config.dataDir),asyncStore=new AsyncStore(join(config.dataDir,'async-cli.sqlite'),command==='async-status');
    try{
      if(command==='async-reconcile-input'){if(!process.argv.includes('--verified-not-accepted'))throw Error('Inspect native thread history and effects first: async-reconcile-input <input-id> --verified-not-accepted');console.log(JSON.stringify(asyncStore.requeueInput(process.argv[3])));}
      else if(command==='async-reconcile-send'){const {AsyncBridge}=await import('./async-cli.js'),gmail=await GmailClient.create(config);await gmail.verify();console.log(JSON.stringify(await new AsyncBridge(config,asyncStore,gmail).reconcileSend(process.argv[3],process.argv.includes('--verified-absent'))));}
      else if(command==='async-reconcile'){const c=asyncStore.conversation(process.argv[3]);if(!c||!process.argv[4])throw Error('async-reconcile <feature-id> <operation-id> [--verified-no-effect]');const {AsyncTools}=await import('./async-tools.js');console.log(JSON.stringify(await new AsyncTools(config,asyncStore,c,new AbortController().signal).reconcile(process.argv[4],process.argv.includes('--verified-no-effect'))));}
      else if(command==='async-adopt'){const c=asyncStore.conversation(process.argv[3]);if(!c?.paused||!process.argv.includes('--verified-runtime'))throw Error('async-adopt <id> --verified-runtime: first inspect actual versions, worktrees and uncertain operations; old approvals are never restored');c.paused=false;asyncStore.save(c);console.log(JSON.stringify({id:c.id,adopted:true,replayed:0,restoredGrants:0}));}
      else console.log(JSON.stringify(command==='async-import'?importLegacy(asyncStore,join(config.dataDir,'state.sqlite')):{conversations:asyncStore.conversations(),pendingInputs:asyncStore.inputs().filter(e=>e.status!=='accepted').map(e=>({id:e.id,status:e.status})),outbox:asyncStore.mails().map(m=>({id:m.id,status:m.status,identity:m.identityStatus})),operations:asyncStore.all('operation')},null,2));}
    finally{asyncStore.close();await release();}return;
  }
  if(command==='doctor'){if(!await doctor(config))process.exitCode=2;return;}
  const store=new Store(join(config.dataDir,'state.sqlite')),registry=new ProjectRegistry(config,store);
  if(command==='memory'){const memory=new ProjectMemoryService(config,store);const action=process.argv[3];if(action==='forget'){const path=process.argv[4];if(!path)throw new Error('memory forget <project-relative-path>');await memory.forget(path);console.log('Project lookup memory removed');}else if(!action)console.log(JSON.stringify(memory.inspect(),null,2));else throw new Error('memory [forget <project-relative-path>]');store.close();return;}
  if(command==='projects'){await registry.scan(true,{sync:true});console.log(registry.list());store.close();return;}
  if(command==='migrate'||command==='adopt-config'){const release=await acquireLease(config.dataDir);try{console.log(JSON.stringify(command==='migrate'?await migrate(config,store,registry):await adoptConfig(config,store,process.argv.includes('--dry-run'))));}finally{store.close();await release();}return;}
  if(command==='migration-status'){console.log(JSON.stringify({schema:store.get('schema_version'),oldCodeCompatible:store.get('schema_version')==='1',queued:store.jobs().filter(j=>j.status==='queued').length}));store.close();return;}
  if(command==='status'){console.log(JSON.stringify(store.sessions(),null,2));store.close();return;}
  if(command==='mail-links'){
    const action=process.argv[3]||'check';if(!['check','backfill'].includes(action))throw Error('mail-links [check|backfill]');
    if(action==='backfill'){
      const gmail=await GmailClient.create(config);await gmail.verify();console.log(JSON.stringify(await new Delivery(config,store,gmail).backfill()));
      for(const s of store.sessions()){
        const b=currentBinding(s);if(!b||store.get('reply-recovery-required:'+s.id)!=='1'||store.mail(b.noticeId)?.identityStatus!=='verified')continue;
        store.transaction(()=>{const m=store.notify(s,'help',`邮件回复关联已修复。此前被拒绝的回复不会自动执行。当前状态：${s.state}\n版本：${b.version}\n${store.mail(b.noticeId)!.text}\n可以回复本邮件明确确认上述操作；合并和发布需要分别明确说明。`);m.approvalBinding=b;store.saveMail(m);store.set('reply-recovery-required:'+s.id,'0');});
      }
    }else console.log(JSON.stringify(store.mails().map(m=>({id:m.id,gmailId:m.gmailId,rfcMessageId:m.rfcMessageId,identity:m.identityStatus||'pending',reason:m.identityError,status:m.status}))));
    store.close();return;
  }
  if(command==='reconcile-send'){
    const id=process.argv[3],mail=store.mail(id);if(!mail||!['uncertain','failed'].includes(mail.status))throw new Error('Expected an uncertain/failed internal outbox ID');
    const gmail=await GmailClient.create(config);await gmail.verify();const result=await new Delivery(config,store,gmail).reconcile(mail);
    if(result==='verified')console.log('Reconciled sent message and delivered RFC identity');
    else if(result==='absent'&&process.argv.includes('--retry-confirmed-absent')){mail.status='pending';mail.identityStatus=undefined;store.saveMail(mail);console.log('Explicit retry queued after operator verification; search absence alone does not prove non-delivery');}
    else{console.log('No verified unique sent message; remains blocked. Inspect Gmail before confirming retry.');process.exitCode=2;}store.close();return;
  }
  const multiWork=new MultiWork(config,store);
  if(command==='reconcile-merge'){
    const s=store.session(process.argv[3]);if(!s?.mergeUncertain)throw new Error('Expected uncertain merge task');const target=s.targets!.find(t=>t.projectId===s.mergeUncertain)!;await registry.refresh(s.targets!);
    const merged=await multiWork.inspect(s,target,new AbortController().signal,true);if(merged)target.mergeSha=merged;s.mergeUncertain=undefined;store.save(s);console.log(merged?'Reconciled merged commit':'No merge found; old approval remains invalid');store.close();return;
  }
  if(command==='reconcile-deploy'){
    const s=store.session(process.argv[3]);const alias=process.argv[4];const uncertain=s?.targets?.filter(t=>t.deployUncertain)||[];const target=alias?uncertain.find(t=>t.projectId===alias):uncertain.length===1?uncertain[0]:undefined;if(!s||!target)throw new Error('Provide uncertain task and project alias');await registry.refresh(s.targets!);
    if(await multiWork.reconcileDeploy(s,target)){target.deployed=true;target.deployUncertain=false;s.state='MERGED';store.save(s);store.notify(s,'deployed',`${target.projectId}: reconciled ${target.mergeSha}`);}
    else if(process.argv.includes('--failed')){target.deployUncertain=false;s.state='FAILED';s.failedKind='deploy';s.deployTarget=target.projectId;store.save(s);}else{console.log('Approved release not active; inspect production before --failed');process.exitCode=2;}store.close();return;
  }
  if(command!=='serve')throw new Error('Commands: init, agent-guide, workflow-guide, auth, projects, memory, doctor [project], status, migrate, adopt-config [--dry-run], migration-status, serve, mail-links, reconcile-send, reconcile-merge, reconcile-deploy');
  if(store.get('schema_version')!=='7')throw new Error('Stop service, run migrate and doctor before starting v7');
  const releaseLease=await acquireLease(config.dataDir);const gmail=await GmailClient.create(config);try{await gmail.verify();await new RuntimeAdapter(config,new Runner(config)).cleanOrphans();}catch(e){await releaseLease();throw e;}store.recover();
  // Shared polling and verified outbox transport; business effects use multi-project adapters.
  const controller=new MultiController(config,store,gmail,{} as import('./controller.js').Work,registry,multiWork);
  let stopping=false,lastPoll=0,busy=false;
  const tick=async()=>{if(stopping)return;controller.startNext();if(busy)return;busy=true;try{if(Date.now()-lastPoll>=config.pollSeconds*1000){lastPoll=Date.now();const updated=await loadConfig();Object.assign(config,{projectsRoot:updated.projectsRoot,productDocs:updated.productDocs,profiles:updated.profiles,repositories:updated.repositories});await controller.poll();}await controller.flush();controller.startNext();}finally{busy=false;}};
  const interval=setInterval(()=>void tick().catch(e=>console.error(safeError(e))),1000);await tick();
  const stop=async()=>{if(stopping)return;stopping=true;clearInterval(interval);await controller.stop();while(busy)await new Promise(r=>setTimeout(r,50));store.close();await releaseLease();};
  process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
  console.log('mail-to-code running; notifications are emitted only for decisions/results/failures.');
}
main().catch(e=>{console.error(safeError(e));process.exitCode=1;});
