import path from "node:path";

import {
  PROVIDER_KEYS,
  getProviderCatalogEntry,
  validateProviderKey,
  type ProviderKey,
} from "./catalog.js";

const KIB = 1_024;
const MIB = 1_024 * KIB;
const GIB = 1_024 * MIB;
const MAX_URL_LENGTH = 2_048;
const MAX_ID_BYTES = 512;
const MAX_SECRET_BYTES = 4_096;
const MAX_PATH_BYTES = 4_096;
const MAX_ROOTS = 32;
const MAX_LINK_ORIGINS = 32;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const HOST_SUFFIX_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DEFAULT_TRANSFER_HOST_SUFFIXES = [
  "disk.yandex.net",
  "disk.yandex.ru",
  "storage.yandex.net",
  "dst.yandex.net",
  "dst.yandex.ru",
] as const;

export const DEFAULT_RUNTIME_LIMITS = Object.freeze({
  transport: Object.freeze({
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 300_000,
    operationDeadlineMs: 300_000,
    // Inclusive total attempts: 3 means the first call plus at most 2 retries.
    readAttempts: 3,
    initialBackoffMs: 250,
    maxBackoffMs: 5_000,
    maxRequestBytes: MIB,
    maxResponseBytes: MIB,
  }),
  pagination: Object.freeze({
    maxPages: 25,
    maxItems: 1_000,
  }),
  actions: Object.freeze({
    syncTimeoutMs: 30_000,
    maxInputBytes: MIB,
    maxOutputBytes: MIB,
  }),
  disk: Object.freeze({
    maxTransferBytes: GIB,
    maxRedirects: 3,
    timeoutMs: 300_000,
    transferHostSuffixes: Object.freeze([...DEFAULT_TRANSFER_HOST_SUFFIXES]),
  }),
});

const ID_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  pattern: "^[^\\u0000-\\u001F\\u007F]+$",
} as const;

const SECRET_INPUT_SCHEMA = {
  anyOf: [
    {
      type: "string",
      minLength: 1,
      maxLength: 4_096,
      pattern: "^[^\\u0000-\\u001F\\u007F]+$",
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["source", "provider", "id"],
      properties: {
        source: { type: "string", enum: ["env", "file", "exec"] },
        provider: ID_SCHEMA,
        id: ID_SCHEMA,
      },
    },
  ],
} as const;

const LINK_ORIGIN_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: MAX_LINK_ORIGINS,
  uniqueItems: true,
  items: {
    type: "string",
    minLength: 1,
    maxLength: MAX_URL_LENGTH,
  },
} as const;

const LINK_ORIGIN_KEY_PATTERN = `^(?:${PROVIDER_KEYS.join("|")})$`;

