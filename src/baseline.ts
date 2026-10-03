import { join, resolve, relative } from 'node:path';
import { mkdir, mkdtemp, readFile, realpath, stat, rm, rename, writeFile } from 'node:fs/promises';
import type { Config } from './config.js';
import { git } from './git.js';
import { execute } from './process.js';

export type SynchronizeBranch = (path:string,branch:string,signal?:AbortSignal)=>Promise<unknown>;
export interface BaselineOptions { synchronize?: SynchronizeBranch; sync?: boolean; sha?: string; signal?: AbortSignal; }
export async function sourcePath(root: string, path: string): Promise<string> {
    const actualRoot = await realpath(root), actual = await realpath(resolve(root, path));
    if (actual !== actualRoot && !actual.startsWith(actualRoot + '/')) throw new Error('配置读取拒绝越界链接');
    return actual;
}
export async function sourceFile(root: string, path: string): Promise<string> {
    const actual = await sourcePath(root, path);
    if (!(await stat(actual)).isFile()) throw new Error('配置必须引用普通文件');
    return readFile(actual, 'utf8');
}
export async function hasSourceFile(root: string, path: string): Promise<boolean> {
    try { await sourceFile(root, path); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
// Only the controller fetches. All subsequent reads use a literal commit SHA.
export async function snapshot(config: Config, path: string, identity: string, branch: string, options: BaselineOptions = {}) {
    if(options.sha&&!/^[a-f0-9]{40,64}$/.test(options.sha))throw new Error('基线必须是固定提交 SHA');
    await git(path, ['check-ref-format', `refs/heads/${branch}`], options);
    if (options.sync) {
        try { if(options.synchronize)await options.synchronize(path,branch,options.signal);else await git(path, ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], options); }
        catch { options.signal?.throwIfAborted(); throw new Error(`默认分支同步失败：${branch}；未回退旧基线`); }
    }
    const sha = await git(path, ['rev-parse', '--verify', `${options.sha || `refs/remotes/origin/${branch}`}^{commit}`], options);
    const directory = join(config.dataDir, 'baselines', identity, sha);
    for(const stamp of ['.mail-to-code-baseline','.mail-agent-baseline'])try{if(await readFile(join(directory,stamp),'utf8')===sha)return{sha,directory};}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    const parent = join(config.dataDir, 'baselines', identity);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(parent, '.pending-')), archive = staging + '.tar';
    try {
        const tree = await git(path, ['ls-tree', '-r', '-z', sha], options);
        for (const row of tree.split('\0').filter(Boolean)) {
            const tab = row.indexOf('\t'), name = row.slice(tab + 1);
            if (!row.startsWith('120000 ')) continue;
            const link = await execute('git', ['-c', 'core.hooksPath=/dev/null', 'show', `${sha}:${name}`], {cwd:path,signal:options.signal,timeoutMs:30000});
            const destination = resolve(staging, name, '..', link.stdout);
            if (relative(staging, destination).startsWith('..') || !destination.startsWith(staging + '/') && destination !== staging)
                throw new Error('默认分支快照拒绝越界链接');
        }
        await git(path, ['archive', '--format=tar', `--output=${archive}`, sha], options);
        await execute('tar', ['-xf', archive, '-C', staging], { signal: options.signal });
        await writeFile(join(staging, '.mail-to-code-baseline'), sha, { mode: 0o600 });
        try { await rename(staging, directory); }
        catch (e) {
            if (!['EEXIST','ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code || '')) throw e;
            if(await readFile(join(directory,'.mail-to-code-baseline'),'utf8')!==sha)throw new Error('默认分支快照不完整');
        }
        return { sha, directory };
    } finally { await rm(staging, { recursive: true, force: true }); await rm(archive, { force: true }); }
}
