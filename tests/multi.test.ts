import {Runner} from '../src/runner.js';
import {ScopeResolutionError} from '../src/scope.js';
import {installSemanticFixture,drainObservations,wire,synthetic} from './semantic-fixture.js';
import {fakeMail} from './fake-mail.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigSchema } from '../src/config.js';
import { Store } from '../src/store.js';
import { git } from '../src/git.js';
import { ProjectRegistry, digest } from '../src/projects.js';
import { MultiController, manifest } from '../src/multi-controller.js';
import { validateProfile } from '../src/profile.js';
import { codexPolicy } from '../src/runner.js';
import { markdownChecks, RuntimeAdapter } from '../src/runtime.js';
import type { MultiWork } from '../src/multi-work.js';
import type { Work } from '../src/controller.js';
import type { Incoming, Session, RepoExecution } from '../src/types.js';
import { migrate } from '../src/migration.js';
import {planManifest} from '../src/multi-work.js';
async function fixture(legacy = false) {
    const root = await mkdtemp(join(tmpdir(), 'mail-multi-')), store = new Store(':memory:');
    const config = ConfigSchema.parse({ gmailAddress: 'a@gmail.com', ownerAddress: 'o@qq.com', projectsRoot: root, productDocs: join(root, 'product-records'), dataDir: join(root, 'data'),controllerRepository:'example-org/mail-to-code', previewEnabled: false });
    if (!legacy)
        store.migrate(s => s);
    async function repo(alias: string, parent = root) { const path = join(parent, alias); await mkdir(path, { recursive: true }); await git(path, ['init', '-b', 'main']); await git(path, ['config', 'user.name', 'test']); await git(path, ['config', 'user.email', 'test@example.com']); await writeFile(join(path, 'README.md'), 'fixture'); await git(path, ['add', '.']); await git(path, ['commit', '-m', 'fixture']); await git(path, ['remote', 'add', 'origin', `https://github.com/example-org/${alias}.git`]); await git(path, ['update-ref', 'refs/remotes/origin/main', 'HEAD']); return path; }
    await repo('one');
    await repo('two');
    const registry = new ProjectRegistry(config, store,(path,branch,signal)=>git(path,['fetch',path,`+refs/heads/${branch}:refs/remotes/origin/${branch}`],{signal}));
    await registry.scan(true);
    const merged: string[] = [], deployed: string[] = [], phases: string[] = [], threads: string[] = [];
    let sends = 0, failMerge = '', failCheck = false;
    const scopeRunner=new Runner(config);scopeRunner.interpret=async()=>{throw Error('UNEXPECTED_SCOPE_MODEL');};
    const work = { resolveScope:async(s:Session,t:RepoExecution,result:any,signal:AbortSignal)=>scopeRunner.resolveScope({...s,repo:t.projectId},result,signal), prepare: async (s: Session, t: RepoExecution) => { t.worktree = t.path; }, run: async (s: Session, t: RepoExecution, p: string, f: string, signal: AbortSignal, onThread: (id: string) => void) => { phases.push(p); if (t.thread)
            threads.push(t.thread); onThread('thread-' + t.projectId); return { outcome: p === 'plan' ? 'plan_ready' : 'implementation_ready', summary: '完成', questions: [], requiresBackend: false, screenshotTargets: [] }; }, validate: async () => { }, updateBase: async () => { }, review: async (s: Session, t: RepoExecution) => { if (failCheck)
            throw new Error('TEST_FAILED'); t.baseSha = await git(t.path,['rev-parse','HEAD']); t.reviewSha = 'head-' + t.projectId; t.prNumber = 1; t.prUrl = `https://github.com/example-org/${t.projectId}/pull/1`; t.checks = ['independent check passed']; }, inspect: async (s: Session, t: RepoExecution) => t.mergeSha, merge: async (s: Session, t: RepoExecution) => { if (t.projectId === failMerge)
            throw new Error('CONFLICT'); merged.push(t.projectId); return 'merged-' + t.projectId; }, deploy: async (s: Session, t: RepoExecution) => { deployed.push(t.projectId); t.deployed = true; }, productEvidence: async (s:Session,t:RepoExecution) => { } };
    Object.assign(work,{
      analyze:async(s:Session,f:string,signal:AbortSignal,onThread:(id:string)=>void)=>{phases.push('plan');onThread('analysis-thread');const paths=s.projectHints?.length?s.projectHints:['one'];return {workflow:{decision:'propose_step',kind:'implementation',name:'实施',rationale:'已确认需求',deliverables:['实现'],acceptance:['测试']},outcome:'plan_ready',summary:'完成',questions:[],projects:paths.map(path=>({path,displayName:'项目 '+path,role:'modify',pendingChecks:[]})),mergeOrder:paths};},
      prepareProject:async(path:string,r:ProjectRegistry)=>{const p=await r.resolve(path);return p;},
      snapshot:async(s:Session,t:RepoExecution)=>{t.baseSha='base';return t.path;},
      verifyPlan:async(s:Session,r:ProjectRegistry)=>{await r.refresh([...(s.targets||[]),...(s.references||[])]);assert.equal(s.planManifest,planManifest(s));for(const t of s.targets!)if(r.get(t.projectId).version!==s.planRegistryVersions?.[t.projectId])throw new Error('项目配置变化');}
    });
    const mail=fakeMail(config,()=>{sends++;});
    Object.assign(work,{interpretReply:async(s:Session,c:any)=>({action:'feedback',clear:true,evidence:c.incoming.text,feedback:c.incoming.text,question:''})});
    const controller = new MultiController(config, store, mail, {} as Work, registry, work as unknown as MultiWork);
    installSemanticFixture(work,store);drainObservations(controller,store);
    let n = 0;
    const message = (text: string, reply = '', subject?: string) => ({ id: 'm' + (++n), rfcId: `<m${n}@qq.com>`, threadId: 'initial', inReplyTo: reply, subject: subject || 'Re: ' + store.sessions().filter(s => !s.system)[0]?.subject, text, from: config.ownerAddress, trusted: true } as Incoming);
    const s = () => store.sessions().filter(s => !s.system)[0];
    const flush = async () => { while (store.mails().some(m => m.status === 'pending'))
        await controller.flush(); };
    const review = async (body = 'PROJECTS: one, two') => { controller.handle(message(body, '', 'NEW one: 任务')); await controller.startNext(); await flush(); controller.handle(message('START', s().planNotice)); await controller.startNext(); await flush(); };
    return { root, store, config, registry, repo, work, scopeRunner, controller, message, s, flush, review, merged, deployed, phases, threads, setFailMerge: (v: string) => failMerge = v, setFailCheck: (v: boolean) => failCheck = v, cleanup: async () => { await controller.stop(); store.close(); await rm(root, { recursive: true, force: true }); } };
}
test('Registry discovers new/deleted repositories, deduplicates links, rejects escape and duplicate aliases', async () => { const x = await fixture(); try {
    assert.equal(x.registry.entries.size, 2);
    await x.repo('three');
    await symlink(join(x.root, 'one'), join(x.root, 'same'));
    await symlink('/etc', join(x.root, 'escape'));
    await x.repo('one', join(x.root, 'nested'));
    await x.registry.scan(true);
    assert.equal(x.registry.entries.size, 3);
    assert.match(x.registry.list(), /链接越界/);
    assert.throws(() => x.registry.get('one'), /重名/);
    await rm(join(x.root, 'three'), { recursive: true });
    await x.registry.scan(true);
    assert.equal(x.registry.entries.has('three'), false);
}
finally {
    await x.cleanup();
} });
test('First RUN cannot skip onboarding; configuration change requires a fresh START', async () => { const x = await fixture(); try {
    x.controller.handle(x.message('task', '', 'NEW one RUN: first'));
    assert.equal(x.store.jobs()[0].kind, 'interpret');
    await x.controller.startNext();
    await x.flush();
    const old = x.s().planNotice!;
    x.config.profiles.one = validateProfile({ checks: [{ executable: 'node', args: ['--version'] }] });
    x.config.repositories.one = { path: join(x.root, 'one'), github: 'example-org/one', baseBranch: 'main', mergeMethod: 'squash', checks: [] };
    await x.registry.scan(true);
    x.controller.handle(x.message('START', old));
    await x.controller.startNext();
    assert.equal(x.store.jobs().filter(j => j.status === 'queued'&&j.kind==='plan').length,1);
    await x.controller.startNext();
    await x.flush();
    x.controller.handle(x.message('START', x.s().planNotice));
    await x.controller.startNext();
    assert.equal(x.registry.get('one').ready, true);
    assert.equal(x.s().targets![0].mergeMethod, 'squash');
    await x.registry.scan(true);
    assert.equal(x.registry.changed(x.s().targets![0]), false);
    await x.controller.startNext();
    assert.equal(x.s().state, 'WAITING_REVIEW');
}
finally {
    await x.cleanup();
} });
test('Multi-repo review, session IDs, old approvals, non-UI evidence, manual controller and exact DEPLOY target', async () => {
    const x = await fixture();
    try {
        await x.review();
        assert.equal(x.s().targets!.length, 2);
        assert.equal(x.s().state, 'WAITING_REVIEW');
        const old = x.s().reviewNotice!;
        x.controller.handle(x.message('修改', old));
        await x.controller.startNext();
        await x.flush();
        assert.deepEqual([...new Set(x.threads)].sort(), ['thread-one', 'thread-two']);
        x.controller.handle(x.message('APPROVE', old));
        assert.equal(x.merged.length, 0);
        x.controller.handle(x.message('APPROVE', x.s().reviewNotice));
        await x.controller.startNext();
        assert.deepEqual(x.merged, ['one', 'two']);
        await x.flush();
        x.controller.handle(x.message('DEPLOY', x.s().mergeNotice));
        assert.equal(x.deployed.length, 0);
        const task = x.s(), t = task.targets![1];
        t.deployment = { enabled: true, host: 'test', domain: 'test.invalid', remoteBase: '/tmp/test', script: 'scripts/deploy.sh', adapter: 'script', args: [], healthPaths: ['/'] };
        x.config.repositories.two={path:t.path,github:t.github,baseBranch:t.baseBranch,mergeMethod:'merge',checks:[],deployment:t.deployment};
        const updated=await x.registry.resolve('two');t.profileVersion=updated.version;x.registry.approve(t);
        x.store.save(task);
        task.mergeNotice=x.store.notify(task,'merge','当前发布配置已更新，请重新确认').id;x.store.save(task);await x.flush();
        x.controller.handle(x.message('DEPLOY two', task.mergeNotice));
        await x.controller.startNext();
        assert.deepEqual(x.deployed, ['two']);
    }
    finally {
        await x.cleanup();
    }
});
test('Partial merge stops, records progress and requires a new approval rather than RETRY continuation', async () => { const x = await fixture(); try {
    await x.review();
    const old = x.s().reviewNotice!;
    x.setFailMerge('two');
    x.controller.handle(x.message('APPROVE', old));
    await x.controller.startNext();
    assert.deepEqual(x.merged, ['one']);
    assert.equal(x.s().targets![0].mergeSha, 'merged-one');
    assert.notEqual(x.s().reviewNotice, old);
    await x.controller.startNext();
    await x.flush();
    assert.equal(x.s().state, 'WAITING_REVIEW');
    assert.notEqual(x.s().reviewNotice, old);
    x.controller.handle(x.message('APPROVE', old));
    assert.deepEqual(x.merged, ['one']);
    x.setFailMerge('');
    x.controller.handle(x.message('APPROVE', x.s().reviewNotice));
    await x.controller.startNext();
    assert.deepEqual(x.merged, ['one', 'two']);
}
finally {
    await x.cleanup();
} });
test('mail-to-code identity forces whole batch manual; manifest/head changes invalidate approval', async () => { const x = await fixture(); try {
    await x.review();
    let task = x.s();
    task.targets![1].manualMerge = true;
    x.store.save(task);
    x.controller.handle(x.message('APPROVE', task.reviewNotice));
    await x.controller.startNext();
    assert.equal(x.store.jobs().some(j => j.status === 'queued'), false);
    task.targets![1].manualMerge = false;
    task.targets![0].reviewSha = 'changed';
    x.store.save(task);
    x.controller.handle(x.message('APPROVE', task.reviewNotice));
    await x.controller.startNext();
    assert.equal(x.store.jobs().some(j => j.status === 'queued'), false);
    assert.notEqual(task.reviewManifest, manifest(task));
}
finally {
    await x.cleanup();
} });
test('Failed checks cannot enter Review; feedback stays queued and cancellation fences late results', async () => {
    const x = await fixture();
    try {
        x.setFailCheck(true);
        await x.review();
        assert.equal(x.s().state, 'FAILED');
        assert.equal(x.store.mails().some(m => m.kind === 'review'), false);
    }
    finally {
        await x.cleanup();
    }
    const y = await fixture();
    try {
        let finish: (v: any) => void = () => { }, started: () => void = () => { };
        const start = new Promise<void>(r => started = r);
        Object.assign(y.work,{analyze:async()=>{started();return new Promise(r=>finish=r);}});
        y.controller.handle(y.message('task', '', 'NEW one: task'));
        const pending = y.controller.startNext()!;
        await start;
        y.controller.handle(y.message('意见'));
        assert.equal(y.store.jobs().filter(j => j.status === 'queued').length, 1);
        y.controller.handle(y.message('CANCEL'));
        await y.controller.startNext();
        finish({ outcome: 'plan_ready', summary: 'done', questions: [], requiresBackend: false, screenshotTargets: [] });
        await pending;
        assert.equal(y.s().state, 'CANCELLED');
        assert.equal(y.store.mails().some(m => m.kind === 'plan'), false);
    }
    finally {
        await y.cleanup();
    }
});
test('Migration is transactional, preserves v1 cursor/outbox/SHA/thread and snapshot backup', async () => { const x = await fixture(true); try {
    x.config.repositories.sampleapp = { path: join(x.root, 'sampleapp'), github: 'example-org/sampleapp', baseBranch: 'main', mergeMethod: 'merge', checks: [] };
    await x.repo('sampleapp');
    await x.registry.scan(true);
    const old: Session = { id: 'DEV-20261001-001', repo: 'sampleapp', title: 'old', subject: 'old', state: 'WAITING_REVIEW', createdAt: 'old', initialMessageId: 'old', initialRfcId: '<old>', initialThreadId: 'initial', thread: 'actual-thread', worktree: '/saved/worktree', reviewSha: 'saved-head', mergeSha: undefined, summary: 'summary', revision: 2, cancellationEpoch: 0 };
    x.store.save(old);
    x.store.save({...old,id:'DEV-20261001-002',state:'RUNNING',blockedPhase:'develop'});
    x.store.set('gmail_history', 'saved-cursor');
    const out = x.store.notify(old, 'review', 'saved-mail');
    out.text='saved-mail';delete out.presentation;delete out.summary;delete out.questions;delete out.approvalBinding;x.store.saveMail(out);
    assert.throws(() => x.store.migrate(() => { throw new Error('abort'); }), /abort/);
    assert.equal(x.store.get('schema_version'), '1');
    await assert.rejects(migrate(x.config, x.store, x.registry, async () => true), /Stop/);
    const result = await migrate(x.config, x.store, x.registry, async () => false);
    assert.equal(result.version, 7);
    assert.equal(x.store.get('gmail_history'), 'saved-cursor');
    assert.equal(x.store.mail(out.id)!.text, 'saved-mail');
    const t = x.store.session(old.id)!.targets![0];
    assert.equal(t.thread, 'actual-thread');
    assert.equal(t.worktree, '/saved/worktree');
    assert.equal(t.reviewSha, 'saved-head');
    assert.equal(x.store.session('DEV-20261001-002')!.state,'RUNNING');
    assert.equal(x.store.session('DEV-20261001-002')!.targets![0].thread,'actual-thread');
    assert.equal(x.store.jobs().find(j=>j.sessionId===old.id)!.feedback,'__REVALIDATE__');
    assert.equal(x.store.session(old.id)!.reviewNotice, undefined);
}
finally {
    await x.cleanup();
} });
test('Profile rejects privilege, credential injection, external preview and unpinned services; Markdown links checked', async () => { for (const profile of [{ checks: [{ executable: 'ssh', args: [] }] }, { checks: [{ executable: 'node', env: { GITHUB_TOKEN: 'no' } }] }, { preview: { paths: ['//prod.invalid'] } }, { services: [{ name: 'db', image: 'postgres:latest', health: ['true'] }] }])
    assert.throws(() => validateProfile(profile)); const x = await fixture(); try {
    await writeFile(join(x.root, 'one', 'README.md'), '[broken](missing.md)');
    await assert.rejects(markdownChecks(join(x.root, 'one')), /Broken/);
    await writeFile(join(x.root, 'one', 'missing.md'), 'okay');
    assert.match((await markdownChecks(join(x.root, 'one')))[0], /1 local links/);
}
finally {
    await x.cleanup();
} });
test('PROJECTS and unknown aliases produce a reply without code execution; arbitrary product prefixes resolve docs', async () => { const x = await fixture(); try {
    x.controller.handle(x.message('', '', 'PROJECTS'));
    await x.controller.startNext();
    assert.match(x.store.mails()[0].text, /one/);
    x.controller.handle({ ...x.message('', '', 'NEW missing: task'), threadId: 'new-unknown' });
    assert.equal(x.store.jobs().filter(j=>j.status==='queued')[0].kind,'interpret');
    await x.repo('product-records');
    for (const folder of ['ideas', 'prd', 'design', 'decisions'])
        await mkdir(join(x.config.productDocs, folder));
    for (const folder of ['ideas', 'prd', 'design'])
        await writeFile(join(x.config.productDocs, folder, 'OTHER-0007-test.md'), 'synthetic');
    await git(x.config.productDocs,['add','.']);await git(x.config.productDocs,['commit','-m','product fixture']);await git(x.config.productDocs,['update-ref','refs/remotes/origin/main','HEAD']);
    const docs = await x.registry.documents('OTHER-0007');
    assert.equal(docs.version.length, 64);
    await writeFile(join(x.config.productDocs,'design','OTHER-0007-test.md'),'uncommitted design');
    assert.equal((await x.registry.documents('OTHER-0007')).version,docs.version);
}
finally {
    await x.cleanup();
} });
test('Cancellation during merge preserves the external SHA without moving the task or starting next merge', async () => { const x = await fixture(); try {
    await x.review();
    let resolve: (sha: string) => void = () => { }, began: () => void = () => { };
    const started = new Promise<void>(r => began = r);
    x.work.merge = async () => { began(); return new Promise(r => resolve = r); };
    x.controller.handle(x.message('APPROVE', x.s().reviewNotice));
    const pending = x.controller.startNext()!;
    await started;
    x.controller.handle(x.message('CANCEL'));
    await x.controller.startNext();
    resolve('external-known-sha');
    await pending;
    assert.equal(x.s().state, 'CANCELLED');
    assert.equal(x.s().targets![0].mergeSha, 'external-known-sha');
    assert.equal(x.s().targets![1].mergeSha, undefined);
    assert.equal(x.store.mails().some(m => m.kind === 'merge'), false);
}
finally {
    await x.cleanup();
} });
test('Interrupted merge retains per-repository progress and fences RETRY until external reconciliation', async () => { const x = await fixture(); try {
    await x.review();
    const s = x.s();
    s.state = 'MERGING';
    s.targets![0].mergeSha = 'merged-one';
    s.mergeUncertain = 'two';
    x.store.save(s);
    const j = x.store.enqueue(s, 'merge', s.reviewManifest!);
    j.status = 'running';
    x.store.saveJob(j);
    x.store.recover();
    assert.equal(x.s().state, 'FAILED');
    assert.equal(x.s().targets![0].mergeSha, 'merged-one');
    x.controller.handle(x.message('RETRY'));
    await x.controller.startNext();
    assert.equal(x.store.jobs().some(j => j.status === 'queued'), false);
}
finally {
    await x.cleanup();
} });
test('Task permissions deny tracked credential files in current and reference worktrees', async () => { const x = await fixture(); try {
    await writeFile(join(x.root, 'one', '.env.production'), 'synthetic');
    await writeFile(join(x.root, 'two', 'private.pem'), 'synthetic');
    const policy = codexPolicy(x.config, join(x.root, 'one'), 'develop', [join(x.root, 'two')]).join(' ');
    assert.match(policy, /\.env\.production.*deny/);
    assert.match(policy, /private\.pem.*deny/);
}
finally {
    await x.cleanup();
} });
test('Controller lease rejects another live process and can be released safely', async () => { const { acquireLease } = await import('../src/lease.js'); const x = await fixture(); try {
    await mkdir(x.config.dataDir,{recursive:true});
    const release = await acquireLease(x.config.dataDir);
    await assert.rejects(acquireLease(x.config.dataDir), /Another/);
    await release();
    await release();
    const next = await acquireLease(x.config.dataDir);
    await next();
}
finally {
    await x.cleanup();
} });

