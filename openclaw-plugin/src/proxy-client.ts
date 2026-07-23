import { createHash } from "node:crypto";

import {
  validateProviderKey,
  type ProviderKey,
} from "./catalog.js";
import type { RuntimeConfig } from "./config.js";
import {
  containsConfiguredSecret,
  createFailureResult,
  createSuccessResult,
  filterResponseHeaders,
  type FailureResult,
  type JsonValue,
  type RequestSummary,
  type ResponseBody,
  type ToolResult,
} from "./result.js";
import {
  encodeOrderedQuery,
  validateHttpMethod,
  validateProviderHeaders,
  validateRelativeProviderPath,
  type HttpMethod,
  type QueryPair,
  type ValidatedRequestBody,
} from "./validation.js";

const INVALID_REQUEST_SUMMARY: RequestSummary = Object.freeze({
  providerConfigKey: "yandex-id",
  method: "GET",
  path: "<invalid>",
});
const MAX_CONTENT_TYPE_BYTES = 256;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MEDIA_TYPE_RE =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:[ ]*;[ ]*[\x20-\x7e]+)?$/;
const REDIRECT_STATUSES = new Set([
  300,
  301,
  302,
  303,
  305,
  306,
  307,
  308,
]);

export type ProxyRequest = Readonly<{
  providerConfigKey: ProviderKey;
  /** Trusted internal classification; this field must not be model-controlled. */
  operationKind: "read" | "mutation";
  method: HttpMethod;
  path: string;
  query?: readonly QueryPair[];
  headers?: Readonly<Record<string, string>>;
  body?: ValidatedRequestBody;
  timeoutMs?: number;
}>;

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ProxyClientDependencies = Readonly<{
  fetch: FetchLike;
  monotonicNow?: () => number;
  wallNow?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}>;

export type ProxyClient = Readonly<{
  request(request: ProxyRequest): Promise<ToolResult>;
}>;

type NormalizedRequest = Readonly<{
  providerConfigKey: ProviderKey;
  operationKind: "read" | "mutation";
  method: HttpMethod;
  path: string;
  queryString: string;
  headers: Readonly<Record<string, string>>;
  body?: ValidatedRequestBody;
  timeoutMs: number;
  summary: RequestSummary;
}>;

function encodeRfc3986Component(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function deriveConnectionId(config: RuntimeConfig): string {
  return (
    `project-${config.cloudru.projectId}` +
    `-evoclaw-${config.cloudru.evoClawId}`
  );
}

function normalizeTimeout(
  value: number | undefined,
  config: RuntimeConfig,
): number {
  if (value === undefined) {
    return config.transport.defaultTimeoutMs;
  }
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > config.transport.maxTimeoutMs
  ) {
    throw new Error("invalid_timeout");
  }
  return value;
}

function snapshotValidatedBody(
  body: ValidatedRequestBody | undefined,
  maxBytes: number,
): ValidatedRequestBody | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (
    !["json", "text", "base64"].includes(body.kind) ||
    typeof body.contentType !== "string" ||
    new TextEncoder().encode(body.contentType).byteLength >
      MAX_CONTENT_TYPE_BYTES ||
    !MEDIA_TYPE_RE.test(body.contentType) ||
    (body.kind === "json" &&
      body.contentType !== "application/json") ||
    !(body.bytes instanceof Uint8Array) ||
    !Number.isSafeInteger(body.size) ||
    body.size < 0 ||
    body.size !== body.bytes.byteLength ||
    body.size > maxBytes
  ) {
    throw new Error("invalid_body");
  }
  return Object.freeze({
    kind: body.kind,
    contentType: body.contentType,
    bytes: Uint8Array.from(body.bytes),
    size: body.size,
  });
}

function normalizeRequest(
  config: RuntimeConfig,
  request: ProxyRequest,
): NormalizedRequest {
  const providerConfigKey = validateProviderKey(request.providerConfigKey);
  if (
    request.operationKind !== "read" &&
    request.operationKind !== "mutation"
  ) {
    throw new Error("invalid_operation_kind");
  }
  const method = validateHttpMethod(request.method);
  const path = validateRelativeProviderPath(request.path);
  const queryString = encodeOrderedQuery(request.query ?? []);
  const headers = validateProviderHeaders(request.headers ?? {});
  const body = snapshotValidatedBody(
    request.body,
    config.transport.maxRequestBytes,
  );
  if ((method === "GET" || method === "HEAD") && body !== undefined) {
    throw new Error("invalid_body");
  }
  const summary = Object.freeze({
    providerConfigKey,
    method,
    path,
  });
  return Object.freeze({
    providerConfigKey,
    operationKind: request.operationKind,
    method,
    path,
    queryString,
    headers,
    ...(body === undefined ? {} : { body }),
    timeoutMs: normalizeTimeout(request.timeoutMs, config),
    summary,
  });
}

