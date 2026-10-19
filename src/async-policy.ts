import { join, dirname, resolve, delimiter } from 'node:path';
import { existsSync, realpathSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expand, configDir, type Config } from './config.js';
import type { Conversation } from './async-store.js';
import { projectLocations } from './async-projects.js';
import { developmentEnvironment } from './runner.js';
import { sessionOf } from './executor.js';

export const installationRoot = fileURLToPath(new URL('../../', import.meta.url));
const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

// Deny unknown child names recursively without a blanket deny glob over this
// task's own paths: Codex applies deny globs even beneath explicit write grants.
// The trie also protects tasks/files created after a persistent session starts.
function protectDirectory(entries: Record<string,string>, root: string, allowed: string[]) {
    type PathNode = { terminal?: boolean; children: Map<string, PathNode> };
    const tree: PathNode = { children: new Map() };
    for (const path of allowed) {
        let node = tree;
        for (const part of path.split('/')) {
            if (!node.children.has(part)) node.children.set(part, { children: new Map() });
            node = node.children.get(part)!;
        }
        node.terminal = true;
    }
    const level = (directory: string, node: PathNode) => {
        if (node.terminal) return; // The complete allowed subtree belongs to this task.
        type Letters = { accepted?: PathNode; children: Map<string, Letters> };
        const names: Letters = { children: new Map() };
        for (const [name, child] of node.children) {
            let cursor = names;
            for (const ch of name) {
                if (!cursor.children.has(ch)) cursor.children.set(ch, { children: new Map() });
                cursor = cursor.children.get(ch)!;
            }
            cursor.accepted = child;
        }
        const patterns: string[] = [];
        const walk = (prefix: string, letters: Letters) => {
            // Dot prefixes would normalize to a parent and mask allowed children.
            if (prefix && prefix !== '.' && prefix !== '..' && !letters.accepted) patterns.push(prefix);
            // A hyphen must be last in a glob character class, never a range.
            const chars = [...letters.children.keys()].sort((a,b) => a === '-' ? 1 : b === '-' ? -1 : a.localeCompare(b)).join('');
            patterns.push(prefix + (chars ? '[!' + chars + ']*' : '?*'));
            for (const [ch, child] of letters.children) walk(prefix + ch, child);
            if (letters.accepted) level(join(directory, prefix), letters.accepted);
        };
        walk('', names);
        // Bounded alternations avoid both argv limits and Seatbelt's string
        // parser limit when native project names are long.
        let group: string[] = [];
        const flush = () => {
            if (!group.length) return;
            const pattern = join(directory, '{' + group.join(',') + '}');
            entries[pattern] = 'deny';
            entries[pattern + '/**'] = 'deny';
            group = [];
        };
        for (const pattern of patterns) {
            if (group.join(',').length + pattern.length > 512) flush();
            group.push(pattern);
        }
        flush();
    };
    level(root, tree);
}