test('v1 flattened repository fields cannot leak into a newly added repository execution',async()=>{const x=await fixture();try{const {MultiWork}=await import('../src/multi-work.js');const t=x.registry.target('two'),s={id:'DEV-OLD',repo:'one',thread:'old-context',worktree:'/old-tree',branch:'old-branch',baseSha:'old-base',reviewSha:'old-head',prNumber:8,prUrl:'old-pr',mergeSha:'old-merge',summary:'old',targets:[t]} as Session;const view=new MultiWork(x.config,x.store).view(s,t);for(const key of ['thread','worktree','branch','baseSha','reviewSha','prNumber','prUrl','mergeSha'] as const)assert.equal(view[key],t[key]);assert.equal(view.repo,'two');}finally{await x.cleanup();}});

test('Chinese task starts unresolved, plans without worktrees and keeps separate analysis/development threads',async()=>{
  const x=await fixture();try{
    x.controller.handle(x.message('添加分享，先出方案','','示例笔记小程序：添加分享'));
    assert.equal(x.s().repo,'');assert.deepEqual(x.s().targets,[]);
    await x.controller.startNext();await x.flush();
    assert.equal(x.s().state,'WAITING_START');assert.equal(x.s().analysisThreadId,'analysis-thread');
    assert.equal(x.s().targets![0].worktree,undefined);assert.equal(x.s().targets![0].thread,undefined);
    assert.match(x.store.mail(x.s().planNotice!)!.text,/项目 one（one） \| 修改/);
    x.controller.handle(x.message('START',x.s().planNotice));await x.controller.startNext();
    assert.equal(x.s().state,'WAITING_REVIEW');assert.equal(x.s().targets![0].thread,'thread-one');
    assert.equal(x.s().analysisThreadId,'analysis-thread');
  }finally{await x.cleanup();}
});
test('Ambiguous natural description requests Chinese clarification and cannot START until resolved',async()=>{
  const x=await fixture();try{
    let calls=0;Object.assign(x.work,{analyze:async(s:Session,f:string,signal:AbortSignal,onThread:(id:string)=>void)=>{
      onThread('same-analysis');calls++;
      return calls===1?{workflow:{decision:'clarify',kind:'implementation',name:'实施',rationale:'已确认需求',deliverables:['实现'],acceptance:['测试']},outcome:'needs_input',summary:'有两个示例笔记项目',questions:['示例笔记网页（one）还是示例笔记小程序（two）？'],projects:[],mergeOrder:[]}:
        {workflow:{decision:'propose_step',kind:'implementation',name:'实施',rationale:'已确认需求',deliverables:['实现'],acceptance:['测试']},outcome:'plan_ready',summary:'修改小程序',questions:[],projects:[{path:'two',displayName:'示例笔记小程序',role:'modify',pendingChecks:[]}],mergeOrder:['two']};
    }});
    x.controller.handle(x.message('分享','','示例笔记：添加分享'));await x.controller.startNext();await x.flush();
    assert.equal(x.s().state,'WAITING_INPUT');assert.match(x.store.mails().at(-1)!.text,/示例笔记网页/);
    x.controller.handle(x.message('START'));await x.controller.startNext();assert.equal(x.store.jobs().some(j=>j.status==='queued'),false);
    x.controller.handle(x.message('是示例笔记小程序'));await x.controller.startNext();
    assert.equal(x.s().state,'WAITING_START');assert.equal(x.s().targets![0].projectId,'two');
    assert.equal(x.s().analysisThreadId,'same-analysis');
  }finally{await x.cleanup();}
});
test('Unknown reply headers/task IDs cannot create a natural task; catalog scans only on request',async()=>{
  const x=await fixture();try{
    let scans=0;const original=x.registry.scan.bind(x.registry);x.registry.scan=async(force?:boolean)=>{scans++;await original(force);};
    for(const m of [x.message('需求','<lost@mail>','自然主题'),x.message('意见','','Re: 旧任务'),x.message('意见','','[DEV-20261001-999] 旧任务'),x.message('APPROVE','','')])x.controller.handle(m);
    assert.equal(x.store.jobs().some(j=>j.kind!=='interpret'),false);assert.equal(scans,0);
    Object.defineProperty(x.work,'interpretReply',{value:async(_s:Session,c:any)=>c.mode==='outcome'?synthetic(_s,c):c.incoming.subject==='PROJECTS'?wire({items:[{id:'catalog',action:'catalog',clear:true,evidence:'PROJECTS',text:'列出项目',questionRefs:[],dependsOn:[]}],questions:[]}):wire({items:[],questions:[{text:'请指出正确任务',kind:'open',dependsOn:[]}]})});
    x.controller.handle({...x.message('','','PROJECTS'),threadId:'catalog'});await x.controller.startNext();
    assert.equal(scans,1);assert.match(x.store.mails().at(-1)!.text,/one/);
  }finally{await x.cleanup();}
});
test('On-demand resolver discovers a new Chinese directory without inventory or alias config and rejects escapes',async()=>{
  const x=await fixture();try{
    const path=join(x.root,'中文小程序');await mkdir(path);await git(path,['init','-b','main']);await git(path,['config','user.name','test']);await git(path,['config','user.email','test@example.com']);await writeFile(join(path,'README.md'),'new project');await git(path,['add','.']);await git(path,['commit','-m','fixture']);await git(path,['remote','add','origin','git@github.com:example-org/new-mini.git']);await git(path,['update-ref','refs/remotes/origin/main',await git(path,['rev-parse','HEAD'])]);
    const p=await x.registry.resolve('中文小程序');assert.equal(p.path,await realpath(path));assert.match(p.alias,/^project-/);assert.equal(p.ready,false);
    await symlink('/etc',join(x.root,'outside'));await assert.rejects(x.registry.resolve('outside'),/越界/);
    await assert.rejects(x.registry.resolve('one/src'),/ENOENT/);
  }finally{await x.cleanup();}
});
test('Reference repositories remain outside write targets and are included in START manifest',async()=>{
  const x=await fixture();try{
    Object.assign(x.work,{analyze:async()=>({workflow:{decision:'propose_step',kind:'implementation',name:'实施',rationale:'已确认需求',deliverables:['实现'],acceptance:['测试']},outcome:'plan_ready',summary:'跨项目参考',questions:[],projects:[{path:'one',displayName:'小程序',role:'modify',pendingChecks:[]},{path:'two',displayName:'参考服务',role:'reference',pendingChecks:[]}],mergeOrder:['one']})});
    x.controller.handle(x.message('参考服务','','小程序修改'));await x.controller.startNext();await x.flush();
    assert.equal(x.s().targets!.length,1);assert.equal(x.s().references!.length,1);assert.match(x.store.mail(x.s().planNotice!)!.text,/只读参考/);
    const initial=x.s().planManifest;const changed=x.s();changed.references![0].baseSha='new-base';assert.notEqual(initial,planManifest(changed));
  }finally{await x.cleanup();}
});
test('Natural feedback requiring another repository replans and waits for new START without widening execution',async()=>{
  const x=await fixture();try{
    await x.review('PROJECTS: one');await x.flush();
    const old=x.s().reviewNotice;x.work.run=async()=>({outcome:'implementation_ready',summary:'还需后端',questions:[],requiresBackend:true,screenshotTargets:[],scopeDecision:{decision:'propose_scope_change',reason:'需要新增后端写入',requests:[{projectId:null,identity:null,path:'two',role:'modify',reason:'新增后端接口'}],questions:[]}});
    x.controller.handle(x.message('同时调整后端',old));await x.controller.startNext();
    assert.equal(x.s().targets!.length,1);assert.equal(x.s().blockedPhase,'plan');assert.equal(x.store.jobs().filter(j=>j.status==='queued')[0].kind,'plan');
    Object.assign(x.work,{analyze:async()=>({workflow:{decision:'propose_step',kind:'implementation',name:'实施',rationale:'已确认需求',deliverables:['实现'],acceptance:['测试']},outcome:'plan_ready',summary:'两个仓库',questions:[],projects:['one','two'].map(path=>({path,displayName:path,role:'modify',pendingChecks:[]})),mergeOrder:['two','one']})});
    await x.controller.startNext();assert.equal(x.s().state,'WAITING_START');assert.equal(x.s().targets![1].worktree,undefined);
    x.controller.handle(x.message('APPROVE',old));assert.deepEqual(x.merged,[]);
  }finally{await x.cleanup();}
});
test('v2 migration keeps running development threads and refreshes only pending confirmations',async()=>{
  const x=await fixture();try{
    await x.review();const old=x.s(),running={...old,id:'DEV-20261001-888',state:'RUNNING' as const,thread:'legacy-thread'};
    x.store.save(running);const start={...old,id:'DEV-20261001-889',state:'WAITING_START' as const,planNotice:'old-plan'};x.store.save(start);
    const result=await migrate(x.config,x.store,x.registry,async()=>false);assert.equal(result.version,7);assert.equal(x.store.get('schema_version'),'7');
    assert.equal(x.store.session(running.id)!.thread,'legacy-thread');assert.equal(x.store.session(running.id)!.targets![0].thread,'thread-one');
    assert.equal(x.store.session(start.id)!.planNotice,undefined);assert.equal(x.store.session(old.id)!.reviewNotice,undefined);
    assert.equal(x.store.mail(old.reviewNotice!)!.text.includes('Review'),true);
  }finally{await x.cleanup();}
});
test('Default-branch snapshot ignores dirty checkout and creates no feature branch or worktree',async()=>{
  const x=await fixture();try{
    const {MultiWork}=await import('../src/multi-work.js'),p=join(x.root,'one');await git(p,['config',`url.${p}.insteadOf`,'https://github.com/example-org/one.git']);
    const head=await git(p,['rev-parse','HEAD']);await writeFile(join(p,'README.md'),'local dirty content');
    const t=x.registry.target('one'),s={id:'DEV-SNAPSHOT',targets:[t]} as Session;
    const snapshot=await new MultiWork(x.config,x.store).snapshot(s,t,new AbortController().signal);
    assert.equal(await readFile(join(snapshot,'README.md'),'utf8'),'fixture');assert.equal(await readFile(join(p,'README.md'),'utf8'),'local dirty content');
    assert.equal(t.baseSha,head);assert.equal(t.worktree,undefined);assert.equal(await git(p,['branch','--show-current']),'main');
    assert.equal((await git(p,['worktree','list','--porcelain'])).split('\n').filter(l=>l.startsWith('worktree ')).length,1);
  }finally{await x.cleanup();}
});
test('Inferred product IDs include independently validated product evidence last; explicit conflicts ask first',async()=>{
  const x=await fixture();try{
    await x.repo('product-records');for(const folder of ['ideas','prd','design']){await mkdir(join(x.config.productDocs,folder));await writeFile(join(x.config.productDocs,folder,'OTHER-0007-test.md'),'product record');}
    await git(x.config.productDocs,['add','.']);await git(x.config.productDocs,['commit','-m','product fixture']);await git(x.config.productDocs,['update-ref','refs/remotes/origin/main','HEAD']);
    Object.assign(x.work,{analyze:async()=>({workflow:{decision:'propose_step',kind:'implementation',name:'实施',rationale:'已确认需求',deliverables:['实现'],acceptance:['测试']},outcome:'plan_ready',summary:'产品修改',questions:[],productId:'OTHER-0007',projects:[{path:'one',displayName:'应用',role:'modify',pendingChecks:[]}],mergeOrder:['one']})});
    x.controller.handle(x.message('请读对应设计','','应用调整'));await x.controller.startNext();
    assert.equal(x.s().state,'WAITING_START');assert.equal(x.s().productId,'OTHER-0007');assert.equal(x.s().documentVersion!.length,64);
    assert.equal(x.s().targets!.at(-1)!.auxiliary,true);assert.equal(x.s().mergeOrder!.at(-1),'product-records');
  }finally{await x.cleanup();}
  const y=await fixture();try{
    Object.assign(y.work,{analyze:async()=>({workflow:{decision:'propose_step',kind:'implementation',name:'实施',rationale:'已确认需求',deliverables:['实现'],acceptance:['测试']},outcome:'needs_input',summary:'请确认产品',questions:['邮件产品与所讨论文档不同，请确认产品'],productId:'OTHER-0007',projects:[],mergeOrder:[]})});
    y.controller.handle(y.message('PRODUCT: DEMO-0003','','示例笔记小程序'));await y.controller.startNext();
    assert.equal(y.s().state,'WAITING_INPUT');assert.deepEqual(y.s().targets,[]);assert.match(y.store.mails().at(-1)!.text,/请确认产品/);
  }finally{await y.cleanup();}
});
test('START baseline failure automatically replans without source execution and fences the old notice',async()=>{
  const x=await fixture();try{
    x.controller.handle(x.message('需求','','应用修改'));await x.controller.startNext();await x.flush();const old=x.s().planNotice;
    let reject=true;const work=x.work as any,verify=work.verifyPlan;work.verifyPlan=async(...args:any[])=>{if(reject){reject=false;throw new Error('默认分支基线变化');}return verify(...args);};
    x.controller.handle(x.message('START',old));await x.controller.startNext();assert.equal(x.s().targets![0].worktree,undefined);
    assert.equal(x.store.jobs().filter(j=>j.status==='queued')[0].kind,'plan');await x.controller.startNext();await x.flush();
    assert.equal(x.s().state,'WAITING_START');assert.notEqual(x.s().planNotice,old);
    x.controller.handle(x.message('START',old));await x.controller.startNext();assert.equal(x.store.jobs().some(j=>j.status==='queued'),false);
  }finally{await x.cleanup();}
});
test('RUN cannot bypass semantic planning or the new-stage START',async()=>{
  const x=await fixture();try{
    const t=x.registry.target('one');x.registry.approve(t);
    x.controller.handle(x.message('实施','','NEW one RUN: task'));await x.controller.startNext();
    assert.equal(x.s().state,'WAITING_START');assert.equal(x.s().analysisThreadId,'analysis-thread');assert.deepEqual(x.phases,['plan','plan']);
  }finally{await x.cleanup();}
});

