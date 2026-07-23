import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import sendMessageAction from '../amocrm-chats-channel/actions/send-message.js';
import {
    AMOJO_ORIGINS,
    formatRfc2822Date,
    signAmoChatsRequest
} from '../amocrm-chats-channel/lib/signature.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHANNEL_SECRET = '0123456789abcdef0123456789abcdef01234567';
const FIXED_NOW = new Date('2025-07-23T12:34:56.000Z');
const SCOPE_ID = 'scope_abc-123';

const validInput = {
    msgid: 'msg-12345678',
    conversationId: 'conversation-1',
    receiver: {
        id: 'client-1',
        name: 'Client'
    },
    text: 'Hello',
    silent: false
};

function connection(overrides: Record<string, unknown> = {}) {
    return {
        credentials: {
            type: 'CUSTOM',
            raw: {
                channel_secret: CHANNEL_SECRET
            }
        },
        connection_config: {
            scope_id: SCOPE_ID,
            amojo_region: 'ru',
            sender_id: 'bot-1',
            sender_name: 'Support Bot',
            sender_ref_id: 'amo-bot-1'
        },
        ...overrides
    };
}

function providerResponse(overrides: Record<string, unknown> = {}) {
    return {
        new_message: {
            conversation_id: 'conversation-1',
            sender_id: 'bot-1',
            receiver_id: 'client-1',
            msgid: 'provider-message-1',
            ref_id: 'msg-12345678',
            ...overrides
        }
    };
}

