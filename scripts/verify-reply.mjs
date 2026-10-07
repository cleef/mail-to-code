// Independent acceptance. Never sends email, starts business adapters, or upgrades the live DB/service.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {loadConfig,configDir} from '../dist/src/config.js';
import {Store} from '../dist/src/store.js';
import {ProjectRegistry} from '../dist/src/projects.js';
import {MultiController} from '../dist/src/multi-controller.js';
import {migrate} from '../dist/src/migration.js';
import {Delivery} from '../dist/src/delivery.js';
import {CodexGmailTransport,closeMailTransports} from '../dist/src/gmail.js';
import {parseIncoming} from '../dist/src/mail.js';
import {ReplyInterpreter} from '../dist/src/reply-interpreter.js';
import {replyPolicy,shellEnvironment} from '../dist/src/runner.js';
import {execute} from '../dist/src/process.js';
const base=await loadConfig(),c={...base,dataDir:join(base.dataDir,'verification','replies-'+Date.now())};process.umask(0o077);await mkdir(c.dataDir,{recursive:true,mode:0o700});const report={directory:c.dataDir};
try{
 if(process.argv.includes('--permissions')){
  const dir=join(c.dataDir,'sandbox');await mkdir(dir,{mode:0o700});
  const denied=[join(configDir(),'config.json'),join(base.dataDir,'state.sqlite'),join(Object.values(base.repositories)[0]?.path||base.projectsRoot,'README.md'),join(process.env.HOME,'.ssh/config')];
  const code=`const fs=require('node:fs');for(const p of ${JSON.stringify(denied)}){let denied=false;try{fs.readFileSync(p)}catch{denied=true}if(!denied)process.exit(10);}let denied=false;try{fs.writeFileSync(${JSON.stringify(join(dir,'forbidden'))},'bad')}catch{denied=true}if(!denied)process.exit(11);const s=require('node:net').createConnection({host:'1.1.1.1',port:443});s.once('connect',()=>process.exit(12));s.once('error',e=>{if(!['EPERM','EACCES'].includes(e.code))process.exit(13);console.log('private/project read denied; workspace write denied; network denied');process.exit(0)});setTimeout(()=>process.exit(14),3000)`;
  const probe=await execute(c.codexCommand,['sandbox',...replyPolicy(dir,c),'-P','mail-to-code-reply','--','/usr/bin/bash','-c','set -o pipefail; "$@" 2> >(cat >&2) | cat','reply-probe',process.execPath,'-e',code],{cwd:dir,env:shellEnvironment(),timeoutMs:30000});report.permissions=probe.stdout.trim();console.log(report.permissions);
 }
 if(process.argv.includes('--mail')){
  const source=new DatabaseSync(join(base.dataDir,'state.sqlite'),{readOnly:true});source.prepare('VACUUM INTO ?').run(join(c.dataDir,'state.sqlite'));source.close();const store=new Store(join(c.dataDir,'state.sqlite'));
  try{
   const normalize=items=>JSON.stringify(items.map(({workflow,...rest})=>rest));const original=normalize(store.sessions());const migration=await migrate(c,store,new ProjectRegistry(c,store),async()=>false);if(original!==normalize(store.sessions()))throw Error('Migration changed live task copies');report.migration={schema:migration.version,sessionsPreserved:true};
   if(migration.sourceVersion==='3'){
   const liveStore=join(base.projectsRoot,'mail-to-code','dist/src/store.js');
   const guard=await execute(process.execPath,['--input-type=module','-e',`const {Store}=await import(${JSON.stringify('file://'+liveStore)});let blocked=false;try{const d=new Store(${JSON.stringify(join(c.dataDir,'state.sqlite'))});d.close();}catch(e){blocked=/migration required/.test(e.message)}if(!blocked)process.exit(1);console.log('old v3 rejected isolated v4 state')`],{timeoutMs:30000});report.migration.oldV3Rejected=guard.stdout.includes('old v3 rejected');
   }
   const gmail=await CodexGmailTransport.create(base),readOnly={profile:gmail.profile.bind(gmail),search:gmail.search.bind(gmail),read:gmail.read.bind(gmail),send:async()=>{throw Error('Verification forbids sending');}};
   const result=await new Delivery(c,store,readOnly).backfill();if(result.some(r=>r.result!=='verified'))throw Error('Legacy sent identity backfill incomplete');report.mail={verified:result.length};
   const s=store.sessions().find(s=>!s.system&&s.state==='WAITING_START'&&s.planNotice);if(!s)throw Error('No existing waiting plan for reply acceptance');const plan=store.mail(s.planNotice);if(plan.identityStatus!=='verified')throw Error('Waiting plan not verified');
   const inputs=store.db.prepare('SELECT id FROM inbox WHERE session_id=? ORDER BY rowid DESC LIMIT 8').all(s.id);let input;
   for(const row of inputs){const raw=await readOnly.read(row.id),p=await parseIncoming(raw.id,raw.threadId,raw.raw,c.ownerAddress);if(p.trusted&&p.inReplyTo===plan.rfcMessageId){input=p;break;}}
   if(!input)throw Error('Original correctly addressed owner reply not found');
   const controller=new MultiController(c,store,readOnly,{},new ProjectRegistry(c,store),{interpretReply:(session,context,signal)=>new ReplyInterpreter(c).interpret(session,context,signal)});controller.startBusiness=()=>undefined;input.id='VERIFY-'+input.id;controller.handle(input);controller.handle(input);await controller.startNext();
   const interpreted=store.jobs().filter(j=>j.kind==='interpret'&&j.reply?.incoming.id===input.id);if(interpreted.length!==1||interpreted[0].status!=='done')throw Error('Original owner reply was not interpreted exactly once');report.mail.originalReplyRecovered=true;report.mail.sent=0;report.mail.businessExecuted=0;
  }finally{await closeMailTransports();store.close();}
  console.log('isolated current-schema migration, real Gmail read-only identity backfill, original owner-reply semantic routing passed');
 }
 if(process.argv.includes('--codex')||process.argv.includes('--edges')){await import('./verify-conversations.mjs');report.semantic='v7 isolated semantic acceptance';}

 await writeFile(join(c.dataDir,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({directory:c.dataDir,permissions:!!report.permissions,mail:report.mail,semantic:report.semantic}));
}catch(e){await writeFile(join(c.dataDir,'report.json'),JSON.stringify({...report,error:e.message},null,2),{mode:0o600});throw e;}
