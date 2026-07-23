import { describe, expect, test } from "vitest";

import {
  ERROR_LAYERS,
  OUTCOMES,
  createFailureResult,
  createSuccessResult,
  filterResponseHeaders,
  type RequestSummary,
} from "../src/result.js";

const REQUEST: RequestSummary = Object.freeze({
  providerConfigKey: "amocrm-crm",
  method: "GET",
  path: "api/v4/leads",
});

describe("result envelopes", () => {
  test("keeps outcome and layer unions exhaustive and immutable", () => {
    expect(OUTCOMES).toEqual([
      "confirmed",
      "confirmed_failed",
      "not_started",
      "unknown",
    ]);
    expect(ERROR_LAYERS).toEqual([
      "validation",
      "approval",
      "cloudru_proxy",
      "nango",
      "provider",
      "unknown_upstream",
      "network",
      "local_io",
    ]);
    expect(Object.isFrozen(OUTCOMES)).toBe(true);
    expect(Object.isFrozen(ERROR_LAYERS)).toBe(true);
  });

  test("constructs a confirmed success envelope", () => {
    const result = createSuccessResult(REQUEST, {
      status: 200,
      contentType: "application/json",
      headers: { "x-request-id": "request-1" },
      body: { items: [] },
    });

    expect(result).toEqual({
      ok: true,
      request: REQUEST,
      response: {
        status: 200,
        contentType: "application/json",
        headers: { "x-request-id": "request-1" },
        body: { items: [] },
      },
      outcome: "confirmed",
    });
  });

  test.each(["confirmed_failed", "not_started", "unknown"] as const)(
    "constructs a bounded failure envelope with outcome %s",
    (outcome) => {
      const result = createFailureResult(REQUEST, {
        layer: "unknown_upstream",
        code: "stable_code",
        message: "A".repeat(2_000),
        status: 503,
        retryable: false,
        outcome,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message.length).toBeLessThanOrEqual(256);
        expect(result.error).toMatchObject({
          layer: "unknown_upstream",
          code: "stable_code",
          status: 503,
          retryable: false,
        });
        expect(result.outcome).toBe(outcome);
      }
    },
  );

  test("caps error messages by UTF-8 bytes without splitting a code point", () => {
    const result = createFailureResult(REQUEST, {
      layer: "network",
      code: "network_error",
      message: `${"A".repeat(255)}\u20AC`,
      retryable: false,
      outcome: "confirmed_failed",
    });

    expect(
      new TextEncoder().encode(result.error.message).byteLength,
    ).toBeLessThanOrEqual(256);
    expect(result.error.message).not.toContain("\uFFFD");
  });

  test("rejects unsafe constructor fields instead of echoing them", () => {
    const sentinel = "failure-secret-sentinel";

    expect(() =>
      createFailureResult(REQUEST, {
        layer: "not-a-layer" as never,
        code: sentinel,
        message: sentinel,
        retryable: false,
        outcome: "confirmed_failed",
      }),
    ).toThrowError("invalid_failure_descriptor");
  });
});

describe("response header projection", () => {
  test("returns only request, pagination, retry, rate and entity headers", () => {
    const headers = new Headers([
      ["ETag", '"entity"'],
      ["Last-Modified", "Wed, 22 Jul 2026 10:00:00 GMT"],
      ["Link", '<https://tenant.example/next>; rel="next"'],
      ["Request-Id", "request-0"],
      ["Retry-After", "3"],
      ["X-Correlation-Id", "correlation-1"],
      ["X-Next-Page", "2"],
      ["X-Page", "1"],
      ["X-Pagination-Total", "25"],
      ["X-Per-Page", "10"],
      ["X-RateLimit-Remaining", "9"],
      ["RateLimit-Reset", "12"],
      ["X-Request-Id", "request-1"],
      ["X-Total", "25"],
      ["X-Total-Count", "25"],
    ]);

    expect(filterResponseHeaders(headers)).toEqual({
      etag: '"entity"',
      "last-modified": "Wed, 22 Jul 2026 10:00:00 GMT",
      link: '<https://tenant.example/next>; rel="next"',
      "ratelimit-reset": "12",
      "request-id": "request-0",
      "retry-after": "3",
      "x-correlation-id": "correlation-1",
      "x-next-page": "2",
      "x-page": "1",
      "x-pagination-total": "25",
      "x-per-page": "10",
      "x-ratelimit-remaining": "9",
      "x-request-id": "request-1",
      "x-total": "25",
      "x-total-count": "25",
    });
  });

  test("redacts arbitrary, credential, cookie and routing headers", () => {
    const sentinel = "response-secret-sentinel";
    const headers = new Headers([
      ["Authorization", sentinel],
      ["Set-Cookie", `session=${sentinel}`],
      ["X-Nango-Connection-Id", sentinel],
      ["X-Cloudru-Api-Key", sentinel],
      ["X-Provider-Debug", sentinel],
      ["X-Request-Id", "safe-request-id"],
    ]);

    const projected = filterResponseHeaders(headers);
    expect(projected).toEqual({ "x-request-id": "safe-request-id" });
    expect(JSON.stringify(projected)).not.toContain(sentinel);
    expect(Object.isFrozen(projected)).toBe(true);
  });

  test("drops unsafe or oversized allowed metadata without echoing it", () => {
    const sentinel = "metadata-secret-sentinel";
    const headers = {
      entries() {
        return [
          ["x-request-id", `safe\r\n${sentinel}`],
          ["etag", "x".repeat(16_385)],
        ][Symbol.iterator]();
      },
    } as Headers;

    const projected = filterResponseHeaders(headers);
    expect(projected).toEqual({});
    expect(JSON.stringify(projected)).not.toContain(sentinel);
  });

  test("caps the aggregate allowlisted header projection", () => {
    const headers = new Headers();
    for (let index = 0; index < 32; index += 1) {
      headers.set(
        `x-pagination-field-${index.toString().padStart(2, "0")}`,
        "v".repeat(1_000),
      );
    }

    const projected = filterResponseHeaders(headers);
    const totalBytes = Object.entries(projected).reduce(
      (total, [name, value]) =>
        total +
        new TextEncoder().encode(name).byteLength +
        new TextEncoder().encode(value).byteLength,
      0,
    );

    expect(totalBytes).toBeLessThanOrEqual(16_384);
    expect(Object.keys(projected).length).toBeLessThan(32);
  });
});
