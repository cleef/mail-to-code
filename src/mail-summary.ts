import type {MailSummary} from './types.js';
export const escapeHtml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export function summaryText(summary:MailSummary){
 const cell=(s:string)=>s.replace(/[\r\n|]/g,' ');
 return ['Feature name(description) | Progress (Phase) | Status | Delivery',...summary.rows.map(r=>[cell(summary.feature),cell(r.phase),cell(r.status),r.deliveries.map(d=>cell(d.label)+(d.url?` (${d.url})`:'')).join('; ')||'—（尚未创建分支／PR）'].join(' | '))].join('\n')+'\n\n';
}
export function summaryHtml(summary:MailSummary){
 const cell='border:1px solid #ddd;padding:8px;vertical-align:top;overflow-wrap:anywhere;word-break:break-word';
 const heads=['Feature name(description)','Progress (Phase)','Status','Delivery'];
 return `<table role="table" style="border-collapse:collapse;width:100%;table-layout:fixed;font:13px/1.5 sans-serif;margin-bottom:16px"><thead><tr>${heads.map(h=>`<th style="${cell};text-align:left">${h}</th>`).join('')}</tr></thead><tbody>${summary.rows.map(r=>`<tr${r.current?' style="background:#f0f5ff;font-weight:600"':''}><td style="${cell}">${escapeHtml(summary.feature)}</td><td style="${cell}">${escapeHtml(r.phase)}</td><td style="${cell}">${escapeHtml(r.status)}</td><td style="${cell}">${r.deliveries.map(d=>d.url&&/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(d.url)?`<a href="${escapeHtml(d.url)}">${escapeHtml(d.label)}</a>`:escapeHtml(d.label)).join('<br>')||'—（尚未创建分支／PR）'}</td></tr>`).join('')}</tbody></table>`;
}
