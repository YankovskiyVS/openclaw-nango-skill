import { createHash, createHmac, randomBytes } from 'node:crypto';
import { URL } from 'node:url';

import * as z from 'zod';

export const BRIDGE_PATHS = {
    resolveMailbox: '/v1/yandex-mail/resolve-mailbox',
    listMessages: '/v1/yandex-mail/list-messages',
    getMessage: '/v1/yandex-mail/get-message',
    sendMessage: '/v1/yandex-mail/send-message'
} as const;

const MAX_BODY_CHARS = 262_144;
const MAX_ATTACHMENT_BASE64_CHARS = 1_400_000;
const MAX_SEND_CONTENT_BYTES = 1_048_576;

export const mailboxSchema = z
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
const nullableText = (max: number) => z.string().max(max).nullable();

export const resolveMailboxInputSchema = z.object({}).strict();

export const listMessagesInputSchema = z
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

export const getMessageInputSchema = z
    .object({
        folder: folderSchema.default('INBOX'),
        uid: z.number().int().positive()
    })
    .strict();

const attachmentInputSchema = z
    .object({
        filename: z.string().trim().min(1).max(255),
        contentType: z.string().trim().min(1).max(127),
        contentBase64: z
            .string()
            .min(1)
            .max(MAX_ATTACHMENT_BASE64_CHARS)
            .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
            .refine((value) => Buffer.from(value, 'base64').toString('base64') === value, 'Base64 must be canonical')
    })
    .strict();

export const sendMessageInputSchema = z
    .object({
        idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
        to: z.array(emailSchema).min(1).max(50),
        cc: z.array(emailSchema).max(50).optional(),
        bcc: z.array(emailSchema).max(50).optional(),
        subject: z.string().max(998),
        text: z.string().max(MAX_BODY_CHARS).optional(),
        html: z.string().max(MAX_BODY_CHARS).optional(),
        attachments: z.array(attachmentInputSchema).max(10).optional()
    })
    .strict()
    .refine((value) => value.text !== undefined || value.html !== undefined, {
        message: 'A text or HTML body is required'
    })
    .superRefine((value, context) => {
        const bodyBytes =
            Buffer.byteLength(value.text ?? '', 'utf8') +
            Buffer.byteLength(value.html ?? '', 'utf8') +
            (value.attachments ?? []).reduce(
                (total, attachment) => total + Buffer.from(attachment.contentBase64, 'base64').byteLength,
                0
            );
        if (bodyBytes > MAX_SEND_CONTENT_BYTES) {
            context.addIssue({
                code: 'custom',
                message: `Combined message bodies and decoded attachments must not exceed ${MAX_SEND_CONTENT_BYTES} bytes`
            });
        }
    });

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

const confirmedEnvelope = <T extends z.ZodTypeAny>(result: T) =>
    z
        .object({
            ok: z.literal(true),
            outcome: z.literal('confirmed'),
            result
        })
        .strict();

const addressSchema = z
    .object({
        name: nullableText(256),
        address: nullableText(254)
    })
    .strict();

const messageSummarySchema = z
    .object({
        uid: z.number().int().positive(),
        subject: nullableText(998),
        from: z.array(addressSchema).max(100),
        to: z.array(addressSchema).max(100),
        receivedAt: z.iso.datetime({ offset: true }).nullable(),
        flags: z.array(z.string().max(128)).max(100),
        size: z.number().int().nonnegative(),
        hasAttachments: z.boolean()
    })
    .strict();

const attachmentMetadataSchema = z
    .object({
        filename: nullableText(255),
        contentType: z.string().min(1).max(127),
        size: z.number().int().nonnegative(),
        contentId: nullableText(512)
    })
    .strict();

export const resolveMailboxOutputSchema = z.union([
    confirmedEnvelope(
        z
            .object({
                mailbox: mailboxSchema
            })
            .strict()
    ),
    failureEnvelopeSchema
]);

export const listMessagesOutputSchema = z.union([
    confirmedEnvelope(
        z
            .object({
                mailbox: mailboxSchema,
                messages: z.array(messageSummarySchema).max(100),
                nextCursor: z.string().max(64).nullable()
            })
            .strict()
    ),
    failureEnvelopeSchema
]);

export const getMessageOutputSchema = z.union([
    confirmedEnvelope(
        z
            .object({
                mailbox: mailboxSchema,
                message: messageSummarySchema.extend({
                    text: nullableText(MAX_BODY_CHARS),
                    html: nullableText(MAX_BODY_CHARS),
                    bodyTruncated: z.boolean(),
                    attachments: z.array(attachmentMetadataSchema).max(100)
                })
            })
            .strict()
    ),
    failureEnvelopeSchema
]);

export const sendMessageOutputSchema = z.union([
    confirmedEnvelope(
        z
            .object({
                mailbox: mailboxSchema,
                messageId: z.string().min(1).max(998)
            })
            .strict()
    ),
    failureEnvelopeSchema
]);

type EnvironmentVariable = { name: string; value: string };

type NangoRuntime = {
    getConnection(): Promise<unknown>;
    getEnvironmentVariables(): Promise<EnvironmentVariable[] | null>;
    post<T = unknown>(config: {
        endpoint: string;
        baseUrlOverride: string;
        retries: number;
        forwardHeadersOnRedirect: false;
        data: string;
        headers: Record<string, string>;
    }): Promise<{ data: T }>;
};

type FailureOutcome = 'not_started' | 'confirmed_failed' | 'unknown';

type SafeFailure = {
    ok: false;
    outcome: FailureOutcome;
    error: {
        code: string;
        message: string;
        retryable: boolean;
    };
};

