import {readdirSync,existsSync,realpathSync} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './config.js';
import { configDir } from './config.js';
import { execute } from './process.js';

// Code/model subprocesses get no controller tokens or unrelated credentials.
export function shellEnvironment():NodeJS.ProcessEnv { const result:NodeJS.ProcessEnv={}; for(const k of ['PATH','LANG','LC_ALL','TMPDIR','TZ','HOME','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'])if(process.env[k])result[k]=process.env[k];return result; }
function mailCredentialPaths(config?:Pick<Config,'mailCodexHome'>){
  const home=config?.mailCodexHome ? resolve(config.mailCodexHome.startsWith('~/') ? join(homedir(),config.mailCodexHome.slice(2)) : config.mailCodexHome) : resolve(configDir(),'codex-mail');
  return existsSync(home)?[...new Set([home,realpathSync(home)])]:[];
}
export function codexPolicy(config:Config,worktree:string,phase:'plan'|'develop',readPaths:string[]=[],analysis=false,trustedProjectLinks:string[]=[],additionalFilesystem:Record<string,string>={},temporaryDirectory?:string):string[] {
  const filesystem:Record<string,string>={':root':'deny',':minimal':'read',[resolve(worktree)]:phase==='plan'?'read':'write',
    [join(worktree,'.git')]:'read',[join(worktree,'.codex')]:'read',[join(worktree,'.agents')]:'read',...(temporaryDirectory?{[temporaryDirectory]:'write'}:{':tmpdir':'write',':slash_tmp':'write'})};
  // Node's macOS builds load the system OpenSSL configuration during startup.
  if(process.platform==='darwin')filesystem['/System/Library/OpenSSL']='read';
  for(const p of readPaths)if(resolve(p)!==resolve(worktree))filesystem[resolve(p)]='read';
  if(config.productDocs)filesystem[config.productDocs]='read';
  for(const repo of Object.values(config.repositories)) {
    filesystem[join(repo.path,'.git')]='read';filesystem[join(repo.path,'.git','config')]='deny';filesystem[join(repo.path,'.git','hooks')]='deny';
    if(repo.productDocs)filesystem[repo.productDocs]='read';
  }
  // A checkout may contain tracked production credentials. Deny conventional
  // secret files explicitly, including in other read-only task repositories.
  const scan=(root:string)=>{let entries;try{entries=readdirSync(root,{withFileTypes:true});}catch{return;}
    for(const e of entries){const path=join(root,e.name),secret=(analysis&&(e.name==='.git'||e.isSymbolicLink()&&!trustedProjectLinks.includes(path)))||['.ssh','.aws','.gnupg','.config','.codex','.claude','.claude.json','.npmrc','.pypirc','.netrc','auth.json'].includes(e.name)||/\.(pem|key)$/.test(e.name)||/^\.env($|\.)/.test(e.name)&&!['.env.example','.env.sample'].includes(e.name);
      if(secret){filesystem[path]='deny';continue;}if(e.isDirectory()&&!['.git','node_modules','dist','dist-h5','.run','.release'].includes(e.name))scan(path);
    }
  };for(const root of [worktree,...readPaths,...(config.productDocs?[config.productDocs]:[])])scan(resolve(root));
  // CLI -c splits dotted keys literally: pass quoted paths as an inline TOML table.
  if(analysis){
    // Bubblewrap cannot create missing read-only mount points inside a read-only
    // project root. Missing children inherit the parent policy without a mount.
    for(const [path,permission] of Object.entries(filesystem))
      if(permission==='read' && path.startsWith('/') && !existsSync(path))delete filesystem[path];
    filesystem[configDir()]='deny';
    if(resolve(config.dataDir).startsWith(resolve(worktree)+'/'))filesystem[resolve(config.dataDir)]='deny';
    for(const p of readPaths)filesystem[resolve(p)]='read';
  }
  Object.assign(filesystem,additionalFilesystem);
  if(temporaryDirectory)for(const [path,permission] of Object.entries(filesystem))
    if(permission==='read' && path.startsWith('/') && !existsSync(path))delete filesystem[path];
  for(const path of mailCredentialPaths(config))filesystem[path]='deny';
  // Normalize the complete policy, including async masks. A denied parent already
  // hides exact descendants, unless an intervening read/write rule reopens them.
  // Keep glob masks: they also protect files created later in writable task roots.
  const rules=Object.entries(filesystem);
  for(const [child,permission] of rules) {
    if(permission!=='deny'||!child.startsWith('/')||child.includes('*'))continue;
    const covered=rules.some(([parent,value])=>value==='deny'&&parent.startsWith('/')&&!parent.includes('*')&&child.startsWith(parent+'/')&&
      !rules.some(([allowed,access])=>access!=='deny'&&allowed.startsWith(parent+'/')&&!allowed.includes('*')&&(child===allowed||child.startsWith(allowed+'/'))));
    if(covered)delete filesystem[child];
  }
  const filesystemToml='{'+Object.entries(filesystem).map(([key,value])=>`${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')+'}';
  const args=['-c','approval_policy="never"','-c','default_permissions="mail-to-code-task"',
    '-c',`permissions.mail-to-code-task.filesystem=${filesystemToml}`,
    '-c','permissions.mail-to-code-task.network.enabled=false',
    '-c',`mcp_servers.gmail.command=${JSON.stringify(process.execPath)}`,
    '-c','mcp_servers.gmail.enabled=false','-c','features.apps=false','-c','features.plugins=false','-c','features.hooks=false','-c','web_search="disabled"',
    '-c','shell_environment_policy.inherit="core"',
    '-c','shell_environment_policy.ignore_default_excludes=false'];
  return args;
}
// Inventory may include plugin servers that are absent from the exec configuration.
// An enabled=false leaf alone would create an invalid transport-less server entry.
export function disabledMcpPolicy(servers:{name?:string;transport?:{type?:string}}[]):string[]{
  return servers.filter(s=>s.name).flatMap(s=>{
    if(!/^[a-zA-Z0-9_-]+$/.test(s.name!))throw Error('CODEX_MCP_NAME_INVALID');
    const transport=s.transport?.type||'stdio';
    if(!['stdio','streamable_http'].includes(transport))throw Error('CODEX_MCP_TRANSPORT_INVALID');
    const inert=transport==='stdio'?'command="/usr/bin/true"':'url="https://invalid.invalid/"';
    return ['-c',`mcp_servers.${s.name}={${inert},enabled=false}`];
  });
}
export class Runner {
  constructor(readonly config:Config) {}
  async check(worktree:string,command:string,args:string[],cwd:string,signal:AbortSignal,network=false,options:{env?:NodeJS.ProcessEnv;sources?:string[];policy?:string[];cacheDirectory?:string}={}) {
    const policy=[...(options.policy||codexPolicy(this.config,worktree,'develop'))];
    if(network){policy.push('-c','permissions.mail-to-code-task.network.enabled=true','-c','features.network_proxy=true','-c',`permissions.mail-to-code-task.network.domains={${(options.sources||['registry.npmjs.org']).map(d=>JSON.stringify(d)+'="allow"').join(',')}}`);}
    // Codex 0.159's Linux stdio bridge appears as UNKNOWN to Node's handle
    // detection. Ordinary pipes restore Node/npm logs while pipefail preserves
    // failed test exit codes. All command data stays in positional arguments.
    return execute(this.config.codexCommand,['sandbox',...policy,'-P','mail-to-code-task','--','/usr/bin/bash','-c',
      'set -o pipefail; "$@" 2> >(cat >&2) | cat','mail-to-code-check',command,...args],
      {cwd,env:{...shellEnvironment(),...options.env,NPM_CONFIG_CACHE:options.cacheDirectory||'/tmp/mail-to-code-npm-cache'},signal,timeoutMs:this.config.timeoutSeconds*1000});
  }
}
