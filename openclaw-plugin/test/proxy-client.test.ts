import { createHash } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import { parseRuntimeConfig } from "../src/config.js";
import {
  buildProxyUrl,
  createProxyClient,
  deriveConnectionId,
} from "../src/proxy-client.js";
import { validateRequestBody } from "../src/validation.js";

function runtimeConfig(
  overrides: Record<string, unknown> = {},
) {
  return parseRuntimeConfig({
    cloudru: {
      proxyBaseUrl: "https://proxy.example.test/base/",
      projectId: "project/a !",
      evoClawId: "evo claw(1)",
      apiKey: "cloudru-secret-sentinel",
    },
    ...overrides,
  });
}

function jsonResponse(
  value: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

function streamedResponse(
  chunks: readonly Uint8Array[],
  init: ResponseInit = {},
) {
  const cancel = vi.fn();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(stream, init),
    cancel,
    pulls: () => index,
  };
}

function responseLimitConfig(maxResponseBytes: number) {
  return runtimeConfig({
    transport: {
      defaultTimeoutMs: 1_000,
      maxTimeoutMs: 1_000,
      operationDeadlineMs: 2_000,
      readAttempts: 1,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      maxRequestBytes: 1_024,
      maxResponseBytes,
    },
  });
}

function transportConfig(
  transport: Partial<{
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    operationDeadlineMs: number;
    readAttempts: number;
    initialBackoffMs: number;
    maxBackoffMs: number;
    maxRequestBytes: number;
    maxResponseBytes: number;
  }> = {},
) {
  return runtimeConfig({
    transport: {
      defaultTimeoutMs: 1_000,
      maxTimeoutMs: 1_000,
      operationDeadlineMs: 5_000,
      readAttempts: 3,
      initialBackoffMs: 0,
      maxBackoffMs: 0,
      maxRequestBytes: 1_024,
      maxResponseBytes: 1_024,
      ...transport,
    },
  });
}

function fakeClock(wallStart = Date.UTC(2026, 6, 23, 12, 0, 0)) {
  let elapsed = 0;
  const scheduledDelays: number[] = [];
  return {
    monotonicNow: () => elapsed,
    wallNow: () => wallStart + elapsed,
    setTimer(callback: () => void, delayMs: number) {
      const due = elapsed + delayMs;
      scheduledDelays.push(delayMs);
      return setTimeout(() => {
        elapsed = Math.max(elapsed, due);
        callback();
      }, delayMs);
    },
    clearTimer(handle: unknown) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    scheduledDelays,
  };
}

