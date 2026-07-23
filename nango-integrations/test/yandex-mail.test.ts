import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import getMessageAction from '../yandex-mail/actions/get-message.js';
import listMessagesAction from '../yandex-mail/actions/list-messages.js';
import resolveMailboxAction from '../yandex-mail/actions/resolve-mailbox.js';
import sendMessageAction from '../yandex-mail/actions/send-message.js';
import {
    BRIDGE_PATHS,
    buildSignedBridgeRequest,
    getMessageInputSchema,
    listMessagesInputSchema,
    sendMessageInputSchema
} from '../yandex-mail/lib/bridge.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = '0123456789abcdef0123456789abcdef';
const MAILBOX = 'robot@custom-domain.example';

function connection(overrides: Record<string, unknown> = {}) {
    return {
        credentials: {
            type: 'OAUTH2',
            access_token: 'oauth-access-token-that-must-not-leak'
        },
        connection_config: {
            mailbox: MAILBOX
        },
        ...overrides
    };
}

function runtime(overrides: Record<string, string> = {}) {
    return [
        { name: 'MAIL_BRIDGE_ORIGIN', value: 'https://mail-bridge.example' },
        { name: 'MAIL_BRIDGE_HMAC_SECRET', value: SECRET },
        ...Object.entries(overrides).map(([name, value]) => ({ name, value }))
    ];
}

function nangoMock(options: {
    connection?: unknown;
    environment?: unknown;
    response?: unknown;
    postError?: unknown;
} = {}) {
    const post = options.postError
        ? vi.fn().mockRejectedValue(options.postError)
        : vi.fn().mockResolvedValue({
              data:
                  options.response ??
                  ({
                      ok: true,
                      outcome: 'confirmed',
                      result: { mailbox: MAILBOX }
                  } as const)
          });
    return {
        getConnection: vi.fn().mockResolvedValue(options.connection ?? connection()),
        getEnvironmentVariables: vi.fn().mockResolvedValue(options.environment ?? runtime()),
        post
    };
}

describe('Nango action identity and compiler-safe imports', () => {
    it('uses the pinned Nango toolchain and Node floor', async () => {
        const pkg = JSON.parse(await readFile(resolve(HERE, '../package.json'), 'utf8')) as {
            dependencies: Record<string, string>;
            engines: Record<string, string>;
        };

        expect(pkg.dependencies).toMatchObject({ nango: '0.71.2', zod: '4.3.6' });
        expect(pkg.engines.node).toBe('>=22.22.2');
    });

    it('side-effect imports every action with directory/basename identity', async () => {
        const index = await readFile(resolve(HERE, '../index.ts'), 'utf8');

        expect(index).toBe(
            [
                "import './yandex-mail/actions/resolve-mailbox.js';",
                "import './yandex-mail/actions/list-messages.js';",
                "import './yandex-mail/actions/get-message.js';",
                "import './yandex-mail/actions/send-message.js';",
                ''
            ].join('\n')
        );
        expect(resolveMailboxAction.type).toBe('action');
        expect(listMessagesAction.type).toBe('action');
        expect(getMessageAction.type).toBe('action');
        expect(sendMessageAction.type).toBe('action');
        for (const action of [resolveMailboxAction, listMessagesAction, getMessageAction, sendMessageAction]) {
            expect(action.version).toBe('1.0.0');
        }
        expect(resolveMailboxAction.scopes).toEqual(['mail:imap_full']);
        expect(listMessagesAction.scopes).toEqual(['mail:imap_full']);
        expect(getMessageAction.scopes).toEqual(['mail:imap_full']);
        expect(sendMessageAction.scopes).toEqual(['mail:smtp']);
    });

    it('keeps runtime action imports inside the Nango compiler allowlist', async () => {
        const files = [
            '../yandex-mail/actions/resolve-mailbox.ts',
            '../yandex-mail/actions/list-messages.ts',
            '../yandex-mail/actions/get-message.ts',
            '../yandex-mail/actions/send-message.ts',
            '../yandex-mail/lib/bridge.ts'
        ];
        const allowed = new Set(['nango', 'zod', 'node:crypto', 'node:url']);

        for (const file of files) {
            const source = await readFile(resolve(HERE, file), 'utf8');
            for (const match of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
                const specifier = match[1]!;
                expect(specifier.startsWith('.') || allowed.has(specifier), `${file}: ${specifier}`).toBe(true);
            }
        }
    });
});