test('Restarted inventory cache does not force root reanalysis for unchanged development feedback',async()=>{
  const x=await fixture();try{
    await x.review('PROJECTS: one');await x.flush();const old=x.s().reviewNotice;
    x.registry.entries.clear();x.phases.length=0;
    x.controller.handle(x.message('调整说明',old));await x.controller.startNext();
    assert.equal(x.s().state,'WAITING_REVIEW');assert.deepEqual(x.phases,['develop']);assert.ok(x.threads.includes('thread-one'));
  }finally{await x.cleanup();}
});

test('Controller learns verified Chinese mapping during analysis and promotes it only after valid START',async()=>{
  const x=await fixture();try{
    const {ProjectMemoryService}=await import('../src/memory.js');
    Object.assign(x.work,{analyze:async(s:Session,f:string,signal:AbortSignal,onThread:(id:string)=>void)=>{onThread('root-memory');return {workflow:{decision:'propose_step',kind:'implementation',name:'实施',rationale:'已确认需求',deliverables:['实现'],acceptance:['测试']},outcome:'plan_ready',summary:'调整小程序',questions:[],projects:[{path:'one',displayName:'示例笔记印记小程序',role:'modify',pendingChecks:[]}],mergeOrder:['one'],memoryProposals:[{path:'one',descriptions:['示例笔记小程序']}]};}});
    x.controller.handle(x.message('先给方案','','示例笔记小程序：调整'));await x.controller.startNext();await x.flush();
    const memory=new ProjectMemoryService(x.config,x.store);assert.equal(memory.inspect().projects[0].confidence,'observed');
    assert.ok(memory.inspect().projects[0].descriptions.includes('示例笔记小程序'));assert.equal(x.s().targets![0].worktree,undefined);
    x.controller.handle(x.message('START','unknown'));await x.controller.startNext();assert.equal(memory.inspect().projects[0].confidence,'observed');
    x.controller.handle(x.message('START',x.s().planNotice));await x.controller.startNext();assert.equal(x.s().state,'WAITING_REVIEW');
    assert.equal(memory.inspect().projects[0].confidence,'confirmed');assert.equal(memory.inspect().projects.length,1);
  }finally{await x.cleanup();}
});

