import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  DEFAULT_RUNTIME_LIMITS,
  PLUGIN_CONFIG_SCHEMA,
  RuntimeConfigError,
  getTrustedLinkOrigins,
  parseRuntimeConfig,
  projectPublicConfig,
} from "../src/config.js";
import {
  HTTP_METHODS,
  ValidationError,
  encodeOrderedQuery,
  isReadMethod,
  validateHttpMethod,
  validateProviderHeaders,
  validateRelativeProviderPath,
  validateRequestBody,
} from "../src/validation.js";

function expectValidationCode(
  run: () => unknown,
  code: string,
  sentinel?: string,
): void {
  try {
    run();
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe(code);
    if (sentinel) {
      expect(String(error)).not.toContain(sentinel);
    }
  }
}

function expectConfigCode(
  run: () => unknown,
  code: string,
  sentinel?: string,
): void {
  try {
    run();
    throw new Error("expected config parsing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeConfigError);
    expect((error as RuntimeConfigError).code).toBe(code);
    if (sentinel) {
      expect(String(error)).not.toContain(sentinel);
    }
  }
}

const MINIMAL_CONFIG = {
  cloudru: {
    proxyBaseUrl: "https://proxy.example.test/base/",
    projectId: "project-sentinel",
    evoClawId: "evoclaw-sentinel",
    apiKey: "cloudru-secret-sentinel",
  },
};

describe("provider path validation", () => {
  test.each([
    ["api/v4/leads", "api/v4/leads"],
    ["crm.lead.list", "crm.lead.list"],
    ["calendars/user/event.ics", "calendars/user/event.ics"],
    ["folder/space%20here/", "folder/space%20here/"],
    ["folder/raw space", "folder/raw%20space"],
    ["api/лиды", "api/%D0%BB%D0%B8%D0%B4%D1%8B"],
    ["api/%D0%BB%D0%B8%D0%B4%D1%8B", "api/%D0%BB%D0%B8%D0%B4%D1%8B"],
    ["api/!'()*", "api/%21%27%28%29%2A"],
  ])("accepts and canonicalizes a strict relative path", (input, expected) => {
    expect(validateRelativeProviderPath(input)).toBe(expected);
  });

  test.each([
    ["", "invalid_path"],
    ["/api/v4/leads", "invalid_path"],
    ["//provider.example/path", "invalid_path"],
    ["https://provider.example/path", "invalid_path"],
    ["mailto:user@example.test", "invalid_path"],
    ["api/v4/leads?limit=1", "invalid_path"],
    ["api/v4/leads#fragment", "invalid_path"],
    ["api\\v4\\leads", "invalid_path"],
    ["api//leads", "unsafe_path_segment"],
    ["api/./leads", "unsafe_path_segment"],
    ["api/../leads", "unsafe_path_segment"],
    ["api/%2e/leads", "unsafe_path_segment"],
    ["api/%2E%2E/leads", "unsafe_path_segment"],
    ["api/%252e%252e/leads", "unsafe_path_segment"],
    ["api/%2f/leads", "unsafe_path_segment"],
    ["api/%5C/leads", "unsafe_path_segment"],
    ["api/%252F/leads", "unsafe_path_segment"],
    ["api/%ZZ/leads", "invalid_path_encoding"],
    ["api/\u0000leads", "invalid_path"],
    ["api/%00leads", "invalid_path"],
  ])("rejects unsafe provider paths", (input, code) => {
    expectValidationCode(
      () => validateRelativeProviderPath(input),
      code,
      input,
    );
  });

  test("enforces the routing path byte limit", () => {
    expectValidationCode(
      () => validateRelativeProviderPath(`api/${"a".repeat(4093)}`),
      "invalid_path",
    );
  });
});

describe("HTTP method validation", () => {
  test("preserves every advertised method and classifies reads", () => {
    const methods = [
      "GET",
      "HEAD",
      "OPTIONS",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "PROPFIND",
      "REPORT",
    ] as const;
    expect(methods.map((method) => validateHttpMethod(method))).toEqual(methods);
    expect(Object.isFrozen(HTTP_METHODS)).toBe(true);
    expect(validateHttpMethod("get")).toBe("GET");
    expect(methods.filter((method) => isReadMethod(method))).toEqual([
      "GET",
      "HEAD",
      "OPTIONS",
      "PROPFIND",
      "REPORT",
    ]);
  });

  test.each(["", "TRACE", "CONNECT", " POST ", 1, null])(
    "rejects an unsupported or malformed method",
    (method) => {
      expectValidationCode(() => validateHttpMethod(method), "invalid_method");
    },
  );
});

describe("ordered query validation", () => {
  test("preserves pair order, repeated names and empty values", () => {
    expect(
      encodeOrderedQuery([
        { name: "tag", value: "first" },
        { name: "filter[status]", value: "active" },
        { name: "tag", value: "with/slash" },
        { name: "flag", value: "" },
      ]),
    ).toBe(
      "tag=first&filter%5Bstatus%5D=active&tag=with%2Fslash&flag=",
    );
  });

  test("UTF-8 encodes Unicode query data without changing order", () => {
    expect(
      encodeOrderedQuery([
        { name: "поиск", value: "два слова" },
        { name: "page", value: "2" },
      ]),
    ).toBe(
      "%D0%BF%D0%BE%D0%B8%D1%81%D0%BA=%D0%B4%D0%B2%D0%B0%20%D1%81%D0%BB%D0%BE%D0%B2%D0%B0&page=2",
    );
  });

  test("uses RFC 3986 component encoding for reserved punctuation", () => {
    expect(encodeOrderedQuery([{ name: "!'()*", value: "!'()*" }])).toBe(
      "%21%27%28%29%2A=%21%27%28%29%2A",
    );
  });

  test.each([
    [null, "invalid_query"],
    [{ name: "page", value: "1" }, "invalid_query"],
    [[{ name: "", value: "1" }], "invalid_query"],
    [[{ name: "page", value: 1 }], "invalid_query"],
    [[{ name: "line\nbreak", value: "1" }], "invalid_query"],
    [[{ name: "page", value: "line\u007fbreak" }], "invalid_query"],
    [[{ name: "page", value: "\ud800" }], "invalid_query"],
    [[{ name: "a".repeat(4_097), value: "1" }], "query_too_large"],
  ])("rejects malformed or oversized query pairs", (input, code) => {
    expectValidationCode(() => encodeOrderedQuery(input), code);
  });
});

describe("provider header validation", () => {
  test("accepts safe ASCII headers and returns an immutable normalized copy", () => {
    const input = {
      Depth: "1",
      "X-Provider-Feature": "first:second",
    };

    const validated = validateProviderHeaders(input);

    expect(validated).toEqual({
      depth: "1",
      "x-provider-feature": "first:second",
    });
    expect(Object.isFrozen(validated)).toBe(true);
    input.Depth = "infinity";
    expect(validated.depth).toBe("1");
  });

  test("preserves a safe __proto__ header as data without prototype mutation", () => {
    const headers = JSON.parse('{"__proto__":"provider-value"}') as unknown;
    const validated = validateProviderHeaders(headers);

    expect(Object.hasOwn(validated, "__proto__")).toBe(true);
    expect(validated.__proto__).toBe("provider-value");
    expect(Object.getPrototypeOf(validated)).toBe(Object.prototype);
  });

  test.each([
    "Authorization",
    "Proxy-Authorization",
    "Cookie",
    "Set-Cookie",
    "Host",
    "Connection",
    "Keep-Alive",
    "Proxy-Connection",
    "TE",
    "Trailer",
    "Transfer-Encoding",
    "Upgrade",
    "Content-Length",
    "Api-Key",
    "X-Api-Key",
    "X-Nango-Connection-Id",
    "X-Cloudru-Api-Key",
    "X-EvoClaw-Id",
    "X-Evolution-Project-Id",
  ])("rejects credential, routing and hop-by-hop header %s", (name) => {
    expectValidationCode(
      () => validateProviderHeaders({ [name]: "header-secret-sentinel" }),
      "blocked_header",
      "header-secret-sentinel",
    );
  });

  test.each([
    [{ "Bad Name": "value" }, "invalid_header"],
    [{ "X-Test\r\nInjected": "value" }, "invalid_header"],
    [{ "X-Test": "value\r\nInjected: yes" }, "invalid_header"],
    [{ "X-Test": "секрет" }, "invalid_header"],
    [{ "X-Test": 1 }, "invalid_header"],
    [{ "X-Test": "one", "x-test": "two" }, "duplicate_header"],
    [[], "invalid_headers"],
  ])("rejects malformed or ambiguous headers", (headers, code) => {
    expectValidationCode(() => validateProviderHeaders(headers), code);
  });
});

describe("request body validation", () => {
  test("supports JSON null and uses the JSON media type", () => {
    const body = validateRequestBody({ jsonBody: null }, 1_024);

    expect(body).toMatchObject({
      kind: "json",
      contentType: "application/json",
      size: 4,
    });
    expect(new TextDecoder().decode(body?.bytes)).toBe("null");
    expect(Object.isFrozen(body)).toBe(true);
  });

  test("supports bounded UTF-8 text with an explicit content type", () => {
    const body = validateRequestBody(
      {
        textBody: "BEGIN:VCALENDAR",
        contentType: "text/calendar; charset=utf-8",
      },
      1_024,
    );

    expect(body?.kind).toBe("text");
    expect(new TextDecoder().decode(body?.bytes)).toBe("BEGIN:VCALENDAR");
  });

  test("strictly decodes a canonical base64 body", () => {
    const body = validateRequestBody(
      {
        base64Body: "AAEC",
        contentType: "application/octet-stream",
      },
      3,
    );

    expect(body).toMatchObject({
      kind: "base64",
      contentType: "application/octet-stream",
      size: 3,
    });
    expect([...body!.bytes]).toEqual([0, 1, 2]);
  });

  test("allows a body-less request but not a detached content type", () => {
    expect(validateRequestBody({}, 1_024)).toBeUndefined();
    expectValidationCode(
      () => validateRequestBody({ contentType: "text/plain" }, 1_024),
      "invalid_body",
    );
  });

  test.each([
    [
      { jsonBody: {}, textBody: "also" },
      1_024,
      "multiple_body_modes",
    ],
    [
      { textBody: "missing media type" },
      1_024,
      "invalid_content_type",
    ],
    [
      { base64Body: "not base64!", contentType: "application/octet-stream" },
      1_024,
      "invalid_base64",
    ],
    [
      { jsonBody: {}, contentType: "application/problem+json" },
      1_024,
      "invalid_content_type",
    ],
    [
      { textBody: "sentinel-secret-body", contentType: "text/plain" },
      3,
      "body_too_large",
    ],
    [
      { textBody: "body", contentType: "text/plain\r\nX-Evil: yes" },
      1_024,
      "invalid_content_type",
    ],
    [{ textBody: "body", contentType: "text/plain", extra: true }, 1_024, "invalid_body"],
  ])("rejects ambiguous, malformed or oversized bodies", (input, limit, code) => {
    expectValidationCode(
      () => validateRequestBody(input, limit),
      code,
      "sentinel-secret-body",
    );
  });

  test("rejects circular JSON without exposing its values", () => {
    const circular: Record<string, unknown> = {
      value: "circular-secret-sentinel",
    };
    circular.self = circular;

    expectValidationCode(
      () => validateRequestBody({ jsonBody: circular }, 1_024),
      "invalid_json_body",
      "circular-secret-sentinel",
    );
  });
});

describe("strict runtime plugin config", () => {
  test("applies deterministic bounded defaults once", () => {
    const config = parseRuntimeConfig(MINIMAL_CONFIG);

    expect(config).toEqual({
      cloudru: {
        proxyBaseUrl: "https://proxy.example.test/base",
        projectId: "project-sentinel",
        evoClawId: "evoclaw-sentinel",
        apiKey: "cloudru-secret-sentinel",
      },
      transport: DEFAULT_RUNTIME_LIMITS.transport,
      pagination: {
        ...DEFAULT_RUNTIME_LIMITS.pagination,
        linkOrigins: {},
      },
    });
    expect(config.transport.readAttempts).toBe(3);
    expect(config.transport.readAttempts).toBeGreaterThanOrEqual(1);
  });

  test.each([
    [{ ...MINIMAL_CONFIG, extra: true }, "unknown_config_property"],
    [
      { cloudru: { ...MINIMAL_CONFIG.cloudru, extra: true } },
      "unknown_config_property",
    ],
    [
      { ...MINIMAL_CONFIG, transport: { extra: true } },
      "unknown_config_property",
    ],
    [
      { ...MINIMAL_CONFIG, pagination: { extra: true } },
      "unknown_config_property",
    ],
    [{ cloudru: null }, "invalid_config"],
    [{ cloudru: {} }, "missing_config_property"],
  ])("rejects unknown, missing or malformed nested config", (input, code) => {
    expectConfigCode(() => parseRuntimeConfig(input), code);
  });

  test("accepts only resolved literal runtime secrets without ambient fallback", () => {
    expectConfigCode(
      () =>
        parseRuntimeConfig({
          cloudru: {
            ...MINIMAL_CONFIG.cloudru,
            apiKey: {
              source: "env",
              provider: "default",
              id: "UNRESOLVED_SECRET_SENTINEL",
            },
          },
        }),
      "unresolved_secret",
      "UNRESOLVED_SECRET_SENTINEL",
    );
    const { apiKey: _apiKey, ...withoutKey } = MINIMAL_CONFIG.cloudru;
    expectConfigCode(
      () => parseRuntimeConfig({ cloudru: withoutKey }),
      "missing_config_property",
    );
  });

  test("contains no ambient process.env fallback", async () => {
    const sourcePath = fileURLToPath(
      new URL("../src/config.ts", import.meta.url),
    );
    const source = await readFile(sourcePath, "utf8");

    expect(source).not.toContain("process.env");
  });

  test.each([
    ["line\r\nsecret", "invalid_secret"],
    ["", "invalid_secret"],
  ])("rejects unsafe literal secrets without echoing them", (apiKey, code) => {
    expectConfigCode(
      () =>
        parseRuntimeConfig({
          cloudru: { ...MINIMAL_CONFIG.cloudru, apiKey },
        }),
      code,
      apiKey,
    );
  });

  test.each([
    "https://proxy.example.test/base/../admin",
    "https://proxy.example.test/base/%2e%2e/admin",
    "https://proxy.example.test/base/%00admin",
    "https://proxy.example.test/base//nested",
    "https://user:password@proxy.example.test/base",
    "https://proxy.example.test/base?target=provider",
    "ftp://proxy.example.test/base",
  ])("rejects an unsafe or non-normalized proxy base URL", (proxyBaseUrl) => {
    expectConfigCode(
      () =>
        parseRuntimeConfig({
          cloudru: { ...MINIMAL_CONFIG.cloudru, proxyBaseUrl },
        }),
      "invalid_url",
      proxyBaseUrl,
    );
  });

  test.each([
    [{ defaultTimeoutMs: 0 }, "invalid_config_bound"],
    [{ maxTimeoutMs: 300_001 }, "invalid_config_bound"],
    [{ operationDeadlineMs: 900_001 }, "invalid_config_bound"],
    [{ readAttempts: 0 }, "invalid_config_bound"],
    [{ readAttempts: 6 }, "invalid_config_bound"],
    [{ maxRequestBytes: 16 * 1_024 * 1_024 + 1 }, "invalid_config_bound"],
    [{ maxResponseBytes: 16 * 1_024 * 1_024 + 1 }, "invalid_config_bound"],
    [
      { defaultTimeoutMs: 31_000, maxTimeoutMs: 30_000 },
      "invalid_config_relation",
    ],
    [
      { maxTimeoutMs: 300_000, operationDeadlineMs: 299_999 },
      "invalid_config_relation",
    ],
    [
      { initialBackoffMs: 10_000, maxBackoffMs: 5_000 },
      "invalid_config_relation",
    ],
  ])("enforces transport bounds and cross-field relations", (transport, code) => {
    expectConfigCode(
      () => parseRuntimeConfig({ ...MINIMAL_CONFIG, transport }),
      code,
    );
  });

  test.each([
    [{ maxPages: 0 }, "invalid_config_bound"],
    [{ maxPages: 101 }, "invalid_config_bound"],
    [{ maxItems: 0 }, "invalid_config_bound"],
    [{ maxItems: 10_001 }, "invalid_config_bound"],
    [
      { linkOrigins: { unknown: ["https://tenant.example.test"] } },
      "unknown_config_property",
    ],
    [
      { linkOrigins: { amocrm: ["http://tenant.amocrm.ru"] } },
      "invalid_origin",
    ],
    [
      {
        linkOrigins: {
          amocrm: ["https://user:pass@tenant.amocrm.ru"],
        },
      },
      "invalid_origin",
    ],
    [
      {
        linkOrigins: {
          amocrm: ["https://tenant.amocrm.ru/path"],
        },
      },
      "invalid_origin",
    ],
  ])("enforces pagination bounds and exact HTTPS origins", (pagination, code) => {
    expectConfigCode(
      () => parseRuntimeConfig({ ...MINIMAL_CONFIG, pagination }),
      code,
    );
  });

  test("combines code-owned static origins with exact operator origins", () => {
    const config = parseRuntimeConfig({
      ...MINIMAL_CONFIG,
      pagination: {
        maxPages: 10,
        maxItems: 500,
        linkOrigins: {
          "amocrm-crm": ["https://tenant.amocrm.ru"],
          "bitrix24-crm": ["https://tenant.bitrix24.ru/"],
          "yandex-maps": ["https://maps-adapter.example.test"],
          yandex: ["https://legacy-id.example.test"],
        },
      },
    });

    expect(getTrustedLinkOrigins(config, "amocrm-crm")).toEqual([
      "https://tenant.amocrm.ru",
    ]);
    expect(getTrustedLinkOrigins(config, "bitrix24-crm")).toEqual([
      "https://tenant.bitrix24.ru",
    ]);
    expect(getTrustedLinkOrigins(config, "yandex-disk")).toEqual([
      "https://cloud-api.yandex.net",
    ]);
    expect(getTrustedLinkOrigins(config, "yandex-maps")).toEqual([
      "https://maps-adapter.example.test",
    ]);
    expect(getTrustedLinkOrigins(config, "yandex")).toEqual([
      "https://login.yandex.ru",
      "https://legacy-id.example.test",
    ]);
  });

  test("parses a strict proxy Action transport with bounded payloads", () => {
    const config = parseRuntimeConfig({
      ...MINIMAL_CONFIG,
      transport: { operationDeadlineMs: 900_000 },
      actions: {
        transport: {
          mode: "proxy",
          endpointUrl: "https://actions.example.test/v1/nango/action",
        },
        syncTimeoutMs: 900_000,
        maxInputBytes: 2_000_000,
        maxOutputBytes: 2_000_000,
      },
    });

    expect(config.actions).toEqual({
      transport: {
        mode: "proxy",
        endpointUrl: "https://actions.example.test/v1/nango/action",
      },
      syncTimeoutMs: 900_000,
      maxInputBytes: 2_000_000,
      maxOutputBytes: 2_000_000,
    });
  });

  test("parses direct Actions only with an exact HTTPS origin and literal secret", () => {
    const config = parseRuntimeConfig({
      ...MINIMAL_CONFIG,
      actions: {
        transport: {
          mode: "direct",
          baseUrl: "https://api.nango.dev/",
          secretKey: "nango-secret-sentinel",
        },
      },
    });

    expect(config.actions?.transport).toEqual({
      mode: "direct",
      baseUrl: "https://api.nango.dev",
      secretKey: "nango-secret-sentinel",
    });
  });

  test.each([
    [{ transport: { mode: "proxy" } }, "missing_config_property"],
    [
      {
        transport: {
          mode: "proxy",
          endpointUrl: "https://actions.example.test/v1/action",
          secretKey: "must-not-be-accepted",
        },
      },
      "unknown_config_property",
    ],
    [
      {
        transport: {
          mode: "direct",
          baseUrl: "http://api.nango.dev",
          secretKey: "secret",
        },
      },
      "invalid_origin",
    ],
    [
      {
        transport: {
          mode: "direct",
          baseUrl: "https://api.nango.dev/path",
          secretKey: "secret",
        },
      },
      "invalid_origin",
    ],
    [
      {
        transport: {
          mode: "direct",
          baseUrl: "https://api.nango.dev",
          secretKey: { source: "file", provider: "vault", id: "secret-id" },
        },
      },
      "unresolved_secret",
    ],
    [
      {
        transport: {
          mode: "proxy",
          endpointUrl: "https://actions.example.test/v1/action",
        },
        syncTimeoutMs: 900_001,
      },
      "invalid_config_bound",
    ],
  ])("rejects malformed or unresolved Action configuration", (actions, code) => {
    expectConfigCode(
      () => parseRuntimeConfig({ ...MINIMAL_CONFIG, actions }),
      code,
      "must-not-be-accepted",
    );
  });

  test("parses separate Disk roots and normalized transfer policy", () => {
    const config = parseRuntimeConfig({
      ...MINIMAL_CONFIG,
      disk: {
        uploadRoots: ["/srv/nango/uploads"],
        downloadRoots: ["/srv/nango/downloads"],
        maxTransferBytes: 10 * 1_024 * 1_024 * 1_024,
        maxRedirects: 5,
        timeoutMs: 3_600_000,
        transferHostSuffixes: [
          "disk.yandex.net",
          "downloader.disk.yandex.ru",
        ],
      },
    });

    expect(config.disk).toEqual({
      uploadRoots: ["/srv/nango/uploads"],
      downloadRoots: ["/srv/nango/downloads"],
      maxTransferBytes: 10 * 1_024 * 1_024 * 1_024,
      maxRedirects: 5,
      timeoutMs: 3_600_000,
      transferHostSuffixes: [
        "disk.yandex.net",
        "downloader.disk.yandex.ru",
      ],
    });
  });

  test.each([
    [
      { uploadRoots: ["/srv/nango/uploads"] },
      { uploadRoots: ["/srv/nango/uploads"], downloadRoots: [] },
    ],
    [
      { downloadRoots: ["/srv/nango/downloads"] },
      { uploadRoots: [], downloadRoots: ["/srv/nango/downloads"] },
    ],
  ])("allows a one-sided Disk deployment", (disk, roots) => {
    const config = parseRuntimeConfig({ ...MINIMAL_CONFIG, disk });

    expect(config.disk).toMatchObject(roots);
    expect(config.disk?.transferHostSuffixes).toEqual([
      "disk.yandex.net",
      "disk.yandex.ru",
      "storage.yandex.net",
    ]);
  });

  test.each([
    [
      {
        uploadRoots: ["relative/uploads"],
        downloadRoots: ["/srv/downloads"],
      },
      "invalid_disk_root",
    ],
    [
      { uploadRoots: ["/"], downloadRoots: ["/srv/downloads"] },
      "invalid_disk_root",
    ],
    [
      { uploadRoots: [], downloadRoots: [] },
      "invalid_disk_root",
    ],
    [
      {
        uploadRoots: Array.from({ length: 33 }, (_, index) => `/srv/u${index}`),
        downloadRoots: ["/srv/downloads"],
      },
      "invalid_config_bound",
    ],
    [
      {
        uploadRoots: ["/srv/uploads"],
        downloadRoots: ["/srv/downloads"],
        maxTransferBytes: 1_024 * 1_024 - 1,
      },
      "invalid_config_bound",
    ],
    [
      {
        uploadRoots: ["/srv/uploads"],
        downloadRoots: ["/srv/downloads"],
        maxRedirects: 6,
      },
      "invalid_config_bound",
    ],
    [
      {
        uploadRoots: ["/srv/uploads"],
        downloadRoots: ["/srv/downloads"],
        timeoutMs: 3_600_001,
      },
      "invalid_config_bound",
    ],
    [
      {
        uploadRoots: ["/srv/uploads"],
        downloadRoots: ["/srv/downloads"],
        transferHostSuffixes: ["example.com"],
      },
      "invalid_transfer_host_suffix",
    ],
    [
      {
        uploadRoots: ["/srv/uploads"],
        downloadRoots: ["/srv/downloads"],
        transferHostSuffixes: ["Disk.Yandex.Net"],
      },
      "invalid_transfer_host_suffix",
    ],
  ])("rejects unsafe Disk roots, limits and host suffixes", (disk, code) => {
    expectConfigCode(
      () => parseRuntimeConfig({ ...MINIMAL_CONFIG, disk }),
      code,
    );
  });

  test("deep-freezes runtime config and exposes only non-sensitive metadata", () => {
    const input = {
      ...MINIMAL_CONFIG,
      pagination: {
        linkOrigins: {
          amocrm: ["https://private-tenant-sentinel.amocrm.ru"],
        },
      },
      actions: {
        transport: {
          mode: "direct",
          baseUrl: "https://private-nango-origin-sentinel.example",
          secretKey: "direct-secret-sentinel",
        },
      },
      disk: {
        uploadRoots: ["/private/upload-root-sentinel"],
        downloadRoots: ["/private/download-root-sentinel"],
      },
    };
    const config = parseRuntimeConfig(input);
    const projection = projectPublicConfig(config);

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.cloudru)).toBe(true);
    expect(Object.isFrozen(config.pagination.linkOrigins)).toBe(true);
    expect(Object.isFrozen(config.pagination.linkOrigins.amocrm)).toBe(true);
    expect(Object.isFrozen(config.actions?.transport)).toBe(true);
    expect(Object.isFrozen(config.disk?.uploadRoots)).toBe(true);
    expect(Object.isFrozen(projection)).toBe(true);

    const serialized = JSON.stringify(projection);
    for (const sentinel of [
      "cloudru-secret-sentinel",
      "project-sentinel",
      "evoclaw-sentinel",
      "private-tenant-sentinel",
      "private-nango-origin-sentinel",
      "direct-secret-sentinel",
      "private/upload-root-sentinel",
      "private/download-root-sentinel",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(projection).toMatchObject({
      cloudru: { proxyScheme: "https" },
      actions: { enabled: true, direct: true, originScheme: "https" },
      disk: {
        enabled: true,
        uploadRootCount: 1,
        downloadRootCount: 1,
      },
    });
  });
});

describe("manifest config contract", () => {
  test("keeps exact schema parity and exactly two SecretInput surfaces", async () => {
    const manifestPath = fileURLToPath(
      new URL("../openclaw.plugin.json", import.meta.url),
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      configSchema: unknown;
      configContracts?: {
        secretInputs?: {
          paths?: Array<{ path: string; expected?: string }>;
        };
      };
      uiHints?: Record<string, { sensitive?: boolean }>;
    };

    expect(manifest.configSchema).toEqual(PLUGIN_CONFIG_SCHEMA);
    expect(manifest.configContracts?.secretInputs?.paths).toEqual([
      { path: "cloudru.apiKey", expected: "string" },
      { path: "actions.transport.secretKey", expected: "string" },
    ]);
    expect(
      Object.entries(manifest.uiHints ?? {})
        .filter(([, hint]) => hint.sensitive)
        .map(([path]) => path)
        .sort(),
    ).toEqual([
      "actions.transport.secretKey",
      "cloudru.apiKey",
    ]);
  });

  test("source SecretInput schema is a literal or strict canonical reference", () => {
    const cloudru = PLUGIN_CONFIG_SCHEMA.properties.cloudru;
    const apiKey = cloudru.properties.apiKey;

    expect(apiKey).toEqual({
      anyOf: [
        {
          type: "string",
          minLength: 1,
          maxLength: 4_096,
          pattern: "^[^\\r\\n]+$",
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["source", "provider", "id"],
          properties: {
            source: { type: "string", enum: ["env", "file", "exec"] },
            provider: {
              type: "string",
              minLength: 1,
              maxLength: 512,
              pattern: "^[^\\u0000-\\u001F\\u007F]+$",
            },
            id: {
              type: "string",
              minLength: 1,
              maxLength: 512,
              pattern: "^[^\\u0000-\\u001F\\u007F]+$",
            },
          },
        },
      ],
    });
  });
});
