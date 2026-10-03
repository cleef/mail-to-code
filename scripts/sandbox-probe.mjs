import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../dist/src/config.js';
import { Runner } from '../dist/src/runner.js';
import { execute } from '../dist/src/process.js';

const config=await loadConfig();
await mkdir(join(config.dataDir,'worktrees'),{recursive:true,mode:0o700});
const worktree=await mkdtemp(join(config.dataDir,'worktrees/probe-'));
const secret=join(config.dataDir,'sandbox-probe-private');
await writeFile(secret,'synthetic-secret-do-not-expose',{mode:0o600});
const script=`const fs=require('node:fs'); let denied=false; try{fs.readFileSync(${JSON.stringify(secret)})}catch{denied=true} if(!denied) process.exit(10); fs.writeFileSync('allowed.txt','ok'); console.log('secret-read-denied; workspace-write-allowed')`;
try {
  const result=await new Runner(config).check(worktree,process.execPath,['-e',script],worktree,new AbortController().signal);
  if((await readFile(join(worktree,'allowed.txt'),'utf8'))!=='ok'||!result.stdout.includes('secret-read-denied; workspace-write-allowed'))throw new Error('Sandbox did not execute the verification command');
  console.log(result.stdout.trim());
}finally{await rm(worktree,{recursive:true,force:true});await rm(secret,{force:true});}
