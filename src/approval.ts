import {createHash} from 'node:crypto';
import type {Session,ApprovalBinding} from './types.js';
import type {Store} from './store.js';
import {stageBinding} from './workflow.js';
export function approvalVersion(s:Session,action:ApprovalBinding['action']){
 const data=action==='START'?{manifest:s.planManifest,summary:s.summary,documents:s.documentVersion,targets:s.targets?.map(t=>({id:t.identity,base:t.baseSha,profile:t.profileVersion})),references:s.references?.map(t=>({id:t.identity,base:t.baseSha,profile:t.profileVersion}))}:action==='APPROVE'?{manifest:s.reviewManifest,head:s.reviewSha,targets:s.targets?.map(t=>({id:t.identity,head:t.reviewSha,base:t.baseSha,pr:t.prNumber,merged:t.mergeSha,profile:t.profileVersion}))}:{targets:s.targets?.map(t=>({id:t.identity,merge:t.mergeSha,profile:t.profileVersion,deploy:t.deployment})),merge:s.mergeSha};
 return createHash('sha256').update(JSON.stringify({...stageBinding(s),...data})).digest('hex');
}
export function currentBinding(s:Session,action?:ApprovalBinding['action']):ApprovalBinding|undefined{
 const expected=s.state==='WAITING_START'?'START':s.state==='WAITING_REVIEW'?'APPROVE':['MERGED','DONE'].includes(s.state)?'DEPLOY':undefined;
 const chosen=action||expected;if(!chosen||chosen!==expected)return;
 const noticeId=chosen==='START'?s.planNotice:chosen==='APPROVE'?s.reviewNotice:s.mergeNotice;
 return noticeId?{noticeId,version:approvalVersion(s,chosen),action:chosen,stageId:s.workflow?.legacy?undefined:s.workflow?.stageId}:undefined;
}
export function replyBinding(store:Store,s:Session,replyId:string):ApprovalBinding|undefined{
 const m=store.replyMail(replyId);if(!m||m.sessionId!==s.id||m.status!=='sent')return;
 if(m.approvalBinding)return structuredClone(m.approvalBinding);
 for(const action of ['START','APPROVE','DEPLOY'] as const){const id=action==='START'?s.planNotice:action==='APPROVE'?s.reviewNotice:s.mergeNotice;if(m.id===id)return {noticeId:id,action,version:approvalVersion(s,action),stageId:s.workflow?.legacy?undefined:s.workflow?.stageId};}
}
export function bindingValid(s:Session,b:ApprovalBinding|undefined){const current=b&&currentBinding(s,b.action);return !!current&&current.noticeId===b!.noticeId&&current.version===b!.version&&current.stageId===b!.stageId;}
