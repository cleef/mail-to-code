// Read-only prerequisite check. No intake, model turn, send, migration or cleanup.
import { loadConfig } from '../dist/src/config.js';
import { checkMailPlugin } from '../dist/src/mail-connect.js';

const config = await loadConfig(true);
const index = process.argv.indexOf('--codex-home');
if (index >= 0 && !process.argv[index + 1]) throw Error('--codex-home requires a directory');
try {
    const report = await checkMailPlugin(config, index >= 0 ? process.argv[index + 1] : undefined);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 2;
} catch (e) {
    const code = e instanceof Error && /^MAIL_CODEX_[A-Z_]+$/.test(e.message) ? e.message : 'MAIL_CODEX_APP_SERVER_UNAVAILABLE';
    console.log(JSON.stringify({ ok: false, code }));
    process.exitCode = 2;
}
