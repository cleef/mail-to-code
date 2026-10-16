import {createHash} from 'node:crypto';
import {simpleParser} from 'mailparser';
import type {Config} from './config.js';
import type {MailTransport} from './mail-transport.js';
import {matchesFrozenBody} from './mail-quote.js';
import type {Outbound,Session} from './types.js';
import type {Store} from './store.js';
import {mailDiagnostic, type MailPhase} from './mail-diagnostics.js';
export type {MailTransport} from './mail-transport.js';
const body=(text:string)=>text.replace(/\r\n/g,'\n').trim();
export class Delivery {
 constructor(readonly config:Config,readonly store:Store,readonly mail:MailTransport,readonly onError?:(m:Outbound,error:unknown,phase:MailPhase)=>void){}
 private pending(m:Outbound,code:string,result:'pending'|'absent'|'ambiguous'='pending',error?:unknown,phase:'search'|'read'='read'){
  m.identityStatus='pending';m.identityError=code;m.identityDiagnostic=error===undefined?undefined:mailDiagnostic(m,phase,error);
  if(error!==undefined)this.onError?.(m,error,phase);
  this.store.saveMail(m);return result;
 }
 async inspect(m:Outbound,s:Session,id:string){
  const raw=await this.mail.read(id),p=await simpleParser(Buffer.from(raw.raw,'base64url'),{keepCidLinks:true});
  const expected=(m.bodySnapshot?.text ?? m.text)+(m.deliveryMarker?`\n\n[MAIL-REF: ${m.deliveryMarker}]`:'');
  const from=p.from?.value,to=p.to?(Array.isArray(p.to)?p.to.flatMap(v=>v.value):p.to.value):[];
  if(!raw.labelIds?.includes('SENT')||from?.length!==1||from[0].address?.toLowerCase()!==this.config.gmailAddress||to.length!==1||to[0].address?.toLowerCase()!==this.config.ownerAddress||p.cc||p.bcc||p.subject!==s.subject||!matchesFrozenBody(p.text||'',expected,m.replyQuoteHash))throw Error('DELIVERY_CANDIDATE_MISMATCH');
  if(m.replyParentRfcId&&p.inReplyTo!==m.replyParentRfcId)throw Error('DELIVERY_REPLY_PARENT_MISMATCH');
  if(m.threadId&&raw.threadId!==m.threadId)throw Error('DELIVERY_THREAD_MISMATCH');
  const names=(values:{filename?:string;cid?:string;contentId?:string}[])=>values.map(a=>[a.filename||'',(a.cid||a.contentId||'').replace(/^<|>$/g,'')]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if(JSON.stringify(names(p.attachments))!==JSON.stringify(names(m.attachments)))throw Error('DELIVERY_ATTACHMENTS_MISMATCH');
  if(m.attachmentHashes){const expected=m.attachments.map((a,n)=>[a.filename,(a.cid||'').replace(/^<|>$/g,''),m.attachmentHashes![n]]).sort(),actual=p.attachments.map(a=>[a.filename||'',(a.cid||a.contentId||'').replace(/^<|>$/g,''),createHash('sha256').update(a.content).digest('hex')]).sort();if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('DELIVERY_ATTACHMENT_CONTENT_MISMATCH');}
  if(m.bodySnapshot?.images.length){
   const html=typeof p.html==='string'?p.html:'',refs=[...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map(v=>v[1]);
   if(m.bodySnapshot.images.some(image=>!refs.includes('cid:'+image.cid)) || refs.some(src=>!src.startsWith('cid:')||!m.bodySnapshot!.images.some(image=>'cid:'+image.cid===src)))throw Error('DELIVERY_IMAGE_HTML_MISMATCH');
   for(const image of m.bodySnapshot.images){const a=p.attachments.find(a=>(a.cid||a.contentId||'').replace(/^<|>$/g,'')===image.cid),declared=a?.headers.get('content-type');if(!a || a.contentType!==image.contentType || !declared || typeof declared!=='object' || !('value' in declared) || declared.value!==image.contentType)throw Error('DELIVERY_IMAGE_MIME_MISMATCH');}
  }
  if(!p.messageId||!/^<[^<>\s]+>$/.test(p.messageId))throw Error('DELIVERY_RFC_ID_MISSING');
  return {id:raw.id,threadId:raw.threadId,rfcMessageId:p.messageId,sentAt:raw.internalDate?new Date(Number(raw.internalDate)).toISOString():p.date?.toISOString()};
 }
 async reconcile(m:Outbound):Promise<'verified'|'absent'|'ambiguous'|'pending'>{
  m.identityCheckedAt=new Date().toISOString();this.store.saveMail(m);
  const s=this.store.session(m.sessionId);if(!s)throw Error('Missing delivery task');
  let found:Awaited<ReturnType<Delivery['inspect']>>[]=[];
  if(m.gmailId){try{found=[await this.inspect(m,s,m.gmailId)];}catch(e){return this.pending(m,e instanceof Error&&/^DELIVERY_[A-Z_]+$/.test(e.message)?e.message:'DELIVERY_READ_PENDING','pending',e);}}
  else{
   const at=Math.floor(Date.parse(m.attemptedAt||m.createdAt)/1000);
   const query=m.deliveryMarker?`in:sent "${m.deliveryMarker}"`:`in:sent to:${this.config.ownerAddress} after:${at-300} before:${at+86400}`;
   let refs;try{refs=await this.mail.search(query);}catch(e){return this.pending(m,'DELIVERY_SEARCH_PENDING','pending',e,'search');}
   // An oversized result is ambiguous, never evidence of absence.
   if(refs.length>500)return this.pending(m,'DELIVERY_SEARCH_AMBIGUOUS','ambiguous');
   let candidateError:unknown;
   for(const r of refs){try{found.push(await this.inspect(m,s,r.id));}catch(e){candidateError=e;/* Unverified candidates cannot establish delivery. */}}
   if(!found.length)return refs.length?this.pending(m,'DELIVERY_CANDIDATES_UNVERIFIED','pending',candidateError):this.pending(m,'DELIVERY_SENT_MESSAGE_NOT_FOUND','absent');
  }
  if(found.length!==1)return this.pending(m,'DELIVERY_SEARCH_AMBIGUOUS','ambiguous');
  const hit=found[0];m.status='sent';m.gmailId=hit.id;m.threadId=hit.threadId;m.rfcMessageId=hit.rfcMessageId;m.identityStatus='verified';m.sentAt ||= hit.sentAt||new Date().toISOString();m.lastError=undefined;m.identityError=undefined;m.identityDiagnostic=undefined;m.sendDiagnostic=undefined;this.store.saveMail(m);
  const current=this.store.session(m.sessionId)!;current.threadId=hit.threadId;this.store.save(current);return 'verified';
 }
 async backfill(){const results=[];for(const m of this.store.mails().filter(m=>m.status==='sent'&&m.identityStatus!=='verified'||m.status==='uncertain'))results.push({id:m.id,result:await this.reconcile(m)});return results;}
}
