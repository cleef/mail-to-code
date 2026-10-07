import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configDir, expand, privateDir, type Config } from './config.js';
import { shellEnvironment } from './runner.js';
import { AppServer, denyInteractive } from './app-server.js';
import { inspectGmailPlugin, type GmailPluginReadiness } from './gmail-plugin-readiness.js';

export function mailCodexHome(config: Pick<Config, 'mailCodexHome'>) {
    return config.mailCodexHome ? expand(config.mailCodexHome) : resolve(configDir(), 'codex-mail');
}
export function mailCodexEnvironment(home: string): NodeJS.ProcessEnv {
    return { ...shellEnvironment(), CODEX_HOME: home };
}
export async function checkSeparateHome(home: string) {
    const coding = expand('~/.codex');
    const canonicalHome = await realpath(home).catch(() => resolve(home));
    const canonicalCoding = await realpath(coding).catch(() => coding);
    if (canonicalHome === canonicalCoding || canonicalHome.startsWith(canonicalCoding + '/') || canonicalCoding.startsWith(canonicalHome.endsWith('/')?canonicalHome:canonicalHome + '/'))
        throw Error('MAIL_CODEX_HOME_MUST_BE_SEPARATE_FROM_DEVELOPMENT');
}
export async function connectMail(config: Config, deviceAuth = false): Promise<void> {
    const home = mailCodexHome(config);
    await checkSeparateHome(home);
    await privateDir(home);
    const args = ['-c', 'cli_auth_credentials_store="file"', '-c', 'features.apps=true', '-c', 'features.plugins=true', '-c', 'features.hooks=false'];
    if (deviceAuth) args.push('login', '--device-auth');
    await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(config.codexCommand, args, { cwd: home, env: mailCodexEnvironment(home), stdio: 'inherit' });
        child.once('error', () => reject(Error('MAIL_CODEX_CONNECT_START_FAILED')));
        child.once('exit', (code, signal) => code === 0 && !signal ? resolvePromise() : reject(Error('MAIL_CODEX_CONNECT_FAILED')));
    });
}
export async function checkMailPlugin(config: Config, overrideHome?: string): Promise<GmailPluginReadiness> {
    const home = overrideHome ? expand(overrideHome) : mailCodexHome(config);
    await checkSeparateHome(home);
    const info = await stat(home).catch(() => null);
    if (!info?.isDirectory() || (info.mode & 0o077)) throw Error('MAIL_CODEX_HOME_PRIVATE_DIRECTORY_REQUIRED');
    const server = await startMailServer(config, home);
    try { const result = await inspectGmailPlugin(server, config.gmailAddress); delete result.session; return result; }
    finally { await server.close(); }
}
export async function startMailServer(config: Config, home = mailCodexHome(config)) {
    await checkSeparateHome(home);
    const info = await stat(home).catch(() => null);
    if (!info?.isDirectory() || (info.mode & 0o077)) throw Error('MAIL_CODEX_HOME_PRIVATE_DIRECTORY_REQUIRED');
    const server = new AppServer(config.codexCommand, ['-c', 'cli_auth_credentials_store="file"', '-c', 'features.apps=true', '-c', 'features.plugins=true', '-c', 'features.hooks=false'], home, async r => denyInteractive(r), 30000, mailCodexEnvironment(home));
    await server.start().catch(async e => { await server.close(); throw e; });
    return server;
}
