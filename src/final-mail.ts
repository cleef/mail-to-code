import type { AsyncStore, Conversation, InputEvent } from './async-store.js';

// Eligibility is written before input dispatch. Historical turns are never backfilled.
export class FinalMail {
    constructor(readonly store: AsyncStore) {}
    begin(input: InputEvent) { this.store.put('final-input', input.id, { conversationId: input.conversationId }); }
    accepted(c: Conversation, input: InputEvent) {
        if (!input.turnId || !this.store.get('final-input', input.id)) return;
        const key = c.id + ':' + input.turnId;
        if (!this.store.get('final-turn', key)) this.store.put('final-turn', key, { conversationId: c.id, turnId: input.turnId, rootTurn: input.turnId });
    }
    continuation(c: Conversation, previous: string, next: string) {
        const eligible = this.store.get<{ rootTurn: string }>('final-turn', c.id + ':' + previous);
        if (eligible && !this.store.get('turn-output', c.id + ':' + eligible.rootTurn)) this.store.put('final-turn', c.id + ':' + next, { ...eligible, conversationId: c.id, turnId: next });
    }
    pending(c: Conversation) {
        return this.store.all<{ conversationId: string; turnId: string; rootTurn: string }>('final-turn').filter(value => value.conversationId === c.id && !this.store.get('turn-output', c.id + ':' + value.rootTurn) && !this.store.get('final-held', c.id + ':' + value.turnId));
    }
    item(c: Conversation, turnId: string, item: any) {
        if (!turnId || !item?.id || !['agentMessage', 'plan'].includes(item.type) || typeof item.text !== 'string') return;
        this.store.put('final-item', c.id + ':' + turnId + ':' + item.id, { conversationId: c.id, turnId, item });
        const turn = this.store.get<any>('turn', turnId);
        if (turn?.status === 'completed') this.complete(c, turn);
    }
    complete(c: Conversation, turn: any) {
        if (turn.status !== 'completed') return;
        const eligible = this.store.get<{ rootTurn: string }>('final-turn', c.id + ':' + turn.id);
        if (!eligible) return;
        const items = new Map<string, any>();
        for (const value of this.store.all<any>('final-item')) if (value.conversationId === c.id && value.turnId === turn.id) items.set(value.item.id, value.item);
        for (const item of turn.items || []) if (item.id) items.set(item.id, item);
        const all = [...items.values()], explicit = all.filter(i => i.type === 'agentMessage' && i.phase === 'final_answer' && typeof i.text === 'string');
        // Older pinned CLI histories may omit phase. Only a terminal assistant item is eligible.
        const last = all.at(-1);
        const selected = explicit.length ? explicit : last?.type === 'agentMessage' && !last.phase && typeof last.text === 'string' ? [last] : all.filter(i => i.type === 'plan' && typeof i.text === 'string').slice(-1);
        const text = selected.map(i => i.text).join('\n\n');
        if (!text.trim()) return;
        if (text.length > 50000) throw Error('FINAL_REPLY_TOO_LARGE');
        if (eligible.rootTurn !== turn.id) {
            const pending = this.store.get<any>('turn-confirmation', c.id + ':' + turn.id);
            if (pending) this.store.put('turn-confirmation', c.id + ':' + eligible.rootTurn, pending);
        }
        this.store.queueFinal(c, eligible.rootTurn, text, selected.map(i => i.id));
    }
}
