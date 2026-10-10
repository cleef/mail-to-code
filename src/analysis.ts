import {QuestionInputSchema,QUESTION_OUTPUT} from './questions.js';
import {MailBriefSchema,MAIL_BRIEF_OUTPUT} from './mail-brief.js';
import { z } from 'zod/v3';
import { ProfileSchema } from './profile.js';
import { MemoryProposalSchema } from './memory.js';
import {WorkflowProposalSchema,WORKFLOW_OUTPUT} from './workflow.js';
export const AnalysisSchema = z.object({
  mailBrief:MailBriefSchema.optional(),
  workflow:WorkflowProposalSchema,
  outcome:z.enum(['plan_ready','needs_input','blocked']),summary:z.string().min(1).max(20000),questions:z.array(QuestionInputSchema).max(10),
  projects:z.array(z.object({path:z.string().min(1),displayName:z.string().min(1).max(120),role:z.enum(['modify','reference','product_record']),profileProposal:ProfileSchema.optional(),pendingChecks:z.array(z.string()).max(20)}).strict()).max(16),
  memoryProposals:z.array(MemoryProposalSchema).max(16).default([]),
  productId:z.string().regex(/^[A-Z][A-Z0-9_-]*-\d+$/).optional(),mergeOrder:z.array(z.string()).max(16)
}).strict();
export type AnalysisResult=z.infer<typeof AnalysisSchema>;
const project={type:'object',additionalProperties:false,required:['path','displayName','role','profileProposal','pendingChecks'],properties:{path:{type:'string'},displayName:{type:'string'},role:{type:'string',enum:['modify','reference','product_record']},profileProposal:{type:['string','null'],description:'Complete ProjectProfile JSON encoded as a string: kind, runtime, install/build/checks command arrays, preview, pendingChecks. Never a single command object. Null to use controller defaults.'},pendingChecks:{type:'array',items:{type:'string'}}}};
export const ANALYSIS_OUTPUT_SCHEMA={type:'object',additionalProperties:false,required:['mailBrief','outcome','summary','questions','projects','productId','mergeOrder','memoryProposals','workflow'],properties:{mailBrief:MAIL_BRIEF_OUTPUT,workflow:WORKFLOW_OUTPUT,memoryProposals:{type:'array',items:{type:'object',additionalProperties:false,required:['path','descriptions'],properties:{path:{type:'string'},descriptions:{type:'array',items:{type:'string'}}}}},outcome:{type:'string',enum:['plan_ready','needs_input','blocked']},summary:{type:'string'},questions:{type:'array',items:QUESTION_OUTPUT},projects:{type:'array',items:project},productId:{type:['string','null']},mergeOrder:{type:'array',items:{type:'string'}}}};
