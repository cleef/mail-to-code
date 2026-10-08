import { createHash } from 'node:crypto';
import type { Attachment } from './types.js';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { simpleParser } from 'mailparser';
import { convert } from 'html-to-text';
import type { Config } from './config.js';
import { startMailServer } from './mail-connect.js';
import { inspectGmailPlugin } from './gmail-plugin-readiness.js';
import type { Rpc } from './app-server.js';
import { GmailError, type MailTransport, type MessageRef, type RawMessage, type SendMail } from './mail-transport.js';
import { quoteHash } from './mail-quote.js';
import { verifyPresentation } from './mail-presentation.js';
import { summaryHtml, summaryText } from './mail-summary.js';
import { markdownHtml } from './mail-markdown.js';
export { GmailError } from './mail-transport.js';
const active = new Set<CodexGmailTransport>();
export async function closeMailTransports() { await Promise.all([...active].map(mail => mail.close())); }
const actions = ['get_profile', 'search_email_ids', 'read_email', 'send_email'] as const;
type Action = typeof actions[number];
function decode(result: any): any {
    if (result?.isError) throw new GmailError(0, 'MAIL_PLUGIN_TOOL_FAILED_RECONNECT_WITH_MAIL_CONNECT');
    if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
    const texts = result?.content?.filter((c: any) => c.type === 'text');
    if (texts?.length !== 1) throw Error('MAIL_PLUGIN_RESPONSE_INVALID');
    try { const value = JSON.parse(texts[0].text); if (!value || typeof value !== 'object') throw Error(); return value; }
    catch { throw Error('MAIL_PLUGIN_RESPONSE_INVALID'); }
}
function ref(value: any): MessageRef & { threadId: string } {
    if (typeof value?.id !== 'string' || !value.id || typeof value.thread_id !== 'string' || !value.thread_id) throw Error('MAIL_PLUGIN_MESSAGE_IDENTITY_MISSING');
    return { id: value.id, threadId: value.thread_id };
}
export class CodexGmailTransport implements MailTransport {
    private constructor(readonly config: Config, readonly rpc: Rpc, readonly threadId: string, private readonly routes: Record<string, { server: string; tool: string }>) { }
    static async create(config: Config) {
        const rpc = await startMailServer(config);
        try {
            const ready = await inspectGmailPlugin(rpc, config.gmailAddress);
            if (!ready.ok || !ready.session) throw Error(ready.code);
            const mail = new CodexGmailTransport(config, rpc, ready.session.threadId, ready.session.routes);
            active.add(mail); return mail;
        } catch (e) { await rpc.close(); throw e; }
    }
    // This controller is the only RPC caller. No model turn is ever created and
    // no arbitrary server/tool name or tool arguments are accepted from a model.
    private async call(action: Action, args: unknown) {
        if (!actions.includes(action) || !this.routes[action]) throw Error('MAIL_PLUGIN_ACTION_FORBIDDEN');
        try { return decode(await this.rpc.request('mcpServer/tool/call', { threadId: this.threadId, ...this.routes[action], arguments: args })); }
        catch (e) { if (e instanceof GmailError) throw e; throw new GmailError(0, 'MAIL_PLUGIN_CALL_UNCERTAIN_NO_AUTOMATIC_RETRY'); }
    }
    async profile() {
        const profile = await this.call('get_profile', {}), address = profile.emailAddress || profile.email_address || profile.email;
        if (typeof address !== 'string' || address.toLowerCase() !== this.config.gmailAddress) throw Error('MAIL_GMAIL_ACCOUNT_MISMATCH');
        return { emailAddress: address.toLowerCase() };
    }
    async verify() { return this.profile(); }
    async search(query: string): Promise<MessageRef[]> {
        const ids = new Set<string>(), pages = new Set<string>(); let token = '';
        do {
            const page = await this.call('search_email_ids', { query, max_results: 100, next_page_token: token });
            if (!Array.isArray(page.message_ids) || page.message_ids.some((id: unknown) => typeof id !== 'string' || !id) || !Object.hasOwn(page,'next_page_token') || page.next_page_token!==null&&typeof page.next_page_token!=='string') throw Error('MAIL_PLUGIN_SEARCH_PAGE_INVALID');
            for (const id of page.message_ids) ids.add(id);
            token = page.next_page_token || '';
            if (token && pages.has(token)) throw Error('MAIL_PLUGIN_PAGINATION_LOOP');
            if (token) pages.add(token);
        } while (token);
        return [...ids].map(id => ({ id }));
    }
    async read(id: string): Promise<RawMessage> {
        const value = await this.call('read_email', { message_id: id, format: 'raw' }), identity = ref(value);
        if (identity.id !== id || typeof value.raw !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value.raw) || !Array.isArray(value.label_ids) || value.label_ids.some((s: unknown) => typeof s !== 'string')) throw Error('MAIL_PLUGIN_RAW_MESSAGE_REQUIRED');
        return { ...identity, raw: value.raw, labelIds: value.label_ids, internalDate: value.internal_date == null ? undefined : String(value.internal_date) };
    }
    async prepareReply(id: string, attachments: Attachment[] = []) {
        const raw = await this.read(id), p = await simpleParser(Buffer.from(raw.raw, 'base64url'));
        if (!p.messageId || !/^<[^<>\s]+>$/.test(p.messageId) || p.from?.value.length !== 1 || ![this.config.ownerAddress, this.config.gmailAddress].includes(p.from.value[0].address?.toLowerCase() || '')) throw Error('MAIL_REPLY_PARENT_IDENTITY_INVALID');
        return { attachmentHashes: (await this.attachmentParts(attachments)).hashes, quoteHash: quoteHash(p.text || convert(p.html || '', { wordwrap: false })), rfcId: p.messageId, threadId: raw.threadId };
    }
    async send(input: SendMail) {
        if (input.to.toLowerCase() !== this.config.ownerAddress || /[\r\n]/.test(input.subject)) throw Error('MAIL_RECIPIENT_OR_SUBJECT_INVALID');
        if (!input.replyMessageId) throw Error('MAIL_FROZEN_REPLY_PARENT_REQUIRED');
        if (input.deliveryMarker && !/^[a-f0-9-]{36}$/.test(input.deliveryMarker)) throw Error('MAIL_DELIVERY_MARKER_INVALID');
        const attachments=input.attachments||[],{parts,hashes}=await this.attachmentParts(attachments);
        if(input.attachmentHashes&&JSON.stringify(input.attachmentHashes)!==JSON.stringify(hashes))throw Error('MAIL_ATTACHMENT_SNAPSHOT_CHANGED');
        if (input.presentation) { verifyPresentation(input.presentation, input.summary, attachments); if (input.text !== input.presentation.text) throw Error('MAIL_TEXT_SNAPSHOT_MISMATCH'); }
        const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
        if(input.bodySnapshot) {
            const images=attachments.map((a,n)=>({cid:a.cid,filename:a.filename,contentType:a.contentType,sha256:hashes[n]}));
            if(input.bodySnapshot.version!==1 || JSON.stringify(images)!==JSON.stringify(input.bodySnapshot.images))throw Error('MAIL_BODY_IMAGE_SNAPSHOT_MISMATCH');
        }
        const marker = input.deliveryMarker ? `\n\n[MAIL-REF: ${input.deliveryMarker}]` : '', text = (input.bodySnapshot?.text ?? input.text) + marker;
        const legacyImages=new Map(attachments.filter(a=>a.cid).map(a=>['cid:'+a.cid,{cid:a.cid!,alt:a.filename}]));
        const html = input.bodySnapshot ? input.bodySnapshot.html + (marker ? `<p>${escape(marker.trim())}</p>` : '') : input.markdown ? markdownHtml(text,legacyImages) + attachments.filter(a=>a.cid&&!input.text.includes('](cid:'+a.cid+')')).map(a=>`<img src="cid:${escape(a.cid!)}" alt="${escape(a.filename)}" style="max-width:100%;height:auto">`).join('') : input.presentation ? input.presentation.html + (marker ? `<p>${escape(marker.trim())}</p>` : '') : (input.summary ? summaryHtml(input.summary) : '') + `<div style="white-space:pre-wrap">${escape(input.summary && text.startsWith(summaryText(input.summary)) ? text.slice(summaryText(input.summary).length) : text)}</div>` + attachments.filter(a => a.cid).map(a => `<p>${escape(a.filename)}</p><img src="cid:${escape(a.cid!)}">`).join('');
        let payload: any = { mime_type: 'multipart/alternative', parts: [{ mime_type: 'text/plain', body: { content: text } }, { mime_type: 'text/html', body: { content: html } }] };
        const inline = parts.filter(p => p.content_id), files = parts.filter(p => !p.content_id);
        if (inline.length) payload = { mime_type: 'multipart/related', parts: [payload, ...inline] };
        if (files.length) payload = { mime_type: 'multipart/mixed', parts: [payload, ...files] };
        return ref(await this.call('send_email', { to: this.config.ownerAddress, subject: input.subject, payload, reply_message_id: input.replyMessageId, response_fields: ['id', 'thread_id', 'label_ids'] }));
    }
    private async attachmentParts(attachments:Attachment[]){
        const parts:any[]=[],hashes:string[]=[];let total=0;
        const artifactRoot = await realpath(resolve(this.config.dataDir, 'artifacts')).catch(() => resolve(this.config.dataDir, 'artifacts'));
        for (const a of attachments) {
            if(!a.filename||/[\r\n]/.test(a.filename)||a.cid&&/[\r\n<>]/.test(a.cid))throw Error('MAIL_ATTACHMENT_HEADERS_INVALID');
            const path = await realpath(a.path), info = await stat(path);
            if (!path.startsWith(artifactRoot + sep) || !info.isFile()) throw Error('MAIL_ATTACHMENT_OUTSIDE_ARTIFACTS');
            total += info.size; if (total > 10 * 1024 * 1024) throw Error('MAIL_ATTACHMENTS_EXCEED_10_MIB');
            const bytes = await readFile(path); total += Math.max(0, bytes.length - info.size); if (total > 10 * 1024 * 1024) throw Error('MAIL_ATTACHMENTS_EXCEED_10_MIB');
            hashes.push(createHash('sha256').update(bytes).digest('hex'));
            parts.push({ mime_type: ({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.pdf':'application/pdf','.txt':'text/plain'} as Record<string,string>)[extname(a.filename).toLowerCase()] || 'application/octet-stream', filename: a.filename, ...(a.cid ? { content_id: a.cid, content_disposition: 'inline' } : { content_disposition: 'attachment' }), body: { base64_url_content: bytes.toString('base64url') } });
        }
        return {parts,hashes};
    }
    async close() { active.delete(this); await this.rpc.close(); }
}
