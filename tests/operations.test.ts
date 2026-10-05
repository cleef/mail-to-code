import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../src/config.js';
import { AsyncStore, type Conversation } from '../src/async-store.js';
import { AsyncTools, ASYNC_TOOLS } from '../src/async-tools.js';
import { OperationsAdapter, digest, withProjectOperationLock } from '../src/operations.js';
import { asyncPolicy, ASYNC_CONTRACT } from '../src/async-cli.js';
import { DeployAdapter } from '../src/deploy.js';
import { git, type GitAdapter } from '../src/git.js';
import type { Session, Incoming } from '../src/types.js';

const signal = () => new AbortController().signal;
const mail = (id: string, text: string): Incoming => ({ id, text, threadId: 'gmail', rfcId: `<${id}@example.test>`, inReplyTo: '', subject: 'Synthetic operations', from: 'owner@example.test', trusted: true });
async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'controlled-operations-')));
    const projects = join(root, 'projects'), privateDirectory = join(root, 'private'), data = join(root, 'data');
    await Promise.all([mkdir(projects), mkdir(privateDirectory, { mode: 0o700 }), mkdir(data)]);
    const script = join(privateDirectory, 'operation'), trace = join(privateDirectory, 'trace');
    await writeFile(script, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(trace)},'call\\n');\nconsole.log(JSON.stringify({ok:true,summary:'Synthetic check',evidence:{value:process.argv[2]||'default',id:process.env.MAIL_TO_CODE_OPERATION_ID}}));\n`, { mode: 0o700 });
    const repositories: any = {};
    for (const alias of ['sample', 'other']) {
        const path = join(projects, alias); await mkdir(path);
        await git(path, ['init', '-b', 'main']);
        await git(path, ['remote', 'add', 'origin', `https://github.com/example-org/${alias}.git`]);
        repositories[alias] = { path, github: `example-org/${alias}`, operations: {
            inspect: { description: 'Inspect fixed synthetic target', target: alias + '-staging', effect: 'read', script, args: ['literal;$(no-shell)'] },
            backup: { description: 'Back up fixed synthetic target', target: alias + '-staging', effect: 'write', script }
        }};
    }
    const config = ConfigSchema.parse({ engine: 'async-cli', gmailAddress: 'agent@example.test', ownerAddress: 'owner@example.test', projectsRoot: projects, dataDir: data, repositories });
    const store = new AsyncStore(join(data, 'async-cli.sqlite'));
    const c = store.intake(mail('initial', 'Back up sample-staging now.'), 'synthetic', 'synthetic'); c.codexThread = 'primary'; store.save(c);
    store.put('scope', c.id, Object.entries(config.repositories).map(([, r]) => ({ path: r.path, identity: r.github, role: 'modify' })));
    const tools = new AsyncTools(config, store, c, signal()), adapter = new OperationsAdapter(config, store, c.id);
    const call = (name: string, args: any) => tools.call('primary', name, { project: 'sample', ...args });
    return { root, config, store, c, tools, adapter, call, script, trace, privateDirectory };
}

test('operation configuration is opt-in, rejects legacy, missing prerequisites and arbitrary fields', async () => {
    const f = await fixture();
    assert.throws(() => ConfigSchema.parse({ ...f.config, engine: 'legacy' }), /OPERATIONS_REQUIRE_ASYNC_CLI/);
    const d = { enabled: true, host: 'operator@server.example.test', domain: 'app.example.test', remoteBase: '/srv/app', preDeployOperations: ['missing'] };
    assert.throws(() => ConfigSchema.parse({ ...f.config, repositories: { sample: { ...f.config.repositories.sample, deployment: d } } }), /Unique configured/);
    assert.throws(() => ConfigSchema.parse({ ...f.config, repositories: { sample: { ...f.config.repositories.sample, operations: { inspect: { ...f.config.repositories.sample.operations!.inspect, command: 'ssh arbitrary' } } } } }), /Unrecognized/);
    const old = ConfigSchema.parse({ gmailAddress: 'agent@example.test', ownerAddress: 'owner@example.test' });
    assert.equal(old.engine, 'legacy'); f.store.close();
});

