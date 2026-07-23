import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import * as z from 'zod';

import { BridgeError, type AtomicStateStore } from './auth.js';

export const IMAP_ENDPOINT = {
    host: 'imap.yandex.com',
    port: 993,
    secure: true
} as const;

export const SMTP_ENDPOINT = {
    host: 'smtp.yandex.com',
    port: 465,
    secure: true
} as const;

const MAX_BODY_CHARS = 262_144;
const MAX_SEND_CONTENT_BYTES = 1_048_576;
const MAX_MESSAGE_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_STRUCTURE_DEPTH = 32;
const MAX_STRUCTURE_NODES = 1_000;
const SEND_LEDGER_TTL_SECONDS = 7 * 24 * 60 * 60;

export const mailboxAddressSchema = z
    .string()
    .trim()
    .min(3)
    .max(254)
    .refine(
        (value) =>
            /^[^\s@]+@[^\s@]+$/.test(value) &&
            !value.includes('..') &&
            value.indexOf('@') === value.lastIndexOf('@'),
        'A full mailbox address is required'
    );

const folderSchema = z.string().trim().min(1).max(128);
const emailSchema = z.email().max(254);

export const resolveMailboxRequestSchema = z.object({}).strict();

export const listMessagesRequestSchema = z
    .object({
        folder: folderSchema.default('INBOX'),
        limit: z.number().int().min(1).max(100).default(25),
        unseenOnly: z.boolean().default(false),
        from: emailSchema.optional(),
        subject: z.string().max(256).optional(),
        since: z.iso.datetime({ offset: true }).optional(),
        beforeUid: z.number().int().positive().optional()
    })
    .strict();

export const getMessageRequestSchema = z
    .object({
        folder: folderSchema.default('INBOX'),
        uid: z.number().int().positive()
    })
    .strict();

const canonicalBase64Schema = z
    .string()
    .min(1)
    .max(1_400_000)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
    .refine((value) => Buffer.from(value, 'base64').toString('base64') === value, 'Base64 must be canonical');

const attachmentRequestSchema = z
    .object({
        filename: z.string().trim().min(1).max(255),
        contentType: z.string().trim().min(1).max(127),
        contentBase64: canonicalBase64Schema
    })
    .strict();

export const sendMessageRequestSchema = z
    .object({
        idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
        to: z.array(emailSchema).min(1).max(50),
        cc: z.array(emailSchema).max(50).optional(),
        bcc: z.array(emailSchema).max(50).optional(),
        subject: z.string().max(998),
        text: z.string().max(MAX_BODY_CHARS).optional(),
        html: z.string().max(MAX_BODY_CHARS).optional(),
        attachments: z.array(attachmentRequestSchema).max(10).optional()
    })
    .strict()
    .refine((value) => value.text !== undefined || value.html !== undefined, {
        message: 'A text or HTML body is required'
    })
    .superRefine((value, context) => {
        const contentBytes =
            Buffer.byteLength(value.text ?? '', 'utf8') +
            Buffer.byteLength(value.html ?? '', 'utf8') +
            (value.attachments ?? []).reduce(
                (total, attachment) => total + Buffer.from(attachment.contentBase64, 'base64').byteLength,
                0
            );
        if (contentBytes > MAX_SEND_CONTENT_BYTES) {
            context.addIssue({
                code: 'custom',
                message: `Combined message bodies and decoded attachments must not exceed ${MAX_SEND_CONTENT_BYTES} bytes`
            });
        }
    });

export type ListMessagesRequest = z.infer<typeof listMessagesRequestSchema>;
export type GetMessageRequest = z.infer<typeof getMessageRequestSchema>;
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

type Address = {
    name: string | null;
    address: string | null;
};

export type MessageSummary = {
    uid: number;
    subject: string | null;
    from: Address[];
    to: Address[];
    receivedAt: string | null;
    flags: string[];
    size: number;
    hasAttachments: boolean;
};

type AttachmentMetadata = {
    filename: string | null;
    contentType: string;
    size: number;
    contentId: string | null;
};

type ImapClientLike = {
    connect(): Promise<void>;
    logout(): Promise<void>;
    mailboxOpen(path: string, options: { readOnly: true }): Promise<unknown>;
    search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false>;
    fetchAll(
        range: number[],
        query: Record<string, boolean>,
        options: { uid: true }
    ): Promise<Array<Record<string, unknown>>>;
    fetchOne(
        uid: number,
        query: Record<string, boolean>,
        options: { uid: true }
    ): Promise<Record<string, unknown> | false>;
};

