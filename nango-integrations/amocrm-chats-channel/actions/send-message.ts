import { createAction } from 'nango';
import { createHash } from 'node:crypto';
import * as z from 'zod';

import { AMOJO_ORIGINS, signAmoChatsRequest } from '../lib/signature.js';

const idSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9._:-]+$/);
const messageIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const displayNameSchema = z.string().trim().min(1).max(256);

const receiverSchema = z
    .object({
        id: idSchema,
        name: displayNameSchema,
        refId: idSchema.optional()
    })
    .strict();

const sendMessageInputSchema = z
    .object({
        msgid: messageIdSchema,
        conversationId: idSchema,
        conversationRefId: idSchema.optional(),
        receiver: receiverSchema,
        text: z.string().min(1).max(32_768),
        silent: z.boolean().default(false)
    })
    .strict();

const safeErrorSchema = z
    .object({
        code: z.string().min(1).max(96),
        message: z.string().min(1).max(512),
        retryable: z.boolean()
    })
    .strict();

const failureEnvelopeSchema = z.discriminatedUnion('outcome', [
    z
        .object({
            ok: z.literal(false),
            outcome: z.literal('not_started'),
            error: safeErrorSchema
        })
        .strict(),
    z
        .object({
            ok: z.literal(false),
            outcome: z.literal('confirmed_failed'),
            error: safeErrorSchema
        })
        .strict(),
    z
        .object({
            ok: z.literal(false),
            outcome: z.literal('unknown'),
            error: safeErrorSchema
        })
        .strict()
]);

const confirmedResultSchema = z
    .object({
        conversationId: idSchema,
        senderId: idSchema,
        receiverId: idSchema.nullable(),
        msgid: z.string().min(1).max(255),
        refId: messageIdSchema
    })
    .strict();

const LEDGER_METADATA_FIELD = 'openclawAmoSendLedgerV1';
const LEDGER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LEDGER_LOCK_TTL_MS = 15 * 60 * 1000;
const MAX_LEDGER_ENTRIES = 256;
const bodyHashSchema = z.string().length(64).regex(/^[a-f0-9]+$/);

const ledgerEntrySchema = z.discriminatedUnion('state', [
    z
        .object({
            state: z.literal('pending'),
            bodyHash: bodyHashSchema,
            expiresAt: z.number().int().positive()
        })
        .strict(),
    z
        .object({
            state: z.literal('unknown'),
            bodyHash: bodyHashSchema,
            expiresAt: z.number().int().positive()
        })
        .strict(),
    z
        .object({
            state: z.literal('confirmed_failed'),
            bodyHash: bodyHashSchema,
            expiresAt: z.number().int().positive()
        })
        .strict(),
    z
        .object({
            state: z.literal('confirmed'),
            bodyHash: bodyHashSchema,
            expiresAt: z.number().int().positive(),
            result: confirmedResultSchema
        })
        .strict()
]);

const actionMetadataSchema = z
    .object({
        [LEDGER_METADATA_FIELD]: z.record(messageIdSchema, ledgerEntrySchema).optional()
    })
    .passthrough();

const sendMessageOutputSchema = z.union([
    z
        .object({
            ok: z.literal(true),
            outcome: z.literal('confirmed'),
            result: confirmedResultSchema
        })
        .strict(),
    failureEnvelopeSchema
]);

const providerResponseSchema = z
    .object({
        new_message: z
            .object({
                conversation_id: idSchema,
                sender_id: idSchema,
                receiver_id: idSchema.nullable(),
                msgid: z.string().min(1).max(255),
                ref_id: messageIdSchema
            })
            .strict()
    })
    .strict();

const channelSecretSchema = z.string().min(20).max(512).regex(/^[\x21-\x7e]+$/);
const channelConnectionSchema = z
    .object({
        credentials: z
            .object({
                type: z.literal('CUSTOM'),
                raw: z
                    .object({
                        channel_secret: channelSecretSchema
                    })
                    .passthrough()
            })
            .passthrough(),
        connection_config: z
            .object({
                scope_id: idSchema,
                amojo_region: z.enum(['ru', 'com']),
                sender_id: idSchema,
                sender_name: displayNameSchema,
                sender_ref_id: idSchema
            })
            .passthrough()
    })
    .passthrough();