export const PLUGIN_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cloudru"],
  properties: {
    cloudru: {
      type: "object",
      additionalProperties: false,
      required: ["proxyBaseUrl", "projectId", "evoClawId", "apiKey"],
      properties: {
        proxyBaseUrl: {
          type: "string",
          minLength: 1,
          maxLength: MAX_URL_LENGTH,
        },
        projectId: ID_SCHEMA,
        evoClawId: ID_SCHEMA,
        apiKey: SECRET_INPUT_SCHEMA,
      },
    },
    transport: {
      type: "object",
      additionalProperties: false,
      properties: {
        defaultTimeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 300_000,
        },
        maxTimeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 300_000,
        },
        operationDeadlineMs: {
          type: "integer",
          minimum: 1,
          maximum: 900_000,
        },
        readAttempts: {
          type: "integer",
          minimum: 1,
          maximum: 5,
        },
        initialBackoffMs: {
          type: "integer",
          minimum: 0,
          maximum: 60_000,
        },
        maxBackoffMs: {
          type: "integer",
          minimum: 0,
          maximum: 60_000,
        },
        maxRequestBytes: {
          type: "integer",
          minimum: 1,
          maximum: 16 * MIB,
        },
        maxResponseBytes: {
          type: "integer",
          minimum: 1,
          maximum: 16 * MIB,
        },
      },
    },
    pagination: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxPages: {
          type: "integer",
          minimum: 1,
          maximum: 100,
        },
        maxItems: {
          type: "integer",
          minimum: 1,
          maximum: 10_000,
        },
        linkOrigins: {
          type: "object",
          additionalProperties: false,
          patternProperties: {
            [LINK_ORIGIN_KEY_PATTERN]: LINK_ORIGIN_SCHEMA,
          },
        },
      },
    },
    actions: {
      type: "object",
      additionalProperties: false,
      required: ["transport"],
      properties: {
        transport: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["mode", "endpointUrl"],
              properties: {
                mode: { type: "string", const: "proxy" },
                endpointUrl: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_URL_LENGTH,
                },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["mode", "baseUrl", "secretKey"],
              properties: {
                mode: { type: "string", const: "direct" },
                baseUrl: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_URL_LENGTH,
                },
                secretKey: SECRET_INPUT_SCHEMA,
              },
            },
          ],
        },
        syncTimeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 900_000,
        },
        maxInputBytes: {
          type: "integer",
          minimum: 1,
          maximum: 2_000_000,
        },
        maxOutputBytes: {
          type: "integer",
          minimum: 1,
          maximum: 2_000_000,
        },
      },
    },
    disk: {
      type: "object",
      additionalProperties: false,
      anyOf: [
        {
          required: ["uploadRoots"],
          properties: { uploadRoots: { minItems: 1 } },
        },
        {
          required: ["downloadRoots"],
          properties: { downloadRoots: { minItems: 1 } },
        },
      ],
      properties: {
        uploadRoots: {
          type: "array",
          maxItems: MAX_ROOTS,
          uniqueItems: true,
          items: {
            type: "string",
            minLength: 1,
            maxLength: MAX_PATH_BYTES,
          },
        },
        downloadRoots: {
          type: "array",
          maxItems: MAX_ROOTS,
          uniqueItems: true,
          items: {
            type: "string",
            minLength: 1,
            maxLength: MAX_PATH_BYTES,
          },
        },
        maxTransferBytes: {
          type: "integer",
          minimum: MIB,
          maximum: 10 * GIB,
        },
        maxRedirects: {
          type: "integer",
          minimum: 0,
          maximum: 5,
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 3_600_000,
        },
        transferHostSuffixes: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          uniqueItems: true,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 253,
          },
        },
      },
    },
  },
} as const;

export class RuntimeConfigError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RuntimeConfigError";
    this.code = code;
  }
}

export type RuntimeTransportConfig = Readonly<{
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  operationDeadlineMs: number;
  /** Inclusive total attempts, including the initial request. */
  readAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
}>;

export type RuntimePaginationConfig = Readonly<{
  maxPages: number;
  maxItems: number;
  linkOrigins: Readonly<Partial<Record<ProviderKey, readonly string[]>>>;
}>;

export type RuntimeActionTransport =
  | Readonly<{
      mode: "proxy";
      endpointUrl: string;
    }>
  | Readonly<{
      mode: "direct";
      baseUrl: string;
      secretKey: string;
    }>;

export type RuntimeActionsConfig = Readonly<{
  transport: RuntimeActionTransport;
  syncTimeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
}>;

export type RuntimeDiskConfig = Readonly<{
  uploadRoots: readonly string[];
  downloadRoots: readonly string[];
  maxTransferBytes: number;
  maxRedirects: number;
  timeoutMs: number;
  transferHostSuffixes: readonly string[];
}>;

export type RuntimeConfig = Readonly<{
  cloudru: Readonly<{
    proxyBaseUrl: string;
    projectId: string;
    evoClawId: string;
    apiKey: string;
  }>;
  transport: RuntimeTransportConfig;
  pagination: RuntimePaginationConfig;
  actions?: RuntimeActionsConfig;
  disk?: RuntimeDiskConfig;
}>;

function fail(code: string): never {
  throw new RuntimeConfigError(code);
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

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    fail("invalid_config");
  }
  return value;
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    fail("unknown_config_property");
  }
}

