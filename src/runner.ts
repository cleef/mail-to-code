import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter, resolve } from 'node:path';

// Mail transport gets core shell values only, never development credentials.
export function shellEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ', 'HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) if (source[key]) result[key] = source[key];
    return result;
}
export function developmentEnvironment(temporaryDirectory?: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const result = shellEnvironment(source);
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_SSH', 'GIT_SSH_COMMAND', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_CONFIG_DIR']) if (source[key]) result[key] = source[key];
    const home = source.HOME || homedir();
    const privateHomes = [source.CODEX_HOME || join(home,'.codex'),source.CLAUDE_CONFIG_DIR || join(home,'.claude')].map(p=>resolve(p));
    if (result.PATH) result.PATH=result.PATH.split(delimiter).filter(p=>p && existsSync(p) && !privateHomes.some(root=>resolve(p)===root || resolve(p).startsWith(root+'/'))).map(p=>realpathSync(p)).join(delimiter);
    // Avoid EPERM on an absent host global config under a read-restricted HOME.
    if (!result.GIT_CONFIG_GLOBAL && !existsSync(join(home,'.gitconfig')) && !existsSync(join(source.XDG_CONFIG_HOME || join(home,'.config'),'git','config'))) result.GIT_CONFIG_GLOBAL = '/dev/null';
    if (temporaryDirectory) Object.assign(result, { TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory, NPM_CONFIG_CACHE: join(temporaryDirectory, 'npm-cache') });
    return result;
}
export function disabledMcpPolicy(servers:{name?:string;transport?:{type?:string}}[]):string[]{
  return servers.filter(s=>s.name).flatMap(s=>{
    if(!/^[a-zA-Z0-9_-]+$/.test(s.name!))throw Error('CODEX_MCP_NAME_INVALID');
    const transport=s.transport?.type||'stdio';
    if(!['stdio','streamable_http'].includes(transport))throw Error('CODEX_MCP_TRANSPORT_INVALID');
    const inert=transport==='stdio'?'command="/usr/bin/true"':'url="https://invalid.invalid/"';
    return ['-c',`mcp_servers.${s.name}={${inert},enabled=false}`];
  });
}
