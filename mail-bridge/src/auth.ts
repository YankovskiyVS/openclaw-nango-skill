import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';

import { createClient } from 'redis';

export type SafeOutcome = 'not_started' | 'confirmed_failed' | 'unknown';

export class BridgeError extends Error {
    readonly code: string;
    readonly status: number;
    readonly outcome: SafeOutcome;
    readonly retryable: boolean;

    constructor(input: {
        code: string;
        message: string;
        status: number;
        outcome?: SafeOutcome;
        retryable?: boolean;
    }) {
        super(input.message);
        this.name = 'BridgeError';
        this.code = input.code;
        this.status = input.status;
        this.outcome = input.outcome ?? 'not_started';
        this.retryable = input.retryable ?? false;
    }
}

export type BeginSendResult =
    | { kind: 'new' }
    | { kind: 'cached'; result: string }
    | { kind: 'unknown' }
    | { kind: 'conflict' };

export interface AtomicStateStore {
    consumeNonce(nonce: string, ttlSeconds: number): Promise<boolean>;
    beginSend(key: string, bodyHash: string, ttlSeconds: number): Promise<BeginSendResult>;
    confirmSend(key: string, bodyHash: string, result: string, ttlSeconds: number): Promise<boolean>;
    markSendUnknown(key: string, bodyHash: string, ttlSeconds: number): Promise<boolean>;
}

type MemoryLedgerEntry = {
    bodyHash: string;
    state: 'pending' | 'unknown' | 'confirmed';
    result?: string;
    expiresAt: number;
};

export class InMemoryAtomicStore implements AtomicStateStore {
    readonly #nonces = new Map<string, number>();
    readonly #ledger = new Map<string, MemoryLedgerEntry>();
    readonly #nowMilliseconds: () => number;
    readonly #maxEntriesPerMap: number;

    constructor(nowMilliseconds: () => number = Date.now, maxEntriesPerMap = 10_000) {
        if (!Number.isSafeInteger(maxEntriesPerMap) || maxEntriesPerMap < 1) {
            throw new TypeError('maxEntriesPerMap must be a positive safe integer');
        }
        this.#nowMilliseconds = nowMilliseconds;
        this.#maxEntriesPerMap = maxEntriesPerMap;
    }

    async consumeNonce(nonce: string, ttlSeconds: number): Promise<boolean> {
        const now = this.#nowMilliseconds();
        const expiresAt = this.#nonces.get(nonce);
        if (expiresAt !== undefined && expiresAt > now) {
            return false;
        }
        if (expiresAt !== undefined) {
            this.#nonces.delete(nonce);
        }
        if (this.#nonces.size >= this.#maxEntriesPerMap) {
            this.#pruneNonces(now);
        }
        if (this.#nonces.size >= this.#maxEntriesPerMap) {
            throw sharedStoreUnavailable();
        }
        this.#nonces.set(nonce, now + ttlSeconds * 1000);
        return true;
    }

    async beginSend(key: string, bodyHash: string, ttlSeconds: number): Promise<BeginSendResult> {
        const now = this.#nowMilliseconds();
        const existing = this.#ledger.get(key);
        if (!existing || existing.expiresAt <= now) {
            if (existing) {
                this.#ledger.delete(key);
            }
            if (this.#ledger.size >= this.#maxEntriesPerMap) {
                this.#pruneLedger(now);
            }
            if (this.#ledger.size >= this.#maxEntriesPerMap) {
                throw sharedStoreUnavailable();
            }
            this.#ledger.set(key, {
                bodyHash,
                state: 'pending',
                expiresAt: now + ttlSeconds * 1000
            });
            return { kind: 'new' };
        }
        if (existing.bodyHash !== bodyHash) {
            return { kind: 'conflict' };
        }
        if (existing.state === 'confirmed' && existing.result !== undefined) {
            return { kind: 'cached', result: existing.result };
        }
        return { kind: 'unknown' };
    }

    async confirmSend(key: string, bodyHash: string, result: string, ttlSeconds: number): Promise<boolean> {
        const existing = this.#ledger.get(key);
        if (!existing || existing.bodyHash !== bodyHash) {
            return false;
        }
        this.#ledger.set(key, {
            bodyHash,
            state: 'confirmed',
            result,
            expiresAt: this.#nowMilliseconds() + ttlSeconds * 1000
        });
        return true;
    }

    async markSendUnknown(key: string, bodyHash: string, ttlSeconds: number): Promise<boolean> {
        const existing = this.#ledger.get(key);
        if (!existing || existing.bodyHash !== bodyHash) {
            return false;
        }
        this.#ledger.set(key, {
            bodyHash,
            state: 'unknown',
            expiresAt: this.#nowMilliseconds() + ttlSeconds * 1000
        });
        return true;
    }

    #pruneNonces(now: number): void {
        for (const [key, expiresAt] of this.#nonces) {
            if (expiresAt <= now) {
                this.#nonces.delete(key);
            }
        }
    }

    #pruneLedger(now: number): void {
        for (const [key, entry] of this.#ledger) {
            if (entry.expiresAt <= now) {
                this.#ledger.delete(key);
            }
        }
    }
}

