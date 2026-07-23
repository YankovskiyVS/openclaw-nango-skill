import { createAction } from 'nango';
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

export const sendMessageInputSchema = z
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

export const sendMessageOutputSchema = z.union([
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
    | 'amocrm_chats_rejected'
    | 'amocrm_chats_outcome_unknown'
    | 'amocrm_chats_response_invalid';

const SAFE_ERROR_MESSAGES: Record<ErrorCode, string> = {
    amocrm_channel_connection_invalid: 'The amoCRM Chats channel connection is invalid.',
    amocrm_chats_rejected: 'amoCRM rejected the signed message request.',
    amocrm_chats_outcome_unknown: 'The message may have reached amoCRM; inspect the chat before retrying.',
    amocrm_chats_response_invalid: 'amoCRM returned an invalid message response; inspect the chat before retrying.'
};

function failure<TOutcome extends FailureOutcome>(outcome: TOutcome, code: ErrorCode) {
    return {
        ok: false as const,
        outcome,
        error: {
            code,
            message: SAFE_ERROR_MESSAGES[code],
            retryable: false
        }
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function documentedRejectionStatus(error: unknown): boolean {
    if (!isRecord(error) || !isRecord(error.response)) {
        return false;
    }
    const status = error.response.status;
    return Number.isInteger(status) && (status === 400 || status === 403);
}

const action = createAction({
    description: 'Send one bounded text message through an internally configured amoCRM Chats channel.',
    version: '1.0.0',
    scopes: [],
    input: sendMessageInputSchema,
    output: sendMessageOutputSchema,
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

        const now = new Date();
        const timestampMs = now.getTime();
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
                return failure('unknown', 'amocrm_chats_response_invalid');
            }

            return {
                ok: true as const,
                outcome: 'confirmed' as const,
                result: {
                    conversationId: parsed.data.new_message.conversation_id,
                    senderId: parsed.data.new_message.sender_id,
                    receiverId: parsed.data.new_message.receiver_id,
                    msgid: parsed.data.new_message.msgid,
                    refId: parsed.data.new_message.ref_id
                }
            };
        } catch (error) {
            if (documentedRejectionStatus(error)) {
                return failure('confirmed_failed', 'amocrm_chats_rejected');
            }
            return failure('unknown', 'amocrm_chats_outcome_unknown');
        }
    }
});

export default action;
