import { constants, openSync, closeSync, fstatSync, readFileSync, readSync, lstatSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep, relative, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { mapMarkdownImages, markdownHtml } from './mail-markdown.js';
import type { Attachment, MailBodySnapshot, Outbound } from './types.js';

export const MAIL_IMAGE_LIMIT = 10 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function mailImageDirectory(dataDir:string, conversationId:string) {
    return join(dataDir, 'async-cli', 'features', conversationId, 'notes', 'mail-images');
}
function format(bytes:Buffer, filename:string): 'image/png'|'image/jpeg' {
    try {
        const ext = extname(filename).toLowerCase();
        if (ext === '.png' && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) {
            if (bytes.length < 33 || bytes.toString('ascii',12,16) !== 'IHDR') throw Error();
            const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
            if (!width || !height || width>16384 || height>16384 || width*height>MAX_PIXELS) throw Error();
            // pngjs bounds ordinary PNG inflation, but not its interlaced path.
            // Bound inflation before either decoder can allocate an oversized stream.
            const idat:Buffer[]=[];
            for(let offset=8;offset<bytes.length;) {
                if(offset+12>bytes.length)throw Error();
                const length=bytes.readUInt32BE(offset),end=offset+12+length;
                if(end>bytes.length)throw Error();
                if(bytes.toString('ascii',offset+4,offset+8)==='IDAT')idat.push(bytes.subarray(offset+8,end-4));
                offset=end;
            }
            if(!idat.length)throw Error();
            inflateSync(Buffer.concat(idat),{maxOutputLength:Math.min(128*1024*1024,width*height*8+height*7+4096)});
            PNG.sync.read(bytes, {checkCRC:true});
            return 'image/png';
        }
        if (['.jpg','.jpeg'].includes(ext) && bytes[0]===255 && bytes[1]===216 && bytes[bytes.length-2]===255 && bytes[bytes.length-1]===217) {
            jpeg.decode(bytes,{useTArray:true,maxResolutionInMP:16,maxMemoryUsageInMB:128,tolerantDecoding:false});
            return 'image/jpeg';
        }
    } catch { /* Decoder details and private paths do not cross the bridge. */ }
    throw Error('MAIL_IMAGE_FORMAT_INVALID');
}
function sourceBytes(root:string, source:string) {
    let decoded:string;
    try { decoded=decodeURIComponent(source); } catch { throw Error('MAIL_IMAGE_REFERENCE_INVALID'); }
    if (/[\x00-\x1f\\]/.test(decoded) || decoded.split('/').includes('..')) throw Error('MAIL_IMAGE_REFERENCE_INVALID');
    const path=decoded.startsWith('/') ? resolve(decoded) : /^(?:\.\/)?mail-images\//.test(decoded) ? resolve(root,decoded.replace(/^(?:\.\/)?mail-images\//,'')) : '';
    if (!path || !path.startsWith(resolve(root)+sep)) throw Error('MAIL_IMAGE_OUTSIDE_TASK');
    // Check every model-writable component, not only the leaf. A symlinked
    // notes directory must not turn this privileged importer into a file reader.
    const notes=resolve(root,'..');
    try {
        let current=notes;
        if (lstatSync(current).isSymbolicLink()) throw Error('MAIL_IMAGE_SYMLINK_DENIED');
        for(const part of relative(notes,path).split(sep)) {
            current=join(current,part);
            if(lstatSync(current).isSymbolicLink())throw Error('MAIL_IMAGE_SYMLINK_DENIED');
        }
        const canonicalRoot=realpathSync(root), canonical=realpathSync(path);
        if(canonicalRoot!==join(realpathSync(resolve(notes,'..')),'notes','mail-images'))throw Error('MAIL_IMAGE_SYMLINK_DENIED');
        if(!canonical.startsWith(canonicalRoot+sep))throw Error('MAIL_IMAGE_OUTSIDE_TASK');
        if(!lstatSync(path).isFile())throw Error('MAIL_IMAGE_REGULAR_FILE_REQUIRED');
        const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try {
            const before=fstatSync(fd);
            if(!before.isFile() || before.nlink!==1)throw Error('MAIL_IMAGE_REGULAR_FILE_REQUIRED');
            if(before.size>MAIL_IMAGE_LIMIT)throw Error('MAIL_ATTACHMENTS_EXCEED_10_MIB');
            const buffer=Buffer.alloc(before.size+1);let size=0,read=0;
            do {read=readSync(fd,buffer,size,buffer.length-size,null);size+=read;}while(read && size<buffer.length);
            const bytes=buffer.subarray(0,size),after=lstatSync(path);
            if(after.isSymbolicLink() || before.ino!==after.ino || before.dev!==after.dev || before.size!==size || after.size!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs || realpathSync(path)!==canonical || realpathSync(root)!==canonicalRoot)throw Error('MAIL_IMAGE_SOURCE_CHANGED');
            if(bytes.length>MAIL_IMAGE_LIMIT)throw Error('MAIL_ATTACHMENTS_EXCEED_10_MIB');
            return {bytes,filename:basename(path)};
        } finally {closeSync(fd);}
    } catch(error) {
        if(error instanceof Error && /^MAIL_/.test(error.message))throw error;
        throw Error('MAIL_IMAGE_FILE_UNAVAILABLE');
    }
}
export function prepareMailBody(dataDir:string, conversationId:string, text:string): {bodySnapshot:MailBodySnapshot;attachments:Attachment[];attachmentHashes:string[]} {
    if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))throw Error('MAIL_BODY_CONTROL_CHARACTER');
    const root=mailImageDirectory(dataDir,conversationId),prepared=new Map<string,{bytes:Buffer;filename:string;contentType:'image/png'|'image/jpeg';cid:string;sha256:string}>();
    let total=0;
    const plain=mapMarkdownImages(text,image=>{
        let entry=prepared.get(image.source);
        if(!entry) {
            const file=sourceBytes(root,image.source);
            total+=file.bytes.length;if(total>MAIL_IMAGE_LIMIT)throw Error('MAIL_ATTACHMENTS_EXCEED_10_MIB');
            const contentType=format(file.bytes,file.filename),sha256=hash(file.bytes);
            entry={...file,contentType,sha256,cid:`image-${prepared.size}-${sha256.slice(0,24)}@mail-to-code`};prepared.set(image.source,entry);
        }
        return `[Image${image.alt ? ': '+image.alt : ''}: ${entry.filename}]`;
    });
    const bodySnapshot:MailBodySnapshot={version:1,text:plain,html:markdownHtml(text,prepared),images:[]},attachments:Attachment[]=[],attachmentHashes:string[]=[];
    if(prepared.size) {
        const destination=join(dataDir,'artifacts','mail-images',hash(conversationId),hash(text));
        mkdirSync(destination,{recursive:true,mode:0o700});
        for(const image of prepared.values()) {
            const path=join(destination,image.sha256+extname(image.filename).toLowerCase());
            try {writeFileSync(path,image.bytes,{flag:'wx',mode:0o400});}
            catch(error) {
                if((error as NodeJS.ErrnoException).code!=='EEXIST' || lstatSync(path).isSymbolicLink() || hash(readFileSync(path))!==image.sha256)throw Error('MAIL_IMAGE_FROZEN_COPY_INVALID');
            }
            attachments.push({path,filename:image.filename,cid:image.cid,contentType:image.contentType});attachmentHashes.push(image.sha256);
            bodySnapshot.images.push({cid:image.cid,filename:image.filename,contentType:image.contentType,sha256:image.sha256});
        }
    }
    return {bodySnapshot,attachments,attachmentHashes};
}
// Run before marking a send attempt. A damaged frozen file is a held reply,
// not an uncertain external effect. The transport checks again before its RPC.
export function verifyFrozenMailImages(dataDir:string,mail:Outbound) {
    if(!mail.bodySnapshot?.images.length)return;
    const root=resolve(dataDir,'artifacts','mail-images');
    try {
        let total=0;
        for(const [n,image] of mail.bodySnapshot.images.entries()) {
            const a=mail.attachments[n];
            if(!a || a.cid!==image.cid || a.filename!==image.filename || a.contentType!==image.contentType || mail.attachmentHashes?.[n]!==image.sha256)throw Error();
            if(!resolve(a.path).startsWith(root+sep))throw Error();
            let path=root;
            if(lstatSync(path).isSymbolicLink())throw Error();
            for(const part of relative(root,a.path).split(sep)){path=join(path,part);if(lstatSync(path).isSymbolicLink())throw Error();}
            const info=lstatSync(a.path);
            if(!info.isFile() || info.nlink!==1 || info.size>MAIL_IMAGE_LIMIT)throw Error();
            const bytes=readFileSync(a.path);total+=bytes.length;
            if(total>MAIL_IMAGE_LIMIT || hash(bytes)!==image.sha256)throw Error();
        }
        if(mail.attachments.length!==mail.bodySnapshot.images.length)throw Error();
    } catch {throw Error('MAIL_IMAGE_FROZEN_COPY_INVALID');}
}
