import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, stat, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConfigSchema } from '../src/config.js';
import { ProfileSchema } from '../src/profile.js';
import { AsyncStore } from '../src/async-store.js';
import { AsyncTools } from '../src/async-tools.js';
import { GitAdapter, git } from '../src/git.js';
import { Runner } from '../src/runner.js';
import { RuntimeAdapter } from '../src/runtime.js';
import { execute } from '../src/process.js';
import { checkPlan, copyTestTree, fileDigest, sourceFiles, ProjectCheckRuntime, CheckGateError, type CheckReceipt } from '../src/project-checks.js';

const image = 'example.test/node-browser@sha256:' + 'a'.repeat(64), databaseImage = 'example.test/mysql@sha256:' + 'b'.repeat(64);
const command = { executable: 'node', args: ['test.mjs'], cwd: '.', env: { TEST_VALUE: 'synthetic' } };
const service = { name: 'db', image: databaseImage, env: { MYSQL_ALLOW_EMPTY_PASSWORD: 'yes' }, args: [], health: ['ready'] };
async function fixture(executor: 'codex' | 'claude' = 'codex') {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'project-checks-'))), projects = join(root, 'projects'), tree = join(projects, 'sample');
    await mkdir(tree, { recursive: true });
    await git(tree, ['init', '-b', 'main']);
    await git(tree, ['remote', 'add', 'origin', 'https://github.com/example-org/sample.git']);
    await writeFile(join(tree, '.gitignore'), 'node_modules/\nignored-state.json\noutput/\n');
    await writeFile(join(tree, 'test.mjs'), 'console.log("synthetic test");\n');
    const config = ConfigSchema.parse({ engine: 'async-cli', gmailAddress: 'agent@example.test', ownerAddress: 'owner@example.test', projectsRoot: projects, dataDir: join(root, 'state'), repositories: { sample: { path: tree, github: 'example-org/sample' } }, profiles: { sample: { runtime: [], checks: [command] } } });
    await mkdir(config.dataDir);
    const store = new AsyncStore(join(config.dataDir, 'async-cli.sqlite'));
    const incoming = { id: 'input', threadId: 'mail', rfcId: '<input@example.test>', inReplyTo: '', subject: `[${executor}] Synthetic test`, text: 'Implement the synthetic project.', from: config.ownerAddress, trusted: true };
    const c = store.intake(incoming, 'synthetic MIME', incoming.text); c.executorSession = 'primary'; store.save(c);
    store.put('scope', c.id, [{ path: tree, role: 'modify', identity: 'example-org/sample' }]);
    store.put('project', c.id + ':' + tree, { id: c.id + '-sample', repo: 'sample', worktree: tree, baseSha: 'a'.repeat(40) });
    const tools = () => new AsyncTools(config, store, c, new AbortController().signal);
    return { root, tree, config, store, c, tools, async close() { store.close(); await rm(root, { recursive: true, force: true }); } };
}
const nativeRunner = (config: ReturnType<typeof ConfigSchema.parse>, calls: any[] = []) => ({ check: async (tree: string, executable: string, args: string[], cwd: string, signal: AbortSignal, network: boolean, options: any) => {
    calls.push({ tree, executable, args, cwd, network, options });
    // Unit harness executes only synthetic fixture code. Real sandbox/container
    // isolation is covered by the separate Linux acceptance script.
    return execute(executable === 'node' ? process.execPath : executable, args, { cwd, signal, env: { PATH: process.env.PATH, ...options.env }, timeoutMs: config.timeoutSeconds * 1000 });
} }) as Runner;

