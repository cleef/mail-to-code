import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod/v3';
import type { Config } from './config.js';
import type { AsyncStore, Operation } from './async-store.js';
import { execute } from './process.js';
import { acquireLease } from './lease.js';
import { OperationJournal } from './operation-report.js';
import { OperationResultSchema, type OperationResult } from './operation-result.js';
export { OperationResultSchema, type OperationResult } from './operation-result.js';

const argument = z.string().max(4096).refine(v => !v.includes('\0'), 'NUL is not allowed');
const script = z.string().startsWith('/').refine(v => !/[\r\n\0]/.test(v), 'Expected an absolute script path');
export const OperationSchema = z.object({
    description: z.string().min(1).max(2000), target: z.string().min(1).max(500),
    effect: z.enum(['read', 'write']), script, args: z.array(argument).max(100).default([]),
    timeoutSeconds: z.number().int().min(1).max(3600).default(1800),
    reconcileScript: script.optional()
}).strict();
export const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export interface OperationBinding {
    project: string; repository: string; operation: string; target: string; effect: 'read' | 'write'; fingerprint: string;
}
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function trustedScript(config: Config, path: string) {
    try {
        const info = await lstat(path), actual = await realpath(path);
        const roots = [config.projectsRoot, ...Object.values(config.repositories).map(r => r.path), join(config.dataDir, 'async-cli', 'features')];
        for (const root of roots) {
            const resolved = await realpath(root).catch(() => resolve(root));
            if (actual === resolved || actual.startsWith(resolved + '/')) throw Error('untrusted location');
        }
        const parent = await lstat(dirname(actual));
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || !(info.mode & 0o100) || !parent.isDirectory() || (parent.mode & 0o022)) throw Error('private executable required');
        if (process.getuid && (![0, process.getuid()].includes(info.uid) || ![0, process.getuid()].includes(parent.uid))) throw Error('unexpected owner');
        return { path: actual, sha256: createHash('sha256').update(await readFile(actual)).digest('hex') };
    } catch { throw Error('OPERATION_PRIVATE_SCRIPT_REQUIRED'); }
}

const queues = new Map<string, Promise<unknown>>();
export async function withProjectOperationLock<T>(config: Config, project: string, action: () => Promise<T>): Promise<T> {
    const identity = config.repositories[project]?.github;
    if (!identity) throw Error('OPERATOR_ADAPTER_MISSING');
    const directory = join(config.dataDir, 'operation-locks', digest(identity)), key = resolve(directory);
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const release = await acquireLease(directory);
        try { return await action(); } finally { await release(); }
    });
    queues.set(key, next);
    try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}

