import { createHash } from "node:crypto";

import { Type } from "typebox";

import {
  type ApprovalController,
} from "../approval.js";
import {
  getProviderCatalogEntry,
  type ProviderKey,
} from "../catalog.js";
import {
  getTrustedLinkOrigins,
  type RuntimeConfig,
} from "../config.js";
import type {
  ProxyClient,
  ProxyRequest,
} from "../proxy-client.js";
import {
  createFailureResult,
  type FailureResult,
  type JsonValue,
  type RequestSummary,
  type ResponseSummary,
  type SuccessResult,
  type ToolResult,
} from "../result.js";
import {
  encodeOrderedQuery,
  validateRelativeProviderPath,
  validateRequestBody,
  type QueryPair,
} from "../validation.js";
import {
  REQUEST_PARAMETERS,
  authorizationFailure,
  parseProxyRequestParams,
  requestParamsFromEnvelope,
  runtimeConfigFailure,
  stripAuthorizedProof,
  toolExecutionResult,
  type ToolExecutionResult,
} from "./request.js";

const PAGINATION_MODES = Object.freeze([
  "link",
  "offset",
  "body-offset",
  "single",
] as const);
type PaginationMode = (typeof PAGINATION_MODES)[number];

const PAGINATION_KEYS = new Set([
  ...Object.keys(REQUEST_PARAMETERS.properties),
  "mode",
  "maxPages",
  "maxItems",
]);
const MAX_SCHEMA_PAGES = 100;
const MAX_SCHEMA_ITEMS = 10_000;
const MIN_PAGINATION_OUTPUT_BYTES = 64 * 1_024;
// OpenClaw receives both `details` and its JSON text projection. Bounding
// details to 8 MiB keeps the combined tool surface below roughly 16 MiB.
const MAX_PAGINATION_OUTPUT_BYTES = 8 * 1_024 * 1_024;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const INVALID_PERCENT_ESCAPE_RE = /%(?![0-9A-Fa-f]{2})/;
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const PAGINATE_PARAMETERS = Type.Object(
  {
    ...REQUEST_PARAMETERS.properties,
    mode: Type.Union(
      PAGINATION_MODES.map((mode) => Type.Literal(mode)),
    ),
    maxPages: Type.Integer({
      minimum: 1,
      maximum: MAX_SCHEMA_PAGES,
    }),
    maxItems: Type.Integer({
      minimum: 1,
      maximum: MAX_SCHEMA_ITEMS,
    }),
  },
  { additionalProperties: false },
);

const INVALID_REQUEST_SUMMARY: RequestSummary = Object.freeze({
  providerConfigKey: "yandex-id",
  method: "GET",
  path: "<invalid>",
});

const DIRECT_COLLECTIONS = Object.freeze({
  ads: "Ads",
  adgroups: "AdGroups",
  bidmodifiers: "BidModifiers",
  campaigns: "Campaigns",
  clients: "Clients",
  creatives: "Creatives",
  dictionaries: "Dictionaries",
  keywords: "Keywords",
  keywordbids: "KeywordBids",
  keywordsresearch: "KeywordsResearch",
  leads: "Leads",
  retargetinglists: "RetargetingLists",
  sitelinks: "Sitelinks",
  smartadtargets: "SmartAdTargets",
  turbolandings: "TurboLandings",
  vcards: "VCards",
} as const);

const AMO_COLLECTIONS = Object.freeze({
  catalogs: "catalogs",
  companies: "companies",
  contacts: "contacts",
  customers: "customers",
  events: "events",
  leads: "leads",
  talks: "talks",
  tasks: "tasks",
  users: "users",
} as const);

const BITRIX_OFFSET_READ_METHODS = new Set([
  "calendar.section.get",
  "department.get",
  "im.recent.get",
  "telephony.externalline.get",
  "user.current",
]);

type PaginationTermination =
  | "provider_end"
  | "max_pages"
  | "max_items"
  | "max_bytes"
  | "loop_detected";

type PaginationPage = Readonly<{
  request: RequestSummary;
  response: Readonly<{
    status: number;
    contentType: string;
    headers: Readonly<Record<string, string>>;
  }>;
}>;

