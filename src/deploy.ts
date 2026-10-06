import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import type { Session } from './types.js';
import { GitAdapter, git } from './git.js';
import { execute } from './process.js';
import type { OperationJournal } from './operation-report.js';

export class DeployAdapter {
  constructor(readonly config:Config,readonly gitAdapter:GitAdapter,readonly beforeEffect?:(session:Session)=>void,readonly buildProject?:(session:Session,signal:AbortSignal)=>Promise<unknown>,readonly preDeploy?:(signal:AbortSignal)=>Promise<unknown>,readonly journal?:OperationJournal) {}
  release(session:Session){return `mail-${session.id.toLowerCase()}-${session.mergeSha!.slice(0,12)}`;}
  async reconcile(session:Session):Promise<boolean> {
    const d=this.config.repositories[session.repo].deployment;if(!d)throw new Error('Production deployment is not configured');
    const target=(await execute('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',d.host,`readlink -f '${d.remoteBase}/current'`],{timeoutMs:20000})).stdout.trim();
    if(target!==`${d.remoteBase}/releases/${this.release(session)}`)return false;
    for(const path of d.healthPaths||['/']){const r=await fetch(`https://${d.domain}${path}`,{signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('Production health check failed');}
    return true;
  }
  async deploy(session:Session,signal:AbortSignal) {
    const d=this.config.repositories[session.repo].deployment;
    this.journal?.update({stage:'build'});
    if(!d?.enabled)throw new Error('Production deployment disabled or missing SSH configuration');
    if(session.deployUncertain){if(await this.reconcile(session))return;throw new Error('DEPLOY_UNCERTAIN: administrator must inspect/rollback and use reconcile-deploy --failed before retry');}
    const tree=await this.gitAdapter.cleanDeploy(session);
    const releaseSession={...session,worktree:tree};if(!this.buildProject)throw Error('Deployment build adapter missing');await this.buildProject(releaseSession,signal);
    if(await git(tree,['rev-parse','HEAD'])!==session.mergeSha||await git(tree,['status','--porcelain']))throw new Error('Production build changed the approved source commit');
    // Execute only the deployment script from a separately trusted baseline.
    // Static scope does not permit modifying it. Verify against the original base.
    const script=d.script;
    const trusted=await git(this.config.repositories[session.repo].path,['show',`${d.trustedScriptSha || session.baseSha}:${script}`]);
    const current=(await readFile(join(tree,script),'utf8')).trim();
    if(createHash('sha256').update(current).digest('hex')!==createHash('sha256').update(trusted).digest('hex'))throw new Error('Deployment script differs from trusted baseline');
    if(d.preDeployOperations?.length && !this.preDeploy)throw Error('PREDEPLOY_ADAPTER_REQUIRED');
    this.journal?.update({stage:'predeploy'});
    await this.preDeploy?.(signal);
    if(await git(tree,['rev-parse','HEAD'])!==session.mergeSha||await git(tree,['status','--porcelain']))throw Error('Pre-deployment operation changed approved source');
    signal.throwIfAborted();session.deployRelease=this.release(session);session.deployUncertain=true;this.beforeEffect?.(session);
    const args=d.args.map(v=>v.replaceAll('{commit}',session.mergeSha!).replaceAll('{release}',this.release(session)).replaceAll('{host}',d.host).replaceAll('{domain}',d.domain).replaceAll('{remoteBase}',d.remoteBase));
    this.journal?.update({stage:'deploy'});
    await execute('bash',[join(tree,script),...args],{cwd:tree,signal,timeoutMs:3600000,
      onStdout:this.journal?.onStdout,onStderr:this.journal?.onStderr,
      env:{...process.env,...(this.journal?{MAIL_TO_CODE_OPERATION_ID:this.journal.operationId}:{})}});
    this.journal?.update({stage:'health'});
    if(!await this.reconcile(session))throw new Error('Production release identity did not match deployment');
  }
}
