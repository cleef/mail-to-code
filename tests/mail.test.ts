import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanReply, parseIncoming, authenticated } from '../src/mail.js';
import { developmentEnvironment, shellEnvironment } from '../src/runner.js';
import { ConfigSchema } from '../src/config.js';

const owner='owner@qq.com';
function mime(body:string,extra=''){return Buffer.from(`From: 人 <${owner}>\r\nTo: agent@gmail.com\r\nSubject: Re: [DEV-20260930-001] 标题\r\nMessage-ID: <reply@qq.com>\r\nIn-Reply-To: <review@mail-to-code.local>\r\nAuthentication-Results: mx.google.com; dkim=pass header.i=@qq.com; spf=pass; dmarc=pass header.from=qq.com\r\n${extra}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`).toString('base64url');}
test('Chinese QQ reply strips quotation and command-looking old content',async()=>{
  const mail=await parseIncoming('1','thread',mime('缩小一点\r\n------------------ 原始邮件 ------------------\r\nAPPROVE'),owner);
  assert.equal(mail.trusted,true);assert.equal(mail.text,'缩小一点');assert.equal(mail.inReplyTo,'<review@mail-to-code.local>');
});
test('Gmail quotation and mobile signatures never activate quoted commands',()=>{
  assert.equal(cleanReply('意见\nOn Wed, someone wrote:\nSTART'),'意见');assert.equal(cleanReply('APPROVE\n发自我的手机'),'APPROVE');
});
test('sender spoofing, duplicates and automatic replies rejected',async()=>{
  assert.equal((await parseIncoming('1','t',mime('START','Auto-Submitted: auto-replied\r\n'),owner)).trusted,false);
  assert.equal((await parseIncoming('1','t',mime('START').replace('noop',''), 'other@qq.com')).trusted,false);
  assert.equal(authenticated([{key:'authentication-results',line:'Authentication-Results: attacker; dmarc=pass header.from=qq.com'}],owner),false);
  const record={key:'authentication-results',line:'Authentication-Results: mx.google.com; dkim=pass; dmarc=pass header.from=qq.com'};
  assert.equal(authenticated([record,record],owner),false);assert.equal(authenticated([{...record,line:record.line.replace('qq.com','evilqq.com')}],owner),false);
});
test('mail and development credentials use separate environments',()=>{
  const source={PATH:'/synthetic/bin',HOME:'/synthetic/home',GH_TOKEN:'synthetic',SSH_AUTH_SOCK:'/synthetic/ssh',MAIL_TO_CODE_SECRET:'synthetic',NODE_OPTIONS:'--require=unsafe'};
  assert.equal(shellEnvironment(source).GH_TOKEN,undefined);
  assert.equal(developmentEnvironment(undefined,source).GH_TOKEN,'synthetic');
  assert.equal(developmentEnvironment(undefined,source).SSH_AUTH_SOCK,'/synthetic/ssh');
  assert.equal(developmentEnvironment(undefined,source).MAIL_TO_CODE_SECRET,undefined);
  assert.equal(developmentEnvironment(undefined,source).NODE_OPTIONS,undefined);
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
