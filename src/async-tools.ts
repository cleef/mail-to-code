import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v3';
import type { Config } from './config.js';
import { AsyncStore, type Conversation } from './async-store.js';
import { sessionOf } from './executor.js';

export const ASYNC_TOOLS = [{ type: 'function', name: 'queue_mail',
    description: 'Queue one user-facing email in queue-mail mode. Only the primary session may send. This is transport only; explain questions and confirmations in ordinary prose.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, text: { type: 'string' } }, required: ['key', 'text'] } }];
const retired = new Set(['request_confirmation', 'grant_scope', 'record_authorization', 'workspace_command',
    'project_worktree', 'project_sync_base', 'project_command', 'project_checks', 'project_operations',
    'project_operation_status', 'project_operation', 'project_pr', 'project_merge', 'project_deploy']);
export class AsyncTools {
    constructor(readonly config: Config, readonly store: AsyncStore, readonly conversation: Conversation, readonly signal: AbortSignal, readonly turnId?: string) {}
    directory() { return join(this.config.dataDir, 'async-cli', 'features', this.conversation.id); }
    async initializeFeature() {
        await Promise.all(['input', 'notes', 'worktrees', 'tmp'].map(name => mkdir(join(this.directory(), name), { recursive: true, mode: 0o700 })));
        const path = join(this.directory(), 'notes', 'FEATURE.md');
        try { await writeFile(path, `# ${this.conversation.subject.replace(/[\r\n]/g, ' ')}\n\nRecord requirements, decisions, progress, issues, validation and PR evidence here.\n`, { flag: 'wx', mode: 0o600 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        return path;
    }
    async call(threadId: string, name: string, raw: unknown): Promise<unknown> {
        if (!threadId || threadId !== sessionOf(this.conversation)) throw Error('PRIMARY_AGENT_ONLY');
        if (retired.has(name) || name.startsWith('project_')) return { ok: false, error: 'TOOL_RETIRED_USE_NATIVE', instruction: '工具已退役，请使用原生工具。Use native shell/file/Git/gh tools inside the sandbox. Ask for merge or deployment confirmation in an ordinary email; no scope, request ID, target hash or evidence binding is required.' };
        if (name !== 'queue_mail') throw Error('UNKNOWN_MAIL_TOOL');
        // Old thread schemas may still supply request. Ignore it, never create an approval.
        const a = z.object({ key: z.string().min(1).max(200), text: z.string().min(1).max(50000), request: z.unknown().optional() }).strict().parse(raw);
        if (this.config.asyncMailOutput === 'assistant-final') return { status: 'awaiting_final_response', instruction: 'Write the user-facing reply as your final assistant message. No separate email or authorization record was created.' };
        const heldId = this.conversation.id + ':' + a.key;
        try {
            const { mail } = this.store.queue(this.conversation, a.key, a.text);
            const held = this.store.get<any>('mail-held', heldId);
            if (held) this.store.put('mail-held', heldId, { ...held, status: 'resolved', mailId: mail.id });
            return { mailId: mail.id, status: mail.status };
        } catch (error) {
            if (error instanceof Error && /^MAIL_(?:IMAGE_|ATTACHMENTS_|BODY_)/.test(error.message)) this.store.put('mail-held', heldId, { conversationId: this.conversation.id, key: a.key, status: 'held', reason: error.message });
            throw error;
        }
    }
}
