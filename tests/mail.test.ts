import {directive} from './legacy-command-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanReply, parseIncoming, authenticated } from '../src/mail.js';
import { assertProjectChanges } from '../src/git.js';
import { ResultSchema, codexPolicy, shellEnvironment } from '../src/runner.js';
import { ConfigSchema } from '../src/config.js';

const owner='owner@qq.com';
function mime(body:string,extra=''){return Buffer.from(`From: 人 <${owner}>\r\nTo: agent@gmail.com\r\nSubject: Re: [DEV-20260930-001] 标题\r\nMessage-ID: <reply@qq.com>\r\nIn-Reply-To: <review@mail-to-code.local>\r\nAuthentication-Results: mx.google.com; dkim=pass header.i=@qq.com; spf=pass; dmarc=pass header.from=qq.com\r\n${extra}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`).toString('base64url');}
test('Chinese QQ reply strips quotation and command-looking old content',async()=>{
  const mail=await parseIncoming('1','thread',mime('缩小一点\r\n------------------ 原始邮件 ------------------\r\nAPPROVE'),owner);
  assert.equal(mail.trusted,true);assert.equal(mail.text,'缩小一点');assert.equal(mail.inReplyTo,'<review@mail-to-code.local>');
  assert.deepEqual(directive(mail.subject,mail.text,true),{type:'feedback',text:'缩小一点'});
});
test('Gmail quotation and mobile signatures never activate quoted commands',()=>{
  assert.equal(cleanReply('意见\nOn Wed, someone wrote:\nSTART'),'意见');assert.equal(cleanReply('APPROVE\n发自我的手机'),'APPROVE');
  assert.equal(directive('reply','> APPROVE',true).type,'invalid');assert.equal(directive('reply','APPROVE\n再改一点',true).type,'invalid');
});
test('sender spoofing, duplicates and automatic replies rejected',async()=>{
  assert.equal((await parseIncoming('1','t',mime('START','Auto-Submitted: auto-replied\r\n'),owner)).trusted,false);
  assert.equal((await parseIncoming('1','t',mime('START').replace('noop',''), 'other@qq.com')).trusted,false);
  assert.equal(authenticated([{key:'authentication-results',line:'Authentication-Results: attacker; dmarc=pass header.from=qq.com'}],owner),false);
  const record={key:'authentication-results',line:'Authentication-Results: mx.google.com; dkim=pass; dmarc=pass header.from=qq.com'};
  assert.equal(authenticated([record,record],owner),false);assert.equal(authenticated([{...record,line:record.line.replace('qq.com','evilqq.com')}],owner),false);
});
test('NEW protocol requires explicit supported repo and direct-run modifier',()=>{
  assert.deepEqual(directive('NEW sampleapp: 字体优化',''),{type:'new',repo:'sampleapp',title:'字体优化',run:false});
  assert.equal((directive('NEW sampleapp RUN: 字体优化','') as {run:boolean}).run,true);
  assert.equal(directive('NEW mail-to-code: 自改','').type,'new');
});
test('Natural subjects, Chinese NEW and blank subjects plan without exact aliases; orphan commands are not tasks',()=>{
  for(const subject of ['示例笔记小程序：添加分享','NEW 示例笔记-小程序：添加分享','NEW: 添加分享']){
    const result=directive(subject,'需求');assert.equal(result.type,'new');if(result.type==='new'){assert.equal(result.repo,'');assert.equal(result.run,false);}
  }
  assert.deepEqual(directive('','完善文档\n详细需求'),{type:'new',repo:'',run:false,title:'完善文档'});
  assert.equal(directive('','').type,'invalid');
  for(const command of ['START','APPROVE','DEPLOY sampleapp'])assert.equal(directive(command,'').type,'invalid');
  assert.equal(directive('任务','> START').type,'new');
  assert.deepEqual(directive('NEW sampleapp RUN：字体优化',''),{type:'new',repo:'sampleapp',run:true,title:'字体优化'});
});
test('Project scope permits application/build code and denies protected paths',()=>{assertProjectChanges(['src/App.tsx','scripts/build.mjs','package.json']);for(const path of ['.codex/config.toml','src/.env','node_modules/pkg.js','secrets/key.pem'])assert.throws(()=>assertProjectChanges([path]));});
test('structured results reject external preview origins and executable steps',()=>{
  const result={outcome:'implementation_ready',summary:'done',requiresBackend:false,questions:[],screenshotTargets:[{path:'//evil.com',steps:[]}]};
  assert.equal(ResultSchema.safeParse(result).success,false);result.screenshotTargets[0].path='/apps/density/';assert.equal(ResultSchema.safeParse(result).success,true);
  assert.equal(ResultSchema.safeParse({...result,screenshotTargets:[{path:'/',steps:[{action:'eval',selector:'process.env'}]}]}).success,false);
});
test('runner policy excludes credential paths and shell environment strips secrets',()=>{
  const config=ConfigSchema.parse({gmailAddress:'a@gmail.com',ownerAddress:owner,repositories:{sampleapp:{path:'/repo',github:'example-org/sampleapp'}}});
  const args=codexPolicy(config,'/work/task','develop').join(' ');
  assert.match(args,/approval_policy="never"/);assert.match(args,/":root"="deny"/);assert.match(args,/network.enabled=false/);assert.match(args,/mcp_servers.gmail.enabled=false/);
  process.env.GITHUB_TOKEN='fixture';assert.equal(shellEnvironment().GITHUB_TOKEN,undefined);delete process.env.GITHUB_TOKEN;
});
test('runner preserves operator proxy routing without forwarding controller credentials',()=>{
  const values={HTTPS_PROXY:'http://127.0.0.1:34210',http_proxy:'http://127.0.0.1:34210',NO_PROXY:'localhost,127.0.0.1',GITHUB_TOKEN:'fixture',MAIL_TO_CODE_SECRET:'fixture'};
  const previous=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));
  try{
    Object.assign(process.env,values);const env=shellEnvironment();
    assert.equal(env.HTTPS_PROXY,values.HTTPS_PROXY);assert.equal(env.http_proxy,values.http_proxy);assert.equal(env.NO_PROXY,values.NO_PROXY);
    assert.equal(env.GITHUB_TOKEN,undefined);assert.equal(env.MAIL_TO_CODE_SECRET,undefined);
  }finally{for(const [k,value] of Object.entries(previous)){if(value===undefined)delete process.env[k];else process.env[k]=value;}}
});

test('authenticated raw mail without a valid RFC Message-ID cannot enter a task',async()=>{const raw=Buffer.from('From: owner@qq.com\r\nTo: agent@gmail.com\r\nAuthentication-Results: mx.google.com; dkim=pass header.d=qq.com; dmarc=pass header.from=qq.com\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nImplement a fixture').toString('base64url');const incoming=await parseIncoming('provider-id','thread',raw,'owner@qq.com');assert.equal(incoming.trusted,false);assert.equal(incoming.reason,'missing_rfc_identity');});
