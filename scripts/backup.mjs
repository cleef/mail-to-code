import {DatabaseSync}from'node:sqlite';import{cp,mkdir,writeFile,chmod,stat}from'node:fs/promises';import{join}from'node:path';import{execFileSync,spawnSync}from'node:child_process';
import{loadConfig,configDir}from'../dist/src/config.js';import{acquireLease}from'../dist/src/lease.js';
process.umask(0o077);const c=await loadConfig();
for(const service of ['mail-to-code.service','mail-agent.service'])if(spawnSync('systemctl',['--user','is-active',service],{encoding:'utf8'}).stdout.trim()==='active')throw Error('Stop both controllers before backup');
const release=await acquireLease(c.dataDir);
try{
 const dir=join(c.dataDir,'backups','upgrade-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(dir,{recursive:true,mode:0o700});
 const db=new DatabaseSync(join(c.dataDir,'state.sqlite'),{readOnly:true});if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('SQLite integrity failed');db.prepare('VACUUM INTO ?').run(join(dir,'state.sqlite'));db.close();await chmod(join(dir,'state.sqlite'),0o600);
 await cp(configDir(),join(dir,'config'),{recursive:true,preserveTimestamps:true});
 for(const name of ['mail-to-code.service','mail-agent.service']){const path=join(process.env.HOME,'.config/systemd/user',name);if(await stat(path).catch(()=>null))await cp(path,join(dir,name));}
 await writeFile(join(dir,'release.json'),JSON.stringify({previous:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),next:process.argv[2],createdAt:new Date().toISOString(),dataDir:c.dataDir}),{mode:0o600});console.log('Consistent private upgrade backup: '+dir);
}finally{await release();}
