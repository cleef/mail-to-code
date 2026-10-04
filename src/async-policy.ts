import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { expand, type Config } from './config.js';
import type { Conversation } from './async-store.js';
import { codexPolicy } from './runner.js';
import { projectLocations } from './async-projects.js';
export function asyncPolicy(config: Config, c: Conversation) {
    const directory = join(config.dataDir, 'async-cli', 'features', c.id), worktrees = join(directory, 'worktrees'), notes = join(directory, 'notes');
    const locations = projectLocations(config);
    const entries: Record<string, string> = { [worktrees]: 'write', [notes]: 'write', [join(directory, 'input')]: 'read', [join(worktrees, '**/.git')]: 'deny', [join(worktrees, '**/.codex')]: 'deny', [join(worktrees, '**/.agents')]: 'deny', [join(worktrees, '**/.env')]: 'deny', [join(worktrees, '**/.env.*')]: 'deny', [join(worktrees, '**/*.pem')]: 'deny', [join(worktrees, '**/*.key')]: 'deny', [join(worktrees, '**/.npmrc')]: 'deny', [join(expand('~/.codex'), 'auth.json')]: 'deny', [expand('~/.ssh')]: 'deny', [expand('~/.aws')]: 'deny', [expand('~/.netrc')]: 'deny' };
    if (config.githubTokenFile)
        entries[config.githubTokenFile] = 'deny';
    for (const db of ['async-cli.sqlite', 'state.sqlite'])
        for (const suffix of ['', '-wal', '-shm'])
            entries[join(config.dataDir, db + suffix)] = 'deny';
    // Explicitly mask other task directories even when operators put dataDir under /tmp.
    const features = join(config.dataDir, 'async-cli', 'features');
    try {
        for (const name of readdirSync(features))
            if (name !== c.id)
                entries[join(features, name)] = 'deny';
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
            throw e;
    }
    // Missing exact masks have no source to hide and race in Linux's synthetic
    // mount helper. System/home paths remain denied by the parent policy; new
    // engine databases are created before any model starts. Keep future-file
    // glob restrictions inside the writable task roots.
    for (const [path, permission] of Object.entries(entries))
        if (permission === 'deny' && !path.includes('*') && !existsSync(path))
            delete entries[path];
    // No account MCP servers, plugins or hooks are inherited. Network is disabled for native tools.
    return codexPolicy(config, config.projectsRoot, 'plan', locations.map(p => p.path), true, locations.map(p => p.entry), entries);
}
