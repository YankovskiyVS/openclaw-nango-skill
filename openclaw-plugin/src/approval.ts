import {
  createHash,
  createHmac,
  randomBytes as cryptoRandomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  getProviderCatalogEntry,
  validateProviderKey,
  type ProviderKey,
} from "./catalog.js";
import {
  encodeOrderedQuery,
  isReadMethod,
  validateHttpMethod,
  validateProviderHeaders,
  validateRelativeProviderPath,
  validateRequestBody,
  type HttpMethod,
} from "./validation.js";

export const APPROVAL_PROOF_PARAM = "__nangoApprovalProof";
export const APPROVAL_TIMEOUT_MS = 120_000;

const PLUGIN_ID = "nango-tools";
const DEFAULT_PROOF_TTL_MS = APPROVAL_TIMEOUT_MS + 30_000;
const DEFAULT_MAX_RECORDS = 1_024;
const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_NODES = 100_000;
const MAX_CANONICAL_BYTES = 32 * 1_024 * 1_024;
const MAX_REQUEST_BODY_BYTES = 16 * 1_024 * 1_024;
const MAX_TITLE_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 320;
const MAX_TARGET_CHARS = 160;
const PROOF_VERSION = "v1";
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export const NANGO_TOOL_NAMES = Object.freeze([
  "nango_proxy_request",
  "nango_proxy_paginate",
  "nango_action",
  "nango_disk_transfer",
] as const);

export type NangoToolName = (typeof NANGO_TOOL_NAMES)[number];
export type OperationKind = "read" | "mutation";
export type ApprovalSeverity = "warning" | "critical";

const NANGO_TOOL_NAME_SET = new Set<string>(NANGO_TOOL_NAMES);
const REQUEST_PARAM_KEYS = Object.freeze([
  "providerConfigKey",
  "method",
  "path",
  "query",
  "headers",
  "jsonBody",
  "textBody",
  "base64Body",
  "contentType",
  "timeoutMs",
] as const);
const REQUEST_PARAM_KEY_SET = new Set<string>(REQUEST_PARAM_KEYS);
const PAGINATION_PARAM_KEY_SET = new Set<string>([
  ...REQUEST_PARAM_KEYS,
  "mode",
  "maxPages",
  "maxItems",
]);
const DISK_PARAM_KEY_SET = new Set([
  "providerConfigKey",
  "direction",
  "operation",
  "localPath",
  "remotePath",
  "overwrite",
  "timeoutMs",
]);
const RESERVED_TRUST_KEYS = new Set([
  APPROVAL_PROOF_PARAM,
  "approvalProof",
  "operationKind",
]);

const BITRIX_READ_TERMINALS = new Set([
  "current",
  "fields",
  "get",
  "getavailablefields",
  "getfields",
  "getlist",
  "getstatuses",
  "gettypes",
  "history",
  "items",
  "list",
  "read",
  "search",
  "statuses",
  "types",
]);
const BITRIX_MUTATION_SEGMENTS = new Set([
  "activate",
  "add",
  "attach",
  "bind",
  "call",
  "cancel",
  "change",
  "close",
  "complete",
  "copy",
  "create",
  "deactivate",
  "delete",
  "detach",
  "disable",
  "enable",
  "execute",
  "finish",
  "grant",
  "invite",
  "join",
  "kick",
  "leave",
  "mark",
  "move",
  "mute",
  "open",
  "pause",
  "pin",
  "publish",
  "register",
  "remove",
  "renew",
  "resume",
  "revoke",
  "run",
  "send",
  "set",
  "start",
  "stop",
  "unbind",
  "unmute",
  "unpin",
  "unregister",
  "update",
  "upload",
]);
const CRITICAL_TARGET_SEGMENTS = new Set([
  "delete",
  "overwrite",
  "publish",
  "remove",
  "send",
]);

