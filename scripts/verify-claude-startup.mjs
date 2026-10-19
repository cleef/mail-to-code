// Pinned SDK/CLI startup without model input or credentials. Synthetic storage only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, access, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ConfigSchema } from '../dist/src/config.js';
import { claudeSessionStorage, prepareNativeFilesystem } from '../dist/src/async-policy.js';
import { checkClaude, claudeOptions, spawnSandboxedClaude } from '../dist/src/claude-client.js';
import { shellEnvironment } from '../dist/src/runner.js';
import { ASYNC_CODEX_VERSION } from '../dist/src/async-cli.js';
import { execute } from '../dist/src/process.js';

process.umask(0o077);
const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-startup-')));
const projectsRoot = join(root, 'projects'); await mkdir(projectsRoot);
process.env.CLAUDE_CONFIG_DIR = join(root, 'native-home');
process.env.MAIL_TO_CODE_CONFIG_DIR = join(root, 'mail-config');
const config = ConfigSchema.parse({gmailAddress:'agent@example.test', ownerAddress:'owner@example.test',
    projectsRoot, dataDir:join(root, 'state'), codexCommand:process.env.ASYNC_CODEX_COMMAND || 'codex'});
assert.equal((await execute(config.codexCommand, ['--version'])).stdout.trim(), `codex-cli ${ASYNC_CODEX_VERSION}`);
const executable = await checkClaude(process.env.ASYNC_CLAUDE_COMMAND || 'claude');
const c = {id:randomUUID(), executorSession:randomUUID()};
prepareNativeFilesystem(config, c, executable);
const storage = claudeSessionStorage(config, c), transcript = join(storage.project, c.executorSession + '.jsonl');
await assert.rejects(access(transcript), {code:'ENOENT'});
let release;
const hold = new Promise(resolve => { release = resolve; });
const run = query({prompt:(async function* () { await hold; })(), options:{
    ...claudeOptions(config, executable, {...shellEnvironment(), CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR}),
    cwd:storage.cwd, sessionId:c.executorSession,
    spawnClaudeCodeProcess:options => spawnSandboxedClaude(config, c, executable, options),
}});
const timer = setTimeout(() => run.close(), 30000);
try {
    assert.ok(await run.initializationResult());
    console.log(JSON.stringify({passed:true, transcriptNotPrecreated:true, nativeInitialization:true, modelInputs:0, realMailSent:0, businessEffects:0}));
} finally { clearTimeout(timer); release(); run.close(); }