export function nativeFilesystem(config: Config, c: Conversation, executable?: string): Record<string, string> {
    const directory = canonical(join(config.dataDir, 'async-cli', 'features', c.id));
    const entries: Record<string, string> = { ':root': 'deny', ':minimal': 'read', [dirname(canonical(process.execPath))]: 'read', [canonical(config.projectsRoot)]: 'write' };
    for (const path of [canonical(config.projectsRoot), ...projectLocations(config).map(p => p.path)]) {
        entries[path] = 'write';
        // Native Git owns metadata, including worktrees created later in this root.
        const metadata = join(path, '.git');
        if (existsSync(metadata)) {
            entries[canonical(metadata)] = 'write';
            try {
                const pointer = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(metadata,'utf8'));
                if (pointer) {
                    const gitdir = canonical(resolve(path,pointer[1])); entries[gitdir] = 'write';
                    try { entries[canonical(resolve(gitdir,readFileSync(join(gitdir,'commondir'),'utf8').trim()))] = 'write'; } catch { /* standalone gitdir */ }
                }
            } catch { /* normal .git directory */ }
        }
    }
    // Keep structural parents read-only too: otherwise a writable projectsRoot
    // could rename runtime storage and bypass path-based child masks.
    for (const path of [config.dataDir, join(config.dataDir, 'async-cli'), join(config.dataDir, 'async-cli', 'features'), directory]) entries[canonical(path)] = 'read';
    for (const name of ['worktrees', 'notes', 'tmp']) entries[join(directory, name)] = 'write';
    entries[join(directory, 'input')] = 'read';
    if (config.productDocs) entries[canonical(config.productDocs)] = 'write';
    const home = expand('~');
    // Reuse host developer login, not mail login. Do not expose the whole HOME.
    for (const path of [join(home, '.ssh'), join(home, '.gitconfig'), join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'git'), process.env.GH_CONFIG_DIR || join(home, '.config', 'gh'), process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_SYSTEM]) {
        if (path && existsSync(path)) { entries[resolve(path)] = 'read'; entries[canonical(path)] = 'read'; }
    }
    for (const path of (developmentEnvironment().PATH || '').split(delimiter)) if (path && existsSync(path) && !entries[canonical(path)]) entries[canonical(path)] = 'read';
    if (process.env.SSH_AUTH_SOCK && existsSync(process.env.SSH_AUTH_SOCK)) entries[canonical(process.env.SSH_AUTH_SOCK)] = 'write';
    for (const path of ['/usr/local', '/opt/homebrew', '/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer']) if (existsSync(path)) entries[canonical(path)] = 'read';
    if (process.platform === 'darwin') entries['/System/Library/OpenSSL'] = 'read';
    const codexHome = canonical(process.env.CODEX_HOME || join(home, '.codex'));
    for (const name of ['sessions', 'archived_sessions', 'logs', 'sqlite']) entries[join(codexHome, name, '**')] = 'deny';
    entries[join(codexHome, '*.sqlite*')] = 'deny';
    const claude = canonical(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'));
    if (existsSync(claude)) entries[claude] = 'deny';
    if (existsSync(join(home, '.claude.json'))) entries[join(home, '.claude.json')] = 'deny';
    if (executable) {
        // Claude's complete process is sandboxed, including its native file tools.
        entries[dirname(canonical(executable))] = 'read';
        if (!process.env.CLAUDE_CONFIG_DIR && existsSync(join(home, '.claude.json'))) entries[join(home, '.claude.json')] = 'read';
        for (const name of ['.credentials.json', 'settings.json', '.claude.json']) if (existsSync(join(claude,name))) entries[join(claude,name)] = 'read';
        const session = sessionOf(c);
        if (session) {
            const project = canonical(config.projectsRoot).replace(/[^a-zA-Z0-9]/g, '-');
            entries[join(claude, 'projects', project, session + '.jsonl')] = 'write';
            entries[join(claude, 'projects', project, session)] = 'write';
            entries[join(claude, 'debug', session + '.txt')] = 'write';
            entries[join(claude, 'todos', session + '-agent-' + session + '.json')] = 'write';
            entries[join(claude, 'tasks', session)] = 'write';
            entries[join(claude, 'session-env', session)] = 'write';
        }
    }
    // Exact private parents do not contain writable task children. Keep these
    // masks even when projectsRoot is broad or dataDir is inside projectsRoot.
    for (const path of [configDir(), config.mailCodexHome || join(configDir(), 'codex-mail'), join(config.dataDir, 'artifacts'), join(config.dataDir, 'effect-logs'), join(config.dataDir, 'operation-locks'), join(config.dataDir, 'backups')]) {
        entries[resolve(path)] = 'deny'; entries[join(resolve(path),'**')]='deny';
        if (existsSync(path)) {entries[canonical(path)] = 'deny';entries[join(canonical(path),'**')]='deny';}
    }
    for (const dataDirectory of new Set([resolve(config.dataDir), canonical(config.dataDir)])) {
        entries[join(dataDirectory, '*.sqlite*')] = 'deny';
        for (const db of ['async-cli.sqlite', 'state.sqlite']) for (const suffix of ['', '-wal', '-shm']) entries[join(dataDirectory, db + suffix)] = 'deny';
    }
    if(!/^[a-zA-Z0-9_-]+$/.test(c.id))throw Error('INVALID_TASK_ID_FOR_SANDBOX');
    protectDirectory(entries, canonical(config.dataDir), ['notes', 'tmp', 'worktrees', 'input'].map(name => `async-cli/features/${c.id}/${name}`));
    if (config.githubTokenFile) entries[canonical(config.githubTokenFile)] = 'deny';
    // The live installation can only be upgraded manually. Feature copies remain writable.
    entries[canonical(installationRoot)] = 'read';
    if (existsSync(join(installationRoot,'.git'))) entries[canonical(join(installationRoot,'.git'))] = 'read';
    // Linux's pinned mount helper cannot construct absent exact masks.
    for (const [path] of Object.entries(entries)) if (path.startsWith('/') && !/[?*\[{}]/.test(path) && !existsSync(path)) delete entries[path];
    return entries;
}
export function asyncPolicy(config: Config, c: Conversation, executable?: string) {
    const filesystem = '{' + Object.entries(nativeFilesystem(config, c, executable)).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',') + '}';
    return ['-c', 'approval_policy="never"', '-c', 'default_permissions="mail-to-code-task"',
        '-c', `permissions.mail-to-code-task.filesystem=${filesystem}`,
        '-c', 'permissions.mail-to-code-task.network.enabled=true',
        '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.hooks=false',
        '-c', 'shell_environment_policy.inherit="all"', '-c', 'shell_environment_policy.ignore_default_excludes=true'];
}

// Mount-based sandboxes need exact paths to exist before the policy is built.
// Only this session's storage is prepared; historical sessions remain protected.
export function prepareNativeFilesystem(config: Config, c: Conversation, executable?: string) {
    const directory = canonical(join(config.dataDir, 'async-cli', 'features', c.id));
    for (const name of ['notes', 'tmp', 'worktrees', 'input']) mkdirSync(join(directory, name), { recursive: true, mode: 0o700 });
    if (!executable || !sessionOf(c)) return;
    const claude = canonical(process.env.CLAUDE_CONFIG_DIR || join(expand('~'), '.claude'));
    const project = canonical(config.projectsRoot).replace(/[^a-zA-Z0-9]/g, '-');
    const session = sessionOf(c)!;
    for (const path of [join(claude, 'projects', project, session), join(claude, 'debug'), join(claude, 'todos'), join(claude, 'session-env', session), join(claude, 'tasks', session)]) mkdirSync(path, { recursive: true, mode: 0o700 });
    for (const path of [join(claude, 'projects', project, session + '.jsonl'), join(claude, 'debug', session + '.txt'), join(claude,'todos',session+'-agent-'+session+'.json')]) {
        try { writeFileSync(path, path.endsWith('.json') ? '[]' : '', { flag: 'wx', mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
}
