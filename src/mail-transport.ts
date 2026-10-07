import type { Attachment, MailPresentation, MailSummary } from './types.js';
export interface MessageRef { id: string; threadId?: string }
export interface RawMessage extends MessageRef { threadId: string; raw: string; labelIds: string[]; internalDate?: string }
export interface SendMail {
    to: string; subject: string; text: string; markdown?: boolean; summary?: MailSummary;
    presentation?: MailPresentation; messageId?: string; deliveryMarker?: string; threadId?: string;
    inReplyTo?: string; references?: string[]; attachments?: Attachment[]; attachmentHashes?: string[]; replyMessageId?: string;
}
export interface MailTransport {
    profile(): Promise<{ emailAddress: string }>;
    search(query: string): Promise<MessageRef[]>;
    read(id: string): Promise<RawMessage>;
    send(input: SendMail): Promise<MessageRef & { threadId: string }>;
    prepareReply?(id: string, attachments?: Attachment[]): Promise<{ quoteHash: string; rfcId: string; threadId: string; attachmentHashes?: string[] }>;
    close?(): Promise<void>;
}
export class GmailError extends Error { constructor(public status: number, message: string) { super(message); } }
