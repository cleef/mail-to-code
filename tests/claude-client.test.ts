import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeClient, claudeOptions, claudeEnvironment, type ClaudeRuntime } from '../src/claude-client.js';
import { ConfigSchema } from '../src/config.js';
import { AsyncStore } from '../src/async-store.js';
import { ASYNC_TOOLS, WORKSPACE_TOOL, AsyncTools } from '../src/async-tools.js';
import { AsyncBridge } from '../src/async-cli.js';
import { executorOf, sessionOf } from '../src/executor.js';
import type { Incoming } from '../src/types.js';
import type { MailTransport } from '../src/delivery.js';

const incoming = (id: string, subject = '[claude] Synthetic feature', inReplyTo = ''): Incoming => ({ id, threadId: 'mail', rfcId: `<${id}@example.test>`, inReplyTo, subject, text: 'Discuss the synthetic feature.', from: 'owner@example.test', trusted: true });
const inventory = [...ASYNC_TOOLS, WORKSPACE_TOOL].map(t => 'mcp__mail_to_code__' + t.name);
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'dual-executor-test-'));
    const config = ConfigSchema.parse({ engine: 'async-cli', asyncMailOutput: 'assistant-final', gmailAddress: 'agent@example.test', ownerAddress: 'owner@example.test', projectsRoot: join(root, 'projects'), dataDir: root });
    await mkdir(config.projectsRoot);
    const store = new AsyncStore(join(root, 'async-cli.sqlite'));
    return { root, config, store };
}
function fakeRuntime(options: { ack?: boolean; fail?: boolean; persist?: boolean; tools?: string[]; wait?: Promise<void> } = {}) {
    const calls: any[] = [], messages: any[] = [];
    const sdk: ClaudeRuntime = {
        environment: async () => ({}),
        messages: async () => messages,
        query: args => {
            calls.push(args);
            const session = args.options.resume || args.options.sessionId!;
            return {
                initializationResult: async () => ({ commands: [] }), close() {},
                async *[Symbol.asyncIterator]() {
                    yield { type: 'system', subtype: 'init', session_id: session, tools: options.tools || inventory };
                    const next = await args.prompt[Symbol.asyncIterator]().next();
                    const input = next.value;
                    if (options.persist !== false) messages.push(input);
                    if (options.ack !== false) yield input;
                    await options.wait;
                    if (options.fail) throw Error('Synthetic disconnect');
                    yield { type: 'assistant', session_id: session, uuid: randomUUID(), message: { content: [{ type: 'text', text: 'Internal progress is not mail.' }] } };
                    yield { type: 'result', subtype: 'success', session_id: session, uuid: randomUUID(), is_error: false, result: 'Synthetic final answer.' };
                },
            };
        },
    };
    return { sdk, calls, messages };
}
const noMail: MailTransport = { profile: async () => ({ emailAddress: 'agent@example.test', historyId: '0' }), search: async () => [], read: async () => { throw Error('No mail'); }, send: async () => { throw Error('No sends'); } };
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('new subjects select once; reply references, duplicates and old conversations retain their executor', async () => {
    const { store } = await fixture();
    try {
        for (const [subject, expected] of [['[claude] Task', 'claude'], [' [CLAUDE] Task', 'claude'], ['[codex] Task', 'codex'], ['Task', 'codex'], ['Re: [claude] Task', 'codex']]) {
            const i = incoming(randomUUID(), subject), c = store.intake(i, 'raw', i.text);
            assert.equal(executorOf(c), expected);
            const reply = store.intake(incoming(randomUUID(), expected === 'claude' ? '[codex] Different title' : '[claude] Different title', i.rfcId), 'reply', i.text);
            assert.equal(reply.id, c.id); assert.equal(executorOf(reply), expected);
            const duplicate = store.intake({ ...i, id: randomUUID(), subject: '[claude] changed grouping' }, 'raw', i.text);
            assert.equal(duplicate.id, c.id); assert.equal(executorOf(duplicate), expected);
            assert.throws(() => store.save({ ...c, executor: expected === 'claude' ? 'codex' : 'claude' }), /IMMUTABLE_TASK_EXECUTOR/);
        }
        const legacy = { id: 'old', subject: '[claude] Historical title', gmailThread: 'old-mail', codexThread: 'old-codex', createdAt: '2026-01-01' };
        store.save(legacy); assert.equal(executorOf(legacy), 'codex'); assert.equal(sessionOf(legacy), 'old-codex');
        assert.throws(() => store.save({ ...legacy, executor: 'claude' }), /IMMUTABLE_TASK_EXECUTOR/);
        assert.throws(() => store.save({ ...legacy, executorSession: 'different-session' }), /IMMUTABLE_EXECUTOR_SESSION/);
        assert.throws(() => store.intake(incoming('unknown', '[claude] New', '<unknown@example.test>'), 'raw', 'body'), /UNKNOWN_REPLY/);
    } finally { store.close(); }
});

