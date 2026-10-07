import { readFile, writeFile, rename, stat, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ConfigSchema, configDir, expand, privateFile } from './config.js';
import { acquireLease } from './lease.js';
import { execute } from './process.js';
export async function assertMailServicesStopped(){
    for(const unit of ['mail-to-code.service','mail-agent.service']){
        if(process.platform==='linux'){
            const active=await execute('systemctl',['--user','is-active',unit]).then(r=>r.stdout.trim(),e=>{const state=String(e.stdout||'').trim();if(!['inactive','failed','unknown'].includes(state))throw Error('MAIL_MIGRATION_SERVICE_STATUS_UNAVAILABLE');return state;});
            if(!['inactive','failed','unknown'].includes(active))throw Error('MAIL_MIGRATION_STOP_BOTH_SERVICES_FIRST');
        }
    }
}
export async function migrateMail(dryRun: boolean, checkStopped: () => Promise<void> = assertMailServicesStopped) {
    const path=join(configDir(),'config.json');await privateFile(path);
    const raw=JSON.parse(await readFile(path,'utf8')), next={...raw};delete next.oauthPort;
    next.mailCodexHome ||= join(configDir(),'codex-mail');
    const config=ConfigSchema.parse(next),dataDir=expand(config.dataDir);
    await checkStopped();
    // The same exclusive lease is used by both business engines and migration.
    const release=await acquireLease(dataDir);
    try{
        const plans:{name:string;table:string;baseline:number;success:number;existing:boolean;blockers:string[]}[]=[];
        for(const [name,table] of [['async-cli.sqlite','metadata'],['state.sqlite','meta']]){
            const file=join(dataDir,name);if(!(await stat(file).catch(()=>null)))continue;
            const db=new DatabaseSync(file,{readOnly:true});try{
                if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw Error('MAIL_MIGRATION_DATABASE_INTEGRITY');
                const get=(key:string)=>String(db.prepare(`SELECT value FROM ${table} WHERE key=?`).get(key)?.value||'');
                const existing=!!get('mail_scan_baseline');
                let baseline=Number(get('mail_scan_baseline')|| (name==='async-cli.sqlite'?Number(get('started_at'))*1000:get('gmail_last_success')) || Date.now());
                const blockers:string[]=[];
                if(name==='async-cli.sqlite'){
                    for(const row of db.prepare("SELECT kind,id,value FROM records WHERE kind IN ('conversation','operation','mail','input')").all()){
                        const r=JSON.parse(String(row.value));
                        if(row.kind==='input'&&['dispatching','ambiguous'].includes(r.status)||row.kind==='conversation'&&r.activeTurn||row.kind==='operation'&&['running','uncertain'].includes(r.status)||row.kind==='mail'&&(['sending','uncertain'].includes(r.status)||r.status==='sent'&&r.identityStatus!=='verified'))blockers.push(String(row.kind)+':'+String(row.id));
                    }
                }else{
                    for(const row of db.prepare("SELECT id,status,data FROM jobs WHERE status='running'").all())blockers.push('job:'+String(row.id));
                    for(const row of db.prepare("SELECT id,data FROM outbox").all()){const m=JSON.parse(String(row.data));if(['sending','uncertain'].includes(m.status)||m.status==='sent'&&m.identityStatus!=='verified')blockers.push('mail:'+String(row.id));}
                    const first=db.prepare('SELECT MIN(received_at) AS first FROM inbox').get()?.first;
                    if(!existing&&typeof first==='string'&&Number.isFinite(Date.parse(first)))baseline=Math.min(baseline,Date.parse(first));
                }
                if(!Number.isFinite(baseline)||baseline<=0||baseline>Date.now())throw Error('MAIL_MIGRATION_BASELINE_INVALID');
                plans.push({name,table,baseline,success:Number(get('mail_scan_success')||baseline),existing,blockers});
            }finally{db.close();}
        }
        const report={backup:undefined as string|undefined,dryRun,configChanged:JSON.stringify(next)!==JSON.stringify(raw),databases:plans.map(({name,baseline,existing,blockers})=>({name,baseline,alreadyMigrated:existing,blockers})),replayed:0,oauthCredentialsRemoved:false};
        if(dryRun)return report;
        if(plans.some(p=>p.blockers.length))throw Error('MAIL_MIGRATION_IN_FLIGHT_OR_UNCERTAIN_EFFECTS_RECONCILE_FIRST');
        const backup=join(dataDir,'backups','mail-plugin-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(backup,{recursive:true,mode:0o700});
        for(const plan of plans){
            const db=new DatabaseSync(join(dataDir,plan.name));try{
                db.prepare('VACUUM INTO ?').run(join(backup,plan.name));await chmod(join(backup,plan.name),0o600);
                db.exec('BEGIN IMMEDIATE');try{
                    const set=db.prepare(`INSERT INTO ${plan.table}(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
                    set.run('mail_transport','codex-gmail-plugin-v1');set.run('mail_scan_baseline',String(plan.baseline));set.run('mail_scan_success',String(plan.success));
                    // Existing full-scan checkpoints survive an idempotent rerun.
                    db.exec('COMMIT');
                }catch(e){db.exec('ROLLBACK');throw e;}
            }finally{db.close();}
        }
        await writeFile(join(backup,'config.json'),JSON.stringify(next,null,2)+'\n',{mode:0o600});
        const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600});await rename(temp,path);
        await writeFile(join(backup,'migration.json'),JSON.stringify(report,null,2),{mode:0o600});
        return {...report,backup};
    }finally{await release();}
}