test('effective checks validate and fingerprint environment, images, services, packages and repository checks', async () => {
    const f = await fixture();
    try {
        f.config.repositories.sample.checks.push({ executable: 'node', args: ['--version'], cwd: '.' });
        let plan = checkPlan(f.config, 'sample'); assert.equal(plan.required.length, 2);
        const first = plan.fingerprint;
        f.config.profiles.sample.checks[0].env.TEST_VALUE = 'changed';
        assert.notEqual(checkPlan(f.config, 'sample').fingerprint, first);
        f.config.profiles.sample = ProfileSchema.parse({ image, services: [service], checks: [command], packageSources: ['packages.example.test'] });
        plan = checkPlan(f.config, 'sample');
        for (const mutate of [() => { f.config.profiles.sample.services[0].env.CHARSET = 'utf8mb4'; }, () => { f.config.profiles.sample.image = databaseImage; }, () => { f.config.profiles.sample.packageSources = ['another.example.test']; }]) {
            const before = checkPlan(f.config, 'sample').fingerprint; mutate(); assert.notEqual(checkPlan(f.config, 'sample').fingerprint, before);
        }
        f.config.repositories.sample.checks[0].cwd = '../outside'; assert.throws(() => checkPlan(f.config, 'sample'));
        f.config.repositories.sample.checks = [{ executable: 'podman', args: [], cwd: '.' }]; assert.throws(() => checkPlan(f.config, 'sample'), /Privileged/);
        f.config.repositories.sample.checks = []; f.config.profiles.sample.services.push(service); assert.throws(() => checkPlan(f.config, 'sample'), /DUPLICATE/);
    } finally { await f.close(); }
});

test('test snapshot excludes ignored state, Git, secrets and dependency secrets while retaining allowed dependencies', async () => {
    const f = await fixture();
    try {
        await mkdir(join(f.tree, 'node_modules', 'fixture'), { recursive: true });
        await mkdir(join(f.tree, '.run')); await mkdir(join(f.tree, '.config'));
        for (const path of ['.env', 'auth.json', '.run/state.json', '.config/private.json', 'ignored-state.json', 'node_modules/fixture/.env', 'node_modules/fixture/private.key']) await writeFile(join(f.tree, path), 'synthetic excluded');
        await writeFile(join(f.tree, '.env.example'), 'SYNTHETIC=yes'); await writeFile(join(f.tree, 'node_modules/fixture/index.js'), 'export default 1;');
        const snapshot = join(f.root, 'copy'); await copyTestTree(f.tree, snapshot, await sourceFiles(f.tree));
        assert.equal(await readFile(join(snapshot, 'node_modules/fixture/index.js'), 'utf8'), 'export default 1;');
        assert.equal(await readFile(join(snapshot, '.env.example'), 'utf8'), 'SYNTHETIC=yes');
        for (const path of ['.git', '.env', 'auth.json', '.run', '.config', 'ignored-state.json', 'node_modules/fixture/.env', 'node_modules/fixture/private.key']) await assert.rejects(stat(join(snapshot, path)), { code: 'ENOENT' });
    } finally { await f.close(); }
});

test('snapshot rejects outside, ignored and secret links; internal source and dependency links remain usable', async () => {
    const f = await fixture();
    try {
        await writeFile(join(f.root, 'foreign'), 'synthetic foreign task'); await writeFile(join(f.tree, '.env'), 'synthetic secret'); await writeFile(join(f.tree, 'ignored-state.json'), '{}');
        for (const target of ['../../foreign', '.env', 'ignored-state.json']) {
            await symlink(target, join(f.tree, 'unsafe'));
            await assert.rejects(copyTestTree(f.tree, join(f.root, 'copy'), await sourceFiles(f.tree)), /UNSAFE_LINK/);
            await rm(join(f.tree, 'unsafe')); await rm(join(f.root, 'copy'), { recursive: true, force: true });
        }
        await mkdir(join(f.tree, 'node_modules/.bin'), { recursive: true }); await mkdir(join(f.tree, 'node_modules/pkg'));
        await writeFile(join(f.tree, 'node_modules/pkg/cli.js'), 'synthetic');
        await symlink('../pkg/cli.js', join(f.tree, 'node_modules/.bin/cli')); await symlink(join(f.tree, 'test.mjs'), join(f.tree, 'safe'));
        const dest = join(f.root, 'copy'); await copyTestTree(f.tree, dest, await sourceFiles(f.tree));
        assert.equal(await readFile(join(dest, 'safe'), 'utf8'), await readFile(join(f.tree, 'test.mjs'), 'utf8'));
        assert.equal(await readFile(join(dest, 'node_modules/.bin/cli'), 'utf8'), 'synthetic');
    } finally { await f.close(); }
});

