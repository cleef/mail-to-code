import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { GmailClient, SCOPES, atomicSecret } from './gmail.js';
import type { Config } from './config.js';
import { configDir } from './config.js';

export async function authorize(config:Config) {
  const gmail=await GmailClient.create(config),state=randomBytes(32).toString('hex'),verifier=randomBytes(64).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const server=createServer();
  await new Promise<void>((res,rej)=>{server.once('error',rej);server.listen(config.oauthPort,'127.0.0.1',res);});
  console.log(`SSH forwarding: ssh -N -L ${config.oauthPort}:127.0.0.1:${config.oauthPort} user@your-server`);
  console.log(gmail.auth.generateAuthUrl({access_type:'offline',prompt:'consent',scope:SCOPES,state,code_challenge:challenge,code_challenge_method:'S256' as never,login_hint:config.gmailAddress}));
  try {
    const code=await new Promise<string>((res,rej)=>{
      const timer=setTimeout(()=>rej(new Error('OAuth authorization timed out')),1800000);
      server.on('request',(req,reply)=>{
        const url=new URL(req.url||'/','http://127.0.0.1');
        if(url.pathname!='/callback'||url.searchParams.get('state')!==state){reply.writeHead(400);reply.end('Invalid callback');return;}
        if(url.searchParams.has('error')){reply.end('Authorization was declined');clearTimeout(timer);rej(new Error('OAuth authorization declined'));return;}
        const code=url.searchParams.get('code');if(!code){reply.writeHead(400);reply.end('Missing code');return;}
        reply.end('Authorization received. Return to mail-to-code.');clearTimeout(timer);res(code);
      });
    });
    const response=await gmail.auth.getToken({code,codeVerifier:verifier});
    if(!response.tokens.refresh_token)throw new Error('No refresh token returned; revoke old consent and authorize again');
    gmail.auth.setCredentials(response.tokens);await gmail.verify();await atomicSecret(join(configDir(),'token.json'),JSON.stringify(response.tokens));
    console.log('Gmail account, scopes and refresh token verified.');
  }finally{server.close();}
}
