export type ProfileSource = 'auto' | 'proposal' | 'external' | 'legacy';
export type State = 'QUEUED' | 'PLANNING' | 'WAITING_START' | 'RUNNING' | 'WAITING_INPUT' | 'WAITING_REVIEW' | 'MERGING' | 'MERGED' | 'DEPLOYING' | 'DONE' | 'FAILED' | 'CANCELLED';
export type JobKind = 'plan' | 'develop' | 'merge' | 'deploy' | 'catalog' | 'interpret';
export interface Session {
  mailBrief?: import('./mail-brief.js').MailBrief;
  checks?:string[];
  workflow?: WorkflowState;
  id: string; title: string; repo: string; state: State; subject: string; createdAt: string;
  initialMessageId: string; initialRfcId: string; initialThreadId: string; threadId?: string;
  worktree?: string; branch?: string; baseSha?: string; thread?: string; productId?: string;
  summary: string; planNotice?: string; reviewNotice?: string; mergeNotice?: string;
  reviewSha?: string; prNumber?: number; prUrl?: string; mergeSha?: string;
  failedKind?: JobKind; blockedPhase?: 'plan' | 'develop'; deployRelease?: string; deployUncertain?: boolean;
  targets?: RepoExecution[]; mergeOrder?: string[]; profileVersions?: Record<string,string>; documentVersion?: string; reviewManifest?: string; partialMerge?: boolean; system?: boolean; planRegistryVersions?: Record<string,string>; deployTarget?:string; mergeUncertain?:string; needsRefresh?:'plan'|'review';
  cancellationEpoch: number; revision: number; lastError?: string;
  originalRequest?: string; analysisThreadId?: string; projectHints?: string[]; explicitProductId?: string;
  references?: RepoExecution[]; planningSnapshots?: Record<string,string>; planningLocked?: boolean;
  planManifest?: string;
  analysisCandidates?: {path:string;displayName:string;role:'modify'|'reference'|'product_record'}[];
  pendingStart?: boolean; directRunRequested?: boolean;
  conversation?: { records: ReplyRecord[]; requests: {id:string;text:string;source:string;stageId?:string}[]; answered: string[] };
}
export interface ApprovalBinding { noticeId: string; version: string; action: 'START'|'APPROVE'|'DEPLOY'; stageId?:string; }
export interface ReplyContext { mode?:'intake'|'outcome'; facts?:ExecutionFact[]; candidate?:{kind:string;text:string;scopeChange?:ScopeChange;questions?:QuestionInput[];sourceDecision?:SemanticDecision;attachments?:Attachment[];action?:ApprovalBinding['action'];version?:string}; snapshot?:string; incoming: Incoming; epoch: number; binding?: ApprovalBinding; command?: string; project?: string; result?: ReplyIntent | ReplyDecision; waitingForEarlier?:boolean; stageId?:string; parent?: {id:string;text:string;questions:MailQuestion[]}; previous?: {id:string;text:string;questions:MailQuestion[]}[]; }
export interface ReplyIntent { action:'start'|'feedback'|'status'|'cancel'|'retry'|'approve'|'deploy'|'clarify'; clear:boolean; evidence:string; feedback:string; project?:string; question:string; }
export interface ReplyItem {id:string;action:ReplyIntent['action']|'future'|'catalog';clear:boolean;evidence:string;text:string;project?:string;questionRefs:string[];dependsOn:string[];}
export interface QuestionProposal {text:string;kind:'confirm'|'choice'|'open';action?:'START'|'APPROVE'|'DEPLOY'|'future';dependsOn:string[];humanReason?:string;options?:{id:string;label:string;impact:string}[];recommendedOptionId?:string;recommendationReason?:string;}
export type QuestionInput=string|QuestionProposal;
export interface ReplyDecision {items:ReplyItem[];questions:QuestionProposal[];}
export interface ExecutionFact {code:'guard_rejected'|'item_blocked'|'outcome'|'earlier_reply_pending';text:string;itemId?:string;item?:ReplyItem;}
export interface SemanticDecision extends ReplyDecision {version:2;nextStep:'wait'|'analyze'|'revise';revisionPhase:'plan'|'develop'|null;communication:{kind:'internal'|'ask_human'|'requested_status'|'confirmation'|'final_result';text:string};}
export interface MailQuestion extends QuestionProposal {id:string;binding?:ApprovalBinding;}
export interface ReplyRecord {id:string;source:string;stageId?:string;item:ReplyItem;binding?:ApprovalBinding;status:'accepted'|'waiting'|'queued'|'done'|'blocked';jobIds?:string[];dependencies?:string[];reason?:string;factReported?:boolean;revisionPhase?:'plan'|'develop';}
export interface MailSummary {feature:string;rows:{phase:string;status:string;current:boolean;deliveries:{label:string;url?:string}[]}[];}
export interface ScopeChange {reason:string;changes:string[];}
export interface Job { id: string; sessionId: string; stageId?:string; kind: JobKind; feedback: string; scopeChange?:ScopeChange; reply?:ReplyContext; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; }
export interface Attachment { path: string; filename: string; cid?: string; contentType?: 'image/png' | 'image/jpeg'; }
export interface MailBodySnapshot {
  version: 1; text: string; html: string;
  images: {cid:string;filename:string;contentType:'image/png'|'image/jpeg';sha256:string}[];
}
export type MailBlock = {kind:'paragraph';title?:string;text:string} | {kind:'table';title:string;headers:string[];rows:string[][]} | {kind:'image';cid:string;caption:string};
export interface MailPresentation {version:1;configuration?:{project:string;role:string;sources:string[];services:string[];deployment?:string}[];blocks:MailBlock[];text:string;html:string;}
export interface Outbound {
  scopeChange?:ScopeChange;
  stageId?:string;
  id: string; sessionId: string; kind: string; text: string; attachments: Attachment[];
  bodySnapshot?: MailBodySnapshot;
  status: 'pending' | 'sending' | 'sent' | 'uncertain' | 'failed'; gmailId?: string; threadId?: string;
  createdAt: string; lastError?: string; attempts: number;
  rfcMessageId?:string; identityCheckedAt?:string; identityError?:string; sentAt?:string; attemptedAt?:string; identityStatus?:'pending'|'verified'|'failed'; deliveryMarker?:string; approvalBinding?:ApprovalBinding;
  replySourceId?:string; replyMessageId?:string; replyParentRfcId?:string; replyQuoteHash?:string; attachmentHashes?:string[];
  summary?:MailSummary; questions?:MailQuestion[]; presentation?:MailPresentation;
}
export interface Incoming { id: string; threadId: string; rfcId: string; inReplyTo: string; references?:string[]; subject: string; text: string; from: string; trusted: boolean; reason?: string; }