test('native pipeline installs and checks in a copy with configured env, private temporary storage and package sources', async () => {
    const f = await fixture(), calls: any[] = [];
    try {
        f.config.profiles.sample = ProfileSchema.parse({ runtime: [], packageSources: ['packages.example.test'], install: [{ executable: 'node', args: ['-e', 'require("node:fs").writeFileSync("installed",process.env.TEST_VALUE)'], env: { TEST_VALUE: 'synthetic' } }], checks: [{ executable: 'node', args: ['-e', 'if(require("node:fs").readFileSync("installed","utf8")!==process.env.TEST_VALUE)process.exit(1)'], env: { TEST_VALUE: 'synthetic' } }] });
        const before = await fileDigest(f.tree, await sourceFiles(f.tree));
        const result = await new ProjectCheckRuntime(f.config, execute, nativeRunner(f.config, calls)).run(f.tree, checkPlan(f.config, 'sample'), new AbortController().signal);
        assert.equal(result.commands.length, 1); assert.deepEqual(calls.map(c => c.network), [true, false]);
        assert.notEqual(calls[0].tree, f.tree); assert.deepEqual(calls[0].options.sources, ['packages.example.test']);
        assert.ok(calls[0].options.policy.join('').includes('network.enabled=false'));
        assert.ok(!calls[0].options.policy.join('').includes(':slash_tmp'));
        assert.ok(!calls[0].options.policy.join('').includes(JSON.stringify(f.tree) + '="write"'));
        await assert.rejects(stat(calls[0].tree), { code: 'ENOENT' }); await assert.rejects(stat(join(f.tree, 'installed')), { code: 'ENOENT' });
        assert.equal(await fileDigest(f.tree, await sourceFiles(f.tree)), before);
        const [run] = await readdir(join(f.config.dataDir, 'artifacts/checks')); assert.deepEqual((await readdir(join(f.config.dataDir, 'artifacts/checks', run))).sort(), ['1.json', '2.json']);
    } finally { await f.close(); }
});

test('mutating copied source is rejected and install hooks cannot introduce outside links', async () => {
    const f = await fixture();
    try {
        f.config.profiles.sample = ProfileSchema.parse({ runtime: [], checks: [{ executable: 'node', args: ['-e', 'require("node:fs").writeFileSync("test.mjs","changed")'] }] });
        const runtime = new ProjectCheckRuntime(f.config, execute, nativeRunner(f.config));
        await assert.rejects(runtime.run(f.tree, checkPlan(f.config, 'sample'), new AbortController().signal), /CHECK_SOURCE_CHANGED/);
        assert.match(await readFile(join(f.tree, 'test.mjs'), 'utf8'), /synthetic/);
        f.config.profiles.sample = ProfileSchema.parse({ runtime: [], install: [{ executable: 'node', args: ['-e', 'require("node:fs").symlinkSync("/etc/passwd","escape")'] }], checks: [command] });
        await assert.rejects(runtime.run(f.tree, checkPlan(f.config, 'sample'), new AbortController().signal), /UNSAFE_LINK/);
    } finally { await f.close(); }
});

test('services have an isolated network, health gating and unconditional cleanup on failure, timeout and cancellation', async () => {
    const f = await fixture();
    try {
        const profile = ProfileSchema.parse({ image, services: [service], checks: [command] });
        for (const failure of ['health', 'test', 'timeout', 'cancel', 'create', 'cleanup']) {
            const calls: string[][] = [], abort = new AbortController();
            const processCall: typeof execute = async (_cmd, args) => {
                calls.push(args);
                if (failure === 'create' && args[0] === 'pod' && args[1] === 'create') throw Error('PROCESS_TIMEOUT');
                if (failure === 'cleanup' && args[0] === 'pod' && args[1] === 'rm') throw Object.assign(Error('cleanup failed'), { stderr: 'synthetic cleanup failure' });
                if (args[0] === 'exec' && failure === 'health') throw Object.assign(Error('not ready'), { stderr: 'synthetic health failure' });
                return { stdout: '', stderr: '' };
            };
            const runtime = new RuntimeAdapter(f.config, new Runner(f.config), processCall, async () => {});
            let executed = false;
            await assert.rejects(runtime.withServices(profile, abort.signal, async () => { executed = true; if (failure === 'cancel') abort.abort(); throw Error(failure === 'timeout' ? 'PROCESS_TIMEOUT' : failure === 'cancel' ? 'CANCELLED' : 'test failed'); }), (error: any) => failure === 'health' ? error.stderr === 'synthetic health failure' : failure !== 'cleanup' || error.message === 'test failed' && error.stderr.includes('TEST_CLEANUP_FAILED'));
            assert.equal(executed, !['health', 'create'].includes(failure));
            assert.ok(calls[0].includes('--network=none')); assert.deepEqual(calls.at(-1)!.slice(0, 4), ['pod', 'rm', '--ignore', '-f']);
            assert.equal(calls.filter(c => c[0] === 'exec').length, failure === 'health' ? 60 : failure === 'create' ? 0 : 1);
        }
        const pods: string[] = [];
        const runtime = new RuntimeAdapter(f.config, new Runner(f.config), async (_cmd, args) => { if (args[0] === 'pod' && args[1] === 'create') pods.push(args[3]); return { stdout: '', stderr: '' }; });
        await Promise.all([runtime.withServices(profile, new AbortController().signal, async () => {}), runtime.withServices(profile, new AbortController().signal, async () => {})]);
        assert.equal(new Set(pods).size, 2);
        const cleanupFailure = new RuntimeAdapter(f.config, new Runner(f.config), async (_cmd, args) => { if (args[0] === 'pod' && args[1] === 'rm') throw Error('CLEANUP_FAILED'); return { stdout: '', stderr: '' }; });
        await assert.rejects(cleanupFailure.withServices(profile, new AbortController().signal, async () => 'passed'), /CLEANUP_FAILED/);
    } finally { await f.close(); }
});

