import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { InMemoryAtomicStore } from '../src/auth.js';
import {
    IMAP_ENDPOINT,
    SMTP_ENDPOINT,
    MailService,
    getMessageRequestSchema,
    listMessagesRequestSchema,
    sendMessageRequestSchema
} from '../src/mail.js';

const MAILBOX = 'robot@custom-domain.example';
const TOKEN = 'oauth-token';

function envelope() {
    return {
        subject: 'Status',
        from: [{ name: 'Sender', address: 'sender@example.com' }],
        to: [{ name: 'Robot', address: MAILBOX }],
        date: new Date('2026-07-23T12:00:00.000Z')
    };
}

function imapHarness(options: {
    search?: number[];
    fetchAll?: unknown[];
    fetchOne?: unknown;
    sourceFetch?: unknown;
} = {}) {
    const connect = vi.fn().mockResolvedValue(undefined);
    const logout = vi.fn().mockResolvedValue(undefined);
    const mailboxOpen = vi.fn().mockResolvedValue({ exists: 1 });
    const search = vi.fn().mockResolvedValue(options.search ?? [44]);
    const fetchAll = vi.fn().mockResolvedValue(
        options.fetchAll ?? [
            {
                uid: 44,
                envelope: envelope(),
                internalDate: new Date('2026-07-23T12:00:00.000Z'),
                flags: new Set(['\\Seen']),
                size: 512,
                bodyStructure: {
                    type: 'multipart/mixed',
                    childNodes: [{ type: 'text/plain' }, { type: 'application/pdf', disposition: 'attachment' }]
                }
            }
        ]
    );
    const fetchOne = vi
        .fn()
        .mockResolvedValueOnce(
            options.fetchOne ?? {
                uid: 44,
                envelope: envelope(),
                internalDate: new Date('2026-07-23T12:00:00.000Z'),
                flags: new Set(['\\Seen']),
                size: 512,
                bodyStructure: { type: 'text/plain' }
            }
        )
        .mockResolvedValueOnce(
            options.sourceFetch ?? {
                uid: 44,
                source: Buffer.from(
                    [
                        'From: Sender <sender@example.com>',
                        `To: Robot <${MAILBOX}>`,
                        'Subject: Status',
                        'Content-Type: text/plain; charset=utf-8',
                        '',
                        'Everything is green.'
                    ].join('\r\n')
                )
            }
        );
    const factory = vi.fn().mockReturnValue({ connect, logout, mailboxOpen, search, fetchAll, fetchOne });
    return { factory, connect, logout, mailboxOpen, search, fetchAll, fetchOne };
}

function smtpHarness(options: { result?: unknown; error?: Error } = {}) {
    const sendMail = options.error
        ? vi.fn().mockRejectedValue(options.error)
        : vi.fn().mockResolvedValue(options.result ?? { messageId: '<message-123@yandex.ru>' });
    const close = vi.fn();
    const factory = vi.fn().mockReturnValue({ sendMail, close });
    return { factory, sendMail, close };
}

describe('strict mail request schemas', () => {
    it('rejects mailbox, token, URL and file attachment controls inside payload', () => {
        expect(listMessagesRequestSchema.safeParse({ limit: 5, mailbox: 'attacker@example.com' }).success).toBe(false);
        expect(getMessageRequestSchema.safeParse({ uid: 1, accessToken: 'attacker-token' }).success).toBe(false);
        expect(
            sendMessageRequestSchema.safeParse({
                idempotencyKey: 'send-12345678',
                to: ['recipient@example.com'],
                subject: 'hello',
                text: 'body',
                smtpHost: 'attacker.example'
            }).success
        ).toBe(false);
        expect(
            sendMessageRequestSchema.safeParse({
                idempotencyKey: 'send-12345678',
                to: ['recipient@example.com'],
                subject: 'hello',
                text: 'body',
                attachments: [{ filename: 'secret', contentType: 'text/plain', path: '/etc/passwd' }]
            }).success
        ).toBe(false);
    });
});