export type RedisClientLike = {
    connect(): Promise<unknown>;
    eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
    on(event: 'error', listener: (error: unknown) => void): unknown;
    on(event: 'ready' | 'end' | 'reconnecting', listener: () => void): unknown;
};

export type RedisStoreStatusEvent = {
    component: 'mail_bridge_redis';
    available: boolean;
    code: 'redis_ready' | 'shared_store_unavailable';
};

type RedisStoreStatusReporter = (event: RedisStoreStatusEvent) => void;

function defaultRedisStoreStatusReporter(event: RedisStoreStatusEvent): void {
    try {
        process.stderr.write(`${JSON.stringify(event)}\n`);
    } catch {
        // Observability must never turn a handled Redis lifecycle event into a process crash.
    }
}

class RedisAvailability {
    #state: 'connecting' | 'available' | 'unavailable';
    readonly #reportStatus: RedisStoreStatusReporter;

    constructor(reportStatus: RedisStoreStatusReporter, initialState: 'connecting' | 'available' = 'connecting') {
        this.#reportStatus = reportStatus;
        this.#state = initialState;
    }

    isAvailable(): boolean {
        return this.#state === 'available';
    }

    markAvailable(): void {
        this.#transition('available');
    }

    markConnectedFallback(): void {
        if (this.#state === 'connecting') {
            this.#transition('available');
        }
    }

    markUnavailable(): void {
        this.#transition('unavailable');
    }

    #transition(next: 'available' | 'unavailable'): void {
        if (this.#state === next) {
            return;
        }
        this.#state = next;
        try {
            this.#reportStatus({
                component: 'mail_bridge_redis',
                available: next === 'available',
                code: next === 'available' ? 'redis_ready' : 'shared_store_unavailable'
            });
        } catch {
            // A caller-provided metrics/logging sink must not destabilize the bridge.
        }
    }
}

const REDIS_BEGIN_SEND = `
local current_hash = redis.call('HGET', KEYS[1], 'body_hash')
if not current_hash then
  redis.call('HSET', KEYS[1], 'body_hash', ARGV[1], 'state', 'pending')
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return {'new'}
end
if current_hash ~= ARGV[1] then
  return {'conflict'}
end
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'confirmed' then
  return {'cached', redis.call('HGET', KEYS[1], 'result') or ''}
end
return {'unknown'}
`;

const REDIS_CONFIRM_SEND = `
local current_hash = redis.call('HGET', KEYS[1], 'body_hash')
if not current_hash or current_hash ~= ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[1], 'state', 'confirmed', 'result', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`;

