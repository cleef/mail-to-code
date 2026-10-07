import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, stat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ConfigSchema, expand } from '../src/config.js';
import { checkMailPlugin, connectMail, mailCodexEnvironment, mailCodexHome } from '../src/mail-connect.js';
import { execute } from '../src/process.js';
import { codexPolicy, replyPolicy } from '../src/runner.js';

test('independent mail home never inherits API credentials or replaces development authentication', async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'synthetic-do-not-inherit';
    try {
        const env = mailCodexEnvironment('/synthetic/private/mail-codex');
        assert.equal(env.CODEX_HOME, '/synthetic/private/mail-codex');
        assert.equal(env.OPENAI_API_KEY, undefined);
        assert.equal(env.CODEX_ACCESS_TOKEN, undefined);
        assert.equal(env.HOME, process.env.HOME);
    } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
    const config = ConfigSchema.parse({ gmailAddress: 'agent@example.test', ownerAddress: 'owner@example.test', mailCodexHome: '~/.codex' });
    await assert.rejects(connectMail(config), /MAIL_CODEX_HOME_MUST_BE_SEPARATE/);
    await assert.rejects(checkMailPlugin(config), /MAIL_CODEX_HOME_MUST_BE_SEPARATE/);
    assert.equal(mailCodexHome(config), expand('~/.codex'));
});

test('mail-connect invokes Codex in a private independent home without touching runtime data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'synthetic-mail-connect-')), directory = join(root, 'config'), home = join(root, 'mail-codex'), command = join(root, 'fake-codex');
    await mkdir(directory, { mode: 0o700 });
    await writeFile(command, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({home:process.env.CODEX_HOME,hasApiKey:!!process.env.OPENAI_API_KEY,cwd:process.cwd(),args:process.argv.slice(2)}));\n`, { mode: 0o700 });
    await chmod(command, 0o700);
    const config = { gmailAddress: 'agent@example.test', ownerAddress: 'owner@example.test', mailCodexHome: home, codexCommand: command, dataDir: join(root, 'runtime-must-not-be-created'), controllerRepository: 'example-org/controller' };
    await writeFile(join(directory, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    const result = await execute(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'mail-connect', '--device-auth'], { env: { ...process.env, MAIL_TO_CODE_CONFIG_DIR: directory, OPENAI_API_KEY: 'synthetic-key' } });
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.home, home); assert.equal(observed.cwd, await realpath(home)); assert.equal(observed.hasApiKey, false);
    assert.deepEqual(observed.args.slice(-2), ['login', '--device-auth']);
    assert.ok(observed.args.includes('cli_auth_credentials_store="file"'));
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal(await stat(config.dataDir).catch(() => null), null);
});

test('development and reply policies disable apps; configured mail credentials are masked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'synthetic-mail-policy-')), home = join(root, 'private-mail');
    await mkdir(home, { mode: 0o700 });
    const config = ConfigSchema.parse({ gmailAddress: 'agent@example.test', ownerAddress: 'owner@example.test', mailCodexHome: home });
    const policy = codexPolicy(config, root, 'develop');
    assert.ok(policy.includes('features.apps=false'));
    const reply=replyPolicy(root,config);assert.ok(reply.includes('features.apps=false'));assert.ok(reply.find(s=>s.startsWith('permissions.mail-to-code-reply.filesystem='))!.includes(JSON.stringify(home)+'="deny"'));
    const table = policy.find(s => s.startsWith('permissions.mail-to-code-task.filesystem='))!;
    assert.ok(table.includes(JSON.stringify(home) + '="deny"'));
});
