import {createPresentation} from './mail-presentation.js';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session, Job, JobKind, Outbound, Attachment, MailQuestion, ApprovalBinding } from './types.js';
import {createSummary} from './mail-summary.js';
import {approvalVersion} from './approval.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,rfc_id TEXT,thread_id TEXT,session_id TEXT,disposition TEXT,received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,event TEXT,data TEXT,created_at TEXT);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,session_id TEXT,data TEXT);
      CREATE INDEX IF NOT EXISTS job_status ON jobs(status); CREATE INDEX IF NOT EXISTS outbound_status ON outbox(status);`);
    const version=this.get('schema_version');
    if(version&&!['1','2','3','4','5','6','7'].includes(version)){this.db.close();throw new Error('Unsupported SQLite schema version; migration required');}
    if(!version)this.set('schema_version', '1');
  }
  migrate(map:(session:Session)=>Session) {
    if(this.get('schema_version')!=='1')return;
    this.transaction(()=>{this.db.exec('CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
      for(const session of this.sessions())this.save(map(session));this.set('schema_version','2');});
  }
  project<T>(id:string):T|undefined {if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get())return undefined;return this.read<T>('projects',id);}
  saveProject(id:string,data:unknown){this.db.prepare('INSERT INTO projects VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(data));}
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  get(key: string): string | undefined { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|undefined)?.value; }
  set(key: string, value: string) { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value); }
  session(id: string): Session | undefined { return this.read<Session>('sessions',id); }
  sessions(): Session[] { return this.all<Session>('sessions'); }
  save(session: Session) { this.db.prepare('INSERT INTO sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(session.id,JSON.stringify(session)); }
  private read<T>(table: string, id: string): T | undefined { const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as {data:string}|undefined; return row ? JSON.parse(row.data) : undefined; }
  private all<T>(table: string): T[] { return (this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as {data:string}[]).map(r=>JSON.parse(r.data)); }
  seen(id: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM inbox WHERE id=?').get(id)); }
  remember(id: string,rfc: string,thread: string,session: string|undefined,disposition: string) { this.db.prepare('INSERT INTO inbox VALUES(?,?,?,?,?,?)').run(id,rfc,thread,session??null,disposition,new Date().toISOString()); }
  inboundSession(rfc: string, thread: string): string | undefined {
    const row = this.db.prepare('SELECT session_id FROM inbox WHERE (rfc_id=? OR thread_id=?) AND session_id IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(rfc,thread) as {session_id:string}|undefined;
    return row?.session_id;
  }
  enqueue(session: Session,kind: JobKind,feedback: string): Job {
    const job: Job = {id:randomUUID(),sessionId:session.id,stageId:session.workflow?.stageId,kind,feedback,status:'queued'}; this.saveJob(job); return job;
  }
  saveJob(job: Job) { this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(job.id,job.sessionId,job.status,JSON.stringify(job)); }
  jobs(): Job[] { return this.all<Job>('jobs'); }
  recordProgress(session: Session,kind: string,text: string) {
    this.event(session.id,'notification_internal',{kind,text,stageId:session.workflow?.stageId,summary:createSummary(session)});
  }
  notify(session: Session,kind: string,text: string,attachments: Attachment[]=[],options?:{binding?:ApprovalBinding;preserveBinding?:boolean;questions?:Omit<MailQuestion,'id'>[]}): Outbound {
    const marker=randomUUID();
    const mail: Outbound = {id:`<${marker}@mail-to-code.local>`,deliveryMarker:marker,sessionId:session.id,stageId:session.workflow?.stageId,kind,text,attachments,status:'pending',createdAt:new Date().toISOString(),attempts:0};
    mail.summary=createSummary(session);
    const action=kind==='plan'?'START':kind==='review'?'APPROVE':kind==='merge'&&session.workflow?.proposal?.kind!=='documentation'?'DEPLOY':undefined;
    if(action){mail.approvalBinding={noticeId:mail.id,version:approvalVersion(session,action),action,stageId:session.workflow?.legacy?undefined:session.workflow?.stageId};mail.questions=[{id:mail.id+'/q1',kind:action==='DEPLOY'&&(session.targets?.length||0)>1?'choice':'confirm',text:action==='START'?'确认按本次方案实施':action==='APPROVE'?'确认合并本次 Review 的完整清单':'确认发布已合并版本（多项目请指定目标）',action,binding:mail.approvalBinding,dependsOn:[]}];}
    if(options){mail.approvalBinding=options.preserveBinding?mail.approvalBinding:options.binding;mail.questions=options.questions?.map((q,n)=>({...q,binding:q.action===mail.approvalBinding?.action?mail.approvalBinding:q.binding,id:mail.id+'/q'+(n+1)}));}
    if(mail.summary){mail.presentation=createPresentation(session,mail,text,this.mails().filter(m=>m.sessionId===session.id&&m.stageId===mail.stageId).at(-1)?.presentation);mail.text=mail.presentation.text;}
    this.saveMail(mail); return mail;
  }
  saveMail(mail: Outbound) { this.db.prepare('INSERT INTO outbox VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(mail.id,mail.sessionId,mail.status,JSON.stringify(mail)); }
  mail(id: string): Outbound|undefined { return this.read<Outbound>('outbox',id); }
  replyMail(id:string):Outbound|undefined {if(!id)return;const matches=this.mails().filter(m=>m.id===id||m.identityStatus==='verified'&&m.rfcMessageId===id);return matches.length===1?matches[0]:undefined;}
  mails(): Outbound[] { return this.all<Outbound>('outbox'); }
  event(id: string,event: string,data: unknown={}) { this.db.prepare('INSERT INTO events(session_id,event,data,created_at) VALUES(?,?,?,?)').run(id,event,JSON.stringify(data),new Date().toISOString()); }
  run(id: string,sessionId: string,data: unknown) { this.db.prepare('INSERT INTO runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id,sessionId,JSON.stringify(data)); }
  newId(now=new Date()): string {
    const date = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now).replaceAll('-','');
    const key=`sequence:${date}`, n=Number(this.get(key)||0)+1; this.set(key,String(n)); return `DEV-${date}-${String(n).padStart(3,'0')}`;
  }
  recover() {
    this.transaction(()=>{
      for(const job of this.jobs().filter(j=>j.status==='running')) {
        if(job.kind==='interpret'){job.status='queued';this.saveJob(job);continue;}
        const staged=this.session(job.sessionId)!;
        if(job.kind==='merge'&&staged.state==='MERGED'&&!staged.mergeUncertain&&!staged.partialMerge&&!!staged.targets?.length&&staged.targets.every(t=>t.mergeSha)){
          job.status='done';this.saveJob(job);
          if(!this.jobs().some(j=>j.sessionId===staged.id&&j.stageId===job.stageId&&j.kind==='interpret'&&j.reply?.mode==='outcome'&&['queued','running','done'].includes(j.status)&&j.reply?.candidate?.kind==='merge')){
            const observation=this.enqueue(staged,'interpret','理解已知合并结果');
            observation.reply={mode:'outcome',facts:[{code:'outcome',text:'服务重启前完整阶段已知合并成功；由 Codex 决定后续规划与沟通。'}],candidate:{kind:'merge',text:staged.summary,...(staged.workflow?.proposal?.kind!=='documentation'?{action:'DEPLOY' as const,version:approvalVersion(staged,'DEPLOY')}:{})},epoch:staged.cancellationEpoch,stageId:staged.workflow?.stageId,incoming:{id:observation.id,rfcId:'',inReplyTo:'',threadId:staged.initialThreadId,subject:staged.subject,text:'',from:'',trusted:true}};this.saveJob(observation);
          }
          this.event(staged.id,'stage_recovered');continue;
        }
        job.status='failed'; this.saveJob(job); const session=this.session(job.sessionId)!;
        this.run(job.id,session.id,{...this.read<Record<string,unknown>>('runs',job.id),status:'interrupted',finishedAt:new Date().toISOString()});
        if(session.state==='CANCELLED') continue;
        session.state='FAILED'; session.failedKind=job.kind; session.lastError='Service restarted during execution; reply RETRY after checking the result.';
        if(job.kind==='deploy'&&(session.deployUncertain||session.targets?.some(t=>t.deployUncertain))) { session.lastError='Deployment outcome is uncertain. Reconcile the production release before retrying.'; }
        this.save(session); this.notify(session,'failure',session.lastError); this.event(session.id,'interrupted',{kind:job.kind});
      }
      for(const mail of this.mails().filter(m=>m.status==='sending')) { mail.status='uncertain'; this.saveMail(mail); }
    });
  }
  close() { this.db.close(); }
}
