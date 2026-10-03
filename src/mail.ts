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
  const trusted=sender===owner.toLowerCase() && !auto && authenticated(parsed.headerLines,owner);
  const htmlText=parsed.html ? convert(parsed.html,{wordwrap:false,selectors:[{selector:'blockquote',format:'skip'},{selector:'.gmail_quote',format:'skip'}]}) : '';
  return {id,threadId,rfcId:parsed.messageId||'',inReplyTo:parsed.inReplyTo||'',subject:parsed.subject||'',
    references:[...new Set((Array.isArray(parsed.references)?parsed.references:parsed.references?[parsed.references]:[]).flatMap(v=>v.match(/<[^<>\s]+>/g)||[]))],
    text:cleanReply(parsed.text||htmlText),from:sender,trusted,reason:trusted?undefined:auto?'auto_reply':'sender_or_authentication'};
}
export type Directive = {type:'new';title:string;repo:string;run:boolean} | {type:'command';command:'START'|'STATUS'|'APPROVE'|'DEPLOY'|'RETRY'|'CANCEL';project?:string} | {type:'feedback';text:string} | {type:'invalid';reason:string};
export function directive(subject: string,text: string,existing=false): Directive {
  if(!existing) {
    const match=/^NEW\s+([a-z0-9][a-z0-9._-]{0,63})(\s+RUN)?\s*[:：]\s*(.+)$/i.exec(subject.trim());
    if(match) return {type:'new',repo:match[1].toLowerCase(),title:match[3].trim().slice(0,180),run:Boolean(match[2])};
    const body=cleanReply(text),title=subject.trim().replace(/^NEW(?:\s+|[:：]\s*|$)/i,'') || body.split('\n')[0]?.trim();
    if(/^(START|STATUS|APPROVE|DEPLOY(?:\s+\S+)?|RETRY|CANCEL)$/i.test(subject.trim()) || /^(START|STATUS|APPROVE|DEPLOY(?:\s+\S+)?|RETRY|CANCEL)$/i.test(body))return {type:'invalid',reason:'未关联任务，请直接回复对应任务的最新通知；新任务可用中文描述项目和需求。'};
    if(!title)return {type:'invalid',reason:'请在主题或正文描述需求。'};
    return {type:'new',repo:'',title:title.slice(0,180),run:false};
  }
  const cleaned=cleanReply(text), first=cleaned.split('\n')[0]?.trim().toUpperCase();
  const deploy=/^DEPLOY\s+([a-z0-9][a-z0-9._-]{0,63})$/i.exec(cleaned);if(deploy)return {type:'command',command:'DEPLOY',project:deploy[1].toLowerCase()};
  if(['START','STATUS','APPROVE','DEPLOY','RETRY','CANCEL'].includes(first)) {
    if(cleaned.trim().toUpperCase()!==first) return {type:'invalid',reason:'控制命令请单独回复一行；修改意见请另发邮件。'};
    return {type:'command',command:first as Extract<Directive,{type:'command'}>['command']};
  }
  return cleaned ? {type:'feedback',text:cleaned.slice(0,50000)} : {type:'invalid',reason:'未发现新写的正文。'};
}
