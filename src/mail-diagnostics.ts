import { GmailError, type MailTransportFailure } from './mail-transport.js';
import type { Outbound } from './types.js';

export type MailPhase = 'prepare' | 'send' | 'search' | 'read';
export interface MailDiagnostic {
    at: string;
    attempt: number;
    phase: MailPhase;
    code: string;
    transport?: MailTransportFailure;
    auditId: string;
}
// Only bounded controller codes enter status output. Provider messages and RPC
// data stay in the private database, which is denied to development sessions.
export function mailDiagnostic(m: Outbound, phase: MailPhase, error: unknown): MailDiagnostic {
    const message = error instanceof Error ? error.message : '';
    return {
        at: new Date().toISOString(), attempt: m.attempts, phase,
        code: /^(?:MAIL|DELIVERY)_[A-Z_]{1,100}$/.test(message) ? message : `MAIL_${phase.toUpperCase()}_FAILED`,
        ...(error instanceof GmailError && error.failure ? { transport: error.failure } : {}),
        auditId: `${m.id}:${m.attempts}:${phase}`,
    };
}

// Never serialize request arguments ourselves. Preserve only the thrown failure
// and its cause (including tool error responses), with strict depth/size bounds.
// This is private operator evidence, not model/user-facing error text.
export function privateMailError(error: unknown): unknown {
    let remaining = 16000, nodes = 300;
    const seen = new Set<object>();
    const visit = (value: unknown, depth: number): unknown => {
        if (remaining <= 0 || depth > 6 || --nodes < 0) return '[truncated]';
        if (typeof value === 'string') { const text = value.slice(0, Math.min(4000, remaining)); remaining -= text.length; return text; }
        if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
        if (typeof value !== 'object') return String(typeof value);
        if (seen.has(value)) return '[circular]';
        seen.add(value);
        if (value instanceof Error) return visit({ name: value.name, message: value.message, code: (value as any).code, rpcCode: (value as any).rpcCode, diagnostic: (value as any).diagnostic, cause: value.cause }, depth + 1);
        if (Array.isArray(value)) return value.slice(0, 20).map(v => visit(v, depth + 1));
        return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, v]) => [key.slice(0, 100), visit(v, depth + 1)]));
    };
    return visit(error, 0);
}

export function mailStatus(m: Outbound) {
    return { id: m.id, status: m.status, identity: m.identityStatus, lastError: m.lastError,
        attempts: m.attempts, attemptedAt: m.attemptedAt, gmailId: m.gmailId,
        identityCheckedAt: m.identityCheckedAt, identityError: m.identityError,
        sendDiagnostic: m.sendDiagnostic, identityDiagnostic: m.identityDiagnostic, images: m.bodySnapshot?.images };
}

export function blockedMail(mails: Outbound[]) {
    return mails.filter(m => m.status === 'uncertain' || m.status === 'failed' ||
        m.status === 'pending' && !!m.lastError || m.status === 'sent' && m.identityStatus !== 'verified' && !!m.identityError).map(mailStatus);
}