type FailureOutcome = 'not_started' | 'confirmed_failed' | 'unknown';
type ErrorCode =
    | 'amocrm_channel_connection_invalid'
    | 'amocrm_chats_idempotency_conflict'
    | 'amocrm_chats_idempotency_unavailable'
    | 'amocrm_chats_rejected'
    | 'amocrm_chats_outcome_unknown'
    | 'amocrm_chats_response_invalid';

const SAFE_ERROR_MESSAGES: Record<ErrorCode, string> = {
    amocrm_channel_connection_invalid: 'The amoCRM Chats channel connection is invalid.',
    amocrm_chats_idempotency_conflict: 'The msgid was already used for a different message.',
    amocrm_chats_idempotency_unavailable: 'The shared amoCRM send ledger is unavailable.',
    amocrm_chats_rejected: 'amoCRM rejected the signed message request.',
    amocrm_chats_outcome_unknown: 'The message may have reached amoCRM; inspect the chat before retrying.',
    amocrm_chats_response_invalid: 'amoCRM returned an invalid message response; inspect the chat before retrying.'
};

function failure<TOutcome extends FailureOutcome>(outcome: TOutcome, code: ErrorCode, retryable = false) {
    return {
        ok: false as const,
        outcome,
        error: {
            code,
            message: SAFE_ERROR_MESSAGES[code],
            retryable
        }
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function documentedRejectionStatus(error: unknown): boolean {
    if (!isRecord(error) || !isRecord(error['response'])) {
        return false;
    }
    const status = error['response']['status'];
    return Number.isInteger(status) && (status === 400 || status === 403);
}

type SendInput = z.infer<typeof sendMessageInputSchema>;
type ChannelConnection = z.infer<typeof channelConnectionSchema>;
type ActionMetadata = z.infer<typeof actionMetadataSchema>;
type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
type ConfirmedResult = z.infer<typeof confirmedResultSchema>;

type LedgerContext = {
    entries: Record<string, LedgerEntry>;
};

function sendBodyHash(input: SendInput, connection: ChannelConnection): string {
    const stableRequest = JSON.stringify({
        scopeId: connection.connection_config.scope_id,
        region: connection.connection_config.amojo_region,
        senderId: connection.connection_config.sender_id,
        senderName: connection.connection_config.sender_name,
        senderRefId: connection.connection_config.sender_ref_id,
        msgid: input.msgid,
        conversationId: input.conversationId,
        conversationRefId: input.conversationRefId ?? null,
        receiver: {
            id: input.receiver.id,
            name: input.receiver.name,
            refId: input.receiver.refId ?? null
        },
        text: input.text,
        silent: input.silent
    });
    return createHash('sha256').update(stableRequest, 'utf8').digest('hex');
}

function ledgerLockKey(connectionId: string, scopeId: string): string {
    const digest = createHash('sha256')
        .update(`${connectionId}\0${scopeId}`, 'utf8')
        .digest('hex');
    return `openclaw-amocrm-send-${digest}`;
}

function messageLedgerKey(msgid: string): string {
    return createHash('sha256').update(msgid, 'utf8').digest('hex');
}

function readLedgerMetadata(value: unknown): ActionMetadata | null {
    const candidate = value === null || value === undefined ? {} : value;
    const parsed = actionMetadataSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
}

function prunedLedger(
    entries: Record<string, LedgerEntry>,
    currentKey: string,
    now: number
): Record<string, LedgerEntry> | null {
    const next = Object.fromEntries(
        Object.entries(entries).filter(([, entry]) => entry.expiresAt > now)
    ) as Record<string, LedgerEntry>;
    if (Object.hasOwn(next, currentKey) || Object.keys(next).length < MAX_LEDGER_ENTRIES) {
        return next;
    }

    const evictable = Object.entries(next)
        .filter(([, entry]) => entry.state === 'confirmed' || entry.state === 'confirmed_failed')
        .sort((left, right) => left[1].expiresAt - right[1].expiresAt);
    for (const [msgid] of evictable) {
        delete next[msgid];
        if (Object.keys(next).length < MAX_LEDGER_ENTRIES) {
            return next;
        }
    }
    return null;
}

async function beginLedgerSend(
    nango: {
        getMetadata(): Promise<unknown>;
        updateMetadata(metadata: Partial<ActionMetadata>): Promise<unknown>;
    },
    msgid: string,
    bodyHash: string,
    now: number
): Promise<
    | { kind: 'new'; context: LedgerContext }
    | { kind: 'cached'; result: ConfirmedResult }
    | { kind: 'confirmed_failed' }
    | { kind: 'unknown' }
    | { kind: 'conflict' }
    | { kind: 'unavailable' }
> {
    let metadata: ActionMetadata | null;
    try {
        metadata = readLedgerMetadata(await nango.getMetadata());
    } catch {
        metadata = null;
    }
    if (!metadata) {
        return { kind: 'unavailable' };
    }

    const ledgerKey = messageLedgerKey(msgid);
    const entries = prunedLedger(metadata[LEDGER_METADATA_FIELD] ?? {}, ledgerKey, now);
    if (!entries) {
        return { kind: 'unavailable' };
    }
    const existing = Object.hasOwn(entries, ledgerKey) ? entries[ledgerKey] : undefined;
    if (existing) {
        if (existing.bodyHash !== bodyHash) {
            return { kind: 'conflict' };
        }
        if (existing.state === 'confirmed') {
            return { kind: 'cached', result: existing.result };
        }
        if (existing.state === 'confirmed_failed') {
            return { kind: 'confirmed_failed' };
        }
        return { kind: 'unknown' };
    }

    entries[ledgerKey] = {
        state: 'pending',
        bodyHash,
        expiresAt: now + LEDGER_TTL_MS
    };
    try {
        await nango.updateMetadata({
            [LEDGER_METADATA_FIELD]: entries
        });
    } catch {
        return { kind: 'unavailable' };
    }
    return {
        kind: 'new',
        context: { entries }
    };
}

async function persistLedgerState(
    nango: { updateMetadata(metadata: Partial<ActionMetadata>): Promise<unknown> },
    context: LedgerContext,
    msgid: string,
    entry: LedgerEntry
): Promise<boolean> {
    context.entries[messageLedgerKey(msgid)] = entry;
    try {
        await nango.updateMetadata({
            [LEDGER_METADATA_FIELD]: context.entries
        });
        return true;
    } catch {
        return false;
    }
}

const action = createAction({
    description: 'Send one bounded text message through an internally configured amoCRM Chats channel.',
    version: '1.0.0',
    scopes: [],
    input: sendMessageInputSchema,
    output: sendMessageOutputSchema,
    metadata: actionMetadataSchema,
    exec: async (nango, rawInput) => {
        const input = sendMessageInputSchema.parse(rawInput);

        let connection: z.infer<typeof channelConnectionSchema> | null;
        try {
            const parsed = channelConnectionSchema.safeParse(await nango.getConnection());
            connection = parsed.success ? parsed.data : null;
        } catch {
            connection = null;
        }
        if (!connection) {
            return failure('not_started', 'amocrm_channel_connection_invalid');
        }

        let lockAcquired = false;
        try {
            try {
                lockAcquired = await nango.tryAcquireLock({
                    key: ledgerLockKey(nango.connectionId, connection.connection_config.scope_id),
                    ttlMs: LEDGER_LOCK_TTL_MS
                });
            } catch {
                return failure('not_started', 'amocrm_chats_idempotency_unavailable', true);
            }
            if (!lockAcquired) {
                return failure('unknown', 'amocrm_chats_outcome_unknown');
            }

            const timestampMs = Date.now();
            const bodyHash = sendBodyHash(input, connection);
            const begin = await beginLedgerSend(nango, input.msgid, bodyHash, timestampMs);
            if (begin.kind === 'unavailable') {
                return failure('not_started', 'amocrm_chats_idempotency_unavailable', true);
            }
            if (begin.kind === 'conflict') {
                return failure('not_started', 'amocrm_chats_idempotency_conflict');
            }
            if (begin.kind === 'unknown') {
                return failure('unknown', 'amocrm_chats_outcome_unknown');
            }
            if (begin.kind === 'confirmed_failed') {
                return failure('confirmed_failed', 'amocrm_chats_rejected');
            }
            if (begin.kind === 'cached') {
                return {
                    ok: true as const,
                    outcome: 'confirmed' as const,
                    result: begin.result
                };
            }

            const now = new Date(timestampMs);
            const path = `/v2/origin/custom/${connection.connection_config.scope_id}`;
            const body = JSON.stringify({
                event_type: 'new_message',
                payload: {
                    timestamp: Math.floor(timestampMs / 1000),
                    msec_timestamp: timestampMs,
                    msgid: input.msgid,
                    conversation_id: input.conversationId,
                    ...(input.conversationRefId === undefined
                        ? {}
                        : { conversation_ref_id: input.conversationRefId }),
                    sender: {
                        id: connection.connection_config.sender_id,
                        name: connection.connection_config.sender_name,
                        ref_id: connection.connection_config.sender_ref_id
                    },
                    receiver: {
                        id: input.receiver.id,
                        name: input.receiver.name,
                        ...(input.receiver.refId === undefined ? {} : { ref_id: input.receiver.refId })
                    },
                    message: {
                        type: 'text',
                        text: input.text
                    },
                    silent: input.silent
                }
            });
            const signed = signAmoChatsRequest({
                body,
                path,
                secret: connection.credentials.raw.channel_secret,
                date: now
            });

            try {
                const response = await nango.post<unknown>({
                    endpoint: path,
                    baseUrlOverride: AMOJO_ORIGINS[connection.connection_config.amojo_region],
                    retries: 0,
                    forwardHeadersOnRedirect: false,
                    data: body,
                    headers: signed.headers
                });
                const parsed = providerResponseSchema.safeParse(response.data);
                if (!parsed.success || parsed.data.new_message.ref_id !== input.msgid) {
                    await persistLedgerState(nango, begin.context, input.msgid, {
                        state: 'unknown',
                        bodyHash,
                        expiresAt: Date.now() + LEDGER_TTL_MS
                    });
                    return failure('unknown', 'amocrm_chats_response_invalid');
                }

                const result = {
                    conversationId: parsed.data.new_message.conversation_id,
                    senderId: parsed.data.new_message.sender_id,
                    receiverId: parsed.data.new_message.receiver_id,
                    msgid: parsed.data.new_message.msgid,
                    refId: parsed.data.new_message.ref_id
                };
                const persisted = await persistLedgerState(nango, begin.context, input.msgid, {
                    state: 'confirmed',
                    bodyHash,
                    expiresAt: Date.now() + LEDGER_TTL_MS,
                    result
                });
                if (!persisted) {
                    return failure('unknown', 'amocrm_chats_outcome_unknown');
                }
                return {
                    ok: true as const,
                    outcome: 'confirmed' as const,
                    result
                };
            } catch (error) {
                if (documentedRejectionStatus(error)) {
                    await persistLedgerState(nango, begin.context, input.msgid, {
                        state: 'confirmed_failed',
                        bodyHash,
                        expiresAt: Date.now() + LEDGER_TTL_MS
                    });
                    return failure('confirmed_failed', 'amocrm_chats_rejected');
                }
                await persistLedgerState(nango, begin.context, input.msgid, {
                    state: 'unknown',
                    bodyHash,
                    expiresAt: Date.now() + LEDGER_TTL_MS
                });
                return failure('unknown', 'amocrm_chats_outcome_unknown');
            }
        } finally {
            if (lockAcquired) {
                try {
                    await nango.releaseLock({
                        key: ledgerLockKey(nango.connectionId, connection.connection_config.scope_id)
                    });
                } catch {
                    // Nango releases execution locks at the end of an action as a second safety net.
                }
            }
        }
    }
});

export default action;
