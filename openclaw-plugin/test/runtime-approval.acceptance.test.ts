import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { runBeforeToolCallHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  PluginApprovalResolutions,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-runtime";

import { APPROVAL_PROOF_PARAM } from "../src/approval.js";
import plugin from "../src/index.js";

const CLOUDRU_KEY = "cloudru-api-key-secret-sentinel";
const ROUTE_PREFIX =
  "/api/v1/project/evo-claws/evoclaw/proxy";

type RegisteredTool = {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
  }>;
};

type BeforeToolCallHandler = (
  event: {
    toolName: string;
    toolCallId?: string;
    params: Record<string, unknown>;
  },
  context: {
    toolName: string;
    toolCallId?: string;
  },
) => unknown;

type CapturedRequest = Readonly<{
  method: string;
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Buffer;
}>;

type LocalProxy = Readonly<{
  baseUrl: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}>;

async function readRequestBody(
  request: AsyncIterable<Uint8Array>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function startLocalProxy(
  respond: (
    request: CapturedRequest,
    response: ServerResponse,
  ) => void | Promise<void>,
): Promise<LocalProxy> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const captured = Object.freeze({
          method: request.method ?? "",
          url: request.url ?? "",
          headers: Object.freeze({ ...request.headers }),
          body: await readRequestBody(request),
        });
        requests.push(captured);
        await respond(captured, response);
      } catch {
        if (!response.headersSent) {
          response.writeHead(500, {
            "content-type": "application/json",
          });
        }
        response.end(JSON.stringify({ error: "fixture_failure" }));
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function runtimeConfig(proxyBaseUrl: string) {
  return {
    cloudru: {
      proxyBaseUrl,
      projectId: "project",
      evoClawId: "evoclaw",
      apiKey: CLOUDRU_KEY,
    },
    transport: {
      defaultTimeoutMs: 1_000,
      maxTimeoutMs: 1_000,
      operationDeadlineMs: 5_000,
      readAttempts: 1,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      maxRequestBytes: 4_096,
      maxResponseBytes: 16_384,
    },
    pagination: {
      maxPages: 5,
      maxItems: 20,
      linkOrigins: {
        "amocrm-crm": ["https://tenant.amocrm.ru"],
      },
    },
  };
}

function registerRuntime(proxyBaseUrl: string) {
  const tools = new Map<string, RegisteredTool>();
  let beforeToolCall: BeforeToolCallHandler | undefined;

  plugin.register({
    pluginConfig: runtimeConfig(proxyBaseUrl),
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(hookName: string, handler: BeforeToolCallHandler) {
      if (hookName === "before_tool_call") {
        beforeToolCall = handler;
      }
    },
  } as never);
  if (beforeToolCall === undefined) {
    throw new Error("before_tool_call hook was not registered");
  }

  initializeGlobalHookRunner({
    hooks: [],
    plugins: [{ id: "nango-tools", status: "loaded" }],
    typedHooks: [
      {
        pluginId: "nango-tools",
        hookName: "before_tool_call",
        source: "runtime-approval.acceptance.test.ts",
        handler: beforeToolCall as never,
      },
    ],
  });

  return {
    tool(name: string): RegisteredTool {
      const tool = tools.get(name);
      if (tool === undefined) {
        throw new Error(`tool ${name} was not registered`);
      }
      return tool;
    },
  };
}

async function runHook(
  toolName: string,
  toolCallId: string,
  params: Record<string, unknown>,
) {
  return runBeforeToolCallHook({
    toolName,
    toolCallId,
    params,
    approvalMode: "defer",
  });
}

function mergeDeferredApprovalParams(
  deferred: NonNullable<
    Awaited<ReturnType<typeof runHook>>["deferredApproval"]
  >,
): Record<string, unknown> {
  return {
    ...(deferred.baseParams as Record<string, unknown>),
    ...(deferred.overrideParams as Record<string, unknown>),
  };
}

type RegisteredToolResult = Awaited<
  ReturnType<RegisteredTool["execute"]>
>;

const APPROVAL_REQUIRED_DETAILS = {
  ok: false,
  request: {
    providerConfigKey: "yandex-id",
    method: "GET",
    path: "<invalid>",
  },
  error: {
    layer: "approval",
    code: "approval_required",
    message: "One-time approval is required",
    retryable: false,
  },
  outcome: "not_started",
} as const;

function expectModelContentMatchesDetails(result: {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
}) {
  expect(result.content).toEqual([
    {
      type: "text",
      text: JSON.stringify(result.details),
    },
  ]);
}

function requireApprovalProof(
  params: Record<string, unknown>,
): string {
  const proof = params[APPROVAL_PROOF_PARAM];
  expect(proof).toEqual(expect.stringMatching(/^v1\./));
  if (typeof proof !== "string") {
    throw new Error("approval proof was not a string");
  }
  return proof;
}

function expectExactApprovalRequired(
  result: RegisteredToolResult,
  forbiddenStrings: readonly string[],
) {
  expect(result.details).toEqual(APPROVAL_REQUIRED_DETAILS);
  expectModelContentMatchesDetails(result);
  const serialized = JSON.stringify(result);
  for (const forbidden of forbiddenStrings) {
    expect(forbidden.length).toBeGreaterThan(0);
    expect(serialized).not.toContain(forbidden);
  }
}

async function expectMismatchConsumesFreshApproval(options: {
  toolCallId: string;
  params: Record<string, unknown>;
  forbiddenParamStrings: readonly string[];
  changeApprovedParams(
    approved: Record<string, unknown>,
  ): Record<string, unknown>;
}) {
  const proxy = await startLocalProxy((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ shouldNotRun: true }));
  });
  try {
    const runtime = registerRuntime(proxy.baseUrl);
    const hook = await runHook(
      "nango_proxy_request",
      options.toolCallId,
      options.params,
    );
    if (hook.blocked || hook.deferredApproval === undefined) {
      throw new Error("expected deferred approval");
    }
    const deferred = hook.deferredApproval;
    await deferred.approval.onResolution?.(
      PluginApprovalResolutions.ALLOW_ONCE,
    );
    const approved = mergeDeferredApprovalParams(deferred);
    const proof = requireApprovalProof(approved);
    const mismatched = options.changeApprovedParams(approved);
    const forbidden = [
      CLOUDRU_KEY,
      proof,
      ...options.forbiddenParamStrings,
      JSON.stringify(options.params),
      JSON.stringify(mismatched),
    ];

    const mismatchResult = await runtime
      .tool("nango_proxy_request")
      .execute(options.toolCallId, mismatched);
    expectExactApprovalRequired(mismatchResult, forbidden);
    expect(proxy.requests).toHaveLength(0);

    const originalResult = await runtime
      .tool("nango_proxy_request")
      .execute(options.toolCallId, approved);
    expectExactApprovalRequired(originalResult, forbidden);
    expect(proxy.requests).toHaveLength(0);
  } finally {
    await proxy.close();
  }
}

