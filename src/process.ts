import { spawn } from 'node:child_process';
export interface ProcessOptions {cwd?:string;env?:NodeJS.ProcessEnv;signal?:AbortSignal;timeoutMs?:number;onStdout?:(text:string)=>void;onStderr?:(text:string)=>void;maxOutput?:number}
export async function execute(command:string,args:string[],options:ProcessOptions={}):Promise<{stdout:string;stderr:string}> {
  if(options.signal?.aborted)throw new Error('CANCELLED');
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='',ended=false,timedOut=false;const cap=options.maxOutput??2_000_000;
    const child=spawn(command,args,{cwd:options.cwd,env:options.env||process.env,stdio:['ignore','pipe','pipe'],detached:true});
    let force:NodeJS.Timeout|undefined;
    const terminate=()=>{try{if(child.pid)process.kill(-child.pid,'SIGTERM');}catch{}force=setTimeout(()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}},2000);};
    const timer=setTimeout(()=>{timedOut=true;terminate();},options.timeoutMs||3600000);
    options.signal?.addEventListener('abort',terminate,{once:true});
    const cleanup=()=>{clearTimeout(timer);clearTimeout(force);options.signal?.removeEventListener('abort',terminate);};
    child.stdout.on('data',(chunk:Buffer)=>{const text=chunk.toString();options.onStdout?.(text);stdout=(stdout+text).slice(-cap);});
    child.stderr.on('data',(chunk:Buffer)=>{const text=chunk.toString();options.onStderr?.(text);stderr=(stderr+text).slice(-cap);});
    child.once('error',e=>{if(ended)return;ended=true;cleanup();reject(e);});
    child.once('close',code=>{if(ended)return;ended=true;cleanup();
      if(code===0&&!timedOut&&!options.signal?.aborted)resolve({stdout,stderr});
      else reject(Object.assign(new Error(options.signal?.aborted?'CANCELLED':timedOut?'PROCESS_TIMEOUT':`PROCESS_FAILED:${command}:${code}`),{stdout,stderr}));
    });
  });
}
