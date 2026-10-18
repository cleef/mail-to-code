import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session, Job, JobKind, Outbound } from './types.js';

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
  saveMail(mail: Outbound) { const previous=this.mail(mail.id);if(previous?.replyMessageId&&['replyMessageId','replyParentRfcId','replyQuoteHash','attachmentHashes'].some(key=>JSON.stringify((previous as any)[key])!==JSON.stringify((mail as any)[key])))throw Error('IMMUTABLE_REPLY_PARENT_SNAPSHOT');this.db.prepare('INSERT INTO outbox VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(mail.id,mail.sessionId,mail.status,JSON.stringify(mail)); }
  mail(id: string): Outbound|undefined { return this.read<Outbound>('outbox',id); }
  replyMail(id:string):Outbound|undefined {if(!id)return;const matches=this.mails().filter(m=>m.id===id||m.identityStatus==='verified'&&m.rfcMessageId===id);return matches.length===1?matches[0]:undefined;}
  mails(): Outbound[] { return this.all<Outbound>('outbox'); }
  event(id: string,event: string,data: unknown={}) { this.db.prepare('INSERT INTO events(session_id,event,data,created_at) VALUES(?,?,?,?)').run(id,event,JSON.stringify(data),new Date().toISOString()); }
  run(id: string,sessionId: string,data: unknown) { this.db.prepare('INSERT INTO runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id,sessionId,JSON.stringify(data)); }
  newId(now=new Date()): string {
    const date = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now).replaceAll('-','');
    const key=`sequence:${date}`, n=Number(this.get(key)||0)+1; this.set(key,String(n)); return `DEV-${date}-${String(n).padStart(3,'0')}`;
  }
  close() { this.db.close(); }
}
