import {z} from 'zod';
export const MailBriefSchema=z.object({
 goal:z.string().min(1).max(1200),
 choices:z.array(z.object({category:z.enum(['product','technical']),topic:z.string().min(1).max(160),choice:z.string().min(1).max(1200),reason:z.string().min(1).max(1200),tradeoff:z.string().min(1).max(1200)}).strict()).max(16),
 changes:z.array(z.string().min(1).max(1200)).max(16)
}).strict();
export type MailBrief=z.infer<typeof MailBriefSchema>;
export const MAIL_BRIEF_OUTPUT={type:'object',additionalProperties:false,required:['goal','choices','changes'],properties:{goal:{type:'string'},choices:{type:'array',items:{type:'object',additionalProperties:false,required:['category','topic','choice','reason','tradeoff'],properties:{category:{type:'string',enum:['product','technical']},topic:{type:'string'},choice:{type:'string'},reason:{type:'string'},tradeoff:{type:'string'}}}},changes:{type:'array',items:{type:'string'}}}};
export const MAIL_BRIEF_PROMPT='返回 mailBrief：goal 用一两句说明产品目标或本轮成果；choices 列出产品/技术选择、理由、代价或限制（category=product/technical）；changes 仅列相比上一轮的变化，没有变化用空数组。不放配置 JSON、版本指纹、命令、目录或 Git SHA；不要在简报里声称控制器测试/合并/部署已完成。真实范围、状态、验证和待确认问题由控制器补入。choices 只写设计决策，不写仓库责任分工、验收清单、阶段状态或回复指令；不重复 goal 和 changes。简报是 summary/阶段提案的可读摘要，不得新增范围或授权条件。';
