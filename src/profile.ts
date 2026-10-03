import { z } from 'zod';
export const CommandSchema = z.object({ executable: z.string().min(1), args: z.array(z.string()).default([]), cwd: z.string().default('.'), env: z.record(z.string()).default({}) }).strict();
const relative = z.string().refine(p => !p.startsWith('/') && !p.split(/[\\/]/).includes('..') && !/[\r\n\0]/.test(p), 'Expected a worktree-relative path');
export const ProfileSchema = z.object({
    kind: z.enum(['generic', 'docs', 'taro', 'controller']).default('generic'),
    runtime: z.array(z.string()).default(['node']), image: z.string().regex(/@sha256:[a-f0-9]{64}$/).optional(),
    install: z.array(CommandSchema).default([]), build: z.array(CommandSchema).default([]), checks: z.array(CommandSchema).default([]),
    packageSources: z.array(z.string().regex(/^[a-z0-9.-]+$/)).default(['registry.npmjs.org']),
    preview: z.object({ kind: z.enum(['none', 'static', 'h5']).default('none'), mounts: z.array(z.object({ source: relative, destination: relative })).default([]), paths: z.array(z.string()).default(['/']), fixtures: relative.optional() }).default({}),
    services: z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), image: z.string().regex(/@sha256:[a-f0-9]{64}$/), args: z.array(z.string()).default([]), env: z.record(z.string()).default({}), health: z.array(z.string()).min(1) })).default([]),
    generatedFiles:z.array(relative).default([]),
    pendingChecks: z.array(z.string()).default([])
}).strict();
export type ProjectProfile = z.infer<typeof ProfileSchema>;
export function validateProfile(input: unknown): ProjectProfile {
    const p = ProfileSchema.parse(input);
    for (const c of [...p.install, ...p.build, ...p.checks]) {
        relative.parse(c.cwd);
        if (/[\r\n\0]/.test(c.executable) || /^(ssh|sudo|su|podman|docker|systemctl|gh|git)$/.test(c.executable.split('/').at(-1)!))
            throw new Error('Privileged/controller commands cannot be profile steps');
        for (const k of Object.keys(c.env))
            if (/TOKEN|SECRET|PASSWORD|PRIVATE|SSH|GH_|GITHUB|GMAIL|MAIL_TO_CODE|MAIL_AGENT|CODEX_HOME|LD_PRELOAD|NODE_OPTIONS/.test(k))
                throw new Error('Profile environment cannot contain credentials or runtime injection');
    }
    for(const path of p.generatedFiles)if(!path||path==='.'||path.split('/').some(v=>['.git','.codex','.agents','node_modules'].includes(v)))throw Error('Invalid generated source file');
    if (p.services.length && !p.image)
        throw new Error('Local services require a pinned test runtime image');
    for (const service of p.services)
        for (const k of Object.keys(service.env))
            if (/TOKEN|SECRET|PRIVATE|SSH|GH_|GITHUB|GMAIL/.test(k))
                throw new Error('Service credentials must be synthetic test data');
    for (const path of p.preview.paths)
        if (!path.startsWith('/') || path.startsWith('//'))
            throw new Error('Preview paths must be local');
    return p;
}