test('both executors share exact delivered confirmation bindings and uncertain effect guards', async () => {
    const { config, store } = await fixture();
    try {
        for (const executor of ['codex', 'claude'] as const) {
            const i = incoming(executor, `[${executor}] Task`), c = store.intake(i, 'raw', i.text);
            c.executorSession = randomUUID(); store.save(c);
            const tools = new AsyncTools(config, store, c, new AbortController().signal);
            await assert.rejects(tools.call('foreign-session', 'grant_scope', {}), /PRIMARY_AGENT_ONLY/);
            await assert.rejects(tools.call(c.executorSession, 'project_merge', { requestId: 'missing' }));
            await assert.rejects(tools.call(c.executorSession, 'project_deploy', { requestId: 'missing' }));
            const { mail, request } = store.queue(c, 'merge', 'Review exact revision.', { kind: 'merge', target: { project: 'example', head: 'a'.repeat(40), base: 'b'.repeat(40), pr: 1 } });
            const reply = incoming(executor + '-reply', 'Re: task', '<delivered@example.test>'); reply.text = 'Merge this revision.';
            // Distinct delivered identities per task.
            mail.rfcMessageId = `<${executor}-delivered@example.test>`; mail.identityStatus = 'verified'; store.saveMail(mail);
            reply.inReplyTo = mail.rfcMessageId; store.intake(reply, 'raw', reply.text);
            assert.throws(() => store.authorize(c.id, request!.id, i.id, i.text), /BINDING/);
            assert.equal(store.authorize(c.id, request!.id, reply.id, reply.text).sourceMailId, reply.id);
            assert.throws(() => store.put('request', request!.id, { ...request, target: { head: 'changed' } }), /IMMUTABLE_CONFIRMATION_TARGET/);
            let attempts = 0;
            await assert.rejects(store.effect(c.id, 'uncertain', {}, async () => { attempts++; throw Error('uncertain'); }));
            await assert.rejects(store.effect(c.id, 'uncertain', {}, async () => { attempts++; }), /UNCERTAIN/);
            assert.equal(attempts, 1);
        }
    } finally { store.close(); }
});

test('Claude native tools/settings are disabled and only explicit bridge tools are allowed', async () => {
    const { config, store } = await fixture();
    try {
        const options = claudeOptions(config, '/synthetic/claude');
        assert.deepEqual(options.tools, []); assert.deepEqual(options.settingSources, []);
        assert.equal(options.strictMcpConfig, true); assert.equal(options.permissionMode, 'dontAsk');
        assert.equal(options.permissionPrompts, 'none'); assert.equal(options.env?.CLAUDE_CODE_SAFE_MODE, '1');
        assert.equal(options.env?.GITHUB_TOKEN, undefined); assert.equal(options.env?.ANTHROPIC_API_KEY, undefined);
        assert.deepEqual(options.allowedTools, inventory); assert.equal(options.persistSession, true);
    } finally { store.close(); }
});

test('Claude inherits only allowlisted model authentication values, never settings hooks or shell credentials', async () => {
    const { root, store } = await fixture();
    try {
        const path = join(root, 'settings.json');
        await writeFile(path, JSON.stringify({ hooks: { PreToolUse: 'must never execute' }, apiKeyHelper: 'must never execute', env: { ANTHROPIC_AUTH_TOKEN: 'synthetic-token', ANTHROPIC_BASE_URL: 'https://api.example.test', ANTHROPIC_MODEL: 'synthetic-model', GITHUB_TOKEN: 'synthetic-controller-secret', NODE_OPTIONS: '--require=untrusted', CLAUDE_CODE_SAFE_MODE: '0' } }), { mode: 0o600 });
        const env = await claudeEnvironment(path, { ANTHROPIC_MODEL: 'synthetic-override' });
        assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'synthetic-token'); assert.equal(env.ANTHROPIC_MODEL, 'synthetic-override');
        assert.equal(env.GITHUB_TOKEN, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.CLAUDE_CODE_SAFE_MODE, undefined);
        const link = join(root, 'linked-settings'); await symlink(path, link);
        await assert.rejects(claudeEnvironment(link, {}), /AUTH_SETTINGS_INVALID/);
        await writeFile(path, '{broken'); await assert.rejects(claudeEnvironment(path, {}), /AUTH_SETTINGS_INVALID/);
    } finally { store.close(); }
});