test('container command mounts only the test copy, passes synthetic env and stops at failed checks', async () => {
    const f = await fixture(), calls: string[][] = [];
    try {
        f.config.profiles.sample = ProfileSchema.parse({ image, services: [service], checks: [command, { executable: 'node', args: ['never.mjs'] }] });
        const processCall: typeof execute = async (_cmd, args) => { calls.push(args); if (args.includes('--read-only')) throw Object.assign(Error('PROCESS_FAILED:podman:1'), { stdout: 'synthetic failure', stderr: 'assertion' }); return { stdout: '', stderr: '' }; };
        await assert.rejects(new ProjectCheckRuntime(f.config, processCall).run(f.tree, checkPlan(f.config, 'sample'), new AbortController().signal), /PROCESS_FAILED/);
        const [check] = calls.filter(c => c.includes('--read-only'));
        assert.ok(check.includes('TEST_VALUE=synthetic')); assert.ok(check.includes('--cap-drop=all')); assert.ok(check.includes('--pull=never'));
        assert.ok(!check.some(a => a.includes(f.tree))); assert.match(check[check.indexOf('-v') + 1], /artifacts\/checks\/run-.*\/workspace:\/workspace:rw,Z$/);
        assert.deepEqual(calls.at(-1)!.slice(0, 4), ['pod', 'rm', '--ignore', '-f']);
    } finally { await f.close(); }
});

test('readiness reports missing images and unavailable container/cgroup infrastructure without running tests', async () => {
    const f = await fixture();
    try {
        f.config.profiles.sample = ProfileSchema.parse({ image, services: [service], checks: [command] });
        const plan = checkPlan(f.config, 'sample');
        let calls = 0;
        const missingCgroup = new ProjectCheckRuntime(f.config, async () => { calls++; return { stdout: JSON.stringify({ host: {} }), stderr: '' }; });
        assert.deepEqual(await missingCgroup.readiness(plan), ['PODMAN_CGROUP_UNAVAILABLE']); assert.equal(calls, 1);
        const missingImage = new ProjectCheckRuntime(f.config, async (_cmd, args) => { if (args[0] === 'info') return { stdout: JSON.stringify({ host: { cgroupManager: 'systemd', cgroupVersion: 'v2' }, version: { Version: '4.9.0' } }), stderr: '' }; throw Error('IMAGE_MISSING'); });
        assert.deepEqual(await missingImage.readiness(plan), ['IMAGE_MISSING']);
    } finally { await f.close(); }
});

