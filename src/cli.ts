import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { configDir, loadConfig, privateDir, type Config } from './config.js';
import { CodexGmailTransport,closeMailTransports } from './gmail.js';
import {migrateMail} from './mail-migration.js';
import { safeError } from './errors.js';
import { readAgentGuide, initializeAgentGuide, agentGuidePath } from './agent-guide.js';
import {acquireLease} from './lease.js';
import {connectMail,checkMailPlugin} from './mail-connect.js';
import {readWorkflowGuide,initializeWorkflowGuide} from './workflow.js';
import {mailStatus} from './mail-diagnostics.js';

process.umask(0o077);
const command=process.argv[2]||'doctor';
async function main(){
  if(command==='migrate-mail'){console.log(JSON.stringify(await migrateMail(process.argv.includes('--dry-run')),null,2));return;}
  if(command==='async-agent-guide'){if(process.argv[3]==='init')console.log(JSON.stringify(await initializeAgentGuide(undefined,true)));else if(!process.argv[3]){await readAgentGuide(undefined,true);console.log(join(configDir(),'ASYNC_AGENTS.md'));}else throw Error('async-agent-guide [init]');return;}
  if(command==='workflow-guide'){if(process.argv[3]==='init')console.log(JSON.stringify(await initializeWorkflowGuide()));else if(!process.argv[3])console.log(JSON.stringify({version:(await readWorkflowGuide()).version}));else throw Error('workflow-guide [init]');return;}
  if(command==='agent-guide'){if(process.argv[3]==='init')console.log(JSON.stringify(await initializeAgentGuide()));else if(!process.argv[3]){await readAgentGuide();console.log(agentGuidePath());}else throw new Error('agent-guide [init]');return;}
  if(command==='init'){
    const args=process.argv.slice(3),value=(key:string)=>args[args.indexOf(key)+1];
    if(!args.includes('--gmail')||!args.includes('--owner'))throw new Error('init --gmail agent@gmail.com --owner owner@qq.com');
    await privateDir(configDir());const path=join(configDir(),'config.json');
    const config={engine:'async-cli',asyncMailOutput:'assistant-final',gmailAddress:value('--gmail'),ownerAddress:value('--owner'),dataDir:'~/.local/share/mail-to-code',codexCommand:'codex',mailCodexHome:join(configDir(),'codex-mail'),projectsRoot:'~/projects',repositories:{},profiles:{}};
    await writeFile(path,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});await initializeAgentGuide();await initializeAgentGuide(undefined,true);await initializeWorkflowGuide();console.log(`Created ${path}; edit private settings, then run mail-connect and doctor.`);return;
  }
  if(['async-reconcile','async-resolve-failed'].includes(command))throw Error('OPERATION_GATEWAY_RETIRED: inspect historical operation records with async-status; use native tools for new work');
  const config=await loadConfig(['mail-connect','mail-plugin-check'].includes(command));
  if(command==='mail-connect'){await connectMail(config,process.argv.includes('--device-auth'));return;}
  if(command==='mail-plugin-check'){const result=await checkMailPlugin(config);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=2;return;}
  await privateDir(config.dataDir);
  if(command==='serve-async'||command==='serve'&&config.engine==='async-cli'){
    await (await import('./async-cli.js')).serveAsync(config);return;
  }
  if(command==='async-doctor'||command==='doctor'&&config.engine==='async-cli'){const result=await(await import('./async-cli.js')).doctorAsync(config);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=2;return;}
  if(command==='async-status'||command==='async-mail-errors'||command==='async-import'||command==='async-adopt'||command==='async-reconcile-input'||command==='async-reconcile-send'){
    const {AsyncStore}=await import('./async-store.js'),{importLegacy}=await import('./async-cli.js');
    const readOnly=['async-status','async-mail-errors'].includes(command);
    const release=readOnly?async()=>{}:await acquireLease(config.dataDir),asyncStore=new AsyncStore(join(config.dataDir,'async-cli.sqlite'),readOnly);
    try{
      if(command==='async-mail-errors'){const id=process.argv[3];if(!id||!asyncStore.mail(id))throw Error('async-mail-errors <mail-id>: existing outbound mail required');console.log(JSON.stringify(asyncStore.all<{mailId:string}>('mail-error').filter(e=>e.mailId===id),null,2));}
      else if(command==='async-reconcile-input'){if(!process.argv.includes('--verified-not-accepted'))throw Error('Inspect native thread history and effects first: async-reconcile-input <input-id> --verified-not-accepted');console.log(JSON.stringify(asyncStore.requeueInput(process.argv[3])));}
      else if(command==='async-reconcile-send'){const {AsyncBridge}=await import('./async-cli.js'),gmail=await CodexGmailTransport.create(config);await gmail.verify();console.log(JSON.stringify(await new AsyncBridge(config,asyncStore,gmail).reconcileSend(process.argv[3],process.argv.includes('--verified-absent'))));}
      else if(command==='async-adopt'){const c=asyncStore.conversation(process.argv[3]);if(!c?.paused||!process.argv.includes('--verified-runtime'))throw Error('async-adopt <id> --verified-runtime: first inspect actual versions, worktrees and uncertain operations; old approvals are never restored');c.paused=false;asyncStore.save(c);console.log(JSON.stringify({id:c.id,adopted:true,replayed:0,restoredGrants:0}));}
      else console.log(JSON.stringify(command==='async-import'?importLegacy(asyncStore,join(config.dataDir,'state.sqlite')):{conversations:asyncStore.conversations(),pendingInputs:asyncStore.inputs().filter(e=>e.status!=='accepted').map(e=>({id:e.id,status:e.status})),outbox:asyncStore.mails().map(mailStatus),heldReplies:[...asyncStore.all('final-held'),...asyncStore.all<any>('mail-held').filter(h=>h.status==='held')],operations:asyncStore.all('operation')},null,2));}
    finally{asyncStore.close();await release();}return;
  }
  throw new Error('Commands: init, agent-guide, workflow-guide, async-agent-guide, mail-connect, mail-plugin-check, migrate-mail, serve, async-doctor, async-status, async-mail-errors, async-import, async-adopt, async-reconcile-input, async-reconcile-send');
}
main().then(async()=>{if(!['serve','serve-async'].includes(command))await closeMailTransports();}).catch(async e=>{await closeMailTransports();console.error(safeError(e));process.exitCode=1;});
