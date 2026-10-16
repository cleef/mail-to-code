// Real Linux/Codex sandbox + Podman + MySQL + Chromium acceptance. All source,
// mail identities and database contents are synthetic. No model, Gmail, GitHub
// mutation, merge or deployment is invoked.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { ConfigSchema } from '../dist/src/config.js';
import { AsyncStore } from '../dist/src/async-store.js';
import { AsyncTools } from '../dist/src/async-tools.js';
import { ASYNC_CODEX_VERSION } from '../dist/src/async-cli.js';
import { execute } from '../dist/src/process.js';
import { git } from '../dist/src/git.js';

assert.equal(process.platform, 'linux', 'This acceptance requires a real Linux host');
const browserImage = process.env.CHECKS_BROWSER_IMAGE, mysqlImage = process.env.CHECKS_MYSQL_IMAGE;
for (const image of [browserImage, mysqlImage]) assert.match(image || '', /@sha256:[a-f0-9]{64}$/, 'Prepare and supply digest-pinned local images');
const codex = process.env.ASYNC_CODEX_COMMAND || 'codex';
assert.equal((await execute(codex, ['--version'])).stdout.trim(), `codex-cli ${ASYNC_CODEX_VERSION}`);
process.umask(0o077);
const root = await realpath(await mkdtemp(join(tmpdir(), 'mail-check-acceptance-'))), projectsRoot = join(root, 'projects'), tree = join(projectsRoot, 'sample'), dataDir = join(root, 'state');
await mkdir(tree, { recursive: true }); await mkdir(dataDir);
const canary = net.createServer(socket => socket.end('HOST-CANARY'));
await new Promise((resolve, reject) => { canary.once('error', reject); canary.listen(0, '127.0.0.1', resolve); });
const port = canary.address().port, hostFile = join(root, 'host-canary'); await writeFile(hostFile, 'SYNTHETIC-HOST-ONLY');
const store = new AsyncStore(join(dataDir, 'async-cli.sqlite'));
const resources = async () => Promise.all([['pod', 'ps', '--filter', 'label=mail-to-code.owner=controller', '-q'], ['volume', 'ls', '-q']].map(async args => (await execute('podman', args)).stdout.trim().split('\n').filter(Boolean).sort()));
const baseline = await resources();
try {
    await git(tree, ['init', '-b', 'main']); await git(tree, ['remote', 'add', 'origin', 'https://github.com/example-org/synthetic-checks.git']);
    await writeFile(join(tree, '.gitignore'), 'node_modules/\npackage-lock.json\nignored-state.json\n');
    await writeFile(join(tree, 'package.json'), JSON.stringify({ name: 'synthetic-check-fixture', private: true, type: 'module', dependencies: { mysql2: '3.24.4', playwright: '1.63.0' } }));
    await writeFile(join(tree, '.env'), 'SYNTHETIC_EXCLUDED=yes'); await writeFile(join(tree, 'ignored-state.json'), 'synthetic ignored state');
    await writeFile(join(tree, 'integration.mjs'), `
import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import mysql from 'mysql2/promise';
import {chromium} from 'playwright';
for(const path of ['.git','.env','ignored-state.json',process.env.HOST_CANARY_FILE]) await assert.rejects(access(path));
assert.equal(process.env.TEST_VALUE,'synthetic');
await new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port:Number(process.env.HOST_CANARY_PORT)});socket.setTimeout(2000);socket.once('connect',()=>{socket.destroy();reject(Error('Host loopback was exposed'));});socket.once('error',resolve);socket.once('timeout',()=>{socket.destroy();resolve();});});
assert.equal(JSON.parse(await readFile('mode.json','utf8')).fail,false,'intentional initial failure');
const db=await mysql.createConnection({host:'127.0.0.1',user:'root',password:''});
let server,browser;
try{
 await db.query('CREATE DATABASE synthetic_checks');await db.query('CREATE TABLE synthetic_checks.entries (id INT PRIMARY KEY, text VARCHAR(100))');await db.query("INSERT INTO synthetic_checks.entries VALUES (1,'Synthetic learning entry')");
 server=http.createServer(async(_req,res)=>{const [rows]=await db.query('SELECT text FROM synthetic_checks.entries ORDER BY id');res.end('<html><body><h1>'+rows[0].text+'</h1></body></html>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage']});const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
 assert.equal(await page.locator('h1').textContent(),'Synthetic learning entry');assert.equal((await page.screenshot())[0],137);
 console.log('SYNTHETIC-MYSQL-BROWSER-PASSED');
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await db.end();}
`);
    const config = ConfigSchema.parse({ engine: 'async-cli', gmailAddress: 'agent@example.test', ownerAddress: 'owner@example.test', projectsRoot, dataDir, codexCommand: codex, timeoutSeconds: 180, repositories: { sample: { path: tree, github: 'example-org/synthetic-checks', checks: [{ executable: 'node', args: ['--check', 'integration.mjs'], cwd: '.' }] } }, profiles: { sample: {
        image: browserImage, install: [{ executable: 'npm', args: ['install', '--ignore-scripts', '--no-audit', '--no-fund'] }],
        checks: [{ executable: 'node', args: ['integration.mjs'], env: { TEST_VALUE: 'synthetic', HOST_CANARY_FILE: hostFile, HOST_CANARY_PORT: String(port) } }],
        services: [{ name: 'db', image: mysqlImage, env: { MYSQL_ALLOW_EMPTY_PASSWORD: 'yes', MYSQL_ROOT_HOST: '%' }, health: ['mysqladmin', 'ping', '-h', '127.0.0.1', '--silent'] }]
    } } });
    const results = [];
    for (const executor of ['codex', 'claude']) {
        const incoming = { id: executor, threadId: 'synthetic-' + executor, rfcId: '<' + executor + '@example.test>', inReplyTo: '', subject: '[' + executor + '] Synthetic checks', text: 'Test this synthetic project.', from: config.ownerAddress, trusted: true };
        const c = store.intake(incoming, 'synthetic MIME', incoming.text); c.executorSession = 'synthetic-' + executor; store.save(c);
        store.put('scope', c.id, [{ path: tree, role: 'modify', identity: 'example-org/synthetic-checks' }]);
        store.put('project', c.id + ':' + tree, { id: c.id + '-sample', repo: 'sample', worktree: tree, baseSha: 'a'.repeat(40) });
        const tools = new AsyncTools(config, store, c, new AbortController().signal);
        const call = (action, compatibility = false) => compatibility ? tools.call(c.executorSession, 'project_command', { project: 'sample', executable: 'mail-to-code-checks', args: [action] }) : tools.call(c.executorSession, 'project_checks', { project: 'sample', action });
        assert.deepEqual(await call('inspect', true), await call('inspect'));
        await symlink(hostFile, join(tree, 'escape'));
        const unsafe = await call('run'); assert.match(unsafe.error, /^TEST_COPY_UNSAFE_LINK:escape$/); assert.deepEqual(unsafe.checkIds, []);
        await rm(join(tree, 'escape')); assert.deepEqual(await resources(), baseline);
        await writeFile(join(tree, 'mode.json'), JSON.stringify({ fail: true }));
        const failure = await call('run', executor === 'claude'); assert.equal(failure.ok, false); assert.deepEqual(failure.checkIds, []);
        assert.match(failure.stderr, /intentional initial failure/); assert.deepEqual(await resources(), baseline);
        await writeFile(join(tree, 'mode.json'), JSON.stringify({ fail: false }));
        const success = await call('run', executor === 'claude'); assert.equal(success.ok, true, JSON.stringify(success));
        assert.equal(success.checkIds.length, 2); assert.ok(success.commands.some(c => c.stdout.includes('SYNTHETIC-MYSQL-BROWSER-PASSED')));
        assert.deepEqual(await resources(), baseline);
        assert.equal((await call('inspect')).missing.length, 0);
        await writeFile(join(tree, 'mode.json'), JSON.stringify({ fail: true }));
        await assert.rejects(tools.call(c.executorSession, 'project_pr', { project: 'sample', summary: 'No actual PR is permitted in this acceptance.', checks: success.checkIds }), /CURRENT_SOURCE_CHECK_RECEIPTS_REQUIRED/);
        results.push({ executor, compatibility: executor === 'claude', unsafeLinkRejected: true, resourcesCleaned: true, failedThenPassed: true, checks: success.checkIds.length, sourceChangeRejected: true });
    }
    assert.equal(store.mails().length, 0); assert.equal(store.all('operation').length, 0);
    console.log(JSON.stringify({ ok: true, platform: process.platform, codexVersion: ASYNC_CODEX_VERSION, browserImage, mysqlImage, results, realModelTurns: 0, externalEffects: 0 }, null, 2));
} finally {
    store.close(); await new Promise(resolve => canary.close(resolve)); await rm(root, { recursive: true, force: true });
}
