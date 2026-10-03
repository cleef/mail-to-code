import { join } from 'node:path';
import { mkdir, readFile, writeFile, cp, realpath } from 'node:fs/promises';
import type { Config } from './config.js';
import type { Session, RepoExecution } from './types.js';
import { GitAdapter, GitHubAdapter, git } from './git.js';
import { Runner, type RunResult } from './runner.js';
import { RuntimeAdapter } from './runtime.js';
import { EvidenceAdapter } from './evidence.js';
import { DeployAdapter } from './deploy.js';
import type { Store } from './store.js';
import { digest, ProjectRegistry, type PreparedProject } from './projects.js';
import { sourceFile, hasSourceFile, snapshot } from './baseline.js';
import { ProjectMemoryService } from './memory.js';
import {ReplyInterpreter} from './reply-interpreter.js';
import {readWorkflowGuide,stageBinding} from './workflow.js';
import type {ReplyContext} from './types.js';
export const planManifest=(s:Session)=>digest({...stageBinding(s),product:s.productId,documents:s.documentVersion,order:s.mergeOrder,targets:[...(s.targets||[]),...(s.references||[])].map(t=>({identity:t.identity,path:t.path,base:t.baseSha,profile:t.profileVersion,...(s.workflow&&!s.workflow.legacy?{mode:t.auxiliary?'evidence':'model',evidence:!!t.recordEvidence}:{}),reference:s.references?.some(r=>r.identity===t.identity)}))});
export class MultiWork {
    constructor(readonly config: Config, readonly store: Store) { }
    async interpretReply(s:Session,context:ReplyContext,signal:AbortSignal){return new ReplyInterpreter(this.config).interpret(s,context,signal);}
    scoped(s: Session, t: RepoExecution) { const repositories = Object.fromEntries((s.targets || []).map(r => [r.projectId, { path: r.path, github: r.github, baseBranch: r.baseBranch, mergeMethod: r.mergeMethod || 'merge', checks: [], deployment: r.deployment }])); return { ...this.config, repositories }; }
    view(s: Session, t: RepoExecution): Session {
        // Never inherit v1's flattened repository fields into another target.
        return { ...s, id: `${s.id}${s.workflow&&!s.workflow.legacy?'-s'+s.workflow.number:''}-${t.projectId}`, repo: t.projectId, ...t,
            worktree: t.worktree, branch: t.branch, baseSha: t.baseSha, thread: t.thread,
            reviewSha: t.reviewSha, prNumber: t.prNumber, prUrl: t.prUrl, mergeSha: t.mergeSha,
            deployRelease: t.deployRelease, deployUncertain: t.deployUncertain,
            targets: s.targets, summary: s.summary };
    }

