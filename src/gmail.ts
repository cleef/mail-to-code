import {verifyPresentation} from './mail-presentation.js';
import { OAuth2Client } from 'google-auth-library';
import { readFile, writeFile, rename, stat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { configDir, privateDir, privateFile, type Config } from './config.js';
import {summaryHtml,summaryText} from './mail-summary.js';
import type { MailSummary, MailPresentation, Attachment } from './types.js';
import { markdownHtml } from './mail-markdown.js';

export const SCOPES=['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'];
export class GmailError extends Error { constructor(public status:number, message:string) { super(message); } }
export interface MessageRef {id:string;threadId:string}
export class GmailClient {
  private constructor(readonly config:Config,readonly auth:OAuth2Client) {}
  static async create(config:Config) {
    const path=join(configDir(),'oauth-client.json'); await privateFile(path);
    const client=JSON.parse(await readFile(path,'utf8')).installed;
    if(!client?.client_id || !client?.client_secret) throw new Error('OAuth credentials must be a Desktop client');
    const auth=new OAuth2Client(client.client_id,client.client_secret,`http://127.0.0.1:${config.oauthPort}/callback`);
    const tokenPath=join(configDir(),'token.json');
    try { await privateFile(tokenPath); auth.setCredentials(JSON.parse(await readFile(tokenPath,'utf8'))); } catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
    auth.on('tokens',tokens=>{const merged={...auth.credentials,...tokens}; if(!merged.refresh_token) return; void atomicSecret(tokenPath,JSON.stringify(merged)).catch(()=>process.stderr.write('OAuth token persistence failed\n'));});
    return new GmailClient(config,auth);
  }
  async request<T>(path:string,method='GET',body?:unknown):Promise<T> {
    try { const response=await this.auth.request<T>({url:`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,method:method as 'GET'|'POST',data:body,timeout:30000,retry:false}); return response.data; }
    catch(e) { const status=Number((e as {response?:{status:number}}).response?.status||0); throw new GmailError(status, status===401||status===403?'Gmail authorization unavailable; run auth again':`Gmail request failed (${status||'network'})`); }
  }
  profile() { return this.request<{emailAddress:string;historyId:string}>('profile'); }
  async verify() {
    if(!this.auth.credentials.refresh_token) throw new Error('Missing OAuth refresh token; run auth');
    const token=await this.auth.getAccessToken(); if(!token.token) throw new Error('OAuth access token unavailable');
    const info=await this.auth.getTokenInfo(token.token);
    if(!SCOPES.every(s=>info.scopes.includes(s))) throw new Error('OAuth token lacks required Gmail scopes');
    const p=await this.profile(); if(p.emailAddress.toLowerCase()!==this.config.gmailAddress) throw new Error('Authorized Gmail account differs from configuration');
    return p;
  }
  async search(query:string):Promise<MessageRef[]> {
    const messages:MessageRef[]=[]; let page:string|undefined;
    do { const qs=new URLSearchParams({q:query,maxResults:'100'}); if(page)qs.set('pageToken',page);
      const data=await this.request<{messages?:MessageRef[];nextPageToken?:string}>(`messages?${qs}`); messages.push(...data.messages||[]); page=data.nextPageToken;
    } while(page); return messages;
  }
  read(id:string) { return this.request<MessageRef&{raw:string;labelIds?:string[];internalDate?:string}>(`messages/${encodeURIComponent(id)}?format=raw`); }
  thread(id:string) { return this.request<{messages?:unknown[]}>(`threads/${encodeURIComponent(id)}?format=full`); }
  async history(cursor:string):Promise<{messages:MessageRef[];cursor:string}> {
    const messages:MessageRef[]=[]; let page:string|undefined,latest=cursor;
    do {const qs=new URLSearchParams({startHistoryId:cursor,historyTypes:'messageAdded',maxResults:'100'});if(page)qs.set('pageToken',page);
      const data=await this.request<{history?:{messagesAdded?:{message:MessageRef}[]}[];historyId:string;nextPageToken?:string}>(`history?${qs}`);
      for(const h of data.history||[])for(const m of h.messagesAdded||[])messages.push(m.message); latest=data.historyId; page=data.nextPageToken;
    }while(page);return {messages:[...new Map(messages.map(m=>[m.id,m])).values()],cursor:latest};
  }
  async send(input:{to:string;subject:string;text:string;markdown?:boolean;summary?:MailSummary;presentation?:MailPresentation;messageId?:string;deliveryMarker?:string;threadId?:string;inReplyTo?:string;references?:string[];attachments?:Attachment[]}) {
    if(input.to.toLowerCase()!==this.config.ownerAddress) throw new Error('Recipient is not the configured owner');
    if(/[\r\n]/.test(input.subject))throw new Error('Invalid subject');
    const attachments=input.attachments||[]; let total=0;
    for(const a of attachments){if(!(await realpath(a.path)).startsWith(this.config.dataDir+'/artifacts/'))throw new Error('Attachment is outside artifact directory');total+=(await stat(a.path)).size;}
    if(total>10*1024*1024)throw new Error('Attachments exceed 10 MiB');
    const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
    if(input.deliveryMarker&&!/^[a-f0-9-]{36}$/.test(input.deliveryMarker))throw new Error('Invalid delivery marker');
    const text=input.text+(input.deliveryMarker?`\n\n[MAIL-REF: ${input.deliveryMarker}]`:'');
    if(input.presentation){verifyPresentation(input.presentation,input.summary,attachments);if(input.text!==input.presentation.text)throw Error('MAIL_TEXT_SNAPSHOT_MISMATCH');}
    const raw=await new MailComposer({from:this.config.gmailAddress,to:this.config.ownerAddress,subject:input.subject,
      headers:input.deliveryMarker?{'X-Mail-To-Code-Delivery':input.deliveryMarker}:undefined,
      text,html:input.markdown?markdownHtml(text):input.presentation?input.presentation.html+(input.deliveryMarker?`<p>[MAIL-REF: ${escape(input.deliveryMarker)}]</p>`:''):(input.summary?summaryHtml(input.summary):'')+`<div style="white-space:pre-wrap">${escape(input.summary&&text.startsWith(summaryText(input.summary))?text.slice(summaryText(input.summary).length):text)}</div>`+attachments.filter(a=>a.cid).map(a=>`<p>${escape(a.filename)}</p><img style="max-width:100%" src="cid:${escape(a.cid!)}">`).join(''),
      messageId:input.messageId||`<${randomUUID()}@mail-to-code.local>`,inReplyTo:input.inReplyTo,references:input.references,attachments}).compile().build();
    return this.request<MessageRef>('messages/send','POST',{raw:raw.toString('base64url'),...(input.threadId?{threadId:input.threadId}:{})});
  }
}
export async function atomicSecret(path:string,text:string) {
  await privateDir(configDir()); const temporary=`${path}.${randomUUID()}.tmp`;
  await writeFile(temporary,text,{mode:0o600}); await rename(temporary,path);
}
