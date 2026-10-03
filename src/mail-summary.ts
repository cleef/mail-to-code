import type {MailSummary,Session,RepoExecution,WorkflowStage} from './types.js';
export const escapeHtml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
function deliveries(targets:RepoExecution[],s?:Session){
 const values=targets.length?targets:s?.prUrl||s?.branch?[{projectId:s.repo,prUrl:s.prUrl,branch:s.branch} as RepoExecution]:[];
 return values.map(t=>{
  if(t.prUrl){let u:URL;try{u=new URL(t.prUrl);}catch{return {label:`${t.projectId}: PR 链接无效`};}const expected=t.github?`/${t.github}/pull/`:undefined;
   if(u.username||u.password||u.port||u.protocol!=='https:'||u.hostname!=='github.com'||u.search||u.hash||!/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(u.pathname)||expected&&!u.pathname.startsWith(expected))return {label:`${t.projectId}: PR 链接无效`};
   return {label:`${t.displayName||t.projectId} PR #${u.pathname.split('/').at(-1)}`,url:u.href};
  }
  return {label:t.branch?`${t.displayName||t.projectId}: ${t.branch}`:`${t.displayName||t.projectId}: —（尚未创建分支／PR）`};
 });
}
function phase(proposal:import('./workflow.js').WorkflowProposal|undefined,number?:number,s?:Session){
 const words=[proposal?.name,...proposal?.deliverables||[]].join(' ');
 const label=proposal?.kind==='documentation'?(/PRD/i.test(words)&&/Design|设计/i.test(words)?'PRD / Design':'Documentation'):proposal?.kind==='implementation'?'Implementation':proposal?.kind==='maintenance'?'Maintenance':s?.blockedPhase==='develop'?'Implementation':s?.state==='WAITING_REVIEW'?'Review':s&&['MERGING','MERGED'].includes(s.state)?'Merge':s?.state==='DEPLOYING'?'Deployment':s?.state==='RUNNING'?'Execution':s?.workflow?.legacy?'Maintenance':'Planning';
 return `${label}${number?` · 阶段 ${number}`:''}`;
}
const names:Record<string,string>={QUEUED:'已排队',PLANNING:'规划中',WAITING_START:'待确认方案',RUNNING:'执行中',WAITING_INPUT:'待补充信息',WAITING_REVIEW:'待审阅批准',MERGING:'合并中',MERGED:'已合并，未部署',DEPLOYING:'部署中',DONE:'已完成',FAILED:'失败',CANCELLED:'已取消'};
function completed(h:WorkflowStage){return {phase:phase(h.proposal,h.number),status:h.proposal.kind==='documentation'?'DONE（已合并）':h.targets.some(t=>t.deployed)?'DONE（代码已合并；部署结果按仓库记录）':'DONE（代码已合并，未部署）',current:false,deliveries:deliveries(h.targets)};}
export function createSummary(s:Session):MailSummary|undefined{
 if(s.system)return;
 const history=s.workflow?.history||[];
 const allMerged=!!s.targets?.length&&s.targets.every(t=>!!t.mergeSha);
 const deployTargets=(s.targets||[]).filter(t=>t.deployment?.enabled);
 const deployed=deployTargets.length?deployTargets.every(t=>t.deployed):!!s.deployRelease;
 const partiallyDeployed=!deployed&&s.targets?.some(t=>t.deployed);
 const status=s.state==='DONE'?(deployed?'DONE（已部署）':partiallyDeployed?'DONE（部分仓库已部署）':allMerged?'DONE（已合并，未部署）':'DONE（任务已完成）'):s.state==='MERGED'&&s.workflow?.proposal?.kind==='documentation'?'DONE（文档已合并）':`${s.state}（${names[s.state]}）`;
 return {feature:s.title,rows:[...history.map(completed),{phase:phase(s.workflow?.proposal,s.workflow?.number,s),status,current:true,deliveries:deliveries(s.targets||[],s)}]};
}
export function summaryText(summary:MailSummary){
 const cell=(s:string)=>s.replace(/[\r\n|]/g,' ');
 return ['Feature name(description) | Progress (Phase) | Status | Delivery',...summary.rows.map(r=>[cell(summary.feature),cell(r.phase),cell(r.status),r.deliveries.map(d=>cell(d.label)+(d.url?` (${d.url})`:'')).join('; ')||'—（尚未创建分支／PR）'].join(' | '))].join('\n')+'\n\n';
}
export function summaryHtml(summary:MailSummary){
 const cell='border:1px solid #ddd;padding:8px;vertical-align:top;overflow-wrap:anywhere;word-break:break-word';
 const heads=['Feature name(description)','Progress (Phase)','Status','Delivery'];
 return `<table role="table" style="border-collapse:collapse;width:100%;table-layout:fixed;font:13px/1.5 sans-serif;margin-bottom:16px"><thead><tr>${heads.map(h=>`<th style="${cell};text-align:left">${h}</th>`).join('')}</tr></thead><tbody>${summary.rows.map(r=>`<tr${r.current?' style="background:#f0f5ff;font-weight:600"':''}><td style="${cell}">${escapeHtml(summary.feature)}</td><td style="${cell}">${escapeHtml(r.phase)}</td><td style="${cell}">${escapeHtml(r.status)}</td><td style="${cell}">${r.deliveries.map(d=>d.url&&/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(d.url)?`<a href="${escapeHtml(d.url)}">${escapeHtml(d.label)}</a>`:escapeHtml(d.label)).join('<br>')||'—（尚未创建分支／PR）'}</td></tr>`).join('')}</tbody></table>`;
}