describe('pinned Yandex IMAP behavior', () => {
    it('uses custom-domain mailbox with XOAUTH2 and fixed imap.yandex.com:993 TLS', async () => {
        const imap = imapHarness();
        const service = new MailService({
            store: new InMemoryAtomicStore(),
            imapFactory: imap.factory,
            smtpFactory: smtpHarness().factory
        });

        const result = await service.resolveMailbox(MAILBOX, TOKEN);

        expect(result).toEqual({ mailbox: MAILBOX });
        expect(IMAP_ENDPOINT).toEqual({ host: 'imap.yandex.com', port: 993, secure: true });
        expect(imap.factory).toHaveBeenCalledWith(
            expect.objectContaining({
                host: 'imap.yandex.com',
                port: 993,
                secure: true,
                auth: { user: MAILBOX, accessToken: TOKEN }
            })
        );
        expect(imap.connect).toHaveBeenCalledTimes(1);
        expect(imap.logout).toHaveBeenCalledTimes(1);
    });

    it('maps a bounded IMAP search/list result and attachment presence', async () => {
        const imap = imapHarness({ search: [41, 42, 43, 44] });
        const service = new MailService({
            store: new InMemoryAtomicStore(),
            imapFactory: imap.factory,
            smtpFactory: smtpHarness().factory
        });

        const result = await service.listMessages(MAILBOX, TOKEN, {
            folder: 'INBOX',
            limit: 1,
            unseenOnly: true,
            from: 'sender@example.com',
            subject: 'Status',
            since: '2026-07-01T00:00:00.000Z'
        });

        expect(imap.mailboxOpen).toHaveBeenCalledWith('INBOX', { readOnly: true });
        expect(imap.search).toHaveBeenCalledWith(
            {
                seen: false,
                from: 'sender@example.com',
                subject: 'Status',
                since: new Date('2026-07-01T00:00:00.000Z')
            },
            { uid: true }
        );
        expect(imap.fetchAll.mock.calls[0]![0]).toEqual([44]);
        expect(result).toEqual({
            mailbox: MAILBOX,
            messages: [
                {
                    uid: 44,
                    subject: 'Status',
                    from: [{ name: 'Sender', address: 'sender@example.com' }],
                    to: [{ name: 'Robot', address: MAILBOX }],
                    receivedAt: '2026-07-23T12:00:00.000Z',
                    flags: ['\\Seen'],
                    size: 512,
                    hasAttachments: true
                }
            ],
            nextCursor: '44'
        });
    });

    it('maps a bounded message body and attachment metadata without returning content', async () => {
        const imap = imapHarness({
            fetchOne: {
                uid: 44,
                envelope: envelope(),
                internalDate: new Date('2026-07-23T12:00:00.000Z'),
                flags: new Set(['\\Seen']),
                size: 512,
                bodyStructure: {
                    type: 'multipart/mixed',
                    childNodes: [
                        { type: 'text/plain' },
                        {
                            type: 'application/pdf',
                            disposition: 'attachment',
                            dispositionParameters: { filename: 'report.pdf' },
                            size: 1,
                            id: 'report'
                        }
                    ]
                }
            },
            sourceFetch: {
                uid: 44,
                source: Buffer.from(
                    [
                        'From: Sender <sender@example.com>',
                        `To: Robot <${MAILBOX}>`,
                        'Subject: Status',
                        'Content-Type: multipart/mixed; boundary=mail-boundary',
                        '',
                        '--mail-boundary',
                        'Content-Type: text/plain; charset=utf-8',
                        '',
                        'Everything is green.',
                        '--mail-boundary',
                        'Content-Type: application/pdf; name=report.pdf',
                        'Content-Disposition: attachment; filename=report.pdf',
                        'Content-Transfer-Encoding: base64',
                        'Content-ID: <report>',
                        '',
                        'YQ==',
                        '--mail-boundary--'
                    ].join('\r\n')
                )
            }
        });
        const service = new MailService({
            store: new InMemoryAtomicStore(),
            imapFactory: imap.factory,
            smtpFactory: smtpHarness().factory
        });

        const result = await service.getMessage(MAILBOX, TOKEN, { folder: 'INBOX', uid: 44 });

        expect(imap.fetchOne).toHaveBeenNthCalledWith(
            1,
            44,
            expect.objectContaining({ uid: true, envelope: true, size: true, bodyStructure: true }),
            { uid: true }
        );
        expect(imap.fetchOne).toHaveBeenNthCalledWith(2, 44, { source: true }, { uid: true });
        expect(result.message).toMatchObject({
            uid: 44,
            text: 'Everything is green.',
            html: null,
            bodyTruncated: false,
            hasAttachments: true,
            attachments: [
                {
                    filename: 'report.pdf',
                    contentType: 'application/pdf',
                    size: 1,
                    contentId: 'report'
                }
            ]
        });
        expect(result.message.attachments[0]).not.toHaveProperty('content');
        expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it('does not fetch raw source above the bounded message cap', async () => {
        const imap = imapHarness({
            fetchOne: {
                uid: 44,
                envelope: envelope(),
                internalDate: new Date('2026-07-23T12:00:00.000Z'),
                flags: new Set(),
                size: 5 * 1024 * 1024 + 1,
                bodyStructure: {
                    type: 'multipart/mixed',
                    childNodes: [
                        {
                            type: 'application/pdf',
                            disposition: 'attachment',
                            dispositionParameters: { filename: 'large.pdf' },
                            size: 5 * 1024 * 1024
                        }
                    ]
                }
            }
        });
        const service = new MailService({
            store: new InMemoryAtomicStore(),
            imapFactory: imap.factory,
            smtpFactory: smtpHarness().factory
        });

        const result = await service.getMessage(MAILBOX, TOKEN, { folder: 'INBOX', uid: 44 });

        expect(imap.fetchOne).toHaveBeenCalledTimes(1);
        expect(result.message).toMatchObject({
            bodyTruncated: true,
            text: null,
            html: null,
            attachments: [
                {
                    filename: 'large.pdf',
                    contentType: 'application/pdf',
                    size: 5 * 1024 * 1024,
                    contentId: null
                }
            ]
        });
    });
});

describe('SMTP dispatch and atomic idempotency', () => {
    const payload = {
        idempotencyKey: 'send-12345678',
        to: ['recipient@example.com'],
        subject: 'hello',
        text: 'body'
    };
    const bodyHash = createHash('sha256').update(JSON.stringify({ mailbox: MAILBOX, payload })).digest('hex');

    it('pins smtp.yandex.com:465 secure OAuth2 and returns the Message-ID', async () => {
        const smtp = smtpHarness();
        const store = new InMemoryAtomicStore();
        const service = new MailService({
            store,
            imapFactory: imapHarness().factory,
            smtpFactory: smtp.factory
        });

        const result = await service.sendMessage(MAILBOX, TOKEN, payload, bodyHash);

        expect(SMTP_ENDPOINT).toEqual({ host: 'smtp.yandex.com', port: 465, secure: true });
        expect(smtp.factory).toHaveBeenCalledWith(
            expect.objectContaining({
                host: 'smtp.yandex.com',
                port: 465,
                secure: true,
                pool: false,
                logger: false,
                debug: false,
                auth: { type: 'OAuth2', user: MAILBOX, accessToken: TOKEN }
            })
        );
        expect(smtp.sendMail).toHaveBeenCalledTimes(1);
        expect(smtp.sendMail).toHaveBeenCalledWith(
            expect.objectContaining({
                disableFileAccess: true,
                disableUrlAccess: true
            })
        );
        expect(result).toEqual({
            ok: true,
            outcome: 'confirmed',
            result: { mailbox: MAILBOX, messageId: '<message-123@yandex.ru>' }
        });
    });

    it('returns a cached confirmation for the same key and body without resending', async () => {
        const smtp = smtpHarness();
        const store = new InMemoryAtomicStore();
        const service = new MailService({
            store,
            imapFactory: imapHarness().factory,
            smtpFactory: smtp.factory
        });

        const first = await service.sendMessage(MAILBOX, TOKEN, payload, bodyHash);
        const second = await service.sendMessage(MAILBOX, TOKEN, payload, bodyHash);

        expect(first).toEqual(second);
        expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    });

    it('returns unknown after dispatch failure and never resends the same key/body', async () => {
        const smtp = smtpHarness({ error: new Error(`timeout after DATA ${TOKEN}`) });
        const store = new InMemoryAtomicStore();
        const service = new MailService({
            store,
            imapFactory: imapHarness().factory,
            smtpFactory: smtp.factory
        });

        const first = await service.sendMessage(MAILBOX, TOKEN, payload, bodyHash);
        const second = await service.sendMessage(MAILBOX, TOKEN, payload, bodyHash);

        expect(first).toEqual({
            ok: false,
            outcome: 'unknown',
            error: {
                code: 'smtp_outcome_unknown',
                message: 'SMTP dispatch may have completed; inspect the mailbox before retrying.',
                retryable: false
            }
        });
        expect(second).toEqual(first);
        expect(smtp.sendMail).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(first)).not.toContain(TOKEN);
    });

    it('returns unknown for an existing pending send without dispatching SMTP', async () => {
        const smtp = smtpHarness();
        const store = new InMemoryAtomicStore();
        await store.beginSend(`${MAILBOX}\0${payload.idempotencyKey}`, bodyHash, 60);
        const service = new MailService({
            store,
            imapFactory: imapHarness().factory,
            smtpFactory: smtp.factory
        });

        const result = await service.sendMessage(MAILBOX, TOKEN, payload, bodyHash);

        expect(result).toMatchObject({ ok: false, outcome: 'unknown', error: { code: 'smtp_outcome_unknown' } });
        expect(smtp.sendMail).not.toHaveBeenCalled();
    });

    it('rejects reuse of an idempotency key with a different body hash', async () => {
        const smtp = smtpHarness();
        const service = new MailService({
            store: new InMemoryAtomicStore(),
            imapFactory: imapHarness().factory,
            smtpFactory: smtp.factory
        });

        await service.sendMessage(MAILBOX, TOKEN, payload, bodyHash);
        const conflict = await service.sendMessage(
            MAILBOX,
            TOKEN,
            { ...payload, subject: 'different' },
            createHash('sha256').update('different-body').digest('hex')
        );

        expect(conflict).toEqual({
            ok: false,
            outcome: 'not_started',
            error: {
                code: 'idempotency_conflict',
                message: 'The idempotency key was already used for a different message.',
                retryable: false
            }
        });
        expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    });

    it('returns unknown instead of confirmed if the shared ledger cannot record confirmation', async () => {
        const smtp = smtpHarness();
        const base = new InMemoryAtomicStore();
        const store = {
            consumeNonce: base.consumeNonce.bind(base),
            beginSend: base.beginSend.bind(base),
            confirmSend: vi.fn().mockRejectedValue(new Error('redis unavailable')),
            markSendUnknown: base.markSendUnknown.bind(base)
        };
        const service = new MailService({
            store,
            imapFactory: imapHarness().factory,
            smtpFactory: smtp.factory
        });

        const result = await service.sendMessage(MAILBOX, TOKEN, payload, bodyHash);

        expect(result).toMatchObject({ ok: false, outcome: 'unknown', error: { code: 'smtp_outcome_unknown' } });
        expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    });
});