test('both executors and old-session entry share checks, guards, failed-attempt history and current-source receipts', async () => {
    const readiness = ProjectCheckRuntime.prototype.readiness, run = ProjectCheckRuntime.prototype.run;
    let failure = true;
    ProjectCheckRuntime.prototype.readiness = async () => [];
    ProjectCheckRuntime.prototype.run = async () => { if (failure) throw Object.assign(Error('synthetic test failure'), { checkCommand: command }); return { commands: [] }; };
    try {
        for (const executor of ['codex', 'claude'] as const) {
            const f = await fixture(executor);
            try {
                const tools = f.tools(); failure = true;
                await assert.rejects(tools.call('other', 'project_checks', { project: 'sample', action: 'inspect' }), /PRIMARY_AGENT_ONLY/);
                const native = await tools.call('primary', 'project_checks', { project: 'sample', action: 'inspect' });
                assert.deepEqual(await tools.call('primary', 'project_command', { project: 'sample', executable: 'mail-to-code-checks', args: ['inspect'] }), native);
                for (const extra of [{ network: true }, { cwd: 'subdir' }, { args: ['run', '{}'] }]) await assert.rejects(tools.call('primary', 'project_command', { project: 'sample', executable: 'mail-to-code-checks', args: ['run'], ...extra }), /INVALID_CHECKS/);
                const failed = await tools.call('primary', 'project_checks', { project: 'sample', action: 'run' }) as any;
                assert.equal(failed.ok, false); assert.deepEqual(failed.checkIds, []);
                const inspect = await tools.call('primary', 'project_checks', { project: 'sample', action: 'inspect' }) as any; assert.equal(inspect.missing[0].reason, 'failed');
                failure = false;
                const passed = await tools.call('primary', 'project_command', { project: 'sample', executable: 'mail-to-code-checks', args: ['run'] }) as any;
                assert.equal(passed.ok, true); assert.equal(passed.checkIds.length, 1);
                assert.equal((await tools.call('primary', 'project_checks', { project: 'sample', action: 'inspect' }) as any).missing.length, 0);
                assert.equal(f.store.all('check-attempt').length, 4); assert.equal(f.store.mails().length, 0); assert.equal(tools.scopes().length, 1);
                await writeFile(join(f.tree, 'test.mjs'), 'changed');
                await assert.rejects(tools.call('primary', 'project_pr', { project: 'sample', summary: 'Synthetic', checks: passed.checkIds }), (error: any) => error instanceof CheckGateError && error.missing[0].reason === 'source_changed');
            } finally { await f.close(); }
        }
    } finally { ProjectCheckRuntime.prototype.readiness = readiness; ProjectCheckRuntime.prototype.run = run; }
});

test('PR blocks absent, legacy, foreign, configuration-stale and plain diagnostic receipts before Git effects', async () => {
    const f = await fixture(), ready = ProjectCheckRuntime.prototype.readiness, run = ProjectCheckRuntime.prototype.run, commit = GitAdapter.prototype.commit, runner = Runner.prototype.check;
    ProjectCheckRuntime.prototype.readiness = async () => []; ProjectCheckRuntime.prototype.run = async () => ({ commands: [] });
    let commits = 0; GitAdapter.prototype.commit = async () => { commits++; throw Error('GIT_BOUNDARY'); };
    Runner.prototype.check = async () => ({ stdout: 'diagnostic only', stderr: '' });
    try {
        const publish = (checks: string[]) => f.tools().call('primary', 'project_pr', { project: 'sample', summary: 'Synthetic', checks });
        await assert.rejects(publish([]), /REQUIRED_CHECKS_NOT_PASSED/);
        const diagnostic = await f.tools().call('primary', 'project_command', { project: 'sample', executable: command.executable, args: command.args }) as any;
        await assert.rejects(publish([diagnostic.checkId]), /REQUIRED_CHECKS_NOT_PASSED/);
        let passed = await f.tools().call('primary', 'project_checks', { project: 'sample', action: 'run' }) as any;
        const id = passed.checkIds[0], receipt = f.store.get<CheckReceipt>('check', id)!;
        f.store.put('check', id, { ...receipt, fingerprint: undefined });
        await assert.rejects(publish([id]), (e: any) => e.missing[0].reason === 'configuration_changed' && e.missing[0].command.executable === 'node');
        f.store.put('check', 'foreign:check', { ...receipt, id: 'foreign:check' }); await assert.rejects(publish(['foreign:check']), /CURRENT_SOURCE/);
        f.store.put('check', id, receipt);
        f.config.profiles.sample.checks[0].env.TEST_VALUE = 'new synthetic config';
        await assert.rejects(publish([id]), (e: any) => e.missing[0].reason === 'configuration_changed');
        assert.equal((await f.tools().call('primary', 'project_checks', { project: 'sample', action: 'inspect' }) as any).missing[0].reason, 'configuration_changed');
        f.config.repositories.sample.checks.push({ executable: 'node', args: ['another.mjs'], cwd: '.' });
        passed = await f.tools().call('primary', 'project_checks', { project: 'sample', action: 'run' }) as any;
        await assert.rejects(publish([passed.checkIds[0]]), (e: any) => e.message === 'REQUIRED_CHECKS_NOT_PASSED' && e.missing[0].command.args[0] === 'another.mjs');
        assert.equal(commits, 0);
        await assert.rejects(publish(passed.checkIds), /GIT_BOUNDARY/); assert.equal(commits, 1);
        f.config.profiles.sample.image = image;
        const plain = await f.tools().call('primary', 'project_command', { project: 'sample', executable: 'node', args: ['another.mjs'] }) as any;
        await assert.rejects(publish([plain.checkId]), /REQUIRED_CHECKS_NOT_PASSED/); assert.equal(commits, 1);
    } finally { ProjectCheckRuntime.prototype.readiness = ready; ProjectCheckRuntime.prototype.run = run; GitAdapter.prototype.commit = commit; Runner.prototype.check = runner; await f.close(); }
});