function requireProperty(
  value: Record<string, unknown>,
  key: string,
): unknown {
  if (!Object.hasOwn(value, key)) {
    fail("missing_config_property");
  }
  return value[key];
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    utf8Bytes(value) < 1 ||
    utf8Bytes(value) > MAX_ID_BYTES ||
    CONTROL_RE.test(value)
  ) {
    fail("invalid_identifier");
  }
  return value;
}

function parseLiteralSecret(value: unknown): string {
  if (isRecord(value)) {
    fail("unresolved_secret");
  }
  if (
    typeof value !== "string" ||
    utf8Bytes(value) < 1 ||
    utf8Bytes(value) > MAX_SECRET_BYTES ||
    CONTROL_RE.test(value)
  ) {
    fail("invalid_secret");
  }
  return value;
}

function parseInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value === undefined ? fallback : value;
  if (
    typeof candidate !== "number" ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    fail("invalid_config_bound");
  }
  return candidate;
}

function parseUrl(value: unknown): URL {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_URL_LENGTH ||
    CONTROL_RE.test(value) ||
    value.includes("\\")
  ) {
    fail("invalid_url");
  }
  try {
    return new URL(value);
  } catch {
    fail("invalid_url");
  }
}

function assertUrlAuthority(url: URL): void {
  if (
    url.hostname.length === 0 ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.search.length !== 0 ||
    url.hash.length !== 0
  ) {
    fail("invalid_url");
  }
}

function assertNormalizedRawUrlPath(value: string): void {
  const authorityStart = value.indexOf("://") + 3;
  const pathStart = value.indexOf("/", authorityStart);
  if (pathStart < 0) {
    return;
  }
  const queryStart = value.indexOf("?", pathStart);
  const fragmentStart = value.indexOf("#", pathStart);
  const pathEnd = Math.min(
    ...[queryStart, fragmentStart, value.length].filter(
      (index) => index >= 0,
    ),
  );
  const rawPath = value.slice(pathStart, pathEnd);
  if (rawPath.slice(1).includes("//")) {
    fail("invalid_url");
  }
  for (const rawSegment of rawPath.split("/").slice(1)) {
    let decoded = rawSegment;
    for (let depth = 0; depth < 4; depth += 1) {
      let next: string;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        fail("invalid_url");
      }
      if (next === decoded) {
        break;
      }
      decoded = next;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      CONTROL_RE.test(decoded) ||
      /%[0-9A-Fa-f]{2}/.test(decoded)
    ) {
      fail("invalid_url");
    }
  }
}

