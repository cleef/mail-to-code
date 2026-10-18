import {escapeHtml,summaryHtml,summaryText} from './mail-summary.js';
import type {Attachment,MailBlock,MailPresentation,MailSummary} from './types.js';

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
