import { readdir, readFile, realpath, lstat, readlink, symlink, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { ProjectProfile } from './profile.js';
import { Runner } from './runner.js';
import { execute } from './process.js';
import {git}from'./git.js';
export async function markdownChecks(tree: string) {
    const files: string[] = [];
    async function walk(path: string) { for (const e of await readdir(path, { withFileTypes: true })) {
        if (e.name.startsWith('.') || ['node_modules', 'dist', 'vendor'].includes(e.name))
            continue;
        const p = join(path, e.name);
        if (e.isSymbolicLink())
            throw new Error('Symlink in documentation source');
        if (e.isDirectory())
            await walk(p);
        else if (e.name.endsWith('.md'))
            files.push(p);
    } }
    await walk(tree);
    let count = 0;
    for (const f of files) {
        const text = await readFile(f, 'utf8');
        for (const m of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
            const url = m[1];
            if (/^(https?:|mailto:|#)/.test(url))
                continue;
            const target = resolve(f, '..', decodeURIComponent(url.split('#')[0]));
            if (!target.startsWith(resolve(tree) + '/'))
                throw new Error(`Documentation link escapes worktree: ${url}`);
            await lstat(target).catch(() => { throw new Error(`Broken Markdown link ${url} in ${f.slice(tree.length + 1)}`); });
            count++;
        }
    }
    return [`Markdown: ${files.length} files, ${count} local links passed`];
}
export class RuntimeAdapter {
    lastLogDirectory?: string;
    constructor(readonly config: Config, readonly runner: Runner, readonly process = execute, readonly pause = (ms: number) => new Promise(r => setTimeout(r, ms))) { }
    async cleanOrphans() { let pods: string; try {
        pods = (await execute('podman', ['pod', 'ps', '--filter', 'label=mail-to-code.owner=controller', '--format', '{{.Name}}'], { timeoutMs: 30000 })).stdout;
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return;
        throw e;
    } for (const name of pods.split('\n').filter(Boolean)) {
        if (!/^mail-to-code-[a-f0-9-]+$/.test(name))
            throw new Error('Unexpected owned Pod name');
        await execute('podman', ['pod', 'rm', '-f', name], { timeoutMs: 30000 });
    } }
    async verify(profile: ProjectProfile) {
        if (profile.image) {
            await this.process('podman', ['image', 'exists', profile.image], { timeoutMs: 30000 });
        }
        else
            for (const name of profile.runtime) {
                if (!/^[a-zA-Z0-9._-]+$/.test(name))
                    throw new Error('Invalid runtime executable');
                await this.process(name, ['--version'], { timeoutMs: 30000 });
            }
        for (const s of profile.services)
            await this.process('podman', ['image', 'exists', s.image], { timeoutMs: 30000 });
    }
    // Only the controller starts services. Callers choose what workspace, if any,
    // a test process receives; services themselves have no host bind mounts.
    async withServices<T>(profile: ProjectProfile, signal: AbortSignal, run: (pod?: string) => Promise<T>, forcePod = false): Promise<T> {
        if (!profile.services.length && !forcePod) return run();
        const pod = `mail-to-code-${randomUUID()}`;
        try {
            signal.throwIfAborted();
            await this.process('podman', ['pod', 'create', '--name', pod, '--network=none', '--userns=keep-id', '--label=mail-to-code.owner=controller'], { signal, timeoutMs: 30000 });
            for (const service of profile.services) {
                const name = `${pod}-${service.name}`;
                await this.process('podman', ['run', '--pull=never', '--rm', '-d', '--pod', pod, '--name', name, '--security-opt=no-new-privileges', ...Object.entries(service.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), service.image, ...service.args], { signal, timeoutMs: 30000 });
                let healthy = false;
                for (let n = 0; n < 60; n++) {
                    signal.throwIfAborted();
                    try {
                        await this.process('podman', ['exec', name, ...service.health], { signal, timeoutMs: 3000 });
                        healthy = true;
                        break;
                    } catch {
                        signal.throwIfAborted();
                        if (n < 59) await this.pause(1000);
                    }
                }
                if (!healthy) throw Error(`TEST_SERVICE_UNHEALTHY:${service.name}`);
            }
            return await run(pod);
        } finally {
            // Also covers interrupted/uncertain creation. Never reuse a test Pod.
            await this.process('podman', ['pod', 'rm', '--ignore', '-f', pod], { timeoutMs: 30000 });
        }
    }
    async run(tree: string, profile: ProjectProfile, signal: AbortSignal, deployment=false) {
        tree = await realpath(tree);
        await this.verify(profile);
        const checks: string[] = [];
        if (profile.kind === 'docs')
            return markdownChecks(tree);
        const logDir = join(this.config.dataDir, 'runs', 'checks', basename(tree), randomUUID());
        await mkdir(logDir, { recursive: true, mode: 0o700 });
        this.lastLogDirectory = logDir;
        let sequence = 0;
        const log = async (command: unknown, output: unknown) => writeFile(join(logDir, `${++sequence}.json`), JSON.stringify({ command, output }, null, 2), { mode: 0o600 });
        if (!profile.build.length && !profile.checks.length && profile.kind === 'generic')
            throw new Error('Configure at least one independent build/test check before Review');
        for (const c of profile.install) {
            const cwd = await realpath(resolve(tree, c.cwd));
            if (cwd !== tree && !cwd.startsWith(tree + '/'))
                throw new Error('Step escapes worktree');
            if(c.executable.split('/').at(-1)==='npm'&&['ci','install'].includes(c.args[0])){
                const dep=join(cwd,'node_modules'),rel=dep.slice(tree.length+1);
                if((await git(tree,['ls-files','-s',rel])).startsWith('120000 ')){
                    const link=await git(tree,['show',`HEAD:${rel}`]),target=resolve(cwd,link);
                    if(!target.startsWith(tree+'/'))throw Error('Tracked dependency link escapes worktree');
                    let matches=false;try{matches=(await lstat(dep)).isSymbolicLink()&&await readlink(dep)===link;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
                    if(!matches){await rm(dep,{recursive:true,force:true});await symlink(link,dep);}
                    continue;
                }
            }
            const output = await this.runner.check(tree, c.executable, c.args, cwd, signal, true, { env: c.env, sources: profile.packageSources });
            await log(c, output);
        }
        return this.withServices(profile, signal, async pod => {
            for (const c of [...profile.build, ...profile.checks]) {
                const cwd = await realpath(resolve(tree, c.cwd));
                if (cwd !== tree && !cwd.startsWith(tree + '/'))
                    throw new Error('Step escapes worktree');
                if (profile.image) {
                    const args = ['run', '--pull=never', '--rm', '--read-only', '--cap-drop=all', '--security-opt=no-new-privileges', ...(pod ? ['--user', `${process.getuid!()}:${process.getgid!()}`] : ['--userns=keep-id']), '--tmpfs', '/tmp:rw,size=512m', ...(pod ? ['--pod', pod] : ['--network=none']), '-v', `${tree}:/workspace:rw,Z`, '-w', `/workspace/${c.cwd}`, ...Object.entries(c.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), profile.image, c.executable, ...c.args];
                    const output = await execute('podman', args, { signal, timeoutMs: this.config.timeoutSeconds * 1000 });
                    await log(c, output);
                }
                else {
                    const output = await this.runner.check(tree, c.executable, c.args, cwd, signal, false, { env: c.env });
                    await log(c, output);
                }
                checks.push(`${c.cwd}: ${c.executable} ${c.args.join(' ')} passed`);
            }
            if(deployment){
                const changed=(await git(tree,['diff','--name-only'])).split('\n').filter(Boolean);
                if(await git(tree,['ls-files','--others','--exclude-standard'])||changed.some(path=>!profile.generatedFiles.includes(path)))throw Error('Deployment build changed unapproved source');
                if(changed.length)await git(tree,['restore','--source=HEAD','--',...changed]);
            }
            return checks;
        });
    }
}
