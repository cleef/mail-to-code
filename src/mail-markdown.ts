// A deliberately small, escaped Markdown renderer. No raw HTML or executable URLs.
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const inline = (s: string) => escape(s).replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>').replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
export interface MarkdownImage { alt: string; source: string }
// Use the same tokenizer for import and rendering. Code examples are never files.
export function mapMarkdownImages(text: string, replace: (image: MarkdownImage) => string) {
    let fenced = false;
    return text.split('\n').map(line => {
        if (/^\s*```/.test(line)) { fenced = !fenced; return line; }
        if (fenced) return line;
        return line.split(/(`+[^`]*`+)/g).map((part, n) => {
            if(n % 2)return part;
            const replaced=part.replace(/!\[([^\]\r\n]*)\]\((?:<([^<>\r\n]+)>|([^()\s]+))\)/g, (_, alt, angle, source) => replace({ alt, source: angle || source }));
            if(replaced.includes('!['))throw Error('MAIL_IMAGE_REFERENCE_INVALID');
            return replaced;
        }).join('');
    }).join('\n');
}
export function markdownHtml(text: string, images: ReadonlyMap<string, {cid:string}> = new Map()) {
    const replacements: string[] = [];
    text = mapMarkdownImages(text, image => {
        const resolved = images.get(image.source);
        if (!resolved) throw Error('MAIL_IMAGE_REFERENCE_UNREGISTERED');
        replacements.push(`<img src="cid:${escape(resolved.cid)}" alt="${escape(image.alt)}" style="max-width:100%;height:auto">`);
        return `\u0001mail-image-${replacements.length-1}\u0002`;
    });
    const lines = text.replace(/\r\n/g, '\n').split('\n'), output: string[] = [];
    let code = false;
    for (let n = 0; n < lines.length; n++) {
        const line = lines[n];
        if (/^```/.test(line)) {
            output.push(code ? '</code></pre>' : '<pre><code>');
            code = !code;
            continue;
        }
        if (code) {
            output.push(escape(line) + '\n');
            continue;
        }
        if (line.startsWith('|') && /^\|?\s*:?-+:?\s*\|/.test(lines[n + 1] || '')) {
            const cells = (v: string) => v.replace(/^\||\|$/g, '').split('|').map(v => inline(v.trim()));
            output.push('<table border="1" cellpadding="6" style="border-collapse:collapse"><thead><tr>' + cells(line).map(v => '<th>' + v + '</th>').join('') + '</tr></thead><tbody>');
            n++;
            while ((lines[n + 1] || '').startsWith('|')) {
                n++;
                output.push('<tr>' + cells(lines[n]).map(v => '<td>' + v + '</td>').join('') + '</tr>');
            }
            output.push('</tbody></table>');
            continue;
        }
        const heading = /^(#{1,3})\s+(.+)$/.exec(line);
        if (heading) {
            output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
            continue;
        }
        output.push(line ? '<div>' + inline(line) + '</div>' : '<br>');
    }
    if (code)
        output.push('</code></pre>');
    return output.join('\n').replace(/\u0001mail-image-(\d+)\u0002/g, (_, index) => replacements[Number(index)] || '');
}
