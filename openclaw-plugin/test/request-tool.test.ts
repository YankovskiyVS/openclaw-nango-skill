import { describe, expect, test, vi } from "vitest";

import {
  APPROVAL_PROOF_PARAM,
  createApprovalController,
  type ApprovalController,
} from "../src/approval.js";
import { PROVIDER_KEYS } from "../src/catalog.js";
import { parseRuntimeConfig } from "../src/config.js";
import type {
  ProxyClient,
  ProxyRequest,
} from "../src/proxy-client.js";
import { createSuccessResult } from "../src/result.js";
import {
  REQUEST_PARAMETERS,
  createRequestTool,
} from "../src/tools/request.js";
import { HTTP_METHODS } from "../src/validation.js";

function runtimeConfig() {
  return parseRuntimeConfig({
    cloudru: {
      proxyBaseUrl: "https://proxy.example.test",
      projectId: "project",
      evoClawId: "evoclaw",
      apiKey: "cloudru-secret-sentinel",
    },
    transport: {
      defaultTimeoutMs: 1_000,
      maxRequestBytes: 1_024,
      maxTimeoutMs: 5_000,
    },
  });
}

function requestParams(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    providerConfigKey: "amocrm-crm",
    method: "GET",
    path: "api/v4/leads",
    ...overrides,
  };
}

function executableParams(
  approvals: ApprovalController,
  toolCallId: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const decision = approvals.beforeToolCall({
    toolName: "nango_proxy_request",
    toolCallId,
    params,
  });
  if (decision?.requireApproval) {
    decision.requireApproval.onResolution("allow-once");
    return decision.params!;
  }
  expect(decision).toBeUndefined();
  return params;
}

function fakeClient(captured: ProxyRequest[]): ProxyClient {
  return {
    async request(request) {
      captured.push(request);
      return createSuccessResult(
        {
          providerConfigKey: request.providerConfigKey,
          method: request.method,
          path: request.path,
        },
        {
          status: 200,
          contentType: "application/json",
          headers: {},
          body: { accepted: true },
        },
      );
    },
  };
}

