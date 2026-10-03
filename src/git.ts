import { mkdir, readFile, cp, writeFile, realpath, lstat, readdir, readlink, symlink, rm } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import type { Config } from './config.js';
import { privateFile } from './config.js';
import type { Session } from './types.js';
import { execute, type ProcessOptions } from './process.js';
import { Runner } from './runner.js';

export async function git(cwd:string,args:string[],options:ProcessOptions={}) { return (await execute('git',['-c','core.hooksPath=/dev/null',...args],{timeoutMs:120000,...options,cwd})).stdout.trim(); }
export function assertProjectChanges(paths:string[]) {
  for(const p of paths){const segments=p.split('/');if(segments.some(name=>['.git','.codex','.agents','node_modules','dist','.run','.release'].includes(name)||/\.(pem|key)$/.test(name)||/^\.env($|\.)/.test(name)&&!['.env.example','.env.sample'].includes(name)))throw new Error(`Protected path modified: ${p}`);}
}
export class GitAdapter {
  constructor(readonly config:Config,readonly runner:Runner,readonly scope:'project'='project') {}
  async prepare(session:Session,signal?:AbortSignal) {
    const repo=this.config.repositories[session.repo];
    if(session.worktree)return;
    await git(repo.path,['fetch','origin',repo.baseBranch],{signal});
    const baseline=await git(repo.path,['rev-parse',`origin/${repo.baseBranch}`],{signal});
    if(session.baseSha && session.baseSha!==baseline)throw new Error('默认分支基线变化，需新方案和 START');
    session.baseSha=baseline;
    session.branch=`codex/${session.productId?session.productId+'-':''}${session.id.toLowerCase()}`;
    session.worktree=join(this.config.dataDir,'worktrees',session.id);
    await mkdir(join(this.config.dataDir,'worktrees'),{recursive:true,mode:0o700});
    await git(repo.path,['worktree','add','-b',session.branch,session.worktree,session.baseSha],{signal});
  }
  async verifyScope(session:Session,signal?:AbortSignal) {
    const tree=session.worktree!;
    // Includes previously committed changes, unstaged changes and new files.
    const paths=await git(tree,['diff','--name-only',session.baseSha!],{signal});
    const untracked=await git(tree,['ls-files','--others','--exclude-standard'],{signal});
    const changed=[...paths.split('\n'),...untracked.split('\n')].filter(Boolean);
    assertProjectChanges(changed);

  }
  async updateBase(session:Session,signal?:AbortSignal) {
    const repo=this.config.repositories[session.repo];await git(repo.path,['fetch','origin',repo.baseBranch],{signal});
    const current=await git(repo.path,['rev-parse',`origin/${repo.baseBranch}`],{signal});
    if(current===session.baseSha && await git(session.worktree!,['merge-base','--is-ancestor',current,'HEAD'],{signal}).then(()=>true,()=>false))return false;
    await git(session.worktree!,['merge','--no-edit',current],{signal});session.baseSha=current;return true;
  }
  async commit(session:Session,signal?:AbortSignal) {
    await this.verifyScope(session,signal);
    const files=await git(session.worktree!,['status','--porcelain'],{signal});
    if(files){await git(session.worktree!,['add','--all'],{signal});await git(session.worktree!,['commit','-m',`${session.productId?session.productId+' ':''}${session.id}: ${session.title}`],{signal});}
    if(await git(session.worktree!,['diff','--quiet',session.baseSha!],{signal}).then(()=>true,()=>false))throw new Error('No code changes to review');
    return git(session.worktree!,['rev-parse','HEAD'],{signal});
  }
  async push(session:Session,signal?:AbortSignal) { await git(session.worktree!,['push','--set-upstream','origin',session.branch!],{signal}); }
  async cleanDeploy(session:Session) {
    const tree=join(this.config.dataDir,'releases',`${session.id}-${session.mergeSha!.slice(0,12)}`),repo=this.config.repositories[session.repo];
    await git(repo.path,['fetch','origin',repo.baseBranch]);
    await mkdir(join(this.config.dataDir,'releases'),{recursive:true,mode:0o700});
    try{await lstat(tree);}catch{await git(repo.path,['worktree','add','--detach',tree,session.mergeSha!]);}
    if(await git(tree,['rev-parse','HEAD'])!==session.mergeSha || await git(tree,['status','--porcelain']))throw new Error('Deployment checkout is not the approved clean commit');
    return tree;
  }
}
export class GitHubAdapter {
  constructor(readonly config:Config,readonly repoName:string) {}
  private async request(path:string,method='GET',body?:unknown,signal?:AbortSignal) {
    const tokenPath=this.config.githubTokenFile;if(!tokenPath)throw new Error('GitHub token file is not configured');
    await privateFile(tokenPath);const token=(await readFile(tokenPath,'utf8')).trim();
    const response=await fetch(`https://api.github.com/repos/${this.config.repositories[this.repoName].github}${path?'/'+path:''}`,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`GitHub request failed (${response.status})`);return response.json() as Promise<any>;
  }
  async ensurePr(session:Session,checks:string[],signal?:AbortSignal) {
    const repo=this.config.repositories[session.repo];
    const body=`${session.productId?session.productId+' · ':''}${session.title}\n\n${session.summary}\n\nValidation:\n${checks.map(t=>'- '+t).join('\n')}\n\nReview screenshots are sent in the ${session.id} email thread. Head: ${session.reviewSha}.`;
    if(session.prNumber)await this.request(`pulls/${session.prNumber}`,'PATCH',{body},signal);
    else {
      const existing=await this.request(`pulls?state=open&head=${encodeURIComponent(repo.github.split('/')[0]+':'+session.branch)}`,'GET',undefined,signal);
      const pr=existing[0]||await this.request('pulls','POST',{title:`${session.productId?session.productId+' ':''}${session.title}`,head:session.branch,base:repo.baseBranch,body},signal);
      session.prNumber=pr.number;session.prUrl=pr.html_url;
    }
  }
  pr(session:Session,signal?:AbortSignal){return this.request(`pulls/${session.prNumber}`,'GET',undefined,signal);}
  async verify(){const repo=await this.request('');if(!repo.permissions?.push)throw new Error('GitHub account lacks repository write permission');if(repo.default_branch!==this.config.repositories[this.repoName].baseBranch)throw new Error('GitHub default branch changed; refresh the project plan/configuration');}
  async merge(session:Session,signal?:AbortSignal) {
    const pr=await this.pr(session,signal);
    if(pr.head.sha!==session.reviewSha)throw new Error('PR head no longer matches reviewed commit');
    if(pr.merged)return pr.merge_commit_sha as string;
    if(pr.base.sha!==session.baseSha)throw new Error('BASE_ADVANCED');
    const result=await this.request(`pulls/${session.prNumber}/merge`,'PUT',{sha:session.reviewSha,merge_method:this.config.repositories[session.repo]?.mergeMethod||'merge'},signal);
    if(!result.merged)throw new Error('PR merge did not complete');return result.sha as string;
  }
}