describe('bounded strict inputs', () => {
    it.each(['bridgeUrl', 'bridgeOrigin', 'mailbox', 'login', 'connectionId', 'providerConfigKey', 'accessToken', 'credentials'])(
        'rejects forbidden field %s from every operation shape',
        (field) => {
            expect(listMessagesInputSchema.safeParse({ limit: 5, [field]: 'attacker-controlled' }).success).toBe(false);
            expect(getMessageInputSchema.safeParse({ uid: 1, [field]: 'attacker-controlled' }).success).toBe(false);
            expect(
                sendMessageInputSchema.safeParse({
                    idempotencyKey: 'send-12345678',
                    to: ['recipient@example.com'],
                    subject: 'hello',
                    text: 'body',
                    [field]: 'attacker-controlled'
                }).success
            ).toBe(false);
        }
    );

    it('bounds list, get, recipients, bodies and inline attachments', () => {
        expect(listMessagesInputSchema.safeParse({ limit: 101 }).success).toBe(false);
        expect(getMessageInputSchema.safeParse({ uid: 0 }).success).toBe(false);
        expect(
            sendMessageInputSchema.safeParse({
                idempotencyKey: 'send-12345678',
                to: [],
                subject: 'hello',
                text: 'body'
            }).success
        ).toBe(false);
        expect(
            sendMessageInputSchema.safeParse({
                idempotencyKey: 'send-12345678',
                to: ['recipient@example.com'],
                subject: 'hello',
                text: 'body',
                attachments: [
                    {
                        filename: 'one.bin',
                        contentType: 'application/octet-stream',
                        contentBase64: Buffer.alloc(600_000).toString('base64')
                    },
                    {
                        filename: 'two.bin',
                        contentType: 'application/octet-stream',
                        contentBase64: Buffer.alloc(600_000).toString('base64')
                    }
                ]
            }).success
        ).toBe(false);
        expect(
            sendMessageInputSchema.safeParse({
                idempotencyKey: 'send-12345678',
                to: ['recipient@example.com'],
                subject: 'hello',
                text: 'body',
                attachments: [
                    {
                        filename: 'not-canonical.bin',
                        contentType: 'application/octet-stream',
                        contentBase64: 'YR=='
                    }
                ]
            }).success
        ).toBe(false);
        expect(
            sendMessageInputSchema.safeParse({
                idempotencyKey: 'send-12345678',
                to: ['recipient@example.com'],
                subject: 'hello',
                text: 'x'.repeat(262_145)
            }).success
        ).toBe(false);
        expect(
            sendMessageInputSchema.safeParse({
                idempotencyKey: 'send-12345678',
                to: ['recipient@example.com'],
                subject: 'hello',
                attachments: Array.from({ length: 11 }, (_, index) => ({
                    filename: `file-${index}.txt`,
                    contentType: 'text/plain',
                    contentBase64: 'YQ=='
                }))
            }).success
        ).toBe(false);
    });
});