describe("nango_proxy_request public contract", () => {
  test("publishes the exact strict schema without hidden trust fields", () => {
    expect(REQUEST_PARAMETERS).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["providerConfigKey", "method", "path"],
    });
    expect(Object.keys(REQUEST_PARAMETERS.properties)).toEqual([
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
    ]);
    expect(
      REQUEST_PARAMETERS.properties.providerConfigKey.anyOf.map(
        (item: { const: string }) => item.const,
      ),
    ).toEqual(PROVIDER_KEYS);
    expect(
      REQUEST_PARAMETERS.properties.method.anyOf.map(
        (item: { const: string }) => item.const,
      ),
    ).toEqual(HTTP_METHODS);
    expect(JSON.stringify(REQUEST_PARAMETERS)).not.toContain(
      APPROVAL_PROOF_PARAM,
    );
    expect(JSON.stringify(REQUEST_PARAMETERS)).not.toContain(
      "operationKind",
    );
  });

  test.each(HTTP_METHODS)("preserves the %s method", async (method) => {
    const approvals = createApprovalController();
    const captured: ProxyRequest[] = [];
    const tool = createRequestTool({
      config: runtimeConfig(),
      client: fakeClient(captured),
      approvals,
    });
    const params = requestParams({ method });
    const toolCallId = `method-${method}`;

    const result = await tool.execute(
      toolCallId,
      executableParams(approvals, toolCallId, params),
    );

    expect(result.details).toMatchObject({ ok: true });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe(method);
  });

  test.each(PROVIDER_KEYS)(
    "preserves the registered provider key %s",
    async (providerConfigKey) => {
      const approvals = createApprovalController();
      const captured: ProxyRequest[] = [];
      const tool = createRequestTool({
        config: runtimeConfig(),
        client: fakeClient(captured),
        approvals,
      });

      await tool.execute(
        `provider-${providerConfigKey}`,
        requestParams({ providerConfigKey }),
      );

      expect(captured[0]?.providerConfigKey).toBe(providerConfigKey);
    },
  );

  test.each([
    [
      "json",
      { jsonBody: { nested: ["value", 2] } },
      "application/json",
    ],
    [
      "text",
      { textBody: "hello", contentType: "text/plain" },
      "text/plain",
    ],
    [
      "base64",
      {
        base64Body: Buffer.from("binary").toString("base64"),
        contentType: "application/octet-stream",
      },
      "application/octet-stream",
    ],
  ])(
    "validates and forwards the %s body mode",
    async (kind, bodyParams, contentType) => {
      const approvals = createApprovalController();
      const captured: ProxyRequest[] = [];
      const tool = createRequestTool({
        config: runtimeConfig(),
        client: fakeClient(captured),
        approvals,
      });
      const params = requestParams({
        method: "POST",
        ...bodyParams,
      });
      const toolCallId = `body-${kind}`;

      await tool.execute(
        toolCallId,
        executableParams(approvals, toolCallId, params),
      );

      expect(captured[0]?.body).toMatchObject({ kind, contentType });
    },
  );

  test("preserves ordered repeated query and safe normalized headers", async () => {
    const approvals = createApprovalController();
    const captured: ProxyRequest[] = [];
    const tool = createRequestTool({
      config: runtimeConfig(),
      client: fakeClient(captured),
      approvals,
    });

    await tool.execute(
      "ordered",
      requestParams({
        query: [
          { name: "tag", value: "first" },
          { name: "tag", value: "second" },
        ],
        headers: { "X-Provider-Feature": "enabled" },
        timeoutMs: 4_000,
      }),
    );

    expect(captured[0]).toMatchObject({
      query: [
        { name: "tag", value: "first" },
        { name: "tag", value: "second" },
      ],
      headers: { "x-provider-feature": "enabled" },
      timeoutMs: 4_000,
    });
  });

  test("uses only the approval controller's trusted semantic kind", async () => {
    const approvals = createApprovalController();
    const captured: ProxyRequest[] = [];
    const tool = createRequestTool({
      config: runtimeConfig(),
      client: fakeClient(captured),
      approvals,
    });
    const bitrixWrite = requestParams({
      providerConfigKey: "bitrix24-crm",
      method: "GET",
      path: "crm.deal.delete",
      query: [{ name: "id", value: "7" }],
    });
    const bitrixId = "bitrix-semantic-write";

    await tool.execute(
      bitrixId,
      executableParams(approvals, bitrixId, bitrixWrite),
    );
    await tool.execute(
      "direct-semantic-read",
      requestParams({
        providerConfigKey: "yandex-direct",
        method: "POST",
        path: "json/v5/campaigns",
        jsonBody: { method: "get", params: { SelectionCriteria: {} } },
      }),
    );

    expect(captured.map(({ operationKind }) => operationKind)).toEqual([
      "mutation",
      "read",
    ]);
  });

  test("authorizes before validation/network and consumes mutation proof once", async () => {
    const approvals = createApprovalController();
    const request = vi.fn(fakeClient([]).request);
    const tool = createRequestTool({
      config: runtimeConfig(),
      client: { request },
      approvals,
    });
    const params = requestParams({
      method: "PATCH",
      jsonBody: { name: "lead" },
    });

    await expect(tool.execute("missing-proof", params)).resolves.toMatchObject({
      details: {
        ok: false,
        error: { code: "approval_required" },
        outcome: "not_started",
      },
    });
    expect(request).not.toHaveBeenCalled();

    const approved = executableParams(approvals, "approved", params);
    await expect(tool.execute("approved", approved)).resolves.toMatchObject({
      details: { ok: true },
    });
    await expect(tool.execute("approved", approved)).resolves.toMatchObject({
      details: {
        ok: false,
        error: { code: "approval_required" },
      },
    });
    expect(request).toHaveBeenCalledOnce();
  });

  test.each([
    requestParams({ extra: true }),
    requestParams({
      jsonBody: {},
      textBody: "ambiguous",
      contentType: "text/plain",
    }),
    requestParams({ timeoutMs: 5_001 }),
    requestParams({ headers: { authorization: "secret" } }),
  ])("fails malformed input without proxy I/O", async (params) => {
    const approvals = createApprovalController();
    const request = vi.fn(fakeClient([]).request);
    const tool = createRequestTool({
      config: runtimeConfig(),
      client: { request },
      approvals,
    });

    const result = await tool.execute("invalid", params);

    expect(result.details).toMatchObject({
      ok: false,
      outcome: "not_started",
    });
    expect(request).not.toHaveBeenCalled();
  });

  test("fails closed on missing runtime config after authorization", async () => {
    const approvals = createApprovalController();
    const request = vi.fn(fakeClient([]).request);
    const tool = createRequestTool({
      approvals,
      client: { request },
    });

    const result = await tool.execute("missing-config", requestParams());

    expect(result.details).toMatchObject({
      ok: false,
      error: { code: "invalid_runtime_config" },
      outcome: "not_started",
    });
    expect(request).not.toHaveBeenCalled();
  });

  test("never returns config secrets or the hidden proof", async () => {
    const approvals = createApprovalController();
    const tool = createRequestTool({
      config: runtimeConfig(),
      client: fakeClient([]),
      approvals,
    });
    const params = requestParams({
      method: "PATCH",
      jsonBody: { name: "lead" },
    });
    const approved = executableParams(approvals, "secret-free", params);

    const result = await tool.execute("secret-free", approved);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("cloudru-secret-sentinel");
    expect(serialized).not.toContain(APPROVAL_PROOF_PARAM);
    expect(result.content[0]?.text).toBe(JSON.stringify(result.details));
  });
});
