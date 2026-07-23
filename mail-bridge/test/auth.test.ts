import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
    BridgeError,
    InMemoryAtomicStore,
    authenticateBridgeRequest,
    createConfiguredStore
} from '../src/auth.js';
import {
    MAX_RAW_BODY_BYTES,
    createBridgeHandler,
    readBoundedBody
} from '../src/server.js';

const SECRET = '0123456789abcdef0123456789abcdef';
const TOKEN = 'provider-access-token-never-returned';
const NOW = 1_750_000_000;
const PATH = '/v1/yandex-mail/resolve-mailbox';
const NONCE = '00112233445566778899aabbccddeeff';
const BODY = Buffer.from('{"mailbox":"robot@custom-domain.example","payload":{}}');

function signedHeaders(body = BODY, timestamp = NOW, nonce = NONCE, secret = SECRET) {
    const digest = createHash('sha256').update(body).digest('hex');
    const canonical = ['v1', 'POST', PATH, String(timestamp), nonce, digest].join('\n');
    return {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'x-mail-bridge-version': 'v1',
        'x-mail-bridge-timestamp': String(timestamp),
        'x-mail-bridge-nonce': nonce,
        'x-mail-bridge-body-sha256': digest,
        'x-mail-bridge-signature': createHmac('sha256', secret).update(canonical).digest('hex')
    };
}

describe('bridge request authentication', () => {
    it('accepts the exact canonical HMAC fixture and returns only the bearer token internally', async () => {
        const store = new InMemoryAtomicStore();

        const authenticated = await authenticateBridgeRequest(
            {
                method: 'POST',
                path: PATH,
                headers: signedHeaders(),
                body: BODY
            },
            { secret: SECRET, store, nowSeconds: () => NOW }
        );

        expect(authenticated).toEqual({
            accessToken: TOKEN,
            bodySha256: createHash('sha256').update(BODY).digest('hex')
        });
        expect(JSON.stringify(authenticated)).not.toContain(SECRET);
    });

    it.each([
        ['forged body', Buffer.from('{"mailbox":"attacker@example.com","payload":{}}'), signedHeaders()],
        ['stale timestamp', BODY, signedHeaders(BODY, NOW - 301)],
        ['future timestamp', BODY, signedHeaders(BODY, NOW + 301)],
        ['short nonce', BODY, signedHeaders(BODY, NOW, '0011')],
        ['forged signature', BODY, signedHeaders(BODY, NOW, NONCE, 'fedcba9876543210fedcba9876543210')]
    ])('rejects %s before replay state is consumed', async (_name, body, headers) => {
        const consumeNonce = vi.fn().mockResolvedValue(true);

        await expect(
            authenticateBridgeRequest(
                { method: 'POST', path: PATH, headers, body },
                {
                    secret: SECRET,
                    store: {
                        consumeNonce,
                        beginSend: vi.fn(),
                        confirmSend: vi.fn(),
                        markSendUnknown: vi.fn()
                    },
                    nowSeconds: () => NOW
                }
            )
        ).rejects.toBeInstanceOf(BridgeError);
        expect(consumeNonce).not.toHaveBeenCalled();
    });

    it('atomically rejects a replay', async () => {
        const store = new InMemoryAtomicStore();
        const request = { method: 'POST', path: PATH, headers: signedHeaders(), body: BODY };

        await expect(
            authenticateBridgeRequest(request, { secret: SECRET, store, nowSeconds: () => NOW })
        ).resolves.toMatchObject({ accessToken: TOKEN });
        await expect(
            authenticateBridgeRequest(request, { secret: SECRET, store, nowSeconds: () => NOW })
        ).rejects.toMatchObject({ code: 'request_replayed', status: 409 });
    });

    it('fails closed instead of growing the single-replica replay store without bound', async () => {
        const store = new InMemoryAtomicStore(() => 0, 2);

        await expect(store.consumeNonce('nonce-one', 600)).resolves.toBe(true);
        await expect(store.consumeNonce('nonce-two', 600)).resolves.toBe(true);
        await expect(store.consumeNonce('nonce-three', 600)).rejects.toMatchObject({
            code: 'shared_store_unavailable',
            status: 503
        });
    });

    it('rejects non-printable bytes in the bearer credential before consuming the nonce', async () => {
        const consumeNonce = vi.fn().mockResolvedValue(true);
        const headers = {
            ...signedHeaders(),
            authorization: `Bearer valid-prefix\u0000suffix`
        };

        await expect(
            authenticateBridgeRequest(
                { method: 'POST', path: PATH, headers, body: BODY },
                {
                    secret: SECRET,
                    store: {
                        consumeNonce,
                        beginSend: vi.fn(),
                        confirmSend: vi.fn(),
                        markSendUnknown: vi.fn()
                    },
                    nowSeconds: () => NOW
                }
            )
        ).rejects.toMatchObject({ code: 'authorization_invalid' });
        expect(consumeNonce).not.toHaveBeenCalled();
    });

    it('does not parse JSON or call mail for forged, stale or replayed requests', async () => {
        const parseJson = vi.fn().mockReturnValue(JSON.parse(BODY.toString('utf8')));
        const mail = {
            resolveMailbox: vi.fn(),
            listMessages: vi.fn(),
            getMessage: vi.fn(),
            sendMessage: vi.fn()
        };
        const handler = createBridgeHandler({
            secret: SECRET,
            store: new InMemoryAtomicStore(),
            mail,
            nowSeconds: () => NOW,
            parseJson
        });

        for (const headers of [
            signedHeaders(BODY, NOW - 301),
            signedHeaders(BODY, NOW, NONCE, 'fedcba9876543210fedcba9876543210')
        ]) {
            const response = await handler({ method: 'POST', path: PATH, headers, body: BODY });
            expect(response.status).toBe(401);
        }

        const valid = { method: 'POST', path: PATH, headers: signedHeaders(), body: BODY };
        await handler(valid);
        const replay = await handler(valid);
        expect(replay.status).toBe(409);
        expect(parseJson).toHaveBeenCalledTimes(1);
        expect(mail.resolveMailbox).toHaveBeenCalledTimes(1);
    });
});

