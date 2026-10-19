import { readFile, mkdir, chmod, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { z } from 'zod/v3';
import {ProfileSchema} from './profile.js';
const OperationIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const OperationSchema = z.object({ description: z.string(), target: z.string(), effect: z.enum(['read', 'write']), script: z.string(), args: z.array(z.string()).default([]), timeoutSeconds: z.number().default(1800), reconcileScript: z.string().optional() }).strict();

export const configDir = () => process.env.MAIL_TO_CODE_CONFIG_DIR || join(homedir(), '.config/mail-to-code');
const command = z.object({ executable: z.string().min(1), args: z.array(z.string()), cwd: z.string().default('.') }).strict();
const repository = z.object({
  path: z.string(), github: z.string().regex(/^[\w.-]+\/[\w.-]+$/), baseBranch: z.string().default('main'),
  mergeMethod:z.enum(['merge','squash','rebase']).default('merge'), productDocs: z.string().optional(), checks: z.array(command).default([]),
  operations: z.record(OperationIdSchema, OperationSchema).optional(),
  deployment: z.object({ trustedScriptSha: z.string().regex(/^[a-f0-9]{40}$/).optional(), host: z.string().regex(/^[\w.@-]+$/), domain: z.string().regex(/^[\w.-]+$/), remoteBase: z.string().regex(/^\/[\w./-]+$/), script:z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w./-]+$/).default('scripts/deploy.sh'), adapter:z.literal('script').default('script'), args:z.array(z.string()).default([]), healthPaths:z.array(z.string().regex(/^\/(?!\/)/)).default(['/']), enabled: z.boolean().default(false), preDeployOperations: z.array(OperationIdSchema).max(20).optional() }).strict().optional()
}).strict();
export const ConfigSchema = z.object({
  engine:z.enum(['async-cli']).default('async-cli'),
  asyncMailOutput:z.enum(['queue-mail','assistant-final']).default('queue-mail'),
  gmailAddress: z.string().email(), ownerAddress: z.string().email(),
  dataDir: z.string().default('~/.local/share/mail-to-code'), codexCommand: z.string().default('codex'),
  claudeCommand: z.string().min(1).default('claude'),
  mailCodexHome: z.string().min(1).optional(),
  pollSeconds: z.number().int().min(10).default(60), timeoutSeconds: z.number().int().min(30).default(3600),
  githubTokenFile: z.string().optional(), repositories: z.record(repository).default({}),
  projectsRoot:z.string().default('~/projects'),productDocs:z.string().default(''),
  profiles:z.record(ProfileSchema).default({}),controllerRepository:z.string().default(''),protectedRepositories:z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).default([]),
  screenshotImage: z.string().default('localhost/mail-to-code-preview:1.63.0'),
  previewEnabled: z.boolean().default(true)
}).strict();
export type Config = z.infer<typeof ConfigSchema>;
export const expand = (path: string) => resolve(path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
export async function loadConfig(mailSetupOnly=false): Promise<Config> {
  const path = join(configDir(), 'config.json');
  await privateFile(path);
  const raw=JSON.parse(await readFile(path,'utf8'));
  if('oauthPort' in raw&&!mailSetupOnly)throw Error('MAIL_MIGRATION_REQUIRED: stop service and run migrate-mail --dry-run');
  if(mailSetupOnly)delete raw.oauthPort;
  const config = ConfigSchema.parse(raw);
  config.gmailAddress = config.gmailAddress.toLowerCase(); config.ownerAddress = config.ownerAddress.toLowerCase();
  if (config.gmailAddress === config.ownerAddress) throw new Error('Agent and owner mailboxes must differ');
  config.dataDir = expand(config.dataDir);config.projectsRoot=expand(config.projectsRoot);config.productDocs=config.productDocs?expand(config.productDocs):'';
  if (config.mailCodexHome) config.mailCodexHome = expand(config.mailCodexHome);
  for (const repo of Object.values(config.repositories)) { repo.path = expand(repo.path); if (repo.productDocs) repo.productDocs = expand(repo.productDocs); }
  if (config.githubTokenFile) config.githubTokenFile = expand(config.githubTokenFile);
  return config;
}
export async function privateDir(path: string) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
export async function privateFile(path: string) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077)) throw new Error(`Private file permissions must be 600: ${path}`);
}