export const ACTION_OPERATION_REGISTRY = Object.freeze({
  "yandex-mail": Object.freeze({
    "resolve-mailbox": "read",
    "list-messages": "read",
    "get-message": "read",
    "send-message": "mutation",
  }),
  "amocrm-chats": Object.freeze({
    "send-message": "mutation",
  }),
} as const);

export type AllowedClassification = Readonly<{
  status: "allowed";
  operationKind: OperationKind;
  providerConfigKey: ProviderKey;
  target: string;
  severity: ApprovalSeverity;
  action: string;
}>;

export type BlockedClassification = Readonly<{
  status: "blocked";
  code: string;
}>;

export type ToolCallClassification =
  | AllowedClassification
  | BlockedClassification
  | Readonly<{ status: "unrelated" }>;

type ApprovalResolution =
  | "allow-once"
  | "allow-always"
  | "deny"
  | "timeout"
  | "cancelled";

export type ApprovalHookResult = Readonly<{
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: Readonly<{
    title: string;
    description: string;
    severity: ApprovalSeverity;
    timeoutMs: number;
    allowedDecisions: Array<"allow-once" | "deny">;
    pluginId: string;
    onResolution: (decision: ApprovalResolution) => void;
  }>;
}>;

export type ExecutionAuthorization =
  | Readonly<{ ok: true; operationKind: OperationKind }>
  | Readonly<{
      ok: false;
      code: "invalid_tool_call" | "approval_required";
    }>;

export type ApprovalController = Readonly<{
  beforeToolCall: (event: {
    toolName: string;
    params: unknown;
    toolCallId?: string;
  }) => ApprovalHookResult | undefined;
  authorizeExecution: (
    toolName: string,
    toolCallId: string,
    params: unknown,
  ) => ExecutionAuthorization;
  verifyAndConsume: (
    toolName: string,
    toolCallId: string,
    params: unknown,
  ) => ExecutionAuthorization;
  pendingRecordCount: () => number;
}>;

export type ApprovalControllerOptions = Readonly<{
  key?: Uint8Array;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  proofTtlMs?: number;
  maxRecords?: number;
}>;

class ApprovalPolicyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ApprovalPolicyError";
    this.code = code;
  }
}

type CanonicalState = {
  seen: Set<object>;
  nodes: number;
};

type RequestFacts = {
  providerConfigKey: ProviderKey;
  family: "yandex" | "bitrix24" | "amocrm";
  method: HttpMethod;
  path: string;
  params: Record<string, unknown>;
};

type ApprovalRecord = {
  state: "pending" | "approved";
  toolName: NangoToolName;
  toolCallId: string;
  nonce: string;
  expiresAt: number;
  paramsHash: string;
};

function fail(code: string): never {
  throw new ApprovalPolicyError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function frame(tag: string, payload: string): string {
  return `${tag}${Buffer.byteLength(payload, "utf8")}:${payload}`;
}

function canonicalizeValue(
  value: unknown,
  state: CanonicalState,
  depth: number,
): string {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
    fail("invalid_params");
  }
  if (value === null) {
    return "z";
  }
  if (typeof value === "boolean") {
    return value ? "b1" : "b0";
  }
  if (typeof value === "string") {
    return frame("s", JSON.stringify(value));
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("invalid_params");
    }
    return frame("n", Object.is(value, -0) ? "-0" : String(value));
  }
  if (typeof value !== "object") {
    fail("invalid_params");
  }
  if (state.seen.has(value)) {
    fail("invalid_params");
  }

  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)),
        )
      ) {
        fail("invalid_params");
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        ) {
          fail("invalid_params");
        }
        items.push(
          frame(
            "i",
            canonicalizeValue(descriptor.value, state, depth + 1),
          ),
        );
      }
      return frame("a", items.join(""));
    }

    if (!isPlainRecord(value)) {
      fail("invalid_params");
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      fail("invalid_params");
    }
    const stringKeys = (ownKeys as string[]).toSorted();
    const entries: string[] = [];
    for (const key of stringKeys) {
      if (RESERVED_TRUST_KEYS.has(key)) {
        fail("reserved_param");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        fail("invalid_params");
      }
      entries.push(
        frame("k", JSON.stringify(key)),
        frame(
          "v",
          canonicalizeValue(descriptor.value, state, depth + 1),
        ),
      );
    }
    return frame("o", entries.join(""));
  } finally {
    state.seen.delete(value);
  }
}

