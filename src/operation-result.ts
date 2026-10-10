import { z } from 'zod/v3';
export const OperationResultSchema = z.object({
    ok: z.boolean(), summary: z.string().max(4000),
    evidence: z.record(z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()])).refine(v => Object.keys(v).length <= 100)
}).strict();
export type OperationResult = z.infer<typeof OperationResultSchema>;
