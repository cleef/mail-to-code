import { readdir, realpath } from 'node:fs/promises';
import { join, resolve, basename, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import { expand } from './config.js';
import { execute } from './process.js';
import { git } from './git.js';
import { ProfileSchema, validateProfile, type ProjectProfile } from './profile.js';
import type { Store } from './store.js';
import type { RepoExecution, Session, ProfileSource } from './types.js';
import { snapshot, sourceFile, sourcePath, hasSourceFile, type BaselineOptions, type SynchronizeBranch } from './baseline.js';
export const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');
export interface Project {
    alias: string;
    path: string;
    github: string;
    baseBranch: string;
    mergeMethod: 'merge' | 'squash' | 'rebase';
    identity: string;
    profile: ProjectProfile;
    profileSource: ProfileSource;
    baselineSha: string;
    snapshotPath: string;
    version: string;
    ready: boolean;
    manualMerge: boolean;
    error?: string;
    deployment?: Config['repositories'][string]['deployment'];
    relativePath?: string;
}
export interface PreparedProject extends Project { baselineSha: string; snapshotPath: string; }
const cmd = (script: string, cwd = '.') => ({ executable: 'npm', args: ['run', script], cwd });
export async function proposeProfile(alias: string, path: string): Promise<ProjectProfile> {
    let pkg: any;
    try {
        pkg = JSON.parse(await sourceFile(path, 'package.json'));
    }
    catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (pkg) {
        const scripts = pkg.scripts || {}, steps = Object.keys(scripts);
        const kind = pkg.name === 'mail-to-code' ? 'controller' : scripts['build:weapp'] ? 'taro' : 'generic';
        return ProfileSchema.parse({ kind, install: [{ executable: 'npm', args: ['ci', '--no-audit', '--no-fund'] }], build: [...(['typecheck', 'build:weapp', 'build:h5', 'build'].filter(k => steps.includes(k))).map(s => cmd(s))], checks: scripts.test ? [{ executable: 'npm', args: ['test'] }] : [],
            preview: kind === 'taro' ? { kind: 'h5', mounts: [{ source: 'dist-h5', destination: '.' }], paths: ['/#/pages/home/index'], fixtures: 'preview/fixtures.json' } : { kind: 'none' }, pendingChecks: kind === 'taro' ? ['微信朋友、群、朋友圈发送与打开需 iOS/Android 真机验收'] : [] });
    }
    if(await hasSourceFile(path,'backlog/TODO.md'))return ProfileSchema.parse({kind:'docs'});
    try {
        if (!await hasSourceFile(path, 'pyproject.toml')) throw Object.assign(new Error('Missing'), {code:'ENOENT'});
        return ProfileSchema.parse({ runtime: ['python3'], checks: [{ executable: 'python3', args: ['-m', 'pytest'] }], packageSources: ['pypi.org', 'files.pythonhosted.org'] });
    }
    catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return ProfileSchema.parse({ runtime: [], pendingChecks: ['尚未确认构建及测试命令；方案须补齐验证配置'] });
}
export class ProjectRegistry {
    entries = new Map<string, Project>();
    issues: string[] = [];
    lastScan = 0;
    constructor(readonly config: Config, readonly store: Store, private readonly synchronize?:SynchronizeBranch) { }
    async scan(force = false, options: BaselineOptions = {}) {
        if (!force && Date.now() - this.lastScan < 60000)
            return;
        this.lastScan = Date.now();
        const entries = new Map<string, Project>(), visited = new Set<string>();
        this.issues = [];
        const root = await realpath(expand(this.config.projectsRoot));
        const skip = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.run', '.release', '.cache']);
        const walk = async (path: string) => {
            let actual: string;
            try {
                actual = await realpath(path);
            }
            catch {
                return;
            }
            if (actual !== root && !actual.startsWith(root + '/')) {
                this.issues.push(`链接越界：${path}`);
                return;
            }
            if (visited.has(actual))
                return;
            visited.add(actual);
            let top = '';
            try {
                top = await git(actual, ['rev-parse', '--show-toplevel']);
            }
            catch { }
            if (top === actual) {
                const alias = Object.entries(this.config.repositories).find(([, r]) => expand(r.path) === actual)?.[0] || basename(path).toLowerCase();
                if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(alias)) {
                    const p = await this.resolve(actual,options); entries.set(p.alias,p); return;
                }
                if (entries.has(alias)) {
                    entries.get(alias)!.error = '项目别名重名，需要外部配置明确别名';
                    this.issues.push(`项目重名：${alias}`);
                    return;
                }
                entries.set(alias, await this.inspect(actual, alias, options));
                return;
            }
            let children;
            try {
                children = await readdir(actual, { withFileTypes: true });
            }
            catch {
                return;
            }
            if (actual !== root && children.some(e => ['package.json', 'pyproject.toml', 'README.md'].includes(e.name)))
                this.issues.push(`非 Git 目录：${path}`);
            for (const e of children)
                if (!e.name.startsWith('.') && !skip.has(e.name) && (e.isDirectory() || e.isSymbolicLink()))
                    await walk(join(actual, e.name));
        };
        await walk(root);
        this.entries = entries;
    }
    private async inspect(actual: string, alias: string, options: BaselineOptions = {}): Promise<PreparedProject> {
                const explicit = this.config.repositories[alias];
                let github = explicit?.github || '', baseBranch = explicit?.baseBranch || '';
                let error: string | undefined;
                try {
                    const remote = await git(actual, ['remote', 'get-url', 'origin']);
                    const gh = /^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote)?.[1];
                    if (!gh)
                        throw new Error('首版需要 GitHub origin');
                    if (github && github !== gh)
                        throw new Error('origin 与配置仓库不匹配');
                    github = gh;
                    if (!baseBranch)
                        try {
                            baseBranch = (await git(actual, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).replace(/^refs\/remotes\/origin\//, '');
                        }
                        catch {
                            for (const candidate of ['main', 'master']) {
                                try {
                                    await git(actual, ['rev-parse', '--verify', `refs/remotes/origin/${candidate}`]);
                                    baseBranch = candidate;
                                    break;
                                }
                                catch { }
                            }
                        }
                    if (!baseBranch)
                        throw new Error('需要明确默认分支');
                }
                catch (e) {
                    error = (e as Error).message;
                }
                if(error)throw new Error(error);
                const identity = digest({ path: actual, github });
                const baseline=await snapshot(this.config,actual,identity,baseBranch,{...options,synchronize:this.synchronize});
                const saved=this.store.project<{profile:ProjectProfile;version:string;profileSource?:ProfileSource}>(identity);
                const profileSource:ProfileSource=this.config.profiles[alias]?'external':saved?(saved.profileSource||'legacy'):'auto';
                const proposed=this.config.profiles[alias] || (saved && profileSource!=='auto' ? saved.profile : (actual===this.config.productDocs?ProfileSchema.parse({kind:'docs'}):await proposeProfile(alias,baseline.directory)));
                if(profileSource==='auto' && explicit?.checks?.length)
                    proposed.checks=[...proposed.checks,...explicit.checks.map(c=>({...c,env:{}}))];
                const profile=validateProfile(proposed),mergeMethod=explicit?.mergeMethod||'merge';
                const version=digest({profile,baseBranch,mergeMethod,deployment:explicit?.deployment});
                return {alias,path:actual,github,baseBranch,mergeMethod,identity,profile,profileSource,version,
                    baselineSha:baseline.sha,snapshotPath:baseline.directory,ready:saved?.version===version,
                    manualMerge:github===this.config.controllerRepository||this.config.protectedRepositories.includes(github),deployment:explicit?.deployment};
    }

    async resolve(input: string, options: BaselineOptions = {}): Promise<PreparedProject> {
        if (!input || /[\r\n\0]/.test(input)) throw new Error('Invalid project path');
        const root = await realpath(expand(this.config.projectsRoot));
        const configured = this.config.repositories[input];
        const candidate = configured ? expand(configured.path) : resolve(root, input);
        const actual = await realpath(candidate);
        if (actual === root || !actual.startsWith(root + '/')) throw new Error('项目路径越界');
        if (await git(actual, ['rev-parse', '--show-toplevel']) !== actual) throw new Error('请选择 Git 仓库根目录，不自动创建仓库');
        let known:string|undefined;
        for(const [name,r] of Object.entries(this.config.repositories))if(await realpath(expand(r.path)).catch(()=>undefined)===actual){known=name;break;}
        let alias = known || basename(actual).toLowerCase();
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(alias)) alias = 'project-' + digest(actual).slice(0,12);
        const collision = this.entries.get(alias);
        if (collision && collision.path !== actual) alias += '-' + digest(actual).slice(0,8);
        const project = await this.inspect(actual, alias, options);
        if (project.error) throw new Error(project.error);
        const saved=this.store.project<{alias?:string}>(project.identity);
        if(!known&&saved?.alias)project.alias=saved.alias;
        project.relativePath=relative(root,actual);
        this.entries.set(project.alias, project);
        return project;
    }
    async refresh(targets: RepoExecution[], options: BaselineOptions = {}) {
        for (const t of targets) {
            const p = await this.resolve(t.path, options);
            if (p.identity !== t.identity || p.alias !== t.projectId) throw new Error('项目身份变化，需重新确认方案');
        }
    }
    get(alias: string) { const p = this.entries.get(alias); if (!p || p.error)
        throw new Error(p?.error || `尚未解析项目 ${alias}；可用中文描述需求重新分析`); return p; }
    approve(target: RepoExecution) { const p = this.get(target.projectId); if (p.identity !== target.identity)
        throw new Error('项目身份已变化'); validateProfile(target.profile); this.store.saveProject(p.identity, { alias:p.alias,path:p.path,profile: target.profile, profileSource:target.profileSource||'legacy', version: target.profileVersion, confirmedAt: new Date().toISOString() }); p.profile = target.profile; p.profileSource=target.profileSource||'legacy'; p.version = target.profileVersion; p.ready = true; }
    target(project: string | Project): RepoExecution { const p = typeof project==='string'?this.get(project):project; const alias=p.alias; return { projectId: alias, identity: p.identity, path: p.path, github: p.github, baseBranch: p.baseBranch, mergeMethod: p.mergeMethod, profile: structuredClone(p.profile), profileSource:p.profileSource, baselineSnapshot:p.snapshotPath, baseSha:p.baselineSha, profileVersion: p.version, manualMerge: p.manualMerge, deployment: p.deployment }; }
    list() { return [...this.entries.values()].map(p => `${p.alias}: ${p.error || (p.ready ? '已接入' : '首次需确认方案')} · ${p.profile.kind} · ${p.manualMerge ? '手动合并' : '邮件合并'} · ${p.deployment?.enabled ? '已配置发布' : '发布未启用'}`).join('\n') + '\n' + this.issues.join('\n'); }
    changed(target: RepoExecution) { const p = this.get(target.projectId); return p.identity !== target.identity || p.version !== target.profileVersion || digest(p.deployment) !== digest(target.deployment); }
    async documents(productId?: string, baselineSha?: string, options: BaselineOptions = {}) {
        if (!productId)
            return { version: '', text: '', files:[], missing:[], legacyVersion:'' };
        if(!this.config.productDocs)throw Error('Configure productDocs before using a product ID');
        const root = await realpath(expand(this.config.productDocs));
        const project=await this.resolve(root, {...options,sha:baselineSha});
        const ref=project.baselineSha;
        const files=(await git(root,['ls-tree','-r','--name-only',ref,'--','ideas','prd','design','decisions'])).split('\n').filter(f=>{
            const name=f.split('/').at(-1)!;
            return name.startsWith(productId+'-')&&name.endsWith('.md');
        });
        const missing=['ideas','prd','design'].filter(kind=>!files.some(f=>f.startsWith(kind+'/')));
        const docs=[];
        for(const f of files.sort()){
            const mode=await git(root,['ls-tree',ref,'--',f]);
            if(mode.startsWith('120000'))throw new Error('产品文档不能使用链接');
            docs.push({file:f,text:(await execute('git',['-c','core.hooksPath=/dev/null','show',`${ref}:${f}`],{cwd:root,timeoutMs:30000})).stdout});
        }
        return { version: digest({docs,missing}), legacyVersion:digest(docs), files:docs.map(d=>d.file), missing, baselineSha:ref, text: docs.map(d => `${d.file}\n${d.text}`).join('\n\n') };
    }
    migrateSession(s: Session): Session {
        if (s.targets || s.system)
            return s;
        const p = this.entries.get(s.repo);
        if (!p)
            throw new Error(`迁移需要项目 ${s.repo}`);
        const target = { ...this.target(s.repo), worktree: s.worktree, branch: s.branch, baseSha: s.baseSha, thread: s.thread, reviewSha: s.reviewSha, prNumber: s.prNumber, prUrl: s.prUrl, mergeSha: s.mergeSha, deployRelease: s.deployRelease, deployUncertain: s.deployUncertain, deployed: s.state === 'DONE' };
        if (['WAITING_START', 'WAITING_REVIEW', 'QUEUED', 'RUNNING', 'PLANNING', 'WAITING_INPUT'].includes(s.state)) {
            s.needsRefresh = 'plan';
            s.planNotice = undefined;
            s.reviewNotice = undefined;
            s.state = 'QUEUED';
            s.lastError = '升级后需要重新确认方案或 Review';
        }
        if (s.state === 'MERGING') {
            s.mergeUncertain = s.repo;
            s.reviewNotice = undefined;
        }
        return { ...s, targets: [target], mergeOrder: [s.repo] };
    }
}
