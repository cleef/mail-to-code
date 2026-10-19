import { join, dirname, resolve, delimiter } from 'node:path';
import { existsSync, realpathSync, mkdirSync, writeFileSync, readFileSync, accessSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expand, configDir, type Config } from './config.js';
import type { Conversation } from './async-store.js';
import { projectLocations } from './async-projects.js';
import { developmentEnvironment } from './runner.js';
import { sessionOf } from './executor.js';

export const installationRoot = fileURLToPath(new URL('../../', import.meta.url));
const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith('/') ? root : root + '/');

// Linux re-executes the Codex native binary inside bwrap. npm's PATH shim and
// platform binary are separate packages, including in a private temporary install.
function commandRoots(command: string): string[] {
    const candidates = command.includes('/') ? [resolve(command)] : (process.env.PATH || '').split(delimiter).map(path => join(path, command));
    for (const candidate of candidates) {
        try {
            accessSync(candidate, constants.X_OK);
            const executable = canonical(candidate), roots = new Set([dirname(executable)]);
            let directory = dirname(executable);
            for (let depth = 0; depth < 5; depth++, directory = dirname(directory)) {
                try {
                    const name = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name;
                    if (/^@(?:openai\/codex|anthropic-ai\/claude-code)(?:-[a-z0-9-]+)?$/.test(name)) {
                        roots.add(directory);
                        const platformPackage = join(dirname(directory), name.split('/')[1] + `-${process.platform}-${process.arch}`);
                        if (existsSync(platformPackage)) roots.add(canonical(platformPackage));
                        break;
                    }
                } catch { /* native binaries need no npm manifest */ }
            }
            return [...roots];
        } catch { /* try the next PATH entry; missing launchers still fail closed */ }
    }
    return [];
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
    // A denied runtime parent becomes a private mount on Linux. Reopen only
    // this task directory; future sibling tasks/DB files never enter its view.
    entries[canonical(config.dataDir)] = 'deny';
    entries[directory] = 'write';
    for (const name of ['worktrees', 'notes', 'tmp']) entries[join(directory, name)] = 'write';
    entries[join(directory, 'input')] = 'read';
    if (config.productDocs) entries[canonical(config.productDocs)] = 'write';
    const home = expand('~');
    // Reuse host developer login, not mail login. Do not expose the whole HOME.
    for (const path of [join(home, '.ssh'), join(home, '.gitconfig'), join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'git'), process.env.GH_CONFIG_DIR || join(home, '.config', 'gh'), process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_SYSTEM]) {
        if (path && existsSync(path)) { entries[resolve(path)] = 'read'; entries[canonical(path)] = 'read'; }
    }
    for (const path of (developmentEnvironment().PATH || '').split(delimiter)) if (path && existsSync(path) && !entries[canonical(path)]) entries[canonical(path)] = 'read';
    for (const path of [...commandRoots(config.codexCommand), ...(executable ? commandRoots(executable) : [])]) if (!entries[path]) entries[path] = 'read';
    if (process.env.SSH_AUTH_SOCK && existsSync(process.env.SSH_AUTH_SOCK)) entries[canonical(process.env.SSH_AUTH_SOCK)] = 'write';
    for (const path of ['/usr/local', '/opt/homebrew', '/Library/Developer/CommandLineTools', '/Applications/Xcode.app/Contents/Developer']) if (existsSync(path)) entries[canonical(path)] = 'read';
    if (process.platform === 'darwin') entries['/System/Library/OpenSSL'] = 'read';
    const codexHome = canonical(process.env.CODEX_HOME || join(home, '.codex'));
    const privateRoots = [configDir(), config.mailCodexHome || join(configDir(), 'codex-mail'), config.dataDir, ...['sessions', 'archived_sessions', 'logs', 'sqlite'].map(name => join(codexHome, name))];
    entries[join(codexHome, '*.sqlite*')] = 'deny';
    const claude = canonical(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'));
    if (executable) entries[dirname(canonical(executable))] = 'read';
    if (process.platform === 'linux' && executable) {
        // Pinned bwrap cannot reopen individual files beneath a denied parent.
        // Keep the native account store outside broad project/tool grants so
        // root-deny plus exact session/auth grants isolate it without a parent mask.
        if (Object.entries(entries).some(([path, access]) => access !== 'deny' && path.startsWith('/') && within(claude, path))) throw Error('CLAUDE_HOME_OVERLAPS_SANDBOX_GRANT');
    } else if (existsSync(claude)) entries[claude] = 'deny';
    if (existsSync(join(home, '.claude.json'))) entries[join(home, '.claude.json')] = 'deny';
    if (executable) {
        // Claude's complete process is sandboxed, including its native file tools.
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
    if (!/^[a-zA-Z0-9_-]+$/.test(c.id)) throw Error('INVALID_TASK_ID_FOR_SANDBOX');
    if (config.githubTokenFile) privateRoots.push(config.githubTokenFile);
    // Do not stack masks beneath a denied private parent: the pinned Linux
    // helper otherwise tries to create child targets on an already frozen mount.
    // Also remove narrower PATH/project grants that could reopen private mail.
    const roots = [...new Set(privateRoots.map(canonical))].sort((a,b) => a.length - b.length);
    const masked: string[] = [];
    for (const root of roots) {
        if (masked.some(parent => within(root, parent))) continue;
        if (within(directory, root) && root !== canonical(config.dataDir)) throw Error('MAIL_TASK_OVERLAPS_PRIVATE_CONFIG');
        for (const path of Object.keys(entries)) {
            if (within(path, root) && !(root === canonical(config.dataDir) && within(path, directory))) delete entries[path];
        }
        entries[root] = 'deny';
        masked.push(root);
    }
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
