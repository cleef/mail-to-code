import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Incoming, Outbound } from './types.js';
export interface Conversation {
    id: string;
    subject: string;
    gmailThread: string;
    codexThread?: string;
    activeTurn?: string;
    paused?: boolean;
    error?: string;
    createdAt: string;
    retryAt?: number;
    failures?: number;
}
export interface InputEvent {
    id: string;
    conversationId: string;
    incoming: Incoming;
    raw: string;
    fullText: string;
    status: 'queued' | 'dispatching' | 'accepted' | 'ambiguous';
    turnId?: string;
    attachments?: {
        filename: string;
        contentType: string;
        path: string;
        size: number;
    }[];
}
export interface ApprovalRequest {
    id: string;
    conversationId: string;
    mailId: string;
    kind: 'scope' | 'merge' | 'deploy';
    target: unknown;
    sourceMailId?: string;
    evidence?: string;
}
export interface Operation {
    id: string;
    conversationId: string;
    key: string;
    input: unknown;
    status: 'running' | 'done' | 'uncertain';
    result?: unknown;
    report?: import('./operation-report.js').OperationReport;
}
// This database stores transport/runtime facts. Business progress lives in FEATURE.md.
export class AsyncStore {
    readonly db: DatabaseSync;
    private transactionDepth = 0;
    constructor(path: string, readOnly = false) {
        this.db = new DatabaseSync(path, { readOnly });
        if (readOnly) {
            this.db.exec('PRAGMA busy_timeout=5000');
            return;
        }
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    }
    close() { this.db.close(); }
    transaction<T>(fn: () => T): T {
        const depth = this.transactionDepth++, savepoint = 'async_nested_' + depth;
        try { this.db.exec(depth ? 'SAVEPOINT ' + savepoint : 'BEGIN IMMEDIATE'); }
        catch (error) { this.transactionDepth--; throw error; }
        try {
            const result = fn();
            this.db.exec(depth ? 'RELEASE SAVEPOINT ' + savepoint : 'COMMIT');
            return result;
        }
        catch (e) {
            this.db.exec(depth ? 'ROLLBACK TO SAVEPOINT ' + savepoint : 'ROLLBACK');
            if (depth) this.db.exec('RELEASE SAVEPOINT ' + savepoint);
            throw e;
        }
        finally { this.transactionDepth--; }
    }
    get<T>(kind: string, id: string): T | undefined {
        const r = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id) as {
            value: string;
        } | undefined;
        return r ? JSON.parse(r.value) : undefined;
    }
    all<T>(kind: string): T[] {
        return (this.db.prepare('SELECT value FROM records WHERE kind=? ORDER BY rowid').all(kind) as {
            value: string;
        }[]).map(r => JSON.parse(r.value));
    }
    put(kind: string, id: string, value: unknown) { this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind, id, JSON.stringify(value)); }
    remove(kind: string, id: string) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
    meta(key: string, value?: string) {
        if (value !== undefined)
            this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
        return (this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as {
            value: string;
        } | undefined)?.value;
    }
    conversation(id: string) { return this.get<Conversation>('conversation', id); }
    conversations() { return this.all<Conversation>('conversation'); }
    save(c: Conversation) { this.put('conversation', c.id, c); }
    input(id: string) { return this.get<InputEvent>('input', id); }
    inputs() { return this.all<InputEvent>('input'); }
    saveInput(e: InputEvent) { this.put('input', e.id, e); }
    requeueInput(id: string) {
        const e = this.input(id);
        if (!e || e.status !== 'ambiguous')
            throw Error('AMBIGUOUS_INPUT_REQUIRED');
        this.put('input-audit', id + ':' + Date.now(), e);
        e.status = 'queued';
        this.saveInput(e);
        const c = this.conversation(e.conversationId)!;
        delete c.error;
        delete c.retryAt;
        delete c.failures;
        this.save(c);
        return { id, operatorVerifiedNotAccepted: true, replayed: false };
    }
    mail(id: string) { return this.get<Outbound>('mail', id); }
    mails() { return this.all<Outbound>('mail'); }
    saveMail(m: Outbound) {
        const previous = this.mail(m.id);
        if (previous && (previous.text !== m.text || JSON.stringify(previous.attachments) !== JSON.stringify(m.attachments)))
            throw Error('IMMUTABLE_MAIL_SNAPSHOT');
        this.put('mail', m.id, m);
    }
    route(i: Incoming): Conversation | undefined {
        const refs = [i.inReplyTo, ...(i.references || []).slice().reverse()].filter(Boolean);
        // A fresh message starts a new session, even if Gmail groups equal subjects.
        if (!refs.length)
            return undefined;
        const inputs = this.inputs(), mails = this.mails();
        const imported = this.all<{
            rfcId: string;
            conversationId: string;
        }>('mail-identity');
        // Prefer the direct parent, then the nearest known ancestor. Never combine
        // provider grouping or all ancestors into a semantic task/scope decision.
        for (const ref of refs) {
            const identities = new Set<string>();
            for (const e of inputs)
                if (e.incoming.rfcId === ref)
                    identities.add(e.conversationId);
            for (const m of mails)
                if (m.identityStatus === 'verified' && m.rfcMessageId === ref)
                    identities.add(m.sessionId);
            for (const identity of imported)
                if (identity.rfcId === ref)
                    identities.add(identity.conversationId);
            if (identities.size > 1)
                throw Error('AMBIGUOUS_CONVERSATION_IDENTITY');
            if (identities.size)
                return this.conversation([...identities][0]);
        }
        throw Error('UNKNOWN_REPLY_CONVERSATION_IDENTITY');
    }
    intake(incoming: Incoming, raw: string, fullText: string) {
        if (!incoming.trusted)
            throw Error('UNAUTHENTICATED_INPUT');
        if (this.input(incoming.id))
            return this.conversation(this.input(incoming.id)!.conversationId)!;
        const duplicate = incoming.rfcId ? this.inputs().find(e => e.incoming.rfcId === incoming.rfcId) : undefined;
        if (duplicate) {
            if (duplicate.incoming.text !== incoming.text || duplicate.fullText !== fullText)
                throw Error('RFC_MESSAGE_ID_CONTENT_CONFLICT');
            this.saveInput({ ...duplicate, id: incoming.id, incoming, raw, status: 'accepted' });
            return this.conversation(duplicate.conversationId)!;
        }
        return this.transaction(() => {
            const c = this.route(incoming) || { id: randomUUID(), subject: incoming.subject, gmailThread: incoming.threadId, createdAt: new Date().toISOString() };
            this.save(c);
            this.saveInput({ id: incoming.id, conversationId: c.id, incoming, raw, fullText, status: 'queued' });
            return c;
        });
    }
    queue(c: Conversation, key: string, text: string, request?: Omit<ApprovalRequest, 'id' | 'conversationId' | 'mailId'>, preparedId?: string) {
        return this.transaction(() => {
            const dedupId = c.id + ':' + key, existingId = this.get<string>('mail-key', dedupId);
            if (existingId) {
                const old = this.mail(existingId)!;
                if (old.text !== text || JSON.stringify(this.get('mail-request', old.id)) !== JSON.stringify(request || null))
                    throw Error('MAIL_KEY_REUSED_WITH_DIFFERENT_CONTENT');
                return { mail: old, request: this.all<ApprovalRequest>('request').find(r => r.mailId === old.id) };
            }
            const id = randomUUID(), mail: Outbound = { id, sessionId: c.id, kind: 'agent', text, attachments: [], status: 'pending', createdAt: new Date().toISOString(), attempts: 0, deliveryMarker: id };
            this.saveMail(mail);
            this.put('mail-key', dedupId, id);
            this.put('mail-request', id, request || null);
            const r = request ? { ...request, id: preparedId || randomUUID(), conversationId: c.id, mailId: id } : undefined;
            if (r)
                this.put('request', r.id, r);
            return { mail, request: r };
        });
    }
    prepareConfirmation(c: Conversation, turnId: string, key: string, proposed: Pick<ApprovalRequest, 'kind' | 'target'>) {
        if (!turnId) throw Error('ACTIVE_TURN_REQUIRED');
        return this.transaction(() => {
            const id = c.id + ':' + turnId, previous = this.get<{ key: string; requestId: string }>('turn-confirmation', id);
            if (previous) {
                const request = this.get<ApprovalRequest>('request', previous.requestId)!;
                if (JSON.stringify({ kind: request.kind, target: request.target }) !== JSON.stringify(proposed)) throw Error('TURN_CONFIRMATION_TARGET_CHANGED');
                return request;
            }
            const request: ApprovalRequest = { ...proposed, id: randomUUID(), conversationId: c.id, mailId: '' };
            this.put('request', request.id, request);
            this.put('turn-confirmation', id, { key, requestId: request.id });
            return request;
        });
    }
    queueFinal(c: Conversation, turnId: string, text: string, itemIds: string[]) {
        return this.transaction(() => {
            const id = c.id + ':' + turnId;
            const existing = this.get<{ mailId: string }>('turn-output', id);
            if (existing) return this.mail(existing.mailId)!;
            const prepared = this.get<{ requestId: string }>('turn-confirmation', id);
            const request = prepared ? this.get<ApprovalRequest>('request', prepared.requestId)! : undefined;
            const queued = this.queue(c, 'assistant-final:' + turnId, text, request ? { kind: request.kind, target: request.target } : undefined, request?.id);
            this.put('turn-output', id, { turnId, itemIds, mailId: queued.mail.id });
            return queued.mail;
        });
    }
    authorize(conversationId: string, requestId: string, sourceMailId: string, evidence: string) {
        const r = this.get<ApprovalRequest>('request', requestId), e = this.input(sourceMailId);
        if (!r || r.conversationId !== conversationId || !e || e.conversationId !== conversationId || !e.incoming.trusted)
            throw Error('APPROVAL_SOURCE_MISMATCH');
        const m = this.mail(r.mailId)!;
        if (!m || m.identityStatus !== 'verified' || !m.rfcMessageId || e.incoming.inReplyTo !== m.rfcMessageId)
            throw Error('APPROVAL_REPLY_BINDING_REQUIRED');
        if (!evidence.trim() || !e.incoming.text.includes(evidence))
            throw Error('APPROVAL_EVIDENCE_NOT_IN_NEW_BODY');
        if (r.sourceMailId && r.sourceMailId !== sourceMailId)
            throw Error('APPROVAL_ALREADY_RECORDED');
        r.sourceMailId = sourceMailId;
        r.evidence = evidence;
        this.put('request', r.id, r);
        return r;
    }
    async effect<T>(conversationId: string, key: string, input: unknown, fn: () => Promise<T>): Promise<T> {
        const id = conversationId + ':' + key, existing = this.get<Operation>('operation', id);
        if (existing) {
            if (JSON.stringify(existing.input) !== JSON.stringify(input))
                throw Error('OPERATION_KEY_INPUT_MISMATCH');
            if (existing.status === 'done')
                return existing.result as T;
            throw Error('OPERATION_UNCERTAIN_RECONCILE_BEFORE_RETRY');
        }
        const op: Operation = { id, conversationId, key, input, status: 'running' };
        this.put('operation', id, op);
        try {
            const result = await fn();
            Object.assign(op, this.get<Operation>('operation', id));
            op.status = 'done';
            op.result = result;
            this.put('operation', id, op);
            return result;
        }
        catch (e) {
            Object.assign(op, this.get<Operation>('operation', id));
            op.status = 'uncertain';
            this.put('operation', id, op);
            throw e;
        }
    }
}