describe("Cloud.ru route and credential boundary", () => {
  test("builds the production-compatible RFC 3986 URL and preserves literal yandex", () => {
    const config = runtimeConfig();

    expect(
      buildProxyUrl(config, {
        providerConfigKey: "yandex",
        method: "GET",
        path: "путь/!'()*",
        query: [
          { name: "tag", value: "первый" },
          { name: "tag", value: "with/slash" },
        ],
      }),
    ).toBe(
      "https://proxy.example.test/base/api/v1/project%2Fa%20%21/" +
        "evo-claws/evo%20claw%281%29/proxy/yandex/" +
        "%D0%BF%D1%83%D1%82%D1%8C/%21%27%28%29%2A" +
        "?tag=%D0%BF%D0%B5%D1%80%D0%B2%D1%8B%D0%B9&tag=with%2Fslash",
    );
    expect(deriveConnectionId(config)).toBe(
      "project-project/a !-evoclaw-evo claw(1)",
    );
  });

  test("matches the hardened Python client URL contract", () => {
    const config = parseRuntimeConfig({
      cloudru: {
        proxyBaseUrl: "https://proxy.example/base/",
        projectId: "project/a",
        evoClawId: "evo claw",
        apiKey: "secret",
      },
    });

    expect(
      buildProxyUrl(config, {
        providerConfigKey: "amocrm-crm",
        method: "GET",
        path: "api/v4/leads",
        query: [
          { name: "tag", value: "first" },
          { name: "filter[status]", value: "active" },
          { name: "tag", value: "with/slash" },
        ],
      }),
    ).toBe(
      "https://proxy.example/base/api/v1/project%2Fa/evo-claws/evo%20claw" +
        "/proxy/amocrm-crm/api/v4/leads" +
        "?tag=first&filter%5Bstatus%5D=active&tag=with%2Fslash",
    );
  });

  test("injects the Cloud.ru secret only from runtime config", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(
        "Api-Key cloudru-secret-sentinel",
      );
      expect(headers.get("x-provider-feature")).toBe("enabled");
      expect(headers.get("content-type")).toBe("application/json");
      expect(init?.redirect).toBe("manual");
      return jsonResponse({ ok: true });
    });
    const client = createProxyClient(runtimeConfig(), { fetch: fetchMock });
    const request = {
      providerConfigKey: "amocrm-crm" as const,
      operationKind: "mutation" as const,
      method: "POST" as const,
      path: "api/v4/leads",
      headers: { "X-Provider-Feature": "enabled" },
      body: validateRequestBody({ jsonBody: { name: "lead" } }, 1_024),
      apiKey: "tool-secret-override-sentinel",
      proxyBaseUrl: "https://attacker.example",
    };

    const result = await client.request(request);

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("cloudru-secret-sentinel");
    expect(serialized).not.toContain("tool-secret-override-sentinel");
    expect(serialized).not.toContain("attacker.example");
  });

  test("blocks a credential header before invoking fetch", async () => {
    const fetchMock = vi.fn();
    const client = createProxyClient(runtimeConfig(), { fetch: fetchMock });
    const sentinel = "provider-header-secret-sentinel";

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/leads",
      headers: { Authorization: sentinel },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        layer: "validation",
        code: "invalid_request",
        retryable: false,
      },
      outcome: "not_started",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  test("rejects an untrusted operation classification before invoking fetch", async () => {
    const fetchMock = vi.fn();
    const client = createProxyClient(runtimeConfig(), { fetch: fetchMock });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "model-selected" as never,
      method: "GET",
      path: "api/v4/leads",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { layer: "validation", code: "invalid_request" },
      outcome: "not_started",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("fails closed before dispatch when a runtime secret cannot form a header", async () => {
    const config = parseRuntimeConfig({
      cloudru: {
        proxyBaseUrl: "https://proxy.example.test",
        projectId: "project",
        evoClawId: "evo",
        apiKey: "unicode-\u{1F511}",
      },
    });
    const fetchMock = vi.fn();
    const client = createProxyClient(config, { fetch: fetchMock });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/leads",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        layer: "cloudru_proxy",
        code: "invalid_runtime_transport",
      },
      outcome: "not_started",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("unicode-");
  });

  test("uses the validated body content type instead of a conflicting header", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("content-type")).toBe(
        "application/json",
      );
      return jsonResponse({ ok: true });
    });
    const client = createProxyClient(runtimeConfig(), { fetch: fetchMock });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "mutation",
      method: "POST",
      path: "api/v4/leads",
      headers: { "content-type": "text/plain" },
      body: validateRequestBody({ jsonBody: { name: "lead" } }, 1_024),
    });

    expect(result).toMatchObject({ ok: true });
  });

  test("rejects a forged body content type as a secret-free validation failure", async () => {
    const sentinel = "forged-content-type-secret";
    const fetchMock = vi.fn();
    const client = createProxyClient(runtimeConfig(), { fetch: fetchMock });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "mutation",
      method: "POST",
      path: "api/v4/leads",
      body: {
        kind: "text",
        contentType: `text/plain\r\n${sentinel}`,
        bytes: new TextEncoder().encode("payload-secret"),
        size: 14,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { layer: "validation", code: "invalid_request" },
      outcome: "not_started",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain("payload-secret");
  });
});

