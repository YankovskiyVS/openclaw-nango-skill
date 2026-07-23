import { describe, expect, test, vi } from "vitest";

import {
  APPROVAL_PROOF_PARAM,
  createApprovalController,
} from "../src/approval.js";
import { parseRuntimeConfig } from "../src/config.js";
import type {
  ProxyClient,
  ProxyRequest,
} from "../src/proxy-client.js";
import {
  createFailureResult,
  createSuccessResult,
  type JsonValue,
  type ToolResult,
} from "../src/result.js";
import {
  PAGINATE_PARAMETERS,
  createPaginateTool,
} from "../src/tools/paginate.js";

function runtimeConfig(
  pagination: Record<string, unknown> = {},
  transport: Record<string, unknown> = {},
) {
  return parseRuntimeConfig({
    cloudru: {
      proxyBaseUrl: "https://proxy.example.test",
      projectId: "project",
      evoClawId: "evoclaw",
      apiKey: "cloudru-secret-sentinel",
    },
    transport,
    pagination: {
      maxPages: 5,
      maxItems: 20,
      linkOrigins: {
        "amocrm-crm": ["https://tenant.amocrm.ru"],
        "bitrix24-crm": ["https://tenant.bitrix24.ru"],
      },
      ...pagination,
    },
  });
}

function success(
  request: ProxyRequest,
  body: JsonValue,
  headers: Record<string, string> = {},
): ToolResult {
  return createSuccessResult(
    {
      providerConfigKey: request.providerConfigKey,
      method: request.method,
      path: request.path,
    },
    {
      status: 200,
      contentType: "application/json",
      headers,
      body,
    },
  );
}

function sequenceClient(
  handler: (
    request: ProxyRequest,
    index: number,
  ) => ToolResult | Promise<ToolResult>,
): { client: ProxyClient; requests: ProxyRequest[] } {
  const requests: ProxyRequest[] = [];
  return {
    requests,
    client: {
      async request(request) {
        requests.push(request);
        return handler(request, requests.length - 1);
      },
    },
  };
}

function paginateParams(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    providerConfigKey: "amocrm-crm",
    method: "GET",
    path: "api/v4/leads",
    mode: "link",
    maxPages: 5,
    maxItems: 20,
    ...overrides,
  };
}

