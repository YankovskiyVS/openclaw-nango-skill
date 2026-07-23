import { Type } from "typebox";

import {
  APPROVAL_PROOF_PARAM,
  type ApprovalController,
  type OperationKind,
} from "../approval.js";
import {
  PROVIDER_KEYS,
  validateProviderKey,
} from "../catalog.js";
import type { RuntimeConfig } from "../config.js";
import type {
  ProxyClient,
  ProxyRequest,
} from "../proxy-client.js";
import {
  createFailureResult,
  type FailureResult,
  type RequestSummary,
  type ToolResult,
} from "../result.js";
import {
  HTTP_METHODS,
  encodeOrderedQuery,
  validateHttpMethod,
  validateProviderHeaders,
  validateRelativeProviderPath,
  validateRequestBody,
  type QueryPair,
} from "../validation.js";

const PUBLIC_REQUEST_KEYS = Object.freeze([
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
const PUBLIC_REQUEST_KEY_SET = new Set<string>(PUBLIC_REQUEST_KEYS);
const MAX_PUBLIC_TIMEOUT_MS = 300_000;
const MAX_ROUTING_LENGTH = 4_096;

const QUERY_PAIR_SCHEMA = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: MAX_ROUTING_LENGTH }),
    value: Type.String({ maxLength: MAX_ROUTING_LENGTH }),
  },
  { additionalProperties: false },
);

const REQUEST_PROPERTIES = {
  providerConfigKey: Type.Union(
    PROVIDER_KEYS.map((key) => Type.Literal(key)),
  ),
  method: Type.Union(
    HTTP_METHODS.map((method) => Type.Literal(method)),
  ),
  path: Type.String({ minLength: 1, maxLength: MAX_ROUTING_LENGTH }),
  query: Type.Optional(
    Type.Array(QUERY_PAIR_SCHEMA, { maxItems: 1_024 }),
  ),
  headers: Type.Optional(
    Type.Record(
      Type.String({ minLength: 1, maxLength: 256 }),
      Type.String({ maxLength: 8_192 }),
      { additionalProperties: false, maxProperties: 1_024 },
    ),
  ),
  jsonBody: Type.Optional(Type.Unknown()),
  textBody: Type.Optional(Type.String()),
  base64Body: Type.Optional(Type.String()),
  contentType: Type.Optional(
    Type.String({ minLength: 1, maxLength: 256 }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PUBLIC_TIMEOUT_MS }),
  ),
} as const;

export const REQUEST_PARAMETERS = Type.Object(
  REQUEST_PROPERTIES,
  { additionalProperties: false },
);

const INVALID_REQUEST_SUMMARY: RequestSummary = Object.freeze({
  providerConfigKey: "yandex-id",
  method: "GET",
  path: "<invalid>",
});

export type ToolExecutionResult<Details = unknown> = {
  content: Array<{
    type: "text";
    text: string;
  }>;
  details: Details;
};

export type RequestToolDependencies = Readonly<{
  config?: RuntimeConfig;
  client?: ProxyClient;
  approvals: Pick<ApprovalController, "authorizeExecution">;
}>;

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

function invalidRequestFailure(): FailureResult {
  return createFailureResult(INVALID_REQUEST_SUMMARY, {
    layer: "validation",
    code: "invalid_request",
    message: "Request validation failed",
    retryable: false,
    outcome: "not_started",
  });
}

export function runtimeConfigFailure(): FailureResult {
  return createFailureResult(INVALID_REQUEST_SUMMARY, {
    layer: "validation",
    code: "invalid_runtime_config",
    message: "Runtime configuration is invalid",
    retryable: false,
    outcome: "not_started",
  });
}

export function authorizationFailure(
  code: "invalid_tool_call" | "approval_required",
): FailureResult {
  return createFailureResult(INVALID_REQUEST_SUMMARY, {
    layer: "approval",
    code,
    message:
      code === "approval_required"
        ? "One-time approval is required"
        : "Tool call authorization failed",
    retryable: false,
    outcome: "not_started",
  });
}

export function toolExecutionResult<Details>(
  details: Details,
): ToolExecutionResult<Details> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(details),
      },
    ],
    details,
  };
}

/**
 * This may only be called after authorizeExecution succeeds. Keeping the
 * hidden proof until then prevents validation from becoming an approval
 * bypass or proof oracle.
 */