type ImapFactory = (options: {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; accessToken: string };
    logger: false;
    disableAutoIdle: true;
    connectionTimeout: number;
    greetingTimeout: number;
    socketTimeout: number;
    maxLineLength: number;
    maxLiteralSize: number;
}) => ImapClientLike;

type SmtpTransportLike = {
    sendMail(message: Record<string, unknown>): Promise<{ messageId?: unknown }>;
    close?(): void;
};

type SmtpFactory = (options: {
    host: string;
    port: number;
    secure: boolean;
    pool: false;
    connectionTimeout: number;
    greetingTimeout: number;
    socketTimeout: number;
    logger: false;
    debug: false;
    auth: { type: 'OAuth2'; user: string; accessToken: string };
}) => SmtpTransportLike;

type SendEnvelope =
    | {
          ok: true;
          outcome: 'confirmed';
          result: { mailbox: string; messageId: string };
      }
    | {
          ok: false;
          outcome: 'not_started' | 'unknown';
          error: { code: string; message: string; retryable: boolean };
      };

function defaultImapFactory(options: Parameters<ImapFactory>[0]): ImapClientLike {
    return new ImapFlow(options) as unknown as ImapClientLike;
}

function defaultSmtpFactory(options: Parameters<SmtpFactory>[0]): SmtpTransportLike {
    return nodemailer.createTransport(options) as unknown as SmtpTransportLike;
}

function confirmedFailed(code: string, message: string, status = 502, retryable = false): BridgeError {
    return new BridgeError({
        code,
        message,
        status,
        outcome: 'confirmed_failed',
        retryable
    });
}

