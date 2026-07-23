const MAX_ROUTING_BYTES = 4_096;
const MAX_HEADER_BYTES = 16_384;
const MAX_HEADER_NAME_BYTES = 256;
const MAX_HEADER_VALUE_BYTES = 8_192;
const HARD_MAX_BODY_BYTES = 16 * 1_024 * 1_024;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const PERCENT_ESCAPE_RE = /%(?![0-9A-Fa-f]{2})/;
const REMAINING_ESCAPE_RE = /%[0-9A-Fa-f]{2}/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE_RE = /^[\t\x20-\x7e]*$/;
const MEDIA_TYPE_RE =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:[ ]*;[ ]*[\x20-\x7e]+)?$/;
const BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BLOCKED_HEADERS = new Set([
  "api-key",
  "authorization",
  "base-url-override",
  "connection",
  "connection-id",
  "content-length",
  "cookie",
  "decompress",
  "forward-headers-on-redirect",
  "host",
  "keep-alive",
  "nango-activity-log-id",
  "nango-is-dry-run",
  "nango-is-sync",
  "proxy-authorization",
  "proxy-connection",
  "provider-config-key",
  "retries",
  "retry-on",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
]);
const BLOCKED_HEADER_PREFIXES = [
  "x-cloud-ru-",
  "x-cloudru-",
  "x-evoclaw-",
  "x-evolution-",
  "x-nango-",
] as const;
const NANGO_PASSTHROUGH_HEADER_PREFIX = "nango-proxy-";

export const HTTP_METHODS = Object.freeze([
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "PROPFIND",
  "REPORT",
] as const);
export type HttpMethod = (typeof HTTP_METHODS)[number];
const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);
const READ_METHOD_SET = new Set<HttpMethod>([
  "GET",
  "HEAD",
  "OPTIONS",
  "PROPFIND",
  "REPORT",
]);

export class ValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ValidationError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new ValidationError(code);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function encodeRfc3986Component(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function decodePathSegment(rawSegment: string): string {
  if (PERCENT_ESCAPE_RE.test(rawSegment)) {
    fail("invalid_path_encoding");
  }

  let decoded = rawSegment;
  for (let depth = 0; depth < 4; depth += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      fail("invalid_path_encoding");
    }
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  if (REMAINING_ESCAPE_RE.test(decoded)) {
    fail("unsafe_path_segment");
  }
  return decoded;
}

export function validateRelativeProviderPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8Bytes(value) > MAX_ROUTING_BYTES ||
    CONTROL_RE.test(value) ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    SCHEME_RE.test(value) ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\")
  ) {
    fail("invalid_path");
  }

  const rawSegments = value.split("/");
  const hasTrailingSlash = rawSegments.at(-1) === "";
  if (hasTrailingSlash) {
    rawSegments.pop();
  }
  if (rawSegments.length === 0) {
    fail("invalid_path");
  }

  const canonicalSegments = rawSegments.map((rawSegment) => {
    if (rawSegment.length === 0) {
      fail("unsafe_path_segment");
    }
    const decoded = decodePathSegment(rawSegment);
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\")
    ) {
      fail("unsafe_path_segment");
    }
    if (CONTROL_RE.test(decoded)) {
      fail("invalid_path");
    }
    try {
      return encodeRfc3986Component(decoded);
    } catch {
      fail("invalid_path_encoding");
    }
  });

  const canonical = canonicalSegments.join("/");
  return hasTrailingSlash ? `${canonical}/` : canonical;
}

export type QueryPair = Readonly<{
  name: string;
  value: string;
}>;

export function validateHttpMethod(value: unknown): HttpMethod {
  if (typeof value !== "string") {
    fail("invalid_method");
  }
  const normalized = value.toUpperCase();
  if (!HTTP_METHOD_SET.has(normalized)) {
    fail("invalid_method");
  }
  return normalized as HttpMethod;
}

export function isReadMethod(method: HttpMethod): boolean {
  return READ_METHOD_SET.has(method);
}

export function encodeOrderedQuery(value: unknown): string {
  if (!Array.isArray(value)) {
    fail("invalid_query");
  }

  const encodedPairs: string[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ["name", "value"]) ||
      typeof candidate.name !== "string" ||
      candidate.name.length === 0 ||
      typeof candidate.value !== "string" ||
      CONTROL_RE.test(candidate.name) ||
      CONTROL_RE.test(candidate.value)
    ) {
      fail("invalid_query");
    }
    try {
      encodedPairs.push(
        `${encodeRfc3986Component(candidate.name)}=${encodeRfc3986Component(candidate.value)}`,
      );
    } catch {
      fail("invalid_query");
    }
  }

  const encoded = encodedPairs.join("&");
  if (utf8Bytes(encoded) > MAX_ROUTING_BYTES) {
    fail("query_too_large");
  }
  return encoded;
}

