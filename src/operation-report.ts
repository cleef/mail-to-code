import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AsyncStore, Operation } from './async-store.js';
import type { Config } from './config.js';
import { OperationResultSchema } from './operation-result.js';

const stage = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const StageEventSchema = z.object({ stage, status: z.enum(['started', 'completed', 'failed']) }).strict();
export const ReceiptSchema = OperationResultSchema.extend({ operationId: z.string().max(500), target: z.string().max(500), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), completedAt: z.string().datetime() });
export const OperationReportSchema = z.object({
    stage, status: z.enum(['running', 'succeeded', 'uncertain', 'confirmed-failed']),
    error: z.string().regex(/^[A-Z][A-Z0-9_:.-]{0,200}$/).optional(),
    events: z.array(StageEventSchema).max(100).default([]), prerequisites: z.array(ReceiptSchema).max(20).default([])
}).strict();
export type OperationReport = z.infer<typeof OperationReportSchema>;
const FailedResultSchema = z.object({ ok: z.literal(false), outcome: z.literal('confirmed-failed'), summary: z.string().max(4000),
    evidence: OperationResultSchema.shape.evidence, effects: z.enum(['partial', 'none']), inspectedAt: z.string().datetime() }).strict();
export function safeError(error: unknown) {
    const message = error instanceof Error ? error.message : '';
    return /^[A-Z][A-Z0-9_:.-]{0,200}$/.test(message) ? message : /^PROCESS_FAILED:[\w./-]+:-?\d+$/.test(message) ? 'PROCESS_FAILED' : 'OPERATION_FAILED';
}

// Raw logs are operator-only. Only the bounded stage protocol crosses the bridge.
export class OperationJournal {
    private stdout: number;
    private stderr: number;
    private pending = '';
    constructor(readonly config: Config, readonly store: AsyncStore, readonly operationId: string) {
        const directory = join(config.dataDir, 'effect-logs', createHash('sha256').update(operationId).digest('hex'));
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW;
        this.stdout = openSync(join(directory, 'stdout.log'), flags, 0o600);
        try { this.stderr = openSync(join(directory, 'stderr.log'), flags, 0o600); }
        catch (error) { closeSync(this.stdout); throw error; }
    }
    update(update: Partial<OperationReport>) {
        const op = this.store.get<Operation>('operation', this.operationId);
        if (!op) throw Error('OPERATION_RECEIPT_MISSING');
        op.report = OperationReportSchema.parse({ stage: 'prepare', status: 'running', events: [], prerequisites: [], ...op.report, ...update });
        this.store.put('operation', op.id, op);
    }
    onStdout = (text: string) => {
        writeSync(this.stdout, text);
        this.pending += text;
        const lines = this.pending.split('\n'); this.pending = lines.pop()!.slice(-8192);
        for (const line of lines) {
            if (!line.startsWith('MAIL_TO_CODE_EVENT ')) continue;
            try {
                const event = StageEventSchema.parse(JSON.parse(line.slice(19)));
                const previous = this.store.get<Operation>('operation', this.operationId)?.report;
                this.update({ stage: event.stage, events: [...(previous?.events || []), event].slice(-100) });
            } catch { /* Invalid protocol output stays in private logs, not model results. */ }
        }
    };
    onStderr = (text: string) => { writeSync(this.stderr, text); };
    failed(error: unknown) { this.update({ status: 'uncertain', error: safeError(error) }); }
    close() { closeSync(this.stdout); closeSync(this.stderr); }
}

export function operationStatus(store: AsyncStore, conversationId: string, project: string, operationId?: string) {
    const matching = store.all<Operation>('operation').filter(op => op.conversationId === conversationId && (op.input as any)?.project === project && (!operationId || op.id === operationId));
    const recent = new Set(matching.filter(op => op.status === 'done').slice(-20).map(op => op.id));
    return matching.filter(op => operationId || op.status !== 'done' || recent.has(op.id)).map(op => {
        const input = op.input as any;
        const report = OperationReportSchema.safeParse(op.report);
        const receipt = ReceiptSchema.safeParse(op.result);
        const failure = FailedResultSchema.safeParse(op.result);
        const result = receipt.success ? receipt.data : failure.success ? failure.data : op.status === 'done' && op.result && typeof op.result === 'object'
            ? { ...(/^[a-f0-9]{40}$/.test((op.result as any).commit || '') ? { commit: (op.result as any).commit } : {}),
                ...(/^[a-zA-Z0-9._-]{1,200}$/.test((op.result as any).release || '') ? { release: (op.result as any).release } : {}),
                ...((op.result as any).ok === false ? { ok: false, outcome: 'confirmed-failed' } : {}) } : undefined;
        return { operationId: op.id, kind: op.key.split(':')[0], operation: input.operation, target: input.target,
            fingerprint: input.fingerprint || input.profileHash, status: op.status, result,
            ...(report.success ? { report: report.data } : {}) };
    });
}

export const FailedResolutionSchema = z.object({
    operationId: z.string().min(1), project: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    summary: z.string().min(1).max(4000), inspectedAt: z.string().datetime(), effects: z.enum(['partial', 'none']),
    noEffectInFlight: z.literal(true), evidence: OperationResultSchema.shape.evidence
}).strict();