export function canonicalizeBusinessParams(value: unknown): string {
  const canonical = canonicalizeValue(
    value,
    { seen: new Set(), nodes: 0 },
    0,
  );
  if (Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_BYTES) {
    fail("invalid_params");
  }
  return canonical;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail("unknown_param");
    }
  }
}

function validateOptionalTimeout(value: unknown): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || (value as number) < 1)
  ) {
    fail("invalid_timeout");
  }
}

function validateRequestParams(value: unknown): RequestFacts {
  if (!isPlainRecord(value)) {
    fail("invalid_params");
  }
  canonicalizeBusinessParams(value);
  assertOnlyKeys(value, REQUEST_PARAM_KEY_SET);

  const providerConfigKey = validateProviderKey(value.providerConfigKey);
  const provider = getProviderCatalogEntry(providerConfigKey);
  const method = validateHttpMethod(value.method);
  const path = validateRelativeProviderPath(value.path);

  if (value.query !== undefined) {
    encodeOrderedQuery(value.query);
  }
  if (value.headers !== undefined) {
    validateProviderHeaders(value.headers);
  }
  validateOptionalTimeout(value.timeoutMs);

  const bodyInput: Record<string, unknown> = {};
  for (const key of [
    "jsonBody",
    "textBody",
    "base64Body",
    "contentType",
  ] as const) {
    if (Object.hasOwn(value, key)) {
      bodyInput[key] = value[key];
    }
  }
  validateRequestBody(bodyInput, MAX_REQUEST_BODY_BYTES);

  return {
    providerConfigKey,
    family: provider.family,
    method,
    path,
    params: value,
  };
}

function stripBitrixJsonSuffix(value: string): string {
  const withoutTrailingSlash = value.endsWith("/")
    ? value.slice(0, -1)
    : value;
  return withoutTrailingSlash.toLowerCase().endsWith(".json")
    ? withoutTrailingSlash.slice(0, -5)
    : withoutTrailingSlash;
}

function classifyBitrixMethod(value: string): OperationKind {
  let method = value.trim();
  if (method.length === 0 || method.includes("%")) {
    return "mutation";
  }
  try {
    method = decodeURIComponent(method);
  } catch {
    return "mutation";
  }
  method = stripBitrixJsonSuffix(method).toLowerCase();
  if (!/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(method)) {
    return "mutation";
  }
  const segments = method.split(".");
  if (segments.some((segment) => BITRIX_MUTATION_SEGMENTS.has(segment))) {
    return "mutation";
  }
  const terminal = segments.at(-1);
  return terminal && BITRIX_READ_TERMINALS.has(terminal)
    ? "read"
    : "mutation";
}

function commandMethod(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const rawMethod = value.split("?", 1)[0]?.trim();
  if (!rawMethod || rawMethod.startsWith("/") || rawMethod.includes("%")) {
    return undefined;
  }
  return rawMethod;
}

function collectBatchCommands(params: Record<string, unknown>): unknown[] {
  const commands: unknown[] = [];
  if (Array.isArray(params.query)) {
    for (const pair of params.query) {
      if (
        isPlainRecord(pair) &&
        typeof pair.name === "string" &&
        /^cmd(?:\[[^\]]+\])?$/i.test(pair.name)
      ) {
        commands.push(pair.value);
      }
    }
  }
  if (isPlainRecord(params.jsonBody)) {
    const batchCommands = params.jsonBody.cmd;
    if (Array.isArray(batchCommands)) {
      commands.push(...batchCommands);
    } else if (isPlainRecord(batchCommands)) {
      commands.push(...Object.values(batchCommands));
    } else if (batchCommands !== undefined) {
      commands.push(batchCommands);
    }
  }
  return commands;
}

