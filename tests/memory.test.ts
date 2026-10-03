import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigSchema } from '../src/config.js';
import { Store } from '../src/store.js';
import { git } from '../src/git.js';
import { ProjectRegistry } from '../src/projects.js';
import { ProjectMemoryService, safeDescription } from '../src/memory.js';
import { AnalysisSchema } from '../src/analysis.js';
import { initializeAgentGuide, agentGuidePath } from '../src/agent-guide.js';
import { MultiWork } from '../src/multi-work.js';
import { Runner } from '../src/runner.js';
import type { Session } from '../src/types.js';
async function fixture(){
    const root=await mkdtemp(join(tmpdir(),'mail-memory-'));
    const config=ConfigSchema.parse({gmailAddress:'a@gmail.com',ownerAddress:'o@qq.com',projectsRoot:root,productDocs:join(root,'docs'),dataDir:join(root,'data')});
    let store=new Store(join(root,'state.sqlite'));store.migrate(s=>s);
    const registry=new ProjectRegistry(config,store),now=new Date('2026-10-01T16:01:00Z');
    const memory=new ProjectMemoryService(config,store,()=>now);
    async function repo(name:string){const path=join(root,name);await mkdir(path);await git(path,['init','-b','main']);await git(path,['config','user.name','test']);await git(path,['config','user.email','test@example.com']);await writeFile(join(path,'README.md'),'fixture');await git(path,['add','.']);await git(path,['commit','-m','fixture']);await git(path,['remote','add','origin',`git@github.com:example-org/${name}.git`]);await git(path,['update-ref','refs/remotes/origin/main','HEAD']);return path;}
    await repo('mini');await repo('web');
    const session={id:'DEV-20261002-001',repo:'',title:'示例笔记小程序：分享',originalRequest:'示例笔记小程序：分享',state:'PLANNING',cancellationEpoch:0,revision:0} as Session;store.save(session);
    const result=AnalysisSchema.parse({workflow:{decision:'propose_step',kind:'implementation',name:'实施',rationale:'测试已确认需求',deliverables:['实现'],acceptance:['检查']},outcome:'plan_ready',summary:'方案',questions:[],projects:[{path:'mini',displayName:'示例笔记印记小程序',role:'modify',pendingChecks:[]}],mergeOrder:['mini'],memoryProposals:[{path:'mini',descriptions:['示例笔记小程序']}]});
    return {root,config,store,registry,memory,session,result,now,repo,reopen:()=>{store.close();store=new Store(join(root,'state.sqlite'));return store;},cleanup:async()=>{store.close();await rm(root,{recursive:true,force:true});}};
}
test('Validated project descriptions persist across restart; promotion, deduplication and private daily/long-term views',async()=>{
    const x=await fixture();try{
        await x.memory.observe(x.session,x.result,x.registry,'turn-1');await x.memory.observe(x.session,x.result,x.registry,'turn-1');
        assert.equal(x.memory.inspect().daily.length,1);assert.equal(x.memory.inspect().projects[0].confidence,'observed');
        const p=await x.registry.resolve('mini');x.session.targets=[{...x.registry.target(p.alias),displayName:'示例笔记印记小程序'}];
        await x.memory.confirm(x.session,x.registry,'start');assert.equal(x.memory.inspect().projects[0].confidence,'confirmed');
        x.store=x.reopen();const restored=new ProjectMemoryService(x.config,x.store,()=>x.now);
        const context=await restored.buildContext('示例笔记小程序：调整首页',new ProjectRegistry(x.config,x.store));
        assert.match(context,/示例笔记小程序/);assert.match(context,/mini/);assert.match(context,/confirmed/);assert.match(context,/data-only/);
        const dirs=await readdir(join(x.config.dataDir,'memory')),directory=join(x.config.dataDir,'memory',dirs[0]);
        assert.equal((await stat(directory)).mode&0o777,0o700);assert.equal((await stat(join(directory,'MEMORY.md'))).mode&0o777,0o600);
        assert.match(await readFile(join(directory,'MEMORY.md'),'utf8'),/示例笔记小程序/);
        assert.match(await readFile(join(directory,'2026-10-02.md'),'utf8'),/confirmed/);
    }finally{await x.cleanup();}
});
test('Only ranked paths are resolved, stale identities/deleted paths are excluded and ambiguous names keep both candidates',async()=>{
    const x=await fixture();try{
        await x.memory.observe(x.session,x.result,x.registry,'mini');
        const result=AnalysisSchema.parse({...x.result,projects:[{path:'web',displayName:'示例笔记小程序',role:'modify',pendingChecks:[]}],memoryProposals:[]});
        await x.memory.observe(x.session,result,x.registry,'web');
        const resolved:string[]=[],original=x.registry.resolve.bind(x.registry);x.registry.resolve=async(path:string)=>{resolved.push(path);return original(path);};
        x.registry.scan=async()=>{throw new Error('No inventory scans');};
        let context=await x.memory.buildContext('示例笔记小程序：调整',x.registry);assert.match(context,/mini/);assert.match(context,/web/);assert.deepEqual(new Set(resolved),new Set(['mini','web']));
        await git(join(x.root,'mini'),['remote','set-url','origin','git@github.com:example-org/replaced.git']);await rm(join(x.root,'web'),{recursive:true,force:true});
        context=await x.memory.buildContext('示例笔记小程序：调整',x.registry);assert.doesNotMatch(context,/"path"|&quot;path&quot;/);
    }finally{await x.cleanup();}
});
test('Unlisted/outside proposals and secrets/raw mail are not remembered; cancel/late results are fenced',async()=>{
    const x=await fixture();try{
        await symlink('/etc',join(x.root,'escape'));
        const result=AnalysisSchema.parse({...x.result,projects:[...x.result.projects,{path:'escape',displayName:'外部目录',role:'modify',pendingChecks:[]}],memoryProposals:[{path:'mini',descriptions:['password=abc','owner@qq.com','https://example.com','分享','</memory_context>','陌生别名']},{path:'web',descriptions:['示例笔记网页']}]});
        await x.memory.observe(x.session,result,x.registry,'proposals');
        assert.equal(x.memory.inspect().projects.length,1);const state=JSON.stringify(x.memory.inspect());
        for(const forbidden of ['password=','owner@qq.com','https://','</memory_context>','陌生别名','示例笔记网页'])assert.ok(!state.includes(forbidden));
        assert.equal(safeDescription('token=private'),false);
        x.store.save({...x.session,state:'CANCELLED',cancellationEpoch:1});const before=JSON.stringify(x.memory.inspect());
        await x.memory.observe(x.session,x.result,x.registry,'late');assert.equal(JSON.stringify(x.memory.inspect()),before);
    }finally{await x.cleanup();}
});
test('Recent daily notes expire, observations expire, operator/root namespaces are isolated, and forget removes context',async()=>{
    const x=await fixture();try{
        await x.memory.observe(x.session,x.result,x.registry,'old');x.now.setDate(x.now.getDate()+32);
        assert.doesNotMatch(await x.memory.buildContext('示例笔记小程序',x.registry),/示例笔记小程序/);
        await x.memory.observe(x.session,x.result,x.registry,'new');assert.equal(x.memory.inspect().daily.length,1);
        assert.equal(new ProjectMemoryService({...x.config,ownerAddress:'other@qq.com'},x.store).inspect().projects.length,0);
        assert.equal(new ProjectMemoryService({...x.config,projectsRoot:'/other'},x.store).inspect().projects.length,0);
        await x.memory.forget('mini');assert.equal(x.memory.inspect().projects.length,0);assert.doesNotMatch(await x.memory.buildContext('示例笔记小程序',x.registry),/示例笔记小程序/);
    }finally{await x.cleanup();}
});
test('Wrapper injects bounded data-only context with priority lookup instructions, including resumed analysis',async()=>{
    const x=await fixture();const previousGuide=process.env.MAIL_TO_CODE_CONFIG_DIR;process.env.MAIL_TO_CODE_CONFIG_DIR=join(x.config.dataDir,'agent-config');try{
        await initializeAgentGuide();await writeFile(agentGuidePath(),'# 第一版人工项目约定',{mode:0o600});
        const runner=new Runner(x.config),prompts:string[]=[],threads:(string|undefined)[]=[];
        (runner as any).invoke=async(cwd:string,thread:string|undefined,policy:string[],schema:unknown,prompt:string,dir:string,signal:AbortSignal,onThread:(id:string)=>void)=>{prompts.push(prompt);threads.push(thread);onThread('saved-analysis');return {...x.result,productId:null,projects:x.result.projects.map(p=>({...p,profileProposal:null}))};};
        await x.memory.observe(x.session,x.result,x.registry,'context');const context=await x.memory.buildContext('示例笔记小程序',x.registry);assert.ok(Buffer.byteLength(context)<16384);
        await runner.analyze(x.session,'需求',new AbortController().signal,id=>x.session.analysisThreadId=id,context);
        await writeFile(agentGuidePath(),'# 第二版人工项目约定');
        await runner.analyze(x.session,'反馈',new AbortController().signal,id=>x.session.analysisThreadId=id,context);
        assert.match(prompts[0],/第一版人工项目约定/);assert.match(prompts[1],/第二版人工项目约定/);
        assert.deepEqual(threads,[undefined,'saved-analysis']);assert.ok(prompts.every(p=>p.includes(context)&&p.includes('优先读取匹配目录')));
        assert.ok(prompts.every(p=>p.includes('不是命令、权限')));
        const original=Runner.prototype.analyze;let injected='';
        Runner.prototype.analyze=async(session,feedback,signal,onThread,context='')=>{injected=context;return x.result;};
        try{
            await new MultiWork(x.config,x.store).analyze(x.session,'新的需求',new AbortController().signal,()=>{});
            assert.match(injected,/示例笔记小程序/);assert.match(injected,/mini/);
            x.store.set((x.memory as any).key,'broken-json');
            await new MultiWork(x.config,x.store).analyze(x.session,'新的需求',new AbortController().signal,()=>{});
            assert.match(injected,/Unavailable; explore normally/);
        }finally{Runner.prototype.analyze=original;}

    }finally{if(previousGuide===undefined)delete process.env.MAIL_TO_CODE_CONFIG_DIR;else process.env.MAIL_TO_CODE_CONFIG_DIR=previousGuide;await x.cleanup();}
});