function nangoMock(options: {
    connection?: unknown;
    metadata?: unknown;
    response?: unknown;
    postError?: unknown;
    setMetadataErrorAtCall?: number;
} = {}) {
    let metadata: unknown = options.metadata ?? {};
    let lockHeld = false;
    let setMetadataCalls = 0;
    const post = options.postError
        ? vi.fn().mockRejectedValue(options.postError)
        : vi.fn().mockResolvedValue({ data: options.response ?? providerResponse() });
    return {
        connectionId: 'amo-channel-connection-1',
        getConnection: vi.fn().mockResolvedValue(options.connection ?? connection()),
        getMetadata: vi.fn(async () => structuredClone(metadata)),
        updateMetadata: vi.fn(async (value: unknown) => {
            setMetadataCalls += 1;
            if (setMetadataCalls === options.setMetadataErrorAtCall) {
                throw new Error('shared metadata unavailable');
            }
            metadata = {
                ...(typeof metadata === 'object' && metadata !== null ? metadata : {}),
                ...(typeof value === 'object' && value !== null ? structuredClone(value) : {})
            };
            return {};
        }),
        tryAcquireLock: vi.fn(async () => {
            if (lockHeld) {
                return false;
            }
            lockHeld = true;
            return true;
        }),
        releaseLock: vi.fn(async () => {
            lockHeld = false;
            return true;
        }),
        post
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('current official amoCRM Chats signature contract', () => {
    it('formats Date as RFC2822 with a numeric UTC offset', () => {
        expect(formatRfc2822Date(FIXED_NOW)).toBe('Wed, 23 Jul 2025 12:34:56 +0000');
    });

    it('matches the fixed exact-body MD5 and HMAC-SHA1 fixture', () => {
        const body =
            '{"event_type":"new_message","payload":{"timestamp":1753274096,"msec_timestamp":1753274096000,"msgid":"msg-12345678","conversation_id":"conversation-1","sender":{"id":"bot-1","name":"Support Bot","ref_id":"amo-bot-1"},"receiver":{"id":"client-1","name":"Client"},"message":{"type":"text","text":"Hello"},"silent":false}}';

        const signed = signAmoChatsRequest({
            body,
            path: `/v2/origin/custom/${SCOPE_ID}`,
            secret: CHANNEL_SECRET,
            date: FIXED_NOW
        });

        expect(signed.contentMd5).toBe('2ee95f2d3a3a0c9340d52fde30339483');
        expect(signed.canonical).toBe(
            [
                'POST',
                '2ee95f2d3a3a0c9340d52fde30339483',
                'application/json',
                'Wed, 23 Jul 2025 12:34:56 +0000',
                '/v2/origin/custom/scope_abc-123'
            ].join('\n')
        );
        expect(signed.signature).toBe('195b88f4276fd34aa95588af40cc0acb3c6be88d');
        expect(signed.headers).toEqual({
            Date: 'Wed, 23 Jul 2025 12:34:56 +0000',
            'Content-Type': 'application/json',
            'Content-MD5': '2ee95f2d3a3a0c9340d52fde30339483',
            'X-Signature': '195b88f4276fd34aa95588af40cc0acb3c6be88d'
        });
    });
});

describe('action identity, boundary and schemas', () => {
    it('registers the integration/action identity through the root side-effect index', async () => {
        const index = await readFile(resolve(HERE, '../index.ts'), 'utf8');

        expect(index.match(/amocrm-chats-channel\/actions\/send-message\.js/g)).toHaveLength(1);
        expect(sendMessageAction.type).toBe('action');
        expect(sendMessageAction.version).toBe('1.0.0');
        expect(sendMessageAction.scopes).toEqual([]);
    });

    it('keeps function imports within the Nango compiler allowlist', async () => {
        const files = [
            '../amocrm-chats-channel/actions/send-message.ts',
            '../amocrm-chats-channel/lib/signature.ts'
        ];
        const allowed = new Set(['nango', 'zod', 'node:crypto']);

        for (const file of files) {
            const source = await readFile(resolve(HERE, file), 'utf8');
            for (const match of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
                const specifier = match[1]!;
                expect(specifier.startsWith('.') || allowed.has(specifier), `${file}: ${specifier}`).toBe(true);
            }
        }
    });

    it('documents that inbound raw-body webhook verification is not implemented', async () => {
        const readme = await readFile(resolve(HERE, '../amocrm-chats-channel/README.md'), 'utf8');

        expect(readme).toContain('Outbound only');
        expect(readme).toContain('Inbound webhooks are not implemented');
        expect(readme).toContain('raw request body');
    });

    it('accepts one bounded text message and applies a false silent default', () => {
        const parsed = sendMessageAction.input.safeParse({
            ...validInput,
            silent: undefined
        });

        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.silent).toBe(false);
        }
    });

    it.each(['x', 'ü', 'm'.repeat(255)])(
        'accepts provider message id %j consistently through the action output contract',
        (providerMessageId) => {
            const parsed = sendMessageAction.output.safeParse({
                ok: true,
                outcome: 'confirmed',
                result: {
                    conversationId: 'conversation-1',
                    senderId: 'bot-1',
                    receiverId: 'client-1',
                    msgid: providerMessageId,
                    refId: validInput.msgid
                }
            });

            expect(parsed.success).toBe(true);
        }
    );

    it.each([
        'scopeId',
        'scope_id',
        'channelSecret',
        'secret',
        'origin',
        'url',
        'providerConfigKey',
        'connectionId',
        'sender',
        'timestamp',
        'msecTimestamp',
        'eventType',
        'media'
    ])('rejects caller-controlled trust field %s', (field) => {
        expect(
            sendMessageAction.input.safeParse({
                ...validInput,
                [field]: 'attacker-controlled'
            }).success
        ).toBe(false);
    });

    it('rejects weak ids, nested receiver controls and oversized text', () => {
        expect(sendMessageAction.input.safeParse({ ...validInput, msgid: 'short' }).success).toBe(false);
        expect(
            sendMessageAction.input.safeParse({
                ...validInput,
                receiver: { ...validInput.receiver, avatar: 'https://attacker.example/avatar' }
            }).success
        ).toBe(false);
        expect(sendMessageAction.input.safeParse({ ...validInput, text: 'x'.repeat(32_769) }).success).toBe(false);
    });
});