export type PaginationSuccess = Readonly<{
  ok: true;
  request: RequestSummary;
  pages: readonly PaginationPage[];
  items: readonly JsonValue[];
  pagination: Readonly<{
    mode: PaginationMode;
    pageCount: number;
    itemCount: number;
    termination: PaginationTermination;
  }>;
  outcome: "confirmed";
}>;

export type PaginationToolDependencies = Readonly<{
  config?: RuntimeConfig;
  client?: ProxyClient;
  approvals: Pick<ApprovalController, "authorizeExecution">;
}>;

type ParsedPagination = Readonly<{
  mode: PaginationMode;
  maxPages: number;
  maxItems: number;
  request: ProxyRequest;
}>;

type PageExtraction = Readonly<{
  items: readonly JsonValue[];
  next?: ProxyRequest;
}>;

class PaginationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "PaginationError";
    this.code = code;
  }
}

function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function summaryOf(request: ProxyRequest): RequestSummary {
  return Object.freeze({
    providerConfigKey: request.providerConfigKey,
    method: request.method,
    path: request.path,
  });
}

function preflightFailure(code: string): FailureResult {
  return createFailureResult(INVALID_REQUEST_SUMMARY, {
    layer: "validation",
    code,
    message:
      code === "pagination_limit_exceeded"
        ? "Requested pagination limits exceed runtime limits"
        : "Pagination request validation failed",
    retryable: false,
    outcome: "not_started",
  });
}

function providerPaginationFailure(
  request: ProxyRequest,
  code: string,
): FailureResult {
  return createFailureResult(summaryOf(request), {
    layer: "provider",
    code,
    message: "Provider pagination metadata is invalid or unsafe",
    retryable: false,
    outcome: "confirmed_failed",
  });
}

function networkFailure(request: ProxyRequest): FailureResult {
  return createFailureResult(summaryOf(request), {
    layer: "network",
    code: "network_error",
    message: "Network request failed",
    retryable: true,
    outcome: "confirmed_failed",
  });
}

function assertPaginationEnvelope(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => !PAGINATION_KEYS.has(key))
  ) {
    throw new PaginationError("invalid_pagination_request");
  }
}

function stripBitrixJsonSuffix(value: string): string {
  const withoutSlash = value.endsWith("/")
    ? value.slice(0, -1)
    : value;
  return withoutSlash.toLowerCase().endsWith(".json")
    ? withoutSlash.slice(0, -5)
    : withoutSlash;
}

function bitrixOffsetContract(request: ProxyRequest): boolean {
  if (
    getProviderCatalogEntry(request.providerConfigKey).family !==
      "bitrix24" ||
    (request.method !== "GET" && request.method !== "POST")
  ) {
    return false;
  }
  const normalizedPath = stripBitrixJsonSuffix(request.path)
    .toLowerCase();
  const terminal = normalizedPath.split(".").at(-1);
  return (
    terminal === "list" ||
    terminal === "getlist" ||
    terminal === "search" ||
    terminal === "history" ||
    terminal === "items" ||
    BITRIX_OFFSET_READ_METHODS.has(normalizedPath)
  );
}

function diskOffsetContract(request: ProxyRequest): boolean {
  const path = request.path.endsWith("/")
    ? request.path.slice(0, -1)
    : request.path;
  return (
    request.providerConfigKey === "yandex-disk" &&
    request.method === "GET" &&
    path === "v1/disk/resources"
  );
}

function marketOffsetContract(request: ProxyRequest): boolean {
  const path = request.path.endsWith("/")
    ? request.path.slice(0, -1)
    : request.path;
  if (
    request.providerConfigKey !== "yandex-market" ||
    request.method !== "GET" ||
    path !== "v2/campaigns"
  ) {
    return false;
  }
  const limits = (request.query ?? []).filter(
    ({ name }) => name === "limit",
  );
  if (limits.length > 1) {
    return false;
  }
  if (limits.length === 1) {
    const value = limits[0]!.value;
    if (
      !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)
    ) {
      return false;
    }
  }
  return (
    (request.query ?? []).filter(
      ({ name }) => name === "pageToken",
    ).length <= 1
  );
}

