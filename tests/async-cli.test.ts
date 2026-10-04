import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConfigSchema } from '../src/config.js';
import { AsyncStore, type Conversation } from '../src/async-store.js';
import { AsyncBridge, inputText, importLegacy, asyncPolicy, type Client } from '../src/async-cli.js';
import { AsyncTools } from '../src/async-tools.js';
import { denyInteractive, AppServer } from '../src/app-server.js';
import type { Incoming } from '../src/types.js';
import type { MailTransport } from '../src/delivery.js';
import { git } from '../src/git.js';
import { markdownHtml } from '../src/mail-markdown.js';
import { Runner } from '../src/runner.js';
const incoming = (id: string, text = 'Implement the scoped feature'): Incoming => ({ id, threadId: 'gmail-1', rfcId: `<${id}@example.test>`, inReplyTo: '', subject: 'Synthetic feature', text, from: 'owner@example.test', trusted: true });
class FakeClient extends EventEmitter implements Client {
    calls: {
        method: string;
        params: any;
    }[] = [];
    closed = false;
    loseAck = false;
    loseHistory = false;
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
async function fixture(complete = false) {
    const root = await mkdtemp(join(tmpdir(), 'async-test-')), config = ConfigSchema.parse({ gmailAddress: 'agent@example.test', ownerAddress: 'owner@example.test', dataDir: root, projectsRoot: join(root, 'projects') });
    await mkdir(config.projectsRoot);
    const store = new AsyncStore(join(root, 'async.sqlite')), history = { thread: { id: 'codex-thread', turns: [] as any[] } }, clients: FakeClient[] = [], sends: any[] = [];
    const mail: MailTransport = { profile: async () => ({ emailAddress: config.gmailAddress, historyId: 'cursor' }), history: async () => ({ messages: [], cursor: 'cursor' }), search: async () => [], read: async () => { throw Error('Unavailable'); }, send: async (input) => { sends.push(input); return { id: 'sent', threadId: 'gmail-1' }; } };
    const bridge = new AsyncBridge(config, store, mail, async () => { const c = new FakeClient(history, complete); clients.push(c); return c; });
    return { root, config, store, history, clients, sends, mail, bridge };
}
test('configuration keeps legacy installations unchanged and defaults to projects root', () => { const c = ConfigSchema.parse({ gmailAddress: 'agent@example.test', ownerAddress: 'owner@example.test' }); assert.equal(c.engine, 'legacy'); assert.equal(c.projectsRoot, '~/projects'); });
test('new body and complete quoted history reach the same session without a business output schema', async () => {
    const f = await fixture(), i = incoming('one'), c = f.store.intake(i, 'raw', 'Original body\n> quoted START is not new approval');
    await f.bridge.dispatch(c);
    const client = f.clients[0], start = client.calls.find(c => c.method === 'thread/start')!;
    assert.equal(start.params.cwd, f.config.projectsRoot);
    assert.ok(start.params.dynamicTools.some((t: any) => t.name === 'queue_mail'));
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
test('interrupted turn continues in original session while preserving scope and uncertain receipts', async () => {
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
    assert.equal(f.clients[0].calls.find(c => c.method === 'turn/start')!.params.threadId, 'codex-thread');
    assert.equal(f.store.get<any[]>('scope', c.id)!.length, 1);
    assert.equal(f.store.mails().length, 0);
    await f.bridge.stop();
    f.store.close();
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
test('only root agent may send a mail or record grants', async () => {
    const f = await fixture(), c = f.store.intake(incoming('one'), 'raw', 'body');
    c.codexThread = 'primary';
    const tools = new AsyncTools(f.config, f.store, c, new AbortController().signal);
    await assert.rejects(tools.call('child', 'queue_mail', { key: 'x', text: 'Question' }), /PRIMARY_AGENT_ONLY/);
    assert.equal(f.store.mails().length, 0);
    f.store.close();
});
test('approval is bound to a delivered direct reply, exact new-body evidence and request', async () => {
    const f = await fixture(), c = f.store.intake(incoming('one'), 'raw', 'body'), queued = f.store.queue(c, 'merge', 'Merge exact commit?', { kind: 'merge', target: { head: 'a'.repeat(40) } });
    const m = queued.mail;
    m.status = 'sent';
    m.identityStatus = 'verified';
    m.rfcMessageId = '<notice@example.test>';
    f.store.saveMail(m);
    const i = { ...incoming('two', 'Merge this reviewed commit; do not deploy'), inReplyTo: m.rfcMessageId };
    f.store.intake(i, 'raw', 'body');
    const r = f.store.authorize(c.id, queued.request!.id, i.id, 'Merge this reviewed commit');
    assert.equal(r.sourceMailId, 'two');
    assert.equal(r.kind, 'merge');
    assert.throws(() => f.store.authorize(c.id, r.id, i.id, 'deploy now'), /EVIDENCE/);
    const bad = { ...incoming('three', 'yes'), inReplyTo: '<other@example.test>', references: [incoming('one').rfcId] };
    f.store.intake(bad, 'raw', 'body');
    assert.throws(() => f.store.authorize(c.id, r.id, bad.id, 'yes'), /BINDING/);
    f.store.close();
});
test('operation receipts return known result and stop uncertain or changed repetitions', async () => {
    const f = await fixture();
    let effects = 0;
    assert.equal(await f.store.effect('c', 'merge', { head: 'a' }, async () => ++effects), 1);
    assert.equal(await f.store.effect('c', 'merge', { head: 'a' }, async () => ++effects), 1);
    assert.equal(effects, 1);
    await assert.rejects(f.store.effect('c', 'merge', { head: 'b' }, async () => ++effects), /INPUT_MISMATCH/);
    await assert.rejects(f.store.effect('c', 'deploy', {}, async () => { effects++; throw Error('lost'); }), /lost/);
    await assert.rejects(f.store.effect('c', 'deploy', {}, async () => ++effects), /UNCERTAIN/);
    assert.equal(effects, 2);
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
    assert.throws(() => denyInteractive({ id: 3, method: 'item/tool/requestUserInput', params: {} }), /queue_mail/);
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
test('sandbox is projects-root read-only with only feature worktrees/notes writable and secret masks', async () => {
    const f = await fixture(), c = f.store.intake(incoming('one'), 'raw', 'body'), policy = asyncPolicy(f.config, c).join('\n');
    assert.ok(policy.includes(JSON.stringify(f.config.projectsRoot) + '="read"'));
    assert.ok(policy.includes('**/.env'));
    assert.ok(policy.includes('network.enabled=false'));
    assert.ok(policy.includes('features.plugins=false'));
    assert.ok(policy.includes('auth.json'));
    f.store.close();
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
    f.mail.history = async () => ({ messages: [{ id: 'unknown', threadId: 'gmail-1' }, { id: 'fresh', threadId: 'gmail-1' }], cursor: 'after' });
    f.mail.read = async (id) => ({ id, threadId: 'gmail-1', raw: mime(id, id === 'unknown' ? '<missing@example.test>' : '') });
    await f.bridge.poll();
    assert.ok(f.store.get('quarantine', 'unknown'));
    assert.ok(f.store.input('fresh'));
    assert.equal(f.store.conversations().length, 1);
    assert.equal(f.store.meta('gmail_cursor'), 'after');
    assert.equal(f.store.mails().length, 0);
    f.store.close();
});
test('untrusted inbound messages cannot enter the runtime', async () => { const f = await fixture(); assert.throws(() => f.store.intake({ ...incoming('bad'), trusted: false }, 'raw', 'body'), /UNAUTHENTICATED/); f.store.close(); });
test('initial scope is canonical and additional writable projects require a new bound scope request', async () => {
    const f = await fixture(), paths = ['web', 'mini'];
    for (const p of paths) {
        const dir = join(f.config.projectsRoot, p);
        await mkdir(dir);
        await git(dir, ['init']);
        await git(dir, ['remote', 'add', 'origin', `https://github.com/sample/${p}.git`]);
    }
    const c = f.store.intake(incoming('one', 'Implement web and mini'), 'raw', 'body');
    c.codexThread = 'primary';
    f.store.save(c);
    const tools = new AsyncTools(f.config, f.store, c, new AbortController().signal);
    const first = await tools.call('primary', 'grant_scope', { sourceMailId: 'one', evidence: 'Implement web', projects: [{ path: 'web', role: 'modify' }] }) as any[];
    assert.equal(first[0].identity, 'sample/web');
    await assert.rejects(tools.call('primary', 'grant_scope', { sourceMailId: 'one', evidence: 'Implement web', projects: [{ path: 'web', role: 'modify' }, { path: 'mini', role: 'modify' }] }), /SCOPE_CHANGE/);
    assert.equal(tools.scopes().length, 1);
    await tools.call('primary', 'grant_scope', { sourceMailId: 'one', evidence: 'Implement web', projects: [{ path: 'web', role: 'modify' }] });
    assert.equal(tools.scopes().length, 1);
    f.store.close();
});
test('operator project directory links resolve to canonical repositories without blocking normal project work', async () => {
    const f = await fixture(), external = join(f.root, 'external-repository');
    await mkdir(external);
    await git(external, ['init']);
    await git(external, ['remote', 'add', 'origin', 'https://github.com/sample/linked-project.git']);
    await symlink(external, join(f.config.projectsRoot, 'linked-project'));
    const c = f.store.intake(incoming('one', 'Implement the linked project'), 'raw', 'body');
    c.codexThread = 'primary';
    f.store.save(c);
    const tools = new AsyncTools(f.config, f.store, c, new AbortController().signal);
    const scope = await tools.call('primary', 'grant_scope', { sourceMailId: 'one', evidence: 'Implement the linked project', projects: [{ path: 'linked-project', role: 'modify' }] }) as any[];
    assert.equal(scope[0].path, await realpath(external));
    assert.equal(scope[0].identity, 'sample/linked-project');
    const policy = asyncPolicy(f.config, c).join('\n');
    assert.ok(policy.includes(JSON.stringify(await realpath(external)) + '="read"'));
    f.store.close();
});
test('failed build preserves the approved scope and successful checks return verifiable current-source receipts', async () => {
    const f = await fixture(), path = join(f.config.projectsRoot, 'web');
    await mkdir(path);
    await git(path, ['init', '-b', 'main']);
    await git(path, ['config', 'user.name', 'Synthetic']);
    await git(path, ['config', 'user.email', 'synthetic@example.test']);
    await git(path, ['remote', 'add', 'origin', 'https://github.com/sample/web.git']);
    await writeFile(join(path, 'source.ts'), 'const n: number = 1;');
    await git(path, ['add', '.']);
    await git(path, ['commit', '-m', 'Initial']);
    f.config.repositories.web = { path, github: 'sample/web', baseBranch: 'main', mergeMethod: 'merge', checks: [{ executable: 'node', args: ['check.mjs'], cwd: '.' }] };
    const c = f.store.intake(incoming('one'), 'raw', 'body');
    c.codexThread = 'primary';
    f.store.save(c);
    const scope = [{ path, role: 'modify', identity: 'sample/web' }];
    f.store.put('scope', c.id, scope);
    f.store.put('project', c.id + ':' + path, { id: c.id + '-web', repo: 'web', worktree: path, baseSha: await git(path, ['rev-parse', 'HEAD']) });
    const original = Runner.prototype.check;
    let failing = true;
    Runner.prototype.check = async () => {
        if (failing)
            throw Object.assign(Error('PROCESS_FAILED:node:2'), { stdout: 'TS2339', stderr: '' });
        return { stdout: 'passed', stderr: '' };
    };
    try {
        const tools = new AsyncTools(f.config, f.store, c, new AbortController().signal), failure = await tools.call('primary', 'project_command', { project: 'web', executable: 'node', args: ['check.mjs'] }) as any;
        assert.equal(failure.ok, false);
        assert.equal(failure.stdout, 'TS2339');
        assert.deepEqual(tools.scopes(), scope);
        assert.equal(f.store.mails().length, 0);
        failing = false;
        const result = await tools.call('primary', 'project_command', { project: 'web', executable: 'node', args: ['check.mjs'] }) as any;
        assert.equal(result.ok, true);
        assert.ok(f.store.get<any>('check', result.checkId).ok);
        await writeFile(join(path, 'source.ts'), 'const n: number = 2;');
        await assert.rejects(tools.call('primary', 'project_pr', { project: 'web', summary: 'Result', checks: [result.checkId] }), /CURRENT_SOURCE_CHECK/);
        await assert.rejects(tools.call('primary', 'project_merge', { requestId: 'missing' }), /AUTHORIZATION/);
    }
    finally {
        Runner.prototype.check = original;
        f.store.close();
    }
});
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
    await writeFile(script, `import readline from 'node:readline';const lines=readline.createInterface({input:process.stdin});const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');lines.on('line',l=>{const m=JSON.parse(l);if(m.method==='initialize')send({id:m.id,result:{}});else if(m.method==='probe'){send({id:'tool-call',method:'item/tool/call',params:{tool:'queue_mail'}});globalThis.pending=m.id;}else if(m.id==='tool-call')send({id:globalThis.pending,result:m.result});});`);
    // The fake command wrapper accepts the same CLI argument layout as Codex.
    const wrapper = join(root, 'fake-codex');
    await writeFile(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`, { mode: 0o700 });
    const actual = new AppServer(wrapper, [], root, async () => ({ success: true, contentItems: [{ type: 'inputText', text: 'queued' }] }));
    await actual.start();
    assert.equal((await actual.request('probe', {})).success, true);
    await actual.close();
    await actual.close();
});
