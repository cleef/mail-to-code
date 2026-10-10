import type { Rpc, ServerRequest } from './app-server.js';
import type { Conversation } from './async-store.js';

export type Executor = 'codex' | 'claude';
export const executorOf = (c: Conversation): Executor => c.executor || 'codex';
export const sessionOf = (c: Conversation) => c.executorSession || c.codexThread;
export const executorLabel = (c: Conversation) => executorOf(c) === 'claude' ? 'Claude Code' : 'Codex';
export function selectExecutor(subject: string): Executor {
    return /^\s*\[claude\]/i.test(subject) ? 'claude' : 'codex';
}
// Adapters normalize native lifecycle/history into the bridge's existing protocol.
export interface ExecutorClient extends Rpc {
    readonly supportsSteering?: boolean;
    on(event: string, listener: (...args: any[]) => void): unknown;
    start(): Promise<void>;
}
export type ClientFactory = (c: Conversation, handler: (r: ServerRequest) => Promise<unknown>) => Promise<ExecutorClient>;
