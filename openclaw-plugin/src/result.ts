import type { ProviderKey } from "./catalog.js";
import type { HttpMethod } from "./validation.js";

const MAX_ERROR_MESSAGE_BYTES = 256;
const MAX_RESPONSE_HEADER_BYTES = 16_384;
const STABLE_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const SAFE_RESPONSE_HEADERS = new Set([
  "etag",
  "last-modified",
  "link",
  "request-id",
  "retry-after",
  "x-correlation-id",
  "x-next-page",
  "x-page",
  "x-per-page",
  "x-request-id",
  "x-total",
  "x-total-count",
]);
const SAFE_RESPONSE_HEADER_PREFIXES = [
  "ratelimit-",
  "x-pagination-",
  "x-ratelimit-",
] as const;

export const OUTCOMES = Object.freeze([
  "confirmed",
  "confirmed_failed",
  "not_started",
  "unknown",
] as const);
export type Outcome = (typeof OUTCOMES)[number];

export const ERROR_LAYERS = Object.freeze([
  "validation",
  "approval",
  "cloudru_proxy",
  "nango",
  "provider",
  "unknown_upstream",
  "network",
  "local_io",
] as const);
export type ErrorLayer = (typeof ERROR_LAYERS)[number];

const ERROR_LAYER_SET = new Set<string>(ERROR_LAYERS);
const FAILURE_OUTCOME_SET = new Set<Outcome>([
  "confirmed_failed",
  "not_started",
  "unknown",
]);

export type JsonPrimitive = null | boolean | number | string;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export interface JsonArray extends ReadonlyArray<JsonValue> {}
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type BinaryBodySummary = Readonly<{
  kind: "binary";
  size: number;
  contentType: string;
  sha256: string;
}>;

export type ResponseBody = JsonValue | BinaryBodySummary;

export type RequestSummary = Readonly<{
  providerConfigKey: ProviderKey;
  method: HttpMethod;
  path: string;
}>;

export type ResponseSummary = Readonly<{
  status: number;
  contentType: string;
  headers: Readonly<Record<string, string>>;
  body: ResponseBody;
}>;

export type SuccessResult = Readonly<{
  ok: true;
  request: RequestSummary;
  response: ResponseSummary;
  outcome: "confirmed";
}>;

export type FailureOutcome = Exclude<Outcome, "confirmed">;

export type FailureError = Readonly<{
  layer: ErrorLayer;
  code: string;
  message: string;
  status?: number;
  retryable: boolean;
}>;

export type FailureResult = Readonly<{
  ok: false;
  request: RequestSummary;
  error: FailureError;
  outcome: FailureOutcome;
}>;

export type ToolResult = SuccessResult | FailureResult;

export type FailureDescriptor = Readonly<{
  layer: ErrorLayer;
  code: string;
  message: string;
  status?: number;
  retryable: boolean;
  outcome: FailureOutcome;
}>;

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function boundedMessage(value: string): string {
  const encoded = utf8Bytes(value);
  if (encoded.byteLength <= MAX_ERROR_MESSAGE_BYTES) {
    return value;
  }
  let bounded = "";
  let size = 0;
  for (const character of value) {
    const characterBytes = utf8Bytes(character).byteLength;
    if (size + characterBytes > MAX_ERROR_MESSAGE_BYTES) {
      break;
    }
    bounded += character;
    size += characterBytes;
  }
  return bounded;
}

function invalidFailureDescriptor(): never {
  throw new Error("invalid_failure_descriptor");
}

export function createSuccessResult(
  request: RequestSummary,
  response: ResponseSummary,
): SuccessResult {
  return Object.freeze({
    ok: true,
    request,
    response,
    outcome: "confirmed",
  });
}

export function createFailureResult(
  request: RequestSummary,
  descriptor: FailureDescriptor,
): FailureResult {
  if (
    !ERROR_LAYER_SET.has(descriptor.layer) ||
    !FAILURE_OUTCOME_SET.has(descriptor.outcome) ||
    !STABLE_CODE_RE.test(descriptor.code) ||
    typeof descriptor.message !== "string" ||
    CONTROL_RE.test(descriptor.message) ||
    typeof descriptor.retryable !== "boolean" ||
    (descriptor.status !== undefined &&
      (!Number.isInteger(descriptor.status) ||
        descriptor.status < 100 ||
        descriptor.status > 599))
  ) {
    invalidFailureDescriptor();
  }

  const error = Object.freeze({
    layer: descriptor.layer,
    code: descriptor.code,
    message: boundedMessage(descriptor.message),
    ...(descriptor.status === undefined
      ? {}
      : { status: descriptor.status }),
    retryable: descriptor.retryable,
  });
  return Object.freeze({
    ok: false,
    request,
    error,
    outcome: descriptor.outcome,
  });
}

function isSafeResponseHeader(name: string): boolean {
  return (
    SAFE_RESPONSE_HEADERS.has(name) ||
    SAFE_RESPONSE_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

export function filterResponseHeaders(
  headers: Headers,
): Readonly<Record<string, string>> {
  const projected: Record<string, string> = {};
  let totalBytes = 0;
  for (const [rawName, rawValue] of headers.entries()) {
    const name = rawName.toLowerCase();
    if (
      !isSafeResponseHeader(name) ||
      CONTROL_RE.test(name) ||
      CONTROL_RE.test(rawValue)
    ) {
      continue;
    }
    const entryBytes =
      utf8Bytes(name).byteLength + utf8Bytes(rawValue).byteLength;
    if (
      entryBytes > MAX_RESPONSE_HEADER_BYTES ||
      totalBytes + entryBytes > MAX_RESPONSE_HEADER_BYTES
    ) {
      continue;
    }
    Object.defineProperty(projected, name, {
      value: rawValue,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    totalBytes += entryBytes;
  }
  return Object.freeze(projected);
}
