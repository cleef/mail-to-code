import { join } from 'node:path';
import { mkdir, stat, chmod } from 'node:fs/promises';
import { execute } from './process.js';
import { Store } from './store.js';
import { ProjectRegistry } from './projects.js';
import type { Config } from './config.js';
import {ensureWorkflow} from './workflow.js';
// A consistent SQLite snapshot includes WAL contents; copying state.sqlite alone does not.
export async function migrate(config: Config, store: Store, registry: ProjectRegistry, isActive: () => Promise<boolean> = async () => execute('systemctl', ['--user', 'is-active', 'mail-to-code.service','mail-agent.service'], { timeoutMs: 10000 }).then(r => r.stdout.split('\n').includes('active'), () => false)) {
    const active = await isActive();
    if (active)
        throw new Error('Stop mail-to-code.service before migration');
    const source=store.get('schema_version')||'1';
    if(source==='6')return {version:6,alreadyMigrated:true};
    if(['1','2'].includes(source))for(const s of store.sessions())if(!s.targets&&!s.system)await registry.resolve(s.repo);
    const directory = join(config.dataDir, 'backups');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const backup = join(directory, `v${source}-${Date.now()}.sqlite`);
    store.db.prepare('VACUUM INTO ?').run(backup);
    await chmod(backup, 0o600);
    await stat(backup);
    store.transaction(() => {
        store.db.exec('CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
        for(const old of store.sessions()){
            if(source==='5'){store.save(old);continue;}
            if(source==='4'){ensureWorkflow(old,true);store.save(old);continue;}
            if(source==='3'){ensureWorkflow(old,true);store.save(old);if(['WAITING_START','WAITING_REVIEW','MERGED'].includes(old.state))store.set('reply-recovery-required:'+old.id,'1');continue;} // Preserve current plans, tasks and approvals; delivery identity is backfilled separately.
            const oldState=old.state,oldBlocked=old.blockedPhase;
            const s=registry.migrateSession(old);
            if(source==='1'&&old.worktree&&oldBlocked!=='plan'&&['RUNNING','WAITING_INPUT','FAILED','QUEUED'].includes(oldState)){
                s.state=oldState;s.blockedPhase=oldBlocked;s.needsRefresh=undefined;
            }
            if(oldState==='WAITING_REVIEW'){s.needsRefresh='review';s.reviewNotice=undefined;s.state='QUEUED';}
            s.originalRequest ||= s.summary;s.references ||= [];
            // Development sessions keep their own worktree/thread; a root analysis uses a new thread.
            s.projectHints ||= (s.targets||[]).map(t=>t.path);
            if(['WAITING_START','PLANNING'].includes(s.state)){s.needsRefresh='plan';s.planNotice=undefined;s.state='QUEUED';}
            if(source==='2'&&s.state==='WAITING_REVIEW'){s.needsRefresh='review';s.reviewNotice=undefined;s.state='QUEUED';}
            ensureWorkflow(s,true);store.save(s);
        }
        store.set('schema_version','6');
        for (const s of store.sessions())
            if (s.needsRefresh) {
                for (const old of store.jobs().filter(j => j.sessionId === s.id && ['queued', 'running'].includes(j.status))) {
                    old.status = 'failed';
                    store.saveJob(old);
                }
                const kind = s.needsRefresh === 'plan' ? 'plan' : 'develop';
                if (!store.jobs().some(j => j.sessionId === s.id && ['queued', 'running'].includes(j.status)))
                    store.enqueue(s, kind, kind === 'plan' ? s.summary : '__REVALIDATE__');
                s.needsRefresh = undefined;
                store.save(s);
                store.notify(s, 'migration', '控制器已升级自然语言入口：旧待确认通知失效，将重新发送版本通知；开发会话、分支、SHA 和证据保留。');
            }
    });
    return {version:6,sourceVersion:source,backup};
}
