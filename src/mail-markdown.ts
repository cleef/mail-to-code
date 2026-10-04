// A deliberately small, escaped Markdown renderer. No raw HTML or executable URLs.
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const inline = (s: string) => escape(s).replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>').replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
export function markdownHtml(text: string) {
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
    return output.join('\n');
}
