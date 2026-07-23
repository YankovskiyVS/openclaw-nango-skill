import {
  ACTION_PARAMETERS,
  resolveActionRegistration,
  type ActionOperationKind,
  type ActionRegistration,
  type PublicActionProvider,
} from "../action-registry.js";
import type { ApprovalController } from "../approval.js";
import type { RuntimeConfig, RuntimeActionsConfig } from "../config.js";
import { deriveConnectionId } from "../proxy-client.js";
import {
  containsConfiguredSecret,
  createFailureResult,
  createSuccessResult,
  filterResponseHeaders,
  type ErrorLayer,
  type FailureDescriptor,
  type JsonValue,
  type RequestSummary,
  type ToolResult,
} from "../result.js";
import {
  authorizationFailure,
  runtimeConfigFailure,
  stripAuthorizedProof,
  toolExecutionResult,
  type ToolExecutionResult,
} from "./request.js";

const TOOL_NAME = "nango_action";
const PUBLIC_PARAM_KEYS = new Set([
  "providerConfigKey",
  "actionName",
  "action",
  "input",
  "timeoutMs",
]);
const JSON_MEDIA_TYPE_RE =
  /^application\/(?:[A-Za-z0-9!#$&^_.+-]*\+)?json(?:\s*;|$)/i;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SAFE_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_ERROR_LAYERS = new Set<ErrorLayer>([
  "validation",
  "approval",
  "cloudru_proxy",
  "nango",
  "provider",
  "unknown_upstream",
  "network",
  "local_io",
]);
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
const INVALID_ACTION_SUMMARY: RequestSummary = Object.freeze({
  providerConfigKey: "yandex-mail",
  method: "POST",
  path: "action/trigger",
});

function retryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ActionToolDependencies = Readonly<{
  config?: RuntimeConfig;
  approvals: Pick<ApprovalController, "authorizeExecution">;
  fetch?: FetchLike;
}>;

type ParsedActionCall = Readonly<{
  registration: ActionRegistration;
  input: JsonValue;
  timeoutMs: number;
  summary: RequestSummary;
}>;

class ActionTransportError extends Error {
  readonly layer: ErrorLayer;
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    layer: ErrorLayer,
    code: string,
    retryable = false,
    status?: number,
  ) {
    super(code);
    this.name = "ActionTransportError";
    this.layer = layer;
    this.code = code;
    this.retryable = retryable;
    if (status !== undefined) {
      this.status = status;
    }
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

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function assertPublicParams(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !PUBLIC_PARAM_KEYS.has(key) ||
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new Error("invalid_action_request");
    }
  }
}

function actionName(value: Record<string, unknown>): string {
  const primary =
    typeof value.actionName === "string"
      ? value.actionName
      : undefined;
  const alias =
    typeof value.action === "string" ? value.action : undefined;
  if (
    (primary === undefined && alias === undefined) ||
    (primary !== undefined &&
      alias !== undefined &&
      primary !== alias)
  ) {
    throw new Error("invalid_action_request");
  }
  return primary ?? alias!;
}

function serializedBytes(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function parseActionCall(
  value: unknown,
  config: RuntimeConfig,
  operationKind: ActionOperationKind,
): ParsedActionCall {
  if (!isPlainRecord(value)) {
    throw new Error("invalid_action_request");
  }
  assertPublicParams(value);
  const name = actionName(value);
  const registration = resolveActionRegistration(
    value.providerConfigKey,
    name,
  );
  if (
    !registration ||
    registration.operationKind !== operationKind ||
    config.actions === undefined
  ) {
    throw new Error("invalid_action_request");
  }
  const timeout =
    value.timeoutMs === undefined
      ? config.actions.syncTimeoutMs
      : value.timeoutMs;
  if (
    !Number.isSafeInteger(timeout) ||
    (timeout as number) < 1 ||
    (timeout as number) > config.actions.syncTimeoutMs
  ) {
    throw new Error("invalid_action_request");
  }
  const input = registration.parseInput(value.input);
  if (serializedBytes(input) > config.actions.maxInputBytes) {
    throw new Error("invalid_action_request");
  }
  return Object.freeze({
    registration,
    input,
    timeoutMs: timeout as number,
    summary: Object.freeze({
      providerConfigKey: registration.publicProviderConfigKey,
      method: "POST",
      path: "action/trigger",
    }),
  });
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) {
        throw new ActionTransportError(
          "network",
          "action_timeout",
          true,
        );
      }
      const { done, value } = await new Promise<
        ReadableStreamReadResult<Uint8Array>
      >((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) {
            return;
          }
          settled = true;
          void reader.cancel().catch(() => undefined);
          reject(
            new ActionTransportError(
              "network",
              "action_timeout",
              true,
            ),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        void reader.read().then(
          (result) => {
            if (settled) {
              return;
            }
            settled = true;
            signal.removeEventListener("abort", onAbort);
            resolve(result);
          },
          () => {
            if (settled) {
              return;
            }
            settled = true;
            signal.removeEventListener("abort", onAbort);
            reject(
              new ActionTransportError(
                "network",
                signal.aborted
                  ? "action_timeout"
                  : "network_error",
                true,
              ),
            );
          },
        );
      });
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ActionTransportError(
          "unknown_upstream",
          "response_too_large",
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled pending read owns the lock until cancellation settles.
    }
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    throw new ActionTransportError(
      "unknown_upstream",
      "invalid_action_response",
    );
  }
}

