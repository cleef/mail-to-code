import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm,realpath,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleParser } from 'mailparser';
import { ConfigSchema } from '../src/config.js';
import {pluginFixture} from './plugin-fixture.js';
import { GitHubAdapter } from '../src/git.js';
import type { Session } from '../src/types.js';

test('Gmail MIME preserves Chinese, reply headers and CID image; restricts recipients and attachments',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'gmail-wire-'))),previous=process.env.MAIL_TO_CODE_CONFIG_DIR;
  process.env.MAIL_TO_CODE_CONFIG_DIR=dir;
  try {
    const config=ConfigSchema.parse({gmailAddress:'agent@gmail.com',ownerAddress:'owner@qq.com',dataDir:dir,repositories:{sampleapp:{path:'/repo',github:'example-org/sampleapp'}}});
    let payload:any;const {client}=pluginFixture(config,(args,raw)=>{payload={...args,raw};});
    await mkdir(join(dir,'artifacts'),{mode:0o700});const png=join(dir,'artifacts/shot.png');await writeFile(png,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7f8AAAAASUVORK5CYII=','base64'));
    await client.send({replyMessageId:'synthetic-parent',to:'owner@qq.com',subject:'中文 Review',text:'桌面、手机截图验收',messageId:'<review@fixture>',threadId:'thread',inReplyTo:'<plan@fixture>',references:['<plan@fixture>'],attachments:[{path:png,filename:'截图.png',cid:'shot@fixture'}]});
    const mail=await simpleParser(Buffer.from(payload.raw,'base64url'),{skipImageLinks:true});
    assert.equal(mail.subject,'中文 Review');assert.match(mail.text!,/桌面、手机截图验收/);assert.equal(mail.messageId,'<delivered@provider.example.test>');assert.equal(mail.inReplyTo,'<parent@gmail.com>');assert.equal(payload.reply_message_id,'synthetic-parent');
    assert.match(mail.html as string,/cid:shot@fixture/);assert.equal(mail.attachments[0].filename,'截图.png');assert.equal(mail.attachments[0].contentDisposition,'inline');assert.equal(mail.cc,undefined);assert.equal(mail.bcc,undefined);
    await assert.rejects(client.send({replyMessageId:'synthetic-parent',to:'attacker@example.com',subject:'No',text:'No'}),/RECIPIENT/);
    await assert.rejects(client.send({replyMessageId:'synthetic-parent',to:'owner@qq.com',subject:'injection\r\nBcc: attacker@example.com',text:'No'}),/SUBJECT/);
    await writeFile(join(dir,'private.png'),'private');await symlink(join(dir,'private.png'),join(dir,'artifacts/escape.png'));
    await assert.rejects(client.send({replyMessageId:'synthetic-parent',to:'owner@qq.com',subject:'No',text:'No',attachments:[{path:join(dir,'artifacts/escape.png'),filename:'escape.png'}]}),/OUTSIDE/);
  }finally{if(previous===undefined)delete process.env.MAIL_TO_CODE_CONFIG_DIR;else process.env.MAIL_TO_CODE_CONFIG_DIR=previous;await rm(dir,{recursive:true,force:true});}
});

test('GitHub verifies exact repo URL, fences changed heads/base and reconciles already merged PR',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'github-adapter-')),original=globalThis.fetch;await writeFile(join(dir,'token'),'fixture',{mode:0o600});
  const config=ConfigSchema.parse({gmailAddress:'a@gmail.com',ownerAddress:'owner@qq.com',githubTokenFile:join(dir,'token'),repositories:{sampleapp:{path:'/repo',github:'example-org/sampleapp'}}});
  const adapter=new GitHubAdapter(config,'sampleapp'),session={prNumber:1,reviewSha:'review',baseSha:'base'} as Session;
  let response:any={permissions:{push:true},default_branch:'main'},calls:{url:string;init?:RequestInit}[]=[];
  globalThis.fetch=async(input,init)=>{calls.push({url:String(input),init});return new Response(JSON.stringify(response),{status:200});};
  try {
    await adapter.verify();
    response={permissions:{push:true},default_branch:'new-default'};await assert.rejects(adapter.verify(),/default branch changed/);
    response={permissions:{push:true},default_branch:'main'};assert.equal(calls[0].url,'https://api.github.com/repos/example-org/sampleapp');
    response={head:{sha:'changed'},base:{sha:'base'}};await assert.rejects(adapter.merge(session),/head/);
    response={head:{sha:'review'},base:{sha:'new'}};await assert.rejects(adapter.merge(session),/BASE_ADVANCED/);
    response={head:{sha:'review'},base:{sha:'new'},merged:true,merge_commit_sha:'merged'};assert.equal(await adapter.merge(session),'merged');
    assert.equal(calls.filter(c=>c.init?.method==='PUT').length,0);
    globalThis.fetch=async(input,init)=>{calls.push({url:String(input),init});return new Response(JSON.stringify(init?.method==='PUT'?{merged:true,sha:'approved-merge'}:{head:{sha:'review'},base:{sha:'base'}}));};
    assert.equal(await adapter.merge(session),'approved-merge');assert.equal(JSON.parse(calls.at(-1)!.init!.body as string).sha,'review');
  }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});