function directService(
  request: ProxyRequest,
): keyof typeof DIRECT_COLLECTIONS | undefined {
  if (
    request.providerConfigKey !== "yandex-direct" ||
    request.method !== "POST"
  ) {
    return undefined;
  }
  const match = /^json\/v5\/([A-Za-z0-9_-]+)$/.exec(request.path);
  if (!match) {
    return undefined;
  }
  const service = match[1]?.toLowerCase();
  return service && Object.hasOwn(DIRECT_COLLECTIONS, service)
    ? (service as keyof typeof DIRECT_COLLECTIONS)
    : undefined;
}

function decodeJsonRequestBody(
  request: ProxyRequest,
): Record<string, unknown> | undefined {
  if (request.body === undefined) {
    return undefined;
  }
  if (request.body.kind !== "json") {
    throw new PaginationError("unsupported_pagination_contract");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(request.body.bytes));
  } catch {
    throw new PaginationError("invalid_pagination_request");
  }
  if (!isPlainRecord(value)) {
    throw new PaginationError("invalid_pagination_request");
  }
  return value;
}

function withJsonBody(
  request: ProxyRequest,
  value: Record<string, unknown>,
  config: RuntimeConfig,
): ProxyRequest {
  const body = validateRequestBody(
    { jsonBody: value },
    config.transport.maxRequestBytes,
  );
  if (!body) {
    throw new PaginationError("invalid_pagination_request");
  }
  return Object.freeze({ ...request, body });
}

function normalizeDirectInitialRequest(
  request: ProxyRequest,
  config: RuntimeConfig,
  maxItems: number,
): ProxyRequest {
  const service = directService(request);
  const body = decodeJsonRequestBody(request);
  if (!service || !body || body.method !== "get") {
    throw new PaginationError("unsupported_pagination_contract");
  }
  if (!isPlainRecord(body.params)) {
    throw new PaginationError("invalid_pagination_request");
  }
  const params = body.params;
  if (params.Page !== undefined && !isPlainRecord(params.Page)) {
    throw new PaginationError("invalid_pagination_request");
  }
  const page = isPlainRecord(params.Page) ? params.Page : {};
  const offset = page.Offset ?? 0;
  const limit = page.Limit ?? Math.min(maxItems, MAX_SCHEMA_ITEMS);
  if (
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1
  ) {
    throw new PaginationError("invalid_pagination_request");
  }
  const nextBody = {
    ...body,
    params: {
      ...params,
      Page: {
        ...page,
        Offset: offset,
        Limit: limit,
      },
    },
  };
  return withJsonBody(request, nextBody, config);
}

function assertModeContract(
  mode: PaginationMode,
  request: ProxyRequest,
): void {
  if (mode === "single" || mode === "link") {
    return;
  }
  if (
    mode === "offset" &&
    (bitrixOffsetContract(request) ||
      diskOffsetContract(request) ||
      marketOffsetContract(request))
  ) {
    return;
  }
  if (mode === "body-offset" && directService(request)) {
    return;
  }
  throw new PaginationError("unsupported_pagination_contract");
}

function parsePagination(
  value: unknown,
  config: RuntimeConfig,
  operationKind: "read",
): ParsedPagination {
  assertPaginationEnvelope(value);
  if (
    typeof value.mode !== "string" ||
    !PAGINATION_MODES.includes(value.mode as PaginationMode) ||
    !Number.isSafeInteger(value.maxPages) ||
    (value.maxPages as number) < 1 ||
    !Number.isSafeInteger(value.maxItems) ||
    (value.maxItems as number) < 1
  ) {
    throw new PaginationError("invalid_pagination_request");
  }
  const mode = value.mode as PaginationMode;
  const maxPages = value.maxPages as number;
  const maxItems = value.maxItems as number;
  if (
    maxPages > config.pagination.maxPages ||
    maxItems > config.pagination.maxItems
  ) {
    throw new PaginationError("pagination_limit_exceeded");
  }

  let request = parseProxyRequestParams(
    requestParamsFromEnvelope(value),
    config,
    operationKind,
  );
  assertModeContract(mode, request);
  if (mode === "body-offset") {
    request = normalizeDirectInitialRequest(
      request,
      config,
      maxItems,
    );
  }
  return Object.freeze({ mode, maxPages, maxItems, request });
}