export interface RepoExecution {resultSummary?:string;mailBrief?:import('./mail-brief.js').MailBrief;projectId:string;identity:string;path:string;github:string;baseBranch:string;mergeMethod?:'merge'|'squash'|'rebase';profile:import('./profile.js').ProjectProfile;profileVersion:string;profileSource?:ProfileSource;baselineSnapshot?:string;manualMerge:boolean;deployment?:import('./config.js').Config['repositories'][string]['deployment'];worktree?:string;branch?:string;baseSha?:string;thread?:string;reviewSha?:string;prNumber?:number;prUrl?:string;mergeSha?:string;checks?:string[];diffSummary?:string;attachments?:Attachment[];pendingChecks?:string[];deployRelease?:string;deployUncertain?:boolean;deployed?:boolean;auxiliary?:boolean;recordEvidence?:boolean;logDirectory?:string;displayName?:string;relativePath?:string;}

export interface DocumentInventory {files:string[];missing:string[];version:string;legacyVersion?:string;text:string;baselineSha?:string;}
export interface WorkflowState {stageId:string;number:number;legacy?:boolean;proposal?:import('./workflow.js').WorkflowProposal;guide?:import('./workflow.js').WorkflowGuide;documents?:DocumentInventory;confirmed?:boolean;confirmedPlan?:string;history:WorkflowStage[];}
export interface WorkflowStage {id:string;number:number;proposal:import('./workflow.js').WorkflowProposal;guide?:import('./workflow.js').WorkflowGuide;summary:string;confirmedPlan?:string;documentVersion?:string;documents?:DocumentInventory;targets:RepoExecution[];references:RepoExecution[];mergeOrder:string[];planNotice?:string;reviewNotice?:string;mergeNotice?:string;planManifest?:string;reviewManifest?:string;analysisThreadId?:string;completedAt:string;}
