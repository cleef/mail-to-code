import { mkdir, cp, readdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Config } from './config.js';
import type { Session, RepoExecution, Attachment } from './types.js';
import type { RunResult } from './runner.js';
import { execute } from './process.js';
export class EvidenceAdapter {
    constructor(readonly config: Config) { }
    async capture(task: Session, repo: RepoExecution, result: RunResult, signal: AbortSignal) {
        const dir = join(this.config.dataDir, 'artifacts', task.id, `r${task.revision}`, repo.projectId), site = join(dir, 'site'), out = join(dir, 'images');
        await mkdir(out, { recursive: true, mode: 0o700 });
        if (repo.profile.preview.kind === 'none') {
            await writeFile(join(dir, 'checks.json'), JSON.stringify({ checks: repo.checks, pendingChecks: repo.pendingChecks }, null, 2), { mode: 0o600 });
            return { attachments: [] as Attachment[], checks: [], directory: dir };
        }
        if (!this.config.previewEnabled)
            throw new Error('UI screenshots disabled; Review blocked');
        const mounts = repo.profile.preview.mounts;
        if (!mounts.length)
            throw new Error('UI preview requires explicit artifact mounts');
        for (const m of mounts) {
            const source = await realpath(resolve(repo.worktree!, m.source)), dest = resolve(site, m.destination);
            if (!source.startsWith(resolve(repo.worktree!) + '/') || (dest !== site && !dest.startsWith(site + '/')))
                throw new Error('Artifact mount escapes worktree');
            await mkdir(dest, { recursive: true, mode: 0o700 });
            await cp(source, dest, { recursive: true });
        }
        const noLinks = async (path: string) => { for (const e of await readdir(path, { withFileTypes: true })) {
            const p = join(path, e.name);
            if (e.isSymbolicLink())
                throw new Error('Symlink in preview artifact');
            if (e.isDirectory())
                await noLinks(p);
            else if (e.name.endsWith('.html')) {
                const text = await readFile(p, 'utf8');
                await writeFile(p, text.replace(/<!-- baidu-analytics -->\s*<script>[\s\S]*?<\/script>/g, ''));
            }
        } };
        await noLinks(site);
        let fixtures: unknown;
        const f = repo.profile.preview.fixtures;
        if (f) {
            const path = await realpath(resolve(repo.worktree!, f));
            if (!path.startsWith(resolve(repo.worktree!) + '/'))
                throw new Error('Fixture escapes worktree');
            if ((await lstat(path)).size > 1024 * 1024)
                throw new Error('Fixture too large');
            fixtures = JSON.parse(await readFile(path, 'utf8'));
        }
        const targets = result.screenshotTargets.length ? result.screenshotTargets : repo.profile.preview.paths.map(path => ({ path, steps: [] }));
        const manifest = join(dir, 'input.json');
        await writeFile(manifest, JSON.stringify({ targets, checkPaths: repo.profile.preview.paths.map(p => p.split('#')[0] || '/'), fixtures }), { mode: 0o600 });
        await execute('podman', ['run', '--rm', '--network=none', '--read-only', '--cap-drop=all', '--security-opt=no-new-privileges', '--userns=keep-id', '--tmpfs', '/tmp:rw,size=512m', '--shm-size=512m', '-v', `${site}:/site:ro,Z`, '-v', `${manifest}:/input.json:ro,Z`, '-v', `${out}:/output:rw,Z`, this.config.screenshotImage], { signal, timeoutMs: 180000 });
        const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
        if (!report.images?.length)
            throw new Error('No UI screenshots produced');
        const attachments = report.images.map((filename: string, i: number) => { if (!/^[a-z0-9-]+\.png$/.test(filename))
            throw new Error('Invalid image name'); return { path: join(out, filename), filename: `${repo.projectId}-${filename}`, cid: `${task.id}-${task.revision}-${repo.projectId}-${i}@mail-to-code.local` }; });
        return { attachments, checks: report.checks as string[], directory: dir };
    }
}