function assertJsonValue(value: unknown): asserts value is JsonValue {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > 100_000 || current.depth > 64) {
      throw new ActionTransportError(
        "unknown_upstream",
        "invalid_action_response",
      );
    }
    const item = current.value;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean"
    ) {
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw new ActionTransportError(
          "unknown_upstream",
          "invalid_action_response",
        );
      }
      continue;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isPlainRecord(item)) {
      throw new ActionTransportError(
        "unknown_upstream",
        "invalid_action_response",
      );
    }
    for (const child of Object.values(item)) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreezeJson(child);
  }
  return Object.freeze(value);
}

function validSafeBusinessError(value: unknown): boolean {
  return (
    exactRecord(value, ["code", "message", "retryable"]) &&
    typeof value.code === "string" &&
    SAFE_CODE_RE.test(value.code) &&
    typeof value.message === "string" &&
    value.message.length >= 1 &&
    value.message.length <= 512 &&
    !CONTROL_RE.test(value.message) &&
    typeof value.retryable === "boolean"
  );
}

function businessEnvelope(
  value: unknown,
  registration: ActionRegistration,
): JsonValue {
  assertJsonValue(value);
  if (
    exactRecord(value, ["ok", "outcome", "result"]) &&
    value.ok === true &&
    value.outcome === "confirmed" &&
    registration.validateSuccessResult(value.result)
  ) {
    return deepFreezeJson(value);
  }
  if (
    exactRecord(value, ["ok", "outcome", "error"]) &&
    value.ok === false &&
    ["not_started", "confirmed_failed", "unknown"].includes(
      value.outcome as string,
    ) &&
    validSafeBusinessError(value.error)
  ) {
    return deepFreezeJson(value);
  }
  throw new ActionTransportError(
    "unknown_upstream",
    "invalid_action_response",
  );
}

function responseJson(
  text: string,
  contentType: string,
  secrets: readonly string[],
): unknown {
  if (
    new TextEncoder().encode(contentType).byteLength > 256 ||
    CONTROL_RE.test(contentType) ||
    !JSON_MEDIA_TYPE_RE.test(contentType) ||
    secrets.some(
      (secret) =>
        text.includes(secret) || contentType.includes(secret),
    )
  ) {
    throw new ActionTransportError(
      "unknown_upstream",
      "invalid_action_response",
    );
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (containsConfiguredSecret(parsed, secrets)) {
      throw new ActionTransportError(
        "unknown_upstream",
        "invalid_action_response",
      );
    }
    return parsed;
  } catch {
    throw new ActionTransportError(
      "unknown_upstream",
      "invalid_action_response",
    );
  }
}

function validProxyFailure(
  value: unknown,
): value is {
  layer: ErrorLayer;
  code: string;
  message: string;
  retryable: boolean;
} {
  return (
    exactRecord(value, ["layer", "code", "message", "retryable"]) &&
    typeof value.layer === "string" &&
    SAFE_ERROR_LAYERS.has(value.layer as ErrorLayer) &&
    typeof value.code === "string" &&
    SAFE_CODE_RE.test(value.code) &&
    typeof value.message === "string" &&
    value.message.length >= 1 &&
    value.message.length <= 512 &&
    !CONTROL_RE.test(value.message) &&
    typeof value.retryable === "boolean"
  );
}