test('Claude final reply is immutable and resumes the same native session across bridge restarts', async () => {
    const { root, config, store } = await fixture(), native = fakeRuntime();
    const factory = async (c: any, handler: any) => new ClaudeClient(config, store, c, handler, native.sdk, async () => '/synthetic/claude');
    let bridge = new AsyncBridge(config, store, noMail, factory, undefined, root);
    try {
        const i = incoming('first'), c = store.intake(i, 'raw', i.text);
        await bridge.dispatch(c); await settle();
        assert.equal(store.mails().length, 1); assert.equal(store.mails()[0].text, 'Synthetic final answer.');
        assert.match(store.mails()[0].bodySnapshot!.text, /^Executor: Claude Code\n\nSynthetic final answer\./);
        assert.equal(store.conversation(c.id)!.subject, i.subject);
        const session = sessionOf(store.conversation(c.id)!); assert.ok(session); assert.equal(store.conversation(c.id)!.codexThread, undefined);
        assert.equal(native.calls[0].options.sessionId, session); assert.equal(native.calls[0].options.resume, undefined);
        await bridge.stop(); bridge = new AsyncBridge(config, store, noMail, factory, undefined, root);
        await bridge.dispatch(store.conversation(c.id)!); assert.equal(store.mails().length, 1);
        const reply = incoming('second', '[codex] changed title', i.rfcId); store.intake(reply, 'raw', reply.text);
        await bridge.dispatch(store.conversation(c.id)!); await settle();
        assert.equal(native.calls[1].options.resume, session); assert.equal(store.mails().length, 2);
        assert.equal(executorOf(store.conversation(c.id)!), 'claude');
        assert.ok(native.calls[1].options.systemPrompt.prompt.includes('primary Claude Code agent'));
    } finally { await bridge.stop(); store.close(); }
});

test('Claude queues follow-ups while busy without steering or dropping messages', async () => {
    const { root, config, store } = await fixture(); let release!: () => void;
    const native = fakeRuntime({ wait: new Promise<void>(resolve => { release = resolve; }) });
    const bridge = new AsyncBridge(config, store, noMail, async (c, handler) => new ClaudeClient(config, store, c, handler, native.sdk, async () => '/synthetic/claude'), undefined, root);
    try {
        const first = incoming('first'), c = store.intake(first, 'raw', first.text);
        await bridge.dispatch(c);
        const reply = incoming('second', 'Reply', first.rfcId); store.intake(reply, 'raw', reply.text);
        await bridge.dispatch(store.conversation(c.id)!);
        assert.equal(native.calls.length, 1); assert.equal(store.input('second')!.status, 'queued');
        release(); await settle(); await bridge.dispatch(store.conversation(c.id)!); await settle();
        assert.equal(native.calls.length, 2); assert.equal(store.input('second')!.status, 'accepted');
    } finally { release(); await bridge.stop(); store.close(); }
});