function splitOutside(
  value: string,
  delimiter: "," | ";",
): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let inAngle = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted) {
      if (character === "<") {
        if (inAngle) {
          throw new PaginationError("invalid_pagination_link");
        }
        inAngle = true;
      } else if (character === ">") {
        if (!inAngle) {
          throw new PaginationError("invalid_pagination_link");
        }
        inAngle = false;
      } else if (
        character === delimiter &&
        (delimiter === ";" ? !inAngle : !inAngle)
      ) {
        parts.push(value.slice(start, index).trim());
        start = index + 1;
      }
    }
  }
  if (quoted || escaped || inAngle) {
    throw new PaginationError("invalid_pagination_link");
  }
  parts.push(value.slice(start).trim());
  if (parts.some((part) => part.length === 0)) {
    throw new PaginationError("invalid_pagination_link");
  }
  return parts;
}

function parseParameterValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2) {
      throw new PaginationError("invalid_pagination_link");
    }
    let decoded = "";
    let escaped = false;
    for (const character of trimmed.slice(1, -1)) {
      if (escaped) {
        decoded += character;
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        throw new PaginationError("invalid_pagination_link");
      } else {
        decoded += character;
      }
    }
    if (escaped || CONTROL_RE.test(decoded)) {
      throw new PaginationError("invalid_pagination_link");
    }
    return decoded;
  }
  if (!TOKEN_RE.test(trimmed)) {
    throw new PaginationError("invalid_pagination_link");
  }
  return trimmed;
}

function nextLinkTarget(header: string | undefined): string | undefined {
  if (header === undefined || header.trim().length === 0) {
    return undefined;
  }
  if (CONTROL_RE.test(header)) {
    throw new PaginationError("invalid_pagination_link");
  }
  const candidates: string[] = [];
  for (const entry of splitOutside(header, ",")) {
    if (!entry.startsWith("<")) {
      throw new PaginationError("invalid_pagination_link");
    }
    const closing = entry.indexOf(">");
    if (closing <= 1) {
      throw new PaginationError("invalid_pagination_link");
    }
    const target = entry.slice(1, closing);
    if (
      target.includes("<") ||
      target.includes(">") ||
      target.includes("\\") ||
      CONTROL_RE.test(target)
    ) {
      throw new PaginationError("invalid_pagination_link");
    }
    const suffix = entry.slice(closing + 1).trim();
    if (!suffix.startsWith(";")) {
      throw new PaginationError("invalid_pagination_link");
    }
    const parameters = splitOutside(suffix.slice(1), ";");
    let relation: string | undefined;
    for (const parameter of parameters) {
      const equals = parameter.indexOf("=");
      if (equals <= 0) {
        throw new PaginationError("invalid_pagination_link");
      }
      const name = parameter.slice(0, equals).trim().toLowerCase();
      if (!TOKEN_RE.test(name)) {
        throw new PaginationError("invalid_pagination_link");
      }
      const parameterValue = parseParameterValue(
        parameter.slice(equals + 1),
      );
      if (name === "rel") {
        if (relation !== undefined) {
          throw new PaginationError("invalid_pagination_link");
        }
        relation = parameterValue;
      }
    }
    if (
      relation
        ?.toLowerCase()
        .split(/\s+/)
        .includes("next")
    ) {
      candidates.push(target);
    }
  }
  if (candidates.length > 1) {
    throw new PaginationError("ambiguous_pagination_link");
  }
  return candidates[0];
}

function queryPairsFromUrl(url: URL): readonly QueryPair[] {
  if (INVALID_PERCENT_ESCAPE_RE.test(url.search)) {
    throw new PaginationError("unsafe_pagination_link");
  }
  const query = Array.from(url.searchParams.entries(), ([name, value]) =>
    Object.freeze({ name, value })
  );
  encodeOrderedQuery(query);
  return Object.freeze(query);
}