const REDIS_UNKNOWN_SEND = `
local current_hash = redis.call('HGET', KEYS[1], 'body_hash')
if not current_hash or current_hash ~= ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[1], 'state', 'unknown')
redis.call('HDEL', KEYS[1], 'result')
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

export class RedisAtomicStore implements AtomicStateStore {
    readonly #client: RedisClientLike;
    readonly #availability: RedisAvailability;

    constructor(
        client: RedisClientLike,
        availability = new RedisAvailability(() => undefined, 'available')
    ) {
        this.#client = client;
        this.#availability = availability;
    }

    async consumeNonce(nonce: string, ttlSeconds: number): Promise<boolean> {
        const key = `mail-bridge:nonce:${createHash('sha256').update(nonce).digest('hex')}`;
        const result = await this.#eval(
            "return redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1])",
            {
                keys: [key],
                arguments: [String(ttlSeconds)]
            }
        );
        return result === 'OK';
    }

    async beginSend(key: string, bodyHash: string, ttlSeconds: number): Promise<BeginSendResult> {
        const result = await this.#eval(REDIS_BEGIN_SEND, {
            keys: [ledgerKey(key)],
            arguments: [bodyHash, String(ttlSeconds)]
        });
        if (!Array.isArray(result) || typeof result[0] !== 'string') {
            this.#availability.markUnavailable();
            throw sharedStoreUnavailable();
        }
        switch (result[0]) {
            case 'new':
                return { kind: 'new' };
            case 'conflict':
                return { kind: 'conflict' };
            case 'unknown':
                return { kind: 'unknown' };
            case 'cached':
                if (typeof result[1] !== 'string') {
                    this.#availability.markUnavailable();
                    throw sharedStoreUnavailable();
                }
                return { kind: 'cached', result: result[1] };
            default:
                this.#availability.markUnavailable();
                throw sharedStoreUnavailable();
        }
    }

    async confirmSend(key: string, bodyHash: string, result: string, ttlSeconds: number): Promise<boolean> {
        const response = await this.#eval(REDIS_CONFIRM_SEND, {
            keys: [ledgerKey(key)],
            arguments: [bodyHash, result, String(ttlSeconds)]
        });
        return response === 1;
    }

    async markSendUnknown(key: string, bodyHash: string, ttlSeconds: number): Promise<boolean> {
        const response = await this.#eval(REDIS_UNKNOWN_SEND, {
            keys: [ledgerKey(key)],
            arguments: [bodyHash, String(ttlSeconds)]
        });
        return response === 1;
    }

    async #eval(
        script: string,
        options: { keys: string[]; arguments: string[] }
    ): Promise<unknown> {
        if (!this.#availability.isAvailable()) {
            throw sharedStoreUnavailable();
        }
        try {
            return await this.#client.eval(script, options);
        } catch {
            this.#availability.markUnavailable();
            throw sharedStoreUnavailable();
        }
    }
}

function ledgerKey(key: string): string {
    return `mail-bridge:send:${createHash('sha256').update(key).digest('hex')}`;
}

function sharedStoreUnavailable(): BridgeError {
    return new BridgeError({
        code: 'shared_store_unavailable',
        message: 'The shared replay and idempotency store is unavailable.',
        status: 503,
        retryable: true
    });
}

type RedisClientFactory = (options: { url: string }) => RedisClientLike;

export async function createConfiguredStore(
    environment: Record<string, string | undefined>,
    redisClientFactory: RedisClientFactory = (options) => createClient(options) as unknown as RedisClientLike,
    reportRedisStatus: RedisStoreStatusReporter = defaultRedisStoreStatusReporter
): Promise<AtomicStateStore> {
    const mode = environment.MAIL_BRIDGE_REPLICA_MODE;
    if (mode === 'single') {
        return new InMemoryAtomicStore();
    }
    if (mode !== 'multi') {
        throw new BridgeError({
            code: 'replica_mode_required',
            message: 'MAIL_BRIDGE_REPLICA_MODE must explicitly be single or multi.',
            status: 500
        });
    }
    const redisUrl = environment.MAIL_BRIDGE_REDIS_URL;
    if (!redisUrl) {
        throw new BridgeError({
            code: 'shared_store_required',
            message: 'Multi-replica mode requires a shared atomic store.',
            status: 500
        });
    }
    try {
        const parsed = new URL(redisUrl);
        if ((parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') || parsed.hostname === '') {
            throw new Error('invalid redis origin');
        }
        const client = redisClientFactory({ url: redisUrl });
        const availability = new RedisAvailability(reportRedisStatus);
        client.on('error', () => availability.markUnavailable());
        client.on('reconnecting', () => availability.markUnavailable());
        client.on('end', () => availability.markUnavailable());
        client.on('ready', () => availability.markAvailable());
        try {
            await client.connect();
        } catch {
            availability.markUnavailable();
            throw sharedStoreUnavailable();
        }
        availability.markConnectedFallback();
        if (!availability.isAvailable()) {
            throw sharedStoreUnavailable();
        }
        return new RedisAtomicStore(client, availability);
    } catch {
        throw sharedStoreUnavailable();
    }
}

type HeaderValue = string | string[] | undefined;

export type AuthenticatedBridgeRequest = {
    accessToken: string;
    bodySha256: string;
};

function header(headers: Record<string, HeaderValue>, name: string): string | null {
    const value = headers[name] ?? headers[name.toLowerCase()];
    return typeof value === 'string' ? value : null;
}

function safeHexEqual(left: string, right: string): boolean {
    if (!/^[a-f0-9]+$/.test(left) || !/^[a-f0-9]+$/.test(right) || left.length !== right.length) {
        return false;
    }
    const leftBytes = Buffer.from(left, 'hex');
    const rightBytes = Buffer.from(right, 'hex');
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function authFailure(code: string, message: string, status = 401): BridgeError {
    return new BridgeError({ code, message, status });
}

export async function authenticateBridgeRequest(
    request: {
        method: string;
        path: string;
        headers: Record<string, HeaderValue>;
        body: Buffer;
    },
    dependencies: {
        secret: string;
        store: AtomicStateStore;
        nowSeconds?: () => number;
    }
): Promise<AuthenticatedBridgeRequest> {
    if (Buffer.byteLength(dependencies.secret, 'utf8') < 32) {
        throw authFailure('bridge_configuration_invalid', 'The bridge authentication configuration is invalid.', 500);
    }
    if (request.method !== 'POST' || header(request.headers, 'content-type') !== 'application/json') {
        throw authFailure('request_not_supported', 'Only signed JSON POST requests are supported.', 405);
    }
    if (header(request.headers, 'x-mail-bridge-version') !== 'v1') {
        throw authFailure('signature_invalid', 'The bridge signature is invalid.');
    }

    const timestampValue = header(request.headers, 'x-mail-bridge-timestamp');
    if (!timestampValue || !/^[0-9]{10}$/.test(timestampValue)) {
        throw authFailure('timestamp_invalid', 'The bridge timestamp is invalid.');
    }
    const timestamp = Number(timestampValue);
    const now = (dependencies.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
    if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300) {
        throw authFailure('timestamp_invalid', 'The bridge timestamp is outside the allowed window.');
    }

    const nonce = header(request.headers, 'x-mail-bridge-nonce');
    if (!nonce || !/^[a-f0-9]{32,128}$/.test(nonce) || nonce.length % 2 !== 0) {
        throw authFailure('nonce_invalid', 'The bridge nonce is invalid.');
    }

    const suppliedDigest = header(request.headers, 'x-mail-bridge-body-sha256');
    const bodySha256 = createHash('sha256').update(request.body).digest('hex');
    if (!suppliedDigest || !safeHexEqual(suppliedDigest, bodySha256)) {
        throw authFailure('body_digest_invalid', 'The signed request body does not match.');
    }

    const canonical = ['v1', 'POST', request.path, timestampValue, nonce, bodySha256].join('\n');
    const expectedSignature = createHmac('sha256', dependencies.secret).update(canonical).digest('hex');
    const suppliedSignature = header(request.headers, 'x-mail-bridge-signature');
    if (!suppliedSignature || !safeHexEqual(suppliedSignature, expectedSignature)) {
        throw authFailure('signature_invalid', 'The bridge signature is invalid.');
    }

    const authorization = header(request.headers, 'authorization');
    const bearerMatch = authorization?.match(/^Bearer ([\x21-\x7e]{1,8192})$/);
    if (!bearerMatch) {
        throw authFailure('authorization_invalid', 'A provider bearer credential is required.');
    }

    let consumed: boolean;
    try {
        consumed = await dependencies.store.consumeNonce(nonce, 601);
    } catch {
        throw sharedStoreUnavailable();
    }
    if (!consumed) {
        throw authFailure('request_replayed', 'The signed request nonce was already used.', 409);
    }

    return {
        accessToken: bearerMatch[1]!,
        bodySha256
    };
}
