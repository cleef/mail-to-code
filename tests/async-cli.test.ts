import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, symlink, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConfigSchema, configDir } from '../src/config.js';
import { AsyncStore, type Conversation } from '../src/async-store.js';
import { AsyncBridge, inputText, importLegacy, asyncPolicy, type Client } from '../src/async-cli.js';
import { AsyncTools } from '../src/async-tools.js';
import { denyInteractive, AppServer } from '../src/app-server.js';
import type { Incoming } from '../src/types.js';
import type { MailTransport } from '../src/delivery.js';
import { markdownHtml } from '../src/mail-markdown.js';
import { FinalMail } from '../src/final-mail.js';
import { GmailError } from '../src/mail-transport.js';
import { blockedMail, mailStatus } from '../src/mail-diagnostics.js';
import { execute } from '../src/process.js';
const incoming = (id: string, text = 'Implement the scoped feature'): Incoming => ({ id, threadId: 'gmail-1', rfcId: `<${id}@example.test>`, inReplyTo: '', subject: 'Synthetic feature', text, from: 'owner@example.test', trusted: true });
class FakeClient extends EventEmitter implements Client {
    calls: {
        method: string;
        params: any;
    }[] = [];
    closed = false;
    loseAck = false;
    loseHistory = false;
    finalReply?: string;
    constructor(readonly history: {
        thread: any;
    }, readonly complete = false) { super(); }
    async start() { }
    async close() { this.closed = true; }
    async request(method: string, params: any) {
        this.calls.push({ method, params });
        if (method === 'thread/start' || method === 'thread/resume')
            return { thread: this.history.thread };
        if (method === 'thread/read')
            return { thread: this.loseHistory ? { ...this.history.thread, turns: [] } : this.history.thread };
        if (method === 'turn/steer') {
            this.history.thread.turns.at(-1).items.push({ type: 'userMessage', content: params.input });
            return { turnId: params.expectedTurnId };
        }
        if (method === 'turn/start') {
            const turn = { id: 'turn-' + this.history.thread.turns.length, status: this.complete ? 'completed' : 'inProgress', items: [{ type: 'userMessage', content: params.input }] };
            this.history.thread.turns.push(turn);
            if (this.complete && this.finalReply) (turn.items as any[]).push({ id: 'reply-' + turn.id, type: 'agentMessage', phase: 'final_answer', text: this.finalReply });
            if (this.complete)
                queueMicrotask(() => this.emit('notification', 'turn/completed', { threadId: this.history.thread.id, turn }));
            if (this.loseAck) {
                this.loseAck = false;
                throw Error('APP_SERVER_ACK_UNCERTAIN:turn/start');
            }
            return { turn };
        }
        throw Error('Unexpected method ' + method);
    }
}
async function fixture(complete = false, finalMode = false) {
    const root = await mkdtemp(join(tmpdir(), 'async-test-')), config = ConfigSchema.parse({ ...(finalMode ? { engine: 'async-cli', asyncMailOutput: 'assistant-final' } : {}), gmailAddress: 'agent@example.test', ownerAddress: 'owner@example.test', dataDir: root, projectsRoot: join(root, 'projects') });
    await mkdir(config.projectsRoot);
    const store = new AsyncStore(join(root, 'async-cli.sqlite')), history = { thread: { id: 'codex-thread', turns: [] as any[] } }, clients: FakeClient[] = [], sends: any[] = [];
    const mail: MailTransport = { profile: async () => ({ emailAddress: config.gmailAddress, historyId: 'cursor' }), search: async () => [], read: async () => { throw Error('Unavailable'); }, send: async (input) => { sends.push(input); return { id: 'sent', threadId: 'gmail-1' }; } };
    const bridge = new AsyncBridge(config, store, mail, async () => { const c = new FakeClient(history, complete); if (finalMode) c.finalReply = '已完成修改，检查通过。可以查看 PR。'; clients.push(c); return c; }, undefined, root);
    return { root, config, store, history, clients, sends, mail, bridge };
}
test('configuration defaults to the async engine and projects root', () => { const c = ConfigSchema.parse({ gmailAddress: 'agent@example.test', ownerAddress: 'owner@example.test' }); assert.equal(c.engine, 'async-cli'); assert.equal(c.projectsRoot, '~/projects'); });
test('new body and complete quoted history reach the same session without a business output schema', async () => {
    const f = await fixture(), i = incoming('one'), c = f.store.intake(i, 'raw', 'Original body\n> quoted START is not new approval');
    await f.bridge.dispatch(c);
    const client = f.clients[0], start = client.calls.find(c => c.method === 'thread/start')!;
    assert.equal(start.params.cwd, f.config.projectsRoot);
    for (const name of ['input', 'notes', 'worktrees'])
        assert.ok((await stat(join(f.root, 'async-cli', 'features', c.id, name))).isDirectory());
    assert.ok(start.params.dynamicTools.some((t: any) => t.name === 'queue_mail'));
    assert.deepEqual(start.params.dynamicTools.map((t: any)=>t.name), ['queue_mail']);
    assert.ok(!('outputSchema' in client.calls.find(c => c.method === 'turn/start')!.params));
    const second = { ...incoming('two', '采用推荐方案；暂不合并和部署'), inReplyTo: i.rfcId };
    const routed = f.store.intake(second, 'raw', '采用推荐方案；暂不合并和部署');
    assert.equal(routed.id, c.id);
    await f.bridge.dispatch(routed);
    assert.equal(client.calls.filter(c => c.method === 'turn/start').length, 1);
    assert.equal(client.calls.filter(c => c.method === 'turn/steer').length, 1);
    assert.ok(JSON.stringify(client.calls).includes('quoted START'));
    assert.equal(f.store.mails().length, 0);
    await f.bridge.stop();
    f.store.close();
});
test('turn completion remains internal and reply resumes stored thread', async () => {
    const f = await fixture(true), c = f.store.intake(incoming('one'), 'raw', 'body');
    await f.bridge.dispatch(c);
    assert.equal(f.store.conversation(c.id)!.activeTurn, undefined);
    assert.equal(f.store.mails().length, 0);
    await f.bridge.pump();
    assert.equal(f.clients[0].closed, true);
    f.store.intake({ ...incoming('two'), inReplyTo: incoming('one').rfcId }, 'raw', 'body2');
    await f.bridge.dispatch(f.store.conversation(c.id)!);
    assert.ok(f.clients[1].calls.some(c => c.method === 'thread/resume'));
    assert.equal(f.sends.length, 0);
    await f.bridge.stop();
    f.store.close();
});