export function stripAuthorizedProof(
  value: unknown,
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error("invalid_params");
  }
  const publicParams: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new Error("invalid_params");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new Error("invalid_params");
    }
    if (key !== APPROVAL_PROOF_PARAM) {
      Object.defineProperty(publicParams, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return publicParams;
}

function assertOnlyPublicRequestKeys(
  value: Record<string, unknown>,
): void {
  if (
    Object.keys(value).some((key) => !PUBLIC_REQUEST_KEY_SET.has(key))
  ) {
    throw new Error("unknown_param");
  }
}

function snapshotQuery(value: unknown): readonly QueryPair[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  encodeOrderedQuery(value);
  if (!Array.isArray(value)) {
    throw new Error("invalid_query");
  }
  return Object.freeze(
    value.map((item) => {
      if (!isPlainRecord(item)) {
        throw new Error("invalid_query");
      }
      return Object.freeze({
        name: item.name as string,
        value: item.value as string,
      });
    }),
  );
}

function requestBodyInput(
  value: Record<string, unknown>,
): Record<string, unknown> {
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
  return bodyInput;
}

export function parseProxyRequestParams(
  value: unknown,
  config: RuntimeConfig,
  operationKind: OperationKind,
): ProxyRequest {
  if (!isPlainRecord(value)) {
    throw new Error("invalid_params");
  }
  assertOnlyPublicRequestKeys(value);

  const providerConfigKey = validateProviderKey(
    value.providerConfigKey,
  );
  const method = validateHttpMethod(value.method);
  const path = validateRelativeProviderPath(value.path);
  const query = snapshotQuery(value.query);
  const headers =
    value.headers === undefined
      ? undefined
      : validateProviderHeaders(value.headers);
  const timeoutMs = value.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) ||
      (timeoutMs as number) < 1 ||
      (timeoutMs as number) > config.transport.maxTimeoutMs)
  ) {
    throw new Error("invalid_timeout");
  }
  const body = validateRequestBody(
    requestBodyInput(value),
    config.transport.maxRequestBytes,
  );
  if ((method === "GET" || method === "HEAD") && body !== undefined) {
    throw new Error("invalid_body");
  }

  return Object.freeze({
    providerConfigKey,
    operationKind,
    method,
    path,
    ...(query === undefined ? {} : { query }),
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
    ...(timeoutMs === undefined
      ? {}
      : { timeoutMs: timeoutMs as number }),
  });
}

export function requestParamsFromEnvelope(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const request: Record<string, unknown> = {};
  for (const key of PUBLIC_REQUEST_KEYS) {
    if (Object.hasOwn(value, key)) {
      request[key] = value[key];
    }
  }
  return request;
}

export function createRequestTool(
  dependencies: RequestToolDependencies,
) {
  return {
    name: "nango_proxy_request",
    label: "Nango provider request",
    description:
      "Send one validated provider-relative request through the Cloud.ru Nango proxy.",
    parameters: REQUEST_PARAMETERS,
    async execute(
      toolCallId: string,
      params: unknown,
    ): Promise<ToolExecutionResult<ToolResult>> {
      let authorization: ReturnType<
        ApprovalController["authorizeExecution"]
      >;
      try {
        authorization = dependencies.approvals.authorizeExecution(
          "nango_proxy_request",
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
      if (!dependencies.config || !dependencies.client) {
        return toolExecutionResult(runtimeConfigFailure());
      }

      let request: ProxyRequest;
      try {
        const publicParams = stripAuthorizedProof(params);
        request = parseProxyRequestParams(
          publicParams,
          dependencies.config,
          authorization.operationKind,
        );
      } catch {
        return toolExecutionResult(invalidRequestFailure());
      }

      try {
        return toolExecutionResult(
          await dependencies.client.request(request),
        );
      } catch {
        return toolExecutionResult(
          createFailureResult(
            {
              providerConfigKey: request.providerConfigKey,
              method: request.method,
              path: request.path,
            },
            {
              layer: "network",
              code: "network_error",
              message: "Network request failed",
              retryable: authorization.operationKind === "read",
              outcome:
                authorization.operationKind === "read"
                  ? "confirmed_failed"
                  : "unknown",
            },
          ),
        );
      }
    },
  };
}
