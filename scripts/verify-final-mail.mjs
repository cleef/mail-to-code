// Real persistent old-tool thread; synthetic inspection and staged confirmation only.
// No Gmail/GitHub client, production SSH, merge, deployment or real email.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigSchema } from '../dist/src/config.js';
import { AsyncStore } from '../dist/src/async-store.js';
import { AsyncBridge, ASYNC_CONTRACT, ASYNC_CODEX_VERSION, asyncPolicy } from '../dist/src/async-cli.js';
import { ASYNC_TOOLS } from '../dist/src/async-tools.js';
import { AppServer, denyInteractive } from '../dist/src/app-server.js';
import { execute } from '../dist/src/process.js';
import { git } from '../dist/src/git.js';
import { disabledMcpPolicy, shellEnvironment } from '../dist/src/runner.js';
process.umask(0o077);
const command = process.env.ASYNC_CODEX_COMMAND || 'codex';
assert.equal((await execute(command, ['--version'])).stdout.trim(), `codex-cli ${ASYNC_CODEX_VERSION}`);
const root = await realpath(await mkdtemp(join(tmpdir(), 'mail-final-reply-'))), projectsRoot = join(root, 'projects'), dataDir = join(root, 'state'), privateDirectory = join(root, 'private');
await Promise.all([mkdir(projectsRoot), mkdir(dataDir), mkdir(privateDirectory)]);
const guideDirectory = join(root, 'config'); await mkdir(guideDirectory);
await writeFile(join(guideDirectory, 'AGENTS.md'), 'Old guide: require START and Review at every stage. Keep final replies internal.\n');
await writeFile(join(guideDirectory, 'WORKFLOW.md'), 'Old workflow: compose a separate programmatic notification.\n');
await writeFile(join(guideDirectory, 'ASYNC_AGENTS.md'), 'Use natural Chinese, state the result before technical details. The email is your native final reply. Preserve synthetic project conventions.\n');
process.env.MAIL_TO_CODE_CONFIG_DIR = guideDirectory;
for (const name of ['sample', 'second']) {
    const path = join(projectsRoot, name); await mkdir(path); await git(path, ['init', '-b', 'main']);
    await git(path, ['remote', 'add', 'origin', `https://github.com/example-org/${name}.git`]);
    await writeFile(join(path, 'AGENTS.md'), 'Synthetic fixture only. No real services or external effects.\n');
}
const script = join(privateDirectory, 'inspect'), trace = join(privateDirectory, 'calls');
await writeFile(script, `#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(trace)},'inspect\\n');console.log(JSON.stringify({ok:true,summary:'Synthetic background service is healthy',evidence:{workerHealthy:true}}));\n`, { mode: 0o700 });
const config = ConfigSchema.parse({ engine: 'async-cli', asyncMailOutput: 'assistant-final', gmailAddress: 'agent@example.test', ownerAddress: 'owner@example.test', projectsRoot, dataDir, codexCommand: command, controllerRepository: 'example-org/controller', repositories: { sample: { path: join(projectsRoot, 'sample'), github: 'example-org/sample', operations: { inspect: { description: 'Inspect synthetic service', target: 'sample-staging', effect: 'read', script } } } } });
const store = new AsyncStore(join(dataDir, 'async-cli.sqlite'));
const input = { id: 'seed', threadId: 'synthetic-mail', rfcId: '<seed@example.test>', inReplyTo: '', subject: 'Synthetic final reply', text: 'Seed the historical thread only.', from: config.ownerAddress, trusted: true };
const c = store.intake(input, 'synthetic MIME', input.text);
store.put('scope', c.id, [{ path: join(projectsRoot, 'sample'), identity: 'example-org/sample', role: 'modify' }]);
await new (await import('../dist/src/async-tools.js')).AsyncTools(config, store, c, new AbortController().signal).initializeFeature();
const servers = JSON.parse((await execute(command, ['mcp', 'list', '--json'], { env: shellEnvironment() })).stdout);
const create = handler => new AppServer(command, [...asyncPolicy(config, c), ...disabledMcpPolicy(servers)], projectsRoot, handler);
const old = create(denyInteractive), completed = new Set();
old.on('notification', (method, p) => { if (method === 'turn/completed') completed.add(p.turn.id); });
const wait = async (condition, seconds) => { const deadline = Date.now() + seconds * 1000; while (!condition() && Date.now() < deadline) await new Promise(r => setTimeout(r, 250)); assert.ok(condition(), 'Native final reply deadline exceeded'); };
const transport = Object.fromEntries(['profile', 'history', 'search', 'read', 'send'].map(name => [name, async () => { throw Error('REAL_MAIL_DISABLED'); }]));
let bridge;
try {
    await old.start();
    const started = await old.request('thread/start', { cwd: projectsRoot, approvalPolicy: 'never', developerInstructions: ASYNC_CONTRACT,
        dynamicTools: ASYNC_TOOLS.filter(t => !['request_confirmation', 'project_operation_status', 'project_operations', 'project_operation'].includes(t.name)) });
    c.codexThread = started.thread.id; store.save(c);
    const seed = await old.request('turn/start', { threadId: c.codexThread, input: [{ type: 'text', text: 'Synthetic initialization: reply READY only. No tools, file edits or email.' }] });
    await wait(() => completed.has(seed.turn.id), 120); await old.close();
    const event = store.input(input.id); event.status = 'accepted'; event.turnId = seed.turn.id; store.saveInput(event);
    const reply = { ...input, id: 'reply', rfcId: '<reply@example.test>', inReplyTo: input.rfcId,
        text: '请先通过控制器只读检查 sample 的后台服务。然后向我申请增加 second 项目的修改范围：只准备确认请求，不授予范围、不创建 worktree、不修改文件。以自然中文告诉我检查结果和需要确认的事情，不要求 START 或复制固定句式。不要合并、部署或另写通知稿。' };
    store.intake(reply, 'synthetic MIME', reply.text);
    bridge = new AsyncBridge(config, store, transport, async (_, handler) => create(handler), undefined, guideDirectory);
    await bridge.dispatch(store.conversation(c.id)); await wait(() => !store.conversation(c.id).activeTurn, 180);
    await bridge.pump();
    const historyClient = create(denyInteractive); let history;
    try { await historyClient.start(); history = await historyClient.request('thread/read', { threadId: c.codexThread, includeTurns: true }); } finally { await historyClient.close(); }
    const turn = history.thread.turns.at(-1), finals = turn.items.filter(i => i.type === 'agentMessage' && i.phase === 'final_answer');
    const last = turn.items.at(-1); const native = (finals.length ? finals : last?.type === 'agentMessage' ? [last] : []).map(i => i.text).join('\n\n');
    const outbox = store.mails(); assert.equal(outbox.length, 1); assert.equal(outbox[0].text, native);
    assert.equal(store.all('request').length, 1); assert.equal(store.all('request')[0].mailId, outbox[0].id);
    assert.equal(store.get('scope', c.id).length, 1); assert.equal(store.all('operation').length, 1);
    assert.equal((await readFile(trace, 'utf8')).trim(), 'inspect');
    await bridge.stop(); bridge = new AsyncBridge(config, store, transport, async (_, handler) => create(handler), undefined, guideDirectory);
    await bridge.dispatch(store.conversation(c.id)); assert.equal(store.mails().length, 1);
    const report = { codexVersion: ASYNC_CODEX_VERSION, sameThread: store.conversation(c.id).codexThread === started.thread.id, finalEqualsNative: true, queuedMails: outbox.length, preparedConfirmations: 1, readOnlyInspections: 1, grantsPreserved: true, historicalRepliesSent: 0, realMailSent: 0, businessWrites: 0, finalText: native };
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ root, ...report }, null, 2));
} finally { await old.close(); await bridge?.stop(); store.close(); }
