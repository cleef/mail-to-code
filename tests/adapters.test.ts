import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm,realpath,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleParser } from 'mailparser';
import { ConfigSchema } from '../src/config.js';
import {pluginFixture} from './plugin-fixture.js';
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