test('duplicate inbound message never starts a duplicate turn', async () => {
    const f = await fixture(), c = f.store.intake(incoming('one'), 'raw', 'body');
    await f.bridge.dispatch(c);
    f.store.intake(incoming('one'), 'raw', 'body');
    await f.bridge.dispatch(f.store.conversation(c.id)!);
    assert.equal(f.clients[0].calls.filter(c => c.method === 'turn/start').length, 1);
    await f.bridge.stop();
    f.store.close();
});
test('duplicate RFC identity is deduplicated and conflicting content is quarantinable', async () => {
    const f = await fixture(), i = incoming('one'), c = f.store.intake(i, 'raw', 'body');
    f.store.intake({ ...i, id: 'provider-copy' }, 'raw', 'body');
    assert.equal(f.store.inputs().filter(e => e.status === 'queued').length, 1);
    assert.throws(() => f.store.intake({ ...i, id: 'forged-copy', text: 'Different approval' }, 'raw', 'body'), /CONTENT_CONFLICT/);
    assert.equal(f.store.conversations().length, 1);
    f.store.close();
});
test('lost turn acknowledgement is reconciled from exact persisted input, without replay', async () => {
    const f = await fixture(), c = f.store.intake(incoming('one'), 'raw', 'body');
    const client = new FakeClient(f.history);
    client.loseAck = true;
    const bridge = new AsyncBridge(f.config, f.store, f.mail, async () => client);
    await assert.rejects(bridge.dispatch(c), /ACK_UNCERTAIN/);
    assert.equal(f.store.input('one')!.status, 'ambiguous');
    await bridge.stop();
    await f.bridge.dispatch(f.store.conversation(c.id)!);
    assert.equal(f.store.input('one')!.status, 'accepted');
    assert.equal(f.clients[0].calls.filter(c => c.method === 'turn/start').length, 0);
    assert.equal(f.store.conversation(c.id)!.activeTurn, 'turn-0');
    await f.bridge.stop();
    f.store.close();
});
test('unknown acknowledgement is an internal runtime issue, not another START email', async () => {
    const f = await fixture(), c = f.store.intake(incoming('one'), 'raw', 'body');
    c.codexThread = 'codex-thread';
    f.store.save(c);
    const e = f.store.input('one')!;
    e.status = 'ambiguous';
    f.store.saveInput(e);
    await f.bridge.dispatch(c);
    assert.match(f.store.conversation(c.id)!.error!, /OPERATOR_INSPECTION/);
    assert.equal(f.store.mails().length, 0);
    assert.equal(f.clients[0].calls.filter(c => c.method === 'turn/start').length, 0);
    await f.bridge.stop();
    f.store.close();
});
test('interrupted turn waits for new mail while preserving native session and historical records', async () => {
    const f = await fixture(), c = f.store.intake(incoming('one'), 'raw', 'body');
    c.codexThread = 'codex-thread';
    c.activeTurn = 'old';
    f.store.save(c);
    const e = f.store.input('one')!;
    e.status = 'accepted';
    f.store.saveInput(e);
    f.history.thread.turns.push({ id: 'old', status: 'interrupted', items: [] });
    f.store.put('scope', c.id, [{ path: '/synthetic/repo', role: 'modify', identity: 'sample/repo' }]);
    await f.bridge.dispatch(c);
    assert.equal(f.clients[0].calls.filter(c => c.method === 'turn/start').length, 0);
    assert.equal(f.store.conversation(c.id)!.error,'EXECUTION_INTERRUPTED_AWAITING_NEW_MAIL');
    f.store.intake({...incoming('next'),inReplyTo:incoming('one').rfcId},'','Continue');
    await f.bridge.dispatch(f.store.conversation(c.id)!);
    assert.equal(f.clients[0].calls.find(c => c.method === 'turn/start')!.params.threadId,'codex-thread');
    assert.equal(f.store.get<any[]>('scope', c.id)!.length, 1);
    assert.equal(f.store.mails().length, 0);
    await f.bridge.stop();
    f.store.close();
});
test('recovery holds unfinished or missing final replies without creating autonomous execution',async()=>{
    for(const status of ['failed','interrupted','missing','completed']) {
        const f=await fixture(false,true),c=f.store.intake(incoming('one'),'raw','body');
        await f.bridge.dispatch(c);await f.bridge.stop();
        const saved=f.store.conversation(c.id)!;delete saved.activeTurn;f.store.save(saved);
        if(status==='missing')f.history.thread.turns=[];else f.history.thread.turns[0].status=status;
        const client=new FakeClient(f.history),recovered=new AsyncBridge(f.config,f.store,f.mail,async()=>client,undefined,f.root);
        try {
            await recovered.dispatch(saved);await recovered.pump();
            assert.equal(client.calls.filter(call=>call.method==='turn/start').length,0,status);
            assert.equal(f.store.mails().length,0,status);
            assert.equal(new FinalMail(f.store).pending(saved).length,0,status);
            assert.equal(f.store.conversation(c.id)!.error,status==='completed'?'NATIVE_FINAL_REPLY_MISSING':'EXECUTION_INTERRUPTED_AWAITING_NEW_MAIL');
        } finally {await recovered.stop();f.store.close();}
    }
});
test('immutable outbox, deduplication and changed-key rejection', async () => {
    const f = await fixture(), c = f.store.intake(incoming('one'), 'raw', 'body'), a = f.store.queue(c, 'result', 'Result'), b = f.store.queue(c, 'result', 'Result');
    assert.equal(a.mail.id, b.mail.id);
    assert.throws(() => f.store.queue(c, 'result', 'Different'), /KEY_REUSED/);
    const m = { ...a.mail, text: 'edited' };
    assert.throws(() => f.store.saveMail(m), /IMMUTABLE/);
    f.store.close();
});
test('unknown send outcome is reconciled and never automatically resent after restart', async () => {
    const f = await fixture(), c = f.store.intake(incoming('one'), 'raw', 'body');
    f.store.queue(c, 'question', 'Specific question');
    f.mail.send = async () => { f.sends.push('attempt'); throw Error('Connection lost after send'); };
    await f.bridge.flush();
    await f.bridge.flush();
    assert.equal(f.sends.length, 1);
    assert.equal(f.store.mails()[0].status, 'uncertain');
    f.store.close();
});
test('send failure survives restart with private evidence; absence never requeues frozen mail', async () => {
    const f=await fixture(),c=f.store.intake(incoming('one'),'raw','body');
    const {mail:m}=f.store.queue(c,'result','Frozen result');
    m.replyMessageId='one';m.replyParentRfcId='<one@example.test>';m.replyQuoteHash='frozen-quote-hash';m.attachmentHashes=[];f.store.saveMail(m);
    f.mail.send=async()=>{f.sends.push('attempt');throw new GmailError(0,'MAIL_PLUGIN_CALL_UNCERTAIN_NO_AUTOMATIC_RETRY',{action:'send_email',reason:'timeout'},{cause:new Error('Synthetic provider detail: synthetic-private-value')});};
    await f.bridge.flush();
    let saved=f.store.mail(m.id)!;
    assert.equal(saved.status,'uncertain');assert.equal(saved.attempts,1);assert.equal(saved.sendDiagnostic?.transport?.reason,'timeout');
    const audit=f.store.get<any>('mail-error',saved.sendDiagnostic!.auditId);
    assert.match(JSON.stringify(audit),/synthetic-private-value/);assert.equal(JSON.stringify(mailStatus(saved)).includes('synthetic-private-value'),false);
    f.store.close();const reopened=new AsyncStore(join(f.root,'async-cli.sqlite')),bridge=new AsyncBridge(f.config,reopened,f.mail);
    try{
        await bridge.flush();saved=reopened.mail(m.id)!;
        assert.equal(saved.identityError,'DELIVERY_SENT_MESSAGE_NOT_FOUND');assert.equal(saved.status,'uncertain');assert.equal(f.sends.length,1);
        assert.equal(blockedMail(reopened.mails()).length,1);
        const before=JSON.stringify(reopened.all('mail-error'));
        assert.equal((await bridge.reconcileSend(m.id)).result,'absent');assert.equal(reopened.mail(m.id)!.status,'uncertain');
        assert.equal(JSON.stringify(reopened.all('mail-error')),before);
        const reset=await bridge.reconcileSend(m.id,true);assert.equal(reset.operatorReset,true);assert.equal(f.sends.length,1);
        const after=reopened.mail(m.id)!;assert.equal(after.status,'pending');assert.equal(after.text,m.text);assert.equal(after.deliveryMarker,m.deliveryMarker);assert.equal(after.attempts,1);assert.equal(after.lastError,undefined);
        for(const key of ['bodySnapshot','replyMessageId','replyParentRfcId','replyQuoteHash','attachmentHashes'] as const)assert.deepEqual(after[key],m[key]);
        assert.equal(reopened.all('send-audit').length,1);assert.equal(reopened.all('mail-error').length,1);
    }finally{await bridge.stop();reopened.close();}
});
test('successful send receipt survives read failure and restart without resend',async()=>{
    const f=await fixture(),c=f.store.intake(incoming('one'),'raw','body'),{mail:m}=f.store.queue(c,'result','Frozen');
    f.mail.read=async()=>{throw new GmailError(0,'MAIL_PLUGIN_TOOL_FAILED',{action:'read_email',reason:'tool_error'},{cause:'Synthetic read failure'});};
    await f.bridge.flush();let saved=f.store.mail(m.id)!;
    assert.equal(saved.status,'sent');assert.equal(saved.gmailId,'sent');assert.ok(saved.sentAt);assert.equal(saved.identityError,'DELIVERY_READ_PENDING');assert.equal(saved.identityDiagnostic?.transport?.action,'read_email');
    assert.equal(saved.lastError,undefined);assert.equal(f.sends.length,1);assert.equal(f.store.all('mail-error').length,1);
    f.store.close();const reopened=new AsyncStore(join(f.root,'async-cli.sqlite')),bridge=new AsyncBridge(f.config,reopened,f.mail);
    try{saved=reopened.mail(m.id)!;saved.identityCheckedAt='1970-01-01';reopened.saveMail(saved);await bridge.flush();assert.equal(f.sends.length,1);assert.equal(reopened.mail(m.id)!.status,'sent');assert.equal(reopened.all('mail-error').length,1);}finally{await bridge.stop();reopened.close();}
});
test('reconciliation distinguishes lookup failures, absence and ambiguity without replay',async()=>{
    const f=await fixture(),c=f.store.intake(incoming('one'),'raw','body'),{mail:m}=f.store.queue(c,'result','Frozen');
    m.status='uncertain';m.attempts=1;f.store.saveMail(m);
    f.mail.search=async()=>{throw new GmailError(0,'MAIL_PLUGIN_CALL_UNCERTAIN_NO_AUTOMATIC_RETRY',{action:'search_email_ids',reason:'disconnected'},{cause:new Error('Synthetic lookup detail')});};
    assert.equal((await f.bridge.reconcileSend(m.id,true)).result,'pending');let saved=f.store.mail(m.id)!;
    assert.equal(saved.identityError,'DELIVERY_SEARCH_PENDING');assert.equal(saved.identityDiagnostic?.transport?.reason,'disconnected');assert.equal(saved.status,'uncertain');assert.equal(f.store.all('mail-error').length,1);
    f.mail.search=async()=>Array.from({length:501},(_,n)=>({id:String(n)}));
    assert.equal((await f.bridge.reconcileSend(m.id,true)).result,'ambiguous');assert.equal(f.store.mail(m.id)!.identityError,'DELIVERY_SEARCH_AMBIGUOUS');
    f.mail.search=async()=>[{id:'unverified'}];
    assert.equal((await f.bridge.reconcileSend(m.id,true)).result,'pending');assert.equal(f.store.mail(m.id)!.identityError,'DELIVERY_CANDIDATES_UNVERIFIED');
    assert.equal(f.sends.length,0);assert.equal(f.store.all('send-audit').length,0);f.store.close();
});
test('reply preflight failure is visible without dispatching; interrupted historical sends remain blocked',async()=>{
    const f=await fixture(),c=f.store.intake(incoming('one'),'raw','body'),{mail:m}=f.store.queue(c,'result','Frozen');
    f.mail.prepareReply=async()=>{throw Error('Synthetic parent lookup failure');};await f.bridge.flush();
    assert.equal(f.sends.length,0);let saved=f.store.mail(m.id)!;assert.equal(saved.attempts,0);assert.equal(saved.sendDiagnostic?.phase,'prepare');assert.equal(saved.lastError,'MAIL_PREPARE_FAILED');assert.equal(blockedMail(f.store.mails()).length,1);
    saved.status='sending';saved.attempts=1;saved.lastError=undefined;saved.sendDiagnostic=undefined;f.store.saveMail(saved);await f.bridge.flush();
    saved=f.store.mail(m.id)!;assert.equal(saved.status,'uncertain');assert.equal(saved.lastError,'MAIL_SEND_INTERRUPTED_OUTCOME_UNKNOWN');assert.equal(saved.identityError,'DELIVERY_SENT_MESSAGE_NOT_FOUND');assert.equal(f.sends.length,0);f.store.close();
});
test('a late verified delivery clears active errors and retains the original failed attempt audit',async()=>{
    const f=await fixture(),c=f.store.intake(incoming('one'),'raw','body'),{mail:m}=f.store.queue(c,'result','Frozen');
    f.mail.send=async()=>{f.sends.push('attempt');throw Error('Synthetic acknowledgement loss');};await f.bridge.flush();
    f.mail.search=async()=>[{id:'delivered'}];
    f.mail.read=async()=>({id:'delivered',threadId:c.gmailThread,labelIds:['SENT'],raw:Buffer.from(`From: ${f.config.gmailAddress}\r\nTo: ${f.config.ownerAddress}\r\nSubject: ${c.subject}\r\nMessage-ID: <delivered@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${m.bodySnapshot?.text??m.text}\n\n[MAIL-REF: ${m.deliveryMarker}]`).toString('base64url')});
    assert.equal((await f.bridge.reconcileSend(m.id,true)).result,'verified');const saved=f.store.mail(m.id)!;
    assert.equal(saved.status,'sent');assert.equal(saved.identityStatus,'verified');assert.equal(saved.lastError,undefined);assert.equal(saved.sendDiagnostic,undefined);assert.equal(saved.rfcMessageId,'<delivered@example.test>');assert.equal(blockedMail(f.store.mails()).length,0);assert.equal(f.sends.length,1);assert.equal(f.store.all('send-audit').length,0);assert.equal(f.store.all('mail-error').length,1);f.store.close();
});
test('operator status and explicit private error inspection are read-only CLI paths',async()=>{
    const f=await fixture(),c=f.store.intake(incoming('one'),'raw','body'),{mail:m}=f.store.queue(c,'result','Frozen');
    f.mail.send=async()=>{throw new Error('Synthetic provider evidence: synthetic-private-value');};await f.bridge.flush();
    const directory=join(f.root,'config');await mkdir(directory,{mode:0o700});await writeFile(join(directory,'config.json'),JSON.stringify({...f.config,engine:'async-cli',controllerRepository:'synthetic/controller'}),{mode:0o600});
    const before=JSON.stringify(f.store.mails()),env={...process.env,MAIL_TO_CODE_CONFIG_DIR:directory},cli=join(process.cwd(),'dist/src/cli.js');
    const status=JSON.parse((await execute(process.execPath,[cli,'async-status'],{env})).stdout);
    assert.equal(status.outbox[0].lastError,'MAIL_SEND_FAILED');assert.equal(status.outbox[0].attempts,1);assert.equal(JSON.stringify(status).includes('synthetic-private-value'),false);
    const errors=JSON.parse((await execute(process.execPath,[cli,'async-mail-errors',m.id],{env})).stdout);
    assert.equal(errors.length,1);assert.match(JSON.stringify(errors),/synthetic-private-value/);assert.equal(JSON.stringify(f.store.mails()),before);f.store.close();
});
test('only root agent may send a mail or record grants', async () => {
    const f = await fixture(), c = f.store.intake(incoming('one'), 'raw', 'body');
    c.codexThread = 'primary';
    const tools = new AsyncTools(f.config, f.store, c, new AbortController().signal);
    await assert.rejects(tools.call('child', 'queue_mail', { key: 'x', text: 'Question' }), /PRIMARY_AGENT_ONLY/);
    assert.equal(f.store.mails().length, 0);
    f.store.close();
});
test('old state imports read-only and paused without restoring approval or replaying snapshots', async () => {
    const f = await fixture(), path = join(f.root, 'legacy.sqlite'), old = new DatabaseSync(path);
    old.exec('CREATE TABLE sessions(id TEXT,data TEXT);CREATE TABLE outbox(id TEXT,data TEXT);');
    const snapshot = '{"id":"old","text":"historical START","status":"pending"}';
    old.prepare('INSERT INTO sessions VALUES(?,?)').run('old', JSON.stringify({ id: 'old', subject: 'Historical', initialThreadId: 'old-thread', initialRfcId: '<old@example.test>', createdAt: 'old', workflow: { confirmed: true } }));
    old.prepare('INSERT INTO outbox VALUES(?,?)').run('notice', snapshot);
    old.close();
    const before = await readFile(path);
    const result = importLegacy(f.store, path);
    assert.equal(result.replayed, 0);
    assert.equal(result.restoredGrants, 0);
    assert.equal(f.store.conversation('old')!.paused, true);
    assert.equal(f.store.intake({ ...incoming('new-reply'), inReplyTo: '<old@example.test>' }, 'new MIME', 'new request').id, 'old');
    assert.equal(f.store.get('legacy-mail', 'notice'), snapshot);
    assert.equal(f.store.mails().length, 0);
    assert.deepEqual(await readFile(path), before);
    await f.bridge.pump();
    assert.equal(f.clients.length, 0);
    f.store.close();
});
test('native interactive requests decline permissions and never fabricate a human answer', () => {
    assert.deepEqual(denyInteractive({ id: 1, method: 'item/commandExecution/requestApproval', params: {} }), { decision: 'decline' });
    assert.deepEqual(denyInteractive({ id: 2, method: 'item/permissions/requestApproval', params: {} }), { permissions: {}, scope: 'turn' });
    assert.throws(() => denyInteractive({ id: 3, method: 'item/tool/requestUserInput', params: {} }), /ASYNCHRONOUS_CLIENT/);
});
test('runtime scheduler caps active primary conversations and an inspection exception does not occupy a slot', async () => {
    const f = await fixture(), clients: FakeClient[] = [];
    const bridge = new AsyncBridge(f.config, f.store, f.mail, async (c) => { const client = new FakeClient({ thread: { id: c.id, turns: [] } }); clients.push(client); return client; });
    for (let n = 0; n < 5; n++)
        f.store.intake({ ...incoming('parallel-' + n), threadId: 'parallel-thread-' + n }, 'raw', 'body');
    await bridge.pump();
    for (let n = 0; n < 100 && f.store.inputs().filter(e => e.status === 'accepted').length < 4; n++)
        await new Promise(r => setTimeout(r, 10));
    assert.equal(clients.length, 4);
    assert.equal(f.store.inputs().filter(e => e.status === 'queued').length, 1);
    const first = f.store.conversations()[0];
    first.error = 'INPUT_ACK_UNCERTAIN_OPERATOR_INSPECTION_REQUIRED';
    f.store.save(first);
    await bridge.pump();
    for (let n = 0; n < 100 && clients.length < 5; n++)
        await new Promise(r => setTimeout(r, 10));
    assert.equal(clients.find(client => client.history.thread.id === first.id)!.closed, true);
    assert.equal(clients.length, 5);
    await bridge.stop();
    f.store.close();
});
test('startup failure preserves queued input and retries it once in the same conversation', async () => {
    const f = await fixture(), c = f.store.intake(incoming('startup'), 'raw', 'body'), clients: FakeClient[] = [];
    const bridge = new AsyncBridge(f.config, f.store, f.mail, async () => {
        const client = new FakeClient(f.history);clients.push(client);
        if (clients.length === 1) client.request = async () => { throw Error('SYNTHETIC_SANDBOX_STARTUP_FAILURE'); };
        return client;
    });
    try {
        await assert.rejects(bridge.dispatch(c), /SYNTHETIC_SANDBOX_STARTUP_FAILURE/);
        assert.equal(f.store.input('startup')!.status, 'queued');
        assert.equal(f.store.conversation(c.id)!.codexThread, undefined);
        assert.equal(clients[0].closed, true);
        c.error = 'SYNTHETIC_SANDBOX_STARTUP_FAILURE';c.failures = 19;c.retryAt = Date.now();f.store.save(c);
        await bridge.dispatch(f.store.conversation(c.id)!);
        await bridge.dispatch(f.store.conversation(c.id)!);
        const current = f.store.conversation(c.id)!;
        assert.equal(current.codexThread, 'codex-thread');
        for (const key of ['error', 'failures', 'retryAt'] as const) assert.equal(current[key], undefined);
        assert.equal(f.store.input('startup')!.status, 'accepted');
        assert.equal(clients[1].calls.filter(c => c.method === 'turn/start').length, 1);
        assert.equal(f.store.mails().length, 0);
        assert.equal(f.sends.length, 0);
    } finally { await bridge.stop();f.store.close(); }
});
test('fresh same-subject mail starts a session; direct replies override provider grouping and older references', async () => {
    const f = await fixture(), a = f.store.intake(incoming('a'), 'raw', 'a'), b = f.store.intake(incoming('b'), 'raw', 'b');
    assert.notEqual(a.id, b.id);
    const reply = f.store.intake({ ...incoming('c'), threadId: 'another-provider-thread', inReplyTo: incoming('b').rfcId, references: [incoming('a').rfcId] }, 'raw', 'c');
    assert.equal(reply.id, b.id);
    assert.equal(f.store.conversations().length, 2);
    f.store.close();
});
test('nearest known reference resumes; unknown or conflicting identities are held for inspection', async () => {
    const f = await fixture(), a = f.store.intake(incoming('a'), 'raw', 'a'), b = f.store.intake(incoming('b'), 'raw', 'b');
    assert.equal(f.store.intake({ ...incoming('c'), references: [incoming('a').rfcId, incoming('b').rfcId, '<unknown@example.test>'] }, 'raw', 'c').id, b.id);
    assert.throws(() => f.store.intake({ ...incoming('d'), inReplyTo: '<missing@example.test>' }, 'raw', 'd'), /UNKNOWN_REPLY/);
    const m = f.store.queue(a, 'collision', 'Synthetic identity collision').mail;
    m.identityStatus = 'verified';
    m.rfcMessageId = incoming('b').rfcId;
    f.store.saveMail(m);
    assert.throws(() => f.store.intake({ ...incoming('e'), inReplyTo: incoming('b').rfcId }, 'raw', 'e'), /AMBIGUOUS/);
    assert.equal(f.store.input('d'), undefined);
    assert.equal(f.store.input('e'), undefined);
    f.store.close();
});
test('unresolved reply is quarantined without stalling other inbox messages or sending mail', async () => {
    const f = await fixture();
    const mime = (id: string, reply = '') => Buffer.from([
        'From: owner@example.test', 'To: agent@example.test', 'Subject: Synthetic feature',
        `Message-ID: <${id}@example.test>`, ...(reply ? [`In-Reply-To: ${reply}`] : []),
        'Authentication-Results: mx.google.com; dkim=pass; dmarc=pass header.from=example.test',
        '', 'Implement the scoped synthetic task'
    ].join('\r\n')).toString('base64url');
    f.store.meta('gmail_cursor', 'before');
    f.store.meta('mail_scan_baseline','1');f.mail.search = async () => [{id:'unknown'},{id:'fresh'}];
    f.mail.read = async (id) => ({ id, threadId: 'gmail-1', labelIds:[], raw: mime(id, id === 'unknown' ? '<missing@example.test>' : '') });
    await f.bridge.poll();
    assert.ok(f.store.get('quarantine', 'unknown'));
    assert.ok(f.store.input('fresh'));
    assert.equal(f.store.conversations().length, 1);
    assert.equal(f.store.meta('gmail_cursor'), 'before');assert.ok(f.store.meta('mail_scan_success'));
    assert.equal(f.store.mails().length, 0);
    f.store.close();
});
test('untrusted inbound messages cannot enter the runtime', async () => { const f = await fixture(); assert.throws(() => f.store.intake({ ...incoming('bad'), trusted: false }, 'raw', 'body'), /UNAUTHENTICATED/); f.store.close(); });
test('Markdown mail renders recommendations and tables without executable HTML or URLs', () => {
    const html = markdownHtml('**推荐私有**\n| 方案 | 影响 |\n| --- | --- |\n| 私有 | 主动分享 |\n<script>alert(1)</script>\n[evil](javascript:alert)\n[docs](https://example.test/path)');
    assert.ok(html.includes('<table'));
    assert.ok(html.includes('<strong>'));
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('href="javascript:'));
    assert.ok(html.includes('href="https://example.test/path"'));
});
test('actual stdio protocol initializes, handles dynamic server requests and closes cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'async-rpc-')), script = join(root, 'server.mjs');
    await writeFile(script, `import readline from 'node:readline';const lines=readline.createInterface({input:process.stdin});const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');lines.on('line',l=>{const m=JSON.parse(l);if(m.method==='initialize')send({id:m.id,result:{}});else if(m.method==='rpc-failure')send({id:m.id,error:{code:-32000,message:'Synthetic RPC rejection',data:{reason:'synthetic provider evidence'}}});else if(m.method==='probe'){send({id:'tool-call',method:'item/tool/call',params:{tool:'queue_mail'}});globalThis.pending=m.id;}else if(m.id==='tool-call')send({id:globalThis.pending,result:m.result});});`);
    // The fake command wrapper accepts the same CLI argument layout as Codex.
    const wrapper = join(root, 'fake-codex');
    await writeFile(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`, { mode: 0o700 });
    const actual = new AppServer(wrapper, [], root, async () => ({ success: true, contentItems: [{ type: 'inputText', text: 'queued' }] }));
    await actual.start();
    assert.equal((await actual.request('probe', {})).success, true);
    await assert.rejects(actual.request('rpc-failure',{}),(e:any)=>{assert.equal(e.rpcCode,-32000);assert.deepEqual(e.cause,{reason:'synthetic provider evidence'});return true;});
    await actual.close();
    await actual.close();
});

test('assistant-final forwards native wording once, skips historical turns and keeps delivery immutable', async () => {
    const f = await fixture(true, true);
    f.history.thread.turns.push({ id: 'historical', status: 'completed', items: [{ id: 'old-answer', type: 'agentMessage', phase: 'final_answer', text: 'Old answer must not be sent.' }] });
    const c = f.store.intake(incoming('final-one'), 'raw', 'body');
    await f.bridge.dispatch(c);
    assert.equal(f.store.mails().length, 1);
    const outbound = f.store.mails()[0];
    assert.equal(outbound.text, '已完成修改，检查通过。可以查看 PR。');
    new FinalMail(f.store).complete(c, f.history.thread.turns.at(-1));
    assert.equal(f.store.mails().length, 1);
    await f.bridge.stop();
    const restarted = new AsyncBridge(f.config, f.store, f.mail, f.bridge.factory, undefined, f.root);
    await restarted.dispatch(f.store.conversation(c.id)!);
    assert.equal(f.store.mails().length, 1);
    assert.equal(f.store.mail(outbound.id)!.text, outbound.text);
    await restarted.stop(); f.store.close();
});

test('streamed commentary is internal; multiple steered inputs get one completed native final', async () => {
    const f = await fixture(false, true), first = incoming('steer-one'), c = f.store.intake(first, 'raw', 'body');
    await f.bridge.dispatch(c);
    const client = f.clients[0], turn = f.history.thread.turns[0];
    client.emit('notification', 'item/completed', { threadId: c.codexThread, turnId: turn.id, item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Internal progress' } });
    f.store.intake({ ...incoming('steer-two', '补充：保留原布局'), inReplyTo: first.rfcId }, 'raw', 'body');
    await f.bridge.dispatch(f.store.conversation(c.id)!);
    assert.equal(f.store.mails().length, 0);
    turn.status = 'completed'; turn.items = [];
    client.emit('notification', 'item/completed', { threadId: c.codexThread, turnId: turn.id, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '已保留原布局并完成修改。' } });
    client.emit('notification', 'turn/completed', { threadId: c.codexThread, turn });
    assert.equal(f.store.mails().length, 1);
    assert.equal(f.store.mails()[0].text, '已保留原布局并完成修改。');
    assert.equal(client.calls.filter(x => x.method === 'turn/start').length, 1);
    assert.equal(client.calls.filter(x => x.method === 'turn/steer').length, 1);
    await f.bridge.stop(); f.store.close();
});

test('lost final-turn acknowledgement recovers its original reply without executing another turn', async () => {
    const f = await fixture(true, true), c = f.store.intake(incoming('lost-final'), '', 'body');
    const lost = new FakeClient(f.history, true); lost.loseAck = true; lost.finalReply = '原会话已完成。';
    const bridge = new AsyncBridge(f.config, f.store, f.mail, async () => lost, undefined, f.root);
    await assert.rejects(bridge.dispatch(c), /ACK_UNCERTAIN/); await bridge.stop();
    const resumed = new AsyncBridge(f.config, f.store, f.mail, f.bridge.factory, undefined, f.root);
    await resumed.dispatch(f.store.conversation(c.id)!);
    assert.equal(f.history.thread.turns.length, 1);
    assert.equal(f.store.mails().length, 1);
    assert.equal(f.store.mails()[0].text, '原会话已完成。');
    await resumed.stop(); f.store.close();
});

test('production guide-loading path excludes legacy START workflow and refreshes resumed-turn transport', async () => {
    const f = await fixture(false, true);
    await writeFile(join(f.root, 'AGENTS.md'), 'Legacy-only START policy', { mode: 0o600 });
    await writeFile(join(f.root, 'WORKFLOW.md'), 'Legacy-only Review policy', { mode: 0o600 });
    await writeFile(join(f.root, 'ASYNC_AGENTS.md'), 'Write concise natural replies. Preserve synthetic product convention.', { mode: 0o600 });
    const c = f.store.intake(incoming('guide-one'), '', 'body'); await f.bridge.dispatch(c);
    const options = f.clients[0].calls.find(x => x.method === 'thread/start')!.params;
    assert.match(options.developerInstructions, /Preserve synthetic product convention/);
    assert.ok(!options.developerInstructions.includes('Legacy-only'));
    assert.ok(!options.developerInstructions.includes('A final assistant message stays internal'));
    const input = f.clients[0].calls.find(x => x.method === 'turn/start')!.params.input[0].text;
    assert.match(input, /Current mail transport: assistant-final/);
    assert.match(input, /Merge and deployment require separate explicit user email confirmation/);
    await f.bridge.stop(); f.store.close();
});

test('final selection supports terminal legacy messages and native plans, excludes failed turns', async () => {
    const f = await fixture(false, true), c = f.store.intake(incoming('selection'), '', 'body'); await f.bridge.dispatch(c);
    const final = new FinalMail(f.store), id = f.history.thread.turns[0].id;
    final.complete(c, { id, status: 'failed', items: [{ id: 'partial', type: 'agentMessage', phase: 'final_answer', text: 'Partial must not be delivered' }] });
    assert.equal(f.store.mails().length, 0);
    final.complete(c, { id, status: 'completed', items: [{ id: 'legacy-reply', type: 'agentMessage', text: 'Older native final wording' }] });
    assert.equal(f.store.mails()[0].text, 'Older native final wording');
    f.store.put('final-turn', c.id + ':plan-turn', { rootTurn: 'plan-turn' });
    final.complete(c, { id: 'plan-turn', status: 'completed', items: [{ id: 'plan', type: 'plan', text: 'Native proposed plan' }] });
    assert.equal(f.store.mails()[1].text, 'Native proposed plan');
    await f.bridge.stop(); f.store.close();
});

test('restart fills a completed native reply after local turn bookkeeping without starting work again', async () => {
    const f = await fixture(false, true), c = f.store.intake(incoming('crash-final'), '', 'body');
    await f.bridge.dispatch(c);
    const turn = f.history.thread.turns[0];
    turn.status = 'completed'; turn.items.push({ id: 'crash-reply', type: 'agentMessage', phase: 'final_answer', text: '已完成，恢复后发送原答复。' });
    const current = f.store.conversation(c.id)!; current.activeTurn = undefined; f.store.save(current);
    await f.bridge.stop();
    assert.equal(new FinalMail(f.store).pending(current).length, 1);
    const resumed = new AsyncBridge(f.config, f.store, f.mail, f.bridge.factory, undefined, f.root);
    await resumed.dispatch(current);
    assert.equal(f.history.thread.turns.length, 1);
    assert.equal(f.store.mails()[0].text, '已完成，恢复后发送原答复。');
    await resumed.stop(); f.store.close();
});


test('old operation tools are inert in retained sessions; final-mode mail ignores legacy request fields', async()=>{
    const f=await fixture(false,true), c=f.store.intake(incoming('old'),'', 'body'); await f.bridge.dispatch(c);
    const current=f.store.conversation(c.id)!, tools=new AsyncTools(f.config,f.store,current,new AbortController().signal);
    assert.deepEqual(f.clients[0].calls.find(x=>x.method==='thread/start')!.params.dynamicTools,[]);
    for(const name of ['grant_scope','record_authorization','request_confirmation','workspace_command','project_worktree','project_command','project_checks','project_sync_base','project_pr','project_merge','project_deploy','project_operation','project_operations','project_operation_status']) {
        assert.equal((await tools.call(current.codexThread!,name,{executable:'must-not-execute',requestId:'old'} ) as any).error,'TOOL_RETIRED_USE_NATIVE');
    }
    await tools.call(current.codexThread!,'queue_mail',{key:'old',text:'ignored separate notice',request:{kind:'merge',target:{pr:1}}});
    assert.equal(f.store.mails().length,0); assert.equal(f.store.all('request').length,0); assert.equal(f.store.all('operation').length,0); assert.equal(f.store.all('scope').length,0);
    await f.bridge.stop();f.store.close();
});

test('mail merge/deploy dialogue reaches native session as ordinary input without program authorization',async()=>{
    const f=await fixture(true,true), i=incoming('review','Please review synthetic PR 7; do not merge or deploy.'), c=f.store.intake(i,'',i.text);
    await f.bridge.dispatch(c);
    for(const [id,text] of [['merge','Confirm merging synthetic PR 7 only. Do not deploy.'],['deploy','Confirm deploying the synthetic test target.']]) {
        f.store.intake({...incoming(id,text),inReplyTo:i.rfcId},'',text);await f.bridge.dispatch(f.store.conversation(c.id)!);
    }
    const inputs=f.clients.flatMap(c=>c.calls.filter(x=>x.method==='turn/start').map(x=>x.params.input[0].text));
    assert.equal(inputs.length,3);assert.match(inputs[1],/Confirm merging synthetic PR 7 only/);assert.match(inputs[2],/Confirm deploying the synthetic test target/);
    for(const input of inputs) assert.match(input,/not program-enforced gates/);
    assert.equal(f.store.all('request').length,0);assert.equal(f.store.all('operation').length,0);
    assert.equal(f.store.mails().length,3);await f.bridge.stop();f.store.close();
});

test('new contract and inert configuration refresh on resumed and steered mail without replay',async()=>{
    const f=await fixture(), c=f.store.intake(incoming('one'),'','body');await f.bridge.dispatch(c);await f.bridge.stop();f.history.thread.turns[0].status='completed';
    const fresh={...f.config,repositories:{sample:{path:f.config.projectsRoot,github:'example-org/sample',baseBranch:'main',mergeMethod:'merge' as const,checks:[],operations:{inspect:{description:'Synthetic inspection',target:'synthetic-target',effect:'read' as const,script:'/synthetic/inspect',args:[],timeoutSeconds:30}}}}};
    const bridge=new AsyncBridge(f.config,f.store,f.mail,f.bridge.factory,async()=>fresh, f.root);
    try {
        f.store.intake({...incoming('two'),inReplyTo:incoming('one').rfcId},'','body');await bridge.dispatch(f.store.conversation(c.id)!);
        f.store.intake({...incoming('three'),inReplyTo:incoming('one').rfcId},'','body');await bridge.dispatch(f.store.conversation(c.id)!);
        const client=f.clients.at(-1)!;assert.equal(client.calls.find(x=>x.method==='thread/resume')!.params.dynamicTools,undefined);
        for(const method of ['turn/start','turn/steer']) {const text=client.calls.find(x=>x.method===method)!.params.input[0].text;assert.match(text,/synthetic-target/);assert.match(text,/reference facts only/);assert.match(text,/supersedes older/);}
        assert.equal(f.store.all('operation').length,0);
    } finally {await bridge.stop();f.store.close();}
});

test('final output transaction survives rollback and queues a single immutable reply',async()=>{
    const f=await fixture(false,true),c=f.store.intake(incoming('atomic'),'','body');await f.bridge.dispatch(c);const final=new FinalMail(f.store),turn={id:f.history.thread.turns[0].id,status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:'Synthetic complete.'}]};
    assert.throws(()=>f.store.transaction(()=>{final.complete(c,turn);throw Error('rollback');}),/rollback/);assert.equal(f.store.mails().length,0);
    final.complete(c,turn);final.complete(c,turn);assert.equal(f.store.mails().length,1);assert.equal(final.pending(c).length,0);
    await f.bridge.stop();f.store.close();
});
