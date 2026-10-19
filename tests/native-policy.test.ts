import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { ConfigSchema, expand } from '../src/config.js';
import { nativeFilesystem, asyncPolicy, installationRoot, prepareNativeFilesystem, claudeSessionStorage, claudeProjectKey } from '../src/async-policy.js';
import { developmentEnvironment, shellEnvironment } from '../src/runner.js';
import { spawnSandboxedClaude } from '../src/claude-client.js';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
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
    assert.equal(rules[join(config.dataDir,'async-cli/features/primary/input')],'read');
    assert.equal(rules[config.mailCodexHome!],'deny');
    assert.equal(rules[config.dataDir],'deny');assert.equal(rules[join(config.dataDir,'async-cli/features/primary')],'write');
    assert.equal(rules[join(config.dataDir,'artifacts')],undefined); // The whole private parent is masked.
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
    assert.equal(rules[actual],'deny');assert.equal(rules[join(actual,'async-cli/features/primary')],'write');
    assert.equal(rules[join(actual,'artifacts','**')],undefined);
});
test('a selected npm Codex shim exposes its pinned native platform package for Linux re-exec',async()=>{
    const {root,config}=await fixture(),scope=join(root,'tools/node_modules/@openai'),pkg=join(scope,'codex');
    await mkdir(join(pkg,'bin'),{recursive:true});await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@openai/codex'}));
    const shim=join(pkg,'bin/codex.js');await writeFile(shim,'#!/usr/bin/env node\n',{mode:0o700});
    const platformPackage=join(scope,`codex-${process.platform}-${process.arch}`);await mkdir(platformPackage);
    config.codexCommand=shim;
    const rules=nativeFilesystem(config,c);assert.equal(rules[pkg],'read');assert.equal(rules[platformPackage],'read');
    assert.equal(rules[scope],undefined); // Other account packages are not exposed.
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

test('new Claude storage leaves the native session ID unused and mounts only its own project directory', async () => {
    const {root, config} = await fixture(), previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-home');
    const task = {...c, executorSession:'11111111-1111-4111-8111-111111111111'};
    try {
        const initial = claudeSessionStorage(config, task);
        prepareNativeFilesystem(config, task, process.execPath);
        const storage = claudeSessionStorage(config, task), transcript = join(storage.project, task.executorSession + '.jsonl');
        assert.deepEqual(storage, initial);
        assert.equal(storage.legacy, false);
        await assert.rejects(access(transcript), {code:'ENOENT'});
        const rules = nativeFilesystem(config, task, process.execPath);
        assert.equal(rules[storage.project], 'write');
        assert.notEqual(rules[join(process.env.CLAUDE_CONFIG_DIR, 'projects')], 'write');
        assert.notEqual(rules[join(process.env.CLAUDE_CONFIG_DIR, 'projects', claudeProjectKey(config.projectsRoot))], 'write');
        // Simulate native creation, then restart preparation without overwriting history.
        await writeFile(transcript, 'synthetic native history');
        prepareNativeFilesystem(config, task, process.execPath);
        assert.deepEqual(claudeSessionStorage(config, task), storage);
        assert.equal(await readFile(transcript, 'utf8'), 'synthetic native history');
        const other = {...task, id:'foreign', executorSession:'22222222-2222-4222-8222-222222222222'};
        assert.notEqual(claudeSessionStorage(config, other).project, storage.project);
    } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    }
});

test('existing Claude sessions retain their original cwd, history bytes and exact sandbox grants', async () => {
    const {root, config} = await fixture(), previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-home');
    const task = {...c, executorSession:'11111111-1111-4111-8111-111111111111'};
    try {
        const project = join(process.env.CLAUDE_CONFIG_DIR, 'projects', claudeProjectKey(config.projectsRoot));
        await mkdir(project, {recursive:true});
        const transcript = join(project, task.executorSession + '.jsonl');
        await writeFile(transcript, 'synthetic existing history');
        const existingCwd = join(config.dataDir, 'async-cli/features/primary/claude');
        await mkdir(existingCwd); await writeFile(join(existingCwd, 'existing.txt'), 'synthetic task content');
        prepareNativeFilesystem(config, task, process.execPath);
        assert.deepEqual(claudeSessionStorage(config, task), {cwd:config.projectsRoot, project, legacy:true});
        const rules = nativeFilesystem(config, task, process.execPath);
        assert.equal(rules[transcript], 'write'); assert.notEqual(rules[project], 'write');
        assert.equal(await readFile(transcript, 'utf8'), 'synthetic existing history');
        assert.equal(await readFile(join(existingCwd, 'existing.txt'), 'utf8'), 'synthetic task content');
    } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    }
});

test('native project keys for long paths remain readable by the pinned SDK', async () => {
    const {root} = await fixture(), previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(root, 'claude-home');
    try {
        const cwd = join(root, 'synthetic-project-'.repeat(8), 'synthetic-worktree-'.repeat(5));
        await mkdir(cwd, {recursive:true});
        assert.ok(cwd.length > 200);
        const project = join(process.env.CLAUDE_CONFIG_DIR, 'projects', claudeProjectKey(cwd));
        await mkdir(project, {recursive:true});
        const session = '11111111-1111-4111-8111-111111111111';
        await writeFile(join(project, session + '.jsonl'), JSON.stringify({type:'user', uuid:'22222222-2222-4222-8222-222222222222',
            parentUuid:null, sessionId:session, cwd, message:{role:'user', content:'Synthetic long-path input.'}}) + '\n');
        const messages = await getSessionMessages(session, {dir:cwd});
        assert.equal(messages.length, 1);
        assert.deepEqual(messages[0].message, {role:'user', content:'Synthetic long-path input.'});
    } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    }
});