function linkTargetRequest(
  request: ProxyRequest,
  target: string,
  config: RuntimeConfig,
  originalPath: string,
): ProxyRequest {
  const origins = getTrustedLinkOrigins(
    config,
    request.providerConfigKey,
  );
  if (origins.length === 0) {
    throw new PaginationError("unsafe_pagination_link");
  }
  let absoluteTarget = true;
  try {
    new URL(target);
  } catch {
    absoluteTarget = false;
  }
  if (!absoluteTarget && origins.length !== 1) {
    throw new PaginationError("ambiguous_pagination_link");
  }
  let resolved: URL;
  try {
    const base = new URL(
      `/${request.path}`,
      `${origins[0]}/`,
    );
    const currentQuery = encodeOrderedQuery(request.query ?? []);
    base.search = currentQuery.length === 0 ? "" : `?${currentQuery}`;
    resolved = new URL(target, base);
  } catch {
    throw new PaginationError("unsafe_pagination_link");
  }
  if (
    resolved.protocol !== "https:" ||
    resolved.username.length > 0 ||
    resolved.password.length > 0 ||
    target.includes("#") ||
    resolved.hash.length > 0 ||
    !origins.includes(resolved.origin)
  ) {
    throw new PaginationError("unsafe_pagination_link");
  }
  const path = validateRelativeProviderPath(
    resolved.pathname.startsWith("/")
      ? resolved.pathname.slice(1)
      : resolved.pathname,
  );
  if (path !== originalPath) {
    throw new PaginationError("unsafe_pagination_link");
  }
  const query = queryPairsFromUrl(resolved);
  return Object.freeze({
    ...request,
    path,
    query,
    operationKind: "read",
  });
}

function jsonObject(
  value: JsonValue | undefined,
): Record<string, JsonValue> {
  if (!isPlainRecord(value)) {
    throw new PaginationError("invalid_pagination_response");
  }
  return value as Record<string, JsonValue>;
}

function jsonArray(value: JsonValue | undefined): readonly JsonValue[] {
  if (!Array.isArray(value)) {
    throw new PaginationError("invalid_pagination_response");
  }
  return value;
}

function linkItems(
  request: ProxyRequest,
  body: JsonValue,
): readonly JsonValue[] {
  if (Array.isArray(body)) {
    return body;
  }
  if (!isPlainRecord(body)) {
    throw new PaginationError("invalid_pagination_response");
  }
  const family = getProviderCatalogEntry(
    request.providerConfigKey,
  ).family;
  if (family === "amocrm") {
    const match =
      /^api\/v4\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(request.path);
    const entity = match?.[1]?.toLowerCase();
    if (
      entity &&
      Object.hasOwn(AMO_COLLECTIONS, entity)
    ) {
      if (!isPlainRecord(body._embedded)) {
        throw new PaginationError("invalid_pagination_response");
      }
      const key =
        AMO_COLLECTIONS[entity as keyof typeof AMO_COLLECTIONS];
      const value = body._embedded[key];
      if (!Array.isArray(value)) {
        throw new PaginationError("invalid_pagination_response");
      }
      return value as readonly JsonValue[];
    }
    if (entity === "account") {
      return [];
    }
    throw new PaginationError("invalid_pagination_response");
  }
  if (Array.isArray(body.items)) {
    return body.items as readonly JsonValue[];
  }
  if (Array.isArray(body.result)) {
    return body.result as readonly JsonValue[];
  }
  return [];
}

function replaceQueryParameter(
  query: readonly QueryPair[] | undefined,
  name: string,
  value: string,
): readonly QueryPair[] {
  const output: QueryPair[] = [];
  let replaced = false;
  for (const pair of query ?? []) {
    if (pair.name === name) {
      if (!replaced) {
        output.push(Object.freeze({ name, value }));
        replaced = true;
      }
    } else {
      output.push(Object.freeze({ name: pair.name, value: pair.value }));
    }
  }
  if (!replaced) {
    output.push(Object.freeze({ name, value }));
  }
  encodeOrderedQuery(output);
  return Object.freeze(output);
}

function parseBitrixCursor(
  value: JsonValue | undefined,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const number =
    typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
      ? Number(value)
      : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 0
  ) {
    throw new PaginationError("invalid_pagination_response");
  }
  return number;
}

function bitrixPage(
  request: ProxyRequest,
  body: JsonValue,
  config: RuntimeConfig,
): PageExtraction {
  const object = jsonObject(body);
  const normalizedPath = stripBitrixJsonSuffix(request.path)
    .toLowerCase();
  let items: readonly JsonValue[];
  let nestedNext: JsonValue | undefined;
  if (normalizedPath === "tasks.task.list") {
    const result = jsonObject(object.result);
    items = jsonArray(result.tasks);
    nestedNext = result.next;
  } else if (normalizedPath === "user.current") {
    items = [jsonObject(object.result)];
  } else {
    items = jsonArray(object.result);
  }
  const cursor = parseBitrixCursor(object.next ?? nestedNext);
  if (cursor === undefined) {
    return { items };
  }
  if (request.method === "GET") {
    return {
      items,
      next: Object.freeze({
        ...request,
        query: replaceQueryParameter(
          request.query,
          "start",
          String(cursor),
        ),
      }),
    };
  }
  const current = decodeJsonRequestBody(request) ?? {};
  return {
    items,
    next: withJsonBody(
      request,
      { ...current, start: cursor },
      config,
    ),
  };
}

