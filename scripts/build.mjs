import {rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// A clean build cannot retain executable artifacts of the retired transport.
const root=fileURLToPath(new URL('../',import.meta.url));
await rm(new URL('../dist/',import.meta.url),{recursive:true,force:true});
const child=spawn(process.execPath,[fileURLToPath(new URL('../node_modules/typescript/bin/tsc',import.meta.url))],{cwd:root,stdio:'inherit'});
child.once('error',()=>{process.exitCode=1;});
child.once('exit',(code,signal)=>{process.exitCode=signal?1:code??1;});