test('readiness failure and concurrent source changes invalidate all required receipts without changing scope', async () => {
    const f = await fixture(), ready = ProjectCheckRuntime.prototype.readiness, run = ProjectCheckRuntime.prototype.run;
    try {
        ProjectCheckRuntime.prototype.readiness = async () => ['missing runtime'];
        let calls = 0; ProjectCheckRuntime.prototype.run = async () => { calls++; await writeFile(join(f.tree, 'test.mjs'), 'concurrent edit'); return { commands: [] }; };
        assert.equal((await f.tools().call('primary', 'project_checks', { project: 'sample', action: 'run' }) as any).ok, false); assert.equal(calls, 0);
        ProjectCheckRuntime.prototype.readiness = async () => [];
        const result = await f.tools().call('primary', 'project_checks', { project: 'sample', action: 'run' }) as any;
        assert.equal(result.error, 'CHECK_SOURCE_CHANGED'); assert.deepEqual(result.checkIds, []); assert.equal(calls, 1);
        assert.ok(f.store.all<CheckReceipt>('check').every(r => !r.ok)); assert.equal(f.tools().scopes().length, 1);
    } finally { ProjectCheckRuntime.prototype.readiness = ready; ProjectCheckRuntime.prototype.run = run; await f.close(); }
});

test('an unfinished rerun fences earlier success; failing and skipped commands have distinct diagnostics', async () => {
    const f = await fixture(), ready = ProjectCheckRuntime.prototype.readiness, run = ProjectCheckRuntime.prototype.run;
    try {
        f.config.repositories.sample.checks.push({ executable: 'node', args: ['later.mjs'], cwd: '.' });
        ProjectCheckRuntime.prototype.readiness = async () => [];
        ProjectCheckRuntime.prototype.run = async () => ({ commands: [] });
        const passed = await f.tools().call('primary', 'project_checks', { project: 'sample', action: 'run' }) as any;
        let release!: () => void;
        const wait = new Promise<void>(resolve => { release = resolve; });
        ProjectCheckRuntime.prototype.run = async () => { await wait; throw Object.assign(Error('synthetic failing check'), { checkCommand: command }); };
        const rerun = f.tools().call('primary', 'project_checks', { project: 'sample', action: 'run' });
        // Wait for the durable pending slots rather than a timing assumption.
        for (let attempt = 0; attempt < 100 && !f.store.all<CheckReceipt>('check').every(r => r.error === 'CHECK_RUNNING'); attempt++) await new Promise(r => setTimeout(r, 5));
        await assert.rejects(f.tools().call('primary', 'project_pr', { project: 'sample', summary: 'Synthetic', checks: passed.checkIds }), /CURRENT_SOURCE_CHECK/);
        release(); await rerun;
        const inspected = await f.tools().call('primary', 'project_checks', { project: 'sample', action: 'inspect' }) as any;
        assert.deepEqual(inspected.missing.map((m: any) => m.reason), ['failed', 'not_executed']);
    } finally { ProjectCheckRuntime.prototype.readiness = ready; ProjectCheckRuntime.prototype.run = run; await f.close(); }
});
