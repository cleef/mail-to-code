import {readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configDir} from './config.js';
import {z} from 'zod';
import type {Session,WorkflowStage,WorkflowState} from './types.js';
export const WorkflowProposalSchema=z.object({decision:z.enum(['clarify','propose_step','complete']),kind:z.enum(['documentation','implementation','maintenance']),name:z.string().min(1).max(200),rationale:z.string().min(1).max(10000),deliverables:z.array(z.string().min(1).max(2000)).max(30),acceptance:z.array(z.string().min(1).max(2000)).max(30)}).strict();
export type WorkflowProposal=z.infer<typeof WorkflowProposalSchema>;
export const WORKFLOW_OUTPUT={type:'object',additionalProperties:false,required:['decision','kind','name','rationale','deliverables','acceptance'],properties:{decision:{type:'string',enum:['clarify','propose_step','complete']},kind:{type:'string',enum:['documentation','implementation','maintenance'],description:'documentation is exclusively product planning in the configured product-record repository. Ordinary repository README/docs/acceptance-file changes use maintenance.'},name:{type:'string'},rationale:{type:'string'},deliverables:{type:'array',items:{type:'string'}},acceptance:{type:'array',items:{type:'string'}}}};
export interface WorkflowGuide {text:string;version:string;}
const template=fileURLToPath(new URL('../../config-templates/WORKFLOW.md',import.meta.url));
export const workflowGuidePath=(directory=configDir())=>join(directory,'WORKFLOW.md');
export async function readWorkflowGuide(directory=configDir()):Promise<WorkflowGuide>{
 let text:string;
 try{const info=await lstat(workflowGuidePath(directory));if(!info.isFile()||(info.mode&0o077)||info.size>32768)throw Error('WORKFLOW.md must be a private regular file (600), at most 32 KiB');text=await readFile(workflowGuidePath(directory),'utf8');}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;text=await readFile(template,'utf8');}
 if(!text.trim()||/-----BEGIN [^-]*PRIVATE KEY-----|\b(?:access_token|refresh_token|client_secret|api_key|password)\s*[=:]\s*["']?\S+/i.test(text))throw Error('WORKFLOW.md is empty or contains possible credentials');
 return{text,version:createHash('sha256').update(text).digest('hex')};
}
export async function initializeWorkflowGuide(directory=configDir()){
 await mkdir(directory,{recursive:true,mode:0o700});const path=workflowGuidePath(directory);
 try{await writeFile(path,await readFile(template,'utf8'),{mode:0o600,flag:'wx'});return{path,created:true};}
 catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;return{path,created:false};}
}
export function ensureWorkflow(s:Session,legacy=false):WorkflowState{return s.workflow ||= {stageId:s.id+'-s1',number:1,legacy,history:[]};}
export function stageBinding(s:Session){return s.workflow&&!s.workflow.legacy?{stage:s.workflow.stageId,proposal:s.workflow.proposal,workflow:s.workflow.guide?.version}:{};}
export function stageLabel(s:Session){return s.workflow?`阶段 ${s.workflow.number}：${s.workflow.proposal?.name||'兼容阶段'}（${s.workflow.stageId}）`:'兼容单阶段';}
export function advanceDocumentation(s:Session):boolean{
 return s.workflow?.proposal?.kind==='documentation'&&advanceCompletedStage(s);
}
export function advanceRequestedStage(s:Session):boolean{
 return !!s.conversation?.requests.some(r=>r.stageId===s.workflow?.stageId)&&advanceCompletedStage(s);
}
export function advanceCompletedStage(s:Session):boolean{
 const w=s.workflow;
 if(!['MERGED','DONE'].includes(s.state)||!w?.proposal||!s.targets?.length||s.targets.some(t=>!t.mergeSha)||s.mergeUncertain||s.partialMerge||s.targets.some(t=>t.manualMerge||t.deployUncertain)||w.history.some(h=>h.id===w.stageId))return false;
 const stage:WorkflowStage={id:w.stageId,number:w.number,proposal:structuredClone(w.proposal),guide:structuredClone(w.guide),summary:s.summary,confirmedPlan:w.confirmedPlan,documentVersion:s.documentVersion,documents:structuredClone(w.documents),targets:structuredClone(s.targets),references:structuredClone(s.references||[]),mergeOrder:[...(s.mergeOrder||[])],planNotice:s.planNotice,reviewNotice:s.reviewNotice,mergeNotice:s.mergeNotice,planManifest:s.planManifest,reviewManifest:s.reviewManifest,analysisThreadId:s.analysisThreadId,completedAt:new Date().toISOString()};
 w.history.push(stage);w.number++;w.stageId=s.id+'-s'+w.number;w.legacy=false;
 for(const k of ['proposal','guide','documents','confirmed','confirmedPlan'] as const)delete w[k];
 s.cancellationEpoch++;s.targets=[];s.references=[];s.mergeOrder=[];s.planningSnapshots={};s.planningLocked=false;s.pendingStart=false;s.directRunRequested=false;s.repo='';s.state='QUEUED';s.blockedPhase='plan';
 for(const k of ['planNotice','reviewNotice','mergeNotice','planManifest','reviewManifest','documentVersion','profileVersions','planRegistryVersions','partialMerge','lastError','failedKind','worktree','branch','baseSha','thread','reviewSha','prNumber','prUrl','mergeSha','deployTarget','deployRelease','deployUncertain'] as const)delete s[k];
 return true;
}
