import { createHash } from 'node:crypto';
export const normalizeMailBody = (text: string) => text.replace(/\r\n/g, '\n').trim();
export const quoteHash = (text: string) => createHash('sha256').update(normalizeMailBody(text)).digest('hex');
export function matchesFrozenBody(text: string, expected: string, parentHash?: string) {
    if (!parentHash) return normalizeMailBody(text) === normalizeMailBody(expected);
    const actual = text.replace(/\r\n/g, '\n'), frozen = expected.replace(/\r\n/g, '\n');
    if (!actual.startsWith(frozen)) return false;
    const tail = actual.slice(frozen.length);
    const match = /^\n\nOn [^\n]+ wrote:\n([\s\S]*)$/.exec(tail);
    if (!match) return false;
    const lines = match[1].trimEnd().split('\n');
    if (lines.some(line => !line.startsWith('>'))) return false;
    return quoteHash(lines.map(line => line.replace(/^> ?/, '')).join('\n')) === parentHash;
}
