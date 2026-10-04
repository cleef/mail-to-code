// Genuine choices and missing facts through persistent Codex, with a disabled mailbox.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigSchema} from '../dist/src/config.js';
import {AsyncStore} from '../dist/src/async-store.js';
import {AsyncBridge} from '../dist/src/async-cli.js';
process.umask(0o077);
const root=await realpath(await mkdtemp(join(tmpdir(),'mail-async-questions-'))),dataDir=join(root,'state'),projectsRoot=join(root,'projects'),guides=join(root,'guides');
await Promise.all([mkdir(dataDir),mkdir(projectsRoot),mkdir(guides)]);process.env.MAIL_TO_CODE_CONFIG_DIR=guides;
const config=ConfigSchema.parse({gmailAddress:'agent@example.test',ownerAddress:'owner@example.test',dataDir,projectsRoot,codexCommand:process.env.ASYNC_CODEX_COMMAND||'codex',controllerRepository:'example/controller'}),store=new AsyncStore(join(dataDir,'async-cli.sqlite'));
const disabled=async()=>{throw Error('REAL_MAIL_DISABLED');},mail={profile:disabled,history:disabled,read:disabled,search:disabled,send:disabled},bridge=new AsyncBridge(config,store,mail);
const input=(id,text)=>({id,threadId:'thread-'+id,rfcId:`<${id}@example.test>`,inReplyTo:'',subject:'Synthetic discussion '+id,text,from:config.ownerAddress,trusted:true});
const cases=[{id:'privacy',text:'只有产品讨论，不授权实施。团队希望手稿默认公开便于发现，个人希望默认私有；负责人尚未选择。这是真实的重要隐私取舍。请发一封有推荐方案、理由、替代方案和影响的选择邮件，供负责人决定。记录到 FEATURE.md 后结束。不要调用任何 project_* 或授权工具。'},{id:'fact',text:'只有需求讨论，不授权实施。需要导入仅存在于负责人电脑的手稿样例，当前没有提供文件、目录、链接或内容，也不能访问负责人电脑。请明确发邮件索取缺少的客观材料，不要虚构样例、路径、答案或推荐选项。记录到 FEATURE.md 后结束。不要调用任何 project_* 或授权工具。'}];
async function wait(id){const until=Date.now()+180000;while(store.conversation(id).activeTurn&&Date.now()<until)await new Promise(r=>setTimeout(r,500));assert.equal(store.conversation(id).activeTurn,undefined);assert.ok(!store.conversation(id).error);}
try{
  const tasks=cases.map(c=>({definition:c,conversation:store.intake(input(c.id,c.text),'synthetic MIME',c.text)}));
  await Promise.all(tasks.map(async t=>{await bridge.dispatch(t.conversation);await wait(t.conversation.id);}));
  for(const t of tasks){const mails=store.mails().filter(m=>m.sessionId===t.conversation.id);assert.equal(mails.length,1);const text=mails[0].text;if(t.definition.id==='privacy'){assert.ok(text.includes('推荐')&&text.includes('私有')&&text.includes('公开'));}else{assert.ok(text.includes('样例'));assert.ok(!/推荐.{0,20}(路径|方案)/.test(text));}}
  const privacy=tasks[0].conversation,featurePath=join(dataDir,'async-cli/features',privacy.id,'notes/FEATURE.md'),beforeChoice=await readFile(featurePath,'utf8'),choice='采用推荐方案。这只是产品选择，内部记录即可；不授权实施、合并或部署，不需要再发确认邮件。';
  store.intake({...input('choice',choice),threadId:privacy.gmailThread,inReplyTo:input('privacy','').rfcId},'synthetic MIME',choice);await bridge.dispatch(store.conversation(privacy.id));await wait(privacy.id);
  assert.equal(store.mails().length,2);assert.equal(store.all('scope').length,0);assert.equal(store.all('request').length,0);assert.equal(store.all('operation').length,0);
  const feature=await readFile(featurePath,'utf8');assert.notEqual(feature,beforeChoice);assert.ok(/私有|\bprivate\b/i.test(feature));assert.ok(/确认|采用|采纳|\b(?:confirmed|chosen|adopted|selected)\b/i.test(feature));
  console.log(JSON.stringify({choicesWithRecommendation:true,missingFactWithoutInventedAnswer:true,recommendationReplyRecorded:true,implementationGrants:0,operationGrants:0,realMailSent:0,businessEffects:0}));
}finally{await bridge.stop();store.close();}
