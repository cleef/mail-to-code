import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { shellEnvironment } from './runner.js';
export interface Rpc {
    request(method: string, params: unknown): Promise<any>;
    close(): Promise<void>;
}
export interface ServerRequest {
    id: number | string;
    method: string;
    params: any;
}
export class AppServer extends EventEmitter implements Rpc {
    private child?: ChildProcessWithoutNullStreams;
    private sequence = 0;
    private pending = new Map<number, {
        resolve: (v: any) => void;
        reject: (e: Error) => void;
        timer: NodeJS.Timeout;
    }>();
    private stopped = false;
    private diagnostic = '';
    private closing?: Promise<void>;
    constructor(readonly command: string, readonly args: string[], readonly cwd: string, readonly handler: (r: ServerRequest) => Promise<unknown>, readonly timeoutMs = 60000) { super(); }
    async start() {
        this.child = spawn(this.command, ['app-server', ...this.args, '--stdio'], { cwd: this.cwd, env: shellEnvironment(), stdio: 'pipe', detached: true });
        const lines = createInterface({ input: this.child.stdout });
        lines.on('line', line => {
            try {
                const message = JSON.parse(line);
                void this.receive(message).catch(e => this.emit('fault', e));
            }
            catch {
                this.emit('fault', Error('APP_SERVER_INVALID_JSON'));
            }
        });
        this.child.stderr.on('data', chunk => { this.diagnostic = (this.diagnostic + chunk.toString()).slice(-4000); });
        const died = () => {
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(Object.assign(Error('APP_SERVER_DISCONNECTED'), { diagnostic: this.diagnostic }));
            }
            this.pending.clear();
            if (!this.stopped)
                this.emit('fault', Error('APP_SERVER_DISCONNECTED'));
        };
        this.child.once('error', died);
        this.child.once('exit', died);
        await this.request('initialize', { clientInfo: { name: 'mail_to_code_async', title: 'Mail asynchronous CLI', version: '1' }, capabilities: { experimentalApi: true } });
        this.write({ method: 'initialized' });
    }
    private write(value: unknown) {
        if (!this.child || this.child.killed)
            throw Error('APP_SERVER_NOT_RUNNING');
        this.child.stdin.write(JSON.stringify(value) + '\n');
    }
    private async receive(m: any) {
        if (m.method && m.id !== undefined) {
            try {
                const result = await this.handler(m);
                this.write({ id: m.id, result });
            }
            catch (e) {
                this.write({ id: m.id, error: { code: -32000, message: e instanceof Error ? e.message : 'HOST_TOOL_FAILED' } });
            }
        }
        else if (m.method)
            this.emit('notification', m.method, m.params);
        else if (m.id !== undefined) {
            const p = this.pending.get(m.id);
            if (!p)
                return;
            this.pending.delete(m.id);
            clearTimeout(p.timer);
            if (m.error)
                p.reject(Error(m.error.message || 'APP_SERVER_RPC_ERROR'));
            else
                p.resolve(m.result);
        }
    }
    request(method: string, params: unknown): Promise<any> {
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(Error('APP_SERVER_ACK_UNCERTAIN:' + method)); }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.write({ id, method, params });
            }
            catch (e) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(e);
            }
        });
    }
    async close() {
        if (this.closing)
            return this.closing;
        this.stopped = true;
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null)
            return;
        this.closing = (async () => { const exited = new Promise<void>(r => child.once('exit', () => r())); const kill = (signal: NodeJS.Signals) => { try {
            if (child.pid)
                process.kill(-child.pid, signal);
        }
        catch {
            child.kill(signal);
        } }; kill('SIGTERM'); const timer = setTimeout(() => kill('SIGKILL'), 3000); await exited; clearTimeout(timer); })();
        return this.closing;
    }
}
export function denyInteractive(r: ServerRequest) {
    if (r.method === 'item/commandExecution/requestApproval' || r.method === 'item/fileChange/requestApproval')
        return { decision: 'decline' };
    if (r.method === 'item/permissions/requestApproval')
        return { permissions: {}, scope: 'turn' };
    // An unanswered request is a tool error, never a fabricated user answer or approval.
    throw Error('ASYNCHRONOUS_CLIENT: use queue_mail for human input, preserve the draft, and finish the turn.');
}