afterEach(() => {
  resetGlobalHookRunner();
});

describe.sequential("registered OpenClaw runtime acceptance", () => {
  test("executes a read without approval through the real HTTP proxy boundary", async () => {
    const proxy = await startLocalProxy((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "x-request-id": "read-request-id",
        "set-cookie": `opaque=${CLOUDRU_KEY}`,
      });
      response.end(
        JSON.stringify({ records: [{ id: 1 }], accepted: true }),
      );
    });
    try {
      const runtime = registerRuntime(proxy.baseUrl);
      const params = {
        providerConfigKey: "amocrm-crm",
        method: "GET",
        path: "api/v4/leads",
        query: [
          { name: "filter[status]", value: "active" },
          { name: "tag", value: "first" },
          { name: "tag", value: "with/slash" },
        ],
        headers: {
          "X-Provider-Feature": "enabled",
        },
      };

      const hook = await runHook(
        "nango_proxy_request",
        "read-call",
        params,
      );

      expect(hook).toEqual({ blocked: false, params });
      expect(hook.deferredApproval).toBeUndefined();
      const result = await runtime
        .tool("nango_proxy_request")
        .execute("read-call", hook.params as Record<string, unknown>);

      expect(proxy.requests).toHaveLength(1);
      const request = proxy.requests[0]!;
      expect(request.method).toBe("GET");
      expect(request.url).toBe(
        `${ROUTE_PREFIX}/amocrm-crm/api/v4/leads` +
          "?filter%5Bstatus%5D=active&tag=first&tag=with%2Fslash",
      );
      expect(request.headers.authorization).toBe(
        `Api-Key ${CLOUDRU_KEY}`,
      );
      expect(request.headers["x-provider-feature"]).toBe("enabled");
      expect(request.headers["content-type"]).toBeUndefined();
      expect(request.body).toEqual(Buffer.alloc(0));
      expect(result.details).toEqual({
        ok: true,
        request: {
          providerConfigKey: "amocrm-crm",
          method: "GET",
          path: "api/v4/leads",
        },
        response: {
          status: 200,
          contentType: "application/json; charset=utf-8",
          headers: { "x-request-id": "read-request-id" },
          body: { records: [{ id: 1 }], accepted: true },
        },
        outcome: "confirmed",
      });
      expectModelContentMatchesDetails(result);
      expect(JSON.stringify(result)).not.toContain(CLOUDRU_KEY);
      expect(JSON.stringify(result)).not.toContain(APPROVAL_PROOF_PARAM);
    } finally {
      await proxy.close();
    }
  });

  test("paginates two real proxy responses without requesting approval", async () => {
    const proxy = await startLocalProxy((request, response) => {
      const page = new URL(request.url, "http://fixture.invalid")
        .searchParams.get("page");
      response.writeHead(200, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          page === "2"
            ? {
                _embedded: { leads: [{ id: 2 }] },
                _links: {
                  self: {
                    href:
                      "https://tenant.amocrm.ru/api/v4/leads?limit=1&page=2",
                  },
                },
              }
            : {
                _embedded: { leads: [{ id: 1 }] },
                _links: {
                  self: {
                    href:
                      "https://tenant.amocrm.ru/api/v4/leads?limit=1",
                  },
                  next: {
                    href:
                      "https://tenant.amocrm.ru/api/v4/leads?limit=1&page=2",
                  },
                },
              },
        ),
      );
    });
    try {
      const runtime = registerRuntime(proxy.baseUrl);
      const params = {
        providerConfigKey: "amocrm-crm",
        method: "GET",
        path: "api/v4/leads",
        query: [{ name: "limit", value: "1" }],
        mode: "link",
        maxPages: 3,
        maxItems: 10,
      };

      const hook = await runHook(
        "nango_proxy_paginate",
        "paginate-call",
        params,
      );

      expect(hook.blocked).toBe(false);
      expect(hook.deferredApproval).toBeUndefined();
      const result = await runtime
        .tool("nango_proxy_paginate")
        .execute(
          "paginate-call",
          hook.params as Record<string, unknown>,
        );

      expect(proxy.requests.map((request) => request.url)).toEqual([
        `${ROUTE_PREFIX}/amocrm-crm/api/v4/leads?limit=1`,
        `${ROUTE_PREFIX}/amocrm-crm/api/v4/leads?limit=1&page=2`,
      ]);
      expect(
        proxy.requests.map(
          (request) => request.headers.authorization,
        ),
      ).toEqual([
        `Api-Key ${CLOUDRU_KEY}`,
        `Api-Key ${CLOUDRU_KEY}`,
      ]);
      expect(result.details).toMatchObject({
        ok: true,
        items: [{ id: 1 }, { id: 2 }],
        pagination: {
          mode: "link",
          pageCount: 2,
          itemCount: 2,
          termination: "provider_end",
        },
        outcome: "confirmed",
      });
      expectModelContentMatchesDetails(result);
      expect(JSON.stringify(result)).not.toContain(CLOUDRU_KEY);
      expect(JSON.stringify(result)).not.toContain(APPROVAL_PROOF_PARAM);
    } finally {
      await proxy.close();
    }
  });

  test("executes one exactly approved mutation and reports an ambiguous 503", async () => {
    const proxy = await startLocalProxy((_request, response) => {
      response.writeHead(503, {
        connection: "close",
        "content-length": "0",
        "retry-after": "1",
      });
      response.end();
    });
    try {
      const runtime = registerRuntime(proxy.baseUrl);
      const jsonBody = {
        name: "Approved lead",
        custom_fields_values: [{ field_id: 7, values: [{ value: 42 }] }],
      };
      const params = {
        providerConfigKey: "amocrm-crm",
        method: "PATCH",
        path: "api/v4/leads/42",
        headers: { "X-Provider-Trace": "trace-42" },
        jsonBody,
      };

      const hook = await runHook(
        "nango_proxy_request",
        "mutation-call",
        params,
      );

      expect(hook.blocked).toBe(false);
      expect(proxy.requests).toHaveLength(0);
      expect(hook.deferredApproval).toBeDefined();
      const deferred = hook.deferredApproval!;
      expect(deferred.baseParams).toEqual(params);
      expect(deferred.overrideParams).toMatchObject(params);
      await deferred.approval.onResolution?.(
        PluginApprovalResolutions.ALLOW_ONCE,
      );
      const approved = mergeDeferredApprovalParams(deferred);
      const proof = requireApprovalProof(approved);

      const result = await runtime
        .tool("nango_proxy_request")
        .execute("mutation-call", approved);

      expect(proxy.requests).toHaveLength(1);
      const request = proxy.requests[0]!;
      expect(request.method).toBe("PATCH");
      expect(request.url).toBe(
        `${ROUTE_PREFIX}/amocrm-crm/api/v4/leads/42`,
      );
      expect(request.headers.authorization).toBe(
        `Api-Key ${CLOUDRU_KEY}`,
      );
      expect(request.headers["x-provider-trace"]).toBe("trace-42");
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.body).toEqual(
        Buffer.from(JSON.stringify(jsonBody), "utf8"),
      );
      expect(result.details).toEqual({
        ok: false,
        request: {
          providerConfigKey: "amocrm-crm",
          method: "PATCH",
          path: "api/v4/leads/42",
        },
        error: {
          layer: "unknown_upstream",
          code: "upstream_http_error",
          message: "Upstream request failed",
          status: 503,
          retryable: false,
        },
        outcome: "unknown",
      });
      expectModelContentMatchesDetails(result);
      expect(JSON.stringify(result)).not.toContain(CLOUDRU_KEY);
      expect(JSON.stringify(result)).not.toContain(
        approved[APPROVAL_PROOF_PARAM] as string,
      );

      const replay = await runtime
        .tool("nango_proxy_request")
        .execute("mutation-call", approved);
      expectExactApprovalRequired(replay, [
        CLOUDRU_KEY,
        proof,
        "api/v4/leads/42",
        "Approved lead",
        "trace-42",
        JSON.stringify(params),
        JSON.stringify(approved),
      ]);
      expect(proxy.requests).toHaveLength(1);
    } finally {
      await proxy.close();
    }
  });

  test("consumes a fresh approval when only the path changes", async () => {
    await expectMismatchConsumesFreshApproval({
      toolCallId: "path-mismatch-call",
      params: {
        providerConfigKey: "amocrm-crm",
        method: "PATCH",
        path: "api/v4/leads/path-original-42",
        jsonBody: { marker: "path-body-unchanged-sentinel" },
      },
      forbiddenParamStrings: [
        "amocrm-crm",
        "api/v4/leads/path-original-42",
        "api/v4/leads/path-changed-43",
        "path-body-unchanged-sentinel",
      ],
      changeApprovedParams(approved) {
        return {
          ...approved,
          path: "api/v4/leads/path-changed-43",
        };
      },
    });
  });

  test("consumes a fresh approval when only the body changes", async () => {
    await expectMismatchConsumesFreshApproval({
      toolCallId: "body-mismatch-call",
      params: {
        providerConfigKey: "amocrm-crm",
        method: "PATCH",
        path: "api/v4/leads/body-original-52",
        jsonBody: { marker: "body-original-sentinel" },
      },
      forbiddenParamStrings: [
        "amocrm-crm",
        "api/v4/leads/body-original-52",
        "body-original-sentinel",
        "body-changed-sentinel",
      ],
      changeApprovedParams(approved) {
        return {
          ...approved,
          jsonBody: { marker: "body-changed-sentinel" },
        };
      },
    });
  });

  test.each([
    ["no resolution", undefined, "pending"],
    ["deny", PluginApprovalResolutions.DENY, "deny"],
    ["timeout", PluginApprovalResolutions.TIMEOUT, "timeout"],
  ] as const)(
    "does not execute a deferred mutation after %s",
    async (_label, resolution, slug) => {
      const proxy = await startLocalProxy((_request, response) => {
        response.writeHead(200, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ shouldNotRun: true }));
      });
      try {
        const runtime = registerRuntime(proxy.baseUrl);
        const params = {
          providerConfigKey: "amocrm-crm",
          method: "PATCH",
          path: `api/v4/leads/${slug}-raw-path-sentinel`,
          headers: {
            "X-Provider-Trace": `${slug}-raw-header-sentinel`,
          },
          jsonBody: {
            marker: `${slug}-raw-body-sentinel`,
          },
        };
        const hook = await runHook(
          "nango_proxy_request",
          `blocked-${resolution ?? "pending"}`,
          params,
        );
        if (hook.blocked || hook.deferredApproval === undefined) {
          throw new Error("expected deferred approval");
        }
        const deferred = hook.deferredApproval;
        if (resolution !== undefined) {
          await deferred.approval.onResolution?.(resolution);
        }
        const withUnusableProof =
          mergeDeferredApprovalParams(deferred);
        const proof = requireApprovalProof(withUnusableProof);

        const result = await runtime
          .tool("nango_proxy_request")
          .execute(
            `blocked-${resolution ?? "pending"}`,
            withUnusableProof,
          );

        expectExactApprovalRequired(result, [
          CLOUDRU_KEY,
          proof,
          "amocrm-crm",
          `api/v4/leads/${slug}-raw-path-sentinel`,
          `${slug}-raw-header-sentinel`,
          `${slug}-raw-body-sentinel`,
          JSON.stringify(params),
          JSON.stringify(withUnusableProof),
        ]);
        expect(proxy.requests).toHaveLength(0);
      } finally {
        await proxy.close();
      }
    },
  );
});
