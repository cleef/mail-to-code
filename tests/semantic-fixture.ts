import {asQuestion} from '../src/questions.js';
// Synthetic model decisions for adapter tests. Production never uses this helper.
import type {ReplyContext,ReplyDecision,ReplyIntent,SemanticDecision,Session} from '../src/types.js';
import {currentBinding} from '../src/approval.js';
export function wire(d:ReplyDecision,phase:'plan'|'develop'='develop',communication?:SemanticDecision['communication']):SemanticDecision{
 const feedback=d.items.some(i=>i.clear&&i.action==='feedback');
 return {version:2,nextStep:feedback?'revise':'wait',revisionPhase:feedback?phase:null,communication:communication||{kind:d.questions.length?'ask_human':d.items.some(i=>i.clear&&i.action==='status')?'requested_status':d.items.some(i=>i.clear&&i.action==='cancel')?'final_result':'internal',text:d.questions.map(q=>q.text).join('\n')||'当前状态与处理结果'},...d,items:d.items.map(i=>({...i,project:i.project??null} as unknown as typeof i)),questions:d.questions.map(q=>({...q,action:q.action??null} as unknown as typeof q))};
}
const commands:Record<string,ReplyIntent['action']>={START:'start',APPROVE:'approve',DEPLOY:'deploy',STATUS:'status',CANCEL:'cancel',RETRY:'retry'};
export function synthetic(s:Session,c:ReplyContext,d?:ReplyIntent|ReplyDecision):SemanticDecision{
 if(c.mode==='outcome'){
  const candidate=c.candidate,action=candidate?.action||currentBinding(s)?.action;
  if(candidate?.kind==='next-stage'||candidate?.kind==='merge'&&s.workflow?.proposal?.kind==='documentation')return {...wire({items:[],questions:[]}),nextStep:'analyze'};
  if(action&&(candidate?.action||candidate?.kind==='reply-reconciliation'&&!candidate.questions?.length))return wire({items:[],questions:[{text:action==='START'?'确认按当前具体方案实施':action==='APPROVE'?'确认合并当前完整 Review':'确认发布已合并目标',kind:'confirm',action,dependsOn:[]}]},'plan',{kind:'confirmation',text:[candidate?.text,...(c.facts||[]).map(f=>f.text)].filter(Boolean).join('\n')||'确认当前版本'});
  const questions=candidate?.questions||c.facts?.map(f=>f.text)||[];
  if(['input','reply-reconciliation'].includes(candidate?.kind||'')||c.facts?.some(f=>f.code==='guard_rejected'))return wire({items:[],questions:questions.map(asQuestion)},'plan',{kind:questions.length?'ask_human':'internal',text:candidate?.text||questions.map(q=>asQuestion(q).text).join('\n')});
  return wire({items:[],questions:[]},'plan',{kind:candidate?.kind==='projects'?'requested_status':'final_result',text:candidate?.text||s.summary});
 }
 if(c.mode==='intake'){
  if(c.incoming.subject==='PROJECTS')return wire({items:[{id:'catalog',action:'catalog',clear:true,evidence:'PROJECTS',text:'查询项目目录',questionRefs:[],dependsOn:[]}],questions:[]});
  // Static synthetic inputs in these fixtures identify their fake repository explicitly.
  s.projectHints=(/^PROJECTS:\s*(.+)$/mi.exec(c.incoming.text)?.[1]||/^NEW\s+(\w+)/.exec(c.incoming.subject)?.[1]||'').split(/[,，\s]+/).filter(Boolean);
  return {...wire({items:[],questions:[]}),nextStep:'analyze'};
 }
 if(d&&'version' in d)return d as SemanticDecision;
 if(d&&'items' in d){const result=wire(d,['PLANNING','WAITING_START'].includes(s.state)||s.blockedPhase==='plan'?'plan':'develop');if(d.items.some(i=>i.action==='status'))result.communication.text='当前状态：'+s.state+'\n'+result.communication.text;return result;}
 const [token,project]=c.incoming.text.trim().split(/\s+/);const command=c.incoming.text.trim().toUpperCase();const action=commands[command]||(/^DEPLOY \w+$/.test(command)?'deploy':undefined)||d?.action||'feedback';
 const clear=d?.clear??true,questions=(!clear||action==='clarify')&&d?.question?[{text:d.question,kind:'open' as const,dependsOn:[]}]:[];
 const result=wire({items:action==='clarify'?[]:[{id:'mock',action,clear,evidence:c.incoming.text,text:d?.feedback||c.incoming.text,project:action==='deploy'?project||d?.project:d?.project,questionRefs:[],dependsOn:[]}],questions},['PLANNING','WAITING_START'].includes(s.state)||s.blockedPhase==='plan'?'plan':'develop');if(action==='status')result.communication.text='当前状态：'+s.state;return result;
}
export function installSemanticFixture(work:any,store:any){
 let model=work.interpretReply;
 Object.defineProperty(work,'interpretReply',{configurable:true,get:()=>async(s:Session,c:ReplyContext,signal:AbortSignal)=>{
  const raw=c.mode?undefined:await model(s,c,signal);const result=synthetic(s,c,raw);
  if(c.mode==='intake')store.save(s);return result;
 },set:v=>{model=v;}});
}
export function drainObservations(controller:any,store:any){
 const start=controller.startNext.bind(controller);
 controller.startNext=async()=>{const initial=new Set(store.jobs().filter((j:any)=>j.kind==='interpret'&&j.status==='queued').map((j:any)=>j.id));await start();for(let n=0;n<24;n++){
  const next=store.jobs().find((j:any)=>j.kind==='interpret'&&j.status==='queued'&&!j.reply?.waitingForEarlier);
  if(!next||next.reply?.mode!=='outcome'&&!initial.has(next.id))break;initial.delete(next.id);await start();
 }};
}