function classifyBitrixBatch(params: Record<string, unknown>): OperationKind {
  const commands = collectBatchCommands(params);
  if (commands.length === 0) {
    return "mutation";
  }
  return commands.every((command) => {
    const method = commandMethod(command);
    return method !== undefined && classifyBitrixMethod(method) === "read";
  })
    ? "read"
    : "mutation";
}

function directJsonRpcIsRead(facts: RequestFacts): boolean {
  return (
    facts.providerConfigKey === "yandex-direct" &&
    facts.method === "POST" &&
    /^json\/v5\/[A-Za-z0-9_-]+$/.test(facts.path) &&
    isPlainRecord(facts.params.jsonBody) &&
    facts.params.jsonBody.method === "get"
  );
}

function classifyRequestOperation(facts: RequestFacts): OperationKind {
  if (directJsonRpcIsRead(facts)) {
    return "read";
  }
  if (
    facts.family === "bitrix24" &&
    (isReadMethod(facts.method) || facts.method === "POST")
  ) {
    const normalizedPath = stripBitrixJsonSuffix(facts.path).toLowerCase();
    if (normalizedPath === "batch") {
      return classifyBitrixBatch(facts.params);
    }
    if (
      /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+(?:\.json)?\/?$/.test(
        facts.path,
      )
    ) {
      return classifyBitrixMethod(facts.path);
    }
    return isReadMethod(facts.method) ? "read" : "mutation";
  }
  return isReadMethod(facts.method) ? "read" : "mutation";
}

