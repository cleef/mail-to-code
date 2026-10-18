import {readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configDir} from './config.js';

export interface WorkflowGuide {text:string;version:string;}
const template=fileURLToPath(new URL('../../config-templates/WORKFLOW.md',import.meta.url));
export const workflowGuidePath=(directory=configDir())=>join(directory,'WORKFLOW.md');
export async function readWorkflowGuide(directory=configDir()):Promise<WorkflowGuide>{
 let text:string;
 try{const info=await lstat(workflowGuidePath(directory));if(!info.isFile()||(info.mode&0o077)||info.size>32768)throw Error('WORKFLOW.md must be a private regular file (600), at most 32 KiB');text=await readFile(workflowGuidePath(directory),'utf8');}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;text=await readFile(template,'utf8');}
 if(!text.trim()||/-----BEGIN [^-]*PRIVATE KEY-----|\b(?:access_token|refresh_token|client_secret|api_key|password)\s*[=:]\s*["']?\S+/i.test(text))throw Error('WORKFLOW.md is empty or contains possible credentials');
 return{text,version:createHash('sha256').update(text).digest('hex')};
}
export async function initializeWorkflowGuide(directory=configDir()){
 await mkdir(directory,{recursive:true,mode:0o700});const path=workflowGuidePath(directory);
 try{await writeFile(path,await readFile(template,'utf8'),{mode:0o600,flag:'wx'});return{path,created:true};}
 catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;return{path,created:false};}
}
