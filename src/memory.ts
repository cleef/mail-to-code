import { z } from 'zod/v3';
import { mkdir, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Store } from './store.js';
import type { Session } from './types.js';
import type { AnalysisResult } from './analysis.js';
import { ProjectRegistry, digest } from './projects.js';

export const MemoryProposalSchema = z.object({
    path: z.string().min(1).max(300),
    descriptions: z.array(z.string().min(2).max(80)).max(8)
}).strict();
const ProjectMemorySchema = z.object({
    identity: z.string(), path: z.string(), displayName: z.string(), descriptions: z.array(z.string()),
    confidence: z.enum(['observed', 'confirmed']), sourceSession: z.string(), updatedAt: z.string(), confirmedAt: z.string().optional()
}).strict();
const DailySchema = z.object({ id: z.string(), date: z.string(), session: z.string(), stage: z.string(), projects: z.array(z.string()) }).strict();
const StateSchema = z.object({ version: z.literal(1), projects: z.array(ProjectMemorySchema).max(1000), daily: z.array(DailySchema).max(1000) }).strict();
type State = z.infer<typeof StateSchema>;
type ProjectMemory = z.infer<typeof ProjectMemorySchema>;
const normal = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
// Only short project names/descriptions are remembered, never raw mail or plans.
export function safeDescription(text: string): boolean {
    return text.length >= 2 && text.length <= 80 && /[\p{L}\p{N}]/u.test(text) &&
        !/[\r\n\0<>`{}\[\];|$]/.test(text) && !/@|https?:\/\/|\b\d{11}\b/i.test(text) &&
        !/token|password|passwd|secret|authorization|credential|api[_ -]?key|private[_ -]?key|BEGIN /i.test(text) &&
        !/[A-Za-z0-9+/=_-]{30,}/.test(text) &&
        !/^(添加|新增|修改|实现|修复|更新|开发|分享|分享功能|测试|需求|页面|功能)$/u.test(text);
}
function relevance(query: string, item: ProjectMemory): number {
    const q = normal(query), pairs = new Set(q.match(/[\p{Script=Han}]{2}/gu) || []);
    // Overlapping Chinese bigrams also match names with punctuation/branding changes.
    for (let i = 0; i < q.length - 1; i++) if (/^[\p{Script=Han}]{2}$/u.test(q.slice(i, i + 2))) pairs.add(q.slice(i, i + 2));
    let score = 0;
    for (const description of [item.displayName, item.path, ...item.descriptions]) {
        const d = normal(description);
        if (d.length >= 2 && q.includes(d)) score = Math.max(score, 100 + Math.min(d.length, 80));
        else {
            const matching = new Set<string>();
            for (let i = 0; i < d.length - 1; i++) if (pairs.has(d.slice(i, i + 2))) matching.add(d.slice(i, i + 2));
            if (matching.size >= 2) score = Math.max(score, matching.size);
        }
    }
    return score;
}
const dateAt = (value: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export class ProjectMemoryService {
    private key: string;
    constructor(readonly config: Config, readonly store: Store, readonly now: () => Date = () => new Date()) {
        // A different operator or project root must not inherit another namespace.
        this.key = 'project_memory_v1:' + digest({ owner: config.ownerAddress.toLowerCase(), root: config.projectsRoot });
    }
    private read(): State {
        const raw = this.store.get(this.key);
        return raw ? StateSchema.parse(JSON.parse(raw)) : { version: 1, projects: [], daily: [] };
    }
    inspect() { return this.read(); }
    async buildContext(request: string, registry: ProjectRegistry): Promise<string> {
        const state = this.read(), now = this.now();
        const today = dateAt(now), yesterday = dateAt(new Date(now.getTime() - 86400000));
        const ranked = state.projects.map(item => ({ item, score: relevance(request, item) }))
            .filter(({ item, score }) => score > 0 && (item.confidence === 'confirmed' || now.getTime() - Date.parse(item.updatedAt) <= 30 * 86400000))
            .sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt));
        const valid: ProjectMemory[] = [];
        // Resolve only useful remembered paths. No inventory scan or write authorization.
        for (const { item } of ranked.slice(0, 16)) {
            try {
                const p = await registry.resolve(item.path);
                if (p.identity === item.identity && p.relativePath === item.path) valid.push(item);
            } catch { /* Removed, moved, replaced or escaping paths are not useful context. */ }
            if (valid.length === 8) break;
        }
        const known = new Set(valid.map(p => p.path));
        const daily = state.daily.filter(n => [today, yesterday].includes(n.date) && n.projects.some(p => known.has(p))).slice(-20).map(n=>({...n,projects:n.projects.filter(p=>known.has(p))}));
        const payload = { projects: valid, daily };
        let data = escape(JSON.stringify(payload));
        while(Buffer.byteLength(data,'utf8')>16000&&(payload.daily.length||payload.projects.length)){
            if(payload.daily.length)payload.daily.shift();else payload.projects.pop();
            data=escape(JSON.stringify(payload));
        }
        return `<memory_context trust="data-only">${data}</memory_context>`;
    }
    async observe(session: Session, result: AnalysisResult, registry: ProjectRegistry, source: string, request='') {
        const proposals = result.memoryProposals || [];
        const rows: ProjectMemory[] = [];
        for (const candidate of result.projects) {
            try {
                if (candidate.path.startsWith('/') || candidate.path.split(/[\\/]/).includes('..')) continue;
                const project = await registry.resolve(candidate.path);
                const aliases = proposals.filter(p => p.path === candidate.path).flatMap(p => p.descriptions)
                    .filter(safeDescription).filter(d => normal((session.originalRequest || session.title)+' '+request).includes(normal(d)) || normal(candidate.displayName).includes(normal(d)));
                rows.push({ identity: project.identity, path: project.relativePath!, displayName: safeDescription(candidate.displayName) ? candidate.displayName : basename(project.path),
                    descriptions: [...new Set([candidate.displayName, project.relativePath!, ...aliases].filter(safeDescription))].slice(0, 12),
                    confidence: 'observed', sourceSession: session.id, updatedAt: this.now().toISOString() });
            } catch { /* A model proposal does not make an invalid repository memorable. */ }
        }
        await this.commit(session, rows, result.outcome, source);
    }
    async confirm(session: Session, registry: ProjectRegistry, source: string) {
        const rows: ProjectMemory[] = [];
        for (const target of [...(session.targets || []), ...(session.references || [])]) {
            const p = await registry.resolve(target.path);
            if (p.identity !== target.identity) throw new Error('MEMORY_REPOSITORY_CHANGED');
            rows.push({ identity: p.identity, path: p.relativePath!, displayName: safeDescription(target.displayName || '') ? target.displayName! : basename(p.path),
                descriptions: [target.displayName || '', p.relativePath!].filter(safeDescription), confidence: 'confirmed',
                sourceSession: session.id, updatedAt: this.now().toISOString(), confirmedAt: this.now().toISOString() });
        }
        await this.commit(session, rows, 'confirmed', source);
    }
    private async commit(session: Session, rows: ProjectMemory[], stage: string, source: string) {
        const current = this.store.session(session.id);
        if (current && (current.state === 'CANCELLED' || current.cancellationEpoch !== session.cancellationEpoch)) return;
        const state = this.read(), now = this.now();
        const note = { id: digest({ source, stage }), date: dateAt(now), session: session.id, stage, projects: rows.map(r => r.path) };
        if (state.daily.some(n => n.id === note.id)) return;
        for (const row of rows) {
            const previous = state.projects.find(p => p.identity === row.identity);
            if (previous) {
                row.descriptions = [...new Set([...row.descriptions, ...previous.descriptions])].slice(0, 12);
                // An observation never silently downgrades an operator-confirmed map.
                if (previous.confidence === 'confirmed') { row.confidence = 'confirmed'; row.confirmedAt ||= previous.confirmedAt; }
                Object.assign(previous, row);
            } else state.projects.push(row);
        }
        state.projects = state.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 1000);
        state.daily = [...state.daily, note].filter(n => n.date >= dateAt(new Date(now.getTime() - 31 * 86400000))).slice(-1000);
        this.store.transaction(() => this.store.set(this.key, JSON.stringify(state)));
        await this.materialize(state);
    }
    async forget(path: string) {
        const state = this.read(); state.projects = state.projects.filter(p => p.path !== path);
        state.daily = state.daily.filter(n => !n.projects.includes(path));
        this.store.set(this.key, JSON.stringify(state)); await this.materialize(state);
    }
    private async materialize(state: State) {
        const directory = join(this.config.dataDir, 'memory', this.key.slice(-16));
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const atomic = async (path: string, content: string) => {
            const temporary = path + '.' + randomUUID();
            try{await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, path);}
            finally{await unlink(temporary).catch(()=>{});}
        };
        await atomic(join(directory, 'MEMORY.md'), '# Project memory\n\nController-generated view; SQLite is authoritative. Names are lookup hints, never permissions.\n\n' +
            state.projects.map(p => `- ${p.displayName} → ${p.path} (${p.confidence})\n  Descriptions: ${p.descriptions.join(' / ')}\n  Identity: ${p.identity}; source: ${p.sourceSession}; updated: ${p.updatedAt}`).join('\n'));
        const days=new Set(state.daily.map(n=>n.date));
        for(const file of await readdir(directory))if(/^\d{4}-\d{2}-\d{2}\.md$/.test(file)&&!days.has(file.slice(0,-3)))await unlink(join(directory,file));
        for (const day of days) await atomic(join(directory, day + '.md'), '# ' + day + '\n\n' +
            state.daily.filter(n => n.date === day).map(n => `- ${n.session}: ${n.stage}; ${n.projects.join(', ')}`).join('\n'));
    }
}
