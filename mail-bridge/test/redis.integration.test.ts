import { createHash, randomUUID } from 'node:crypto';

import { createClient } from 'redis';
import { describe, expect, it } from 'vitest';

import {
    createConfiguredStore,
    type AtomicStateStore,
    type RedisClientLike
} from '../src/auth.js';

const redisUrl = process.env['MAIL_BRIDGE_TEST_REDIS_URL'];
const describeWithRedis = redisUrl === undefined ? describe.skip : describe;
const TTL_SECONDS = 10;

describeWithRedis('real Redis atomic state store', () => {
    it('keeps nonce and send-ledger transitions atomic across two independent clients', async () => {
        if (!redisUrl) {
            throw new Error('MAIL_BRIDGE_TEST_REDIS_URL must be a non-empty Redis URL');
        }

        const clients: Array<{ readonly isOpen: boolean; close(): Promise<void> }> = [];
        const createRealStore = async (): Promise<AtomicStateStore> =>
            createConfiguredStore(
                {
                    MAIL_BRIDGE_REPLICA_MODE: 'multi',
                    MAIL_BRIDGE_REDIS_URL: redisUrl
                },
                (options): RedisClientLike => {
                    const client = createClient({
                        ...options,
                        socket: { connectTimeout: 5_000, reconnectStrategy: false }
                    });
                    client.on('error', () => undefined);
                    clients.push(client);
                    return client;
                },
                () => undefined
            );

        try {
            const [firstStore, secondStore] = await Promise.all([
                createRealStore(),
                createRealStore()
            ]);
            expect(clients).toHaveLength(2);
            expect(clients[0]).not.toBe(clients[1]);
            expect(firstStore).not.toBe(secondStore);
            const runId = randomUUID();
            const nonce = `mail-bridge-integration:${runId}:nonce`;
            const confirmedKey = `mail-bridge-integration:${runId}:confirmed`;
            const unknownKey = `mail-bridge-integration:${runId}:unknown`;
            const bodyHash = createHash('sha256').update(`${runId}:body`).digest('hex');
            const differentBodyHash = createHash('sha256').update(`${runId}:different`).digest('hex');
            const exactResult = JSON.stringify({
                mailbox: 'integration@example.test',
                messageId: `<${runId}@example.test>`
            });

            const nonceResults = await Promise.all([
                firstStore.consumeNonce(nonce, TTL_SECONDS),
                secondStore.consumeNonce(nonce, TTL_SECONDS)
            ]);
            expect(nonceResults.filter(Boolean)).toHaveLength(1);
            expect(nonceResults).toContain(true);
            expect(nonceResults).toContain(false);

            const concurrentBegins = await Promise.all([
                firstStore.beginSend(confirmedKey, bodyHash, TTL_SECONDS),
                secondStore.beginSend(confirmedKey, bodyHash, TTL_SECONDS)
            ]);
            expect(concurrentBegins.map((result) => result.kind).sort()).toEqual(['new', 'unknown']);
            await expect(
                secondStore.beginSend(confirmedKey, differentBodyHash, TTL_SECONDS)
            ).resolves.toEqual({ kind: 'conflict' });
            await expect(
                firstStore.confirmSend(confirmedKey, differentBodyHash, exactResult, TTL_SECONDS)
            ).resolves.toBe(false);
            await expect(
                secondStore.confirmSend(confirmedKey, bodyHash, exactResult, TTL_SECONDS)
            ).resolves.toBe(true);
            await expect(
                firstStore.beginSend(confirmedKey, bodyHash, TTL_SECONDS)
            ).resolves.toEqual({ kind: 'cached', result: exactResult });

            await expect(
                firstStore.beginSend(unknownKey, bodyHash, TTL_SECONDS)
            ).resolves.toEqual({ kind: 'new' });
            await expect(
                secondStore.markSendUnknown(unknownKey, differentBodyHash, TTL_SECONDS)
            ).resolves.toBe(false);
            await expect(
                firstStore.confirmSend(unknownKey, differentBodyHash, exactResult, TTL_SECONDS)
            ).resolves.toBe(false);
            await expect(
                secondStore.markSendUnknown(unknownKey, bodyHash, TTL_SECONDS)
            ).resolves.toBe(true);
            await expect(
                firstStore.beginSend(unknownKey, bodyHash, TTL_SECONDS)
            ).resolves.toEqual({ kind: 'unknown' });
        } finally {
            await Promise.all(
                clients.map(async (client) => {
                    if (client.isOpen) {
                        await client.close();
                    }
                })
            );
        }
    });
});