export function validateProviderHeaders(
  value: unknown,
): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    fail("invalid_headers");
  }

  const validated: Record<string, string> = {};
  let totalBytes = 0;
  for (const [name, candidateValue] of Object.entries(value)) {
    if (
      !HEADER_NAME_RE.test(name) ||
      utf8Bytes(name) > MAX_HEADER_NAME_BYTES ||
      typeof candidateValue !== "string" ||
      !HEADER_VALUE_RE.test(candidateValue) ||
      utf8Bytes(candidateValue) > MAX_HEADER_VALUE_BYTES
    ) {
      fail("invalid_header");
    }

    const normalizedName = name.toLowerCase();
    let effectiveName = normalizedName;
    while (effectiveName.startsWith(NANGO_PASSTHROUGH_HEADER_PREFIX)) {
      effectiveName = effectiveName.slice(
        NANGO_PASSTHROUGH_HEADER_PREFIX.length,
      );
      if (effectiveName.length === 0) {
        fail("blocked_header");
      }
    }
    if (
      BLOCKED_HEADERS.has(effectiveName) ||
      BLOCKED_HEADER_PREFIXES.some((prefix) =>
        effectiveName.startsWith(prefix),
      )
    ) {
      fail("blocked_header");
    }
    if (Object.hasOwn(validated, normalizedName)) {
      fail("duplicate_header");
    }

    totalBytes += utf8Bytes(normalizedName) + utf8Bytes(candidateValue);
    if (totalBytes > MAX_HEADER_BYTES) {
      fail("headers_too_large");
    }
    Object.defineProperty(validated, normalizedName, {
      value: candidateValue,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }

  return Object.freeze(validated);
}

function assertJsonValue(
  value: unknown,
  seen: Set<object>,
  depth: number,
): void {
  if (depth > 64) {
    fail("invalid_json_body");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("invalid_json_body");
    }
    return;
  }
  if (typeof value !== "object") {
    fail("invalid_json_body");
  }
  if (seen.has(value)) {
    fail("invalid_json_body");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertJsonValue(item, seen, depth + 1);
    }
  } else {
    if (!isRecord(value)) {
      fail("invalid_json_body");
    }
    for (const item of Object.values(value)) {
      assertJsonValue(item, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function validateContentType(value: unknown): string {
  if (
    typeof value !== "string" ||
    utf8Bytes(value) > 256 ||
    !MEDIA_TYPE_RE.test(value)
  ) {
    fail("invalid_content_type");
  }
  return value;
}

function decodeCanonicalBase64(value: unknown): Uint8Array {
  if (typeof value !== "string" || !BASE64_RE.test(value)) {
    fail("invalid_base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    fail("invalid_base64");
  }
  return new Uint8Array(bytes);
}

export type ValidatedRequestBody = Readonly<{
  kind: "json" | "text" | "base64";
  contentType: string;
  bytes: Uint8Array;
  size: number;
}>;

export function validateRequestBody(
  value: unknown,
  maxBytes: number,
): ValidatedRequestBody | undefined {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > HARD_MAX_BODY_BYTES
  ) {
    fail("invalid_body_limit");
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "jsonBody",
      "textBody",
      "base64Body",
      "contentType",
    ])
  ) {
    fail("invalid_body");
  }

  const hasJson = Object.hasOwn(value, "jsonBody");
  const hasText = Object.hasOwn(value, "textBody");
  const hasBase64 = Object.hasOwn(value, "base64Body");
  const modeCount = Number(hasJson) + Number(hasText) + Number(hasBase64);
  if (modeCount > 1) {
    fail("multiple_body_modes");
  }
  if (modeCount === 0) {
    if (Object.hasOwn(value, "contentType")) {
      fail("invalid_body");
    }
    return undefined;
  }

  let kind: ValidatedRequestBody["kind"];
  let contentType: string;
  let bytes: Uint8Array;
  if (hasJson) {
    if (Object.hasOwn(value, "contentType")) {
      fail("invalid_content_type");
    }
    assertJsonValue(value.jsonBody, new Set(), 0);
    let serialized: string;
    try {
      serialized = JSON.stringify(value.jsonBody);
    } catch {
      fail("invalid_json_body");
    }
    kind = "json";
    contentType = "application/json";
    bytes = new TextEncoder().encode(serialized);
  } else if (hasText) {
    if (typeof value.textBody !== "string") {
      fail("invalid_body");
    }
    kind = "text";
    contentType = validateContentType(value.contentType);
    bytes = new TextEncoder().encode(value.textBody);
  } else {
    kind = "base64";
    contentType = validateContentType(value.contentType);
    bytes = decodeCanonicalBase64(value.base64Body);
  }

  if (bytes.byteLength > maxBytes) {
    fail("body_too_large");
  }
  return Object.freeze({
    kind,
    contentType,
    bytes,
    size: bytes.byteLength,
  });
}