test('operations list and read calls require primary authorized repository identity, no worktree or extra mail', async () => {
    const f = await fixture();
    const listed: any = await f.call('project_operations', {});
    assert.equal(listed[0].target, 'sample-staging'); assert.ok(!JSON.stringify(listed).includes(f.script));
    const approvedScope = f.tools.scopes();
    f.store.put('scope', f.c.id, approvedScope.map(p => ({ ...p, role: 'reference' })));
    await assert.rejects(f.call('project_operations', {}), /WRITABLE_SCOPE_REQUIRED/);
    f.store.put('scope', f.c.id, approvedScope);
    await assert.rejects(f.tools.call('subagent', 'project_operations', { project: 'sample' }), /PRIMARY_AGENT_ONLY/);
    const result: any = await f.call('project_operation', { operation: 'inspect', key: 'inspect-1' });
    assert.equal(result.evidence.value, 'literal;$(no-shell)'); assert.equal(result.ok, true); assert.equal(f.store.mails().length, 0);
    await git(f.config.repositories.sample.path, ['remote', 'set-url', 'origin', 'https://github.com/example-org/replaced.git']);
    await assert.rejects(f.call('project_operations', {}), /REPOSITORY_IDENTITY_CHANGED/); f.store.close();
});

test('write operations bind new-body evidence to target/configuration and one key', async () => {
    const f = await fixture();
    await assert.rejects(f.call('project_operation', { operation: 'backup', key: 'backup-1' }), /OPERATION_MAIL_EVIDENCE_REQUIRED/);
    await assert.rejects(f.call('project_operation', { operation: 'backup', key: 'backup-1', sourceMailId: 'initial', evidence: 'Quoted permission' }), /OPERATION_MAIL_EVIDENCE_REQUIRED/);
    const args = { operation: 'backup', key: 'backup-1', sourceMailId: 'initial', evidence: 'Back up sample-staging now.' };
    const first = await f.call('project_operation', args), repeated = await f.call('project_operation', args);
    assert.deepEqual(repeated, first); assert.equal(await readFile(f.trace, 'utf8'), 'call\n');
    await assert.rejects(f.call('project_operation', { ...args, key: 'new-key' }), /AUTHORIZATION_ALREADY_BOUND/);
    await writeFile(f.script, (await readFile(f.script, 'utf8')) + '// changed\n');
    await assert.rejects(f.call('project_operation', args), /AUTHORIZATION_ALREADY_BOUND/); f.store.close();
});

test('forged, cross-conversation and historical/quoted evidence cannot authorize a write', async () => {
    const f = await fixture(); const other = f.store.intake(mail('other-mail', 'Back up sample-staging now.'), '', '');
    assert.notEqual(other.id, f.c.id);
    await assert.rejects(f.call('project_operation', { operation: 'backup', key: 'one', sourceMailId: 'other-mail', evidence: 'Back up sample-staging now.' }), /MAIL_EVIDENCE_REQUIRED/);
    const input = f.store.input('initial')!; input.incoming.trusted = false; f.store.saveInput(input);
    await assert.rejects(f.call('project_operation', { operation: 'backup', key: 'one', sourceMailId: 'initial', evidence: input.incoming.text }), /MAIL_EVIDENCE_REQUIRED/);
    input.incoming.trusted = true; input.incoming.text = 'What is the current status?'; input.fullText = 'Quoted: Back up sample-staging now.'; f.store.saveInput(input);
    await assert.rejects(f.call('project_operation', { operation: 'backup', key: 'one', sourceMailId: 'initial', evidence: 'Back up sample-staging now.' }), /MAIL_EVIDENCE_REQUIRED/); f.store.close();
});

test('existing threads use strict compatibility entry without shell execution or check receipts', async () => {
    const f = await fixture();
    assert.ok(ASYNC_TOOLS.some(t => t.name === 'project_operation')); assert.match(ASYNC_CONTRACT, /mail-to-code-operation/);
    const params = { operation: 'inspect', key: 'compat' };
    const result: any = await f.call('project_command', { executable: 'mail-to-code-operation', args: ['run', JSON.stringify(params)] });
    assert.ok(result.ok); assert.equal(result.checkId, undefined); assert.equal(f.store.all('check').length, 0);
    assert.equal((await f.call('project_command', { executable: 'mail-to-code-operation', args: ['list', '{}'] }) as any[]).length, 2);
    for (const invalid of [{ args: ['run', JSON.stringify({ ...params, args: ['ssh'] })] }, { network: true }, { cwd: '../' }, { args: ['run', JSON.stringify({ ...params, project: 'other' })] }]) {
        await assert.rejects(f.call('project_command', { executable: 'mail-to-code-operation', args: ['run', JSON.stringify(params)], ...invalid }));
    }
    f.store.close();
});