describe('bridge signing and fixed transport', () => {
    it('matches the exact canonical HMAC fixture', () => {
        const body = '{"mailbox":"robot@custom-domain.example","payload":{"limit":5}}';
        const signed = buildSignedBridgeRequest({
            path: BRIDGE_PATHS.listMessages,
            body,
            secret: SECRET,
            timestampSeconds: 1_750_000_000,
            nonce: '00112233445566778899aabbccddeeff'
        });
        const digest = createHash('sha256').update(body).digest('hex');
        const canonical = [
            'v1',
            'POST',
            '/v1/yandex-mail/list-messages',
            '1750000000',
            '00112233445566778899aabbccddeeff',
            digest
        ].join('\n');

        expect(signed.canonical).toBe(canonical);
        expect(signed.headers).toEqual({
            'Content-Type': 'application/json',
            'X-Mail-Bridge-Body-SHA256': digest,
            'X-Mail-Bridge-Nonce': '00112233445566778899aabbccddeeff',
            'X-Mail-Bridge-Signature': createHmac('sha256', SECRET).update(canonical).digest('hex'),
            'X-Mail-Bridge-Timestamp': '1750000000',
            'X-Mail-Bridge-Version': 'v1'
        });
    });

    it('uses connection mailbox and one exact Nango post without exposing credentials', async () => {
        const nango = nangoMock({
            response: {
                ok: true,
                outcome: 'confirmed',
                result: { mailbox: MAILBOX, messages: [], nextCursor: null }
            }
        });

        const result = await listMessagesAction.exec(nango as never, {
            folder: 'INBOX',
            limit: 5,
            unseenOnly: false
        });

        expect(result).toEqual({
            ok: true,
            outcome: 'confirmed',
            result: { mailbox: MAILBOX, messages: [], nextCursor: null }
        });
        expect(nango.getConnection).toHaveBeenCalledWith();
        expect(nango.getEnvironmentVariables).toHaveBeenCalledWith();
        expect(nango.post).toHaveBeenCalledTimes(1);
        const request = nango.post.mock.calls[0]![0] as Record<string, unknown>;
        expect(request).toMatchObject({
            endpoint: BRIDGE_PATHS.listMessages,
            baseUrlOverride: 'https://mail-bridge.example',
            retries: 0,
            forwardHeadersOnRedirect: false,
            data: `{"mailbox":"${MAILBOX}","payload":{"folder":"INBOX","limit":5,"unseenOnly":false}}`
        });
        expect(request).not.toHaveProperty('providerConfigKey');
        expect(request).not.toHaveProperty('connectionId');
        expect(JSON.stringify(request)).not.toContain('oauth-access-token');
        expect((request.headers as Record<string, string>).Authorization).toBeUndefined();
    });

    it.each([
        ['http origin', runtime({ MAIL_BRIDGE_ORIGIN: 'http://mail-bridge.example' })],
        ['origin path', runtime({ MAIL_BRIDGE_ORIGIN: 'https://mail-bridge.example/api' })],
        ['origin credentials', runtime({ MAIL_BRIDGE_ORIGIN: 'https://user:pass@mail-bridge.example' })],
        ['short secret', runtime({ MAIL_BRIDGE_HMAC_SECRET: 'too-short' })],
        [
            'duplicate variables',
            [
                ...runtime(),
                { name: 'MAIL_BRIDGE_ORIGIN', value: 'https://other-mail-bridge.example' }
            ]
        ],
        ['missing variables', []]
    ])('returns a safe not_started error for %s', async (_name, environment) => {
        const nango = nangoMock({ environment });

        const result = await resolveMailboxAction.exec(nango as never, {});
        const serialized = JSON.stringify(result);

        expect(result).toMatchObject({
            ok: false,
            outcome: 'not_started',
            error: { code: 'mail_bridge_configuration_invalid', retryable: false }
        });
        expect(serialized).not.toContain(SECRET);
        expect(serialized).not.toContain('oauth-access-token');
        expect(nango.post).not.toHaveBeenCalled();
    });

    it.each([
        ['non OAuth2', connection({ credentials: { type: 'API_KEY', apiKey: 'secret-api-key' } })],
        ['missing mailbox', connection({ connection_config: {} })],
        ['partial mailbox', connection({ connection_config: { mailbox: 'robot' } })]
    ])('returns a safe connection error for %s', async (_name, badConnection) => {
        const nango = nangoMock({ connection: badConnection });

        const result = await resolveMailboxAction.exec(nango as never, {});

        expect(result).toMatchObject({
            ok: false,
            outcome: 'not_started',
            error: { code: 'mail_connection_invalid', retryable: false }
        });
        expect(JSON.stringify(result)).not.toContain('secret-api-key');
        expect(nango.post).not.toHaveBeenCalled();
    });

    it('treats a send transport failure conservatively as unknown', async () => {
        const nango = nangoMock({ postError: new Error(`network failed ${SECRET} oauth-access-token`) });

        const result = await sendMessageAction.exec(nango as never, {
            idempotencyKey: 'send-12345678',
            to: ['recipient@example.com'],
            subject: 'hello',
            text: 'body'
        });

        expect(result).toEqual({
            ok: false,
            outcome: 'unknown',
            error: {
                code: 'mail_bridge_outcome_unknown',
                message: 'The bridge call may have reached the mail provider; inspect delivery state before retrying.',
                retryable: false
            }
        });
        expect(JSON.stringify(result)).not.toContain(SECRET);
        expect(JSON.stringify(result)).not.toContain('oauth-access-token');
    });

    it('preserves an exact safe bridge envelope from an Axios non-2xx response', async () => {
        const bridgeFailure = {
            ok: false,
            outcome: 'not_started',
            error: {
                code: 'idempotency_conflict',
                message: 'The idempotency key was already used for a different message.',
                retryable: false
            }
        } as const;
        const nango = nangoMock({
            postError: {
                response: {
                    status: 409,
                    data: bridgeFailure
                }
            }
        });

        const result = await sendMessageAction.exec(nango as never, {
            idempotencyKey: 'send-12345678',
            to: ['recipient@example.com'],
            subject: 'hello',
            text: 'body'
        });

        expect(result).toEqual(bridgeFailure);
    });

    it('does not trust a lookalike non-2xx error envelope with extra fields', async () => {
        const nango = nangoMock({
            postError: {
                response: {
                    status: 409,
                    data: {
                        ok: false,
                        outcome: 'not_started',
                        error: {
                            code: 'idempotency_conflict',
                            message: 'conflict',
                            retryable: false,
                            secret: SECRET
                        }
                    }
                }
            }
        });

        const result = await sendMessageAction.exec(nango as never, {
            idempotencyKey: 'send-12345678',
            to: ['recipient@example.com'],
            subject: 'hello',
            text: 'body'
        });

        expect(result).toMatchObject({ ok: false, outcome: 'unknown', error: { code: 'mail_bridge_outcome_unknown' } });
        expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it('uses confirmed_failed after a read bridge dispatch fails', async () => {
        const nango = nangoMock({ postError: new Error(`network failed ${SECRET}`) });

        const result = await listMessagesAction.exec(nango as never, {
            folder: 'INBOX',
            limit: 5,
            unseenOnly: false
        });

        expect(result).toEqual({
            ok: false,
            outcome: 'confirmed_failed',
            error: {
                code: 'mail_bridge_request_failed',
                message: 'The bridge request could not be completed.',
                retryable: true
            }
        });
    });

    it('preserves a safe bridge-provided confirmed_failed envelope', async () => {
        const bridgeFailure = {
            ok: false,
            outcome: 'confirmed_failed',
            error: {
                code: 'imap_authentication_failed',
                message: 'Yandex Mail rejected the current OAuth credential.',
                retryable: false
            }
        } as const;
        const nango = nangoMock({ response: bridgeFailure });

        const result = await resolveMailboxAction.exec(nango as never, {});

        expect(result).toEqual(bridgeFailure);
    });
});