function marketPage(
  request: ProxyRequest,
  body: JsonValue,
): PageExtraction {
  const object = jsonObject(body);
  const result = jsonObject(object.result);
  const items = jsonArray(result.campaigns);
  const paging = jsonObject(object.paging);
  const token = paging.nextPageToken;
  if (token === undefined || token === null || token === "") {
    return { items };
  }
  if (
    typeof token !== "string" ||
    token.length > 4_096 ||
    CONTROL_RE.test(token)
  ) {
    throw new PaginationError("invalid_pagination_response");
  }
  return {
    items,
    next: Object.freeze({
      ...request,
      query: replaceQueryParameter(
        request.query,
        "pageToken",
        token,
      ),
    }),
  };
}

function safeNonNegativeInteger(value: JsonValue | undefined): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new PaginationError("invalid_pagination_response");
  }
  return value;
}

function diskPage(
  request: ProxyRequest,
  body: JsonValue,
): PageExtraction {
  const object = jsonObject(body);
  const embedded = jsonObject(object._embedded);
  const items = jsonArray(embedded.items);
  const offset = safeNonNegativeInteger(embedded.offset);
  const limit = safeNonNegativeInteger(embedded.limit);
  const total = safeNonNegativeInteger(embedded.total);
  if (limit < 1) {
    throw new PaginationError("invalid_pagination_response");
  }
  const nextOffset = offset + items.length;
  if (items.length === 0 || nextOffset >= total) {
    return { items };
  }
  return {
    items,
    next: Object.freeze({
      ...request,
      query: replaceQueryParameter(
        request.query,
        "offset",
        String(nextOffset),
      ),
    }),
  };
}

function directPage(
  request: ProxyRequest,
  body: JsonValue,
  config: RuntimeConfig,
): PageExtraction {
  const service = directService(request);
  if (!service) {
    throw new PaginationError("invalid_pagination_response");
  }
  const requestBody = decodeJsonRequestBody(request);
  if (
    !requestBody ||
    requestBody.method !== "get" ||
    !isPlainRecord(requestBody.params) ||
    !isPlainRecord(requestBody.params.Page)
  ) {
    throw new PaginationError("invalid_pagination_response");
  }
  const page = requestBody.params.Page;
  const offset = page.Offset;
  const limit = page.Limit;
  if (
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1
  ) {
    throw new PaginationError("invalid_pagination_response");
  }
  const response = jsonObject(body);
  const result = jsonObject(response.result);
  const collection = DIRECT_COLLECTIONS[service];
  const items = jsonArray(result[collection]);
  const limitedBy = result.LimitedBy;
  if (limitedBy === undefined || limitedBy === null) {
    return { items };
  }
  const upperBound = safeNonNegativeInteger(limitedBy);
  const nextOffset = (offset as number) + items.length;
  if (items.length === 0 || nextOffset >= upperBound) {
    return { items };
  }
  const nextBody = {
    ...requestBody,
    params: {
      ...requestBody.params,
      Page: {
        ...page,
        Offset: nextOffset,
        Limit: limit,
      },
    },
  };
  return {
    items,
    next: withJsonBody(request, nextBody, config),
  };
}

function singleItems(
  request: ProxyRequest,
  body: JsonValue,
): readonly JsonValue[] {
  if (bitrixOffsetContract(request)) {
    const object = jsonObject(body);
    const path = stripBitrixJsonSuffix(request.path).toLowerCase();
    if (path === "tasks.task.list") {
      return jsonArray(jsonObject(object.result).tasks);
    }
    if (path === "user.current") {
      return [jsonObject(object.result)];
    }
    return jsonArray(object.result);
  }
  if (diskOffsetContract(request)) {
    return jsonArray(jsonObject(jsonObject(body)._embedded).items);
  }
  if (marketOffsetContract(request)) {
    return jsonArray(
      jsonObject(jsonObject(body).result).campaigns,
    );
  }
  const service = directService(request);
  if (service) {
    return jsonArray(
      jsonObject(jsonObject(body).result)[
        DIRECT_COLLECTIONS[service]
      ],
    );
  }
  if (
    getProviderCatalogEntry(request.providerConfigKey).family ===
      "amocrm" &&
    /^api\/v4\/(?:catalogs|companies|contacts|customers|events|leads|talks|tasks|users)(?:\/|$)/.test(
      request.path,
    )
  ) {
    return linkItems(request, body);
  }
  return Array.isArray(body) ? body : [body];
}