function parseProxyBaseUrl(value: unknown): string {
  const url = parseUrl(value);
  assertUrlAuthority(url);
  assertNormalizedRawUrlPath(value as string);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail("invalid_url");
  }
  if (url.pathname.includes("//")) {
    fail("invalid_url");
  }
  const pathname =
    url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.origin}${pathname}`;
}

function parseExactOrigin(value: unknown): string {
  let url: URL;
  try {
    url = parseUrl(value);
    assertUrlAuthority(url);
    assertNormalizedRawUrlPath(value as string);
  } catch {
    fail("invalid_origin");
  }
  if (url.protocol !== "https:" || url.pathname !== "/") {
    fail("invalid_origin");
  }
  return url.origin;
}

function parseActionEndpoint(value: unknown): string {
  let url: URL;
  try {
    url = parseUrl(value);
    assertUrlAuthority(url);
    assertNormalizedRawUrlPath(value as string);
  } catch {
    fail("invalid_origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.pathname === "/" ||
    url.pathname.endsWith("/") ||
    url.pathname.includes("//")
  ) {
    fail("invalid_origin");
  }
  return `${url.origin}${url.pathname}`;
}

function parseTransport(value: unknown): RuntimeTransportConfig {
  const input = value === undefined ? {} : requireRecord(value);
  requireOnlyKeys(input, [
    "defaultTimeoutMs",
    "maxTimeoutMs",
    "operationDeadlineMs",
    "readAttempts",
    "initialBackoffMs",
    "maxBackoffMs",
    "maxRequestBytes",
    "maxResponseBytes",
  ]);
  const defaults = DEFAULT_RUNTIME_LIMITS.transport;
  const parsed: RuntimeTransportConfig = {
    defaultTimeoutMs: parseInteger(
      input.defaultTimeoutMs,
      defaults.defaultTimeoutMs,
      1,
      300_000,
    ),
    maxTimeoutMs: parseInteger(
      input.maxTimeoutMs,
      defaults.maxTimeoutMs,
      1,
      300_000,
    ),
    operationDeadlineMs: parseInteger(
      input.operationDeadlineMs,
      defaults.operationDeadlineMs,
      1,
      900_000,
    ),
    readAttempts: parseInteger(
      input.readAttempts,
      defaults.readAttempts,
      1,
      5,
    ),
    initialBackoffMs: parseInteger(
      input.initialBackoffMs,
      defaults.initialBackoffMs,
      0,
      60_000,
    ),
    maxBackoffMs: parseInteger(
      input.maxBackoffMs,
      defaults.maxBackoffMs,
      0,
      60_000,
    ),
    maxRequestBytes: parseInteger(
      input.maxRequestBytes,
      defaults.maxRequestBytes,
      1,
      16 * MIB,
    ),
    maxResponseBytes: parseInteger(
      input.maxResponseBytes,
      defaults.maxResponseBytes,
      1,
      16 * MIB,
    ),
  };
  if (
    parsed.defaultTimeoutMs > parsed.maxTimeoutMs ||
    parsed.maxTimeoutMs > parsed.operationDeadlineMs ||
    parsed.initialBackoffMs > parsed.maxBackoffMs
  ) {
    fail("invalid_config_relation");
  }
  return parsed;
}

function parseOriginArray(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_LINK_ORIGINS
  ) {
    fail("invalid_config_bound");
  }
  const origins = value.map(parseExactOrigin);
  if (new Set(origins).size !== origins.length) {
    fail("invalid_origin");
  }
  return origins;
}

function parsePagination(value: unknown): RuntimePaginationConfig {
  const input = value === undefined ? {} : requireRecord(value);
  requireOnlyKeys(input, ["maxPages", "maxItems", "linkOrigins"]);
  const rawLinkOrigins =
    input.linkOrigins === undefined ? {} : requireRecord(input.linkOrigins);
  requireOnlyKeys(rawLinkOrigins, PROVIDER_KEYS);
  const linkOrigins: Partial<Record<ProviderKey, readonly string[]>> = {};
  for (const [rawProviderKey, origins] of Object.entries(rawLinkOrigins)) {
    const providerKey = validateProviderKey(rawProviderKey);
    linkOrigins[providerKey] = parseOriginArray(origins);
  }
  return {
    maxPages: parseInteger(
      input.maxPages,
      DEFAULT_RUNTIME_LIMITS.pagination.maxPages,
      1,
      100,
    ),
    maxItems: parseInteger(
      input.maxItems,
      DEFAULT_RUNTIME_LIMITS.pagination.maxItems,
      1,
      10_000,
    ),
    linkOrigins,
  };
}

function parseActions(
  value: unknown,
  operationDeadlineMs: number,
): RuntimeActionsConfig {
  const input = requireRecord(value);
  requireOnlyKeys(input, [
    "transport",
    "syncTimeoutMs",
    "maxInputBytes",
    "maxOutputBytes",
  ]);
  const transportInput = requireRecord(requireProperty(input, "transport"));
  const mode = requireProperty(transportInput, "mode");
  let transport: RuntimeActionTransport;
  if (mode === "proxy") {
    requireOnlyKeys(transportInput, ["mode", "endpointUrl"]);
    transport = {
      mode,
      endpointUrl: parseActionEndpoint(
        requireProperty(transportInput, "endpointUrl"),
      ),
    };
  } else if (mode === "direct") {
    requireOnlyKeys(transportInput, ["mode", "baseUrl", "secretKey"]);
    transport = {
      mode,
      baseUrl: parseExactOrigin(requireProperty(transportInput, "baseUrl")),
      secretKey: parseLiteralSecret(
        requireProperty(transportInput, "secretKey"),
      ),
    };
  } else {
    fail("invalid_config");
  }

  const parsed: RuntimeActionsConfig = {
    transport,
    syncTimeoutMs: parseInteger(
      input.syncTimeoutMs,
      DEFAULT_RUNTIME_LIMITS.actions.syncTimeoutMs,
      1,
      900_000,
    ),
    maxInputBytes: parseInteger(
      input.maxInputBytes,
      DEFAULT_RUNTIME_LIMITS.actions.maxInputBytes,
      1,
      2_000_000,
    ),
    maxOutputBytes: parseInteger(
      input.maxOutputBytes,
      DEFAULT_RUNTIME_LIMITS.actions.maxOutputBytes,
      1,
      2_000_000,
    ),
  };
  if (parsed.syncTimeoutMs > operationDeadlineMs) {
    fail("invalid_config_relation");
  }
  return parsed;
}

function parseRootArray(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail("invalid_disk_root");
  }
  if (value.length > MAX_ROOTS) {
    fail("invalid_config_bound");
  }
  const roots = value.map((candidate) => {
    if (
      typeof candidate !== "string" ||
      utf8Bytes(candidate) > MAX_PATH_BYTES ||
      CONTROL_RE.test(candidate) ||
      !path.isAbsolute(candidate)
    ) {
      fail("invalid_disk_root");
    }
    const normalized = path.normalize(candidate);
    if (
      normalized !== candidate ||
      normalized === path.parse(normalized).root
    ) {
      fail("invalid_disk_root");
    }
    return normalized;
  });
  if (new Set(roots).size !== roots.length) {
    fail("invalid_disk_root");
  }
  return roots;
}

function parseTransferHostSuffixes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    fail("invalid_transfer_host_suffix");
  }
  const suffixes = value.map((candidate) => {
    if (
      typeof candidate !== "string" ||
      candidate.length > 253 ||
      !HOST_SUFFIX_RE.test(candidate) ||
      !DEFAULT_TRANSFER_HOST_SUFFIXES.some(
        (suffix) => candidate === suffix || candidate.endsWith(`.${suffix}`),
      )
    ) {
      fail("invalid_transfer_host_suffix");
    }
    return candidate;
  });
  if (new Set(suffixes).size !== suffixes.length) {
    fail("invalid_transfer_host_suffix");
  }
  return suffixes;
}

function parseDisk(value: unknown): RuntimeDiskConfig {
  const input = requireRecord(value);
  requireOnlyKeys(input, [
    "uploadRoots",
    "downloadRoots",
    "maxTransferBytes",
    "maxRedirects",
    "timeoutMs",
    "transferHostSuffixes",
  ]);
  const uploadRoots = parseRootArray(input.uploadRoots);
  const downloadRoots = parseRootArray(input.downloadRoots);
  if (uploadRoots.length + downloadRoots.length === 0) {
    fail("invalid_disk_root");
  }
  return {
    uploadRoots,
    downloadRoots,
    maxTransferBytes: parseInteger(
      input.maxTransferBytes,
      DEFAULT_RUNTIME_LIMITS.disk.maxTransferBytes,
      MIB,
      10 * GIB,
    ),
    maxRedirects: parseInteger(
      input.maxRedirects,
      DEFAULT_RUNTIME_LIMITS.disk.maxRedirects,
      0,
      5,
    ),
    timeoutMs: parseInteger(
      input.timeoutMs,
      DEFAULT_RUNTIME_LIMITS.disk.timeoutMs,
      1,
      3_600_000,
    ),
    transferHostSuffixes:
      input.transferHostSuffixes === undefined
        ? [...DEFAULT_RUNTIME_LIMITS.disk.transferHostSuffixes]
        : parseTransferHostSuffixes(input.transferHostSuffixes),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const input = requireRecord(value);
  requireOnlyKeys(input, [
    "cloudru",
    "transport",
    "pagination",
    "actions",
    "disk",
  ]);
  const cloudruInput = requireRecord(requireProperty(input, "cloudru"));
  requireOnlyKeys(cloudruInput, [
    "proxyBaseUrl",
    "projectId",
    "evoClawId",
    "apiKey",
  ]);

  const transport = parseTransport(input.transport);
  const runtimeConfig: RuntimeConfig = {
    cloudru: {
      proxyBaseUrl: parseProxyBaseUrl(
        requireProperty(cloudruInput, "proxyBaseUrl"),
      ),
      projectId: parseIdentifier(
        requireProperty(cloudruInput, "projectId"),
      ),
      evoClawId: parseIdentifier(
        requireProperty(cloudruInput, "evoClawId"),
      ),
      apiKey: parseLiteralSecret(requireProperty(cloudruInput, "apiKey")),
    },
    transport,
    pagination: parsePagination(input.pagination),
    ...(input.actions === undefined
      ? {}
      : { actions: parseActions(input.actions, transport.operationDeadlineMs) }),
    ...(input.disk === undefined ? {} : { disk: parseDisk(input.disk) }),
  };
  return deepFreeze(runtimeConfig);
}

export function getTrustedLinkOrigins(
  config: RuntimeConfig,
  provider: unknown,
): readonly string[] {
  const literalProvider = validateProviderKey(provider);
  const origins = [
    ...getProviderCatalogEntry(literalProvider).staticLinkOrigins,
    ...(config.pagination.linkOrigins[literalProvider] ?? []),
  ];
  return Object.freeze([...new Set(origins)]);
}

export type PublicRuntimeConfig = Readonly<{
  cloudru: Readonly<{ proxyScheme: "http" | "https" }>;
  transport: RuntimeTransportConfig;
  pagination: Readonly<{
    maxPages: number;
    maxItems: number;
    configuredProviderCount: number;
    configuredOriginCount: number;
  }>;
  actions: Readonly<{
    enabled: boolean;
    direct: boolean;
    originScheme?: "http" | "https";
    syncTimeoutMs?: number;
    maxInputBytes?: number;
    maxOutputBytes?: number;
  }>;
  disk: Readonly<{
    enabled: boolean;
    uploadRootCount: number;
    downloadRootCount: number;
    transferHostSuffixCount: number;
    maxTransferBytes?: number;
    maxRedirects?: number;
    timeoutMs?: number;
  }>;
}>;

function schemeOf(value: string): "http" | "https" {
  return new URL(value).protocol === "https:" ? "https" : "http";
}

export function projectPublicConfig(
  config: RuntimeConfig,
): PublicRuntimeConfig {
  const configuredOriginArrays = Object.values(
    config.pagination.linkOrigins,
  );
  return deepFreeze({
    cloudru: {
      proxyScheme: schemeOf(config.cloudru.proxyBaseUrl),
    },
    transport: { ...config.transport },
    pagination: {
      maxPages: config.pagination.maxPages,
      maxItems: config.pagination.maxItems,
      configuredProviderCount: configuredOriginArrays.length,
      configuredOriginCount: configuredOriginArrays.reduce(
        (total, origins) => total + origins.length,
        0,
      ),
    },
    actions: config.actions
      ? {
          enabled: true,
          direct: config.actions.transport.mode === "direct",
          originScheme: schemeOf(
            config.actions.transport.mode === "direct"
              ? config.actions.transport.baseUrl
              : config.actions.transport.endpointUrl,
          ),
          syncTimeoutMs: config.actions.syncTimeoutMs,
          maxInputBytes: config.actions.maxInputBytes,
          maxOutputBytes: config.actions.maxOutputBytes,
        }
      : {
          enabled: false,
          direct: false,
        },
    disk: config.disk
      ? {
          enabled: true,
          uploadRootCount: config.disk.uploadRoots.length,
          downloadRootCount: config.disk.downloadRoots.length,
          transferHostSuffixCount: config.disk.transferHostSuffixes.length,
          maxTransferBytes: config.disk.maxTransferBytes,
          maxRedirects: config.disk.maxRedirects,
          timeoutMs: config.disk.timeoutMs,
        }
      : {
          enabled: false,
          uploadRootCount: 0,
          downloadRootCount: 0,
          transferHostSuffixCount: 0,
        },
  });
}