test('private operations are unavailable to source profiles and remain masked in native sandbox policy', async () => {
    const f = await fixture();
    const policy = asyncPolicy(f.config, f.c).join('\n');
    assert.match(policy, /network.enabled=false/); assert.ok(policy.includes(JSON.stringify(f.privateDirectory) + '="deny"'));
    await chmod(f.script, 0o755); await assert.rejects(f.adapter.list('sample'), /PRIVATE_SCRIPT_REQUIRED/);
    await chmod(f.script, 0o700); const link = join(f.privateDirectory, 'link'); await symlink(f.script, link);
    f.config.repositories.sample.operations!.inspect.script = link;
    await assert.rejects(f.adapter.list('sample'), /PRIVATE_SCRIPT_REQUIRED/);
    f.config.repositories.sample.operations!.inspect.script = join(f.config.repositories.sample.path, 'hook');
    await writeFile(f.config.repositories.sample.operations!.inspect.script, await readFile(f.script), { mode: 0o700 });
    await assert.rejects(f.adapter.list('sample'), /PRIVATE_SCRIPT_REQUIRED/); f.store.close();
});

test('invalid/non-JSON/oversized results and failing processes do not disclose stdout or stderr', async () => {
    for (const code of ["console.log('secret output');console.error('secret error');process.exit(1)", "console.log('secret output')", "console.log(JSON.stringify({ok:true,summary:'secret',evidence:{},extra:'secret'}))", "process.stdout.write(' '.repeat(70000));console.log(JSON.stringify({ok:true,summary:'valid tail',evidence:{}}))"]) {
        const f = await fixture(); await writeFile(f.script, `#!${process.execPath}\n${code}\n`);
        try { await f.call('project_operation', { operation: 'inspect', key: 'bad' }); assert.fail('Expected failure'); }
        catch (e) { assert.match(String(e), /OPERATION_/); assert.ok(!JSON.stringify(e).includes('secret')); }
        const op: any = f.store.all('operation')[0]; assert.equal(op.status, 'uncertain');
        await assert.rejects(f.call('project_operation', { operation: 'inspect', key: 'bad' }), /UNCERTAIN_RECONCILE/); f.store.close();
    }
});

test('uncertain writes survive restart and require reconciliation without repeating the script', async () => {
    const f = await fixture();
    const reconcile = join(f.privateDirectory, 'reconcile');
    await writeFile(reconcile, `#!${process.execPath}\nconsole.log(JSON.stringify({ok:true,summary:'Receipt independently verified',evidence:{id:process.env.MAIL_TO_CODE_OPERATION_ID}}));\n`, { mode: 0o700 });
    f.config.repositories.sample.operations!.backup.reconcileScript = reconcile;
    await writeFile(f.script, `#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(f.trace)},'once');process.exit(1);\n`);
    const args = { operation: 'backup', key: 'uncertain', sourceMailId: 'initial', evidence: 'Back up sample-staging now.' };
    await assert.rejects(f.call('project_operation', args), /EXECUTION_UNCERTAIN/);
    const op: any = f.store.all('operation')[0];
    f.store.close();
    const resumedStore = new AsyncStore(join(f.config.dataDir, 'async-cli.sqlite'));
    const resumed = new AsyncTools(f.config, resumedStore, resumedStore.conversation(f.c.id)!, signal());
    await assert.rejects(resumed.call('primary', 'project_operation', { project: 'sample', ...args }), /UNCERTAIN_RECONCILE/);
    assert.equal((await resumed.reconcile(op.id) as any).verified, true);
    assert.equal((await resumed.call('primary', 'project_operation', { project: 'sample', ...args }) as any).ok, true);
    assert.equal(await readFile(f.trace, 'utf8'), 'once'); resumedStore.close();
});

test('same-project operations serialize across conversations; unrelated projects have independent locks', async () => {
    const f = await fixture(); const events: string[] = [];
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const first = withProjectOperationLock(f.config, 'sample', async () => { events.push('first'); await gate; events.push('end'); });
    await new Promise(r => setTimeout(r, 30));
    const second = withProjectOperationLock(f.config, 'sample', async () => { events.push('second'); });
    await withProjectOperationLock(f.config, 'other', async () => { events.push('other'); });
    assert.deepEqual(events, ['first', 'other']); release(); await Promise.all([first, second]);
    assert.deepEqual(events, ['first', 'other', 'end', 'second']); f.store.close();
});