function boundedTarget(value: string): string {
  if (value.length <= MAX_TARGET_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_TARGET_CHARS - 1)}…`;
}

function requestSeverity(
  facts: RequestFacts,
  operationKind: OperationKind,
): ApprovalSeverity {
  if (operationKind === "read") {
    return "warning";
  }
  if (facts.method === "DELETE") {
    return "critical";
  }
  const segments = stripBitrixJsonSuffix(facts.path)
    .toLowerCase()
    .split(/[./_-]+/);
  if (
    segments.some((segment) => CRITICAL_TARGET_SEGMENTS.has(segment)) ||
    facts.path.toLowerCase() === "im.message.add"
  ) {
    return "critical";
  }
  return "warning";
}

function allowedRequestClassification(
  facts: RequestFacts,
): AllowedClassification {
  const operationKind = classifyRequestOperation(facts);
  return {
    status: "allowed",
    operationKind,
    providerConfigKey: facts.providerConfigKey,
    target: boundedTarget(
      `${facts.providerConfigKey}:${facts.path}`,
    ),
    severity: requestSeverity(facts, operationKind),
    action: `${facts.method} provider request`,
  };
}

function isRegisteredPaginationRead(facts: RequestFacts): boolean {
  if (classifyRequestOperation(facts) !== "read") {
    return false;
  }
  if (facts.family === "bitrix24") {
    const path = stripBitrixJsonSuffix(facts.path).toLowerCase();
    if (path === "batch") {
      return classifyBitrixBatch(facts.params) === "read";
    }
    return (
      /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+(?:\.json)?\/?$/.test(
        facts.path,
      ) && classifyBitrixMethod(facts.path) === "read"
    );
  }
  if (facts.family === "amocrm") {
    return (
      facts.method === "GET" &&
      /^api\/v4\/(?:account|catalogs|companies|contacts|customers|events|leads|talks|tasks|users)(?:\/|$)/.test(
        facts.path,
      )
    );
  }
  if (
    (facts.providerConfigKey === "yandex-id" ||
      facts.providerConfigKey === "yandex") &&
    facts.method === "GET" &&
    facts.path === "info"
  ) {
    return true;
  }
  if (
    facts.providerConfigKey === "yandex-disk" &&
    facts.method === "GET" &&
    /^v1\/disk(?:\/resources(?:\/|$)|$)/.test(facts.path)
  ) {
    return true;
  }
  if (
    facts.providerConfigKey === "yandex-calendar" &&
    (facts.method === "PROPFIND" || facts.method === "REPORT") &&
    /^calendars(?:\/|$)/.test(facts.path)
  ) {
    return true;
  }
  if (
    facts.providerConfigKey === "yandex-direct" &&
    directJsonRpcIsRead(facts) &&
    /^json\/v5\/[A-Za-z0-9_-]+$/.test(facts.path)
  ) {
    return true;
  }
  return (
    facts.providerConfigKey === "yandex-market" &&
    facts.method === "GET" &&
    /^v2\/campaigns(?:\/|$)/.test(facts.path)
  );
}

function proxyRequestFromPagination(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const request: Record<string, unknown> = {};
  for (const key of REQUEST_PARAM_KEYS) {
    if (Object.hasOwn(params, key)) {
      request[key] = params[key];
    }
  }
  return request;
}

function classifyPagination(value: unknown): AllowedClassification {
  if (!isPlainRecord(value)) {
    fail("invalid_params");
  }
  canonicalizeBusinessParams(value);
  assertOnlyKeys(value, PAGINATION_PARAM_KEY_SET);
  if (
    typeof value.mode !== "string" ||
    !["link", "offset", "body-offset", "single"].includes(value.mode)
  ) {
    fail("invalid_pagination");
  }
  for (const key of ["maxPages", "maxItems"] as const) {
    if (
      !Number.isSafeInteger(value[key]) ||
      (value[key] as number) < 1
    ) {
      fail("invalid_pagination");
    }
  }

  const facts = validateRequestParams(proxyRequestFromPagination(value));
  if (!isRegisteredPaginationRead(facts)) {
    fail("unsupported_pagination_contract");
  }
  return {
    ...allowedRequestClassification(facts),
    operationKind: "read",
    severity: "warning",
    action: "paginate provider read",
  };
}

function registeredActionKind(
  providerConfigKey: ProviderKey,
  actionName: string,
): OperationKind | undefined {
  if (
    providerConfigKey !== "yandex-mail" &&
    providerConfigKey !== "amocrm-chats"
  ) {
    return undefined;
  }
  const actions = ACTION_OPERATION_REGISTRY[providerConfigKey];
  return Object.hasOwn(actions, actionName)
    ? actions[actionName as keyof typeof actions]
    : undefined;
}

function classifyAction(value: unknown): AllowedClassification {
  if (!isPlainRecord(value)) {
    fail("invalid_params");
  }
  canonicalizeBusinessParams(value);
  assertOnlyKeys(
    value,
    new Set([
      "providerConfigKey",
      "actionName",
      "action",
      "input",
      "timeoutMs",
    ]),
  );

  const providerConfigKey = validateProviderKey(value.providerConfigKey);
  const actionName =
    typeof value.actionName === "string"
      ? value.actionName
      : typeof value.action === "string"
        ? value.action
        : undefined;
  if (
    !actionName ||
    (value.actionName !== undefined &&
      value.action !== undefined &&
      value.actionName !== value.action)
  ) {
    fail("invalid_action");
  }
  validateOptionalTimeout(value.timeoutMs);
  const operationKind = registeredActionKind(
    providerConfigKey,
    actionName,
  );
  if (!operationKind) {
    fail("unsupported_action");
  }
  if (
    value.input !== undefined
      ? !isPlainRecord(value.input)
      : actionName !== "resolve-mailbox"
  ) {
    fail("invalid_action_input");
  }
  const critical = /(?:^|-)(?:send|publish|delete|remove)(?:-|$)/.test(
    actionName,
  );
  return {
    status: "allowed",
    operationKind,
    providerConfigKey,
    target: boundedTarget(`${providerConfigKey}:${actionName}`),
    severity: critical ? "critical" : "warning",
    action: "run registered action",
  };
}

function classifyDiskTransfer(value: unknown): AllowedClassification {
  if (!isPlainRecord(value)) {
    fail("invalid_params");
  }
  canonicalizeBusinessParams(value);
  assertOnlyKeys(value, DISK_PARAM_KEY_SET);
  const providerConfigKey = validateProviderKey(value.providerConfigKey);
  if (providerConfigKey !== "yandex-disk") {
    fail("invalid_disk_provider");
  }
  const direction =
    typeof value.direction === "string"
      ? value.direction
      : typeof value.operation === "string"
        ? value.operation
        : undefined;
  if (
    (direction !== "upload" && direction !== "download") ||
    (value.direction !== undefined &&
      value.operation !== undefined &&
      value.direction !== value.operation)
  ) {
    fail("invalid_disk_operation");
  }
  if (
    value.overwrite !== undefined &&
    typeof value.overwrite !== "boolean"
  ) {
    fail("invalid_disk_operation");
  }
  for (const key of ["localPath", "remotePath"] as const) {
    if (
      typeof value[key] !== "string" ||
      value[key].length === 0 ||
      Buffer.byteLength(value[key], "utf8") > 4_096 ||
      /[\u0000-\u001f\u007f]/.test(value[key])
    ) {
      fail("invalid_disk_path");
    }
  }
  validateOptionalTimeout(value.timeoutMs);
  return {
    status: "allowed",
    operationKind: "mutation",
    providerConfigKey,
    target: `${providerConfigKey}:${direction}`,
    severity: value.overwrite === true ? "critical" : "warning",
    action: `${direction} disk file`,
  };
}

function classifyKnownTool(
  toolName: NangoToolName,
  params: unknown,
): AllowedClassification {
  if (toolName === "nango_proxy_request") {
    return allowedRequestClassification(validateRequestParams(params));
  }
  if (toolName === "nango_proxy_paginate") {
    return classifyPagination(params);
  }
  if (toolName === "nango_action") {
    return classifyAction(params);
  }
  return classifyDiskTransfer(params);
}

export function classifyNangoToolCall(
  toolName: string,
  params: unknown,
): ToolCallClassification {
  if (!NANGO_TOOL_NAME_SET.has(toolName)) {
    return { status: "unrelated" };
  }
  try {
    return classifyKnownTool(toolName as NangoToolName, params);
  } catch (error) {
    return {
      status: "blocked",
      code:
        error instanceof ApprovalPolicyError
          ? error.code
          : "invalid_tool_call",
    };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function proofSigningInput(record: ApprovalRecord): string {
  return [
    PROOF_VERSION,
    frame("t", record.toolName),
    frame("c", record.toolCallId),
    frame("e", String(record.expiresAt)),
    frame("n", record.nonce),
    frame("p", record.paramsHash),
  ].join("\n");
}

function signRecord(key: Uint8Array, record: ApprovalRecord): string {
  return createHmac("sha256", key)
    .update(proofSigningInput(record), "utf8")
    .digest("base64url");
}

function serializeProof(key: Uint8Array, record: ApprovalRecord): string {
  return [
    PROOF_VERSION,
    String(record.expiresAt),
    record.nonce,
    signRecord(key, record),
  ].join(".");
}

function parseProof(
  value: unknown,
):
  | {
      expiresAt: number;
      nonce: string;
      mac: string;
    }
  | undefined {
  if (typeof value !== "string" || value.length > 512) {
    return undefined;
  }
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== PROOF_VERSION) {
    return undefined;
  }
  const expiresAt = Number(parts[1]);
  const nonce = parts[2];
  const mac = parts[3];
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < 0 ||
    String(expiresAt) !== parts[1] ||
    !nonce ||
    !mac ||
    !BASE64URL_RE.test(nonce) ||
    !BASE64URL_RE.test(mac) ||
    Buffer.from(nonce, "base64url").toString("base64url") !== nonce ||
    Buffer.from(mac, "base64url").toString("base64url") !== mac ||
    Buffer.from(nonce, "base64url").byteLength < 16 ||
    Buffer.from(mac, "base64url").byteLength !== 32
  ) {
    return undefined;
  }
  return { expiresAt, nonce, mac };
}

function constantTimeMacEqual(expected: string, actual: string): boolean {
  let expectedBytes: Buffer;
  let actualBytes: Buffer;
  try {
    expectedBytes = Buffer.from(expected, "base64url");
    actualBytes = Buffer.from(actual, "base64url");
  } catch {
    return false;
  }
  return (
    expectedBytes.length === actualBytes.length &&
    expectedBytes.length === 32 &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

function withoutTopLevelProof(value: unknown):
  | {
      businessParams: Record<string, unknown>;
      proof: unknown;
      hasProof: boolean;
    }
  | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const businessParams: Record<string, unknown> = {};
  let proof: unknown;
  let hasProof = false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      return undefined;
    }
    if (key === APPROVAL_PROOF_PARAM) {
      proof = descriptor.value;
      hasProof = true;
    } else {
      Object.defineProperty(businessParams, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return { businessParams, proof, hasProof };
}

function blockReason(code: string): string {
  if (code === "missing_tool_call_id") {
    return "Nango mutation blocked because no tool call id was provided";
  }
  return "Invalid or unsupported Nango tool call";
}

function approvalText(
  classification: AllowedClassification,
): Readonly<{ title: string; description: string }> {
  const title =
    classification.severity === "critical"
      ? "Confirm high-impact Nango mutation"
      : "Confirm Nango mutation";
  const description = boundedTarget(
    `Allow one ${classification.action} for ${classification.target}. ` +
      "This approval applies only to this exact tool call.",
  );
  return {
    title: title.slice(0, MAX_TITLE_CHARS),
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
  };
}

export function createApprovalController(
  options: ApprovalControllerOptions = {},
): ApprovalController {
  const key = new Uint8Array(options.key ?? cryptoRandomBytes(32));
  if (key.byteLength < 32) {
    throw new Error("approval key must contain at least 32 bytes");
  }
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  const proofTtlMs = options.proofTtlMs ?? DEFAULT_PROOF_TTL_MS;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  if (!Number.isSafeInteger(proofTtlMs) || proofTtlMs < 1) {
    throw new Error("proofTtlMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
    throw new Error("maxRecords must be a positive safe integer");
  }

  const records = new Map<string, ApprovalRecord>();

  function recordId(toolCallId: string, nonce: string): string {
    return `${toolCallId}\u0000${nonce}`;
  }

  function cleanup(timestamp: number): void {
    for (const [id, record] of records) {
      if (record.expiresAt < timestamp) {
        records.delete(id);
      }
    }
    while (records.size >= maxRecords) {
      const oldest = records.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      records.delete(oldest);
    }
  }

  function issue(
    toolName: NangoToolName,
    toolCallId: string,
    params: Record<string, unknown>,
  ): { proof: string; id: string } {
    const timestamp = now();
    cleanup(timestamp);
    const nonceBytes = new Uint8Array(randomBytes(16));
    if (nonceBytes.byteLength < 16) {
      fail("invalid_nonce_source");
    }
    const nonce = Buffer.from(nonceBytes).toString("base64url");
    const record: ApprovalRecord = {
      state: "pending",
      toolName,
      toolCallId,
      nonce,
      expiresAt: timestamp + proofTtlMs,
      paramsHash: sha256(canonicalizeBusinessParams(params)),
    };
    const id = recordId(toolCallId, nonce);
    records.set(id, record);
    return { proof: serializeProof(key, record), id };
  }

  function beforeToolCall(event: {
    toolName: string;
    params: unknown;
    toolCallId?: string;
  }): ApprovalHookResult | undefined {
    const classification = classifyNangoToolCall(
      event.toolName,
      event.params,
    );
    if (classification.status === "unrelated") {
      return undefined;
    }
    if (classification.status === "blocked") {
      return {
        block: true,
        blockReason: blockReason(classification.code),
      };
    }
    if (classification.operationKind === "read") {
      return undefined;
    }
    if (
      typeof event.toolCallId !== "string" ||
      event.toolCallId.length === 0
    ) {
      return {
        block: true,
        blockReason: blockReason("missing_tool_call_id"),
      };
    }
    if (!isPlainRecord(event.params)) {
      return {
        block: true,
        blockReason: blockReason("invalid_tool_call"),
      };
    }

    try {
      const issued = issue(
        event.toolName as NangoToolName,
        event.toolCallId,
        event.params,
      );
      const text = approvalText(classification);
      return {
        params: {
          ...event.params,
          [APPROVAL_PROOF_PARAM]: issued.proof,
        },
        requireApproval: {
          ...text,
          severity: classification.severity,
          timeoutMs: APPROVAL_TIMEOUT_MS,
          allowedDecisions: ["allow-once", "deny"],
          pluginId: PLUGIN_ID,
          onResolution(decision) {
            const record = records.get(issued.id);
            if (
              decision === "allow-once" &&
              record?.state === "pending" &&
              record.expiresAt >= now()
            ) {
              record.state = "approved";
              return;
            }
            records.delete(issued.id);
          },
        },
      };
    } catch {
      return {
        block: true,
        blockReason: blockReason("invalid_tool_call"),
      };
    }
  }

  function authorizeExecution(
    toolName: string,
    toolCallId: string,
    params: unknown,
  ): ExecutionAuthorization {
    try {
      const split = withoutTopLevelProof(params);
      if (!split) {
        return { ok: false, code: "invalid_tool_call" };
      }
      const classification = classifyNangoToolCall(
        toolName,
        split.businessParams,
      );
      if (
        classification.status === "blocked" ||
        classification.status === "unrelated"
      ) {
        return { ok: false, code: "invalid_tool_call" };
      }
      if (classification.operationKind === "read") {
        return split.hasProof
          ? { ok: false, code: "invalid_tool_call" }
          : { ok: true, operationKind: "read" };
      }
      if (!split.hasProof) {
        return { ok: false, code: "approval_required" };
      }

      const parsed = parseProof(split.proof);
      if (!parsed) {
        return { ok: false, code: "approval_required" };
      }
      const id = recordId(toolCallId, parsed.nonce);
      const record = records.get(id);
      if (!record) {
        return { ok: false, code: "approval_required" };
      }

      // Consume before performing any comparison that could throw. A failed
      // verification cannot leave a usable approval record behind.
      records.delete(id);
      const timestamp = now();
      if (
        record.state !== "approved" ||
        record.expiresAt < timestamp ||
        record.expiresAt !== parsed.expiresAt ||
        record.toolName !== toolName ||
        record.toolCallId !== toolCallId
      ) {
        return { ok: false, code: "approval_required" };
      }
      const paramsHash = sha256(
        canonicalizeBusinessParams(split.businessParams),
      );
      if (paramsHash !== record.paramsHash) {
        return { ok: false, code: "approval_required" };
      }
      const expectedMac = signRecord(key, record);
      if (!constantTimeMacEqual(expectedMac, parsed.mac)) {
        return { ok: false, code: "approval_required" };
      }
      return { ok: true, operationKind: "mutation" };
    } catch {
      return { ok: false, code: "invalid_tool_call" };
    }
  }

  return Object.freeze({
    beforeToolCall,
    authorizeExecution,
    verifyAndConsume: authorizeExecution,
    pendingRecordCount: () => records.size,
  });
}