test('Multi-project intake is silent until its actionable plan or requested status',async()=>{
 const x=await fixture();try{
  x.controller.handle(x.message('PROJECTS: one','','NEW one: synthetic task'));assert.equal(x.store.mails().length,0);await x.flush();
  const events=x.store.db.prepare("SELECT data FROM events WHERE event='notification_internal'").all().map(row=>JSON.parse(String(row.data)));assert.equal(events[0].kind,'ack');
  const resume=(x.controller as any).startBusiness.bind(x.controller);(x.controller as any).startBusiness=()=>undefined;x.controller.handle(x.message('STATUS'));await x.controller.startNext();await x.flush();(x.controller as any).startBusiness=resume;assert.deepEqual(x.store.mails().map(m=>m.kind),['status']);
  await x.controller.startNext();assert.equal(x.s().state,'WAITING_START');assert.deepEqual(x.store.mails().map(m=>m.kind),['status','plan']);assert.equal(x.store.mail(x.s().planNotice!)!.approvalBinding!.action,'START');
 }finally{await x.cleanup();}
});

for(const legacy of [false,true])test(`Three approved repositories continue with one START (${legacy?'legacy descriptions':'structured identities'})`,async()=>{
 const x=await fixture();try{
  await x.repo('product-records');
  for(const folder of ['ideas','prd','design']){await mkdir(join(x.config.productDocs,folder));await writeFile(join(x.config.productDocs,folder,'DEMO-0005-test.md'),'synthetic confirmed product');}
  await git(x.config.productDocs,['add','.']);await git(x.config.productDocs,['commit','-m','synthetic product']);await git(x.config.productDocs,['update-ref','refs/remotes/origin/main','HEAD']);
  Object.assign(x.work,{analyze:async()=>({workflow:{decision:'propose_step',kind:'implementation',name:'实施',rationale:'已确认需求',deliverables:['两端代码及产品证据'],acceptance:['测试']},outcome:'plan_ready',summary:'已确认的同版本标签设计',questions:[],productId:'DEMO-0005',projects:[{path:'one',displayName:'示例 Web',role:'modify',pendingChecks:[]},{path:'two',displayName:'示例手机端',role:'modify',pendingChecks:[]}],mergeOrder:['one','two']})});
  x.controller.handle(x.message('继续已确认设计','','合成标签任务'));await x.controller.startNext();await x.flush();
  const plan=x.s().planNotice!,snapshot=structuredClone(x.store.mail(plan)),manifest=x.s().planManifest;let repairs=0;const executed:string[]=[],evidence:string[]=[];
  const run=x.work.run;x.work.run=async(s,t,...args)=>{
   executed.push(t.projectId);const r=await run(s,t,...args);
   if(t.projectId==='one'){
    const requests=s.targets!.filter(t=>t.projectId!=='one').map(t=>({projectId:t.projectId,identity:t.identity,path:null,role:t.auxiliary?'product_record' as const:'modify' as const,reason:'继续已批准仓库工作'}));
    if(legacy)return {...r,requestedProjects:['示例手机端：完成标签交互及验证','产品记录：获取两端 PR 后回填']};
    return {...r,scopeDecision:{decision:'within_approved_scope' as const,reason:'两个仓库均已批准',requests,questions:[]}};
   }return r;
  };
  x.scopeRunner.interpret=async()=>{repairs++;return {decision:'within_approved_scope',reason:'自然描述对应已批准仓库',requests:x.s().targets!.filter(t=>t.projectId!=='one').map(t=>({projectId:t.projectId,identity:t.identity,path:null,role:t.auxiliary?'product_record':'modify',reason:'后续实施及回填'})),questions:[]};};
  x.work.productEvidence=async(s,t)=>{evidence.push(t.projectId);};
  x.controller.handle(x.message('START',plan));await x.controller.startNext();await x.flush();
  assert.equal(x.s().state,'WAITING_REVIEW');assert.equal(x.s().workflow!.confirmed,true);assert.equal(x.s().workflow!.confirmedPlan,'已确认的同版本标签设计');assert.equal(x.s().planManifest,manifest);
  assert.deepEqual(executed,['one','two']);assert.deepEqual(evidence,['product-records']);assert.equal(repairs,legacy?1:0);
  assert.equal(x.store.mails().filter(m=>m.kind==='plan').length,1);assert.deepEqual(x.store.mail(plan),snapshot);
  assert.ok(x.s().targets!.every(t=>t.reviewSha&&t.worktree));assert.ok(!x.store.jobs().some(j=>j.status==='queued'&&j.kind==='plan'));
  // Recovery and duplicate receipt do not create another execution or confirmation.
  x.store.recover();await x.controller.startNext();assert.deepEqual(executed,['one','two']);assert.equal(x.store.mails().filter(m=>m.kind==='plan').length,1);
 }finally{await x.cleanup();}
});

