import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectGmailPlugin } from '../src/gmail-plugin-readiness.js';
import type { Rpc } from '../src/app-server.js';

function fixture(options: { login?: boolean; connected?: boolean; direct?: boolean; address?: string } = {}) {
    const calls: { method: string; params: any }[] = [];
    const names = ['get_profile', 'search_email_ids', 'read_email', 'send_email'];
    const rpc: Rpc = { close: async () => {}, request: async (method, params: any) => {
        calls.push({ method, params });
        if (method === 'account/read') return { account: { type: options.login === false ? 'apiKey' : 'chatgpt' } };
        if (method === 'app/installed') return { apps: options.connected === false ? [] : [{ id: 'synthetic-gmail', runtimeName: 'Gmail', enabled: true, callable: true }] };
        if (method === 'app/read') return { apps: [{ id: 'synthetic-gmail', toolSummaries: names.map(name => ({ name, isEnabled: true })) }] };
        if (method === 'thread/start') return { thread: { id: 'ephemeral-probe' } };
        if (method === 'mcpServerStatus/list') return { data: [{ name: 'synthetic-apps', tools: Object.fromEntries(names.map(name => ['gmail.' + name, { name: 'gmail.' + name,inputSchema:{properties:name==='get_profile'?{}:name==='search_email_ids'?{query:{},max_results:{},next_page_token:{}}:name==='read_email'?{message_id:{},format:{enum:['raw']}}:{to:{},subject:{},payload:{},reply_message_id:{}}} }])) }], nextCursor: null };
        if (method === 'mcpServer/tool/call') {
            if (options.direct === false) throw Error('unknown MCP server; private details must not escape');
            return { structuredContent: { email: options.address || 'agent@example.test' } };
        }
        throw Error('Unexpected RPC: ' + method);
    } };
    return { rpc, calls };
}

test('API-key login or missing Gmail connection stops before thread/tool calls', async () => {
    for (const options of [{ login: false }, { connected: false }]) {
        const f = fixture(options), r = await inspectGmailPlugin(f.rpc, 'agent@example.test');
        assert.equal(r.ok, false);
        assert.equal(f.calls.some(c => c.method === 'thread/start' || c.method === 'mcpServer/tool/call'), false);
    }
});
test('installed app metadata cannot pass when direct calls fail or use a different account', async () => {
    const unsupported = fixture({ direct: false }), mismatch = fixture({ address: 'other@example.test' });
    const blocked = await inspectGmailPlugin(unsupported.rpc, 'agent@example.test');
    assert.equal(blocked.code, 'MAIL_GMAIL_DIRECT_CALL_UNAVAILABLE');
    assert.equal(blocked.ok, false);
    assert.equal(JSON.stringify(blocked).includes('private details'), false);
    assert.equal((await inspectGmailPlugin(mismatch.rpc, 'agent@example.test')).code, 'MAIL_GMAIL_ACCOUNT_MISMATCH');
});
test('profile probe never runs a model or sends mail and never claims delivery acceptance', async () => {
    const f = fixture(), r = await inspectGmailPlugin(f.rpc, 'agent@example.test');
    assert.equal(r.ok, true); assert.equal(r.directProfileVerified, true); assert.equal(r.deliveryVerified, false);
    assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
    assert.deepEqual(f.calls.filter(c => c.method === 'mcpServer/tool/call').map(c => c.params.tool), ['gmail.get_profile']);
    const thread = f.calls.find(c => c.method === 'thread/start')!.params;
    assert.equal(thread.ephemeral, true);
    assert.equal(thread.config['apps._default.enabled'], false);
    assert.equal(thread.config['apps.synthetic-gmail.default_tools_enabled'], false);
});
