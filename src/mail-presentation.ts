import {escapeHtml,summaryHtml,summaryText} from './mail-summary.js';
import type {Attachment,MailBlock,MailPresentation,MailSummary,Outbound,RepoExecution,Session} from './types.js';

// Display-only. Authorization always uses the untouched full version/baseline.
export function readable(value:string):string {
 let result=value;
 // Balanced scanning handles nested objects/arrays and JSON strings in legacy summaries.
 for(let start=0;start<result.length;start++){
  if(result[start]!=='{'&&result[start]!=='[')continue;
  const stack:string[]=[];let quoted=false,escaped=false,end=start;
  for(;end<result.length;end++){
   const ch=result[end];if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
   if(ch==='"'){quoted=true;continue;}if(ch==='{'||ch==='[')stack.push(ch);else if(ch==='}'||ch===']'){const open=stack.pop();if(open!==(ch==='}'?'{':'['))break;if(!stack.length){end++;break;}}
  }
  if(stack.length||end<=start+1)continue;
  try{const parsed=JSON.parse(result.slice(start,end));const config=parsed&&!Array.isArray(parsed)&&typeof parsed==='object'&&['runtime','install','build','checks','packageSources','executable','profileVersion','profileProposal'].some(key=>key in parsed);
   const prose=(value:unknown):string=>Array.isArray(value)?value.map(prose).join('、'):value&&typeof value==='object'?Object.entries(value).map(([key,v])=>`${key}：${prose(v)}`).join('；'):typeof value==='boolean'?(value?'是':'否'):String(value??'无');
   const replacement=config?'':prose(parsed);result=result.slice(0,start)+replacement+result.slice(end);start+=replacement.length-1;}catch{/* Ordinary prose/Markdown, retain it. */}
 }
 result=result.split('\n').filter(line=>!/^\s*(工作流版本|配置版本|文档版本|方案清单|完整清单|当前版本|Profile)\s*[:：]/i.test(line)).join('\n');
 return result.replace(/\b[a-f0-9]{64}\b/gi,'（内部核验记录）').replace(/\b[a-f0-9]{40}\b/gi,sha=>sha.slice(-6)).replace(/\n{3,}/g,'\n\n').trim();
}
export function gitTail(sha?:string){return sha&&/^[a-f0-9]{40}$/i.test(sha)?sha.slice(-6):undefined;}
function paragraph(blocks:MailBlock[],title:string,text:string|undefined){const clean=readable(text||'');if(clean)blocks.push({kind:'paragraph',title,text:clean});}
function table(blocks:MailBlock[],title:string,headers:string[],rows:string[][]){if(rows.length)blocks.push({kind:'table',title,headers,rows:rows.map(r=>r.map(readable))});}
function unique(values:string[]){return [...new Set(values.map(readable).filter(Boolean))];}
function project(t:RepoExecution){return t.displayName&&t.displayName!==t.projectId?`${t.displayName}（${t.projectId}）`:t.projectId;}
function checkName(raw:string){
 if(/HTTP.*(?:2\d\d|3\d\d)|(?:^|\s)2\d\d(?:\s|$)/i.test(raw))return readable(raw);
 const script=raw.match(/\bnpm\s+run\s+([^\s]+)/)?.[1];
 if(script)return /typecheck/.test(script)?'类型检查':/build/.test(script)?(/weapp/.test(script)?'微信小程序构建':/h5/i.test(script)?'H5 构建':'构建'): /test/.test(script)?`测试（${script.replace(/^test:?/,'')||'自动化'}）`:`项目检查（${script}）`;
 if(/\bnpm\s+(ci|install)\b/.test(raw))return '依赖准备';
 if(/\bnpm\s+test\b/.test(raw))return '自动化测试';
 if(/screenshot|截图|preview|预览/i.test(raw))return '页面预览与截图';
 return readable(raw).replace(/(?:^|\s)\/[^\s]+/g,'（证据路径已记录）');
}
function checkRows(s:Session,kind:string){
 const rows:string[][]=[];
 for(const t of s.targets||[]){
  if(kind!=='plan')for(const check of t.checks||[])rows.push([project(t),checkName(check),/\b(fail(?:ed)?|error)\b|失败|:\s[45]\d\d$/i.test(check)?'失败':/\bpass(?:ed)?\b|通过|verified|✓|:\s[23]\d\d$/i.test(check)?'已通过':'已记录；不代表通过']);
  if(kind==='plan'||!(t.checks||[]).length){const p=t.profile;const labels=unique([...(p?.build||[]).map(c=>checkName(`${c.executable} ${c.args.join(' ')}`)),...(p?.checks||[]).map(c=>checkName(`${c.executable} ${c.args.join(' ')}`))]);rows.push([project(t),labels.join('、')||'交付物检查',kind==='plan'?'计划验证；尚未运行':'未记录通过结果']);}
  for(const check of unique(t.pendingChecks||[]))rows.push([project(t),check,/真机|人工|iOS|Android/i.test(check)?'待人工验证':'待验证']);
 }
 if(kind==='failure'&&s.lastError)rows.push(['当前执行',readable(s.lastError),'失败／结果待核对']);
 return rows;
}
function configuration(targets:RepoExecution[],references:RepoExecution[]){return [...targets,...references].map(t=>({project:t.projectId,role:references.includes(t)?'只读参考':t.mergeSha?'已合并，只读':'修改',sources:t.profile?.packageSources||[],services:t.profile?.services.map(v=>`${v.name}（${v.image.split('@')[0]}）`)||[],...(t.deployment?.enabled?{deployment:`${t.deployment.domain}（主机 ${t.deployment.host}）`}: {})}));}
function configRows(s:Session,previous?:MailPresentation){
 const facts=configuration(s.targets||[],s.references||[]);
 const rows:string[][]=[];
 for(const f of facts){
  const old=previous?.configuration?.find(v=>v.project===f.project);
  const changed=!!old&&JSON.stringify(old)!==JSON.stringify(f);
  const nonstandard=f.sources.some(source=>source!=='registry.npmjs.org');
  if(!changed&&!nonstandard&&!f.services.length)continue;
  const delta=changed?'与上一封相比已变化；本次重新确认':'本次重要执行条件';
  rows.push([f.project,delta,`${f.role}${old&&old.role!==f.role?`（原为${old.role}）`:''}；${f.role==='修改'?`依赖来源：${f.sources.join('、')||'无'}；隔离测试服务：${f.services.join('、')||'无'}；源码仅限该仓库的隔离工作区`:'不授予写入权限'}${f.deployment?`；发布目标：${f.deployment}（发布另行确认）`:''}`]);
 }
 return {facts,rows};
}
export function createPresentation(session:Session,m:Outbound,source:string,previous?:MailPresentation):MailPresentation {
 const s=session.targets?.length?session:{...session,targets:session.repo?[{projectId:session.repo,baseSha:session.baseSha,reviewSha:session.reviewSha,mergeSha:session.mergeSha,checks:session.checks,mailBrief:session.mailBrief,resultSummary:session.summary} as RepoExecution]:[]};
 const blocks:MailBlock[]=[];
 source=(s.targets||[]).reduce((text,t)=>[t.baseSha,t.reviewSha,t.mergeSha].filter((sha):sha is string=>!!sha&&/^[a-f0-9]{40}$/i.test(sha)).reduce((v,sha)=>v.replaceAll(sha,`${t.projectId} · ${sha.slice(-6)}`),text),source);
 const full=m.kind==='plan'||m.kind==='review';
 const brief=s.mailBrief;
 if(full){
  paragraph(blocks,'本邮件结论',m.kind==='plan'?(brief?.goal||s.summary||s.workflow?.proposal?.rationale):((s.targets||[]).length?`本次 Review 包含 ${s.targets!.length} 个项目，等待审阅完整交付物。`:'当前 Review 等待审阅交付物。'));
  paragraph(blocks,'当前进度',m.kind==='plan'?(s.targets?.some(t=>t.worktree)?'已有阶段工作保留；本邮件提出调整后的方案。下表为计划验证，不代表新方案测试已通过。':'本阶段尚未开始实施；下表为计划验证，不代表测试已通过。'):`Review #${s.revision}；批准范围为下列完整仓库清单。${s.workflow?.proposal?.kind==='documentation'?'文档合并后仅规划下一阶段，实施需新的 START。':'代码合并后，生产部署仍需单独确认。'}`);
  const briefs=m.kind==='review'?(s.targets||[]).flatMap(t=>t.mailBrief?[t.mailBrief]:[]):brief?[brief]:[];
  for(const category of ['product','technical'] as const){const choices=briefs.flatMap(b=>b.choices).filter(c=>c.category===category);table(blocks,category==='product'?'产品选择':'技术选择',['事项','方案与理由','主要代价或限制'],choices.map(c=>[c.topic,`${c.choice}\n理由：${c.reason}`,c.tradeoff]));}
  paragraph(blocks,'相比上一轮的变化',unique(briefs.flatMap(b=>b.changes)).join('\n'));
  table(blocks,'本次范围',['项目','权限与结果'],[...(s.targets||[]).map(t=>[project(t),`${t.mergeSha?'已合并，只读':t.recordEvidence||t.auxiliary?'回填产品证据':'修改'}${m.kind==='review'?`：${t.mailBrief?.goal||t.resultSummary||t.diffSummary||'见交付物'}`:''}`]),...(s.references||[]).map(t=>[project(t),'只读参考，不纳入修改清单'])]);
  if(s.workflow?.proposal){paragraph(blocks,'本阶段交付',unique(s.workflow.proposal.deliverables).join('\n'));paragraph(blocks,'验收重点',unique(s.workflow.proposal.acceptance).join('\n'));}
  table(blocks,'验证情况',['项目','检查内容','结果'],checkRows(s,m.kind));
  const cfg=configRows(s,previous);table(blocks,'执行条件与权限',['项目','变化','具体影响'],cfg.rows);
  if(m.kind==='review'&&(s.targets||[]).some(t=>t.profile?.kind==='taro'))paragraph(blocks,'证据范围','H5 截图只验证界面；微信原生行为仍需 iOS / Android 真机结果。');
  if(m.kind==='review')table(blocks,'审阅版本',['项目','交付版本（尾六位）'],(s.targets||[]).flatMap(t=>gitTail(t.reviewSha)?[[project(t),gitTail(t.reviewSha)!]]:[]));
  paragraph(blocks,'合并安排',(s.mergeOrder||[]).map(id=>project(s.targets?.find(t=>t.projectId===id)||{projectId:id} as RepoExecution)).join(' → '));
 }else{
  // Updates/clarifications carry only new information, never paste a full Review again.
  paragraph(blocks,'本邮件结论',m.kind==='input'&&source===s.summary?brief?.goal||source:source);
  if(m.kind==='input'&&source===s.summary&&brief)table(blocks,'待讨论的选择',['事项','方案与理由','代价或限制'],brief.choices.map(c=>[c.topic,`${c.choice}\n理由：${c.reason}`,c.tradeoff]));
  if(m.kind==='status')paragraph(blocks,'最近变化',s.mailBrief?.changes.join('\n'));
  if(m.kind==='failure')table(blocks,'执行结果',['项目','检查内容','结果'],checkRows(s,m.kind));
  if(m.kind==='merge'||m.kind==='deployed'){
   table(blocks,'交付结果',['项目','结果','版本（尾六位）'],(s.targets||[]).map(t=>[project(t),t.deployed?'已部署并验证':t.mergeSha?(s.workflow?.proposal?.kind==='documentation'?'文档已合并；实现进度见阶段摘要':'代码已合并，未部署'):'尚未合并',gitTail(t.mergeSha)||'—']));
   if(/配置已变化/.test(source))table(blocks,'新的执行条件',['项目','变化','具体影响'],configRows(s,previous).rows);
  }
 }
 table(blocks,'需要回复的事项',['编号','类型','事项'],(m.questions||[]).map((q,n)=>[String(n+1),q.kind==='confirm'?'确定确认项':q.kind==='choice'?'选择题':'开放问题',q.text]));
 if(m.questions?.length)paragraph(blocks,'回复方式',m.questions.some(q=>q.kind==='confirm')?'可回复“确认／同意”确认本邮件中全部确定事项；选择题与开放问题请具体回答。调整意见可一次提出多项。'+(m.approvalBinding?.action==='START'?' START 同样确认本次方案、范围和执行条件；本次确认不包含生产部署。':m.approvalBinding?.action==='APPROVE'?' APPROVE 批准完整 Review；本次确认不包含生产部署。':''):'请一次回答上述问题，可直接用中文提出多项意见。');
 if(m.kind==='review'&&(s.targets||[]).some(t=>t.manualMerge))paragraph(blocks,'合并方式','包含控制器自身，整批需要用户手动合并。');
 for(const a of m.attachments.filter(a=>a.cid))blocks.push({kind:'image',cid:a.cid!,caption:readable(`真实交付截图：${a.filename}。图片仅作视觉证据，审批范围和验证结果以上述文字为准。`)});
 const rendered=renderPresentation(m.summary,blocks,m.attachments);
 return {...rendered,version:1,blocks,configuration:configuration(s.targets||[],s.references||[])};
}
export function renderPresentation(summary:MailSummary|undefined,blocks:MailBlock[],attachments:Attachment[]=[]){
 const parts:string[]=[];const html:string[]=[];
 for(const b of blocks){
  if(b.kind==='paragraph'){parts.push([b.title,b.text].filter(Boolean).join('\n'));html.push(`${b.title?`<h2 style="font-size:17px;margin:22px 0 8px">${escapeHtml(b.title)}</h2>`:''}<p style="white-space:pre-wrap;margin:8px 0;overflow-wrap:anywhere">${escapeHtml(b.text)}</p>`);}
  if(b.kind==='table'){
   if(b.rows.some(r=>r.length!==b.headers.length))throw Error('MAIL_TABLE_COLUMNS');
   parts.push(b.title+'\n'+[b.headers,...b.rows].map(r=>r.map(v=>v.replace(/[\n\r|]/g,' ')).join(' | ')).join('\n'));
   const widths=b.headers.length===2?[35,65]:b.headers.length===3?(b.headers[0]==='事项'?[17,55,28]:b.headers[0]==='编号'?[12,23,65]:[25,50,25]):b.headers.map(()=>100/b.headers.length);
   const cell='border:1px solid #d9e1eb;padding:8px;vertical-align:top;text-align:left;overflow-wrap:anywhere;word-break:break-word;white-space:pre-wrap';
   html.push(`<h2 style="font-size:17px;margin:22px 0 8px">${escapeHtml(b.title)}</h2><table role="table" style="border-collapse:collapse;width:100%;table-layout:fixed;font-size:13px;line-height:1.5"><thead><tr>${b.headers.map((h,i)=>`<th style="${cell};width:${widths[i]}%;background:#f4f6f8">${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map(r=>`<tr>${r.map(v=>`<td style="${cell}">${escapeHtml(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
  }
  if(b.kind==='image'){
   if(!/^[a-zA-Z0-9._@-]{1,200}$/.test(b.cid)||!attachments.some(a=>a.cid===b.cid))throw Error('MAIL_IMAGE_REFERENCE');
   if(!b.caption.trim())throw Error('MAIL_IMAGE_CAPTION');
   parts.push(b.caption);html.push(`<p>${escapeHtml(b.caption)}</p><img alt="${escapeHtml(b.caption)}" style="max-width:100%;height:auto" src="cid:${escapeHtml(b.cid)}">`);
  }
 }
 return {text:(summary?summaryText(summary):'')+parts.join('\n\n'),html:`<div style="max-width:900px;margin:auto;font:15px/1.65 sans-serif;color:#172333;padding:12px">${summary?summaryHtml(summary):''}${html.join('')}</div>`};
}
// Keep this v1 renderer when adding future versions: pending snapshots must still verify.
export function verifyPresentation(p:MailPresentation,summary:MailSummary|undefined,attachments:Attachment[]){if(p.version!==1)throw Error('MAIL_PRESENTATION_VERSION');const rendered=renderPresentation(summary,p.blocks,attachments);if(rendered.text!==p.text||rendered.html!==p.html)throw Error('MAIL_PRESENTATION_SNAPSHOT_MISMATCH');}
