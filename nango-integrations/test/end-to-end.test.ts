import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpsRequest, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { InMemoryAtomicStore } from '../../mail-bridge/src/auth.js';
import { MailService } from '../../mail-bridge/src/mail.js';
import { createBridgeHandler } from '../../mail-bridge/src/server.js';
import amoSendMessageAction from '../amocrm-chats-channel/actions/send-message.js';
import yandexSendMessageAction from '../yandex-mail/actions/send-message.js';

// These are local contract integrations: they use real TLS sockets and production
// Action/bridge code, while Nango transport, SMTP and provider responses stay local.
const TLS_KEY = readFileSync(new URL('./fixtures/localhost-test-key.pem', import.meta.url));
const TLS_CERT = readFileSync(new URL('./fixtures/localhost-test-cert.pem', import.meta.url));
const BRIDGE_SECRET = '0123456789abcdef0123456789abcdef';
const YANDEX_TOKEN = 'yandex-oauth-token-never-returned';
const MAILBOX = 'robot@custom-domain.example';
const CHANNEL_SECRET = '0123456789abcdef0123456789abcdef01234567';
const SCOPE_ID = 'scope_abc-123';

type WireRequest = {
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
};

type WireResponse = {
    status: number;
    body: unknown;
};

type NangoPostConfig = {
    endpoint: string;
    baseUrlOverride: string;
    retries: number;
    forwardHeadersOnRedirect: boolean;
    data: string;
    headers: Record<string, string>;
};

async function startLocalHttps(
    respond: (request: WireRequest) => Promise<WireResponse> | WireResponse
): Promise<{
    origin: string;
    requests: WireRequest[];
    errors: unknown[];
    close(): Promise<void>;
}> {
    const requests: WireRequest[] = [];
    const errors: unknown[] = [];
    const server: Server = createServer({ key: TLS_KEY, cert: TLS_CERT }, async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const value of request) {
            chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array));
        }
        const captured: WireRequest = {
            method: request.method ?? '',
            path: request.url ?? '',
            headers: request.headers,
            body: Buffer.concat(chunks)
        };
        requests.push(captured);
        try {
            const result = await respond(captured);
            response.writeHead(result.status, { 'content-type': 'application/json' });
            response.end(JSON.stringify(result.body));
        } catch (error) {
            errors.push(error);
            response.writeHead(500, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: false, error: { code: 'local_test_server_failed' } }));
        }
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;

    return {
        origin: `https://127.0.0.1:${address.port}`,
        requests,
        errors,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            })
    };
}