describe("bounded response handling", () => {
  test.each([300, 301, 302, 303, 305, 306, 307, 308])(
    "rejects redirect status %i and cancels its body",
    async (status) => {
      const streamed = streamedResponse(
        [new TextEncoder().encode("redirect-secret")],
        { status, headers: { location: "https://attacker.example" } },
      );
      const client = createProxyClient(runtimeConfig(), {
        fetch: vi.fn(async () => streamed.response),
      });

      const result = await client.request({
        providerConfigKey: "amocrm-crm",
        operationKind: "read",
        method: "GET",
        path: "api/v4/leads",
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          layer: "unknown_upstream",
          code: "redirect_blocked",
          status,
        },
        outcome: "confirmed_failed",
      });
      expect(streamed.cancel).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain("attacker.example");
      expect(JSON.stringify(result)).not.toContain("redirect-secret");
    },
  );

  test("treats 304 as an ordinary upstream failure, not a redirect", async () => {
    const client = createProxyClient(runtimeConfig(), {
      fetch: vi.fn(async () => new Response(null, { status: 304 })),
    });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/leads",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "upstream_http_error", status: 304 },
    });
  });

  test("returns only allowlisted response metadata", async () => {
    const sentinel = "response-secret-sentinel";
    const client = createProxyClient(runtimeConfig(), {
      fetch: vi.fn(async () =>
        jsonResponse(
          { ok: true },
          {
            headers: {
              authorization: sentinel,
              "set-cookie": `session=${sentinel}`,
              "x-nango-connection-id": sentinel,
              "x-provider-debug": sentinel,
              "x-request-id": "request-1",
              "x-ratelimit-remaining": "9",
            },
          },
        ),
      ),
    });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/leads",
    });

    expect(result).toMatchObject({
      ok: true,
      response: {
        headers: {
          "x-request-id": "request-1",
          "x-ratelimit-remaining": "9",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  test.each([
    "application/json",
    "application/problem+json; charset=utf-8",
  ])("parses %s as JSON without response convenience methods", async (contentType) => {
    const response = new Response('{"items":[1],"proxyError":{"layer":"provider"}}', {
      headers: { "content-type": contentType },
    });
    Object.defineProperties(response, {
      arrayBuffer: { value: vi.fn(() => { throw new Error("forbidden"); }) },
      json: { value: vi.fn(() => { throw new Error("forbidden"); }) },
      text: { value: vi.fn(() => { throw new Error("forbidden"); }) },
    });
    const client = createProxyClient(runtimeConfig(), {
      fetch: vi.fn(async () => response),
    });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/leads",
    });

    expect(result).toMatchObject({
      ok: true,
      response: {
        body: { items: [1], proxyError: { layer: "provider" } },
      },
    });
  });

  test("rejects invalid JSON without returning payload fragments", async () => {
    const sentinel = "invalid-json-payload-secret";
    const client = createProxyClient(transportConfig({ readAttempts: 1 }), {
      fetch: vi.fn(async () =>
        new Response(`{"secret":"${sentinel}"`, {
          headers: { "content-type": "application/json" },
        }),
      ),
    });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/leads",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        layer: "unknown_upstream",
        code: "invalid_json_response",
        status: 200,
      },
      outcome: "confirmed_failed",
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  test("decodes text as UTF-8 with replacement", async () => {
    const streamed = streamedResponse(
      [Uint8Array.from([0x66, 0x6f, 0x80, 0x6f])],
      { headers: { "content-type": "text/plain" } },
    );
    const client = createProxyClient(runtimeConfig(), {
      fetch: vi.fn(async () => streamed.response),
    });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/leads",
    });

    expect(result).toMatchObject({
      ok: true,
      response: { body: "fo\uFFFDo" },
    });
  });

  test.each([
    {
      name: "decoded JSON body",
      response: () =>
        jsonResponse({
          reflected: "cloudru-secret-sentinel",
        }),
    },
    {
      name: "text body",
      response: () =>
        new Response("prefix cloudru-secret-sentinel suffix", {
          headers: { "content-type": "text/plain" },
        }),
    },
    {
      name: "projected response header",
      response: () =>
        jsonResponse(
          { accepted: true },
          {
            headers: {
              "x-request-id":
                "request-cloudru-secret-sentinel-value",
            },
          },
        ),
    },
  ])("rejects a runtime secret reflected in the $name", async ({ response }) => {
    const secret = "cloudru-secret-sentinel";
    const client = createProxyClient(runtimeConfig(), {
      fetch: vi.fn(async () => response()),
    });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/leads",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        layer: "unknown_upstream",
        code: "secret_in_response",
      },
      outcome: "confirmed_failed",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("returns a complete binary digest without body bytes", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 255]);
    const client = createProxyClient(runtimeConfig(), {
      fetch: vi.fn(async () =>
        new Response(bytes, {
          headers: { "content-type": "application/octet-stream" },
        }),
      ),
    });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/files/1",
    });

    expect(result).toMatchObject({
      ok: true,
      response: {
        body: {
          kind: "binary",
          size: bytes.byteLength,
          contentType: "application/octet-stream",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("[0,1,2,3,255]");
  });

  test("returns an empty body and abandons HEAD response bytes", async () => {
    const emptyClient = createProxyClient(runtimeConfig(), {
      fetch: vi.fn(async () => new Response(null, { status: 204 })),
    });
    const streamed = streamedResponse(
      [new TextEncoder().encode("must-not-be-read")],
      { headers: { "content-type": "text/plain" } },
    );
    const headClient = createProxyClient(runtimeConfig(), {
      fetch: vi.fn(async () => streamed.response),
    });

    const empty = await emptyClient.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/leads",
    });
    const head = await headClient.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "HEAD",
      path: "api/v4/leads",
    });

    expect(empty).toMatchObject({ ok: true, response: { body: null } });
    expect(head).toMatchObject({ ok: true, response: { body: null } });
    expect(streamed.cancel).toHaveBeenCalledOnce();
    expect(streamed.pulls()).toBe(0);
  });

  test("accepts a response exactly at the configured cap", async () => {
    const streamed = streamedResponse(
      [new TextEncoder().encode("12"), new TextEncoder().encode("34")],
      { headers: { "content-type": "text/plain" } },
    );
    const client = createProxyClient(responseLimitConfig(4), {
      fetch: vi.fn(async () => streamed.response),
    });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/leads",
    });

    expect(result).toMatchObject({
      ok: true,
      response: { body: "1234" },
    });
    expect(streamed.cancel).not.toHaveBeenCalled();
  });

  test.each([
    [Uint8Array.from([1, 2, 3, 4, 5])],
    [
      Uint8Array.from([1, 2]),
      Uint8Array.from([3, 4]),
      Uint8Array.from([5]),
      new TextEncoder().encode("must-not-be-read"),
    ],
  ])("stops at cap plus one and cancels an oversized stream", async (...chunks) => {
    const streamed = streamedResponse(chunks, {
      headers: { "content-type": "application/octet-stream" },
    });
    const client = createProxyClient(responseLimitConfig(4), {
      fetch: vi.fn(async () => streamed.response),
    });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/files/1",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "response_too_large" },
    });
    expect(streamed.cancel).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("sha256");
    expect(streamed.pulls()).toBeLessThanOrEqual(3);
  });

  test("does not trust a provider-controlled proxyError discriminator", async () => {
    const sentinel = "provider-body-secret-sentinel";
    const streamed = streamedResponse(
      [
        new TextEncoder().encode(
          JSON.stringify({
            proxyError: {
              layer: "cloudru_proxy",
              code: sentinel,
            },
          }),
        ),
      ],
      { status: 400, headers: { "content-type": "application/json" } },
    );
    const client = createProxyClient(runtimeConfig(), {
      fetch: vi.fn(async () => streamed.response),
    });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/leads",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { layer: "unknown_upstream", code: "upstream_http_error" },
      outcome: "confirmed_failed",
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
});