describe("nango_proxy_paginate public contract", () => {
  test("publishes strict required controls without a hidden proof", () => {
    expect(PAGINATE_PARAMETERS).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(PAGINATE_PARAMETERS.required).toEqual([
      "providerConfigKey",
      "method",
      "path",
      "mode",
      "maxPages",
      "maxItems",
    ]);
    expect(
      PAGINATE_PARAMETERS.properties.mode.anyOf.map(
        (item: { const: string }) => item.const,
      ),
    ).toEqual(["link", "offset", "body-offset", "single"]);
    expect(JSON.stringify(PAGINATE_PARAMETERS)).not.toContain(
      APPROVAL_PROOF_PARAM,
    );
  });

  test("follows only an exact trusted absolute rel=next via the proxy", async () => {
    const { client, requests } = sequenceClient((request, index) =>
      success(
        request,
        index === 0
          ? { _embedded: { leads: [{ id: 1 }] } }
          : { _embedded: { leads: [{ id: 2 }] } },
        index === 0
          ? {
              link:
                '<https://tenant.amocrm.ru/api/v4/leads?tag=a&tag=b&page=2>; rel="next", ' +
                '<https://tenant.amocrm.ru/api/v4/leads?page=9>; rel="last"',
            }
          : {},
      ),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute("amo-link", paginateParams());

    expect(result.details).toMatchObject({
      ok: true,
      pagination: {
        pageCount: 2,
        itemCount: 2,
        termination: "provider_end",
      },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      path: "api/v4/leads",
      query: [
        { name: "tag", value: "a" },
        { name: "tag", value: "b" },
        { name: "page", value: "2" },
      ],
      operationKind: "read",
    });
  });

  test("resolves relative next links against a code/config trusted origin", async () => {
    const { client, requests } = sequenceClient((request, index) =>
      success(
        request,
        { _embedded: { leads: [{ id: index + 1 }] } },
        index === 0
          ? { link: '<?page=2>; rel="next"' }
          : {},
      ),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute("relative", paginateParams());

    expect(result.details).toMatchObject({
      ok: true,
      pagination: { termination: "provider_end", pageCount: 2 },
    });
    expect(requests[1]?.path).toBe("api/v4/leads");
    expect(requests[1]?.query).toEqual([
      { name: "page", value: "2" },
    ]);
  });

  test("rejects a relative link when more than one origin is trusted", async () => {
    const { client, requests } = sequenceClient((request) =>
      success(
        request,
        { _embedded: { leads: [] } },
        { link: "<?page=2>; rel=next" },
      ),
    );
    const tool = createPaginateTool({
      config: runtimeConfig({
        linkOrigins: {
          "amocrm-crm": [
            "https://tenant.amocrm.ru",
            "https://second.amocrm.ru",
          ],
        },
      }),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute(
      "ambiguous-relative-origin",
      paginateParams(),
    );

    expect(result.details).toMatchObject({
      ok: false,
      error: { code: "ambiguous_pagination_link" },
    });
    expect(requests).toHaveLength(1);
  });

  test("does not let amo pagination switch the approved collection", async () => {
    const { client, requests } = sequenceClient((request) =>
      success(
        request,
        { _embedded: { leads: [] } },
        { link: "</api/v4/users?page=2>; rel=next" },
      ),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute(
      "cross-collection",
      paginateParams(),
    );

    expect(result.details).toMatchObject({
      ok: false,
      error: { code: "unsafe_pagination_link" },
    });
    expect(requests).toHaveLength(1);
  });

  test("rejects a malformed known amo collection body", async () => {
    const { client, requests } = sequenceClient((request) =>
      success(request, { _embedded: { users: [] } }),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute(
      "malformed-amo",
      paginateParams(),
    );

    expect(result.details).toMatchObject({
      ok: false,
      error: { code: "invalid_pagination_response" },
    });
    expect(requests).toHaveLength(1);
  });

  test("accepts an exact configured Bitrix link origin", async () => {
    const { client, requests } = sequenceClient((request, index) =>
      success(
        request,
        index === 0
          ? { result: [{ ID: "1" }] }
          : { result: [{ ID: "2" }] },
        index === 0
          ? {
              link:
                '<https://tenant.bitrix24.ru/crm.deal.list?page=2>; rel=next',
            }
          : {},
      ),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute(
      "bitrix-link",
      paginateParams({
        providerConfigKey: "bitrix24-crm",
        path: "crm.deal.list",
      }),
    );

    expect(result.details).toMatchObject({
      ok: true,
      pagination: { pageCount: 2, termination: "provider_end" },
    });
    expect(requests[1]?.path).toBe("crm.deal.list");
  });

  test("rejects a Bitrix origin lookalike", async () => {
    const { client, requests } = sequenceClient((request) =>
      success(request, { result: [] }, {
        link:
          "<https://tenant.bitrix24.ru.attacker.test/crm.deal.list?page=2>; rel=next",
      }),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute(
      "bitrix-lookalike",
      paginateParams({
        providerConfigKey: "bitrix24-crm",
        path: "crm.deal.list",
      }),
    );

    expect(result.details).toMatchObject({
      ok: false,
      error: { code: "unsafe_pagination_link" },
    });
    expect(requests).toHaveLength(1);
  });

  test.each([
    "https://tenant.amocrm.ru.attacker.test/api/v4/leads?page=2",
    "http://tenant.amocrm.ru/api/v4/leads?page=2",
    "https://user@tenant.amocrm.ru/api/v4/leads?page=2",
    "https://tenant.amocrm.ru/api/v4/leads?page=2#fragment",
  ])("rejects an unsafe next target without a second request: %s", async (url) => {
    const { client, requests } = sequenceClient((request) =>
      success(request, { _embedded: { leads: [] } }, {
        link: `<${url}>; rel="next"`,
      }),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute("unsafe-link", paginateParams());

    expect(result.details).toMatchObject({
      ok: false,
      error: { code: "unsafe_pagination_link" },
      outcome: "confirmed_failed",
    });
    expect(requests).toHaveLength(1);
  });

  test("treats quoted commas/semicolons safely and rejects ambiguous next links", async () => {
    const { client, requests } = sequenceClient((request) =>
      success(request, { _embedded: { leads: [] } }, {
        link:
          '<https://tenant.amocrm.ru/api/v4/leads?page=2>; title="a,b;c"; rel="next", ' +
          '<https://tenant.amocrm.ru/api/v4/leads?page=3>; rel=next',
      }),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute("ambiguous", paginateParams());

    expect(result.details).toMatchObject({
      ok: false,
      error: { code: "ambiguous_pagination_link" },
    });
    expect(requests).toHaveLength(1);
  });

  test("detects a repeated next target without refetching it", async () => {
    const { client, requests } = sequenceClient((request) =>
      success(request, { _embedded: { leads: [{ id: 1 }] } }, {
        link: "</api/v4/leads>; rel=next",
      }),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute("loop", paginateParams());

    expect(result.details).toMatchObject({
      ok: true,
      pagination: {
        pageCount: 1,
        itemCount: 1,
        termination: "loop_detected",
      },
    });
    expect(requests).toHaveLength(1);
  });

  test("detects a repeated page fingerprint while cursors advance", async () => {
    const { client, requests } = sequenceClient((request, index) =>
      success(
        request,
        { _embedded: { leads: [{ id: 1 }] } },
        {
          link:
            `</api/v4/leads?page=${index + 2}>; rel=next`,
        },
      ),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute(
      "page-fingerprint-loop",
      paginateParams(),
    );

    expect(result.details).toMatchObject({
      ok: true,
      pagination: {
        pageCount: 1,
        itemCount: 1,
        termination: "loop_detected",
      },
    });
    expect(requests).toHaveLength(2);
  });

  test("returns metadata-only pages and caps aggregate output bytes", async () => {
    const oversizedItem = "x".repeat(70 * 1_024);
    const { client } = sequenceClient((request) =>
      success(request, {
        _embedded: { leads: [{ value: oversizedItem }] },
      }),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(
        {},
        { maxResponseBytes: 64 * 1_024 },
      ),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute(
      "aggregate-cap",
      paginateParams(),
    );

    expect(result.details).toMatchObject({
      ok: true,
      pages: [
        {
          response: {
            status: 200,
            contentType: "application/json",
            headers: {},
          },
        },
      ],
      items: [],
      pagination: {
        pageCount: 1,
        itemCount: 0,
        termination: "max_bytes",
      },
    });
    expect(
      (result.details as { pages: Array<{ response: unknown }> })
        .pages[0]?.response,
    ).not.toHaveProperty("body");
    expect(JSON.stringify(result)).not.toContain(oversizedItem);
  });

  test("rejects requested caps above config before proxy I/O", async () => {
    const { client, requests } = sequenceClient((request) =>
      success(request, { _embedded: { leads: [] } }),
    );
    const tool = createPaginateTool({
      config: runtimeConfig({ maxPages: 2, maxItems: 3 }),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute(
      "caps",
      paginateParams({ maxPages: 3, maxItems: 4 }),
    );

    expect(result.details).toMatchObject({
      ok: false,
      error: { code: "pagination_limit_exceeded" },
      outcome: "not_started",
    });
    expect(requests).toHaveLength(0);
  });

  test("reports max_pages and max_items without claiming provider completion", async () => {
    const pagesClient = sequenceClient((request, index) =>
      success(request, { _embedded: { leads: [{ id: index }] } }, {
        link: `</api/v4/leads?page=${index + 2}>; rel=next`,
      }),
    );
    const pagesTool = createPaginateTool({
      config: runtimeConfig(),
      client: pagesClient.client,
      approvals: createApprovalController(),
    });
    const pages = await pagesTool.execute(
      "max-pages",
      paginateParams({ maxPages: 2 }),
    );

    const itemsClient = sequenceClient((request) =>
      success(request, {
        _embedded: {
          leads: [{ id: 1 }, { id: 2 }, { id: 3 }],
        },
      }, {
        link: "</api/v4/leads?page=2>; rel=next",
      }),
    );
    const itemsTool = createPaginateTool({
      config: runtimeConfig(),
      client: itemsClient.client,
      approvals: createApprovalController(),
    });
    const items = await itemsTool.execute(
      "max-items",
      paginateParams({ maxItems: 2 }),
    );

    expect(pages.details).toMatchObject({
      ok: true,
      pagination: { pageCount: 2, termination: "max_pages" },
    });
    expect(items.details).toMatchObject({
      ok: true,
      items: [{ id: 1 }, { id: 2 }],
      pagination: { itemCount: 2, termination: "max_items" },
    });
  });

  test.each([
    ["GET", undefined],
    ["POST", { filter: { STAGE_ID: "NEW" }, start: 0 }],
  ])("paginates Bitrix %s list responses", async (method, jsonBody) => {
    const { client, requests } = sequenceClient((request, index) =>
      success(
        request,
        index === 0
          ? { result: [{ ID: "1" }], next: 50, total: 2 }
          : { result: [{ ID: "2" }], total: 2 },
      ),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute(
      `bitrix-${method}`,
      paginateParams({
        providerConfigKey: "bitrix24-crm",
        method,
        path: "crm.deal.list",
        mode: "offset",
        ...(jsonBody === undefined ? {} : { jsonBody }),
      }),
    );

    expect(result.details).toMatchObject({
      ok: true,
      items: [{ ID: "1" }, { ID: "2" }],
      pagination: { termination: "provider_end" },
    });
    expect(requests[1]?.operationKind).toBe("read");
    if (method === "GET") {
      expect(requests[1]?.query).toContainEqual({
        name: "start",
        value: "50",
      });
    } else {
      expect(
        JSON.parse(new TextDecoder().decode(requests[1]?.body?.bytes)),
      ).toMatchObject({
        filter: { STAGE_ID: "NEW" },
        start: 50,
      });
      expect(jsonBody).toEqual({
        filter: { STAGE_ID: "NEW" },
        start: 0,
      });
    }
  });

  test("supports Bitrix tasks.task.list result.tasks", async () => {
    const { client, requests } = sequenceClient((request, index) =>
      success(
        request,
        index === 0
          ? {
              result: { tasks: [{ id: "1" }] },
              next: 50,
            }
          : { result: { tasks: [{ id: "2" }] } },
      ),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute(
      "bitrix-tasks",
      paginateParams({
        providerConfigKey: "bitrix24-tasks",
        method: "POST",
        path: "tasks.task.list",
        mode: "offset",
        jsonBody: { filter: { RESPONSIBLE_ID: 1 } },
      }),
    );

    expect(result.details).toMatchObject({
      ok: true,
      items: [{ id: "1" }, { id: "2" }],
      pagination: { termination: "provider_end" },
    });
    expect(
      JSON.parse(new TextDecoder().decode(requests[1]?.body?.bytes)),
    ).toMatchObject({ start: 50 });
  });

  test.each([
    ["bitrix24-im", "im.recent.get"],
    ["bitrix24-user", "department.get"],
    ["bitrix24-calendar", "calendar.section.get"],
    ["bitrix24-telephony", "telephony.externalLine.get"],
  ])(
    "supports exact Bitrix offset read %s/%s",
    async (providerConfigKey, path) => {
      const { client, requests } = sequenceClient((request) =>
        success(request, { result: [{ ID: "1" }] }),
      );
      const tool = createPaginateTool({
        config: runtimeConfig(),
        client,
        approvals: createApprovalController(),
      });

      const result = await tool.execute(
        `bitrix-exact-${path}`,
        paginateParams({
          providerConfigKey,
          method: "GET",
          path,
          mode: "offset",
        }),
      );

      expect(result.details).toMatchObject({
        ok: true,
        items: [{ ID: "1" }],
        pagination: { termination: "provider_end" },
      });
      expect(requests).toHaveLength(1);
    },
  );

  test("keeps the documented Bitrix user.current offset call safe and single-page", async () => {
    const { client, requests } = sequenceClient((request) =>
      success(request, {
        result: { ID: "1", NAME: "Ada" },
      }),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute(
      "bitrix-current",
      paginateParams({
        providerConfigKey: "bitrix24-user",
        method: "GET",
        path: "user.current",
        mode: "offset",
      }),
    );

    expect(result.details).toMatchObject({
      ok: true,
      items: [{ ID: "1", NAME: "Ada" }],
      pagination: {
        pageCount: 1,
        termination: "provider_end",
      },
    });
    expect(requests).toHaveLength(1);
  });

  test("paginates Yandex Disk _embedded offsets", async () => {
    const { client, requests } = sequenceClient((request, index) =>
      success(
        request,
        index === 0
          ? {
              _embedded: {
                items: [{ name: "a" }],
                offset: 0,
                limit: 1,
                total: 2,
              },
            }
          : {
              _embedded: {
                items: [{ name: "b" }],
                offset: 1,
                limit: 1,
                total: 2,
              },
            },
      ),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute(
      "disk",
      paginateParams({
        providerConfigKey: "yandex-disk",
        path: "v1/disk/resources",
        mode: "offset",
        query: [{ name: "path", value: "/" }],
      }),
    );

    expect(result.details).toMatchObject({
      ok: true,
      items: [{ name: "a" }, { name: "b" }],
      pagination: { termination: "provider_end" },
    });
    expect(requests[1]?.query).toEqual([
      { name: "path", value: "/" },
      { name: "offset", value: "1" },
    ]);
  });

  test("paginates Yandex Market campaigns by nextPageToken", async () => {
    const { client, requests } = sequenceClient((request, index) =>
      success(
        request,
        index === 0
          ? {
              result: {
                campaigns: [{ id: 1 }],
              },
              paging: { nextPageToken: "next/token" },
            }
          : {
              result: {
                campaigns: [{ id: 2 }],
              },
              paging: {},
            },
      ),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute(
      "market",
      paginateParams({
        providerConfigKey: "yandex-market",
        path: "v2/campaigns",
        mode: "offset",
        query: [{ name: "limit", value: "100" }],
      }),
    );

    expect(result.details).toMatchObject({
      ok: true,
      items: [{ id: 1 }, { id: 2 }],
      pagination: { termination: "provider_end" },
    });
    expect(requests[1]?.query).toEqual([
      { name: "limit", value: "100" },
      { name: "pageToken", value: "next/token" },
    ]);
  });

  test("immutably advances exact Yandex Direct get Page.Offset", async () => {
    const body = {
      method: "get",
      params: {
        SelectionCriteria: {},
        FieldNames: ["Id"],
        Page: { Offset: 0, Limit: 1 },
      },
    };
    const { client, requests } = sequenceClient((request, index) =>
      success(
        request,
        index === 0
          ? { result: { Campaigns: [{ Id: 1 }], LimitedBy: 2 } }
          : { result: { Campaigns: [{ Id: 2 }] } },
      ),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute(
      "direct",
      paginateParams({
        providerConfigKey: "yandex-direct",
        method: "POST",
        path: "json/v5/campaigns",
        mode: "body-offset",
        jsonBody: body,
      }),
    );

    expect(result.details).toMatchObject({
      ok: true,
      items: [{ Id: 1 }, { Id: 2 }],
      pagination: { termination: "provider_end" },
    });
    expect(
      JSON.parse(new TextDecoder().decode(requests[1]?.body?.bytes)),
    ).toMatchObject({ params: { Page: { Offset: 1, Limit: 1 } } });
    expect(body.params.Page.Offset).toBe(0);
  });

  test("runs single mode exactly once and propagates transport failure", async () => {
    const calls = sequenceClient((request) =>
      success(request, { _embedded: { leads: [{ id: 1 }] } }),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client: calls.client,
      approvals: createApprovalController(),
    });
    const single = await tool.execute(
      "single",
      paginateParams({ mode: "single" }),
    );

    expect(single.details).toMatchObject({
      ok: true,
      pagination: { pageCount: 1, termination: "provider_end" },
    });
    expect(calls.requests).toHaveLength(1);

    const failedCalls = sequenceClient((request) =>
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
          retryable: true,
          outcome: "confirmed_failed",
        },
      ),
    );
    const failedTool = createPaginateTool({
      config: runtimeConfig(),
      client: failedCalls.client,
      approvals: createApprovalController(),
    });
    const failed = await failedTool.execute(
      "failed",
      paginateParams({ mode: "single" }),
    );
    expect(failed.details).toMatchObject({
      ok: false,
      error: { code: "network_error" },
    });
  });

  test("returns a text CalDAV single page without inventing item paths", async () => {
    const calls = sequenceClient((request) =>
      success(request, "<multistatus />"),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client: calls.client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute(
      "caldav-single",
      paginateParams({
        providerConfigKey: "yandex-calendar",
        method: "PROPFIND",
        path: "calendars/",
        textBody: "<propfind />",
        contentType: "application/xml",
        mode: "single",
        maxPages: 1,
      }),
    );

    expect(result.details).toMatchObject({
      ok: true,
      items: ["<multistatus />"],
      pagination: {
        pageCount: 1,
        termination: "provider_end",
      },
    });
    expect(calls.requests).toHaveLength(1);
  });

  test.each([
    paginateParams({
      providerConfigKey: "yandex-delivery",
      method: "POST",
      path: "b2b/platform/offers/create",
      mode: "single",
    }),
    paginateParams({
      providerConfigKey: "yandex-direct",
      method: "POST",
      path: "json/v5/campaigns",
      mode: "body-offset",
      jsonBody: { method: "add", params: { Campaigns: [] } },
    }),
    paginateParams({
      providerConfigKey: "bitrix24-crm",
      method: "POST",
      path: "crm.deal.update",
      mode: "offset",
      jsonBody: { id: 1 },
    }),
  ])("blocks mutation pagination before any request", async (params) => {
    const { client, requests } = sequenceClient((request) =>
      success(request, {}),
    );
    const tool = createPaginateTool({
      config: runtimeConfig(),
      client,
      approvals: createApprovalController(),
    });

    const result = await tool.execute("blocked-write", params);

    expect(result.details).toMatchObject({
      ok: false,
      outcome: "not_started",
    });
    expect(requests).toHaveLength(0);
  });
});
