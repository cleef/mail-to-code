import {mkdir,chmod}from'node:fs/promises';
import {join}from'node:path';
import type {Config}from'./config.js';
import {Store}from'./store.js';
import {validateProfile}from'./profile.js';
import {digest}from'./projects.js';

// Operator-only import. Never handles email/model instructions or performs external effects.
export async function adoptConfig(config:Config,store:Store,dryRun=false){
 if(store.get('schema_version')!=='6')throw Error('Migrate the database to v6 before adopting configuration');
 if(store.jobs().some(j=>['queued','running'].includes(j.status)))throw Error('Resolve queued/running jobs before adopting configuration');
 if(store.mails().some(m=>m.status!=='sent'))throw Error('Reconcile unsent or uncertain mail before adopting configuration');
 if(store.get('mail-to-code-adopted')==='1')return {alreadyAdopted:true,affected:[]};
 const active=store.sessions().filter(s=>!s.system&&!['DONE','CANCELLED'].includes(s.state));
 if(active.some(s=>s.mergeUncertain||s.partialMerge||s.targets?.some(t=>t.mergeSha||t.deployUncertain)))throw Error('Reconcile partially merged/deployed tasks before adopting configuration');
 const staged=active.map(original=>{
  const s=structuredClone(original);
  for(const t of [...(s.targets||[]),...(s.references||[])]){
   const profile=config.profiles[t.projectId];if(!profile)throw Error('Supply an explicit private profile for every active target/reference');
   t.profile=validateProfile(profile);t.profileSource='external';
   t.deployment=config.repositories[t.projectId]?.deployment;
   t.manualMerge=t.github===config.controllerRepository||config.protectedRepositories.includes(t.github);
   t.profileVersion=digest({profile:t.profile,baseBranch:t.baseBranch,mergeMethod:t.mergeMethod||'merge',deployment:t.deployment});
  }
  s.cancellationEpoch++;s.revision++;s.state='QUEUED';s.blockedPhase='plan';
  s.pendingStart=false;s.directRunRequested=false;s.planningLocked=false;
  delete s.planNotice;delete s.reviewNotice;delete s.mergeNotice;delete s.planManifest;delete s.reviewManifest;
  if(s.workflow)s.workflow.confirmed=false;
  return s;
 });
 const report={dryRun,affected:staged.map(s=>({id:s.id,revision:s.revision,targets:s.targets?.length||0})),preserves:['inbox','outbox','cursor','stage history','worktrees','threads','PRs','SHAs'],businessEffects:0};
 if(dryRun)return report;
 const directory=join(config.dataDir,'backups');await mkdir(directory,{recursive:true,mode:0o700});
 const backup=join(directory,`adoption-${Date.now()}.sqlite`);store.db.prepare('VACUUM INTO ?').run(backup);await chmod(backup,0o600);
 store.transaction(()=>{
  for(const s of staged){store.save(s);store.enqueue(s,'plan','Controller configuration migrated. Preserve existing worktrees, branches, PRs and context. Propose the current stage again using the configured profiles; require a fresh START and Review. Do not merge, deploy, replay previous replies, or mark unfinished work complete.');store.event(s.id,'configuration_adopted',{revision:s.revision});}
  store.set('mail-to-code-adopted','1');
 });
 return {...report,backup};
}
