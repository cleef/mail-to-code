import type {Config} from '../src/config.js';
export function fakeMail(config:Config,onSend:()=>void=()=>{}){
 const messages=new Map<string,any>();let n=0;
 const record=(input:any,id?:string)=>{
  id ||= 'sent-'+(++n);const text=input.text+(input.deliveryMarker?`\n\n[MAIL-REF: ${input.deliveryMarker}]`:'');
  const raw=Buffer.from(`From: ${config.gmailAddress}\r\nTo: ${config.ownerAddress}\r\nSubject: ${input.subject}\r\nMessage-ID: <delivered-${id}@gmail.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`).toString('base64url');
  const m={id,threadId:'canonical',raw,labelIds:['SENT']};messages.set(id,m);return m;
 };
 return {record,profile:async()=>({emailAddress:config.gmailAddress,historyId:'100'}),history:async()=>({messages:[],cursor:'101'}),search:async()=>[],read:async(id:string)=>{const m=messages.get(id);if(!m)throw Error('missing mock mail');return m;},send:async(input:any)=>{onSend();const m=record(input);return {id:m.id,threadId:m.threadId};}} as any;
}
