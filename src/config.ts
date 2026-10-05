import { readFile, mkdir, chmod, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import {ProfileSchema} from './profile.js';
import { OperationSchema, OperationIdSchema } from './operations.js';

export const configDir = () => process.env.MAIL_TO_CODE_CONFIG_DIR || join(homedir(), '.config/mail-to-code');
const command = z.object({ executable: z.string().min(1), args: z.array(z.string()), cwd: z.string().default('.') }).strict();
const repository = z.object({
  path: z.string(), github: z.string().regex(/^[\w.-]+\/[\w.-]+$/), baseBranch: z.string().default('main'),
  mergeMethod:z.enum(['merge','squash','rebase']).default('merge'), productDocs: z.string().optional(), checks: z.array(command).default([]),
  operations: z.record(OperationIdSchema, OperationSchema).optional(),
  deployment: z.object({ host: z.string().regex(/^[\w.@-]+$/), domain: z.string().regex(/^[\w.-]+$/), remoteBase: z.string().regex(/^\/[\w./-]+$/), script:z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w./-]+$/).default('scripts/deploy.sh'), adapter:z.literal('script').default('script'), args:z.array(z.string()).default([]), healthPaths:z.array(z.string().regex(/^\/(?!\/)/)).default(['/']), enabled: z.boolean().default(false), preDeployOperations: z.array(OperationIdSchema).max(20).optional() }).strict().optional()
}).strict();
export const ConfigSchema = z.object({
  engine:z.enum(['legacy','async-cli']).default('legacy'),
  gmailAddress: z.string().email(), ownerAddress: z.string().email(),
  dataDir: z.string().default('~/.local/share/mail-to-code'), codexCommand: z.string().default('codex'),
  pollSeconds: z.number().int().min(10).default(60), timeoutSeconds: z.number().int().min(30).default(3600),
  oauthPort: z.number().int().min(1024).max(65535).default(8765),
  githubTokenFile: z.string().optional(), repositories: z.record(repository).default({}),
  projectsRoot:z.string().default('~/projects'),productDocs:z.string().default(''),
  profiles:z.record(ProfileSchema).default({}),controllerRepository:z.string().default(''),protectedRepositories:z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).default([]),
  screenshotImage: z.string().default('localhost/mail-to-code-preview:1.63.0'),
  previewEnabled: z.boolean().default(true)
}).strict().superRefine((config, ctx) => {
  for (const [name, repo] of Object.entries(config.repositories)) {
    const prerequisites = repo.deployment?.preDeployOperations || [];
    if (config.engine !== 'async-cli' && (Object.keys(repo.operations || {}).length || prerequisites.length)) ctx.addIssue({ code: 'custom', path: ['repositories', name], message: 'OPERATIONS_REQUIRE_ASYNC_CLI' });
    if (new Set(prerequisites).size !== prerequisites.length || prerequisites.some(id => !repo.operations?.[id])) ctx.addIssue({ code: 'custom', path: ['repositories', name, 'deployment', 'preDeployOperations'], message: 'Unique configured operations are required' });
  }
});
export type Config = z.infer<typeof ConfigSchema>;
export const expand = (path: string) => resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
export async function loadConfig(): Promise<Config> {
  const path = join(configDir(), 'config.json');
  await privateFile(path);
  const config = ConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  config.gmailAddress = config.gmailAddress.toLowerCase(); config.ownerAddress = config.ownerAddress.toLowerCase();
  if (config.gmailAddress === config.ownerAddress) throw new Error('Agent and owner mailboxes must differ');
  config.dataDir = expand(config.dataDir);config.projectsRoot=expand(config.projectsRoot);config.productDocs=config.productDocs?expand(config.productDocs):'';
  for (const repo of Object.values(config.repositories)) { repo.path = expand(repo.path); if (repo.productDocs) repo.productDocs = expand(repo.productDocs); }
  if (config.githubTokenFile) config.githubTokenFile = expand(config.githubTokenFile);
  if(!config.controllerRepository){
    const {execute}=await import('./process.js');
    const {fileURLToPath}=await import('node:url');
    const root=fileURLToPath(new URL('../../',import.meta.url));
    const remote=await execute('git',['remote','get-url','origin'],{cwd:root}).then(r=>r.stdout.trim(),()=> '');
    config.controllerRepository=/^(?:git@github.com:|https:\/\/github.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote)?.[1]||'';
    if(!config.controllerRepository)throw Error('Set controllerRepository when installing without a GitHub origin');
  }
  return config;
}
export async function privateDir(path: string) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
export async function privateFile(path: string) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077)) throw new Error(`Private file permissions must be 600: ${path}`);
}