test('Within-scope work does not hide real needs_input or turn it into a completed review',async()=>{
 const x=await fixture();try{
  await x.review('PROJECTS: one');await x.flush();
  x.work.run=async()=>({outcome:'needs_input',summary:'业务目标确实未明确',questions:['新的业务目标是什么？'],requiresBackend:false,screenshotTargets:[],scopeDecision:{decision:'within_approved_scope',reason:'仓库不变',requests:[],questions:[]}}) as any;
  x.controller.handle(x.message('业务反馈',x.s().reviewNotice));await x.controller.startNext();
  assert.equal(x.s().state,'WAITING_INPUT');assert.ok(x.store.mails().some(m=>m.kind==='input'));assert.equal(x.store.jobs().filter(j=>j.status==='queued'&&j.kind==='plan').length,0);
 }finally{await x.cleanup();}
});

test('Invalid scope repair fails internally without asking for new START or changing snapshots',async()=>{
 const x=await fixture();try{
  await x.review('PROJECTS: one');await x.flush();const snapshots=structuredClone(x.store.mails());
  x.work.run=async()=>({outcome:'implementation_ready',summary:'当前代码完成',questions:[],requiresBackend:false,screenshotTargets:[],requestedProjects:['描述待理解']});
  let calls=0;x.scopeRunner.interpret=async()=>{calls++;return {decision:'within_approved_scope',reason:'错误引用',requests:[{projectId:'missing',identity:'missing',path:null,role:'modify',reason:'错误'}],questions:[]};};
  x.controller.handle(x.message('继续代码调整',x.s().reviewNotice));await x.controller.startNext();
  assert.equal(calls,1);assert.equal(x.s().state,'FAILED');assert.ok(x.s().lastError!.startsWith('SCOPE_DECISION_INVALID'));assert.equal(x.s().workflow!.confirmed,true);
  assert.deepEqual(x.store.mails(),snapshots);assert.ok(!x.store.jobs().some(j=>j.status==='queued'&&j.kind==='plan'));
 }finally{await x.cleanup();}
});

