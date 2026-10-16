import test from 'node:test';import assert from 'node:assert/strict';
import {CodexGmailTransport} from '../src/gmail.js';import {ConfigSchema} from '../src/config.js';
import {GmailError} from '../src/mail-transport.js';
import {mailDiagnostic,privateMailError} from '../src/mail-diagnostics.js';
function fixture(response:(action:string,args:any)=>any,raw=false){const calls:any[]=[];const rpc={close:async()=>{},request:async(method:string,p:any)=>{calls.push({method,...p});const result=await response(p.tool,p.arguments);return raw?result:{structuredContent:result};}};const config=ConfigSchema.parse({gmailAddress:'agent@gmail.com',ownerAddress:'owner@example.test',dataDir:'/tmp/synthetic-mail'});const actions=['get_profile','search_email_ids','read_email','send_email'];const client=new(CodexGmailTransport as any)(config,rpc,'ephemeral-mail',Object.fromEntries(actions.map(a=>[a,{server:'codex_apps',tool:'gmail.'+a}]))) as CodexGmailTransport;return{client,calls};}
test('plugin pagination deduplicates IDs, requires complete pages, and normalizes raw MIME identity',async()=>{const f=fixture((action,args)=>action==='gmail.search_email_ids'?args.next_page_token?{message_ids:['one','two'],next_page_token:null}:{message_ids:['one'],next_page_token:'next'}:{id:args.message_id,thread_id:'thread',label_ids:['INBOX'],internal_date:123,raw:Buffer.from('From: owner@example.test\r\n\r\nbody').toString('base64url')});assert.deepEqual(await f.client.search('from:owner@example.test'),[{id:'one'},{id:'two'}]);const raw=await f.client.read('one');assert.equal(raw.threadId,'thread');assert.equal(raw.internalDate,'123');assert.ok(raw.raw);assert.equal(f.calls.some(c=>c.method==='turn/start'),false);const loop=fixture(()=>({message_ids:[],next_page_token:'loop'}));await assert.rejects(loop.client.search('query'),/PAGINATION_LOOP/);const broken=fixture(()=>({id:'one',thread_id:'thread',label_ids:[]}));await assert.rejects(broken.client.read('one'),/RAW_MESSAGE_REQUIRED/);});
test('an ambiguous plugin send is attempted once without model fallback or resend',async()=>{let sent=0;const f=fixture(()=>{sent++;throw Error('timeout');});await assert.rejects(f.client.send({to:'owner@example.test',subject:'Fixture',text:'Frozen',replyMessageId:'parent'}),/UNCERTAIN_NO_AUTOMATIC_RETRY/);assert.equal(sent,1);assert.deepEqual(f.calls.map(c=>c.tool),['gmail.send_email']);const args=f.calls[0].arguments;assert.equal(args.reply_message_id,'parent');assert.equal(args.cc,undefined);assert.equal(args.bcc,undefined);await assert.rejects(f.client.send({to:'owner@example.test',subject:'Fixture',text:'No parent'}),/FROZEN_REPLY_PARENT_REQUIRED/);assert.equal(sent,1);});

test('changed attachment bytes are rejected before calling the send tool',async()=>{
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'frozen-plugin-attachment-'));await mkdir(join(root,'artifacts'));const path=join(root,'artifacts/proof.txt');await writeFile(path,'frozen bytes');
 const f=fixture((_action,args)=>({id:args.message_id,thread_id:'thread',label_ids:['INBOX'],raw:Buffer.from('From: owner@example.test\r\nMessage-ID: <parent@example.test>\r\nContent-Type: text/plain\r\n\r\nOriginal request').toString('base64url')}));f.client.config.dataDir=root;
 try{const attachments=[{path,filename:'proof.txt'}],frozen=await f.client.prepareReply('parent',attachments);await writeFile(path,'changed bytes');await assert.rejects(f.client.send({to:'owner@example.test',subject:'Fixture',text:'Frozen',replyMessageId:'parent',attachments,attachmentHashes:frozen.attachmentHashes}),/ATTACHMENT_SNAPSHOT_CHANGED/);assert.equal(f.calls.filter(c=>c.tool==='gmail.send_email').length,0);}finally{await rm(root,{recursive:true,force:true});}
});

test('send errors retain provider evidence privately and expose bounded phase/reason codes',async()=>{
 const input={to:'owner@example.test',subject:'Fixture',text:'Frozen',replyMessageId:'parent'};
 const cases=[
  {result:{isError:true,content:[{type:'text',text:'Synthetic provider failure; Bearer synthetic-secret'}]},code:'MAIL_PLUGIN_TOOL_FAILED',reason:'tool_error'},
  {result:{content:[{type:'text',text:'not JSON'}]},code:'MAIL_PLUGIN_RESPONSE_INVALID',reason:'invalid_response'},
  {result:{structuredContent:{id:'sent-without-thread'}},code:'MAIL_PLUGIN_MESSAGE_IDENTITY_MISSING',reason:'missing_identity'},
 ];
 for(const row of cases){const f=fixture(()=>row.result,true);await assert.rejects(f.client.send(input),(e:any)=>{
  assert.ok(e instanceof GmailError);assert.equal(e.message,row.code);assert.deepEqual(e.failure,{action:'send_email',reason:row.reason});assert.deepEqual(e.cause,row.result.structuredContent??row.result);
  const diagnostic=mailDiagnostic({id:'synthetic',attempts:1} as any,'send',e);
  assert.equal(JSON.stringify(diagnostic).includes('synthetic-secret'),false);
  if(row.reason==='tool_error')assert.match(JSON.stringify(privateMailError(e)),/synthetic-secret/);
  return true;
 });assert.equal(f.calls.length,1);}
 for(const [message,reason] of [['APP_SERVER_ACK_UNCERTAIN:mcpServer/tool/call','timeout'],['APP_SERVER_DISCONNECTED','disconnected'],['Synthetic RPC failure','rpc_error']]){
  const source=Object.assign(new Error(message,{cause:{reason:'Synthetic remote error'}}),{rpcCode:-32000}),f=fixture(()=>{throw source;});
  await assert.rejects(f.client.send(input),(e:any)=>{assert.deepEqual(e.failure,{action:'send_email',reason,rpcCode:-32000});assert.equal(e.cause,source);return true;});assert.equal(f.calls.length,1);
 }
});

test('private error serialization is bounded and cycle-safe',()=>{
 const cyclic:any={text:'x'.repeat(50000)};cyclic.self=cyclic;
 const saved=JSON.stringify(privateMailError(new Error('fixture',{cause:cyclic})));
 assert.ok(saved.length<20000);assert.match(saved,/circular/);
 assert.equal(mailDiagnostic({id:'synthetic',attempts:1} as any,'send',new Error('MAIL_BAD Bearer synthetic-secret')).code,'MAIL_SEND_FAILED');
});
