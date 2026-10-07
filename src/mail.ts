import { simpleParser } from 'mailparser';
import { convert } from 'html-to-text';
import type { Incoming } from './types.js';

export function cleanReply(text: string): string {
  const lines = text.replace(/\r\n/g,'\n').split('\n'), result: string[]=[];
  for (const line of lines) {
    if (/^\s*>/.test(line) || /^\s*(?:On .+wrote:|在.+(?:写道|發送|发送)|[-_]{3,}.*(?:原始邮件|Original Message|转发|Forwarded)|Begin forwarded message:|From:|发件人[:：]|寄件者[:：]|--\s*$)/i.test(line)) break;
    if (/^\s*(?:发自我的|发送自|Sent from my|Get Outlook for)/i.test(line)) break;
    result.push(line);
  }
  return result.join('\n').trim();
}
export function authenticated(headers: readonly {key:string;line:string}[],owner: string): boolean {
  const ownDomain=owner.split('@')[1].toLowerCase();
  const records=headers.filter(h=>h.key.toLowerCase()==='authentication-results').map(h=>h.line.replace(/\r?\n\s+/g,' ').replace(/^Authentication-Results:\s*/i,''));
  const gmail=records.filter(v=>/^mx\.google\.com\s*;/i.test(v));
  if(gmail.length!==1) return false; // Reject ambiguous, potentially forged duplicates.
  const parts=gmail[0].split(';').map(s=>s.trim());
  const dmarc=parts.find(v=>/^dmarc=pass\b/i.test(v));
  if(!dmarc || !new RegExp(`\\bheader\\.from=${ownDomain.replaceAll('.','\\.')}([;\\s]|$)`,'i').test(dmarc)) return false;
  return parts.some(v=>/^(dkim|spf)=pass\b/i.test(v));
}
export async function parseIncoming(id: string,threadId: string,raw: string,owner: string): Promise<Incoming> {
  if(raw.length>4_000_000) throw new Error('Inbound message exceeds size limit');
  const parsed=await simpleParser(Buffer.from(raw,'base64url'));
  const from=parsed.from?.value;
  const sender=from?.length===1 ? from[0].address?.toLowerCase() || '' : '';
  const auto=String(parsed.headers.get('auto-submitted')||'no').toLowerCase()!=='no'
    || parsed.headers.has('list-id') || /bulk|list|junk/i.test(String(parsed.headers.get('precedence')||''));
  const rfcIdentity=typeof parsed.messageId==='string'&&/^<[^<>\s]+>$/.test(parsed.messageId);
  const trusted=rfcIdentity&&sender===owner.toLowerCase() && !auto && authenticated(parsed.headerLines,owner);
  const htmlText=parsed.html ? convert(parsed.html,{wordwrap:false,selectors:[{selector:'blockquote',format:'skip'},{selector:'.gmail_quote',format:'skip'}]}) : '';
  return {id,threadId,rfcId:parsed.messageId||'',inReplyTo:parsed.inReplyTo||'',subject:parsed.subject||'',
    references:[...new Set((Array.isArray(parsed.references)?parsed.references:parsed.references?[parsed.references]:[]).flatMap(v=>v.match(/<[^<>\s]+>/g)||[]))],
    text:cleanReply(parsed.text||htmlText),from:sender,trusted,reason:trusted?undefined:!rfcIdentity?'missing_rfc_identity':auto?'auto_reply':'sender_or_authentication'};
}
