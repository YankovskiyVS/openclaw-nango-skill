import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import { resolve } from 'node:path';
import { type Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import * as z from 'zod';

import {
    BridgeError,
    authenticateBridgeRequest,
    createConfiguredStore,
    type AtomicStateStore,
    type SafeOutcome
} from './auth.js';
import {
    MailService,
    getMessageRequestSchema,
    listMessagesRequestSchema,
    mailboxAddressSchema,
    resolveMailboxRequestSchema,
    sendMessageRequestSchema,
    type GetMessageRequest,
    type ListMessagesRequest,
    type SendMessageRequest
} from './mail.js';

export const MAX_RAW_BODY_BYTES = 2 * 1024 * 1024;

const PATHS = {
    resolveMailbox: '/v1/yandex-mail/resolve-mailbox',
    listMessages: '/v1/yandex-mail/list-messages',
    getMessage: '/v1/yandex-mail/get-message',
    sendMessage: '/v1/yandex-mail/send-message'
} as const;

type HeaderValue = string | string[] | undefined;

type BridgeRequest = {
    method: string;
    path: string;
    headers: Record<string, HeaderValue>;
    body: Buffer;
};

type SafeErrorEnvelope = {
    ok: false;
    outcome: SafeOutcome;
    error: {
        code: string;
        message: string;
        retryable: boolean;
    };
};

type BridgeResponse = {
    status: number;
    body:
        | SafeErrorEnvelope
        | {
              ok: true;
              outcome: 'confirmed';
              result: unknown;
          };
};

type MailOperations = {
    resolveMailbox(mailbox: string, accessToken: string): Promise<unknown>;
    listMessages(mailbox: string, accessToken: string, request: ListMessagesRequest): Promise<unknown>;
    getMessage(mailbox: string, accessToken: string, request: GetMessageRequest): Promise<unknown>;
    sendMessage(
        mailbox: string,
        accessToken: string,
        request: SendMessageRequest,
        bodyHash: string
    ): Promise<
        | { ok: true; outcome: 'confirmed'; result: unknown }
        | { ok: false; outcome: 'not_started' | 'unknown'; error: { code: string; message: string; retryable: boolean } }
    >;
};

function safeError(error: BridgeError): BridgeResponse {
    return {
        status: error.status,
        body: {
            ok: false,
            outcome: error.outcome,
            error: {
                code: error.code,
                message: error.message,
                retryable: error.retryable
            }
        }
    };
}

function invalidRequest(): BridgeResponse {
    return safeError(
        new BridgeError({
            code: 'request_invalid',
            message: 'The signed mail bridge request is invalid.',
            status: 400
        })
    );
}

function parseEnvelope<T extends z.ZodTypeAny>(
    value: unknown,
    payloadSchema: T
): { mailbox: string; payload: z.infer<T> } {
    const parsed = z
        .object({
            mailbox: mailboxAddressSchema,
            payload: payloadSchema
        })
        .strict()
        .parse(value);
    return parsed as { mailbox: string; payload: z.infer<T> };
}

export function createBridgeHandler(dependencies: {
    secret: string;
    store: AtomicStateStore;
    mail: MailOperations;
    nowSeconds?: () => number;
    parseJson?: (body: string) => unknown;
}): (request: BridgeRequest) => Promise<BridgeResponse> {
    const parseJson = dependencies.parseJson ?? JSON.parse;
    const supportedPaths = new Set<string>(Object.values(PATHS));

    return async (request) => {
        if (!supportedPaths.has(request.path)) {
            return safeError(
                new BridgeError({
                    code: 'route_not_found',
                    message: 'The requested mail bridge route does not exist.',
                    status: 404
                })
            );
        }

        let authenticated;
        try {
            authenticated = await authenticateBridgeRequest(request, {
                secret: dependencies.secret,
                store: dependencies.store,
                ...(dependencies.nowSeconds === undefined ? {} : { nowSeconds: dependencies.nowSeconds })
            });
        } catch (error) {
            return safeError(
                error instanceof BridgeError
                    ? error
                    : new BridgeError({
                          code: 'authentication_failed',
                          message: 'The bridge request could not be authenticated.',
                          status: 401
                      })
            );
        }

        let decoded: unknown;
        try {
            decoded = parseJson(request.body.toString('utf8'));
        } catch {
            return invalidRequest();
        }

        try {
            switch (request.path) {
                case PATHS.resolveMailbox: {
                    const parsed = parseEnvelope(decoded, resolveMailboxRequestSchema);
                    const result = await dependencies.mail.resolveMailbox(parsed.mailbox, authenticated.accessToken);
                    return { status: 200, body: { ok: true, outcome: 'confirmed', result } };
                }
                case PATHS.listMessages: {
                    const parsed = parseEnvelope(decoded, listMessagesRequestSchema);
                    const result = await dependencies.mail.listMessages(
                        parsed.mailbox,
                        authenticated.accessToken,
                        parsed.payload
                    );
                    return { status: 200, body: { ok: true, outcome: 'confirmed', result } };
                }
                case PATHS.getMessage: {
                    const parsed = parseEnvelope(decoded, getMessageRequestSchema);
                    const result = await dependencies.mail.getMessage(
                        parsed.mailbox,
                        authenticated.accessToken,
                        parsed.payload
                    );
                    return { status: 200, body: { ok: true, outcome: 'confirmed', result } };
                }
                case PATHS.sendMessage: {
                    const parsed = parseEnvelope(decoded, sendMessageRequestSchema);
                    const result = await dependencies.mail.sendMessage(
                        parsed.mailbox,
                        authenticated.accessToken,
                        parsed.payload,
                        authenticated.bodySha256
                    );
                    return { status: result.ok ? 200 : result.outcome === 'unknown' ? 202 : 409, body: result };
                }
                default:
                    return invalidRequest();
            }
        } catch (error) {
            if (error instanceof z.ZodError) {
                return invalidRequest();
            }
            if (error instanceof BridgeError) {
                return safeError(error);
            }
            return safeError(
                new BridgeError({
                    code: 'bridge_internal_error',
                    message: 'The mail bridge could not complete the request.',
                    status: 500,
                    outcome: request.path === PATHS.sendMessage ? 'unknown' : 'confirmed_failed'
                })
            );
        }
    };
}

export async function readBoundedBody(stream: Readable, maxBytes = MAX_RAW_BODY_BYTES): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string | Uint8Array);
        total += chunk.byteLength;
        if (total > maxBytes) {
            throw new BridgeError({
                code: 'request_too_large',
                message: 'The signed request body exceeds the bridge limit.',
                status: 413
            });
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, HeaderValue> {
    const normalized: Record<string, HeaderValue> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (typeof value === 'string' || Array.isArray(value)) {
            normalized[name.toLowerCase()] = value;
        }
    }
    return normalized;
}

