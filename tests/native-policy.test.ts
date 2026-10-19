import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { ConfigSchema, expand } from '../src/config.js';
import { nativeFilesystem, asyncPolicy, installationRoot } from '../src/async-policy.js';
import { developmentEnvironment, shellEnvironment } from '../src/runner.js';
import { spawnSandboxedClaude } from '../src/claude-client.js';
const c = { id: 'primary', subject: 'Synthetic', gmailThread: 'mail', createdAt: 'now' };
test('home expansion resolves the host credential root rather than a relative tilde directory',()=>{
    assert.equal(expand('~'),homedir());assert.equal(expand('~/.ssh'),join(homedir(),'.ssh'));
});
async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'native-policy-'))), projects = join(root, 'projects');
    const config = ConfigSchema.parse({ gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',projectsRoot:projects,dataDir:join(projects,'state'),mailCodexHome:join(projects,'mail-login') });
    await mkdir(config.dataDir,{recursive:true}); await mkdir(config.mailCodexHome!);
    for(const path of ['primary/notes','primary/tmp','primary/input','primary/worktrees','foreign/notes']) await mkdir(join(config.dataDir,'async-cli/features',path),{recursive:true});
    for(const path of ['artifacts','backups','effect-logs']) await mkdir(join(config.dataDir,path));
    await writeFile(join(config.dataDir,'async-cli.sqlite'),'synthetic');
    return {root,config};
}
test('static policy opens project/Git/task paths without scope or prepared worktrees and masks mail/state',async()=>{
    const {config}=await fixture(),rules=nativeFilesystem(config,c);
    assert.equal(rules[config.projectsRoot],'write');assert.equal(rules[join(config.dataDir,'async-cli/features/primary/notes')],'write');
    assert.equal(rules[join(config.dataDir,'async-cli/features/primary/input')],'read');assert.ok(Object.keys(rules).some(p=>p.includes('features/{')&&p.includes('[!p]*')&&rules[p]==='deny'));
    assert.equal(rules[config.mailCodexHome!],'deny');assert.equal(rules[join(config.dataDir,'async-cli.sqlite')],'deny');
    assert.equal(rules[config.dataDir],'read');assert.equal(rules[join(config.dataDir,'async-cli/features/primary')],'read');
    assert.equal(rules[join(config.dataDir,'*.sqlite*')],'deny');assert.equal(rules[join(config.dataDir,'artifacts')],'deny');
    assert.equal(rules[await realpath(installationRoot)],'read');assert.equal(rules[':root'],'deny');
    const policy=asyncPolicy(config,c).join('\n');assert.match(policy,/network.enabled=true/);assert.match(policy,/features.plugins=false/);assert.match(policy,/features.hooks=false/);
    assert.doesNotMatch(policy,/WRITABLE_SCOPE_REQUIRED|requestId|targetHash/);
});
test('explicit repositories and operator directory links open canonical project and Git paths',async()=>{
    const {root,config}=await fixture(), repo=join(root,'external');await mkdir(join(repo,'.git'),{recursive:true});await symlink(repo,join(config.projectsRoot,'linked'));
    config.repositories={sample:{path:repo,github:'example-org/sample',baseBranch:'main',mergeMethod:'merge',checks:[]}};
    const rules=nativeFilesystem(config,c);assert.equal(rules[repo],'write');assert.equal(rules[join(config.projectsRoot,'linked')],undefined);
});
test('a linked data directory still protects future database sidecars at the canonical path',async()=>{
    const {root,config}=await fixture(),linked=join(root,'linked-state'),actual=config.dataDir;
    await symlink(actual,linked);config.dataDir=linked;
    const rules=nativeFilesystem(config,c);
    assert.equal(rules[join(actual,'*.sqlite*')],'deny');assert.equal(rules[join(linked,'*.sqlite*')],'deny');
    assert.equal(rules[join(actual,'artifacts','**')],'deny');
});
test('development auth is selected from host only; mail environment gets no development secrets',()=>{
    const source={HOME:'/synthetic/home',PATH:'/synthetic/bin',GITHUB_TOKEN:'synthetic',GH_CONFIG_DIR:'/synthetic/gh',GIT_SSH_COMMAND:'ssh -F /synthetic/ssh-config',SSH_AUTH_SOCK:'/synthetic/socket',ANTHROPIC_API_KEY:'model-only',MAIL_TO_CODE_CONFIG_DIR:'/synthetic/mail',NODE_OPTIONS:'unsafe'};
    const dev=developmentEnvironment('/synthetic/tmp',source),mail=shellEnvironment(source);
    assert.equal(dev.GITHUB_TOKEN,'synthetic');assert.equal(dev.GIT_SSH_COMMAND,source.GIT_SSH_COMMAND);assert.equal(dev.TMPDIR,'/synthetic/tmp');
    for(const key of ['GITHUB_TOKEN','GH_CONFIG_DIR','GIT_SSH_COMMAND','SSH_AUTH_SOCK','ANTHROPIC_API_KEY']) assert.equal(mail[key],undefined);
    assert.equal(dev.MAIL_TO_CODE_CONFIG_DIR,undefined);assert.equal(dev.NODE_OPTIONS,undefined);
});
test('Claude process launch never falls back when the sandbox launcher is unavailable',async()=>{
    const {config}=await fixture();config.codexCommand='/synthetic/missing-sandbox';
    // No native session storage preparation or credential use in this synthetic failure.
    const child=spawnSandboxedClaude(config,c,process.execPath,{command:process.execPath,args:['-e','process.stdout.write("UNSANDBOXED")'],cwd:config.projectsRoot,env:{PATH:process.env.PATH},signal:new AbortController().signal});
    let output='';child.stdout.on('data',chunk=>{output+=chunk;});
    await new Promise<void>(resolve=>child.once('error',()=>resolve()));assert.equal(output,'');assert.equal(child.pid,undefined);
});