function extractPage(
  mode: PaginationMode,
  request: ProxyRequest,
  originalPath: string,
  result: SuccessResult,
  config: RuntimeConfig,
): PageExtraction {
  if (mode === "single") {
    return { items: singleItems(request, result.response.body) };
  }
  if (mode === "link") {
    const target = nextLinkTarget(result.response.headers.link);
    return {
      items: linkItems(request, result.response.body),
      ...(target === undefined
        ? {}
        : {
            next: linkTargetRequest(
              request,
              target,
              config,
              originalPath,
            ),
          }),
    };
  }
  if (bitrixOffsetContract(request)) {
    return bitrixPage(request, result.response.body, config);
  }
  if (diskOffsetContract(request)) {
    return diskPage(request, result.response.body);
  }
  if (marketOffsetContract(request)) {
    return marketPage(request, result.response.body);
  }
  return directPage(request, result.response.body, config);
}

function requestFingerprint(request: ProxyRequest): string {
  const hash = createHash("sha256");
  hash.update(request.providerConfigKey);
  hash.update("\0");
  hash.update(request.method);
  hash.update("\0");
  hash.update(request.path);
  hash.update("\0");
  hash.update(JSON.stringify(request.query ?? []));
  hash.update("\0");
  if (request.body) {
    hash.update(request.body.bytes);
  }
  return hash.digest("hex");
}

function pageFingerprint(response: ResponseSummary): string {
  return createHash("sha256")
    .update(JSON.stringify(response.body), "utf8")
    .digest("hex");
}

function paginationSuccess(
  firstRequest: ProxyRequest,
  mode: PaginationMode,
  pages: readonly PaginationPage[],
  items: readonly JsonValue[],
  termination: PaginationTermination,
): PaginationSuccess {
  return Object.freeze({
    ok: true,
    request: summaryOf(firstRequest),
    pages: Object.freeze([...pages]),
    items: Object.freeze([...items]),
    pagination: Object.freeze({
      mode,
      pageCount: pages.length,
      itemCount: items.length,
      termination,
    }),
    outcome: "confirmed",
  });
}

function utf8Size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function appendSerializedSize(
  current: number,
  collectionLength: number,
  value: unknown,
): number {
  return current + (collectionLength === 0 ? 0 : 1) + utf8Size(value);
}

