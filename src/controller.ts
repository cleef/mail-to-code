import type { Config } from './config.js';
import { Store } from './store.js';
import { GmailError, type MailTransport } from './mail-transport.js';
import {scanMailbox} from './mail-scan.js';
import { parseIncoming } from './mail.js';
import type { Incoming, Session, Job, Outbound, Attachment } from './types.js';
import type { RunResult } from './runner.js';
import {Delivery} from './delivery.js';

export interface Work {
  prepare(s:Session,signal?:AbortSignal):Promise<void>; run(s:Session,phase:'plan'|'develop',feedback:string,signal:AbortSignal,onThread:(id:string)=>void):Promise<RunResult>;
  updateBase(s:Session,signal?:AbortSignal):Promise<boolean>; verifyScope(s:Session,signal?:AbortSignal):Promise<void>; commit(s:Session,signal?:AbortSignal):Promise<string>;
  build(s:Session,signal:AbortSignal):Promise<string[]>; push(s:Session,signal?:AbortSignal):Promise<void>;
  capture(s:Session,result:RunResult,signal:AbortSignal):Promise<{attachments:Attachment[];checks:string[];directory:string}>;
  ensurePr(s:Session,checks:string[],signal?:AbortSignal):Promise<void>; merge(s:Session,signal?:AbortSignal):Promise<string>;
  deploy(s:Session,signal:AbortSignal):Promise<void>; reconcile(s:Session):Promise<boolean>;
  productRecord?(s:Session,attachments:Attachment[]):Promise<string|undefined>;
}

// Transport has no mail-intent parser or business fallback. The live semantic
// controller supplies every intake and execution decision.
export abstract class Controller {
  private polling=false; private sending=false; stopped=false;
  constructor(readonly config:Config,readonly store:Store,readonly mail:MailTransport,readonly work:Work) {}
  abstract handle(incoming:Incoming):void;
  abstract startNext():Promise<void>|undefined;
  async poll() {
    if(this.polling||this.stopped)return;this.polling=true;
    try{
      await scanMailbox(this.mail,this.store,this.config.ownerAddress,async id=>{
        if(this.store.seen(id))return;
        const m=await this.mail.read(id);
        let incoming:Incoming;
        try{incoming=await parseIncoming(m.id,m.threadId,m.raw,this.config.ownerAddress);}catch{this.store.remember(m.id,'',m.threadId,undefined,'invalid_mime');return;}
        this.handle(incoming);
      });
      this.store.set('poll_error','');
    }catch(e){this.store.set('poll_error',safeError(e));}
    finally{this.polling=false;}
  }
  async flush() {
    if(this.sending||this.stopped)return;this.sending=true;
    try{
      const delivery=new Delivery(this.config,this.store,this.mail);
      for(const unknown of this.store.mails().filter(m=>(m.status==='uncertain'||m.status==='sent'&&m.identityStatus!=='verified')&&Date.now()-Date.parse(m.identityCheckedAt||'1970-01-01')>=60000).slice(0,3))await delivery.reconcile(unknown);
      const all=this.store.mails();
      const mail=all.find(m=>{const previous=all.filter(p=>p.sessionId===m.sessionId&&p.status==='sent').at(-1);return m.status==='pending'&&!all.some(u=>u.sessionId===m.sessionId&&u.status==='uncertain')&&(!previous||!!previous.rfcMessageId);});if(!mail)return;
      const s=this.store.session(mail.sessionId)!;
      const previous=this.store.mails().filter(m=>m.sessionId===s.id&&m.status==='sent').at(-1);
      if(this.mail.prepareReply&&!mail.replyMessageId){
        const parent=previous?.gmailId||s.initialMessageId, frozen=await this.mail.prepareReply(parent,mail.attachments);
        mail.replyMessageId=parent;mail.replyParentRfcId=frozen.rfcId;mail.replyQuoteHash=frozen.quoteHash;mail.attachmentHashes=frozen.attachmentHashes;mail.threadId=frozen.threadId;this.store.saveMail(mail);
      }
      mail.status='sending';mail.attempts++;mail.attemptedAt=new Date().toISOString();this.store.saveMail(mail);
      try{
        const result=await this.mail.send({replyMessageId:mail.replyMessageId,to:this.config.ownerAddress,subject:s.subject,text:mail.text,summary:mail.summary,presentation:mail.presentation,messageId:mail.id,deliveryMarker:mail.deliveryMarker,threadId:mail.threadId||s.threadId,inReplyTo:previous?.rfcMessageId||s.initialRfcId,references:this.store.mails().filter(m=>m.sessionId===s.id&&m.status==='sent'&&m.rfcMessageId).slice(-15).map(m=>m.rfcMessageId!),attachments:mail.attachments,attachmentHashes:mail.attachmentHashes});
        mail.status='sent';mail.gmailId=result.id;mail.threadId=result.threadId;mail.sentAt=new Date().toISOString();mail.identityStatus='pending';this.store.saveMail(mail);
        const current=this.store.session(s.id)!;current.threadId=result.threadId;this.store.save(current);
        try{await delivery.reconcile(mail);}catch{mail.identityStatus='pending';mail.identityError='DELIVERY_READ_PENDING';this.store.saveMail(mail);}
      }catch(e){mail.status=e instanceof GmailError&&e.status>=400&&e.status<500&&e.status!==408?'failed':'uncertain';mail.lastError=safeError(e);this.store.saveMail(mail);}
    }catch(e){this.store.set('send_error',safeError(e));}
    finally{this.sending=false;}
  }
  async stop(){this.stopped=true;}
}
export function safeError(error:unknown):string { return error instanceof Error?error.message.replace(/(?:Bearer\s+|gh[pousr]_)[\w.-]+/gi,'[redacted]').slice(0,500):'Unexpected failure'; }
