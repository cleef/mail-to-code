import {z} from 'zod';
import type {Session,RepoExecution} from './types.js';
import {QuestionProposalSchema,QUESTION_OUTPUT} from './questions.js';

const Role=z.enum(['modify','reference','product_record']);
const nullableId=z.string().min(1).max(500).nullable();
export const ScopeDecisionSchema=z.object({
  decision:z.enum(['within_approved_scope','propose_scope_change','need_context']),
  reason:z.string().min(1).max(4000),
  requests:z.array(z.object({projectId:nullableId,identity:nullableId,path:nullableId,role:Role,reason:z.string().min(1).max(2000)}).strict()).max(20),
  questions:z.array(QuestionProposalSchema).max(10)
}).strict();
export type ScopeDecision=z.infer<typeof ScopeDecisionSchema>;
export const SCOPE_OUTPUT={type:'object',additionalProperties:false,required:['decision','reason','requests','questions'],properties:{
  decision:{type:'string',enum:['within_approved_scope','propose_scope_change','need_context']},reason:{type:'string'},
  requests:{type:'array',items:{type:'object',additionalProperties:false,required:['projectId','identity','path','role','reason'],properties:{projectId:{type:['string','null']},identity:{type:['string','null']},path:{type:['string','null']},role:{type:'string',enum:['modify','reference','product_record']},reason:{type:'string'}}}},
  questions:{type:'array',items:QUESTION_OUTPUT}
}};
export class ScopeResolutionError extends Error {
  constructor(){super('SCOPE_DECISION_INVALID: 只读范围判断未通过结构或权限校验；保留成果，未扩大权限。');}
}
const role=(s:Session,t:RepoExecution)=>s.references?.some(r=>r.identity===t.identity)?'reference':t.auxiliary?'product_record':'modify';
export function scopeInventory(s:Session){return [...(s.targets||[]),...(s.references||[])].map(t=>({
  projectId:t.projectId,identity:t.identity,name:t.displayName||t.projectId,path:t.path,relativePath:t.relativePath,
  worktree:t.worktree||null,role:role(s,t),current:t.projectId===s.repo,
  status:t.mergeSha?'merged':t.reviewSha?'review_ready':'pending',evidenceOnly:!!t.auxiliary,recordsEvidence:!!t.recordEvidence
}));}

// Only identities, declared roles and structural consistency are compared here.
// Descriptions are data for Codex, never aliases or permissions.
export function validateScope(s:Session,d:ScopeDecision):string[]{
  const inventory=scopeInventory(s),changes:string[]=[],seen=new Set<string>();
  for(const r of d.requests){
    const key=r.projectId||r.path;
    if(!key||seen.has(key))throw new Error('SCOPE_REQUEST_DUPLICATE_OR_MISSING');seen.add(key);
    if(r.projectId){
      const t=inventory.find(t=>t.projectId===r.projectId);
      if(!t||t.identity!==r.identity||r.path!==null&&r.path!==t.path&&r.path!==t.relativePath)throw new Error('SCOPE_IDENTITY_MISMATCH');
      if(t.role!==r.role&&r.role!=='reference')changes.push(`${t.name} (${t.projectId})：${t.role} → ${r.role}；${r.reason}`);
    }else{
      if(r.identity!==null||!r.path||r.path.startsWith('/')||r.path.split(/[\\/]/).some(p=>!p||p==='..'||p==='.')||/[\r\n\0]/.test(r.path))throw new Error('SCOPE_NEW_PATH_INVALID');
      if(inventory.some(t=>t.relativePath===r.path))throw new Error('SCOPE_KNOWN_PROJECT_REQUIRES_ID');
      changes.push(`${r.path}：未批准 → ${r.role}；${r.reason}`);
    }
  }
  if(d.decision==='within_approved_scope'&&(changes.length||d.questions.length))throw new Error('SCOPE_CONTINUE_CONTRADICTION');
  if(d.decision==='propose_scope_change'&&(!changes.length||d.questions.length))throw new Error('SCOPE_CHANGE_CONTRADICTION');
  if(d.decision==='need_context'){
    if(!d.questions.length||d.questions.some(q=>q.kind!=='open'||q.action&&q.action!=='future'||!q.humanReason||q.options?.length))throw new Error('SCOPE_CONTEXT_QUESTION_INVALID');
  }else if(d.questions.length)throw new Error('SCOPE_UNEXPECTED_QUESTION');
  return changes;
}

export const SCOPE_GUIDANCE=`你用 scopeDecision 理解后续仓库工作与真实范围变化。控制器会按当前批准清单依次执行全部修改仓库，产品证据最后回填。仅当前 worktree 可写是隔离措施，不代表其他已批准仓库未授权；其后续实施、跨仓库依赖和证据回填属于 within_approved_scope，不要求再次 START。
已知仓库必须复制清单中的 projectId 和 identity，path=null；需要的 role 不超过已批准角色。仅引用已批准可写仓库作只读参考不扩大权限。新仓库用 projectId=null、identity=null 和项目根目录内的相对 path；不得虚构 ID 或身份。新增仓库或扩大角色权限使用 propose_scope_change，reason 和各请求说明具体变化及影响；不能写新增范围，控制器只读规划后另取 START。
无范围请求时返回 within_approved_scope、requests=[]、questions=[]。客观信息确实无法从给定上下文查明且必须由用户提供时使用 need_context，questions 明确缺少什么和 humanReason；权限隔离、技术错误、进度和已知答案不是人类问题。不要用描述字符串代替结构化引用。
scopeDecision 不改变当前仓库的 outcome、questions 或完成事实。当前仓库尚未完成、真实需求阻塞或测试失败时如实返回，不能为推进其他仓库虚报 implementation_ready。已确认的同版本设计不因文档仍写待确认而重复询问；新阶段及实际版本、权限变化保留新的授权边界。`;
