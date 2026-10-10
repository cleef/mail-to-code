// Real Claude Code, synthetic source/mail only. No mailbox, GitHub or deployment.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ConfigSchema } from '../dist/src/config.js';
import { AsyncStore } from '../dist/src/async-store.js';
import { AsyncBridge } from '../dist/src/async-cli.js';
import { sessionOf } from '../dist/src/executor.js';
import { ASYNC_CLAUDE_VERSION } from '../dist/src/claude-client.js';

process.umask(0o077);
const root = await realpath(await mkdtemp(join(tmpdir(), 'mail-claude-acceptance-')));
const projectsRoot = join(root, 'projects'), dataDir = join(root, 'state'), guides = join(root, 'guides');
await Promise.all([mkdir(projectsRoot), mkdir(dataDir), mkdir(guides)]);
process.env.MAIL_TO_CODE_CONFIG_DIR = guides;
await writeFile(join(guides, 'ASYNC_AGENTS.md'), 'Use only synthetic fixtures. No real email, PR, merge or deployment. Write the final reply once.');
const config = ConfigSchema.parse({ engine: 'async-cli', asyncMailOutput: 'assistant-final',
    ownerAddress: 'owner@example.test', gmailAddress: 'agent@example.test', projectsRoot, dataDir,
    codexCommand: process.env.ASYNC_CODEX_COMMAND || 'codex', claudeCommand: process.env.ASYNC_CLAUDE_COMMAND || 'claude', timeoutSeconds: 180,
});
const store = new AsyncStore(join(dataDir, 'async-cli.sqlite'));
const transport = Object.fromEntries(['profile', 'search', 'read', 'send'].map(name => [name, async () => { throw Error('REAL_MAIL_DISABLED'); }]));
let bridge = new AsyncBridge(config, store, transport, undefined, undefined, guides);
const token = randomUUID();
const input = { id: 'first', threadId: 'synthetic-mail', rfcId: '<first@example.test>', inReplyTo: '',
    subject: '[claude] Synthetic adapter acceptance', from: config.ownerAddress, trusted: true,
    text: `Remember this synthetic token for a later reply: ${token}. Use workspace_command to write the exact text SYNTHETIC_OK into a file named acceptance.txt next to FEATURE.md (its path is in your system instructions). Read it back with workspace_command, then give a brief final reply. Do not request confirmation, send a separate notification, or perform any other effects.`,
};
const c = store.intake(input, 'synthetic MIME', input.text);
async function finish(count) {
    const deadline = Date.now() + 210000;
    while (Date.now() < deadline && store.mails().length < count) {
        const current = store.conversation(c.id);
        if (current.error) throw Error(current.error + ':' + JSON.stringify(store.get('claude-fault', c.id)));
        await new Promise(resolve => setTimeout(resolve, 200));
        await bridge.pump();
    }
    const current = store.conversation(c.id);
    if (current.error) throw Error(current.error + ':' + JSON.stringify(store.get('claude-fault', c.id)));
    assert.equal(store.mails().length, count, 'Expected one immutable native final reply');
}
try {
    await bridge.dispatch(c); await finish(1);
    const file = join(dataDir, 'async-cli', 'features', c.id, 'notes', 'acceptance.txt');
    assert.equal((await readFile(file, 'utf8')).trim(), 'SYNTHETIC_OK');
    const nativeSession = sessionOf(store.conversation(c.id));
    assert.ok(nativeSession); assert.equal(store.conversation(c.id).codexThread, undefined);
    await bridge.stop();
    bridge = new AsyncBridge(config, store, transport, undefined, undefined, guides);
    const followup = { ...input, id: 'second', rfcId: '<second@example.test>', inReplyTo: input.rfcId,
        subject: '[codex] Changed reply title must not switch executor', text: 'Return only the synthetic token I asked you to remember in the previous email. No tools or other effects.' };
    store.intake(followup, 'synthetic MIME', followup.text);
    await bridge.dispatch(store.conversation(c.id)); await finish(2);
    assert.equal(sessionOf(store.conversation(c.id)), nativeSession);
    assert.equal(store.conversation(c.id).executor, 'claude');
    assert.ok(store.mails()[1].text.includes(token));
    await bridge.stop();
    bridge = new AsyncBridge(config, store, transport, undefined, undefined, guides);
    await bridge.dispatch(store.conversation(c.id)); assert.equal(store.mails().length, 2);
    const report = { claudeVersion: ASYNC_CLAUDE_VERSION, sameSessionAfterRestart: true, fixedExecutorOnReply: true,
        sandboxedNotesWrite: true, nativeContextPreserved: true, queuedReplies: 2, duplicateReplies: 0, realMailSent: 0, businessEffects: 0 };
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ root, ...report }, null, 2));
} catch (error) {
    console.error(JSON.stringify({ error: error.message, diagnostics: store.get('claude-fault', c.id), root }));
    process.exitCode = 1;
} finally { await bridge.stop(); store.close(); }