function buildNormalizedProxyUrl(
  config: RuntimeConfig,
  request: Pick<
    NormalizedRequest,
    "providerConfigKey" | "path" | "queryString"
  >,
): string {
  const url =
    `${config.cloudru.proxyBaseUrl}/api/v1/` +
    `${encodeRfc3986Component(config.cloudru.projectId)}/evo-claws/` +
    `${encodeRfc3986Component(config.cloudru.evoClawId)}/proxy/` +
    `${encodeRfc3986Component(request.providerConfigKey)}/${request.path}`;
  return request.queryString.length === 0
    ? url
    : `${url}?${request.queryString}`;
}

export function buildProxyUrl(
  config: RuntimeConfig,
  request: Pick<
    ProxyRequest,
    "providerConfigKey" | "method" | "path" | "query"
  >,
): string {
  const providerConfigKey = validateProviderKey(request.providerConfigKey);
  validateHttpMethod(request.method);
  const path = validateRelativeProviderPath(request.path);
  const queryString = encodeOrderedQuery(request.query ?? []);
  return buildNormalizedProxyUrl(config, {
    providerConfigKey,
    path,
    queryString,
  });
}

function validationFailure(): FailureResult {
  return createFailureResult(INVALID_REQUEST_SUMMARY, {
    layer: "validation",
    code: "invalid_request",
    message: "Request validation failed",
    retryable: false,
    outcome: "not_started",
  });
}

function safeContentType(headers: Headers): string {
  const value = headers.get("content-type")?.trim() ?? "";
  if (
    CONTROL_RE.test(value) ||
    new TextEncoder().encode(value).byteLength > MAX_CONTENT_TYPE_BYTES
  ) {
    return "";
  }
  return value;
}

function isJsonMediaType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType === "application/json" || mediaType.endsWith("+json")
  );
}

function isTextMediaType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType.length === 0 ||
    mediaType.startsWith("text/") ||
    mediaType === "application/javascript" ||
    mediaType === "application/xml" ||
    mediaType.endsWith("+xml")
  );
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) {
    return false;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

class ResponseTooLargeError extends Error {}
class InvalidJsonResponseError extends Error {}
class OperationDeadlineError extends Error {}
class AttemptTimeoutError extends Error {}

type TimerApi = Readonly<{
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}>;

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("operation_aborted");
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }

    promise.then(
      (value) => {
        if (settled) {
          onLateValue?.(value);
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function bestEffortCancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best-effort and its error is never exposed.
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const retained = new Uint8Array(maxBytes + 1);
  let size = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await raceWithAbort(
        reader.read(),
        signal,
      );
      if (done) {
        completed = true;
        break;
      }
      const remaining = maxBytes + 1 - size;
      const retainedLength = Math.min(value.byteLength, remaining);
      if (retainedLength > 0) {
        retained.set(value.subarray(0, retainedLength), size);
        size += retainedLength;
      }
      if (size > maxBytes) {
        throw new ResponseTooLargeError();
      }
    }
  } finally {
    if (!completed) {
      bestEffortCancelReader(reader);
    }
    reader.releaseLock();
  }
  return retained.subarray(0, size);
}

