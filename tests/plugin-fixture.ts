import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { CodexGmailTransport } from '../src/gmail.js';
import type { Config } from '../src/config.js';
// Independent provider fixture: compose the plugin's public MIME-tree request
// into a delivered RFC message with a provider-owned identity.
export function pluginFixture(config: Config, receive: (args: any, raw: string) => void = () => {}) {
    const calls: any[] = [];
    const rpc = { close: async () => {}, request: async (_method: string, p: any) => {
        calls.push(p);
        if (p.tool !== 'gmail.send_email') throw Error('Unexpected fixture tool');
        const args=p.arguments, leaves:any[]=[];
        const visit=(part:any)=>part.parts?part.parts.forEach(visit):leaves.push(part);visit(args.payload);
        const raw=await new MailComposer({from:config.gmailAddress,to:args.to,subject:args.subject,messageId:'<delivered@provider.example.test>',inReplyTo:'<parent@gmail.com>',text:leaves.find(p=>p.mime_type==='text/plain'&&!p.filename)?.body.content,html:leaves.find(p=>p.mime_type==='text/html'&&!p.filename)?.body.content,attachments:leaves.filter(p=>p.filename).map(p=>({filename:p.filename,content:Buffer.from(p.body.base64_url_content,'base64url'),contentType:p.mime_type,contentDisposition:p.content_disposition,cid:p.content_id}))}).compile().build();
        receive(args,raw.toString('base64url'));
        return {structuredContent:{id:'sent',thread_id:'thread'}};
    } };
    const client = new (CodexGmailTransport as any)(config,rpc,'mail-thread',{send_email:{server:'codex_apps',tool:'gmail.send_email'}}) as CodexGmailTransport;
    return {client,calls};
}
