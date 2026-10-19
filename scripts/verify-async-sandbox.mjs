// Matching-version OS sandbox only. Synthetic filesystem/network, no model or business effects.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ConfigSchema } from '../dist/src/config.js';
import { asyncPolicy, ASYNC_CODEX_VERSION } from '../dist/src/async-cli.js';
import { spawnSandboxedClaude, checkClaude } from '../dist/src/claude-client.js';
import { execute } from '../dist/src/process.js';
import { developmentEnvironment } from '../dist/src/runner.js';
process.umask(0o077);
const command = process.env.ASYNC_CODEX_COMMAND || 'codex';
assert.equal((await execute(command,['--version'])).stdout.trim(),`codex-cli ${ASYNC_CODEX_VERSION}`);
const claude = await checkClaude(process.env.ASYNC_CLAUDE_COMMAND || 'claude');
const root = await realpath(await mkdtemp(join(tmpdir(),'mail-native-sandbox-'))), projectsRoot = join(root,'projects'), dataDir = join(projectsRoot,'state');
const c = {id:randomUUID(), subject:'Synthetic', gmailThread:'mail', createdAt:'now',executor:'claude',executorSession:randomUUID()};
const directory = join(dataDir,'async-cli/features',c.id), foreign = join(dataDir,'async-cli/features/foreign');
for(const path of [projectsRoot,dataDir,join(directory,'notes'),join(directory,'worktrees'),join(directory,'tmp'),join(directory,'input'),foreign,join(dataDir,'artifacts'),join(dataDir,'backups')]) await mkdir(path,{recursive:true});
const mail = join(projectsRoot,'mail-login');await mkdir(mail);
// Native account history lives outside writable projects, as on the service host.
const claudeHome=join(root,'claude-home');await mkdir(join(claudeHome,'projects','foreign'),{recursive:true});process.env.CLAUDE_CONFIG_DIR=claudeHome;
process.env.MAIL_TO_CODE_CONFIG_DIR=mail;
const devConfig=join(root,'developer-config');await mkdir(join(devConfig,'gh'),{recursive:true});
process.env.GIT_CONFIG_GLOBAL=join(devConfig,'gitconfig');process.env.GH_CONFIG_DIR=join(devConfig,'gh');
await writeFile(process.env.GIT_CONFIG_GLOBAL,'[user]\n name = Synthetic\n email = synthetic@example.test\n');await writeFile(join(process.env.GH_CONFIG_DIR,'config.yml'),'git_protocol: https\n');
const linked = join(root,'external');await mkdir(join(linked,'.git'),{recursive:true});await symlink(linked,join(projectsRoot,'linked'));
const blocked = {mail:join(mail,'auth.json'),database:join(dataDir,'async-cli.sqlite'),adapterLock:join(dataDir,'daemon.lock'),foreign:join(foreign,'FEATURE.md'),frozen:join(dataDir,'artifacts','frozen.png'),outside:join(root,'outside.txt'),foreignNativeSession:join(claudeHome,'projects','foreign','session.jsonl')};
for(const file of Object.values(blocked)) await writeFile(file,'synthetic protected');
const config = ConfigSchema.parse({gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',projectsRoot,dataDir,mailCodexHome:mail,codexCommand:command});
let claudeHomeOverlapRejected;
if(process.platform==='linux'){
    process.env.CLAUDE_CONFIG_DIR=projectsRoot;
    try{assert.throws(()=>asyncPolicy(config,c,claude),/CLAUDE_HOME_OVERLAPS_SANDBOX_GRANT/);claudeHomeOverlapRejected=true;}
    finally{process.env.CLAUDE_CONFIG_DIR=claudeHome;}
}
const liveFuture=Object.fromEntries(['codex','claude'].map(boundary=>[boundary,{
    liveDatabase:join(dataDir,`live-${boundary}.sqlite`),liveFrozen:join(dataDir,'artifacts',`live-${boundary}.png`),
    liveTask:join(dataDir,'async-cli/features',`live-${boundary}`,'notes','state.txt'),
    liveNativeHistory:join(claudeHome,'projects',`live-${boundary}`,'session.jsonl'),
}]));
// This local HTTP server exercises allowed outbound transport with no external target.
const server = createServer(async(request,response)=>{
    response.setHeader('Content-Type','application/json');
    if(request.url?.startsWith('/create-future?boundary=')){
        const boundary=request.url.split('=').at(-1),files=liveFuture[boundary];
        if(!files){response.statusCode=400;response.end('{}');return;}
        try{for(const file of Object.values(files)){await mkdir(join(file,'..'),{recursive:true});await writeFile(file,'synthetic protected');}response.end('{"created":true}');}
        catch{response.statusCode=500;response.end('{}');}
        return;
    }
    response.end(JSON.stringify({number:7,state:'open',head:{sha:'synthetic'},merged:false}));
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const port=server.address().port;
const input={blocked,protectedDirectories:{runtimeRoot:dataDir,foreignTask:foreign,mailLogin:mail},projectsRoot,worktrees:join(directory,'worktrees'),devGit:process.env.GIT_CONFIG_GLOBAL,devGh:join(process.env.GH_CONFIG_DIR,'config.yml'),project:join(projectsRoot,'native.txt'),git:join(linked,'.git','probe'),notes:join(directory,'notes','probe.txt'),input:join(directory,'input','fixture.txt'),url:`http://127.0.0.1:${port}/repos/example-org/synthetic/pulls/7`};
input.outsideNew=Object.fromEntries(['codex','claude'].map(boundary=>[boundary,join(root,`outside-created-${boundary}.txt`)]));
input.liveFutureUrl=`http://127.0.0.1:${port}/create-future?boundary=`;
await writeFile(input.input,'synthetic input');
const policy=asyncPolicy(config,c);
// Future DB sidecars and frozen/foreign state must remain protected after policy generation.
blocked.futureDb=join(dataDir,'async-cli.sqlite-wal');blocked.futureFrozen=join(dataDir,'artifacts','later.png');blocked.futureTask=join(foreign,'later.txt');
for(const id of [c.id.slice(0,-1),c.id+'-extra',c.id.slice(0,-1)+'x']){const path=join(dataDir,'async-cli/features',id);await mkdir(path);blocked['nearTask'+id]=join(path,'state.txt');await writeFile(blocked['nearTask'+id],'synthetic protected');}
for(const key of ['futureDb','futureFrozen','futureTask']) await writeFile(blocked[key],'synthetic protected');
// Open existing protected host files without O_CREAT: Linux's empty private root
// may allow disposable shadow files at an invisible path, never host-file access.
// Host bytes are independently checked after both sandbox processes exit.
const probe=`const fs=require('node:fs');const cp=require('node:child_process');const p=JSON.parse(process.argv[1]);(async()=>{if(!(await(await fetch(p.liveFutureUrl+p.boundary)).json()).created)throw Error('LIVE_FIXTURE_CREATION_FAILED');const r={};try{fs.writeFileSync(p.outsideNew[p.boundary],'synthetic shadow');}catch{}for(const [k,v]of Object.entries(p.protectedDirectories)){try{fs.renameSync(v,v+'-moved');r[k+'RenameDenied']=false;fs.renameSync(v+'-moved',v);}catch{r[k+'RenameDenied']=true;}}for(const [k,v]of Object.entries(p.blocked)){try{fs.readFileSync(v);r[k+'ReadDenied']=false;}catch{r[k+'ReadDenied']=true;}try{const fd=fs.openSync(v,'r+');try{fs.writeSync(fd,'changed');r[k+'WriteDenied']=false;}finally{fs.closeSync(fd);}}catch{r[k+'WriteDenied']=true;}}for(const k of ['project','git','notes']){fs.writeFileSync(p[k],'native write');r[k+'Write']=true;}r.inputRead=fs.readFileSync(p.input,'utf8')==='synthetic input';try{fs.writeFileSync(p.input,'changed');r.inputWriteDenied=false;}catch{r.inputWriteDenied=true;}r.nativeGit=cp.execFileSync('git',['--version'],{encoding:'utf8'}).startsWith('git version');r.nativeGh=cp.execFileSync('gh',['--version'],{encoding:'utf8'}).startsWith('gh version');r.developerGitConfig=fs.readFileSync(p.devGit,'utf8').includes('Synthetic');r.developerGhConfig=fs.readFileSync(p.devGh,'utf8').includes('https');r.nativeGhPrQuery=JSON.parse(cp.execFileSync('gh',['api',p.url],{encoding:'utf8',env:{...process.env,GH_TOKEN:'synthetic-gh-token'}})).number===7;if(p.nativeHistory){fs.appendFileSync(p.nativeHistory,'synthetic history');r.ownNativeHistory=true;}const repo=p.projectsRoot+'/generated-'+p.boundary;cp.execFileSync('git',['init','-b','main',repo]);fs.writeFileSync(repo+'/README.md','synthetic');cp.execFileSync('git',['-C',repo,'add','.']);cp.execFileSync('git',['-C',repo,'commit','-m','Synthetic']);cp.execFileSync('git',['-C',repo,'worktree','add','--detach',p.worktrees+'/'+p.boundary]);r.nativeWorktreeCreated=fs.readFileSync(p.worktrees+'/'+p.boundary+'/README.md','utf8')==='synthetic';r.nativeLocalHttp=(await(await fetch(p.url)).json()).number===7;process.stdout.write(JSON.stringify(r));})().catch(e=>{console.error(e.message);process.exit(1);});`;
const reports={};
try {
    const direct=await execute(command,['sandbox',...policy,'-P','mail-to-code-task','-C',projectsRoot,'--',process.execPath,'-e',probe,JSON.stringify({...input,blocked:{...blocked,...liveFuture.codex},boundary:'codex'})],{cwd:projectsRoot,env:developmentEnvironment(join(directory,'tmp')),timeoutMs:30000});
    reports.codex=JSON.parse(direct.stdout);
    await assert.rejects(readFile(input.outsideNew.codex),{code:'ENOENT'});reports.codex.outsideCreationIsolated=true;
    // The exact SDK spawn path wraps the entire command, not only shell tools.
    const child=spawnSandboxedClaude(config,c,claude,{command:process.execPath,args:['-e',probe,JSON.stringify({...input,blocked:{...blocked,...liveFuture.claude},boundary:'claude',nativeHistory:join(claudeHome,'projects',projectsRoot.replace(/[^a-zA-Z0-9]/g,'-'),c.executorSession+'.jsonl')})],cwd:projectsRoot,env:developmentEnvironment(join(directory,'tmp')),signal:new AbortController().signal});
    let output='',stderr='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{stderr+=b;});
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,stderr);reports.claudeProcessBoundary=JSON.parse(output);
    await assert.rejects(readFile(input.outsideNew.claude),{code:'ENOENT'});reports.claudeProcessBoundary.outsideCreationIsolated=true;
    for(const [executor,checks]of Object.entries(reports))for(const [name,passed]of Object.entries(checks))assert.equal(passed,true,executor+':'+name);
    for(const file of [...Object.values(blocked),...Object.values(liveFuture).flatMap(Object.values)])assert.equal(await readFile(file,'utf8'),'synthetic protected');
    console.log(JSON.stringify({passed:true,codexVersion:ASYNC_CODEX_VERSION,platform:process.platform,claudeHomeOverlapRejected,checks:reports,realMailSent:0,businessEffects:0},null,2));
} finally {await new Promise(resolve=>server.close(resolve));}
