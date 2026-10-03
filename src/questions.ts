import {z} from 'zod';
import type {QuestionInput,QuestionProposal} from './types.js';
const optionalText=(max:number)=>z.string().trim().min(1).max(max).nullish().transform(v=>v??undefined);
const OptionSchema=z.object({id:z.string().min(1).max(80),label:z.string().min(1).max(300),impact:z.string().min(1).max(1200)}).strict();
// Optional metadata keeps historical questions readable. Fresh model output uses
// the complete wire schema below, including explicit nulls and empty arrays.
export const QuestionProposalSchema=z.object({
 text:z.string().min(1).max(2000),kind:z.enum(['confirm','choice','open']),
 action:z.enum(['START','APPROVE','DEPLOY','future']).nullish().transform(v=>v??undefined),
 dependsOn:z.array(z.string()).max(20),humanReason:optionalText(2000),
 options:z.array(OptionSchema).max(3).optional(),recommendedOptionId:optionalText(80),recommendationReason:optionalText(2000)
}).strict().superRefine((q,ctx)=>{
 if(q.options===undefined)return; // Historical metadata is never fabricated.
 const invalid=(message:string)=>ctx.addIssue({code:'custom',message});
 if(q.kind!=='confirm'&&!q.humanReason)invalid('QUESTION_HUMAN_REASON_MISSING');
 if(q.kind==='choice'){
  if(q.options.length<2)invalid('QUESTION_OPTIONS_MISSING');
  if(new Set(q.options.map(o=>o.id)).size!==q.options.length)invalid('QUESTION_OPTION_DUPLICATE');
  if(q.action&&q.action!=='future'){
   if(q.recommendedOptionId||q.recommendationReason)invalid('QUESTION_AUTHORITY_RECOMMENDATION');
  }else if(!q.options.some(o=>o.id===q.recommendedOptionId)||!q.recommendationReason)invalid('QUESTION_RECOMMENDATION_INVALID');
 }else if(q.options.length||q.recommendedOptionId||q.recommendationReason)invalid('QUESTION_FACT_OR_AUTHORITY_HAS_OPTIONS');
});
export const QuestionInputSchema=z.union([z.string().min(1).max(2000),QuestionProposalSchema]);
export function asQuestion(q:QuestionInput):QuestionProposal{return typeof q==='string'?{text:q,kind:'open',dependsOn:[]}:q;}
export const QUESTION_OUTPUT={type:'object',additionalProperties:false,required:['text','kind','action','dependsOn','humanReason','options','recommendedOptionId','recommendationReason'],properties:{
 text:{type:'string'},kind:{type:'string',enum:['confirm','choice','open']},action:{type:['string','null'],enum:['START','APPROVE','DEPLOY','future',null]},dependsOn:{type:'array',items:{type:'string'}},humanReason:{type:['string','null']},
 options:{type:'array',items:{type:'object',additionalProperties:false,required:['id','label','impact'],properties:{id:{type:'string'},label:{type:'string'},impact:{type:'string'}}}},recommendedOptionId:{type:['string','null']},recommendationReason:{type:['string','null']}
}};
export const DECISION_GUIDANCE=`Codex 自主完成技术实现和可逆的体验默认值：先查代码、既有约定和操作人已确认意见，再给出具体方案。分页数量、稳定排序、先筛选后分页、条件切换重置列表和忽略迟到响应通常由你决定，不逐项询问。检查旧客户端是否依赖完整列表；默认分页会改变该行为，提出适配和发布方案，不能声称默认参数天然兼容。
只把真实需要操作人决定的业务目标、重要产品取舍、隐私或公开范围、显著成本、不可逆影响、以及无法自行解决的已确认要求冲突放入 questions。humanReason 明确为什么需要人判断，以及答案怎样影响继续工作；程序拒绝、进度、可自行查明的事实和已有确定答案不能当讨论问题。
真正的选择题 kind=choice：给出2到3个有意义的 options（id、label、impact），推荐项放首位，recommendedOptionId 指向它，recommendationReason 解释理由和主要代价。不要给明显错误的凑数选项。纯粹缺少客观信息 kind=open：说明需要什么及原因，options=[]、recommendedOptionId=null、recommendationReason=null，不编造答案。kind=confirm 专用于当前版本执行授权，同样不设置选项或推荐；没有权限时不能将选择改成执行确认。授权目标选择可以是 kind=choice，但 action=START/APPROVE/DEPLOY 时不设置推荐，具体执行仍需明确批准；选目标与业务推荐不能混同。分析/开发输出的讨论 action=null、dependsOn=[]，真正执行确认由控制器提供的当前版本另行产生。
mailBrief.choices 是你形成的方案要点，不是逐项等待用户批准。无真实讨论问题时 questions=[]，形成具体方案并推进到可确认的阶段；自主决策不授权写入、合并或发布。用户指定的方案优先于默认值。
文档中的“待用户确认”字样不是独立授权依据。结合文档版本、同版本确认记录、阶段与现有授权判断；已确认事项不重复询问，不能因旧文档措辞循环澄清。确认记录缺失或范围/版本实际变化时遵守新的具体版本授权，不沿用旧批准。
跨仓库任务结合已批准的仓库身份、角色和阶段判断范围。单个 worktree 的写入隔离不要求对其他已批准仓库重复授权；后续实施和证据回填继续原阶段。只有真实新增仓库、角色扩大或有效执行条件变化才需要新的具体确认，邮件说明实际差异和影响，不只说新版本。引用错误和程序结构错误先内部处理，不能变成用户问题。
推荐只是建议，未回复或笼统“同意”不能替用户选择。明确“采用推荐方案”等回复由你结合问题引用理解为具体选择并保存 feedback；它本身不批准其他 START、合并或部署，也不授予未来版本权限。`;