async function postOverLocalTls(
    origin: string,
    config: NangoPostConfig,
    injectedHeaders: Record<string, string> = {}
): Promise<{ status: number; data: unknown }> {
    const body = Buffer.from(config.data, 'utf8');
    const target = new URL(config.endpoint, origin);
    return new Promise((resolve, reject) => {
        const request = httpsRequest(
            target,
            {
                method: 'POST',
                ca: TLS_CERT,
                rejectUnauthorized: true,
                agent: false,
                headers: {
                    ...config.headers,
                    ...injectedHeaders,
                    'Content-Length': String(body.byteLength)
                }
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on('data', (chunk: Buffer) => chunks.push(chunk));
                response.on('end', () => {
                    try {
                        resolve({
                            status: response.statusCode ?? 0,
                            data: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
                        });
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        );
        request.once('error', reject);
        request.end(body);
    });
}

async function nangoPostOverLocalTls(
    origin: string,
    config: NangoPostConfig,
    injectedHeaders: Record<string, string> = {}
): Promise<{ data: unknown }> {
    const response = await postOverLocalTls(origin, config, injectedHeaders);
    if (response.status >= 200 && response.status <= 299) {
        return { data: response.data };
    }
    throw { response };
}

function header(request: WireRequest, name: string): string {
    const value = request.headers[name.toLowerCase()];
    if (typeof value !== 'string') {
        throw new TypeError(`Expected one ${name} header`);
    }
    return value;
}

function createAmoRuntime(post: (config: NangoPostConfig) => Promise<{ data: unknown }>) {
    let metadata: Record<string, unknown> = {};
    let lockHeld = false;
    const metadataWrites: Array<Record<string, unknown>> = [];
    const updateMetadata = vi.fn(async (value: Record<string, unknown>) => {
        const snapshot = structuredClone(value);
        metadataWrites.push(snapshot);
        metadata = { ...metadata, ...snapshot };
        return {};
    });

    return {
        metadataWrites,
        runtime: {
            connectionId: 'amo-channel-connection-1',
            getConnection: vi.fn().mockResolvedValue({
                credentials: {
                    type: 'CUSTOM',
                    raw: { channel_secret: CHANNEL_SECRET }
                },
                connection_config: {
                    scope_id: SCOPE_ID,
                    amojo_region: 'ru',
                    sender_id: 'bot-1',
                    sender_name: 'Support Bot',
                    sender_ref_id: 'amo-bot-1'
                }
            }),
            getMetadata: vi.fn(async () => structuredClone(metadata)),
            updateMetadata,
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
            post: vi.fn(post)
        }
    };
}

describe('saved localhost HTTPS acceptance', () => {
    it('runs Yandex Action -> TLS -> bridge handler -> MailService with replay and send idempotency', async () => {
        const store = new InMemoryAtomicStore();
        const sendMail = vi.fn().mockResolvedValue({ messageId: '<wire-message@yandex.ru>' });
        const smtpFactory = vi.fn().mockReturnValue({ sendMail, close: vi.fn() });
        const mail = new MailService({
            store,
            imapFactory: vi.fn(() => {
                throw new Error('IMAP is outside this send acceptance');
            }),
            smtpFactory
        });
        const handler = createBridgeHandler({ secret: BRIDGE_SECRET, store, mail });
        const local = await startLocalHttps(async (request) => {
            const response = await handler({
                method: request.method,
                path: request.path,
                headers: request.headers,
                body: request.body
            });
            return response;
        });

        try {
            const post = vi.fn((config: NangoPostConfig) =>
                nangoPostOverLocalTls(local.origin, config, {
                    Authorization: `Bearer ${YANDEX_TOKEN}`
                })
            );
            const nango = {
                getConnection: vi.fn().mockResolvedValue({
                    credentials: { type: 'OAUTH2', access_token: YANDEX_TOKEN },
                    connection_config: { mailbox: MAILBOX }
                }),
                getEnvironmentVariables: vi.fn().mockResolvedValue([
                    { name: 'MAIL_BRIDGE_ORIGIN', value: local.origin },
                    { name: 'MAIL_BRIDGE_HMAC_SECRET', value: BRIDGE_SECRET }
                ]),
                post
            };
            const payload = {
                idempotencyKey: 'wire-send-12345678',
                to: ['recipient@example.com'],
                subject: 'TLS acceptance',
                text: 'Exact body over localhost TLS'
            };
            const before = Math.floor(Date.now() / 1000);
            const first = await yandexSendMessageAction.exec(nango as never, payload);
            const after = Math.floor(Date.now() / 1000);

            expect(first).toEqual({
                ok: true,
                outcome: 'confirmed',
                result: { mailbox: MAILBOX, messageId: '<wire-message@yandex.ru>' }
            });
            expect(yandexSendMessageAction.output.safeParse(first).success).toBe(true);
            expect(post).toHaveBeenCalledTimes(1);
            const firstConfig = structuredClone(post.mock.calls[0]![0]);
            const firstWire = local.requests[0]!;
            const digest = createHash('sha256').update(firstWire.body).digest('hex');
            const timestamp = Number(header(firstWire, 'x-mail-bridge-timestamp'));
            const nonce = header(firstWire, 'x-mail-bridge-nonce');
            const canonical = ['v1', 'POST', firstWire.path, String(timestamp), nonce, digest].join('\n');

            expect(firstConfig).toMatchObject({
                endpoint: '/v1/yandex-mail/send-message',
                baseUrlOverride: local.origin,
                retries: 0,
                forwardHeadersOnRedirect: false
            });
            expect(firstConfig.headers).not.toHaveProperty('Authorization');
            expect(firstWire.method).toBe('POST');
            expect(firstWire.path).toBe('/v1/yandex-mail/send-message');
            expect(firstWire.body.equals(Buffer.from(firstConfig.data, 'utf8'))).toBe(true);
            expect(header(firstWire, 'authorization')).toBe(`Bearer ${YANDEX_TOKEN}`);
            expect(header(firstWire, 'x-mail-bridge-body-sha256')).toBe(digest);
            expect(nonce).toMatch(/^[a-f0-9]{32}$/);
            expect(timestamp).toBeGreaterThanOrEqual(before);
            expect(timestamp).toBeLessThanOrEqual(after);
            expect(header(firstWire, 'x-mail-bridge-signature')).toBe(
                createHmac('sha256', BRIDGE_SECRET).update(canonical).digest('hex')
            );

            await expect(post(firstConfig)).rejects.toMatchObject({
                response: {
                    status: 409,
                    data: {
                        ok: false,
                        outcome: 'not_started',
                        error: { code: 'request_replayed' }
                    }
                }
            });
            const cached = await yandexSendMessageAction.exec(nango as never, payload);
            const conflict = await yandexSendMessageAction.exec(nango as never, {
                ...payload,
                subject: 'Different body, same idempotency key'
            });

            expect(cached).toEqual(first);
            expect(conflict).toMatchObject({
                ok: false,
                outcome: 'not_started',
                error: { code: 'idempotency_conflict', retryable: false }
            });
            expect(yandexSendMessageAction.output.safeParse(conflict).success).toBe(true);
            expect(sendMail).toHaveBeenCalledTimes(1);
            expect(local.requests).toHaveLength(4);
            expect(local.errors).toEqual([]);
            expect(JSON.stringify([first, cached, conflict])).not.toContain(YANDEX_TOKEN);
            expect(JSON.stringify([first, cached, conflict])).not.toContain(BRIDGE_SECRET);
        } finally {
            await local.close();
        }
    });

    it('runs amoCRM Action over TLS and proves exact signing plus sticky delivery outcomes', async () => {
        let providerStatus = 200;
        const local = await startLocalHttps((request) => {
            if (providerStatus !== 200) {
                return {
                    status: providerStatus,
                    body: { error: `provider detail containing ${CHANNEL_SECRET}` }
                };
            }
            const decoded = JSON.parse(request.body.toString('utf8')) as {
                payload: {
                    conversation_id: string;
                    sender: { id: string };
                    receiver: { id: string };
                    msgid: string;
                };
            };
            return {
                status: 200,
                body: {
                    new_message: {
                        conversation_id: decoded.payload.conversation_id,
                        sender_id: decoded.payload.sender.id,
                        receiver_id: decoded.payload.receiver.id,
                        msgid: 'provider-wire-message-1',
                        ref_id: decoded.payload.msgid
                    }
                }
            };
        });

        try {
            const postedConfigs: NangoPostConfig[] = [];
            const post = async (config: NangoPostConfig) => {
                postedConfigs.push(structuredClone(config));
                return nangoPostOverLocalTls(local.origin, config);
            };
            const amo = createAmoRuntime(post);
            const input = {
                msgid: 'wire-msg-12345678',
                conversationId: 'conversation-1',
                receiver: { id: 'client-1', name: 'Client' },
                text: 'Signed over localhost TLS',
                silent: false
            };
            const before = Date.now();
            const first = await amoSendMessageAction.exec(amo.runtime as never, input);
            const after = Date.now();
            const cached = await amoSendMessageAction.exec(amo.runtime as never, input);
            const conflict = await amoSendMessageAction.exec(amo.runtime as never, {
                ...input,
                text: 'Different body, same msgid'
            });

            expect(first).toEqual({
                ok: true,
                outcome: 'confirmed',
                result: {
                    conversationId: 'conversation-1',
                    senderId: 'bot-1',
                    receiverId: 'client-1',
                    msgid: 'provider-wire-message-1',
                    refId: 'wire-msg-12345678'
                }
            });
            expect(amoSendMessageAction.output.safeParse(first).success).toBe(true);
            expect(cached).toEqual(first);
            expect(conflict).toMatchObject({
                ok: false,
                outcome: 'not_started',
                error: { code: 'amocrm_chats_idempotency_conflict', retryable: false }
            });
            expect(amoSendMessageAction.output.safeParse(conflict).success).toBe(true);
            expect(amo.runtime.post).toHaveBeenCalledTimes(1);
            expect(postedConfigs).toHaveLength(1);
            expect(postedConfigs[0]).toMatchObject({
                endpoint: `/v2/origin/custom/${SCOPE_ID}`,
                baseUrlOverride: 'https://amojo.amocrm.ru',
                retries: 0,
                forwardHeadersOnRedirect: false
            });

            const firstWire = local.requests[0]!;
            const rawBody = firstWire.body.toString('utf8');
            const decoded = JSON.parse(rawBody) as {
                payload: { timestamp: number; msec_timestamp: number };
            };
            const contentMd5 = createHash('md5').update(firstWire.body).digest('hex');
            const date = header(firstWire, 'date');
            const canonical = [
                'POST',
                contentMd5,
                'application/json',
                date,
                `/v2/origin/custom/${SCOPE_ID}`
            ].join('\n');

            expect(firstWire.method).toBe('POST');
            expect(firstWire.path).toBe(`/v2/origin/custom/${SCOPE_ID}`);
            expect(firstWire.body.equals(Buffer.from(postedConfigs[0]!.data, 'utf8'))).toBe(true);
            expect(header(firstWire, 'content-md5')).toBe(contentMd5);
            expect(date).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
            expect(header(firstWire, 'x-signature')).toBe(
                createHmac('sha1', CHANNEL_SECRET).update(canonical).digest('hex')
            );
            expect(decoded.payload.msec_timestamp).toBeGreaterThanOrEqual(before);
            expect(decoded.payload.msec_timestamp).toBeLessThanOrEqual(after);
            expect(decoded.payload.timestamp).toBe(Math.floor(decoded.payload.msec_timestamp / 1000));
            expect(amo.metadataWrites).toHaveLength(2);
            const firstLedger = Object.values(
                amo.metadataWrites[0]!['openclawAmoSendLedgerV1'] as Record<string, { state: string }>
            );
            const confirmedLedger = Object.values(
                amo.metadataWrites[1]!['openclawAmoSendLedgerV1'] as Record<string, { state: string }>
            );
            expect(firstLedger).toEqual([expect.objectContaining({ state: 'pending' })]);
            expect(confirmedLedger).toEqual([expect.objectContaining({ state: 'confirmed' })]);

            providerStatus = 500;
            const unknownPost = vi.fn((config: NangoPostConfig) => nangoPostOverLocalTls(local.origin, config));
            const unknownAmo = createAmoRuntime(unknownPost);
            const unknownInput = { ...input, msgid: 'wire-unknown-12345678' };
            const unknown = await amoSendMessageAction.exec(unknownAmo.runtime as never, unknownInput);
            providerStatus = 200;
            const stickyUnknown = await amoSendMessageAction.exec(unknownAmo.runtime as never, unknownInput);

            expect(unknown).toMatchObject({
                ok: false,
                outcome: 'unknown',
                error: { code: 'amocrm_chats_outcome_unknown', retryable: false }
            });
            expect(stickyUnknown).toEqual(unknown);
            expect(unknownPost).toHaveBeenCalledTimes(1);
            expect(local.requests).toHaveLength(2);
            expect(local.errors).toEqual([]);
            expect(JSON.stringify([first, cached, conflict, unknown, stickyUnknown])).not.toContain(CHANNEL_SECRET);
        } finally {
            await local.close();
        }
    });
});
