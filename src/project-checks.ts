import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Config } from './config.js';
import { configDir } from './config.js';
import { CommandSchema, ProfileSchema, validateProfile, type ProjectProfile } from './profile.js';
import { Runner, codexPolicy } from './runner.js';
import { RuntimeAdapter, markdownChecks } from './runtime.js';
import { execute } from './process.js';

export type CheckCommand = ReturnType<typeof CommandSchema.parse>;
export interface CheckPlan { profile: ProjectProfile; required: CheckCommand[]; fingerprint: string }
export interface CheckReceipt {
    id: string; project: string; ok: boolean; digest?: string; fingerprint?: string;
    executable: string; args: string[]; cwd: string; env?: Record<string, string>;
    controlled?: boolean; network?: boolean; error?: string; createdAt?: string;
}
export class CheckGateError extends Error {
    constructor(code: string, readonly missing: { command?: { executable: string; args: string[]; cwd: string }; reason: string }[]) { super(code); }
}
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    return value;
}
export const checkHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const commandKey = (command: CheckCommand) => checkHash(command);
export function checkPlan(config: Config, project: string): CheckPlan {
    const configured = config.profiles[project] || ProfileSchema.parse({ runtime: [] });
    const repositoryChecks = config.repositories[project].checks.map(c => CommandSchema.parse(c));
    // Validate repository checks as well as profile steps, even for private config.
    const profile = validateProfile({ ...configured, checks: [...configured.checks, ...repositoryChecks] });
    if (new Set(profile.services.map(s => s.name)).size !== profile.services.length) throw Error('DUPLICATE_TEST_SERVICE');
    const required = [...new Map([...profile.build, ...profile.checks].map(c => [commandKey(c), c])).values()];
    return { profile, required, fingerprint: checkHash({ version: 2, kind: profile.kind, runtime: profile.runtime, install: profile.install, required, image: profile.image, services: profile.services, packageSources: profile.packageSources }) };
}
export function receiptProblem(receipt: CheckReceipt | undefined, project: string, digest: string, fingerprint: string): string | undefined {
    if (!receipt || receipt.project !== project) return 'not_executed';
    if (!receipt.ok) return receipt.error === 'CHECK_SOURCE_CHANGED' ? 'source_changed' : ['CHECK_RUNNING', 'CHECK_NOT_EXECUTED'].includes(receipt.error || '') ? 'not_executed' : 'failed';
    if (receipt.digest !== digest) return 'source_changed';
    if (receipt.fingerprint !== fingerprint) return 'configuration_changed';
}
export function receiptMatches(receipt: CheckReceipt, command: CheckCommand, plan: CheckPlan) {
    return receipt.executable === command.executable && JSON.stringify(receipt.args) === JSON.stringify(command.args) && receipt.cwd === command.cwd &&
        checkHash(receipt.env || {}) === checkHash(command.env) && (receipt.controlled || !receipt.network && !plan.profile.image && !plan.profile.services.length && !Object.keys(command.env).length);
}
export async function sourceFiles(tree: string) {
    const result = await execute('git', ['-c', 'core.hooksPath=/dev/null', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: tree, timeoutMs: 120000 });
    return [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
}
export async function fileDigest(tree: string, files: string[], normalizeLinks = false) {
    tree = await realpath(tree);
    const digest = createHash('sha256');
    for (const file of files) {
        digest.update(file + '\0');
        try {
            const path = join(tree, file), info = await lstat(path);
            digest.update(String(info.mode & 0o777) + '\0');
            const link = info.isSymbolicLink() ? await readlink(path) : undefined;
            digest.update(link !== undefined ? normalizeLinks ? relative(dirname(path), await realpath(path)) : link : info.isFile() ? await readFile(path) : 'submodule');
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            digest.update('deleted');
        }
        digest.update('\0');
    }
    return digest.digest('hex');
}

// Match conventional native-secret restrictions, plus runtime state that must
// never be copied to tests. Ignored files are omitted except dependency trees.
export function testPathAllowed(path: string) {
    return !path.split(/[\\/]/).some(name => ['.git', '.codex', '.agents', '.claude', '.claude.json', '.ssh', '.aws', '.gnupg', '.config', '.local', '.docker', '.kube', '.npmrc', '.pypirc', '.netrc', '.gitconfig', 'auth.json', '.run', '.release'].includes(name) || /\.(pem|key)$/.test(name) || /^\.env($|\.)/.test(name) && !['.env.example', '.env.sample'].includes(name));
}
export async function copyTestTree(tree: string, destination: string, files: string[]) {
    tree = await realpath(tree);
    const selected = new Set(files.filter(testPathAllowed));
    const parents = new Set(['']);
    for (const file of selected) for (let parent = dirname(file); parent !== '.'; parent = dirname(parent)) parents.add(parent);
    const included = (path: string) => selected.has(path) || parents.has(path);
    // Dependency contents may be arbitrarily deep; only dependency roots need a
    // source parent. No ignored build outputs, logs or other runtime files enter.
    const dependency = (path: string) => {
        const segments = path.split('/'), index = segments.indexOf('node_modules');
        return index >= 0 && parents.has(segments.slice(0, index).join('/'));
    };
    async function copy(path: string) {
        if (path && (!testPathAllowed(path) || !included(path) && !dependency(path))) return;
        const from = join(tree, path), to = join(destination, path), info = await lstat(from);
        if (info.isSymbolicLink()) {
            let actual: string;
            try { actual = await realpath(from); } catch { throw Error(`TEST_COPY_UNSAFE_LINK:${path}`); }
            const rel = relative(tree, actual).split('\\').join('/');
            if (!actual.startsWith(tree + '/') || !testPathAllowed(rel) || !included(rel) && !dependency(rel)) throw Error(`TEST_COPY_UNSAFE_LINK:${path}`);
            await symlink(relative(dirname(from), actual), to);
        } else if (info.isDirectory()) {
            if (selected.has(path)) throw Error(`TEST_COPY_UNSUPPORTED_FILE:${path}`);
            await mkdir(to, { recursive: true, mode: 0o700 });
            for (const child of await readdir(from)) await copy(path ? path + '/' + child : child);
        } else if (info.isFile()) {
            await copyFile(from, to);
            await chmod(to, info.mode & 0o777);
        } else throw Error(`TEST_COPY_UNSUPPORTED_FILE:${path}`);
    }
    await copy('');
}

export interface CheckRunResult { commands: { command: Pick<CheckCommand, 'executable' | 'args' | 'cwd'>; stdout: string; stderr: string }[]; documentation?: string[] }
export class ProjectCheckRuntime {
    constructor(readonly config: Config, readonly process = execute, readonly runner = new Runner(config)) { }
    async readiness(plan: CheckPlan) {
        const issues: string[] = [];
        try {
            if (plan.profile.image) {
                const info = await this.process('podman', ['info', '--format=json'], { timeoutMs: 30000 });
                const parsed = JSON.parse(info.stdout), host = parsed.host;
                if (!host?.cgroupVersion || !host?.cgroupManager) throw Error('PODMAN_CGROUP_UNAVAILABLE');
                const [major, minor] = String(parsed.version?.Version || '').split('.').map(Number);
                if (!(major > 4 || major === 4 && minor >= 3)) throw Error('PODMAN_4_3_REQUIRED');
            }
            await new RuntimeAdapter(this.config, this.runner, this.process).verify(plan.profile);
        } catch (e) { issues.push(e instanceof Error ? e.message : 'TEST_RUNTIME_UNAVAILABLE'); }
        if (!plan.required.length && plan.profile.kind !== 'docs') issues.push('REQUIRED_CHECKS_NOT_CONFIGURED');
        return issues;
    }
    async run(tree: string, plan: CheckPlan, signal: AbortSignal): Promise<CheckRunResult> {
        const parent = join(this.config.dataDir, 'artifacts', 'checks');
        await mkdir(parent, { recursive: true, mode: 0o700 });
        const directory = await realpath(await mkdtemp(join(parent, 'run-'))), workspace = join(directory, 'workspace'), temporary = join(directory, 'tmp');
        const outputs: CheckRunResult = { commands: [] };
        const profile = plan.profile;
        let step = 0;
        try {
            signal.throwIfAborted();
            const files = await sourceFiles(tree), copiedFiles = files.filter(testPathAllowed), expected = await fileDigest(tree, copiedFiles, true);
            await copyTestTree(tree, workspace, files);
            await mkdir(temporary, { mode: 0o700 });
            const before = await fileDigest(workspace, copiedFiles, true);
            if (before !== expected) throw Error('CHECK_SOURCE_CHANGED');
            const policy = codexPolicy({ ...this.config, repositories: {}, productDocs: '' }, workspace, 'develop', [], false, [], { [configDir()]: 'deny' }, temporary);
            const native = (command: CheckCommand, network: boolean) => this.runner.check(workspace, command.executable, command.args, resolve(workspace, command.cwd), signal, network,
                { policy, sources: profile.packageSources, cacheDirectory: join(temporary, 'npm-cache'), env: { ...command.env, TMPDIR: temporary, HOME: temporary } });
            const log = async (command: CheckCommand, action: () => Promise<{ stdout: string; stderr: string }>) => {
                const logFile = join(directory, `${++step}.json`);
                try {
                    const output = await action();
                    await writeFile(logFile, JSON.stringify({ command, ok: true, ...output }), { mode: 0o600 });
                    return output;
                } catch (e) {
                    await writeFile(logFile, JSON.stringify({ command, ok: false, error: e instanceof Error ? e.message : 'CHECK_FAILED', stdout: (e as any).stdout || '', stderr: (e as any).stderr || '' }), { mode: 0o600 });
                    throw Object.assign(e instanceof Error ? e : Error('CHECK_FAILED'), { checkCommand: command });
                }
            };
            for (const command of profile.install) {
                await this.checkCwd(workspace, command.cwd);
                await log(command, () => native(command, true));
            }
            // Install hooks cannot create links to operator data and have them
            // followed later by a container mount or a native check.
            await this.auditLinks(workspace);
            const runtime = new RuntimeAdapter(this.config, this.runner, this.process);
            await runtime.withServices(profile, signal, async pod => {
                if (profile.kind === 'docs') outputs.documentation = await markdownChecks(workspace);
                for (const command of plan.required) {
                    signal.throwIfAborted();
                    await this.checkCwd(workspace, command.cwd);
                    const output = await log(command, () => profile.image
                        ? this.process('podman', ['run', '--pull=never', '--rm', '--name', `${pod}-check-${step}`, '--pod', pod!, '--read-only', '--cap-drop=all', '--security-opt=no-new-privileges', '--user', `${process.getuid!()}:${process.getgid!()}`, '--tmpfs', '/tmp:rw,size=512m', '-e', 'HOME=/tmp', '-e', 'TMPDIR=/tmp', '-v', `${workspace}:/workspace:rw,Z`, '-w', `/workspace/${command.cwd}`, ...Object.entries(command.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), profile.image!, command.executable, ...command.args], { signal, timeoutMs: this.config.timeoutSeconds * 1000 })
                        : native(command, false));
                    outputs.commands.push({ command: { executable: command.executable, args: command.args, cwd: command.cwd }, ...output });
                }
            }, !!profile.image);
            if (await fileDigest(workspace, copiedFiles, true) !== before || await fileDigest(tree, copiedFiles, true) !== before) throw Error('CHECK_SOURCE_CHANGED');
            return outputs;
        } finally {
            // Retain private diagnostics, never the copied source/dependencies.
            await rm(workspace, { recursive: true, force: true });
            await rm(temporary, { recursive: true, force: true });
        }
    }
    private async checkCwd(workspace: string, cwd: string) {
        const actual = await realpath(resolve(workspace, cwd));
        if (actual !== workspace && !actual.startsWith(workspace + '/')) throw Error('COMMAND_OUTSIDE_WORKTREE');
    }
    private async auditLinks(workspace: string, path = ''): Promise<void> {
        for (const entry of await readdir(join(workspace, path), { withFileTypes: true })) {
            const rel = path ? path + '/' + entry.name : entry.name;
            if (!testPathAllowed(rel)) throw Error(`TEST_COPY_PROTECTED_FILE:${rel}`);
            if (entry.isSymbolicLink()) {
                const actual = await realpath(join(workspace, rel));
                if (!actual.startsWith(workspace + '/') || !testPathAllowed(relative(workspace, actual))) throw Error(`TEST_COPY_UNSAFE_LINK:${rel}`);
            } else if (entry.isDirectory()) await this.auditLinks(workspace, rel);
        }
    }
}
