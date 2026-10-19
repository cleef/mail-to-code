import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ConfigSchema } from '../dist/src/config.js';
import { AsyncStore } from '../dist/src/async-store.js';
import { AsyncBridge } from '../dist/src/async-cli.js';
import { sessionOf } from '../dist/src/executor.js';
import { execute } from '../dist/src/process.js';

// No real mailbox, PR, merge or deployment. Fail if runtime/auth is unavailable.
export async function verifyNativeCli(executor) {
    process.umask(0o077);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mail-native-cli-')));
    const projectsRoot = join(root, 'projects'), dataDir = join(root, 'state'), guides = join(root, 'guides');
    await Promise.all([mkdir(projectsRoot), mkdir(dataDir), mkdir(guides)]);
    process.env.MAIL_TO_CODE_CONFIG_DIR = guides;
    await writeFile(join(guides, 'ASYNC_AGENTS.md'), 'Synthetic acceptance only. Never contact a real mailbox, repository, deployment or external business service. Use native tools.');
    const config = ConfigSchema.parse({ asyncMailOutput: 'assistant-final', ownerAddress: 'owner@example.test', gmailAddress: 'agent@example.test', projectsRoot, dataDir,
        codexCommand: process.env.ASYNC_CODEX_COMMAND || 'codex', claudeCommand: process.env.ASYNC_CLAUDE_COMMAND || 'claude', timeoutSeconds: 180 });
    const repo = join(projectsRoot, 'sample'); await mkdir(repo);
    await execute('git', ['init', '-b', 'main', repo]);
    await writeFile(join(repo, 'README.md'), 'Synthetic native tool acceptance.\n');
    await execute('git', ['-C', repo, 'add', '.']);
    await execute('git', ['-C', repo, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-m', 'Synthetic fixture']);
    const store = new AsyncStore(join(dataDir, 'async-cli.sqlite'));
    const transport = Object.fromEntries(['profile', 'search', 'read', 'send'].map(name => [name, async () => { throw Error('REAL_MAIL_DISABLED'); }]));
    let bridge = new AsyncBridge(config, store, transport, undefined, undefined, guides);
    const token = randomUUID(), worktree = join(projectsRoot, 'sample-worktree');
    const input = { id: 'first', threadId: 'synthetic-mail', rfcId: '<first@example.test>', inReplyTo: '', subject: `[${executor}] Synthetic native acceptance`, from: config.ownerAddress, trusted: true,
        text: `Remember synthetic token ${token}. Use native Git to create a worktree at ${worktree} from ${repo}, branch synthetic-feature. Write exactly SYNTHETIC_OK to acceptance.txt in that worktree, read it back, run git status and gh --version. There is no scope, prepared worktree, authorization evidence or operation tool. This is synthetic PR 7 and a synthetic deployment target: do not merge/deploy, just explain that separate user confirmation is required. Never contact real GitHub. Give one final reply, no queue_mail.` };
    const c = store.intake(input, 'synthetic MIME', input.text);
    async function finish(count) {
        const deadline = Date.now() + 210000;
        while (Date.now() < deadline && store.mails().length < count) {
            const current = store.conversation(c.id);
            if (current.error) throw Error(current.error);
            await new Promise(resolve => setTimeout(resolve, 200)); await bridge.pump();
        }
        assert.equal(store.mails().length, count, 'Expected one immutable native final per input');
    }
    const report = { executor, realMailSent: 0, realBusinessEffects: 0 };
    try {
        await bridge.dispatch(c); await finish(1);
        assert.equal((await readFile(join(worktree, 'acceptance.txt'), 'utf8')).trim(), 'SYNTHETIC_OK');
        const session = sessionOf(store.conversation(c.id)); assert.ok(session);
        await bridge.stop(); bridge = new AsyncBridge(config, store, transport, undefined, undefined, guides);
        const followup = { ...input, id: 'second', rfcId: '<second@example.test>', inReplyTo: input.rfcId,
            text: `Confirm merging synthetic PR 7 only, not deployment. This mock merge has no external effects: create ${join(worktree, 'mock-merge.txt')} with the token from my first email. Do not create mock-deploy.txt. Reply with the token. No real merge/deploy or network request.` };
        store.intake(followup, 'synthetic MIME', followup.text);
        await bridge.dispatch(store.conversation(c.id)); await finish(2);
        assert.equal(sessionOf(store.conversation(c.id)), session);
        assert.equal((await readFile(join(worktree, 'mock-merge.txt'), 'utf8')).trim(), token);
        assert.equal(await readFile(join(worktree, 'mock-deploy.txt')).catch(() => null), null);
        const third = { ...input, id: 'third', rfcId: '<third@example.test>', inReplyTo: input.rfcId,
            text: `Now confirm the separate synthetic deployment only. Create ${join(worktree, 'mock-deploy.txt')} containing SYNTHETIC_DEPLOY_OK. This local marker is the complete mock action: no real deployment or external operation. Give one final reply.` };
        store.intake(third, 'synthetic MIME', third.text);
        await bridge.dispatch(store.conversation(c.id)); await finish(3);
        assert.equal((await readFile(join(worktree, 'mock-deploy.txt'), 'utf8')).trim(), 'SYNTHETIC_DEPLOY_OK');
        await bridge.stop(); bridge = new AsyncBridge(config, store, transport, undefined, undefined, guides);
        await bridge.dispatch(store.conversation(c.id)); assert.equal(store.mails().length, 3);
        assert.equal(store.all('scope').length, 0); assert.equal(store.all('request').length, 0); assert.equal(store.all('operation').length, 0);
        Object.assign(report, { passed: true, nativeWorktreeCreated: true, sameSession: true, separateSyntheticConfirmations: true, queuedReplies: 3, businessAuthorizationRecords: 0 });
    } catch (error) { Object.assign(report, { passed: false, error: error.message }); process.exitCode = 1; }
    finally { await bridge.stop(); store.close(); }
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ root, ...report }, null, 2));
}