test('deployment fingerprints retain old shape but bind ordered prerequisites and script changes', async () => {
    const f = await fixture();
    f.config.repositories.sample.deployment = { enabled: true, host: 'operator@server.example.test', domain: 'app.example.test', remoteBase: '/srv/app', script: 'deploy.sh', adapter: 'script', args: [], healthPaths: ['/'] };
    assert.equal(await f.adapter.deployFingerprint('sample'), digest(f.config.repositories.sample.deployment));
    f.config.repositories.sample.deployment.preDeployOperations = ['inspect', 'backup'];
    const first = await f.adapter.deployFingerprint('sample');
    f.config.repositories.sample.deployment.preDeployOperations = ['backup', 'inspect'];
    assert.notEqual(await f.adapter.deployFingerprint('sample'), first);
    const second = await f.adapter.deployFingerprint('sample'); await writeFile(f.script, (await readFile(f.script, 'utf8')) + '// update\n');
    assert.notEqual(await f.adapter.deployFingerprint('sample'), second); f.store.close();
});

test('each deployment attempt executes fresh ordered prerequisites and failure stops the remaining steps', async () => {
    const f = await fixture();
    f.config.repositories.sample.deployment = { enabled: true, host: 'operator@server.example.test', domain: 'app.example.test', remoteBase: '/srv/app', script: 'deploy.sh', adapter: 'script', args: [], healthPaths: ['/'], preDeployOperations: ['inspect', 'backup'] };
    const fingerprint = await f.adapter.deployFingerprint('sample');
    await f.adapter.preDeploy('sample', 'request', signal(), fingerprint, 'attempt-1');
    await f.adapter.preDeploy('sample', 'request', signal(), fingerprint, 'attempt-2');
    assert.equal(await readFile(f.trace, 'utf8'), 'call\n'.repeat(4));
    await writeFile(f.script, `#!${process.execPath}\nconsole.log(JSON.stringify({ok:false,summary:'Failed integrity check',evidence:{}}));\n`);
    const changed = await f.adapter.deployFingerprint('sample');
    await assert.rejects(f.adapter.preDeploy('sample', 'request', signal(), fingerprint, 'attempt-3'), /APPROVED_OPERATION_TARGET_CHANGED/);
    await assert.rejects(f.adapter.preDeploy('sample', 'request', signal(), changed, 'attempt-3'), /PREDEPLOY_OPERATION_FAILED/);
    assert.equal(f.store.all('operation').length, 5); f.store.close();
});