export class OperationsAdapter {
    constructor(readonly config: Config, readonly store: AsyncStore, readonly conversationId: string) {}
    private definition(project: string, operation: string) {
        if (this.config.engine !== 'async-cli') throw Error('OPERATIONS_REQUIRE_ASYNC_CLI');
        OperationIdSchema.parse(operation);
        const value = this.config.repositories[project]?.operations?.[operation];
        if (!value) throw Error('OPERATOR_OPERATION_NOT_CONFIGURED');
        return value;
    }
    async binding(project: string, operation: string): Promise<OperationBinding> {
        const definition = this.definition(project, operation);
        const executable = await trustedScript(this.config, definition.script);
        const reconcile = definition.reconcileScript ? await trustedScript(this.config, definition.reconcileScript) : undefined;
        const repository = this.config.repositories[project].github;
        return { project, repository, operation, target: definition.target, effect: definition.effect, fingerprint: digest({ repository, definition, executable, reconcile }) };
    }
    async list(project: string) {
        const operations = this.config.repositories[project]?.operations || {};
        return Promise.all(Object.entries(operations).map(async ([operation, d]) => ({
            operation, description: d.description, target: d.target, effect: d.effect,
            fingerprint: (await this.binding(project, operation)).fingerprint
        })));
    }
    assertNoUncertainWrites(project: string, exceptId?: string) {
        const pending = this.store.all<Operation>('operation').some(op => {
            if (!op.input || typeof op.input !== 'object') return false;
            const input = op.input as Partial<OperationBinding>;
            return op.id !== exceptId && op.status !== 'done' && (input.project === project || input.repository === this.config.repositories[project]?.github) &&
                (op.key.startsWith('deploy:') || op.key.startsWith('operation:') && input.effect === 'write');
        });
        if (pending) throw Error('PROJECT_WRITE_UNCERTAIN_RECONCILE_REQUIRED');
    }
    async deployFingerprint(project: string) {
        const deployment = this.config.repositories[project]?.deployment;
        const prerequisites = deployment?.preDeployOperations || [];
        // Preserve the exact old authorization shape for installations without prerequisites.
        if (!prerequisites.length) return digest(deployment);
        const bindings = await Promise.all(prerequisites.map(id => this.binding(project, id)));
        return digest({ deployment, prerequisites: bindings });
    }
    private async invoke(binding: OperationBinding, operationId: string, signal: AbortSignal, reconcile = false): Promise<OperationResult> {
        const { shellEnvironment } = await import('./runner.js');
        const d = this.definition(binding.project, binding.operation);
        if (digest(await this.binding(binding.project, binding.operation)) !== digest(binding)) throw Error('OPERATION_CONFIGURATION_CHANGED');
        const path = reconcile ? d.reconcileScript : d.script;
        if (!path) throw Error('OPERATION_RECONCILER_NOT_CONFIGURED');
        const executable = await trustedScript(this.config, path);
        let result: { stdout: string; stderr: string };
        let outputBytes = 0;
        const journal = new OperationJournal(this.config, this.store, operationId);
        journal.update({ stage: binding.operation });
        try {
            result = await execute(executable.path, d.args, {
                cwd: dirname(executable.path), signal, timeoutMs: d.timeoutSeconds * 1000, maxOutput: 65537,
                onStdout: text => { outputBytes += Buffer.byteLength(text); journal.onStdout(text); }, onStderr: journal.onStderr,
                env: { ...shellEnvironment(), ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
                    MAIL_TO_CODE_OPERATION_ID: operationId, MAIL_TO_CODE_OPERATION_TARGET: binding.target,
                    MAIL_TO_CODE_OPERATION_FINGERPRINT: binding.fingerprint }
            });
        } catch (error) { journal.failed(error); throw Error('OPERATION_EXECUTION_UNCERTAIN'); }
        finally { journal.close(); }
        if (digest(await this.binding(binding.project, binding.operation)) !== digest(binding)) throw Error('OPERATION_CONFIGURATION_CHANGED');
        try {
            if (outputBytes > 65536) throw Error();
            return OperationResultSchema.parse(JSON.parse(result.stdout));
        } catch { journal.failed(Error('OPERATION_INVALID_RESULT')); throw Error('OPERATION_INVALID_RESULT'); }
    }
    async run(project: string, operation: string, key: string, authorization: unknown, signal: AbortSignal, expected?: OperationBinding) {
        const binding = await this.binding(project, operation);
        if (expected && digest(binding) !== digest(expected)) throw Error('OPERATION_CONFIGURATION_CHANGED');
        return this.store.effect(this.conversationId, 'operation:' + project + ':' + key, { ...binding, authorization }, async () => {
            const operationId = this.conversationId + ':operation:' + project + ':' + key;
            const result = await this.invoke(binding, operationId, signal);
            const op = this.store.get<Operation>('operation', operationId)!;
            if (op.report) { op.report.status = result.ok ? 'succeeded' : 'confirmed-failed'; this.store.put('operation', op.id, op); }
            return { ...result, operationId, target: binding.target, fingerprint: binding.fingerprint, completedAt: new Date().toISOString() };
        });
    }
    async preDeploy(project: string, requestId: string, signal: AbortSignal, approvedFingerprint: string, attemptId: string) {
        const receipts = [];
        this.assertNoUncertainWrites(project, this.conversationId + ':deploy:' + requestId);
        if (await this.deployFingerprint(project) !== approvedFingerprint) throw Error('APPROVED_OPERATION_TARGET_CHANGED');
        for (const operation of this.config.repositories[project].deployment?.preDeployOperations || []) {
            const result = await this.run(project, operation, 'deploy-' + digest({ requestId, attemptId, operation }), { deployRequestId: requestId, attemptId }, signal);
            receipts.push(result);
            if (!result.ok) throw Error('PREDEPLOY_OPERATION_FAILED');
        }
        if (await this.deployFingerprint(project) !== approvedFingerprint) throw Error('APPROVED_OPERATION_TARGET_CHANGED');
        return receipts;
    }
    async reconcile(op: Operation, signal: AbortSignal) {
        const input = op.input as OperationBinding;
        const binding = { project: input.project, repository: input.repository, operation: input.operation, target: input.target, effect: input.effect, fingerprint: input.fingerprint };
        const result = await this.invoke(binding, op.id, signal, true);
        // ok=false means no conclusive successful receipt; it never permits replay.
        if (!result.ok) return { verified: false, uncertain: true };
        const receipt = { ...result, operationId: op.id, target: binding.target, fingerprint: binding.fingerprint, completedAt: new Date().toISOString() };
        op.status = 'done'; op.result = receipt; this.store.put('operation', op.id, op);
        return { verified: true, result: receipt };
    }
}