function transportRequest(
  config: RuntimeConfig,
  actions: RuntimeActionsConfig,
  call: ParsedActionCall,
  signal: AbortSignal,
): Readonly<{
  url: string;
  init: RequestInit;
  secrets: readonly string[];
}> {
  const connectionId = deriveConnectionId(config);
  if (actions.transport.mode === "proxy") {
    return Object.freeze({
      url: actions.transport.endpointUrl,
      init: Object.freeze({
        method: "POST",
        redirect: "manual",
        signal,
        headers: Object.freeze({
          authorization: `Api-Key ${config.cloudru.apiKey}`,
          "content-type": "application/json",
        }),
        body: JSON.stringify({
          projectId: config.cloudru.projectId,
          evoClawId: config.cloudru.evoClawId,
          connectionId,
          providerConfigKey:
            call.registration.internalProviderConfigKey,
          actionName: call.registration.internalActionName,
          input: call.input,
        }),
      }),
      secrets: Object.freeze([config.cloudru.apiKey]),
    });
  }
  return Object.freeze({
    url: `${actions.transport.baseUrl}/action/trigger`,
    init: Object.freeze({
      method: "POST",
      redirect: "manual",
      signal,
      headers: Object.freeze({
        authorization: `Bearer ${actions.transport.secretKey}`,
        "connection-id": connectionId,
        "content-type": "application/json",
        "provider-config-key":
          call.registration.internalProviderConfigKey,
      }),
      body: JSON.stringify({
        action_name: call.registration.internalActionName,
        input: call.input,
      }),
    }),
    secrets: Object.freeze([
      config.cloudru.apiKey,
      actions.transport.secretKey,
    ]),
  });
}

function postDispatchFailure(
  summary: RequestSummary,
  operationKind: ActionOperationKind,
  error: ActionTransportError,
) {
  return createFailureResult(summary, {
    layer: error.layer,
    code: error.code,
    message:
      error.code === "action_timeout"
        ? "Action request timed out"
        : error.code === "network_error"
          ? "Action network request failed"
          : error.code === "response_too_large"
            ? "Action response exceeded the configured limit"
            : error.code === "redirect_blocked"
              ? "Action redirect was blocked"
              : error.code === "action_http_error"
                ? "Action endpoint rejected the request"
                : "Action endpoint returned an invalid response",
    ...(error.status === undefined ? {} : { status: error.status }),
    retryable: operationKind === "read" && error.retryable,
    outcome:
      operationKind === "mutation" ? "unknown" : "confirmed_failed",
  });
}

function resultFromBusinessEnvelope(
  summary: RequestSummary,
  status: number,
  contentType: string,
  headers: Headers,
  operationKind: ActionOperationKind,
  envelope: JsonValue,
): ToolResult {
  if (
    isPlainRecord(envelope) &&
    envelope.ok === false &&
    typeof envelope.outcome === "string" &&
    isPlainRecord(envelope.error) &&
    validSafeBusinessError(envelope.error)
  ) {
    const outcome = envelope.outcome;
    if (
      outcome !== "not_started" &&
      outcome !== "confirmed_failed" &&
      outcome !== "unknown"
    ) {
      throw new ActionTransportError(
        "unknown_upstream",
        "invalid_action_response",
      );
    }
    return createFailureResult(summary, {
      layer: "provider",
      code: envelope.error.code as string,
      message: envelope.error.message as string,
      retryable:
        operationKind === "read" &&
        (envelope.error.retryable as boolean),
      outcome,
    });
  }
  return createSuccessResult(summary, {
    status,
    contentType,
    headers: filterResponseHeaders(headers),
    body: envelope,
  });
}