test('lost Claude acknowledgement reconciles native identity without replay; missing evidence stays ambiguous', async () => {
    for (const persist of [true, false]) {
        const { root, config, store } = await fixture(), native = fakeRuntime({ ack: false, fail: true, persist });
        const factory = async (c: any, handler: any) => new ClaudeClient(config, store, c, handler, native.sdk, async () => '/synthetic/claude');
        let bridge = new AsyncBridge(config, store, noMail, factory, undefined, root);
        try {
            const i = incoming('first'), c = store.intake(i, 'raw', i.text);
            await assert.rejects(bridge.dispatch(c), /ACK_UNCERTAIN/); await bridge.stop();
            const journal = store.all<any>('claude-turn')[0];
            // Simulate a durable completed result arriving before an acknowledgement
            // reaches the bridge; recovery must not run the input a second time.
            if (persist) { journal.turn.status = 'completed'; journal.turn.items.push({ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Recovered answer.' }); store.put('claude-turn', journal.turn.id, journal); }
            bridge = new AsyncBridge(config, store, noMail, factory, undefined, root);
            await bridge.dispatch(store.conversation(c.id)!);
            assert.equal(native.calls.length, 1);
            assert.equal(store.input('first')!.status, persist ? 'accepted' : 'ambiguous');
            const replies = store.mails().filter(m => m.text === 'Recovered answer.');
            assert.equal(replies.length, persist ? 1 : 0);
            assert.equal(store.mails().filter(m => m.text.includes('Claude Code is blocked')).length, 1);
            if (!persist) assert.match(store.conversation(c.id)!.error!, /OPERATOR_INSPECTION/);
        } finally { await bridge.stop(); store.close(); }
    }
});

test('unexpected native tools fail closed before accepting input', async () => {
    const { config, store } = await fixture(), native = fakeRuntime({ tools: [...inventory, 'Bash'] });
    const c = store.intake(incoming('first'), 'raw', 'body');
    const client = new ClaudeClient(config, store, c, async () => { throw Error('must not call tools'); }, native.sdk, async () => '/synthetic/claude');
    client.on('fault', () => {});
    try {
        await client.start(); const start = await client.request('thread/start', { developerInstructions: 'test' });
        await assert.rejects(client.request('turn/start', { threadId: start.thread.id, input: [{ type: 'text', text: 'test' }] }), /ACK_UNCERTAIN/);
        assert.equal(native.messages.length, 0);
    } finally { await client.close(); store.close(); }
});

test('interrupted accepted Claude work resumes without replaying mail or clearing grants and receipts', async () => {
    const { root, config, store } = await fixture();
    const interrupted = fakeRuntime({ fail: true }), recovered = fakeRuntime();
    const c = store.intake(incoming('first'), 'raw', 'body');
    store.put('scope', c.id, [{ path: '/synthetic/project', identity: 'example/project', role: 'modify' }]);
    store.put('operation', c.id + ':effect', { id: c.id + ':effect', conversationId: c.id, key: 'effect', status: 'uncertain', input: {} });
    let bridge = new AsyncBridge(config, store, noMail, async (c, handler) => new ClaudeClient(config, store, c, handler, interrupted.sdk, async () => '/synthetic/claude'), undefined, root);
    try {
        await bridge.dispatch(c); await settle(); await bridge.stop();
        recovered.messages.push(...interrupted.messages);
        bridge = new AsyncBridge(config, store, noMail, async (c, handler) => new ClaudeClient(config, store, c, handler, recovered.sdk, async () => '/synthetic/claude'), undefined, root);
        await bridge.dispatch(store.conversation(c.id)!); await settle();
        assert.equal(recovered.calls.length, 1);
        assert.match(recovered.messages.at(-1).message.content, /^Runtime reconnection/);
        assert.equal(store.inputs().length, 1); assert.equal(store.input('first')!.status, 'accepted');
        assert.equal(store.get<any[]>('scope', c.id)!.length, 1);
        assert.equal(store.get<any>('operation', c.id + ':effect')!.status, 'uncertain');
        assert.equal(store.mails().filter(m => m.text === 'Synthetic final answer.').length, 1);
    } finally { await bridge.stop(); store.close(); }
});

test('unavailable Claude produces one blocker and never changes to Codex or consumes input', async () => {
    const { root, config, store } = await fixture();
    const bridge = new AsyncBridge(config, store, noMail, async c => {
        assert.equal(executorOf(c), 'claude'); throw Error('CLAUDE_EXECUTABLE_UNAVAILABLE');
    }, undefined, root);
    try {
        const c = store.intake(incoming('first'), 'raw', 'body');
        await bridge.pump(); await settle();
        assert.equal(store.mails().length, 1); assert.equal(store.input('first')!.status, 'queued');
        const current = store.conversation(c.id)!; delete current.retryAt; store.save(current);
        await bridge.pump(); await settle();
        assert.equal(store.mails().length, 1); assert.equal(executorOf(store.conversation(c.id)!), 'claude');
        assert.equal(store.conversation(c.id)!.executorSession, undefined);
    } finally { await bridge.stop(); store.close(); }
});