describe('startup and raw body safety', () => {
    it('requires an explicit single-replica mode before using memory', async () => {
        await expect(createConfiguredStore({ MAIL_BRIDGE_REPLICA_MODE: 'single' })).resolves.toBeInstanceOf(
            InMemoryAtomicStore
        );
        await expect(createConfiguredStore({ MAIL_BRIDGE_REPLICA_MODE: 'multi' })).rejects.toMatchObject({
            code: 'shared_store_required'
        });
        await expect(createConfiguredStore({})).rejects.toMatchObject({ code: 'replica_mode_required' });
    });

    it('connects a shared Redis store in multi-replica mode', async () => {
        const connect = vi.fn().mockResolvedValue(undefined);
        const evalCommand = vi.fn();
        const on = vi.fn();
        const createRedisClient = vi.fn().mockReturnValue({ connect, eval: evalCommand, on });
        const reportStatus = vi.fn();

        const store = await createConfiguredStore(
            {
                MAIL_BRIDGE_REPLICA_MODE: 'multi',
                MAIL_BRIDGE_REDIS_URL: 'redis://redis.internal:6379'
            },
            createRedisClient,
            reportStatus
        );

        expect(createRedisClient).toHaveBeenCalledWith({ url: 'redis://redis.internal:6379' });
        expect(on).toHaveBeenCalledTimes(4);
        expect(on.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]!);
        expect(connect).toHaveBeenCalledTimes(1);
        expect(reportStatus).toHaveBeenCalledWith({
            component: 'mail_bridge_redis',
            available: true,
            code: 'redis_ready'
        });
        expect(store.constructor.name).toBe('RedisAtomicStore');
    });

    it('fails closed on Redis lifecycle errors, reports safe transitions and recovers on ready', async () => {
        class FakeRedisClient extends EventEmitter {
            readonly connect = vi.fn().mockResolvedValue(undefined);
            readonly eval = vi.fn().mockResolvedValue('OK');
        }

        const client = new FakeRedisClient();
        const reportStatus = vi.fn();
        const createRedisClient = vi.fn().mockReturnValue(client);
        const store = await createConfiguredStore(
            {
                MAIL_BRIDGE_REPLICA_MODE: 'multi',
                MAIL_BRIDGE_REDIS_URL: 'redis://user:password@redis.internal:6379'
            },
            createRedisClient,
            reportStatus
        );

        expect(reportStatus).toHaveBeenLastCalledWith({
            component: 'mail_bridge_redis',
            available: true,
            code: 'redis_ready'
        });

        expect(() =>
            client.emit(
                'error',
                new Error('redis://user:password@redis.internal:6379 contains-sensitive-provider-detail')
            )
        ).not.toThrow();
        client.emit('reconnecting');
        client.emit('end');

        expect(reportStatus).toHaveBeenLastCalledWith({
            component: 'mail_bridge_redis',
            available: false,
            code: 'shared_store_unavailable'
        });
        expect(reportStatus).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(reportStatus.mock.calls)).not.toContain('password');
        await expect(store.consumeNonce('nonce-after-outage', 60)).rejects.toMatchObject({
            code: 'shared_store_unavailable',
            status: 503,
            outcome: 'not_started',
            retryable: true
        });
        expect(client.eval).not.toHaveBeenCalled();

        client.emit('ready');
        await expect(store.consumeNonce('nonce-after-ready', 60)).resolves.toBe(true);
        expect(reportStatus).toHaveBeenLastCalledWith({
            component: 'mail_bridge_redis',
            available: true,
            code: 'redis_ready'
        });

        client.eval.mockRejectedValueOnce(new Error('redis command exposed a provider detail'));
        await expect(store.consumeNonce('nonce-eval-failure', 60)).rejects.toMatchObject({
            code: 'shared_store_unavailable',
            status: 503,
            outcome: 'not_started',
            retryable: true
        });
        expect(reportStatus).toHaveBeenLastCalledWith({
            component: 'mail_bridge_redis',
            available: false,
            code: 'shared_store_unavailable'
        });
    });

    it('does not overwrite a lifecycle failure emitted while connect is resolving', async () => {
        class EndingRedisClient extends EventEmitter {
            readonly eval = vi.fn();
            readonly connect = vi.fn(async () => {
                this.emit('end');
            });
        }

        const client = new EndingRedisClient();
        const reportStatus = vi.fn();
        await expect(
            createConfiguredStore(
                {
                    MAIL_BRIDGE_REPLICA_MODE: 'multi',
                    MAIL_BRIDGE_REDIS_URL: 'redis://redis.internal:6379'
                },
                vi.fn().mockReturnValue(client),
                reportStatus
            )
        ).rejects.toMatchObject({
            code: 'shared_store_unavailable',
            status: 503,
            outcome: 'not_started',
            retryable: true
        });
        expect(reportStatus).toHaveBeenCalledTimes(1);
        expect(reportStatus).toHaveBeenCalledWith({
            component: 'mail_bridge_redis',
            available: false,
            code: 'shared_store_unavailable'
        });
        expect(client.eval).not.toHaveBeenCalled();
    });

    it('rejects a raw body at cap plus one without parsing it', async () => {
        const stream = Readable.from([
            Buffer.alloc(MAX_RAW_BODY_BYTES),
            Buffer.alloc(1)
        ]);

        await expect(readBoundedBody(stream, MAX_RAW_BODY_BYTES)).rejects.toMatchObject({
            code: 'request_too_large',
            status: 413
        });
    });

    it('never serializes the HMAC secret or bearer token in errors', async () => {
        try {
            await authenticateBridgeRequest(
                {
                    method: 'POST',
                    path: PATH,
                    headers: {
                        ...signedHeaders(),
                        authorization: `Bearer ${TOKEN}`,
                        'x-mail-bridge-signature': SECRET
                    },
                    body: BODY
                },
                { secret: SECRET, store: new InMemoryAtomicStore(), nowSeconds: () => NOW }
            );
            throw new Error('expected failure');
        } catch (error) {
            expect(JSON.stringify(error)).not.toContain(SECRET);
            expect(JSON.stringify(error)).not.toContain(TOKEN);
        }
    });
});