describe('fixed internal connection and outbound transport', () => {
    it('serializes once, pins the ru origin/path and disables retries and redirect forwarding', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(FIXED_NOW);
        const nango = nangoMock();

        const result = await sendMessageAction.exec(nango as never, validInput);

        expect(result).toEqual({
            ok: true,
            outcome: 'confirmed',
            result: {
                conversationId: 'conversation-1',
                senderId: 'bot-1',
                receiverId: 'client-1',
                msgid: 'provider-message-1',
                refId: 'msg-12345678'
            }
        });
        expect(nango.getConnection).toHaveBeenCalledWith();
        expect(nango.post).toHaveBeenCalledTimes(1);
        const request = nango.post.mock.calls[0]![0] as Record<string, unknown>;
        expect(request).toEqual({
            endpoint: `/v2/origin/custom/${SCOPE_ID}`,
            baseUrlOverride: 'https://amojo.amocrm.ru',
            retries: 0,
            forwardHeadersOnRedirect: false,
            data:
                '{"event_type":"new_message","payload":{"timestamp":1753274096,"msec_timestamp":1753274096000,"msgid":"msg-12345678","conversation_id":"conversation-1","sender":{"id":"bot-1","name":"Support Bot","ref_id":"amo-bot-1"},"receiver":{"id":"client-1","name":"Client"},"message":{"type":"text","text":"Hello"},"silent":false}}',
            headers: {
                Date: 'Wed, 23 Jul 2025 12:34:56 +0000',
                'Content-Type': 'application/json',
                'Content-MD5': '2ee95f2d3a3a0c9340d52fde30339483',
                'X-Signature': '195b88f4276fd34aa95588af40cc0acb3c6be88d'
            }
        });
        expect(JSON.stringify(request)).not.toContain(CHANNEL_SECRET);
        expect(request).not.toHaveProperty('providerConfigKey');
        expect(request).not.toHaveProperty('connectionId');
        expect((request.headers as Record<string, string>).Authorization).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain('195b88f4');
    });

    it('selects only the code-owned .com origin for a com connection', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(FIXED_NOW);
        const nango = nangoMock({
            connection: connection({
                connection_config: {
                    scope_id: SCOPE_ID,
                    amojo_region: 'com',
                    sender_id: 'bot-1',
                    sender_name: 'Support Bot',
                    sender_ref_id: 'amo-bot-1'
                }
            })
        });

        await sendMessageAction.exec(nango as never, validInput);

        expect(AMOJO_ORIGINS).toEqual({
            ru: 'https://amojo.amocrm.ru',
            com: 'https://amojo.amocrm.com'
        });
        expect(nango.post.mock.calls[0]![0]).toMatchObject({
            baseUrlOverride: 'https://amojo.amocrm.com'
        });
    });

    it.each([
        [
            'OAuth credentials',
            connection({
                credentials: { type: 'OAUTH2', access_token: CHANNEL_SECRET }
            })
        ],
        [
            'missing channel secret',
            connection({
                credentials: { type: 'CUSTOM', raw: {} }
            })
        ],
        [
            'path-injected scope',
            connection({
                connection_config: {
                    scope_id: '../attacker',
                    amojo_region: 'ru',
                    sender_id: 'bot-1',
                    sender_name: 'Support Bot',
                    sender_ref_id: 'amo-bot-1'
                }
            })
        ],
        [
            'URL-like region',
            connection({
                connection_config: {
                    scope_id: SCOPE_ID,
                    amojo_region: 'https://attacker.example',
                    sender_id: 'bot-1',
                    sender_name: 'Support Bot',
                    sender_ref_id: 'amo-bot-1'
                }
            })
        ],
        [
            'missing sender identity',
            connection({
                connection_config: {
                    scope_id: SCOPE_ID,
                    amojo_region: 'ru'
                }
            })
        ]
    ])('fails safely before dispatch for %s', async (_name, badConnection) => {
        const nango = nangoMock({ connection: badConnection });

        const result = await sendMessageAction.exec(nango as never, validInput);

        expect(result).toMatchObject({
            ok: false,
            outcome: 'not_started',
            error: { code: 'amocrm_channel_connection_invalid', retryable: false }
        });
        expect(JSON.stringify(result)).not.toContain(CHANNEL_SECRET);
        expect(nango.post).not.toHaveBeenCalled();
    });

    it('returns unknown for mutation transport failure without exposing the cause', async () => {
        const nango = nangoMock({
            postError: new Error(`network failure ${CHANNEL_SECRET}`)
        });

        const result = await sendMessageAction.exec(nango as never, validInput);

        expect(result).toEqual({
            ok: false,
            outcome: 'unknown',
            error: {
                code: 'amocrm_chats_outcome_unknown',
                message: 'The message may have reached amoCRM; inspect the chat before retrying.',
                retryable: false
            }
        });
        expect(JSON.stringify(result)).not.toContain(CHANNEL_SECRET);
    });

    it.each([400, 403])('returns a safe confirmed failure for documented provider status %i', async (status) => {
        const nango = nangoMock({
            postError: {
                response: {
                    status,
                    data: { raw_provider_error: CHANNEL_SECRET }
                }
            }
        });

        const result = await sendMessageAction.exec(nango as never, validInput);

        expect(result).toEqual({
            ok: false,
            outcome: 'confirmed_failed',
            error: {
                code: 'amocrm_chats_rejected',
                message: 'amoCRM rejected the signed message request.',
                retryable: false
            }
        });
        expect(JSON.stringify(result)).not.toContain(CHANNEL_SECRET);
    });

    it('keeps a provider 500 response unknown', async () => {
        const nango = nangoMock({
            postError: {
                response: {
                    status: 500,
                    data: providerResponse()
                }
            }
        });

        const result = await sendMessageAction.exec(nango as never, validInput);

        expect(result).toMatchObject({
            ok: false,
            outcome: 'unknown',
            error: { code: 'amocrm_chats_outcome_unknown' }
        });
    });

    it.each([
        { response: { debug: CHANNEL_SECRET } },
        { response: providerResponse({ ref_id: 'different-msgid' }) },
        { response: providerResponse({ unexpected: 'field' }) }
    ])('keeps invalid or mismatched success response unknown', async ({ response }) => {
        const nango = nangoMock({ response });

        const result = await sendMessageAction.exec(nango as never, validInput);

        expect(result).toMatchObject({
            ok: false,
            outcome: 'unknown',
            error: { code: 'amocrm_chats_response_invalid' }
        });
        expect(JSON.stringify(result)).not.toContain(CHANNEL_SECRET);
    });
});