async function executeTransport(
  config: RuntimeConfig,
  call: ParsedActionCall,
  fetch: FetchLike,
): Promise<ToolResult> {
  const actions = config.actions!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs);
  const request = transportRequest(
    config,
    actions,
    call,
    controller.signal,
  );
  try {
    let response: Response;
    try {
      response = await fetch(request.url, request.init);
    } catch {
      throw new ActionTransportError(
        "network",
        controller.signal.aborted ? "action_timeout" : "network_error",
        true,
      );
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      throw new ActionTransportError(
        actions.transport.mode === "proxy"
          ? "cloudru_proxy"
          : "nango",
        "redirect_blocked",
        false,
        response.status,
      );
    }
    const contentType = response.headers.get("content-type")?.trim() ?? "";
    const projectedHeaders = filterResponseHeaders(response.headers);
    if (
      containsConfiguredSecret(
        { contentType, headers: projectedHeaders },
        request.secrets,
      )
    ) {
      throw new ActionTransportError(
        "unknown_upstream",
        "invalid_action_response",
      );
    }
    const text = await readBoundedText(
      response,
      actions.maxOutputBytes,
      controller.signal,
    );
    const parsed = responseJson(text, contentType, request.secrets);

    if (actions.transport.mode === "proxy") {
      if (
        exactRecord(parsed, ["ok", "error"]) &&
        parsed.ok === false &&
        validProxyFailure(parsed.error)
      ) {
        const error = parsed.error;
        const descriptor: FailureDescriptor = {
          layer: error.layer,
          code: error.code,
          message: error.message,
          ...(response.ok ? {} : { status: response.status }),
          retryable:
            call.registration.operationKind === "read" &&
            error.retryable,
          outcome:
            call.registration.operationKind === "mutation"
              ? "unknown"
              : "confirmed_failed",
        };
        return createFailureResult(call.summary, descriptor);
      }
      if (
        !response.ok ||
        !exactRecord(parsed, ["ok", "result"]) ||
        parsed.ok !== true
      ) {
        throw new ActionTransportError(
          "cloudru_proxy",
          response.ok
            ? "invalid_action_response"
            : "action_http_error",
          !response.ok && retryableStatus(response.status),
          response.ok ? undefined : response.status,
        );
      }
      return resultFromBusinessEnvelope(
        call.summary,
        response.status,
        contentType,
        response.headers,
        call.registration.operationKind,
        businessEnvelope(parsed.result, call.registration),
      );
    }

    if (!response.ok) {
      throw new ActionTransportError(
        "nango",
        "action_http_error",
        retryableStatus(response.status),
        response.status,
      );
    }
    return resultFromBusinessEnvelope(
      call.summary,
      response.status,
      contentType,
      response.headers,
      call.registration.operationKind,
      businessEnvelope(parsed, call.registration),
    );
  } finally {
    clearTimeout(timer);
  }
}

function capabilityUnavailable() {
  return createFailureResult(INVALID_ACTION_SUMMARY, {
    layer: "validation",
    code: "capability_unavailable",
    message: "Nango Actions are not configured",
    retryable: false,
    outcome: "not_started",
  });
}

function invalidActionRequest() {
  return createFailureResult(INVALID_ACTION_SUMMARY, {
    layer: "validation",
    code: "invalid_action_request",
    message: "Action request validation failed",
    retryable: false,
    outcome: "not_started",
  });
}

export function createActionTool(
  dependencies: ActionToolDependencies,
) {
  const fetch = dependencies.fetch ?? ((input, init) =>
    globalThis.fetch(input, init));
  return {
    name: TOOL_NAME,
    label: "Nango Action",
    description:
      "Run one registered and validated synchronous Nango Action.",
    parameters: ACTION_PARAMETERS,
    async execute(
      toolCallId: string,
      params: unknown,
    ): Promise<ToolExecutionResult<ToolResult>> {
      let authorization: ReturnType<
        ApprovalController["authorizeExecution"]
      >;
      try {
        authorization = dependencies.approvals.authorizeExecution(
          TOOL_NAME,
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
      if (!dependencies.config) {
        return toolExecutionResult(runtimeConfigFailure());
      }
      if (!dependencies.config.actions) {
        return toolExecutionResult(capabilityUnavailable());
      }

      let call: ParsedActionCall;
      try {
        call = parseActionCall(
          stripAuthorizedProof(params),
          dependencies.config,
          authorization.operationKind,
        );
      } catch {
        return toolExecutionResult(invalidActionRequest());
      }

      try {
        return toolExecutionResult(
          await executeTransport(dependencies.config, call, fetch),
        );
      } catch (error) {
        const transportError =
          error instanceof ActionTransportError
            ? error
            : new ActionTransportError(
                "unknown_upstream",
                "invalid_action_response",
              );
        return toolExecutionResult(
          postDispatchFailure(
            call.summary,
            call.registration.operationKind,
            transportError,
          ),
        );
      }
    },
  };
}