describe("bounded read retries", () => {
  test("retries transient network failures and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network-secret-one"))
      .mockRejectedValueOnce(new Error("network-secret-two"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = createProxyClient(transportConfig(), { fetch: fetchMock });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/leads",
    });

    expect(result).toMatchObject({ ok: true, outcome: "confirmed" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain("network-secret");
  });

  test.each([408, 429, 500, 502, 599])(
    "retries transient HTTP status %i and cancels abandoned bodies",
    async (status) => {
      const first = streamedResponse(
        [new TextEncoder().encode("retry-body-secret")],
        { status },
      );
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(first.response)
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const client = createProxyClient(transportConfig(), {
        fetch: fetchMock,
      });

      const result = await client.request({
        providerConfigKey: "amocrm-crm",
        operationKind: "read",
        method: "OPTIONS",
        path: "api/v4/leads",
      });

      expect(result).toMatchObject({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(first.cancel).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain("retry-body-secret");
    },
  );

  test.each([400, 404])(
    "does not retry definitive HTTP status %i",
    async (status) => {
      const fetchMock = vi.fn(async () => new Response(null, { status }));
      const client = createProxyClient(transportConfig(), {
        fetch: fetchMock,
      });

      const result = await client.request({
        providerConfigKey: "amocrm-crm",
        operationKind: "read",
        method: "GET",
        path: "api/v4/leads",
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "upstream_http_error",
          status,
          retryable: false,
        },
        outcome: "confirmed_failed",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  test("stops after the configured inclusive attempt count", async () => {
    const responses = [500, 500, 500].map((status) =>
      streamedResponse([new TextEncoder().encode("discard")], { status }),
    );
    const fetchMock = vi.fn();
    for (const response of responses) {
      fetchMock.mockResolvedValueOnce(response.response);
    }
    const client = createProxyClient(transportConfig({ readAttempts: 3 }), {
      fetch: fetchMock,
    });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/leads",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "upstream_http_error",
        status: 500,
        retryable: true,
      },
      outcome: "confirmed_failed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const response of responses) {
      expect(response.cancel).toHaveBeenCalledOnce();
    }
  });

  test("returns a bounded failure after exhausting network attempts", async () => {
    const sentinel = "network-exhaustion-secret";
    const fetchMock = vi.fn(async () => {
      throw new Error(sentinel);
    });
    const client = createProxyClient(
      transportConfig({ readAttempts: 2 }),
      { fetch: fetchMock },
    );

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "read",
      method: "GET",
      path: "api/v4/leads",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        layer: "network",
        code: "network_error",
        retryable: true,
      },
      outcome: "confirmed_failed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  test("uses clipped delta-seconds Retry-After", async () => {
    vi.useFakeTimers();
    try {
      const clock = fakeClock();
      const first = streamedResponse([], {
        status: 429,
        headers: { "retry-after": "20" },
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(first.response)
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const client = createProxyClient(
        transportConfig({
          defaultTimeoutMs: 2_000,
          maxTimeoutMs: 2_000,
          operationDeadlineMs: 5_000,
          initialBackoffMs: 100,
          maxBackoffMs: 750,
        }),
        { fetch: fetchMock, ...clock },
      );

      const pending = client.request({
        providerConfigKey: "amocrm-crm",
        operationKind: "read",
        method: "GET",
        path: "api/v4/leads",
      });
      await vi.advanceTimersByTimeAsync(750);
      const result = await pending;

      expect(result).toMatchObject({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(clock.scheduledDelays).toContain(750);
    } finally {
      vi.useRealTimers();
    }
  });

  test("uses an HTTP-date Retry-After relative to the injected wall clock", async () => {
    vi.useFakeTimers();
    try {
      const wallStart = Date.UTC(2026, 6, 23, 12, 0, 0);
      const clock = fakeClock(wallStart);
      const first = streamedResponse([], {
        status: 503,
        headers: {
          "retry-after": new Date(wallStart + 1_000).toUTCString(),
        },
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(first.response)
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const client = createProxyClient(
        transportConfig({
          defaultTimeoutMs: 2_000,
          maxTimeoutMs: 2_000,
          operationDeadlineMs: 5_000,
          initialBackoffMs: 100,
          maxBackoffMs: 2_000,
        }),
        { fetch: fetchMock, ...clock },
      );

      const pending = client.request({
        providerConfigKey: "amocrm-crm",
        operationKind: "read",
        method: "GET",
        path: "api/v4/leads",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(result).toMatchObject({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(clock.scheduledDelays).toContain(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  test("retries a trusted semantic read even when its HTTP method is POST", async () => {
    const first = streamedResponse([], { status: 503 });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = createProxyClient(transportConfig(), {
      fetch: fetchMock,
    });

    const result = await client.request({
      providerConfigKey: "yandex-direct",
      operationKind: "read",
      method: "POST",
      path: "json/v5/campaigns",
    });

    expect(result).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.cancel).toHaveBeenCalledOnce();
  });

  test("snapshots request bytes so retries cannot be changed by caller mutation", async () => {
    vi.useFakeTimers();
    try {
      const clock = fakeClock();
      const dispatchedBodies: number[][] = [];
      const fetchMock = vi
        .fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          dispatchedBodies.push([
            ...new Uint8Array(init?.body as ArrayBuffer),
          ]);
          return fetchMock.mock.calls.length === 1
            ? new Response(null, { status: 503 })
            : jsonResponse({ ok: true });
        });
      const client = createProxyClient(
        transportConfig({
          initialBackoffMs: 100,
          maxBackoffMs: 100,
        }),
        { fetch: fetchMock, ...clock },
      );
      const body = validateRequestBody(
        { textBody: "first", contentType: "text/plain" },
        1_024,
      );
      if (body === undefined) {
        throw new Error("test setup failed");
      }

      const pending = client.request({
        providerConfigKey: "yandex-direct",
        operationKind: "read",
        method: "POST",
        path: "json/v5/campaigns",
        body,
      });
      body.bytes.fill(0x78);
      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;

      expect(result).toMatchObject({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(dispatchedBodies[0]).toEqual([
        ...new TextEncoder().encode("first"),
      ]);
      expect(dispatchedBodies[1]).toEqual(dispatchedBodies[0]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mutation ambiguity boundary", () => {
  test.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "never retries %s after a network failure",
    async (method) => {
      const sentinel = "mutation-network-secret";
      const fetchMock = vi.fn(async () => {
        throw new Error(sentinel);
      });
      const client = createProxyClient(transportConfig(), {
        fetch: fetchMock,
      });

      const result = await client.request({
        providerConfigKey: "amocrm-crm",
        operationKind: "mutation",
        method,
        path: "api/v4/leads",
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          layer: "network",
          code: "network_error",
          retryable: false,
        },
        outcome: "unknown",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain(sentinel);
    },
  );

  test.each([502, 503, 504])(
    "reports mutation status %i as unknown without retrying",
    async (status) => {
      const fetchMock = vi.fn(async () => new Response(null, { status }));
      const client = createProxyClient(transportConfig(), {
        fetch: fetchMock,
      });

      const result = await client.request({
        providerConfigKey: "amocrm-crm",
        operationKind: "mutation",
        method: "POST",
        path: "api/v4/leads",
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          layer: "unknown_upstream",
          status,
          retryable: false,
        },
        outcome: "unknown",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  test.each([400, 409])(
    "reports definitive mutation status %i as confirmed failed",
    async (status) => {
      const fetchMock = vi.fn(async () => new Response(null, { status }));
      const client = createProxyClient(transportConfig(), {
        fetch: fetchMock,
      });

      const result = await client.request({
        providerConfigKey: "amocrm-crm",
        operationKind: "mutation",
        method: "POST",
        path: "api/v4/leads",
      });

      expect(result).toMatchObject({
        ok: false,
        error: { status },
        outcome: "confirmed_failed",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  test("never retries a trusted mutation even when its HTTP method is GET", async () => {
    const sentinel = "bitrix-get-mutation-secret";
    const fetchMock = vi.fn(async () => {
      throw new Error(sentinel);
    });
    const client = createProxyClient(transportConfig(), {
      fetch: fetchMock,
    });

    const result = await client.request({
      providerConfigKey: "bitrix24-crm",
      operationKind: "mutation",
      method: "GET",
      path: "crm.deal.delete.json",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { retryable: false },
      outcome: "unknown",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  test("keeps a rejected mutation at not_started when validation blocks dispatch", async () => {
    const fetchMock = vi.fn();
    const client = createProxyClient(transportConfig(), {
      fetch: fetchMock,
    });

    const result = await client.request({
      providerConfigKey: "bitrix24-crm",
      operationKind: "mutation",
      method: "GET",
      path: "../unsafe",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { layer: "validation", code: "invalid_request" },
      outcome: "not_started",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("total deadline and stream cleanup", () => {
  test("applies the total operation deadline during dispatch", async () => {
    vi.useFakeTimers();
    try {
      const clock = fakeClock();
      const fetchMock = vi.fn(
        async () => new Promise<Response>(() => undefined),
      );
      const client = createProxyClient(
        transportConfig({
          defaultTimeoutMs: 300,
          maxTimeoutMs: 300,
          operationDeadlineMs: 300,
          readAttempts: 1,
        }),
        { fetch: fetchMock, ...clock },
      );

      const pending = client.request({
        providerConfigKey: "amocrm-crm",
        operationKind: "mutation",
        method: "POST",
        path: "api/v4/leads",
      });
      await vi.advanceTimersByTimeAsync(300);
      const result = await pending;

      expect(result).toMatchObject({
        ok: false,
        error: { code: "operation_deadline", retryable: false },
        outcome: "unknown",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds a hanging mutation dispatch with the per-request timeout", async () => {
    vi.useFakeTimers();
    try {
      const clock = fakeClock();
      const fetchMock = vi.fn(
        async () => new Promise<Response>(() => undefined),
      );
      const client = createProxyClient(
        transportConfig({
          defaultTimeoutMs: 100,
          maxTimeoutMs: 100,
          operationDeadlineMs: 500,
          readAttempts: 3,
        }),
        { fetch: fetchMock, ...clock },
      );

      const pending = client.request({
        providerConfigKey: "amocrm-crm",
        operationKind: "mutation",
        method: "POST",
        path: "api/v4/leads",
      });
      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;

      expect(result).toMatchObject({
        ok: false,
        error: { code: "request_timeout", retryable: false },
        outcome: "unknown",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("applies one total deadline to a retry wait", async () => {
    vi.useFakeTimers();
    try {
      const clock = fakeClock();
      const first = streamedResponse([], {
        status: 429,
        headers: { "retry-after": "60" },
      });
      const fetchMock = vi.fn(async () => first.response);
      const client = createProxyClient(
        transportConfig({
          defaultTimeoutMs: 400,
          maxTimeoutMs: 400,
          operationDeadlineMs: 400,
          initialBackoffMs: 100,
          maxBackoffMs: 1_000,
        }),
        { fetch: fetchMock, ...clock },
      );

      const pending = client.request({
        providerConfigKey: "amocrm-crm",
        operationKind: "read",
        method: "GET",
        path: "api/v4/leads",
      });
      await vi.advanceTimersByTimeAsync(400);
      const result = await pending;

      expect(result).toMatchObject({
        ok: false,
        error: { code: "operation_deadline", retryable: false },
        outcome: "confirmed_failed",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(first.cancel).toHaveBeenCalledOnce();
      expect(clock.scheduledDelays).toContain(400);
    } finally {
      vi.useRealTimers();
    }
  });

  test("clips each attempt timeout to the remaining total deadline", async () => {
    vi.useFakeTimers();
    try {
      const clock = fakeClock();
      const first = streamedResponse([], {
        status: 503,
        headers: { "retry-after": "1" },
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(first.response)
        .mockImplementationOnce(
          async () => new Promise<Response>(() => undefined),
        );
      const client = createProxyClient(
        transportConfig({
          defaultTimeoutMs: 800,
          maxTimeoutMs: 800,
          operationDeadlineMs: 1_000,
          initialBackoffMs: 100,
          maxBackoffMs: 700,
        }),
        { fetch: fetchMock, ...clock },
      );

      const pending = client.request({
        providerConfigKey: "amocrm-crm",
        operationKind: "read",
        method: "GET",
        path: "api/v4/leads",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(result).toMatchObject({
        ok: false,
        error: { code: "operation_deadline" },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(clock.scheduledDelays).toContain(300);
    } finally {
      vi.useRealTimers();
    }
  });

  test("aborts and cancels a response stream at the total deadline", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel,
      });
      const clock = fakeClock();
      const client = createProxyClient(
        transportConfig({
          defaultTimeoutMs: 500,
          maxTimeoutMs: 500,
          operationDeadlineMs: 500,
          readAttempts: 1,
        }),
        {
          fetch: vi.fn(async () =>
            new Response(stream, {
              headers: { "content-type": "application/octet-stream" },
            }),
          ),
          ...clock,
        },
      );

      const pending = client.request({
        providerConfigKey: "amocrm-crm",
        operationKind: "read",
        method: "GET",
        path: "api/v4/files/1",
      });
      await vi.advanceTimersByTimeAsync(500);
      const result = await pending;

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "operation_deadline",
          status: 200,
        },
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(JSON.stringify(result)).not.toContain("sha256");
    } finally {
      vi.useRealTimers();
    }
  });

  test("returns unknown and cancels after a mutation response stream error", async () => {
    const cancel = vi.fn();
    const sentinel = "stream-error-secret-sentinel";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial-secret"));
        controller.error(new Error(sentinel));
      },
      cancel,
    });
    const fetchMock = vi.fn(async () =>
      new Response(stream, {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const client = createProxyClient(transportConfig(), {
      fetch: fetchMock,
    });

    const result = await client.request({
      providerConfigKey: "amocrm-crm",
      operationKind: "mutation",
      method: "POST",
      path: "api/v4/leads",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        layer: "network",
        code: "response_stream_error",
        status: 200,
        retryable: false,
      },
      outcome: "unknown",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain("partial-secret");
  });
});
