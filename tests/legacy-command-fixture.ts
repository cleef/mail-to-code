// Legacy protocol data fixture, intentionally absent from the production mail parser.
import {cleanReply} from '../src/mail.js';
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