function safeFailure(
    outcome: 'not_started' | 'unknown',
    code: string,
    message: string,
    retryable = false
): SendEnvelope {
    return {
        ok: false,
        outcome,
        error: { code, message, retryable }
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    return value.slice(0, max);
}

function contentId(value: unknown): string | null {
    const bounded = boundedString(value, 512);
    if (bounded?.startsWith('<') && bounded.endsWith('>')) {
        return bounded.slice(1, -1);
    }
    return bounded;
}

function mapAddresses(value: unknown): Address[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.slice(0, 100).map((entry) => {
        if (!isRecord(entry)) {
            return { name: null, address: null };
        }
        return {
            name: boundedString(entry.name, 256),
            address: boundedString(entry.address, 254)
        };
    });
}

function dateToIso(value: unknown): string | null {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
    }
    if (typeof value === 'string') {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    return null;
}

function walkStructure(structure: unknown, visit: (node: Record<string, unknown>) => void): void {
    if (!isRecord(structure)) {
        return;
    }
    const stack: Array<{ node: Record<string, unknown>; depth: number }> = [{ node: structure, depth: 0 }];
    const visited = new WeakSet<object>();
    let nodeCount = 0;
    while (stack.length > 0) {
        const current = stack.pop()!;
        nodeCount += 1;
        if (
            current.depth > MAX_STRUCTURE_DEPTH ||
            nodeCount > MAX_STRUCTURE_NODES ||
            visited.has(current.node)
        ) {
            throw confirmedFailed('imap_response_invalid', 'Yandex Mail returned invalid message structure.');
        }
        visited.add(current.node);
        visit(current.node);
        if (!Array.isArray(current.node.childNodes)) {
            continue;
        }
        for (let index = current.node.childNodes.length - 1; index >= 0; index -= 1) {
            const child = current.node.childNodes[index];
            if (!isRecord(child)) {
                throw confirmedFailed('imap_response_invalid', 'Yandex Mail returned invalid message structure.');
            }
            stack.push({ node: child, depth: current.depth + 1 });
        }
    }
}

function hasAttachment(structure: unknown): boolean {
    let found = false;
    walkStructure(structure, (node) => {
        if (typeof node.disposition === 'string' && node.disposition.toLowerCase() === 'attachment') {
            found = true;
        }
    });
    return found;
}

function mapSummary(message: Record<string, unknown>): MessageSummary {
    const uid = message.uid;
    if (!Number.isSafeInteger(uid) || (uid as number) <= 0) {
        throw confirmedFailed('imap_response_invalid', 'Yandex Mail returned invalid message metadata.');
    }
    const envelope = isRecord(message.envelope) ? message.envelope : {};
    const flags = message.flags instanceof Set ? [...message.flags] : [];
    const size = Number.isSafeInteger(message.size) && (message.size as number) >= 0 ? (message.size as number) : 0;
    return {
        uid: uid as number,
        subject: boundedString(envelope.subject, 998),
        from: mapAddresses(envelope.from),
        to: mapAddresses(envelope.to),
        receivedAt: dateToIso(message.internalDate) ?? dateToIso(envelope.date),
        flags: flags.filter((flag): flag is string => typeof flag === 'string').slice(0, 100).map((flag) => flag.slice(0, 128)),
        size,
        hasAttachments: hasAttachment(message.bodyStructure)
    };
}

function structureAttachments(structure: unknown): AttachmentMetadata[] {
    const attachments: AttachmentMetadata[] = [];
    walkStructure(structure, (node) => {
        if (
            attachments.length >= 100 ||
            typeof node.disposition !== 'string' ||
            node.disposition.toLowerCase() !== 'attachment'
        ) {
            return;
        }
        const parameters = isRecord(node.dispositionParameters) ? node.dispositionParameters : {};
        const typeParameters = isRecord(node.parameters) ? node.parameters : {};
        attachments.push({
            filename:
                boundedString(parameters.filename, 255) ??
                boundedString(parameters.name, 255) ??
                boundedString(typeParameters.name, 255),
            contentType: boundedString(node.type, 127) ?? 'application/octet-stream',
            size: Number.isSafeInteger(node.size) && (node.size as number) >= 0 ? (node.size as number) : 0,
            contentId: contentId(node.id)
        });
    });
    return attachments;
}

async function logoutQuietly(client: ImapClientLike): Promise<void> {
    try {
        await client.logout();
    } catch {
        // The provider operation already has its own safe outcome.
    }
}

export class MailService {
    readonly #store: AtomicStateStore;
    readonly #imapFactory: ImapFactory;
    readonly #smtpFactory: SmtpFactory;

    constructor(input: {
        store: AtomicStateStore;
        imapFactory?: ImapFactory;
        smtpFactory?: SmtpFactory;
    }) {
        this.#store = input.store;
        this.#imapFactory = input.imapFactory ?? defaultImapFactory;
        this.#smtpFactory = input.smtpFactory ?? defaultSmtpFactory;
    }

    async resolveMailbox(mailboxValue: string, accessToken: string): Promise<{ mailbox: string }> {
        const mailbox = mailboxAddressSchema.parse(mailboxValue);
        const client = this.#newImapClient(mailbox, accessToken);
        try {
            await client.connect();
            return { mailbox };
        } catch {
            throw confirmedFailed(
                'imap_connection_validation_failed',
                'The Yandex Mail connection could not be validated.',
                502,
                true
            );
        } finally {
            await logoutQuietly(client);
        }
    }

    async listMessages(
        mailboxValue: string,
        accessToken: string,
        requestValue: ListMessagesRequest
    ): Promise<{ mailbox: string; messages: MessageSummary[]; nextCursor: string | null }> {
        const mailbox = mailboxAddressSchema.parse(mailboxValue);
        const request = listMessagesRequestSchema.parse(requestValue);
        const client = this.#newImapClient(mailbox, accessToken);
        try {
            await client.connect();
            await client.mailboxOpen(request.folder, { readOnly: true });
            const query: Record<string, unknown> = {};
            if (request.unseenOnly) {
                query.seen = false;
            }
            if (request.from !== undefined) {
                query.from = request.from;
            }
            if (request.subject !== undefined) {
                query.subject = request.subject;
            }
            if (request.since !== undefined) {
                query.since = new Date(request.since);
            }
            if (Object.keys(query).length === 0) {
                query.all = true;
            }
            const found = await client.search(query, { uid: true });
            const candidates = (found || [])
                .filter((uid) => Number.isSafeInteger(uid) && uid > 0)
                .filter((uid) => request.beforeUid === undefined || uid < request.beforeUid)
                .sort((left, right) => right - left);
            const selected = candidates.slice(0, request.limit);
            const fetched =
                selected.length === 0
                    ? []
                    : await client.fetchAll(
                          selected,
                          {
                              uid: true,
                              envelope: true,
                              internalDate: true,
                              flags: true,
                              size: true,
                              bodyStructure: true
                          },
                          { uid: true }
                      );
            const byUid = new Map(
                fetched
                    .filter(isRecord)
                    .map((message) => [message.uid, mapSummary(message)] as const)
            );
            const messages = selected.flatMap((uid) => {
                const message = byUid.get(uid);
                return message ? [message] : [];
            });
            return {
                mailbox,
                messages,
                nextCursor:
                    candidates.length > selected.length && selected.length > 0
                        ? String(selected[selected.length - 1])
                        : null
            };
        } catch (error) {
            if (error instanceof BridgeError) {
                throw error;
            }
            throw confirmedFailed('imap_request_failed', 'The Yandex Mail list request failed.', 502, true);
        } finally {
            await logoutQuietly(client);
        }
    }

    async getMessage(
        mailboxValue: string,
        accessToken: string,
        requestValue: GetMessageRequest
    ): Promise<{
        mailbox: string;
        message: MessageSummary & {
            text: string | null;
            html: string | null;
            bodyTruncated: boolean;
            attachments: AttachmentMetadata[];
        };
    }> {
        const mailbox = mailboxAddressSchema.parse(mailboxValue);
        const request = getMessageRequestSchema.parse(requestValue);
        const client = this.#newImapClient(mailbox, accessToken);
        try {
            await client.connect();
            await client.mailboxOpen(request.folder, { readOnly: true });
            const metadata = await client.fetchOne(
                request.uid,
                {
                    uid: true,
                    envelope: true,
                    internalDate: true,
                    flags: true,
                    size: true,
                    bodyStructure: true
                },
                { uid: true }
            );
            if (!metadata) {
                throw confirmedFailed('message_not_found', 'The requested Yandex Mail message was not found.', 404);
            }
            const summary = mapSummary(metadata);
            let text: string | null = null;
            let html: string | null = null;
            let attachments = structureAttachments(metadata.bodyStructure);
            let bodyTruncated = summary.size > MAX_MESSAGE_SOURCE_BYTES;
            if (!bodyTruncated) {
                const sourceMessage = await client.fetchOne(request.uid, { source: true }, { uid: true });
                if (!sourceMessage || !Buffer.isBuffer(sourceMessage.source)) {
                    throw confirmedFailed('imap_response_invalid', 'Yandex Mail returned an invalid message body.');
                }
                if (sourceMessage.source.byteLength > MAX_MESSAGE_SOURCE_BYTES) {
                    throw confirmedFailed('message_too_large', 'The Yandex Mail message exceeds the bridge limit.', 413);
                }
                const parsed = await simpleParser(sourceMessage.source, {
                    skipHtmlToText: true,
                    skipTextToHtml: true,
                    maxHtmlLengthToParse: MAX_BODY_CHARS
                });
                const parsedText = typeof parsed.text === 'string' ? parsed.text.trimEnd() : null;
                const parsedHtml = typeof parsed.html === 'string' ? parsed.html.trimEnd() : null;
                bodyTruncated =
                    (parsedText?.length ?? 0) > MAX_BODY_CHARS || (parsedHtml?.length ?? 0) > MAX_BODY_CHARS;
                text = parsedText?.slice(0, MAX_BODY_CHARS) ?? null;
                html = parsedHtml?.slice(0, MAX_BODY_CHARS) ?? null;
                attachments = parsed.attachments.slice(0, 100).map((attachment) => ({
                    filename: boundedString(attachment.filename, 255),
                    contentType: boundedString(attachment.contentType, 127) ?? 'application/octet-stream',
                    size: Number.isSafeInteger(attachment.size) && attachment.size >= 0 ? attachment.size : 0,
                    contentId: contentId(attachment.contentId)
                }));
            }
            return {
                mailbox,
                message: {
                    ...summary,
                    text,
                    html,
                    bodyTruncated,
                    attachments
                }
            };
        } catch (error) {
            if (error instanceof BridgeError) {
                throw error;
            }
            throw confirmedFailed('imap_request_failed', 'The Yandex Mail message request failed.', 502, true);
        } finally {
            await logoutQuietly(client);
        }
    }

    async sendMessage(
        mailboxValue: string,
        accessToken: string,
        requestValue: SendMessageRequest,
        bodyHash: string
    ): Promise<SendEnvelope> {
        const mailbox = mailboxAddressSchema.parse(mailboxValue);
        const request = sendMessageRequestSchema.parse(requestValue);
        let transport: SmtpTransportLike;
        try {
            transport = this.#smtpFactory({
                ...SMTP_ENDPOINT,
                pool: false,
                connectionTimeout: 15_000,
                greetingTimeout: 15_000,
                socketTimeout: 30_000,
                logger: false,
                debug: false,
                auth: { type: 'OAuth2', user: mailbox, accessToken }
            });
        } catch {
            return safeFailure('not_started', 'smtp_initialization_failed', 'SMTP dispatch could not be initialized.', true);
        }

        const ledgerKey = `${mailbox}\0${request.idempotencyKey}`;
        let begin;
        try {
            begin = await this.#store.beginSend(ledgerKey, bodyHash, SEND_LEDGER_TTL_SECONDS);
        } catch {
            transport.close?.();
            return safeFailure(
                'not_started',
                'idempotency_store_unavailable',
                'The send idempotency store is unavailable.',
                true
            );
        }
        if (begin.kind === 'conflict') {
            transport.close?.();
            return safeFailure(
                'not_started',
                'idempotency_conflict',
                'The idempotency key was already used for a different message.'
            );
        }
        if (begin.kind === 'unknown') {
            transport.close?.();
            return safeFailure(
                'unknown',
                'smtp_outcome_unknown',
                'SMTP dispatch may have completed; inspect the mailbox before retrying.'
            );
        }
        if (begin.kind === 'cached') {
            transport.close?.();
            try {
                const cached = JSON.parse(begin.result) as unknown;
                if (
                    isRecord(cached) &&
                    cached.mailbox === mailbox &&
                    typeof cached.messageId === 'string' &&
                    cached.messageId.length >= 1 &&
                    cached.messageId.length <= 998
                ) {
                    return {
                        ok: true,
                        outcome: 'confirmed',
                        result: { mailbox, messageId: cached.messageId }
                    };
                }
            } catch {
                // A malformed confirmed record cannot safely authorize another send.
            }
            return safeFailure(
                'unknown',
                'smtp_outcome_unknown',
                'SMTP dispatch may have completed; inspect the mailbox before retrying.'
            );
        }

        try {
            const response = await transport.sendMail({
                from: mailbox,
                to: request.to,
                ...(request.cc === undefined ? {} : { cc: request.cc }),
                ...(request.bcc === undefined ? {} : { bcc: request.bcc }),
                subject: request.subject,
                ...(request.text === undefined ? {} : { text: request.text }),
                ...(request.html === undefined ? {} : { html: request.html }),
                attachments: (request.attachments ?? []).map((attachment) => ({
                    filename: attachment.filename,
                    contentType: attachment.contentType,
                    content: Buffer.from(attachment.contentBase64, 'base64')
                })),
                disableFileAccess: true,
                disableUrlAccess: true
            });
            if (typeof response.messageId !== 'string' || response.messageId.length < 1 || response.messageId.length > 998) {
                await this.#markUnknown(ledgerKey, bodyHash);
                return safeFailure(
                    'unknown',
                    'smtp_outcome_unknown',
                    'SMTP dispatch may have completed; inspect the mailbox before retrying.'
                );
            }
            const result = { mailbox, messageId: response.messageId };
            try {
                const recorded = await this.#store.confirmSend(
                    ledgerKey,
                    bodyHash,
                    JSON.stringify(result),
                    SEND_LEDGER_TTL_SECONDS
                );
                if (!recorded) {
                    throw new Error('ledger transition rejected');
                }
            } catch {
                await this.#markUnknown(ledgerKey, bodyHash);
                return safeFailure(
                    'unknown',
                    'smtp_outcome_unknown',
                    'SMTP dispatch may have completed; inspect the mailbox before retrying.'
                );
            }
            return { ok: true, outcome: 'confirmed', result };
        } catch {
            await this.#markUnknown(ledgerKey, bodyHash);
            return safeFailure(
                'unknown',
                'smtp_outcome_unknown',
                'SMTP dispatch may have completed; inspect the mailbox before retrying.'
            );
        } finally {
            transport.close?.();
        }
    }

    #newImapClient(mailbox: string, accessToken: string): ImapClientLike {
        return this.#imapFactory({
            ...IMAP_ENDPOINT,
            auth: { user: mailbox, accessToken },
            logger: false,
            disableAutoIdle: true,
            connectionTimeout: 15_000,
            greetingTimeout: 15_000,
            socketTimeout: 30_000,
            maxLineLength: 1024 * 1024,
            maxLiteralSize: MAX_MESSAGE_SOURCE_BYTES + 1024
        });
    }

    async #markUnknown(key: string, bodyHash: string): Promise<void> {
        try {
            await this.#store.markSendUnknown(key, bodyHash, SEND_LEDGER_TTL_SECONDS);
        } catch {
            // Unknown remains the only safe client-visible outcome.
        }
    }
}