async function executePagination(
  parsed: ParsedPagination,
  config: RuntimeConfig,
  client: ProxyClient,
): Promise<ToolResult | PaginationSuccess> {
  const pages: PaginationPage[] = [];
  const items: JsonValue[] = [];
  const seenTargets = new Set<string>();
  const seenPages = new Set<string>();
  const firstRequest = parsed.request;
  let request = parsed.request;
  const outputLimit = Math.min(
    MAX_PAGINATION_OUTPUT_BYTES,
    Math.max(
      MIN_PAGINATION_OUTPUT_BYTES,
      config.transport.maxResponseBytes,
    ),
  );
  let aggregateBytes = utf8Size(
    paginationSuccess(
      firstRequest,
      parsed.mode,
      [],
      [],
      "loop_detected",
    ),
  );

  while (true) {
    if (pages.length >= parsed.maxPages) {
      return paginationSuccess(
        firstRequest,
        parsed.mode,
        pages,
        items,
        "max_pages",
      );
    }
    const targetFingerprint = requestFingerprint(request);
    if (seenTargets.has(targetFingerprint)) {
      return paginationSuccess(
        firstRequest,
        parsed.mode,
        pages,
        items,
        "loop_detected",
      );
    }
    seenTargets.add(targetFingerprint);

    let result: ToolResult;
    try {
      result = await client.request(request);
    } catch {
      return networkFailure(request);
    }
    if (!result.ok) {
      return result;
    }

    let extracted: PageExtraction;
    try {
      extracted = extractPage(
        parsed.mode,
        request,
        firstRequest.path,
        result,
        config,
      );
    } catch (error) {
      return providerPaginationFailure(
        request,
        error instanceof PaginationError
          ? error.code
          : "invalid_pagination_response",
      );
    }

    const fingerprint = pageFingerprint(result.response);
    if (seenPages.has(fingerprint)) {
      return paginationSuccess(
        firstRequest,
        parsed.mode,
        pages,
        items,
        "loop_detected",
      );
    }
    seenPages.add(fingerprint);
    const page = Object.freeze({
      request: result.request,
      response: Object.freeze({
        status: result.response.status,
        contentType: result.response.contentType,
        headers: result.response.headers,
      }),
    });
    const pageAggregateBytes = appendSerializedSize(
      aggregateBytes,
      pages.length,
      page,
    );
    if (pageAggregateBytes > outputLimit) {
      return paginationSuccess(
        firstRequest,
        parsed.mode,
        pages,
        items,
        "max_bytes",
      );
    }
    pages.push(page);
    aggregateBytes = pageAggregateBytes;

    for (const item of extracted.items) {
      if (items.length >= parsed.maxItems) {
        return paginationSuccess(
          firstRequest,
          parsed.mode,
          pages,
          items,
          "max_items",
        );
      }
      const itemAggregateBytes = appendSerializedSize(
        aggregateBytes,
        items.length,
        item,
      );
      if (itemAggregateBytes > outputLimit) {
        return paginationSuccess(
          firstRequest,
          parsed.mode,
          pages,
          items,
          "max_bytes",
        );
      }
      items.push(item);
      aggregateBytes = itemAggregateBytes;
    }

    if (extracted.next === undefined) {
      return paginationSuccess(
        firstRequest,
        parsed.mode,
        pages,
        items,
        "provider_end",
      );
    }
    if (
      items.length >= parsed.maxItems &&
      extracted.items.length > 0
    ) {
      return paginationSuccess(
        firstRequest,
        parsed.mode,
        pages,
        items,
        "max_items",
      );
    }
    if (pages.length >= parsed.maxPages) {
      return paginationSuccess(
        firstRequest,
        parsed.mode,
        pages,
        items,
        "max_pages",
      );
    }
    if (seenTargets.has(requestFingerprint(extracted.next))) {
      return paginationSuccess(
        firstRequest,
        parsed.mode,
        pages,
        items,
        "loop_detected",
      );
    }
    request = extracted.next;
  }
}

export function createPaginateTool(
  dependencies: PaginationToolDependencies,
) {
  return {
    name: "nango_proxy_paginate",
    label: "Nango provider pagination",
    description:
      "Read bounded registered provider pages through the Cloud.ru Nango proxy.",
    parameters: PAGINATE_PARAMETERS,
    async execute(
      toolCallId: string,
      params: unknown,
    ): Promise<
      ToolExecutionResult<ToolResult | PaginationSuccess>
    > {
      let authorization: ReturnType<
        ApprovalController["authorizeExecution"]
      >;
      try {
        authorization = dependencies.approvals.authorizeExecution(
          "nango_proxy_paginate",
          toolCallId,
          params,
        );
      } catch {
        return toolExecutionResult(
          authorizationFailure("invalid_tool_call"),
        );
      }
      if (!authorization.ok) {
        return toolExecutionResult(
          authorizationFailure(authorization.code),
        );
      }
      if (authorization.operationKind !== "read") {
        return toolExecutionResult(
          authorizationFailure("invalid_tool_call"),
        );
      }
      if (!dependencies.config || !dependencies.client) {
        return toolExecutionResult(runtimeConfigFailure());
      }

      let parsed: ParsedPagination;
      try {
        const publicParams = stripAuthorizedProof(params);
        parsed = parsePagination(
          publicParams,
          dependencies.config,
          authorization.operationKind,
        );
      } catch (error) {
        return toolExecutionResult(
          preflightFailure(
            error instanceof PaginationError
              ? error.code
              : "invalid_pagination_request",
          ),
        );
      }
      return toolExecutionResult(
        await executePagination(
          parsed,
          dependencies.config,
          dependencies.client,
        ),
      );
    },
  };
}
