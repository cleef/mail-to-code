import { DatabaseSync } from 'node:sqlite';
import { cp,mkdir,writeFile,chmod,stat } from 'node:fs/promises';
import {join,basename} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {loadConfig,configDir} from '../dist/src/config.js';
import {acquireLease} from '../dist/src/lease.js';
process.umask(0o077);const c=await loadConfig(true);
for(const service of ['mail-to-code.service','mail-agent.service'])if(spawnSync('systemctl',['--user','is-active',service],{encoding:'utf8'}).stdout?.trim()==='active')throw Error('Stop both controllers before backup');
const release=await acquireLease(c.dataDir);
try{
 const dir=join(c.dataDir,'backups','upgrade-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(dir,{recursive:true,mode:0o700});
 for(const name of ['state.sqlite','async-cli.sqlite']){
  const path=join(c.dataDir,name);if(!(await stat(path).catch(()=>null)))continue;
  const db=new DatabaseSync(path,{readOnly:true});try{if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('SQLite integrity failed');db.prepare('VACUUM INTO ?').run(join(dir,name));}finally{db.close();}await chmod(join(dir,name),0o600);
 }
 // Never create another copy of the retired Google client or refresh token.
 await cp(configDir(),join(dir,'config'),{recursive:true,preserveTimestamps:true,filter:path=>!['codex-mail','oauth-client.json','token.json'].includes(basename(path))&&!/^(oauth-client|token)\.json\./.test(basename(path))});
 const {readFile}=await import('node:fs/promises');const raw=JSON.parse(await readFile(join(configDir(),'config.json'),'utf8'));delete raw.oauthPort;await writeFile(join(dir,'config/config.json'),JSON.stringify(raw,null,2)+'\n',{mode:0o600});
 for(const name of ['mail-to-code.service','mail-agent.service']){const path=join(process.env.HOME,'.config/systemd/user',name);if(await stat(path).catch(()=>null))await cp(path,join(dir,name));}
 await writeFile(join(dir,'release.json'),JSON.stringify({previous:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),next:process.argv[2],createdAt:new Date().toISOString(),dataDir:c.dataDir,transport:'codex-gmail-plugin-only',databaseRestoreAllowed:false}),{mode:0o600});console.log('Consistent private upgrade backup: '+dir);
}finally{await release();}
