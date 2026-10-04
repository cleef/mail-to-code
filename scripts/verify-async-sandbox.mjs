// Actual Linux Codex sandbox only; no model, mailbox, network or business operations.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,realpath,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigSchema} from '../dist/src/config.js';
import {asyncPolicy,ASYNC_CODEX_VERSION} from '../dist/src/async-cli.js';
import {execute} from '../dist/src/process.js';
import {shellEnvironment,Runner,disabledMcpPolicy} from '../dist/src/runner.js';
import {AppServer,denyInteractive} from '../dist/src/app-server.js';
process.umask(0o077);
const command=process.env.ASYNC_CODEX_COMMAND||'codex';
assert.equal((await execute(command,['--version'])).stdout.trim(),`codex-cli ${ASYNC_CODEX_VERSION}`);
const root=await realpath(await mkdtemp(join(tmpdir(),'mail-async-sandbox-'))),projectsRoot=join(root,'projects'),dataDir=join(root,'state'),c={id:'primary'},directory=join(dataDir,'async-cli/features',c.id),worktree=join(directory,'worktrees','demo'),notes=join(directory,'notes'),foreign=join(dataDir,'async-cli/features','foreign');
await Promise.all([mkdir(projectsRoot,{recursive:true}),mkdir(worktree,{recursive:true}),mkdir(notes,{recursive:true}),mkdir(join(directory,'input'),{recursive:true}),mkdir(foreign,{recursive:true})]);
const linked=join(root,'linked-repository');await mkdir(linked);await mkdir(join(linked,'.git'));await writeFile(join(linked,'README.md'),'linked source');await symlink(linked,join(projectsRoot,'linked'));
const configDirectory=join(root,'config');await mkdir(configDirectory);process.env.MAIL_TO_CODE_CONFIG_DIR=configDirectory;
const agents=join(projectsRoot,'AGENTS.md');await writeFile(agents,'Synthetic sandbox instructions: read-only original projects; use only task worktrees.\n');
const source=join(projectsRoot,'source.txt'),db=join(dataDir,'async-cli.sqlite'),secret=join(worktree,'.env'),git=join(worktree,'.git'),token=join(configDirectory,'github-token'),externalToken=join(root,'external-token'),oauth=join(configDirectory,'token.json'),futureSecret=join(worktree,'created-later.key');
await Promise.all([writeFile(source,'original'),writeFile(db,'synthetic runtime only'),writeFile(secret,'SYNTHETIC_SECRET=example'),writeFile(git,'synthetic git metadata'),writeFile(token,'synthetic token'),writeFile(externalToken,'synthetic external token'),writeFile(oauth,'synthetic OAuth'),writeFile(join(foreign,'FEATURE.md'),'foreign private state')]);
const config=ConfigSchema.parse({gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',projectsRoot,dataDir,codexCommand:command,githubTokenFile:token});
const probe=`const fs=require('node:fs');const paths=JSON.parse(process.argv[1]);let results={linkedProjectRead:fs.readFileSync(paths.linked,'utf8')==='linked source',instructionsRead:fs.readFileSync(paths.agents,'utf8').startsWith('Synthetic sandbox instructions:')};for(const [key,path]of Object.entries(paths.readDeny)){try{fs.readFileSync(path);results[key]=false;}catch{results[key]=true;}}for(const [key,path]of Object.entries(paths.writeDeny)){try{fs.writeFileSync(path,'changed');results[key]=false;}catch{results[key]=true;}}fs.writeFileSync(paths.allowed,'allowed');fs.writeFileSync(paths.allowedWorktree,'allowed');results.taskWorktreeWrite=true;process.stdout.write(JSON.stringify(results));`;
const input={readDeny:{database:db,secret,token,oauth,foreign:join(foreign,'FEATURE.md'),gitMetadata:git},writeDeny:{originalCheckout:source,linkedCheckout:join(projectsRoot,'linked/README.md'),gitMetadataWrite:git},allowed:join(notes,'probe.txt'),allowedWorktree:join(worktree,'probe.ts'),agents,linked:join(projectsRoot,'linked/README.md')};
const policy=asyncPolicy(config,c);
// A future secret must also be denied after the policy has been generated.
await writeFile(futureSecret,'synthetic future secret');input.readDeny.futureSecret=futureSecret;
const result=await execute(command,['sandbox',...policy,'-P','mail-to-code-task','--','/usr/bin/bash','-c','set -o pipefail; "$@" 2> >(cat >&2) | cat','sandbox-probe',process.execPath,'-e',probe,JSON.stringify(input)],{cwd:projectsRoot,env:shellEnvironment(),timeoutMs:30000});
const checks=JSON.parse(result.stdout);for(const [name,passed]of Object.entries(checks))assert.equal(passed,true,name+' unexpectedly permitted');assert.equal(await readFile(source,'utf8'),'original');assert.equal(await readFile(input.allowed,'utf8'),'allowed');assert.equal(await readFile(input.allowedWorktree,'utf8'),'allowed');
const adapted=await new Runner(config).check(worktree,process.execPath,['-e',probe,JSON.stringify(input)],worktree,new AbortController().signal,false,{policy});assert.deepEqual(JSON.parse(adapted.stdout),checks);
const externalConfig={...config,githubTokenFile:externalToken},externalInput={...input,readDeny:{...input.readDeny,externalToken}};
const external=await execute(command,['sandbox',...asyncPolicy(externalConfig,c),'-P','mail-to-code-task','--','/usr/bin/bash','-c','set -o pipefail; "$@" 2> >(cat >&2) | cat','sandbox-probe',process.execPath,'-e',probe,JSON.stringify(externalInput)],{cwd:projectsRoot,env:shellEnvironment(),timeoutMs:30000});
for(const [name,passed]of Object.entries(JSON.parse(external.stdout)))assert.equal(passed,true,name+' unexpectedly permitted with external token');
const servers=JSON.parse((await execute(command,['mcp','list','--json'],{env:shellEnvironment()})).stdout);
const client=new AppServer(command,[...policy,...disabledMcpPolicy(servers)],projectsRoot,async r=>denyInteractive(r),30000);
let threadStarted=false;
try{await client.start();const result=await client.request('thread/start',{cwd:projectsRoot,approvalPolicy:'never',developerInstructions:'Synthetic sandbox startup probe only. No model turn, mailbox or business operations.',dynamicTools:[]});assert.ok(result.thread.id);threadStarted=true;}finally{await client.close();}
console.log(JSON.stringify({codexVersion:ASYNC_CODEX_VERSION,checks,adapterChecks:true,externalTokenChecks:true,threadStarted,network:false,realMailSent:0,businessEffects:0},null,2));