describe('shared amoCRM send idempotency ledger', () => {
    it('returns the cached confirmed result without a second dispatch', async () => {
        const nango = nangoMock();

        const first = await sendMessageAction.exec(nango as never, validInput);
        const second = await sendMessageAction.exec(nango as never, validInput);

        expect(first).toEqual(second);
        expect(first).toMatchObject({ ok: true, outcome: 'confirmed' });
        expect(nango.post).toHaveBeenCalledTimes(1);
    });

    it.each(['__proto__', 'constructor', 'toString'])(
        'treats prototype-like msgid %s as an ordinary idempotency key',
        async (msgid) => {
            const nango = nangoMock({
                response: providerResponse({ ref_id: msgid })
            });
            const input = { ...validInput, msgid };

            const first = await sendMessageAction.exec(nango as never, input);
            const second = await sendMessageAction.exec(nango as never, input);

            expect(first).toEqual(second);
            expect(first).toMatchObject({ ok: true, outcome: 'confirmed' });
            expect(nango.post).toHaveBeenCalledTimes(1);
        }
    );

    it('rejects reuse of one msgid for a different message body', async () => {
        const nango = nangoMock();

        await sendMessageAction.exec(nango as never, validInput);
        const result = await sendMessageAction.exec(nango as never, {
            ...validInput,
            text: 'Different text'
        });

        expect(result).toMatchObject({
            ok: false,
            outcome: 'not_started',
            error: { code: 'amocrm_chats_idempotency_conflict' }
        });
        expect(nango.post).toHaveBeenCalledTimes(1);
    });

    it('keeps an unknown dispatch sticky across a sequential retry', async () => {
        const nango = nangoMock({
            postError: new Error('connection reset after dispatch')
        });

        const first = await sendMessageAction.exec(nango as never, validInput);
        nango.post.mockResolvedValue({ data: providerResponse() });
        const second = await sendMessageAction.exec(nango as never, validInput);

        expect(first).toMatchObject({ ok: false, outcome: 'unknown' });
        expect(second).toMatchObject({
            ok: false,
            outcome: 'unknown',
            error: { code: 'amocrm_chats_outcome_unknown' }
        });
        expect(nango.post).toHaveBeenCalledTimes(1);
    });

    it('dispatches only once for concurrent calls with the same msgid', async () => {
        let releaseProvider!: (value: { data: unknown }) => void;
        const providerPending = new Promise<{ data: unknown }>((resolvePromise) => {
            releaseProvider = resolvePromise;
        });
        const nango = nangoMock();
        nango.post.mockImplementationOnce(() => providerPending);

        const firstPending = sendMessageAction.exec(nango as never, validInput);
        await vi.waitFor(() => expect(nango.post).toHaveBeenCalledTimes(1));
        const concurrent = await sendMessageAction.exec(nango as never, validInput);
        releaseProvider({ data: providerResponse() });
        const first = await firstPending;

        expect(first).toMatchObject({ ok: true, outcome: 'confirmed' });
        expect(concurrent).toMatchObject({
            ok: false,
            outcome: 'unknown',
            error: { code: 'amocrm_chats_outcome_unknown' }
        });
        expect(nango.post).toHaveBeenCalledTimes(1);
    });

    it('makes a failed post-dispatch ledger transition sticky unknown', async () => {
        const nango = nangoMock({ setMetadataErrorAtCall: 2 });

        const first = await sendMessageAction.exec(nango as never, validInput);
        const second = await sendMessageAction.exec(nango as never, validInput);

        expect(first).toMatchObject({ ok: false, outcome: 'unknown' });
        expect(second).toMatchObject({ ok: false, outcome: 'unknown' });
        expect(nango.post).toHaveBeenCalledTimes(1);
    });
});