test('A real reference-to-write change preserves worktrees and explains the new START',async()=>{
 const x=await fixture();try{
  Object.assign(x.work,{analyze:async()=>({workflow:{decision:'propose_step',kind:'implementation',name:'实施',rationale:'已确认需求',deliverables:['实现'],acceptance:['测试']},outcome:'plan_ready',summary:'应用修改与后端参考',questions:[],projects:[{path:'one',displayName:'应用',role:'modify',pendingChecks:[]},{path:'two',displayName:'后端',role:'reference',pendingChecks:[]}],mergeOrder:['one']})});
  x.controller.handle(x.message('修改应用','','范围验证'));await x.controller.startNext();await x.flush();const oldPlan=x.s().planNotice;
  x.work.run=async(s)=>({outcome:'implementation_ready',summary:'应用源码完成，但后端也需修改',questions:[],requiresBackend:true,screenshotTargets:[],scopeDecision:{decision:'propose_scope_change',reason:'新增接口需要后端写入，原批准仅允许参考',requests:[{projectId:s.targets![0].projectId,identity:s.targets![0].identity,path:null,role:'modify',reason:'原范围继续'},{projectId:s.references![0].projectId,identity:s.references![0].identity,path:null,role:'modify',reason:'新增服务端接口'}],questions:[]}}) as any;
  x.controller.handle(x.message('START',oldPlan));await x.controller.startNext();
  const worktree=x.s().targets![0].worktree,job=x.store.jobs().find(j=>j.status==='queued'&&j.kind==='plan')!;
  assert.ok(worktree);assert.equal(x.s().references![0].worktree,undefined);assert.match(job.scopeChange!.changes[0],/reference → modify/);
  Object.assign(x.work,{analyze:async()=>({workflow:{decision:'propose_step',kind:'implementation',name:'实施',rationale:'接口需要写后端',deliverables:['实现'],acceptance:['测试']},outcome:'plan_ready',summary:'修改应用和后端',questions:[],projects:['one','two'].map(path=>({path,displayName:path,role:'modify',pendingChecks:[]})),mergeOrder:['one','two']})});
  await x.controller.startNext();await x.flush();assert.equal(x.s().state,'WAITING_START');assert.equal(x.s().workflow!.confirmed,false);assert.equal(x.s().targets![0].worktree,worktree);assert.equal(x.s().targets![1].worktree,undefined);
  assert.match(x.store.mail(x.s().planNotice!)!.text,/reference → modify/);assert.match(x.store.mail(x.s().planNotice!)!.text,/新增服务端接口/);
  x.controller.handle(x.message('START',oldPlan));await x.controller.startNext();assert.equal(x.s().targets![1].worktree,undefined);
 }finally{await x.cleanup();}
});


test('Real blockers accompany scope-change planning instead of being discarded',async()=>{
 const x=await fixture();try{
  await x.review('PROJECTS: one');await x.flush();
  x.work.run=async()=>({outcome:'needs_input',summary:'缺少业务事实，当前实现未完成',questions:['需要负责人提供样例格式'],requiresBackend:true,screenshotTargets:[],scopeDecision:{decision:'propose_scope_change',reason:'还需要新接口仓库',requests:[{projectId:null,identity:null,path:'two',role:'modify',reason:'接口实现'}],questions:[]}}) as any;
  x.controller.handle(x.message('修改接口',x.s().reviewNotice));await x.controller.startNext();
  const job=x.store.jobs().find(j=>j.kind==='plan'&&j.status==='queued')!;assert.ok(job);assert.match(job.feedback,/needs_input/);assert.match(job.feedback,/需要负责人提供样例格式/);assert.match(job.feedback,/当前实现未完成/);assert.equal(x.s().state,'WAITING_INPUT');
 }finally{await x.cleanup();}
});
