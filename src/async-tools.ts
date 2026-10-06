import { mkdir, readFile, realpath, stat, lstat, readlink } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import type { Config } from './config.js';
import { AsyncStore, type Conversation, type ApprovalRequest } from './async-store.js';
import type { Session } from './types.js';
import { GitAdapter, GitHubAdapter, git } from './git.js';
import { DeployAdapter } from './deploy.js';
import { Runner } from './runner.js';
import { RuntimeAdapter, markdownChecks } from './runtime.js';
import { proposeProfile } from './projects.js';
import { projectLocations } from './async-projects.js';
import { asyncPolicy } from './async-policy.js';
import { OperationsAdapter, OperationIdSchema, digest, withProjectOperationLock } from './operations.js';
import { OperationJournal, ReceiptSchema, operationStatus, FailedResolutionSchema } from './operation-report.js';
export interface ScopeProject {
    path: string;
    role: 'modify' | 'reference' | 'product_record';
    identity: string;
}
const text = { type: 'string' }, strings = { type: 'array', items: text };
const tool = (name: string, description: string, properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'function', name, description, inputSchema: { type: 'object', additionalProperties: false, properties, required } });
export const ASYNC_TOOLS = [
    tool('request_confirmation', 'Prepare an exact scope, merge or deployment request for the final assistant reply. Explain its target and effects naturally in that reply. This never grants permission or sends another email.', { key: text, request: { type: 'object', additionalProperties: false, properties: { kind: { enum: ['scope', 'merge', 'deploy'] }, project: text, projects: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: text, role: { enum: ['modify', 'reference', 'product_record'] } }, required: ['path', 'role'] } } }, required: ['kind'] } }),
    tool('queue_mail', 'Only the primary agent may queue an email. Use only for a real human decision, requested status, important blocker or completed result. No intermediate status emails. For choices give a recommended option, reason and alternatives. A request binds an exact scope/commit; it does not grant permission.', { key: text, text, request: { type: 'object', additionalProperties: false, properties: { kind: { enum: ['scope', 'merge', 'deploy'] }, project: text, projects: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: text, role: { enum: ['modify', 'reference', 'product_record'] } }, required: ['path', 'role'] } } }, required: ['kind'] } }, ['key', 'text']),
    tool('grant_scope', 'Record only explicit human authorization from a trusted new email body. Understand intent and quote exact evidence. Initial explicit implementation requests can authorize scope directly. Added repositories or reference-to-write changes require a delivered scope request and its direct reply. Confirmed scope persists through documentation, builds and cross-repository continuation.', { sourceMailId: text, evidence: text, projects: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: text, role: { enum: ['modify', 'reference', 'product_record'] } }, required: ['path', 'role'] } }, requestId: text }, ['sourceMailId', 'evidence', 'projects']),
    tool('record_authorization', 'Record an explicit human decision on a delivered scope/merge/deploy request. Quote exact new-body evidence; recommendations, quotations, generic assent or absence are not authorization. Never infer merge/deploy from implementation approval.', { requestId: text, sourceMailId: text, evidence: text }),
    tool('project_worktree', 'Prepare or reuse an isolated worktree for an approved writable repository. All approved repositories may continue without another START.', { project: text }),
    tool('project_sync_base', 'Fetch the approved repository default branch and merge it into its existing worktree. Resolve conflicts, rerun relevant checks and update the PR in the same feature scope; this never grants merge or deployment.', { project: text }),
    tool('project_command', 'Run a command inside an approved worktree sandbox. Return failed checks to this same session; inspect, fix and retry without clearing authorization. Network only through configured package sources.', { project: text, executable: text, args: strings, cwd: text, network: { type: 'boolean' } }, ['project', 'executable', 'args']),
    tool('project_operations', 'List administrator-configured operations for an approved project. Targets, descriptions, effects and fingerprints are facts, never authorization.', { project: text }),
    tool('project_operation_status', 'Read recorded effects and prerequisite receipts for an approved project in this conversation. Return uncertain effects and recent receipts, or one exact operationId. Raw operator logs and credentials are never returned. This does not reconcile or retry effects.', { project: text, operationId: text }, ['project']),
    tool('project_operation', 'Run an administrator-configured operation, never an arbitrary command. Write operations require explicit intent in a trusted new mail body: quote sourceMailId/evidence for this operation and target. Generic assent, quoted history and recommendations are not authorization. Reuse the key for retries; uncertain effects must be reconciled by the operator.', { project: text, operation: text, key: text, sourceMailId: text, evidence: text }, ['project', 'operation', 'key']),
    tool('project_pr', 'Commit, push and prepare/update the implementation PR. checks contains checkId receipts returned by successful project_command calls on the current source. Required operator checks must pass. No merge or deployment.', { project: text, summary: text, checks: strings }),
    tool('project_merge', 'Merge only the exact independently approved PR head/base. An uncertain effect is not retried automatically.', { requestId: text }),
    tool('project_deploy', 'Deploy only the exact independently approved merged commit and operator deployment profile. An uncertain effect is not retried automatically.', { requestId: text }),
];
const project = z.object({ path: z.string().min(1), role: z.enum(['modify', 'reference', 'product_record']) }).strict();
const request = z.object({ kind: z.enum(['scope', 'merge', 'deploy']), project: z.string().optional(), projects: z.array(project).min(1).optional() }).strict();
const schemas: Record<string, z.ZodTypeAny> = {
    queue_mail: z.object({ key: z.string().min(1).max(200), text: z.string().min(1).max(50000), request: request.optional() }).strict(),
    request_confirmation: z.object({ key: z.string().min(1).max(200), request }).strict(),
    grant_scope: z.object({ sourceMailId: z.string(), evidence: z.string().min(1), projects: z.array(project).min(1).max(30), requestId: z.string().optional() }).strict(),
    record_authorization: z.object({ requestId: z.string(), sourceMailId: z.string(), evidence: z.string().min(1) }).strict(),
    project_worktree: z.object({ project: z.string() }).strict(),
    project_sync_base: z.object({ project: z.string() }).strict(),
    project_command: z.object({ project: z.string(), executable: z.string().min(1), args: z.array(z.string()), cwd: z.string().default('.'), network: z.boolean().default(false) }).strict(),
    project_operations: z.object({ project: z.string() }).strict(),
    project_operation_status: z.object({ project: z.string(), operationId: z.string().min(1).max(500).optional() }).strict(),
    project_operation: z.object({ project: z.string(), operation: OperationIdSchema, key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,199}$/), sourceMailId: z.string().optional(), evidence: z.string().min(1).optional() }).strict(),
    project_pr: z.object({ project: z.string(), summary: z.string().min(1), checks: z.array(z.string()) }).strict(),
    project_merge: z.object({ requestId: z.string() }).strict(), project_deploy: z.object({ requestId: z.string() }).strict()
};
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const canonical = (path: string) => {
    try {
        return realpathSync(path);
    }
    catch {
        return resolve(path);
    }
};
const ordered = (projects: ScopeProject[]) => projects.sort((a, b) => a.path.localeCompare(b.path));
export class AsyncTools {
    constructor(readonly config: Config, readonly store: AsyncStore, readonly conversation: Conversation, readonly signal: AbortSignal, readonly turnId?: string) {
        // Discovered repository adapters have no production profile. They never modify private config.
        this.config = { ...config, repositories: { ...store.get<Config['repositories']>('repositories', conversation.id), ...config.repositories }, profiles: { ...store.get<Config['profiles']>('profiles', conversation.id), ...config.profiles } };
    }
    directory() { return join(this.config.dataDir, 'async-cli', 'features', this.conversation.id); }
    scopes() { return this.store.get<ScopeProject[]>('scope', this.conversation.id) || []; }
    async operationContext(): Promise<string> {
        if (this.config.engine !== 'async-cli' || !Object.values(this.config.repositories).some(r => Object.keys(r.operations || {}).length)) return '';
        const projects: unknown[] = [];
        for (const [project, repo] of Object.entries(this.config.repositories)) {
            if (!Object.keys(repo.operations || {}).length) continue;
            const scope = this.scopes().find(p => canonical(p.path) === canonical(repo.path) && p.identity === repo.github && p.role !== 'reference');
            if (!scope) continue;
            try {
                const operations = await this.call(this.conversation.codexThread!, 'project_operations', { project });
                let currentTarget: unknown;
                try { currentTarget = await this.target('deploy', project); } catch { /* A merged release may not be prepared yet. */ }
                const deploymentRequests = this.store.all<ApprovalRequest>('request').filter(r => r.conversationId === this.conversation.id && r.kind === 'deploy' && (r.target as { project?: string }).project === project).map(r => ({
                    requestId: r.id, target: r.target,
                    state: !r.sourceMailId ? 'not_authorized' : !currentTarget ? 'unverifiable' : hash(r.target) === hash(currentTarget) ? 'current' : 'requires_new_confirmation'
                }));
                projects.push({ project, operations, preDeployOperations: repo.deployment?.preDeployOperations || [], deploymentRequests, receipts: operationStatus(this.store, this.conversation.id, project) });
            } catch { projects.push({ project, availability: 'unavailable', instruction: 'Query project_operations or its compatibility entry for the current configuration error.' }); }
        }
        return '\n\nController operation context (current capability facts, never human authorization):\n' +
            'These facts supersede older capability and deployment-status claims in FEATURE.md or conversation history. Production checks use these configured controller operations; native SSH/project_command network probes do not test controller access. ' +
            'Use project_operations/project_operation when present. An older thread without those tools must use project_command with executable="mail-to-code-operation", cwd=".", network=false, args=["list","{}"] or ["run",JSON.stringify({operation,key,sourceMailId,evidence})]. ' +
            'Read operations need approved scope only. Writes still require explicit intent in a trusted new email; quote its sourceMailId/evidence. A requires_new_confirmation deployment request cannot execute: request a new exact deployment confirmation including its prerequisites. ' +
            'Never treat this context as mail evidence, repeat uncertain effects or create replacement keys to bypass recovery.\n' + JSON.stringify({ projects });
    }
    private scopedConfig() { return { ...this.config, dataDir: this.directory() }; }
    private async identify(p: {
        path: string;
        role: ScopeProject['role'];
    }): Promise<ScopeProject> {
        const root = await realpath(this.config.projectsRoot), path = await realpath(resolve(root, p.path));
        if (!path.startsWith(root + '/') && !projectLocations(this.config).some(p => p.path === path))
            throw Error('PROJECT_OUTSIDE_ROOT');
        if (await realpath(await git(path, ['rev-parse', '--show-toplevel'])) !== path)
            throw Error('EXPECTED_REPOSITORY_ROOT');
        const remote = await git(path, ['remote', 'get-url', 'origin']);
        const identity = /^(?:git@github.com:|https:\/\/github.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote)?.[1];
        if (!identity)
            throw Error('EXPECTED_GITHUB_IDENTITY');
        if (p.role !== 'reference' && [this.config.controllerRepository, ...this.config.protectedRepositories].includes(identity))
            throw Error('PROTECTED_REPOSITORY');
        return { ...p, path, identity };
    }
    private scope(name: string) {
        const actual = realpathSync(resolve(this.config.projectsRoot, name));
        const p = this.scopes().find(p => realpathSync(p.path) === actual);
        if (!p || p.role === 'reference')
            throw Error('WRITABLE_SCOPE_REQUIRED');
        return p;
    }
    private repo(name: string) {
        const p = this.scope(name);
        const entries = Object.entries(this.config.repositories).filter(([, r]) => canonical(r.path) === realpathSync(p.path) && r.github === p.identity);
        if (entries.length !== 1)
            throw Error('REPOSITORY_ADAPTER_NOT_PREPARED');
        return entries[0];
    }
    private async discover(name: string) {
        const p = this.scope(name);
        if (Object.values(this.config.repositories).some(r => canonical(r.path) === realpathSync(p.path) && r.github === p.identity))
            return;
        // Fetch/symbolic identity are infrastructure facts. Codex decides which repository belongs to the work.
        await git(p.path, ['fetch', 'origin'], { signal: this.signal });
        const branch = (await git(p.path, ['symbolic-ref', 'refs/remotes/origin/HEAD']).catch(async () => {
            const output = await git(p.path, ['ls-remote', '--symref', 'origin', 'HEAD'], { signal: this.signal });
            const match = /^ref: refs\/heads\/([^\t\r\n]+)\tHEAD$/m.exec(output);
            if (!match)
                throw Error('REMOTE_DEFAULT_BRANCH_REQUIRED');
            return 'refs/remotes/origin/' + match[1];
        })).replace(/^refs\/remotes\/origin\//, '');
        if (!branch || branch.startsWith('-') || /[\r\n]/.test(branch))
            throw Error('REMOTE_DEFAULT_BRANCH_REQUIRED');
        const alias = 'discovered-' + hash(p.identity).slice(0, 12), repo = { path: p.path, github: p.identity, baseBranch: branch, mergeMethod: 'merge' as const, checks: [] };
        const repositories = this.store.get<Config['repositories']>('repositories', this.conversation.id) || {};
        repositories[alias] = repo;
        this.store.put('repositories', this.conversation.id, repositories);
        this.config.repositories[alias] = repo;
    }
    private session(name: string) {
        const [, repo] = this.repo(name);
        const s = this.store.get<Session>('project', this.conversation.id + ':' + repo.path);
        if (!s?.worktree)
            throw Error('PREPARE_WORKTREE_FIRST');
        return s;
    }
    private saveProject(s: Session) { this.store.put('project', this.conversation.id + ':' + this.config.repositories[s.repo].path, s); }
    private async sourceDigest(s: Session) {
        const files = (await git(s.worktree!, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort();
        const digest = createHash('sha256');
        for (const file of [...new Set(files)]) {
            digest.update(file + '\0');
            const path = join(s.worktree!, file);
            try {
                const info = await lstat(path);
                digest.update(String(info.mode & 0o777) + '\0');
                digest.update(info.isSymbolicLink() ? await readlink(path) : info.isFile() ? await readFile(path) : 'submodule');
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw e;
                digest.update('deleted');
            }
            digest.update('\0');
        }
        return digest.digest('hex');
    }
    private async target(kind: ApprovalRequest['kind'], name?: string) {
        if (!name)
            throw Error('EXACT_PROJECT_REQUIRED');
        const s = this.session(name), [alias, repo] = this.repo(name);
        if (kind === 'merge') {
            if (!s.reviewSha || !s.prNumber)
                throw Error('PR_REQUIRED');
            return { project: alias, head: s.reviewSha, base: s.baseSha, pr: s.prNumber };
        }
        if (!s.mergeSha || !repo.deployment?.enabled)
            throw Error('MERGED_COMMIT_AND_DEPLOYMENT_PROFILE_REQUIRED');
        return { project: alias, commit: s.mergeSha, profileHash: await new OperationsAdapter(this.config, this.store, this.conversation.id).deployFingerprint(alias) };
    }
    async call(threadId: string, name: string, raw: unknown): Promise<unknown> {
        if (threadId !== this.conversation.codexThread)
            throw Error('PRIMARY_AGENT_ONLY');
        const schema = schemas[name];
        if (!schema)
            throw Error('UNKNOWN_BRIDGE_TOOL');
        const a = schema.parse(raw);
        if (name === 'project_command' && a.executable === 'mail-to-code-operation') {
            if (a.network || a.cwd !== '.' || a.args.length !== 2 || !['list', 'run', 'status'].includes(a.args[0])) throw Error('INVALID_OPERATION_COMPATIBILITY_CALL');
            let params: unknown;
            try { params = JSON.parse(a.args[1]); } catch { throw Error('INVALID_OPERATION_COMPATIBILITY_CALL'); }
            if (!params || typeof params !== 'object' || Array.isArray(params) || 'project' in params) throw Error('INVALID_OPERATION_COMPATIBILITY_CALL');
            return this.call(threadId, a.args[0] === 'list' ? 'project_operations' : a.args[0] === 'status' ? 'project_operation_status' : 'project_operation', { ...params, project: a.project });
        }
        if (name.startsWith('project_') && a.project) {
            const approved = this.scope(a.project), actual = await this.identify(approved);
            if (actual.identity !== approved.identity)
                throw Error('REPOSITORY_IDENTITY_CHANGED');
        }
        if (name === 'queue_mail' || name === 'request_confirmation') {
            let proposed: Omit<ApprovalRequest, 'id' | 'conversationId' | 'mailId'> | undefined;
            if (a.request) {
                const r = a.request;
                proposed = { kind: r.kind, target: r.kind === 'scope' ? ordered(await Promise.all((r.projects || []).map((p: any) => this.identify(p)))) : await this.target(r.kind, r.project) };
                if (r.kind === 'scope' && !(proposed.target as unknown[]).length)
                    throw Error('SCOPE_PROJECTS_REQUIRED');
            }
            if (this.config.asyncMailOutput === 'assistant-final') {
                const turnId = this.turnId || this.conversation.activeTurn;
                if (!turnId) throw Error('ACTIVE_TURN_REQUIRED');
                const prepared = proposed ? this.store.prepareConfirmation(this.conversation, turnId, a.key, proposed) : undefined;
                return { requestId: prepared?.id, target: prepared?.target, status: 'awaiting_final_response' };
            }
            if (name === 'request_confirmation') throw Error('ASSISTANT_FINAL_MODE_REQUIRED');
            const queued = this.store.queue(this.conversation, a.key, a.text, proposed);
            return { mailId: queued.mail.id, requestId: queued.request?.id, status: queued.mail.status };
        }
        if (name === 'record_authorization')
            return this.store.authorize(this.conversation.id, a.requestId, a.sourceMailId, a.evidence);
        if (name === 'project_operations') {
            const [alias] = this.repo(a.project);
            return new OperationsAdapter(this.config, this.store, this.conversation.id).list(alias);
        }
        if (name === 'project_operation_status') {
            const [alias] = this.repo(a.project);
            return operationStatus(this.store, this.conversation.id, alias, a.operationId);
        }
        if (name === 'project_operation') {
            const [alias, repo] = this.repo(a.project), adapter = new OperationsAdapter(this.config, this.store, this.conversation.id);
            return withProjectOperationLock(this.config, alias, async () => {
                const binding = await adapter.binding(alias, a.operation), definition = repo.operations![a.operation];
                let authorization: unknown = null;
                if (definition.effect === 'write') {
                    if (!a.sourceMailId || !a.evidence?.trim()) throw Error('OPERATION_MAIL_EVIDENCE_REQUIRED');
                    const input = this.store.input(a.sourceMailId);
                    if (!input || input.conversationId !== this.conversation.id || !input.incoming.trusted || !a.evidence?.trim() || !input.incoming.text.includes(a.evidence)) throw Error('OPERATION_MAIL_EVIDENCE_REQUIRED');
                    authorization = { sourceMailId: a.sourceMailId, evidence: a.evidence };
                    const id = this.conversation.id + ':' + digest({ project: alias, operation: a.operation, sourceMailId: a.sourceMailId });
                    const recorded = this.store.get<unknown>('operation-authorization', id), value = { binding, key: a.key, authorization };
                    if (recorded && digest(recorded) !== digest(value)) throw Error('OPERATION_AUTHORIZATION_ALREADY_BOUND');
                    adapter.assertNoUncertainWrites(alias, this.conversation.id + ':operation:' + alias + ':' + a.key);
                    this.store.put('operation-authorization', id, value);
                }
                return adapter.run(alias, a.operation, a.key, authorization, this.signal, binding);
            });
        }
        if (name === 'grant_scope') {
            const e = this.store.input(a.sourceMailId);
            if (!e || e.conversationId !== this.conversation.id || !e.incoming.trusted || !a.evidence.trim() || !e.incoming.text.includes(a.evidence))
                throw Error('SCOPE_EVIDENCE_REQUIRED');
            const next = ordered(await Promise.all(a.projects.map((p: any) => this.identify(p)))), previous = this.scopes();
            if (new Set(next.map(p => p.path)).size !== next.length)
                throw Error('DUPLICATE_PROJECT');
            const expanded = previous.length && next.some(p => !previous.some(old => old.identity === p.identity && old.path === p.path && (old.role === p.role || old.role !== 'reference' && p.role === 'reference')));
            if (expanded) {
                if (!a.requestId)
                    throw Error('SCOPE_CHANGE_REQUIRES_EXPLICIT_REPLY');
                const approved = this.store.authorize(this.conversation.id, a.requestId, a.sourceMailId, a.evidence);
                if (approved.kind !== 'scope' || hash(approved.target) !== hash(next))
                    throw Error('SCOPE_REQUEST_CHANGED');
            }
            // Scope is additive. A read-only mention cannot revoke or downgrade an existing grant.
            const merged = [...previous];
            for (const p of next) {
                const at = merged.findIndex(old => old.path === p.path);
                if (at < 0)
                    merged.push(p);
                else if (merged[at].role === 'reference')
                    merged[at] = p;
                else if (merged[at].identity !== p.identity)
                    throw Error('REPOSITORY_IDENTITY_CHANGED');
            }
            this.store.put('scope', this.conversation.id, merged);
            return merged;
        }
        if (name === 'project_worktree') {
            await this.discover(a.project);
            const [alias, repo] = this.repo(a.project), key = this.conversation.id + ':' + repo.path;
            const old = this.store.get<Session>('project', key);
            if (old?.worktree) {
                const exists = await stat(old.worktree).then(() => true, e => {
                    if (e.code === 'ENOENT')
                        return false;
                    throw e;
                });
                if (exists) {
                    if (await realpath(resolve(old.worktree, await git(old.worktree, ['rev-parse', '--git-common-dir']))) !== await realpath(resolve(repo.path, await git(repo.path, ['rev-parse', '--git-common-dir']))))
                        throw Error('WORKTREE_IDENTITY_CHANGED');
                    return { project: a.project, adapter: alias, path: old.worktree, branch: old.branch, base: old.baseSha, profile: this.config.profiles[alias] };
                }
            }
            const s: Session = { id: this.conversation.id + '-' + hash(repo.github).slice(0, 8), repo: alias, title: this.conversation.subject, subject: this.conversation.subject, state: 'RUNNING', summary: '', createdAt: this.conversation.createdAt, initialMessageId: '', initialRfcId: '', initialThreadId: this.conversation.gmailThread, cancellationEpoch: 0, revision: 1 };
            const adapter = new GitAdapter(this.scopedConfig(), new Runner(this.config));
            await adapter.prepare(s, this.signal, () => this.saveProject(s));
            this.saveProject(s);
            if (!this.config.profiles[alias]) {
                const profile = await proposeProfile(alias, s.worktree!), profiles = this.store.get<Config['profiles']>('profiles', this.conversation.id) || {};
                profiles[alias] = profile;
                this.store.put('profiles', this.conversation.id, profiles);
                this.config.profiles[alias] = profile;
            }
            return { project: a.project, adapter: alias, path: s.worktree, branch: s.branch, base: s.baseSha, profile: this.config.profiles[alias] };
        }
        if (name === 'project_command') {
            const s = this.session(a.project), tree = await realpath(s.worktree!), cwd = await realpath(resolve(tree, a.cwd));
            if (cwd !== tree && !cwd.startsWith(tree + '/'))
                throw Error('COMMAND_OUTSIDE_WORKTREE');
            const configured = this.config.profiles[s.repo], sources = configured?.packageSources;
            const checkId = this.conversation.id + ':' + hash({ project: s.repo, executable: a.executable, args: a.args, cwd: a.cwd });
            try {
                const before = await this.sourceDigest(s), result = await new Runner(this.config).check(s.worktree!, a.executable, a.args, cwd, this.signal, a.network, { sources, policy: asyncPolicy(this.config, this.conversation) }), after = await this.sourceDigest(s);
                this.store.put('check', checkId, { id: checkId, project: s.repo, digest: after, executable: a.executable, args: a.args, cwd: a.cwd, ok: before === after });
                return { ok: true, checkId: before === after ? checkId : undefined, ...result };
            }
            catch (e) {
                this.signal.throwIfAborted();
                this.store.put('check', checkId, { id: checkId, project: s.repo, ok: false });
                return { ok: false, error: e instanceof Error ? e.message : 'CHECK_FAILED', stdout: (e as any).stdout || '', stderr: (e as any).stderr || '' };
            }
        }
        if (name === 'project_sync_base') {
            const s = this.session(a.project), adapter = new GitAdapter(this.scopedConfig(), new Runner(this.config));
            try {
                const changed = await adapter.updateBase(s, this.signal);
                this.saveProject(s);
                return { ok: true, changed, base: s.baseSha };
            }
            catch (e) {
                this.signal.throwIfAborted();
                return { ok: false, error: e instanceof Error ? e.message : 'GIT_BASE_UPDATE_FAILED', stdout: (e as any).stdout || '', stderr: (e as any).stderr || '', worktree: s.worktree };
            }
        }
        if (name === 'project_pr') {
            const s = this.session(a.project);
            s.summary = a.summary;
            const adapter = new GitAdapter(this.scopedConfig(), new Runner(this.config));
            const digest = await this.sourceDigest(s), receipts = a.checks.map((id: string) => this.store.get<any>('check', id));
            if (receipts.some((r: any) => !r || r.project !== s.repo || !r.ok || r.digest !== digest))
                throw Error('CURRENT_SOURCE_CHECK_RECEIPTS_REQUIRED');
            const profile = this.config.profiles[s.repo], required = [...this.config.repositories[s.repo].checks, ...(profile?.build || []), ...(profile?.checks || [])];
            if (required.some(command => !receipts.some((r: any) => r.executable === command.executable && JSON.stringify(r.args) === JSON.stringify(command.args) && r.cwd === command.cwd)))
                throw Error('REQUIRED_CHECKS_NOT_PASSED');
            const checks = receipts.map((r: any) => [r.executable, ...r.args].join(' ') + ' (passed; source ' + digest.slice(0, 12) + ')');
            if (profile?.kind === 'docs')
                checks.push(...await markdownChecks(s.worktree!));
            s.reviewSha = await adapter.commit(s, this.signal);
            this.saveProject(s);
            // External mutations have durable intent. Never replay an unknown push/PR outcome.
            return this.store.effect(this.conversation.id, 'pr:' + s.repo + ':' + s.reviewSha, { project: s.repo, head: s.reviewSha, summary: a.summary, checks: a.checks }, async () => { await adapter.push(s, this.signal); await new GitHubAdapter(this.config, s.repo).ensurePr(s, checks, this.signal); this.saveProject(s); return { url: s.prUrl, number: s.prNumber, head: s.reviewSha }; });
        }
        if (name === 'project_merge' || name === 'project_deploy') {
            const r = this.store.get<ApprovalRequest>('request', a.requestId), kind = name === 'project_merge' ? 'merge' : 'deploy';
            if (!r || r.conversationId !== this.conversation.id || r.kind !== kind || !r.sourceMailId)
                throw Error('EXPLICIT_OPERATION_AUTHORIZATION_REQUIRED');
            const target = r.target as {
                project: string;
            }, repo = this.config.repositories[target.project];
            if (!repo)
                throw Error('OPERATOR_ADAPTER_MISSING');
            const approved = this.scope(repo.path), actual = await this.identify(approved);
            if (actual.identity !== approved.identity)
                throw Error('REPOSITORY_IDENTITY_CHANGED');
            const s = this.session(repo.path);
            const recorded = this.store.get<import('./async-store.js').Operation>('operation', this.conversation.id + ':' + kind + ':' + a.requestId);
            if (kind === 'deploy' && recorded?.status === 'done' && (recorded.result as any)?.outcome === 'confirmed-failed' && (recorded.result as any)?.ok === false) {
                if (hash(recorded.input) !== hash(r.target)) throw Error('OPERATION_KEY_INPUT_MISMATCH');
                return recorded.result; // A historical failed receipt is not a new production effect.
            }
            if (hash(r.target) !== hash(await this.target(kind, repo.path)))
                throw Error('APPROVED_OPERATION_TARGET_CHANGED');
            const effect = () => this.store.effect(this.conversation.id, kind + ':' + a.requestId, r.target, async () => {
                if (kind === 'merge') {
                    s.mergeSha = await new GitHubAdapter(this.config, s.repo).merge(s, this.signal);
                    this.saveProject(s);
                    return { commit: s.mergeSha };
                }
                const adapter = new GitAdapter(this.scopedConfig(), new Runner(this.config)), runtime = new RuntimeAdapter(this.config, new Runner(this.config));
                const profile = this.config.profiles[s.repo];
                if (!profile)
                    throw Error('OPERATOR_RUNTIME_PROFILE_REQUIRED');
                const operations = new OperationsAdapter(this.config, this.store, this.conversation.id);
                const attemptId = randomUUID();
                const journal = new OperationJournal(this.config, this.store, this.conversation.id + ':deploy:' + a.requestId);
                try {
                    await new DeployAdapter(this.scopedConfig(), adapter, () => this.saveProject(s), (release, signal) => runtime.run(release.worktree!, profile, signal),
                        async signal => {
                            const receipts = await operations.preDeploy(s.repo, a.requestId, signal, (r.target as { profileHash: string }).profileHash, attemptId);
                            journal.update({ prerequisites: receipts });
                        }, journal).deploy(s, this.signal);
                    s.deployUncertain = false;
                    this.saveProject(s);
                    journal.update({ status: 'succeeded' });
                    return { commit: s.mergeSha, release: s.deployRelease };
                } catch (error) {
                    const prerequisites = this.store.all<import('./async-store.js').Operation>('operation').filter(op => {
                        const input = op.input as any;
                        return op.conversationId === this.conversation.id && input?.project === s.repo && input.authorization?.deployRequestId === a.requestId && input.authorization?.attemptId === attemptId;
                    }).flatMap(op => { const result = ReceiptSchema.safeParse(op.result); return result.success ? [result.data] : []; });
                    journal.update({ prerequisites }); journal.failed(error);
                    throw error;
                } finally { journal.close(); }
            });
            return kind === 'deploy' ? withProjectOperationLock(this.config, target.project, async () => {
                new OperationsAdapter(this.config, this.store, this.conversation.id).assertNoUncertainWrites(target.project, this.conversation.id + ':deploy:' + a.requestId);
                return effect();
            }) : effect();
        }
        throw Error('UNKNOWN_BRIDGE_TOOL');
    }
    async initializeFeature() {
        const notes = join(this.directory(), 'notes');
        await Promise.all(['notes', 'input', 'worktrees'].map(name => mkdir(join(this.directory(), name), { recursive: true, mode: 0o700 })));
        const path = join(notes, 'FEATURE.md');
        try {
            await stat(path);
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                throw e;
            const { writeFile } = await import('node:fs/promises');
            await writeFile(path, `# ${this.conversation.subject.replace(/[\r\n]/g, ' ')}\n\nRecord requirements, decisions, progress, issues, validation and PR evidence here.\nRuntime IDs and operation grants are maintained by the bridge.\n`, { mode: 0o600, flag: 'wx' });
        }
        return path;
    }
    async reconcile(operationId: string, verifiedNoEffect = false) {
        const op = this.store.get<import('./async-store.js').Operation>('operation', operationId);
        if (!op || op.conversationId !== this.conversation.id || op.status === 'done')
            throw Error('UNCERTAIN_OPERATION_REQUIRED');
        const kind = op.key.split(':')[0], input = op.input as any;
        const alias = input.project, repo = this.config.repositories[alias];
        if (!repo)
            throw Error('OPERATOR_ADAPTER_MISSING');
        if (kind === 'operation') {
            return withProjectOperationLock(this.config, alias, async () => {
                const adapter = new OperationsAdapter(this.config, this.store, this.conversation.id);
                if (verifiedNoEffect) {
                    this.store.put('operation-audit', op.id + ':' + Date.now(), op);
                    this.store.remove('operation', op.id);
                    return { verified: false, operatorReset: true, replayed: false };
                }
                return adapter.reconcile(op, this.signal);
            });
        }
        const s = this.session(repo.path), github = new GitHubAdapter(this.config, alias);
        let result: unknown;
        if (kind === 'pr') {
            const matches = await github.findPr({ ...s, reviewSha: input.head }, this.signal);
            if (matches.length === 1) {
                s.prNumber = matches[0].number;
                s.prUrl = matches[0].html_url;
                result = { url: s.prUrl, number: s.prNumber, head: input.head };
            }
            else if (matches.length > 1)
                throw Error('AMBIGUOUS_PR_IDENTITY');
        }
        else if (kind === 'merge') {
            const pr = await github.pr({ ...s, prNumber: input.pr }, this.signal);
            if (pr.head.sha !== input.head)
                throw Error('PR_TARGET_CHANGED');
            if (pr.merged) {
                s.mergeSha = pr.merge_commit_sha;
                result = { commit: s.mergeSha };
            }
        }
        else if (kind === 'deploy') {
            if (await new OperationsAdapter(this.config, this.store, this.conversation.id).deployFingerprint(alias) !== input.profileHash)
                throw Error('DEPLOYMENT_PROFILE_CHANGED');
            const adapter = new DeployAdapter(this.scopedConfig(), new GitAdapter(this.scopedConfig(), new Runner(this.config)));
            if (await adapter.reconcile({ ...s, mergeSha: input.commit })) {
                s.deployUncertain = false;
                result = { commit: input.commit, release: adapter.release({ ...s, mergeSha: input.commit }) };
            }
        }
        else
            throw Error('UNKNOWN_OPERATION_KIND');
        if (result) {
            this.saveProject(s);
            op.status = 'done';
            op.result = result;
            this.store.put('operation', op.id, op);
            return { verified: true, result };
        }
        // Absence is never automatic retry evidence. Only an operator's explicit inspection permits reset.
        if (verifiedNoEffect) {
            this.store.put('operation-audit', op.id + ':' + Date.now(), op);
            this.store.remove('operation', op.id);
            return { verified: false, operatorReset: true, replayed: false };
        }
        return { verified: false, uncertain: true };
    }
    async resolveFailed(operationId: string, raw: unknown) {
        const evidence = FailedResolutionSchema.parse(raw), op = this.store.get<import('./async-store.js').Operation>('operation', operationId);
        if (!op || op.conversationId !== this.conversation.id || !op.key.startsWith('deploy:')) throw Error('DEPLOY_OPERATION_REQUIRED');
        if (evidence.operationId !== op.id || evidence.project !== (op.input as any)?.project || evidence.fingerprint !== (op.input as any)?.profileHash) throw Error('RESOLUTION_TARGET_MISMATCH');
        if (op.status === 'done') {
            const audit = this.store.get('failed-resolution', op.id);
            if (digest(audit) !== digest(evidence)) throw Error('RESOLUTION_ALREADY_RECORDED');
            return op.result;
        }
        return withProjectOperationLock(this.config, evidence.project, async () => this.store.transaction(() => {
            this.store.put('operation-audit', op.id + ':before-failed-resolution', op);
            this.store.put('failed-resolution', op.id, evidence);
            op.status = 'done';
            op.result = { ok: false, outcome: 'confirmed-failed', summary: evidence.summary, evidence: evidence.evidence, effects: evidence.effects, inspectedAt: evidence.inspectedAt };
            if (op.report) op.report.status = 'confirmed-failed';
            this.store.put('operation', op.id, op);
            const s = this.session(this.config.repositories[evidence.project].path);
            s.deployUncertain = false; this.saveProject(s);
            return op.result;
        }));
    }
}
