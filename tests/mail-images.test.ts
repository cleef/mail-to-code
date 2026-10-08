import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { prepareMailBody, mailImageDirectory, MAIL_IMAGE_LIMIT } from '../src/mail-images.js';
import { AsyncStore } from '../src/async-store.js';
import { AsyncTools } from '../src/async-tools.js';
import { FinalMail } from '../src/final-mail.js';
import { ConfigSchema } from '../src/config.js';
import { CodexGmailTransport } from '../src/gmail.js';
import { Delivery } from '../src/delivery.js';
import { AsyncBridge } from '../src/async-cli.js';

function pngBytes(width:number,height:number,data:Buffer){const image=new PNG({width,height});image.data=data;return PNG.sync.write(image);}
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function fixture(final=false) {
    const root=mkdtempSync(join(tmpdir(),'mail-images-')),store=new AsyncStore(join(root,'async-cli.sqlite'));
    const config=ConfigSchema.parse({gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',projectsRoot:join(root,'projects'),dataDir:root,engine:'async-cli',asyncMailOutput:final?'assistant-final':'queue-mail'});
    const c=store.intake({id:'parent',threadId:'provider-thread',rfcId:'<parent@example.test>',inReplyTo:'',references:[],subject:'Visible image fixture',text:'Please send a visible image.',from:'owner@example.test',trusted:true},'','');
    c.codexThread='native-thread';store.save(c);const images=mailImageDirectory(root,c.id);mkdirSync(images,{recursive:true});
    const png=pngBytes(640,360,Buffer.alloc(640*360*4,190)),jpg=jpeg.encode({width:16,height:16,data:Buffer.alloc(16*16*4,150)},80).data;
    writeFileSync(join(images,'预览.png'),png);writeFileSync(join(images,'photo.jpg'),jpg);
    return{root,store,config,c,images,png,jpg,close:()=>{store.close();rmSync(root,{recursive:true,force:true});}};
}
test('imports visible PNG/JPEG, escapes captions, strips private paths and deduplicates repeated references',()=>{
    const f=fixture();try{
        const text=`Visible result\n![<Preview>](<${join(f.images,'预览.png')}>)\n![Photo](mail-images/photo.jpg)\n![Again](<${join(f.images,'预览.png')}>)`;
        const result=prepareMailBody(f.root,f.c.id,text);
        assert.equal(result.attachments.length,2);assert.deepEqual(result.attachmentHashes,[digest(f.png),digest(f.jpg)]);
        assert.match(result.bodySnapshot.html,/<img src="cid:/);assert.match(result.bodySnapshot.html,/&lt;Preview&gt;/);
        assert.equal(result.bodySnapshot.html.includes(f.root),false);assert.equal(result.bodySnapshot.text.includes(f.root),false);
        assert.match(result.bodySnapshot.text,/预览.png/);assert.equal((result.bodySnapshot.html.match(/<img/g)||[]).length,3);
        assert.equal(statSync(result.attachments[0].path).mode&0o777,0o400);
        writeFileSync(join(f.images,'预览.png'),pngBytes(1,1,Buffer.alloc(4)));
        assert.deepEqual(readFileSync(result.attachments[0].path),f.png);
    }finally{f.close();}
});
test('rejects unavailable, invalid, external and escaping images without queuing a fake reply',()=>{
    const f=fixture();try{
        writeFileSync(join(f.images,'wrong.png'),f.jpg);writeFileSync(join(f.images,'fake.png'),Buffer.from('not PNG'));
        writeFileSync(join(f.images,'broken.png'),f.png.subarray(0,40));
        writeFileSync(join(f.images,'wide.png'),pngBytes(32768,1,Buffer.alloc(32768*4)));
        const outside=join(f.root,'private.png');writeFileSync(outside,f.png);symlinkSync(outside,join(f.images,'link.png'));
        symlinkSync(f.root,join(f.images,'nested'));
        linkSync(outside,join(f.images,'hard.png'));mkdirSync(join(f.images,'directory.png'));
        for(const source of ['mail-images/missing.png','mail-images/wrong.png','mail-images/fake.png','mail-images/broken.png','mail-images/wide.png','mail-images/directory.png','https://example.test/image.png','data:image/png;base64,aaa',outside,'mail-images/../private.png','mail-images/%2e%2e/private.png','mail-images/link.png','mail-images/hard.png','mail-images/nested/private.png']) {
            assert.throws(()=>f.store.queue(f.c,'invalid:'+source,`![Preview](${source})`),/MAIL_IMAGE_/);
        }
        assert.equal(f.store.mails().length,0);
        assert.throws(()=>prepareMailBody(f.root,f.c.id,'![Bad](mail-images/a b.png)'),/MAIL_IMAGE_REFERENCE_INVALID/);
        const example='Example: `![Preview](mail-images/missing.png)`\n```md\n![Example](https://example.test/image.png)\n```';
        assert.equal(prepareMailBody(f.root,f.c.id,example).attachments.length,0);
    }finally{f.close();}
});
test('enforces per-file and aggregate byte limits before any outbox write',()=>{
    const f=fixture();try{
        writeFileSync(join(f.images,'large.png'),Buffer.alloc(MAIL_IMAGE_LIMIT+1));
        assert.throws(()=>f.store.queue(f.c,'large','![Large](mail-images/large.png)'),/EXCEED_10_MIB/);
        const noise=pngBytes(1400,1200,randomBytes(1400*1200*4));
        writeFileSync(join(f.images,'one.png'),noise);writeFileSync(join(f.images,'two.png'),noise);
        assert.throws(()=>f.store.queue(f.c,'aggregate','![One](mail-images/one.png)\n![Two](mail-images/two.png)'),/EXCEED_10_MIB/);
        assert.equal(f.store.mails().length,0);
    }finally{f.close();}
});
test('old queue_mail tool imports images without new tools or project/controller scope',async()=>{
    const f=fixture();try{
        const tools=new AsyncTools(f.config,f.store,f.c,new AbortController().signal);
        await assert.rejects(tools.call('native-thread','queue_mail',{key:'image',text:'![Missing](mail-images/missing.png)'}),/MAIL_IMAGE_FILE_UNAVAILABLE/);
        assert.equal(f.store.get<any>('mail-held',f.c.id+':image').reason,'MAIL_IMAGE_FILE_UNAVAILABLE');
        await tools.call('native-thread','queue_mail',{key:'image',text:'Done.\n![Preview](<mail-images/预览.png>)'});
        assert.equal(f.store.get<any>('mail-held',f.c.id+':image').status,'resolved');
        const m=f.store.mails()[0];assert.equal(m.attachments.length,1);assert.equal(m.bodySnapshot?.images.length,1);
        assert.equal(f.store.all('scope').length,0);assert.equal(f.store.all('operation').length,0);
        assert.throws(()=>f.store.saveMail({...m,text:'Changed'}),/IMMUTABLE/);
        assert.throws(()=>f.store.saveMail({...m,bodySnapshot:{...m.bodySnapshot!,html:'Changed'}}),/IMMUTABLE/);
        assert.throws(()=>f.store.saveMail({...m,attachmentHashes:['changed']}),/IMMUTABLE/);
        assert.throws(()=>f.store.saveMail({...m,replySourceId:'changed'}),/IMMUTABLE/);
        writeFileSync(join(f.images,'预览.png'),Buffer.from('changed'));
        await tools.call('native-thread','queue_mail',{key:'image',text:'Done.\n![Preview](<mail-images/预览.png>)'});
        assert.equal(f.store.mails().length,1);assert.deepEqual(readFileSync(m.attachments[0].path),f.png);
    }finally{f.close();}
});
test('image confirmation and reply parent freeze before later inputs; altered frozen files never attempt sending',async()=>{
    const f=fixture();let bridge:AsyncBridge|undefined;try{
        const {mail:m,request:r}=f.store.queue(f.c,'approval','![Preview](<mail-images/预览.png>)',{kind:'scope',target:{projects:['sample']}});
        assert.throws(()=>f.store.put('request',r!.id,{...r,target:{projects:['other']}}),/IMMUTABLE/);
        f.store.intake({id:'later',threadId:'provider-thread',rfcId:'<later@example.test>',inReplyTo:'<parent@example.test>',subject:f.c.subject,text:'Later input',from:f.config.ownerAddress,trusted:true},'','');
        assert.equal(f.store.mail(m.id)?.replySourceId,'parent');
        assert.throws(()=>f.store.authorize(f.c.id,r!.id,'later','Later input'),/APPROVAL_REPLY_BINDING_REQUIRED/);
        let sends=0;
        const transport={send:async()=>{sends++;throw Error('SEND_DISABLED');},search:async()=>[],read:async()=>{throw Error('READ_DISABLED');},profile:async()=>({emailAddress:f.config.gmailAddress})};
        bridge=new AsyncBridge(f.config,f.store,transport,async()=>{throw Error('MODEL_DISABLED');});
        chmodSync(m.attachments[0].path,0o600);writeFileSync(m.attachments[0].path,Buffer.from('changed'));
        await bridge.flush();await bridge.flush();
        assert.equal(sends,0);assert.equal(f.store.mail(m.id)?.attempts,0);assert.equal(f.store.mail(m.id)?.status,'pending');
        assert.equal(f.store.mail(m.id)?.lastError,'MAIL_IMAGE_FROZEN_COPY_INVALID');
    }finally{await bridge?.stop();f.close();}
});
test('final replies queue images once without queue_mail, preserve raw answer, hold invalid images and skip historical turns',()=>{
    const f=fixture(true);try{
        const input=f.store.input('parent')!,final=new FinalMail(f.store);input.turnId='new-turn';final.begin(input);final.accepted(f.c,input);
        const text='Result\n![Preview](<mail-images/预览.png>)',turn={id:'new-turn',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text}]};
        final.complete(f.c,{...turn,id:'historical'});assert.equal(f.store.mails().length,0);
        final.item(f.c,'new-turn',{id:'progress',type:'agentMessage',phase:'commentary',text:'Progress'});final.complete(f.c,turn);final.complete(f.c,turn);
        assert.equal(f.store.mails().length,1);assert.equal(f.store.mails()[0].text,text);
        const reopened=new AsyncStore(join(f.root,'async-cli.sqlite'));new FinalMail(reopened).complete(f.c,turn);assert.equal(reopened.mails().length,1);reopened.close();
        input.turnId='invalid-turn';final.accepted(f.c,input);final.complete(f.c,{id:'invalid-turn',status:'completed',items:[{id:'bad',type:'agentMessage',phase:'final_answer',text:'![Missing](mail-images/missing.png)'}]});
        assert.equal(f.store.mails().length,1);assert.equal(f.store.conversation(f.c.id)?.error,'MAIL_IMAGE_FILE_UNAVAILABLE');
        assert.equal(f.store.get<any>('final-held',f.c.id+':invalid-turn').reason,'MAIL_IMAGE_FILE_UNAVAILABLE');
        writeFileSync(join(f.images,'missing.png'),f.png);final.complete(f.c,{id:'invalid-turn',status:'completed',items:[{id:'bad',type:'agentMessage',phase:'final_answer',text:'![Missing](mail-images/missing.png)'}]});
        assert.equal(f.store.mails().length,1,'held finals require a new owner input, not event replay');
    }finally{f.close();}
});
test('plugin payload and delivered raw MIME include visible CID HTML, original bytes and verified identities',async()=>{
    const f=fixture();try{
        const m=f.store.queue(f.c,'image','Done.\n![Preview](<mail-images/预览.png>)\n![Photo](mail-images/photo.jpg)').mail;
        let payload:any,calls=0,raw:Buffer=Buffer.alloc(0);
        const rpc={close:async()=>{},request:async(_method:string,p:any)=>{
            if(p.tool==='gmail.send_email'){calls++;payload=p.arguments.payload;return{structuredContent:{id:'sent',thread_id:'provider-thread'}};}
            return{structuredContent:{id:'sent',thread_id:'provider-thread',label_ids:['SENT'],raw:raw.toString('base64url')}};
        }};
        const mail=new(CodexGmailTransport as any)(f.config,rpc,'mail-only',{send_email:{server:'codex_apps',tool:'gmail.send_email'},read_email:{server:'codex_apps',tool:'gmail.read_email'}}) as CodexGmailTransport;
        m.replyMessageId='parent';m.replyParentRfcId='<parent@example.test>';m.threadId='provider-thread';f.store.saveMail(m);
        const send={to:f.config.ownerAddress,subject:f.c.subject,text:m.text,markdown:true,bodySnapshot:m.bodySnapshot,attachments:m.attachments,attachmentHashes:m.attachmentHashes,deliveryMarker:m.deliveryMarker,replyMessageId:'parent'};
        await mail.send(send);assert.equal(calls,1);assert.equal(payload.mime_type,'multipart/related');assert.equal(payload.parts[0].mime_type,'multipart/alternative');
        const parts=payload.parts[0].parts,text=parts[0].body.content,html=parts[1].body.content;
        assert.equal(html.includes('mail-images/'),false);assert.match(html,/<img src="cid:/);assert.match(text,/预览.png/);
        const compose=async(body=html,mimeOverride?:string)=>{
            const result=await nodemailer.createTransport({streamTransport:true,buffer:true}).sendMail({from:f.config.gmailAddress,to:f.config.ownerAddress,subject:f.c.subject,messageId:'<sent@example.test>',inReplyTo:m.replyParentRfcId,text,html:body,attachments:payload.parts.slice(1).map((p:any)=>({filename:p.filename,cid:p.content_id,contentType:mimeOverride||p.mime_type,content:Buffer.from(p.body.base64_url_content,'base64url')}))});
            raw=result.message as Buffer;
        };
        await compose();const parsed=await simpleParser(raw,{keepCidLinks:true});assert.equal(parsed.attachments.length,2);assert.deepEqual(parsed.attachments[0].content,f.png);
        const delivery=new Delivery(f.config,{} as any,mail),s={subject:f.c.subject} as any;
        assert.equal((await delivery.inspect(m,s,'sent')).rfcMessageId,'<sent@example.test>');
        await compose('Images omitted');await assert.rejects(delivery.inspect(m,s,'sent'),/IMAGE_HTML_MISMATCH/);
        await compose(html,'application/octet-stream');await assert.rejects(delivery.inspect(m,s,'sent'),/IMAGE_MIME_MISMATCH/);
        chmodSync(m.attachments[0].path,0o600);writeFileSync(m.attachments[0].path,Buffer.from('changed'));
        await assert.rejects(mail.send(send),/ATTACHMENT_SNAPSHOT_CHANGED/);assert.equal(calls,1);
    }finally{f.close();}
});
