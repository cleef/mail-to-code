import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from './config.js';
const template = fileURLToPath(new URL('../../config-templates/AGENTS.md', import.meta.url));
export const agentGuidePath = (directory = configDir()) => join(directory, 'AGENTS.md');
export async function readAgentGuide(directory = configDir()): Promise<string> {
    const path = agentGuidePath(directory);
    let content: string;
    try {
        const info = await lstat(path);
        if (!info.isFile() || (info.mode & 0o077)) throw new Error('Agent AGENTS.md must be a regular private file (600)');
        if (info.size > 32768) throw new Error('Agent AGENTS.md exceeds 32 KiB');
        content = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        content = await readFile(template, 'utf8');
    }
    if (/-----BEGIN [^-]*PRIVATE KEY-----|\b(?:access_token|refresh_token|client_secret|api_key|password)\s*[=:]\s*["']?\S+/i.test(content))
        throw new Error('Agent AGENTS.md contains possible credentials; remove them before analysis');
    return content;
}
export async function initializeAgentGuide(directory = configDir()): Promise<{ path: string; created: boolean }> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = agentGuidePath(directory);
    try {
        await writeFile(path, await readFile(template, 'utf8'), { mode: 0o600, flag: 'wx' });
        return { path, created: true };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return { path, created: false };
    }
}