test('trusted deploy adapter gates deployment after build/baseline verification and before production effect', async () => {
    const f = await fixture(), repo = f.config.repositories.sample;
    await writeFile(join(repo.path, 'deploy.sh'), '#!/bin/sh\nexit 0\n');
    await git(repo.path, ['add', '.']); await git(repo.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Synthetic baseline']);
    const sha = await git(repo.path, ['rev-parse', 'HEAD']);
    repo.deployment = { enabled: true, host: 'operator@server.example.test', domain: 'app.example.test', remoteBase: '/srv/app', script: 'deploy.sh', adapter: 'script', args: [], healthPaths: ['/'], preDeployOperations: ['backup'] };
    const session = { id: 'fixture', repo: 'sample', baseSha: sha, mergeSha: sha } as Session;
    const gitAdapter = { cleanDeploy: async () => repo.path } as unknown as GitAdapter;
    const events: string[] = [];
    const adapter = new DeployAdapter(f.config, gitAdapter, () => events.push('production'), async () => { events.push('build'); }, async () => { events.push('backup'); throw Error('backup failed'); });
    await assert.rejects(adapter.deploy(session, signal()), /backup failed/);
    assert.deepEqual(events, ['build', 'backup']); assert.equal(session.deployUncertain, undefined);
    await assert.rejects(new DeployAdapter(f.config, gitAdapter, undefined, async () => {}).deploy(session, signal()), /PREDEPLOY_ADAPTER_REQUIRED/); f.store.close();
});

test('uncertain project writes block new writes and deployments but allow inspection', async () => {
    const f = await fixture();
    await writeFile(f.script, `#!${process.execPath}\nprocess.exit(1);\n`);
    const input = { operation: 'backup', key: 'pending', sourceMailId: 'initial', evidence: 'Back up sample-staging now.' };
    await assert.rejects(f.call('project_operation', input), /EXECUTION_UNCERTAIN/);
    f.store.intake(mail('next', 'Back up sample-staging again.'), '', '');
    const next = f.store.input('next')!; next.conversationId = f.c.id; f.store.saveInput(next);
    await assert.rejects(f.call('project_operation', { operation: 'backup', key: 'next', sourceMailId: 'next', evidence: next.incoming.text }), /PROJECT_WRITE_UNCERTAIN/);
    assert.throws(() => f.adapter.assertNoUncertainWrites('sample'), /PROJECT_WRITE_UNCERTAIN/);
    assert.doesNotThrow(() => f.adapter.assertNoUncertainWrites('other'));
    const op: any = f.store.all('operation')[0];
    assert.equal((await f.tools.reconcile(op.id, true) as any).operatorReset, true);
    assert.doesNotThrow(() => f.adapter.assertNoUncertainWrites('sample'));
    assert.equal(f.store.all('operation-audit').length, 1); f.store.close();
});

test('timeouts preserve uncertain receipts and do not return process output', async () => {
    const f = await fixture();
    f.config.repositories.sample.operations!.inspect.timeoutSeconds = 1;
    await writeFile(f.script, `#!${process.execPath}\nconsole.error('private diagnostic');setInterval(()=>{},10000);\n`);
    await assert.rejects(f.call('project_operation', { operation: 'inspect', key: 'timeout' }), /EXECUTION_UNCERTAIN/);
    assert.equal((f.store.all('operation')[0] as any).status, 'uncertain'); f.store.close();
});

test('deployment rechecks the approved source after a configured prerequisite', async () => {
    const f = await fixture(), repo = f.config.repositories.sample;
    await writeFile(join(repo.path, 'deploy.sh'), '#!/bin/sh\nexit 0\n');
    await git(repo.path, ['add', '.']); await git(repo.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Synthetic baseline']);
    const sha = await git(repo.path, ['rev-parse', 'HEAD']);
    repo.deployment = { enabled: true, host: 'operator@server.example.test', domain: 'app.example.test', remoteBase: '/srv/app', script: 'deploy.sh', adapter: 'script', args: [], healthPaths: ['/'], preDeployOperations: ['backup'] };
    const session = { id: 'fixture', repo: 'sample', baseSha: sha, mergeSha: sha } as Session;
    const adapter = new DeployAdapter(f.config, { cleanDeploy: async () => repo.path } as unknown as GitAdapter, undefined, async () => {}, async () => { await writeFile(join(repo.path, 'changed.txt'), 'unapproved'); });
    await assert.rejects(adapter.deploy(session, signal()), /changed approved source/); assert.equal(session.deployUncertain, undefined); f.store.close();
});

test('exact deployment approval includes prerequisites, reuses duplicate result and rejects changed scripts', async () => {
    const f = await fixture(), repo = f.config.repositories.sample;
    repo.deployment = { enabled: true, host: 'operator@server.example.test', domain: 'app.example.test', remoteBase: '/srv/app', script: 'deploy.sh', adapter: 'script', args: [], healthPaths: ['/'], preDeployOperations: ['backup'] };
    f.config.profiles.sample = { kind: 'generic', runtime: ['node'], install: [], build: [], checks: [], preview: { kind: 'none', mounts: [], paths: ['/'] }, services: [], generatedFiles: [], pendingChecks: [], packageSources: ['registry.npmjs.org'] };
    f.tools.config.profiles.sample = f.config.profiles.sample;
    f.store.put('project', f.c.id + ':' + repo.path, { id: 'synthetic-release', repo: 'sample', worktree: repo.path, mergeSha: 'a'.repeat(40) });
    const requested: any = await f.tools.call('primary', 'queue_mail', { key: 'deploy-request', text: 'Deploy this exact commit with verified backup first.', request: { kind: 'deploy', project: 'sample' } });
    const outbound = f.store.mail(requested.mailId)!; outbound.identityStatus = 'verified'; outbound.rfcMessageId = '<deploy-request@example.test>'; f.store.saveMail(outbound);
    const reply = { ...mail('deploy-confirmed', 'Deploy that exact commit with backup first.'), inReplyTo: outbound.rfcMessageId };
    f.store.intake(reply, 'synthetic', reply.text);
    await f.tools.call('primary', 'record_authorization', { requestId: requested.requestId, sourceMailId: reply.id, evidence: reply.text });
    const original = DeployAdapter.prototype.deploy; let deployments = 0;
    DeployAdapter.prototype.deploy = async function(session, requestSignal) { await this.preDeploy!(requestSignal); deployments++; session.deployRelease = 'synthetic-release'; };
    try {
        const first = await f.tools.call('primary', 'project_deploy', { requestId: requested.requestId });
        assert.equal(deployments, 1); assert.equal(await readFile(f.trace, 'utf8'), 'call\n');
        assert.deepEqual(await f.tools.call('primary', 'project_deploy', { requestId: requested.requestId }), first);
        assert.equal(deployments, 1);
        await writeFile(f.script, (await readFile(f.script, 'utf8')) + '// changed after confirmation\n');
        await assert.rejects(f.tools.call('primary', 'project_deploy', { requestId: requested.requestId }), /APPROVED_OPERATION_TARGET_CHANGED/);
        assert.equal(deployments, 1);
    } finally { DeployAdapter.prototype.deploy = original; f.store.close(); }
});
