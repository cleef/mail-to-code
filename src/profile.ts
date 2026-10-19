// Legacy project profile shapes are retained as inert agent context.
import { z } from 'zod/v3';
export const CommandSchema = z.object({ executable: z.string().min(1), args: z.array(z.string()).default([]), cwd: z.string().default('.'), env: z.record(z.string()).default({}) }).strict();
const relative = z.string().refine(p => !p.startsWith('/') && !p.split(/[\\/]/).includes('..') && !/[\r\n\0]/.test(p), 'Expected a worktree-relative path');
const pinnedImage = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/);
export const ProfileSchema = z.object({
    kind: z.enum(['generic', 'docs', 'taro', 'controller']).default('generic'),
    runtime: z.array(z.string()).default(['node']), image: pinnedImage.optional(),
    install: z.array(CommandSchema).default([]), build: z.array(CommandSchema).default([]), checks: z.array(CommandSchema).default([]),
    packageSources: z.array(z.string().regex(/^[a-z0-9.-]+$/)).default(['registry.npmjs.org']),
    preview: z.object({ kind: z.enum(['none', 'static', 'h5']).default('none'), mounts: z.array(z.object({ source: relative, destination: relative })).default([]), paths: z.array(z.string()).default(['/']), fixtures: relative.optional() }).default({}),
    services: z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), image: pinnedImage, args: z.array(z.string()).default([]), env: z.record(z.string()).default({}), health: z.array(z.string()).min(1) })).default([]),
    generatedFiles:z.array(relative).default([]),
    pendingChecks: z.array(z.string()).default([])
}).strict();
export type ProjectProfile = z.infer<typeof ProfileSchema>;