function writeJson(response: import('node:http').ServerResponse, result: BridgeResponse): void {
    const serialized = JSON.stringify(result.body);
    response.writeHead(result.status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(serialized),
        'Cache-Control': 'no-store'
    });
    response.end(serialized);
}

function parsePort(value: string | undefined): number {
    const port = value === undefined ? 8080 : Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new BridgeError({
            code: 'port_invalid',
            message: 'MAIL_BRIDGE_PORT must be a valid TCP port.',
            status: 500
        });
    }
    return port;
}

function readSecret(value: string | undefined): string {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32) {
        throw new BridgeError({
            code: 'bridge_configuration_invalid',
            message: 'MAIL_BRIDGE_HMAC_SECRET must contain at least 32 bytes.',
            status: 500
        });
    }
    return value;
}

export async function startServer(
    environment: Record<string, string | undefined> = process.env
): Promise<{ server: Server; port: number }> {
    const secret = readSecret(environment.MAIL_BRIDGE_HMAC_SECRET);
    const store = await createConfiguredStore(environment);
    const mail = new MailService({ store });
    const handler = createBridgeHandler({ secret, store, mail });
    const port = parsePort(environment.MAIL_BRIDGE_PORT);
    const bindAddress = environment.MAIL_BRIDGE_BIND_ADDRESS ?? '0.0.0.0';

    const server = createServer(async (request, response) => {
        try {
            const contentLength = request.headers['content-length'];
            if (contentLength !== undefined && (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > MAX_RAW_BODY_BYTES)) {
                throw new BridgeError({
                    code: 'request_too_large',
                    message: 'The signed request body exceeds the bridge limit.',
                    status: 413
                });
            }
            const path = exactPath(request);
            const body = await readBoundedBody(request, MAX_RAW_BODY_BYTES);
            const result = await handler({
                method: request.method ?? '',
                path,
                headers: normalizeHeaders(request.headers),
                body
            });
            writeJson(response, result);
        } catch (error) {
            writeJson(
                response,
                safeError(
                    error instanceof BridgeError
                        ? error
                        : new BridgeError({
                              code: 'bridge_internal_error',
                              message: 'The mail bridge could not complete the request.',
                              status: 500
                          })
                )
            );
        }
    });

    await new Promise<void>((resolveListening, rejectListening) => {
        server.once('error', rejectListening);
        server.listen(port, bindAddress, () => {
            server.off('error', rejectListening);
            resolveListening();
        });
    });
    return { server, port };
}

function exactPath(request: IncomingMessage): string {
    const requestTarget = request.url;
    if (!requestTarget || requestTarget.includes('?') || requestTarget.includes('#')) {
        throw new BridgeError({
            code: 'request_invalid',
            message: 'The request target must be an exact bridge path.',
            status: 400
        });
    }
    return requestTarget;
}

const isMain =
    process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
    startServer()
        .then(({ port }) => {
            process.stdout.write(`mail-bridge listening on port ${port}\n`);
        })
        .catch((error: unknown) => {
            const code = error instanceof BridgeError ? error.code : 'startup_failed';
            process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
            process.exitCode = 1;
        });
}