const SAFE_ERRORS = {
    mail_connection_invalid: 'The Yandex Mail connection is not configured for OAuth2 and a full mailbox address.',
    mail_bridge_configuration_invalid: 'The mail bridge runtime configuration is invalid.',
    mail_bridge_request_failed: 'The bridge request could not be completed.',
    mail_bridge_response_invalid: 'The mail bridge returned an invalid response.',
    mail_bridge_outcome_unknown: 'The bridge call may have reached the mail provider; inspect delivery state before retrying.'
} as const;

function failure(outcome: FailureOutcome, code: keyof typeof SAFE_ERRORS, retryable: boolean): SafeFailure {
    return {
        ok: false,
        outcome,
        error: {
            code,
            message: SAFE_ERRORS[code],
            retryable
        }
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readConnection(value: unknown): { mailbox: string } | null {
    if (!isRecord(value) || !isRecord(value.credentials) || !isRecord(value.connection_config)) {
        return null;
    }
    const credentials = value.credentials;
    if (
        credentials.type !== 'OAUTH2' ||
        typeof credentials.access_token !== 'string' ||
        credentials.access_token.length === 0
    ) {
        return null;
    }
    const parsedMailbox = mailboxSchema.safeParse(value.connection_config.mailbox);
    return parsedMailbox.success ? { mailbox: parsedMailbox.data } : null;
}

function readBridgeConfig(value: EnvironmentVariable[] | null): { origin: string; secret: string } | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const values = new Map<string, string>();
    for (const entry of value) {
        if (
            (entry.name === 'MAIL_BRIDGE_ORIGIN' || entry.name === 'MAIL_BRIDGE_HMAC_SECRET') &&
            values.has(entry.name)
        ) {
            return null;
        }
        values.set(entry.name, entry.value);
    }
    const originValue = values.get('MAIL_BRIDGE_ORIGIN');
    const secret = values.get('MAIL_BRIDGE_HMAC_SECRET');
    if (typeof originValue !== 'string' || typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
        return null;
    }

    try {
        const parsed = new URL(originValue);
        if (
            parsed.protocol !== 'https:' ||
            parsed.username !== '' ||
            parsed.password !== '' ||
            parsed.search !== '' ||
            parsed.hash !== '' ||
            parsed.pathname !== '/' ||
            (originValue !== parsed.origin && originValue !== `${parsed.origin}/`)
        ) {
            return null;
        }
        return { origin: parsed.origin, secret };
    } catch {
        return null;
    }
}

export function buildSignedBridgeRequest(input: {
    path: string;
    body: string;
    secret: string;
    timestampSeconds?: number;
    nonce?: string;
}): { canonical: string; headers: Record<string, string> } {
    const timestampSeconds = input.timestampSeconds ?? Math.floor(Date.now() / 1000);
    const nonce = input.nonce ?? randomBytes(16).toString('hex');
    const bodyDigest = createHash('sha256').update(input.body).digest('hex');
    const canonical = ['v1', 'POST', input.path, String(timestampSeconds), nonce, bodyDigest].join('\n');
    const signature = createHmac('sha256', input.secret).update(canonical).digest('hex');
    return {
        canonical,
        headers: {
            'Content-Type': 'application/json',
            'X-Mail-Bridge-Body-SHA256': bodyDigest,
            'X-Mail-Bridge-Nonce': nonce,
            'X-Mail-Bridge-Signature': signature,
            'X-Mail-Bridge-Timestamp': String(timestampSeconds),
            'X-Mail-Bridge-Version': 'v1'
        }
    };
}

export async function callMailBridge<T extends z.ZodTypeAny>(input: {
    nango: NangoRuntime;
    path: string;
    payload: unknown;
    output: T;
    mutating: boolean;
}): Promise<z.infer<T> | SafeFailure> {
    let resolvedConnection: { mailbox: string } | null;
    let bridgeConfig: { origin: string; secret: string } | null;
    try {
        resolvedConnection = readConnection(await input.nango.getConnection());
    } catch {
        resolvedConnection = null;
    }
    if (!resolvedConnection) {
        return failure('not_started', 'mail_connection_invalid', false);
    }

    try {
        bridgeConfig = readBridgeConfig(await input.nango.getEnvironmentVariables());
    } catch {
        bridgeConfig = null;
    }
    if (!bridgeConfig) {
        return failure('not_started', 'mail_bridge_configuration_invalid', false);
    }

    const body = JSON.stringify({ mailbox: resolvedConnection.mailbox, payload: input.payload });
    const signed = buildSignedBridgeRequest({
        path: input.path,
        body,
        secret: bridgeConfig.secret
    });

    try {
        const response = await input.nango.post({
            endpoint: input.path,
            baseUrlOverride: bridgeConfig.origin,
            retries: 0,
            forwardHeadersOnRedirect: false,
            data: body,
            headers: signed.headers
        });
        const parsed = input.output.safeParse(response.data);
        if (parsed.success) {
            return parsed.data;
        }
        return failure(
            input.mutating ? 'unknown' : 'confirmed_failed',
            input.mutating ? 'mail_bridge_outcome_unknown' : 'mail_bridge_response_invalid',
            false
        );
    } catch (error) {
        if (
            isRecord(error) &&
            isRecord(error.response) &&
            Number.isInteger(error.response.status) &&
            (error.response.status as number) >= 400 &&
            (error.response.status as number) <= 599
        ) {
            const parsed = input.output.safeParse(error.response.data);
            if (parsed.success && isRecord(parsed.data) && parsed.data.ok === false) {
                return parsed.data;
            }
        }
        return failure(
            input.mutating ? 'unknown' : 'confirmed_failed',
            input.mutating ? 'mail_bridge_outcome_unknown' : 'mail_bridge_request_failed',
            !input.mutating
        );
    }
}