function parseResponseBody(
  bytes: Uint8Array,
  contentType: string,
): ResponseBody {
  if (bytes.byteLength === 0) {
    return null;
  }
  if (isJsonMediaType(contentType)) {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new InvalidJsonResponseError();
    }
    if (!isJsonValue(value)) {
      throw new InvalidJsonResponseError();
    }
    return value;
  }
  if (isTextMediaType(contentType)) {
    return new TextDecoder().decode(bytes);
  }
  return Object.freeze({
    kind: "binary",
    size: bytes.byteLength,
    contentType: contentType || "application/octet-stream",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function cancelResponseBody(response: Response): void {
  if (response.body === null) {
    return;
  }
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best-effort and its error is never exposed.
  }
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 ||
    (status >= 500 && status <= 599);
}

function isAmbiguousMutationStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function responseFailure(
  request: RequestSummary,
  status: number,
  operationKind: NormalizedRequest["operationKind"],
): FailureResult {
  const isRedirect = REDIRECT_STATUSES.has(status);
  const transientRead =
    operationKind === "read" && isTransientStatus(status);
  return createFailureResult(request, {
    layer: "unknown_upstream",
    code: isRedirect ? "redirect_blocked" : "upstream_http_error",
    message: isRedirect
      ? "Credentialed redirect was blocked"
      : "Upstream request failed",
    status,
    retryable: transientRead,
    outcome:
      operationKind === "mutation" && isAmbiguousMutationStatus(status)
      ? "unknown"
      : "confirmed_failed",
  });
}

function responseParseFailure(
  request: RequestSummary,
  code:
    | "invalid_json_response"
    | "response_too_large"
    | "secret_in_response",
  operationKind: NormalizedRequest["operationKind"],
  status: number,
): FailureResult {
  return createFailureResult(request, {
    layer: "unknown_upstream",
    code,
    message:
      code === "response_too_large"
        ? "Upstream response exceeded the configured limit"
        : code === "secret_in_response"
          ? "Upstream response contained a configured secret"
          : "Upstream JSON response was invalid",
    status,
    retryable: false,
    outcome: operationKind === "read"
      ? "confirmed_failed"
      : "unknown",
  });
}

function networkFailure(
  request: RequestSummary,
  operationKind: NormalizedRequest["operationKind"],
  code: "network_error" | "request_timeout" | "response_stream_error",
  status?: number,
): FailureResult {
  const read = operationKind === "read";
  return createFailureResult(request, {
    layer: "network",
    code,
    message: code === "request_timeout"
      ? "Upstream request timed out"
      : code === "response_stream_error"
      ? "Response stream failed"
      : "Network request failed",
    ...(status === undefined ? {} : { status }),
    retryable: read,
    outcome: read ? "confirmed_failed" : "unknown",
  });
}

function deadlineFailure(
  request: RequestSummary,
  operationKind: NormalizedRequest["operationKind"],
  dispatched: boolean,
  status?: number,
): FailureResult {
  return createFailureResult(request, {
    layer: "network",
    code: "operation_deadline",
    message: "Operation deadline exceeded",
    ...(status === undefined ? {} : { status }),
    retryable: false,
    outcome: !dispatched
      ? "not_started"
      : operationKind === "read"
      ? "confirmed_failed"
      : "unknown",
  });
}

function runtimeSetupFailure(request: RequestSummary): FailureResult {
  return createFailureResult(request, {
    layer: "cloudru_proxy",
    code: "invalid_runtime_transport",
    message: "Runtime transport setup failed",
    retryable: false,
    outcome: "not_started",
  });
}

function exponentialBackoffMs(
  attempt: number,
  initialBackoffMs: number,
  maxBackoffMs: number,
): number {
  return Math.min(
    maxBackoffMs,
    initialBackoffMs * 2 ** Math.max(0, attempt - 1),
  );
}

function retryAfterMs(
  response: Response | undefined,
  attempt: number,
  initialBackoffMs: number,
  maxBackoffMs: number,
  wallNow: () => number,
): number {
  const fallback = exponentialBackoffMs(
    attempt,
    initialBackoffMs,
    maxBackoffMs,
  );
  const value = response?.headers.get("retry-after")?.trim();
  if (value === undefined || value.length === 0) {
    return fallback;
  }

  let requested: number;
  if (/^[0-9]+$/.test(value)) {
    requested = Number(value) * 1_000;
  } else {
    const date = Date.parse(value);
    if (!Number.isFinite(date)) {
      return fallback;
    }
    requested = Math.max(0, date - wallNow());
  }
  if (!Number.isFinite(requested)) {
    return maxBackoffMs;
  }
  return Math.min(maxBackoffMs, requested);
}

function waitForRetry(
  delayMs: number,
  signal: AbortSignal,
  timers: TimerApi,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      timers.clearTimer(timer);
      reject(abortReason(signal));
    };
    const timer = timers.setTimer(finish, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

function makeRequestInit(
  request: NormalizedRequest,
  headers: Headers,
  signal: AbortSignal,
): RequestInit {
  return {
    method: request.method,
    headers,
    ...(request.body === undefined
      ? {}
      : { body: Uint8Array.from(request.body.bytes).buffer }),
    redirect: "manual",
    signal,
  };
}

export function createProxyClient(
  config: RuntimeConfig,
  dependencies: ProxyClientDependencies,
): ProxyClient {
  const monotonicNow = dependencies.monotonicNow ??
    (() => performance.now());
  const wallNow = dependencies.wallNow ?? (() => Date.now());
  const timers: TimerApi = {
    setTimer: dependencies.setTimer ??
      ((callback, delayMs) => setTimeout(callback, delayMs)),
    clearTimer: dependencies.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
  };

  return Object.freeze({
    async request(request: ProxyRequest): Promise<ToolResult> {
      const operationStartedAt = monotonicNow();
      let normalized: NormalizedRequest;
      try {
        normalized = normalizeRequest(config, request);
      } catch {
        return validationFailure();
      }

      let headers: Headers;
      let url: string;
      try {
        headers = new Headers(normalized.headers);
        if (normalized.body !== undefined) {
          headers.set("content-type", normalized.body.contentType);
        }
        headers.set(
          "authorization",
          `Api-Key ${config.cloudru.apiKey}`,
        );
        url = buildNormalizedProxyUrl(config, normalized);
      } catch {
        return runtimeSetupFailure(normalized.summary);
      }

      const operationDeadlineAt =
        operationStartedAt + config.transport.operationDeadlineMs;
      const operationController = new AbortController();
      let dispatched = false;
      let operationTimer: unknown;
      try {
        const initialRemaining = Math.max(
          0,
          operationDeadlineAt - monotonicNow(),
        );
        if (initialRemaining <= 0) {
          return deadlineFailure(
            normalized.summary,
            normalized.operationKind,
            false,
          );
        }
        operationTimer = timers.setTimer(() => {
          operationController.abort(new OperationDeadlineError());
        }, initialRemaining);

        const read = normalized.operationKind === "read";
        const maxAttempts = read ? config.transport.readAttempts : 1;
        const waitForNextAttempt = async (
          attempt: number,
          response?: Response,
        ): Promise<boolean> => {
          const retryRemaining = Math.max(
            0,
            operationDeadlineAt - monotonicNow(),
          );
          if (
            retryRemaining <= 0 ||
            operationController.signal.aborted
          ) {
            return false;
          }
          const delay = Math.min(
            retryAfterMs(
              response,
              attempt,
              config.transport.initialBackoffMs,
              config.transport.maxBackoffMs,
              wallNow,
            ),
            retryRemaining,
          );
          try {
            await waitForRetry(
              delay,
              operationController.signal,
              timers,
            );
          } catch {
            return false;
          }
          return (
            !operationController.signal.aborted &&
            monotonicNow() < operationDeadlineAt
          );
        };

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const attemptStartedAt = monotonicNow();
          const remaining = Math.max(
            0,
            operationDeadlineAt - attemptStartedAt,
          );
          if (remaining <= 0 || operationController.signal.aborted) {
            return deadlineFailure(
              normalized.summary,
              normalized.operationKind,
              dispatched,
            );
          }

          const attemptController = new AbortController();
          const attemptSignal = AbortSignal.any([
            operationController.signal,
            attemptController.signal,
          ]);
          let attemptTimer: unknown;
          let attemptTimerActive = true;
          const attemptTimeoutMs = Math.min(
            normalized.timeoutMs,
            remaining,
          );
          const attemptDeadlineAt =
            attemptStartedAt + attemptTimeoutMs;
          const clearAttemptTimer = () => {
            if (!attemptTimerActive) {
              return;
            }
            attemptTimerActive = false;
            timers.clearTimer(attemptTimer);
          };
          attemptTimer = timers.setTimer(() => {
            attemptController.abort(new AttemptTimeoutError());
          }, attemptTimeoutMs);

          let response: Response | undefined;
          try {
            let fetchPromise: Promise<Response>;
            try {
              const init = makeRequestInit(
                normalized,
                new Headers(headers),
                attemptSignal,
              );
              dispatched = true;
              fetchPromise = Promise.resolve(
                dependencies.fetch(url, init),
              );
            } catch (error) {
              fetchPromise = Promise.reject(error);
            }
            response = await raceWithAbort(
              fetchPromise,
              attemptSignal,
              cancelResponseBody,
            );
          } catch {
            clearAttemptTimer();
            if (operationController.signal.aborted) {
              return deadlineFailure(
                normalized.summary,
                normalized.operationKind,
                dispatched,
              );
            }
            const timedOut = attemptController.signal.aborted;
            if (read && attempt < maxAttempts) {
              if (!(await waitForNextAttempt(attempt))) {
                return deadlineFailure(
                  normalized.summary,
                  normalized.operationKind,
                  dispatched,
                );
              }
              continue;
            }
            return networkFailure(
              normalized.summary,
              normalized.operationKind,
              timedOut ? "request_timeout" : "network_error",
            );
          }

          const afterDispatch = monotonicNow();
          if (
            operationController.signal.aborted ||
            afterDispatch >= operationDeadlineAt
          ) {
            cancelResponseBody(response);
            clearAttemptTimer();
            return deadlineFailure(
              normalized.summary,
              normalized.operationKind,
              dispatched,
            );
          }
          if (
            attemptController.signal.aborted ||
            afterDispatch >= attemptDeadlineAt
          ) {
            cancelResponseBody(response);
            clearAttemptTimer();
            if (
              read &&
              attempt < maxAttempts &&
              await waitForNextAttempt(attempt)
            ) {
              continue;
            }
            return networkFailure(
              normalized.summary,
              normalized.operationKind,
              "request_timeout",
            );
          }

          if (response.status < 200 || response.status >= 300) {
            const retryable =
              read && isTransientStatus(response.status);
            cancelResponseBody(response);
            clearAttemptTimer();
            if (retryable && attempt < maxAttempts) {
              if (!(await waitForNextAttempt(attempt, response))) {
                return deadlineFailure(
                  normalized.summary,
                  normalized.operationKind,
                  dispatched,
                );
              }
              continue;
            }
            return responseFailure(
              normalized.summary,
              response.status,
              normalized.operationKind,
            );
          }
          if (
            normalized.method === "HEAD" ||
            response.status === 204 ||
            response.status === 205
          ) {
            cancelResponseBody(response);
            clearAttemptTimer();
            const responseSummary = {
              status: response.status,
              contentType: safeContentType(response.headers),
              headers: filterResponseHeaders(response.headers),
              body: null,
            } as const;
            if (
              containsConfiguredSecret(
                responseSummary,
                [config.cloudru.apiKey],
              )
            ) {
              return responseParseFailure(
                normalized.summary,
                "secret_in_response",
                normalized.operationKind,
                response.status,
              );
            }
            return createSuccessResult(
              normalized.summary,
              responseSummary,
            );
          }

          const contentType = safeContentType(response.headers);
          let body: ResponseBody;
          try {
            const bytes = await readBoundedResponse(
              response,
              config.transport.maxResponseBytes,
              attemptSignal,
            );
            if (
              operationController.signal.aborted ||
              monotonicNow() >= operationDeadlineAt
            ) {
              clearAttemptTimer();
              return deadlineFailure(
                normalized.summary,
                normalized.operationKind,
                dispatched,
                response.status,
              );
            }
            body = parseResponseBody(bytes, contentType);
            if (monotonicNow() >= attemptDeadlineAt) {
              attemptController.abort(new AttemptTimeoutError());
              throw new AttemptTimeoutError();
            }
          } catch (error) {
            clearAttemptTimer();
            if (
              operationController.signal.aborted ||
              monotonicNow() >= operationDeadlineAt
            ) {
              return deadlineFailure(
                normalized.summary,
                normalized.operationKind,
                dispatched,
                response.status,
              );
            }
            if (
              attemptController.signal.aborted &&
              read &&
              attempt < maxAttempts
            ) {
              if (!(await waitForNextAttempt(attempt))) {
                return deadlineFailure(
                  normalized.summary,
                  normalized.operationKind,
                  dispatched,
                  response.status,
                );
              }
              continue;
            }
            if (error instanceof ResponseTooLargeError) {
              return responseParseFailure(
                normalized.summary,
                "response_too_large",
                normalized.operationKind,
                response.status,
              );
            }
            if (error instanceof InvalidJsonResponseError) {
              return responseParseFailure(
                normalized.summary,
                "invalid_json_response",
                normalized.operationKind,
                response.status,
              );
            }
            if (read && attempt < maxAttempts) {
              if (!(await waitForNextAttempt(attempt))) {
                return deadlineFailure(
                  normalized.summary,
                  normalized.operationKind,
                  dispatched,
                  response.status,
                );
              }
              continue;
            }
            return networkFailure(
              normalized.summary,
              normalized.operationKind,
              attemptController.signal.aborted
                ? "request_timeout"
                : "response_stream_error",
              response.status,
            );
          }

          clearAttemptTimer();
          if (
            operationController.signal.aborted ||
            monotonicNow() >= operationDeadlineAt
          ) {
            return deadlineFailure(
              normalized.summary,
              normalized.operationKind,
              dispatched,
              response.status,
            );
          }
          const responseSummary = {
            status: response.status,
            contentType,
            headers: filterResponseHeaders(response.headers),
            body,
          } as const;
          if (
            containsConfiguredSecret(
              responseSummary,
              [config.cloudru.apiKey],
            )
          ) {
            return responseParseFailure(
              normalized.summary,
              "secret_in_response",
              normalized.operationKind,
              response.status,
            );
          }
          return createSuccessResult(
            normalized.summary,
            responseSummary,
          );
        }
        return networkFailure(
          normalized.summary,
          normalized.operationKind,
          "network_error",
        );
      } finally {
        if (operationTimer !== undefined) {
          timers.clearTimer(operationTimer);
        }
      }
    },
  });
}