    copy(t: RepoExecution, v: Session) { for (const k of ['worktree', 'branch', 'baseSha', 'thread', 'reviewSha', 'prNumber', 'prUrl', 'mergeSha', 'deployRelease', 'deployUncertain'] as const)
        (t as any)[k] = v[k]; }
    adapters(s: Session, t: RepoExecution) { const c = this.scoped(s, t), runner = new Runner(c); return { runner, git: new GitAdapter(c, runner, 'project'), github: new GitHubAdapter(c, t.projectId), runtime: new RuntimeAdapter(c, runner), evidence: new EvidenceAdapter(c) }; }
    async prepare(s: Session, t: RepoExecution, signal: AbortSignal) { const v = this.view(s, t); await this.adapters(s, t).git.prepare(v, signal); this.copy(t, v); }
    async analyze(s:Session,feedback:string,signal:AbortSignal,onThread:(id:string)=>void){const memory=await new ProjectMemoryService(this.config,this.store).buildContext((s.originalRequest||s.title)+'\n'+feedback,new ProjectRegistry(this.config,this.store)).catch(()=>'<memory_context trust="data-only">Unavailable; explore normally.</memory_context>');return new Runner(this.config).analyze(s,feedback,signal,onThread,memory);}
    async prepareProject(path:string,registry:ProjectRegistry,signal:AbortSignal):Promise<PreparedProject>{return registry.resolve(path,{sync:true,signal});}
    async snapshot(s:Session,t:RepoExecution,signal:AbortSignal){
        const p=await snapshot(this.config,t.path,t.identity,t.baseBranch,{sync:true,signal});
        t.baseSha=p.sha;t.baselineSnapshot=p.directory;
        return p.directory;
    }
    async verifyPlan(s:Session,registry:ProjectRegistry,signal:AbortSignal){
        if(s.workflow?.proposal?.kind==='documentation'){const docs=await realpath(this.config.productDocs);if(!s.targets?.length||s.targets.some(t=>t.path!==docs))throw Error('文档阶段写入范围无效');}
        await registry.refresh([...(s.targets||[]),...(s.references||[])],{sync:true,signal});
        if(s.planManifest!==planManifest(s))throw new Error('方案清单变化');
        for(const t of [...s.targets!,...(s.references||[])]){
            const p=registry.get(t.projectId);
            if(p.version!==s.planRegistryVersions?.[t.projectId])throw new Error('项目配置变化，需新方案');
            if(p.baselineSha!==t.baseSha)throw new Error('默认分支基线变化，需新方案');
        }
        const docs=await registry.documents(s.productId,undefined,{sync:true,signal});
        if(docs.version!==s.documentVersion&&!(s.workflow?.legacy&&docs.legacyVersion===s.documentVersion))throw new Error('产品文档版本变化，需新方案');
        if(s.workflow?.guide&&!s.workflow.confirmed&&(await readWorkflowGuide()).version!==s.workflow.guide.version)throw Error('工作流指南变化，需新方案和 START');
    }
    async run(s: Session, t: RepoExecution, phase: 'plan' | 'develop', feedback: string, signal: AbortSignal, onThread: (id: string) => void) { return this.adapters(s, t).runner.run(this.view(s, t), phase, feedback, signal, onThread); }
    async resolveScope(s:Session,t:RepoExecution,result:RunResult,signal:AbortSignal){return this.adapters(s,t).runner.resolveScope(this.view(s,t),result,signal);}
    async validate(s:Session,t:RepoExecution,signal:AbortSignal){
        const reason=(text:string)=>new Error(`${text}（基线 ${t.baseSha||'未准备'}；配置来源 ${t.profileSource||'legacy'}）`);
        if(t.profile.kind==='taro'){
            if(!t.profile.build.some(c=>/\bh5\b/.test(c.args.join(' '))))throw reason('执行配置缺少 H5 构建命令');
            if(t.profile.preview.kind!=='h5'||!t.profile.preview.mounts.length||!t.profile.preview.fixtures)throw reason('H5 隔离预览配置不完整');
            const path=t.baselineSnapshot||s.planningSnapshots?.[t.relativePath!];
            if(!path)throw reason('尚未准备默认分支快照');
            if(!await hasSourceFile(path,t.profile.preview.fixtures))throw reason('默认分支缺少 H5 fixture 文件');
            try{JSON.parse(await sourceFile(path,t.profile.preview.fixtures));}catch{throw reason('H5 fixture 不是有效 JSON');}
        }
        const path=t.baselineSnapshot||s.planningSnapshots?.[t.relativePath!];
        if(path){
            let scripts:Record<string,string>={};
            if(await hasSourceFile(path,'package.json'))scripts=JSON.parse(await sourceFile(path,'package.json')).scripts||{};
            for(const c of [...t.profile.build,...t.profile.checks]){
                if(c.executable.split('/').at(-1)!=='npm'||c.cwd!=='.')continue;
                const run=c.args.indexOf('run'),name=run>=0?c.args[run+1]:c.args[0]==='test'?'test':undefined;
                if(name&&!scripts[name])throw reason(`默认分支缺少执行配置引用的脚本：${name}`);
            }
        }
        if(t.profile.kind==='generic'&&!t.profile.build.length&&!t.profile.checks.length)throw reason('需要至少一个独立构建或测试命令');
        await this.adapters(s,t).runtime.verify(t.profile);await this.adapters(s,t).github.verify();
    }
    async updateBase(s: Session, t: RepoExecution, signal: AbortSignal) { const v = this.view(s, t); await this.adapters(s, t).git.updateBase(v, signal); this.copy(t, v); }
    async review(s: Session, t: RepoExecution, result: RunResult, signal: AbortSignal) {
        const a = this.adapters(s, t), v = this.view(s, t);
        await a.git.verifyScope(v, signal);
        v.reviewSha = await a.git.commit(v, signal);
        const checks=await a.runtime.run(v.worktree!,t.profile,signal);
        // Tests may not silently modify the reviewed source; generated changes must pass scope and be committed.
        await a.git.verifyScope(v, signal);
        v.reviewSha = await a.git.commit(v, signal);
        this.copy(t, v);
        const preview = await a.evidence.capture(s,t,result,signal);
        t.logDirectory = a.runtime.lastLogDirectory;
        checks.push(...preview.checks);
        await a.git.push(v, signal);
        await a.github.ensurePr(v, checks, signal);
        this.copy(t, v);
        t.checks = checks;
        if(t.profile.kind==='docs')t.diffSummary=await git(t.worktree!,['diff','--stat',t.baseSha!,t.reviewSha!],{signal});
        t.attachments = preview.attachments;
        t.pendingChecks = [...new Set([...(t.pendingChecks||[]), ...t.profile.pendingChecks, ...(result.pendingChecks || []), ...(t.profile.kind === 'taro' ? ['H5 仅验证界面；微信朋友、群、朋友圈以及原生登录、文件和相册操作须真机验收'] : [])])];
    }
    async inspect(s: Session, t: RepoExecution, signal: AbortSignal, reconcile = false) {
        if (!t.reviewSha || !t.prNumber)
            throw new Error(`Missing reviewed PR: ${t.projectId}`);
        const a = this.adapters(s, t), v = this.view(s, t);
        await a.github.verify();
        const pr = await a.github.pr(v, signal);
        if (pr.head.sha !== t.reviewSha)
            throw new Error(`PR head changed: ${t.projectId}`);
        if (pr.merged)
            return pr.merge_commit_sha as string;
        if (reconcile)
            return undefined;
        if (pr.base.sha !== t.baseSha)
            throw new Error('BASE_ADVANCED');
        if (await git(t.worktree!, ['rev-parse', 'HEAD'], { signal }) !== t.reviewSha || await git(t.worktree!, ['status', '--porcelain'], { signal }))
            throw new Error(`Worktree changed: ${t.projectId}`);
        return undefined;
    }
    async merge(s: Session, t: RepoExecution, signal: AbortSignal) { return this.adapters(s, t).github.merge(this.view(s, t), signal); }
    async deploy(s: Session, t: RepoExecution, signal: AbortSignal) { const a = this.adapters(s, t), v = this.view(s, t), d = new DeployAdapter(this.scoped(s, t), a.git, changed => { this.copy(t, changed); const current = this.store.session(s.id)!; const r = current.targets!.find(r => r.projectId === t.projectId)!; r.deployUncertain = true; r.deployRelease = changed.deployRelease; this.store.save(current); }, (release, abort) => a.runtime.run(release.worktree!, t.profile, abort, true)); await d.deploy(v, signal); this.copy(t, v); t.deployUncertain = false; t.deployed = true; }
    async reconcileDeploy(s: Session, t: RepoExecution) { return new DeployAdapter(this.scoped(s, t), this.adapters(s, t).git).reconcile(this.view(s, t)); }
    async productEvidence(s: Session, t: RepoExecution, signal: AbortSignal) {
        if (!s.productId)
            return;
        const artifact = join(t.worktree!, 'previews', s.productId, s.workflow?.legacy||!s.workflow?s.id:s.workflow.stageId, `r${s.revision}`);
        await mkdir(artifact, { recursive: true });
        const rows = [];
        for (const r of s.targets!.filter(r => r.identity!==t.identity)) {
            rows.push(`## ${r.projectId}\n\nPR: ${r.prUrl}\n\nHead: ${r.reviewSha}\nBase: ${r.baseSha}\n\n${(r.checks || []).map(c => '- ' + c).join('\n')}\n\nPending: ${(r.pendingChecks || []).join('; ')}`);
            for (const a of r.attachments || []) {
                await cp(a.path, join(artifact, a.filename));
                rows.push(`![${a.filename}](${a.filename})`);
            }
        }
        await writeFile(join(artifact, 'README.md'), `# ${s.productId} · ${s.id} Review ${s.revision}\n\n${rows.join('\n\n')}\n`);
        const todo = join(t.worktree!, 'backlog/TODO.md'), text = await readFile(todo, 'utf8');
        if (!text.includes(s.productId))
            throw new Error(`Product ID absent from TODO: ${s.productId}`);
        const marker = `<!-- mail-to-code:${s.workflow?.legacy||!s.workflow?s.id:s.workflow.stageId} -->`, end = `<!-- /mail-to-code:${s.workflow?.legacy||!s.workflow?s.id:s.workflow.stageId} -->`, note = `${marker}\n${s.productId} [Review ${s.revision} evidence](../previews/${s.productId}/${s.workflow?.legacy||!s.workflow?s.id:s.workflow.stageId}/r${s.revision}/README.md) · ${s.targets!.filter(r => r.identity!==t.identity).map(r => r.prUrl).join(' · ')}\n${end}`;
        const start = text.indexOf(marker), last = text.indexOf(end);
        await writeFile(todo, start >= 0 && last >= start ? text.slice(0, start) + note + text.slice(last + end.length) : text + '\n\n' + note + '\n');
    }
}
