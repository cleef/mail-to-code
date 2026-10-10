import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { access, realpath, readFile, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { createSdkMcpServer, query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.js';
import type { ServerRequest } from './app-server.js';
import type { ExecutorClient } from './executor.js';
import { sessionOf } from './executor.js';
import type { AsyncStore, Conversation } from './async-store.js';
import { ASYNC_TOOLS, WORKSPACE_TOOL } from './async-tools.js';
import { execute } from './process.js';
import { shellEnvironment } from './runner.js';

export const ASYNC_CLAUDE_VERSION = '2.1.296';
const DEFINITIONS = [...ASYNC_TOOLS, WORKSPACE_TOOL];
const toolNames = DEFINITIONS.map(t => 'mcp__mail_to_code__' + t.name);
export interface ClaudeRun extends AsyncIterable<any> {
    initializationResult(): Promise<any>;
    close(): void;
}
export interface ClaudeRuntime {
    query(args: { prompt: AsyncIterable<any>; options: Options }): ClaudeRun;
    messages(id: string, cwd: string): Promise<any[]>;
    environment(): Promise<NodeJS.ProcessEnv>;
}
const runtime: ClaudeRuntime = {
    query,
    messages: async (id, dir) => (await import('@anthropic-ai/claude-agent-sdk')).getSessionMessages(id, { dir }),
    environment: () => claudeEnvironment(join(homedir(), '.claude', 'settings.json')),
};
type Turn = { id: string; status: string; items: any[] };
type Journal = { conversationId: string; sessionId: string; promptId: string; prompt: string; accepted: boolean; turn: Turn };
const contentText = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';

export async function claudeExecutable(command: string) {
    const paths = isAbsolute(command) ? [command] : (process.env.PATH || '').split(delimiter).map(dir => join(dir, command));
    for (const path of paths) {
        try { await access(path, constants.X_OK); return await realpath(path); } catch { /* try PATH */ }
    }
    throw Error('CLAUDE_EXECUTABLE_UNAVAILABLE');
}
export async function checkClaude(command: string) {
    const path = await claudeExecutable(command);
    const version = await execute(path, ['--version'], { env: shellEnvironment(), timeoutMs: 15000 });
    if (version.stdout.trim() !== `${ASYNC_CLAUDE_VERSION} (Claude Code)`) throw Error(`ASYNC_CLAUDE_VERSION_REQUIRED:${ASYNC_CLAUDE_VERSION}`);
    return path;
}
const authKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'] as const;
// Read only operator-owned model transport values. Never execute settings,
// inherit hook/plugin definitions or pass credentials to workspace commands.
export async function claudeEnvironment(settingsFile: string, environment: NodeJS.ProcessEnv = process.env) {
    let settings: Record<string, unknown> = {};
    try {
        const info = await lstat(settingsFile);
        if (!info.isFile() || (info.mode & 0o077) || info.size > 65536) throw Error('CLAUDE_AUTH_SETTINGS_INVALID');
        const parsed = JSON.parse(await readFile(settingsFile, 'utf8'));
        if (parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)) settings = parsed.env;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('CLAUDE_AUTH_SETTINGS_INVALID');
    }
    const result = shellEnvironment();
    for (const key of authKeys) {
        const value = environment[key] ?? settings[key];
        if (value !== undefined && typeof value !== 'string') throw Error('CLAUDE_AUTH_SETTINGS_INVALID');
        if (typeof value === 'string' && value) result[key] = value;
    }
    return result;
}
export function claudeOptions(config: Config, executable: string, environment = shellEnvironment()): Options {
    return {
        pathToClaudeCodeExecutable: executable, cwd: config.projectsRoot,
        env: { ...environment, CLAUDE_CODE_SAFE_MODE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        tools: [], allowedTools: toolNames, permissionMode: 'dontAsk', permissionPrompts: 'none',
        settingSources: [], strictMcpConfig: true, plugins: [], persistSession: true,
        settings: { disableAllHooks: true, autoMemoryEnabled: false },
        extraArgs: { 'disable-slash-commands': null, 'replay-user-messages': null },
    };
}

// Only controller tools run commands. Claude's process owns model authentication
// and native history, but has no model-callable native tools, hooks or plugins.
export class ClaudeClient extends EventEmitter implements ExecutorClient {
    readonly supportsSteering = false;
    private session = '';
    private instructions = '';
    private executable = '';
    private environment = shellEnvironment();
    private active?: ClaudeRun;
    private running?: Promise<void>;
    private stopped = false;
    constructor(readonly config: Config, readonly store: AsyncStore, readonly conversation: Conversation,
        readonly handler: (r: ServerRequest) => Promise<unknown>, readonly sdk: ClaudeRuntime = runtime,
        readonly check: (command: string) => Promise<string> = checkClaude) { super(); }
    async start() { this.executable = await this.check(this.config.claudeCommand); this.environment = await this.sdk.environment(); }
    private journals() { return this.store.all<Journal>('claude-turn').filter(t => t.conversationId === this.conversation.id && t.sessionId === this.session); }
    private save(journal: Journal) { this.store.put('claude-turn', journal.turn.id, journal); }
    private async history() {
        const journals = this.journals();
        if (!journals.length) return [];
        const messages = await this.sdk.messages(this.session, this.config.projectsRoot);
        return journals.map(journal => {
            const hit = messages.find(m => m.type === 'user' && !m.parent_tool_use_id && m.session_id === this.session && m.uuid === journal.promptId && contentText(m.message?.content) === journal.prompt);
            if (hit && !journal.accepted) { journal.accepted = true; this.save(journal); }
            // Missing evidence for an unacknowledged input is never acceptance.
            if (!journal.accepted) return { ...journal.turn, status: 'interrupted', items: [] };
            return { ...journal.turn, status: journal.turn.status === 'inProgress' && !this.active ? 'interrupted' : journal.turn.status };
        });
    }
    async request(method: string, params: any): Promise<any> {
        if (method === 'thread/start' || method === 'thread/resume') {
            this.session = params.threadId || sessionOf(this.conversation) || randomUUID();
            this.instructions = params.developerInstructions;
            return { thread: { id: this.session } };
        }
        if (!this.session || params.threadId !== this.session) throw Error('CLAUDE_SESSION_MISMATCH');
        if (method === 'thread/read') return { thread: { id: this.session, turns: await this.history() } };
        if (method !== 'turn/start') throw Error('CLAUDE_UNSUPPORTED_REQUEST');
        if (this.running) throw Error('CLAUDE_TURN_BUSY');
        const journal: Journal = { conversationId: this.conversation.id, sessionId: this.session,
            promptId: randomUUID(), prompt: params.input.map((i: any) => i.text).join('\n'), accepted: false,
            turn: { id: 'claude:' + randomUUID(), status: 'inProgress', items: [{ type: 'userMessage', content: params.input }] } };
        const resume = this.journals().length > 0;
        // Durable intent precedes passing any input to the native process.
        this.save(journal);
        return new Promise((resolve, reject) => {
            let acknowledged = false;
            const accept = () => {
                journal.accepted = true; this.save(journal); acknowledged = true;
                resolve({ turn: journal.turn });
            };
            this.running = this.run(journal, resume, accept).catch(error => {
                const reason = error instanceof Error && /^CLAUDE_[A-Z_]+$/.test(error.message) ? error.message : 'CLAUDE_RUNTIME_UNAVAILABLE';
                this.store.put('claude-fault', this.conversation.id, { turnId: journal.turn.id,
                    reason });
                if (!acknowledged) reject(Error('CLAUDE_INPUT_ACK_UNCERTAIN'));
                this.emit('fault', Error(reason));
            }).finally(() => { this.running = undefined; this.active = undefined; });
        });
    }
    private async run(journal: Journal, resume: boolean, accept: () => void) {
        let release!: () => void;
        const ready = new Promise<void>(resolve => { release = resolve; });
        const session = this.session;
        const prompt = (async function* () {
            await ready;
            yield { type: 'user', uuid: journal.promptId, session_id: session, parent_tool_use_id: null,
                client_composed: true, message: { role: 'user', content: journal.prompt } };
        })();
        const server = createSdkMcpServer({ name: 'mail_to_code', version: '1.0.0', alwaysLoad: true, tools: DEFINITIONS.map(definition => ({
            name: definition.name, description: definition.description,
            inputSchema: (z.fromJSONSchema(definition.inputSchema as any) as z.ZodObject).shape,
            handler: async (args: unknown) => {
                if (this.stopped || !journal.accepted) return { content: [{ type: 'text' as const, text: 'MAIL_INPUT_NOT_ACKNOWLEDGED' }], isError: true };
                const result = await this.handler({ id: randomUUID(), method: 'item/tool/call', params: {
                    threadId: session, turnId: journal.turn.id, tool: definition.name, arguments: args,
                } }) as { contentItems: { text: string }[]; success: boolean };
                return { content: result.contentItems.map(item => ({ type: 'text' as const, text: item.text })), isError: !result.success };
            },
        })) });
        const run = this.sdk.query({ prompt, options: { ...claudeOptions(this.config, this.executable, this.environment),
            ...(resume ? { resume: session } : { sessionId: session }),
            systemPrompt: { type: 'custom', prompt: this.instructions, snapshot: false },
            mcpServers: { mail_to_code: server },
        } });
        this.active = run;
        const timer = setTimeout(() => run.close(), this.config.timeoutSeconds * 1000);
        let resultSeen = false;
        try {
            const init = await run.initializationResult();
            // Fail closed if native tools or missing bridge tools change the contract.
            // initializationResult supplies capabilities; the system init event below
            // supplies the actual model-visible tool inventory.
            if (!init) throw Error('CLAUDE_INITIALIZATION_MISSING');
            release();
            for await (const event of run) {
                if (event.parent_tool_use_id) continue;
                if (event.session_id && event.session_id !== session) throw Error('CLAUDE_SESSION_MISMATCH');
                if (event.type === 'system' && event.subtype === 'init') {
                    if (!Array.isArray(event.tools) || event.tools.some((name: string) => !toolNames.includes(name) && name !== 'EndConversation' && name !== 'ToolSearch') || !toolNames.every(name => event.tools.includes(name))) throw Error('CLAUDE_TOOL_ISOLATION_FAILED');
                }
                if (event.type === 'user' && event.uuid === journal.promptId && contentText(event.message?.content) === journal.prompt && !journal.accepted) accept();
                if (event.type !== 'result') continue;
                if (event.origin?.kind === 'task-notification' || event.user_message_uuid && event.user_message_uuid !== journal.promptId || event.user_message_uuids && !event.user_message_uuids.includes(journal.promptId)) throw Error('CLAUDE_RESULT_INPUT_MISMATCH');
                if (!journal.accepted) {
                    const messages = await this.sdk.messages(session, this.config.projectsRoot);
                    if (!messages.some(m => m.type === 'user' && m.uuid === journal.promptId && m.session_id === session && !m.parent_tool_use_id && contentText(m.message?.content) === journal.prompt)) throw Error('CLAUDE_INPUT_ACK_UNCERTAIN');
                    accept();
                }
                journal.turn.status = event.subtype === 'success' && !event.is_error ? 'completed' : 'failed';
                if (journal.turn.status === 'failed') this.store.put('claude-fault', this.conversation.id, { turnId: journal.turn.id, reason: 'CLAUDE_TURN_FAILED', subtype: event.subtype });
                if (journal.turn.status === 'completed' && typeof event.result === 'string' && event.result.trim()) {
                    journal.turn.items.push({ id: event.uuid, type: 'agentMessage', phase: 'final_answer', text: event.result });
                }
                this.save(journal);
                resultSeen = true;
                this.emit('notification', 'turn/completed', { threadId: session, turn: journal.turn });
                break;
            }
            if (!resultSeen) throw Error('CLAUDE_RESULT_MISSING');
        } finally { clearTimeout(timer); release(); run.close(); }
    }
    async close() {
        this.stopped = true;
        this.active?.close();
        await this.running;
    }
}
