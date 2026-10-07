import type { MailTransport } from './mail-transport.js';
export interface ScanState { get(key: string): string | undefined; set(key: string, value: string): unknown; transaction<T>(fn: () => T): T }
const day = 86400000;
// Processing is idempotent by immutable provider ID. Commit only after every page
// and message completes; a failed poll revisits the same range after restart.
export async function scanMailbox(mail: MailTransport, state: ScanState, owner: string, accept: (id: string) => Promise<void>, now = Date.now()) {
    let baseline = Number(state.get('mail_scan_baseline'));
    if (!Number.isFinite(baseline) || baseline <= 0) {
        if(state.get('gmail_cursor')||state.get('gmail_history')||state.get('started_at'))throw Error('MAIL_MIGRATION_REQUIRED');
        state.transaction(() => { state.set('mail_transport','codex-gmail-plugin-v1'); state.set('mail_scan_baseline', String(now)); state.set('mail_scan_success', String(now)); });
        return;
    }
    const fullAt = Number(state.get('mail_scan_full') || 0), full = now - fullAt >= day;
    const success = Number(state.get('mail_scan_success') || baseline);
    if (!Number.isFinite(success) || success < baseline) throw Error('MAIL_SCAN_CHECKPOINT_INVALID');
    const since = full ? baseline : Math.max(baseline, success - day);
    const refs = await mail.search(`from:${owner} after:${Math.floor(since / 1000) - 1}`);
    for (const id of new Set(refs.map(r => r.id))) await accept(id);
    state.transaction(() => { state.set('mail_scan_success', String(now)); if (full) state.set('mail_scan_full', String(now)); });
}
