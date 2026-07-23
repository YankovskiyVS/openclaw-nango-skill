import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import plugin from "../src/index.js";

const TOOL_NAMES = [
  "nango_proxy_request",
  "nango_proxy_paginate",
  "nango_action",
  "nango_disk_transfer",
] as const;

type RegisteredTool = {
  name: string;
  parameters: {
    type?: string;
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
  };
  execute: (...args: unknown[]) => unknown;
};

type BeforeToolCallHook = (
  event: { toolName: string; params: Record<string, unknown> },
  context: { toolName: string },
) => unknown;

type HookOptions = {
  priority?: number;
  timeoutMs?: number;
};

function registerScaffold(pluginConfig?: Record<string, unknown>) {
  const tools: Array<{
    tool: RegisteredTool;
    options: { optional?: boolean } | undefined;
  }> = [];
  let beforeToolCall: BeforeToolCallHook | undefined;
  let beforeToolCallOptions: HookOptions | undefined;

  plugin.register?.({
    ...(pluginConfig === undefined ? {} : { pluginConfig }),
    registerTool(tool: RegisteredTool, options?: { optional?: boolean }) {
      tools.push({ tool, options });
    },
    on(
      hookName: string,
      handler: BeforeToolCallHook,
      options?: HookOptions,
    ) {
      if (hookName === "before_tool_call") {
        beforeToolCall = handler;
        beforeToolCallOptions = options;
      }
    },
  } as never);

  return { tools, beforeToolCall, beforeToolCallOptions };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runtime registration", () => {
  test("uses the focused plugin entry and TypeBox imports", async () => {
    const sourcePath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const source = await readFile(sourcePath, "utf8");

    expect(source).toContain(
      'from "openclaw/plugin-sdk/plugin-entry"',
    );
    expect(source).toContain('from "typebox"');
    expect(source).not.toContain("openclaw/plugin-sdk/core");
    expect(source).not.toContain(".codex-plugin");
  });

  test("registers exactly the four manifest tools as strict optional tools", () => {
    const { tools } = registerScaffold();

    expect(tools.map(({ tool }) => tool.name)).toEqual(TOOL_NAMES);
    for (const { tool, options } of tools) {
      expect(options).toEqual({ optional: true });
      expect(tool.parameters).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
    expect(tools[0]?.tool.parameters.properties).not.toEqual({});
    expect(tools[1]?.tool.parameters.properties).not.toEqual({});
    expect(tools[2]?.tool.parameters.properties).toEqual({});
    expect(tools[3]?.tool.parameters.properties).toEqual({});
  });

  test("keeps the synchronous approval policy and leaves other tools alone", () => {
    const { beforeToolCall, beforeToolCallOptions } = registerScaffold();

    expect(beforeToolCall).toBeTypeOf("function");
    expect(beforeToolCallOptions).toEqual({
      priority: 100,
      timeoutMs: 1_000,
    });
    for (const toolName of TOOL_NAMES) {
      const decision = beforeToolCall!(
        { toolName, params: {} },
        { toolName },
      );
      expect(decision).not.toBeInstanceOf(Promise);
      expect(decision).toMatchObject({ block: true });
    }
    expect(
      beforeToolCall!(
        { toolName: "unrelated_tool", params: {} },
        { toolName: "unrelated_tool" },
      ),
    ).toBeUndefined();
  });

  test("fails real tools closed on missing config and keeps only action/disk placeholders", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network I/O"));
    const { tools } = registerScaffold();
    const placeholder = {
      content: [
        {
          type: "text",
          text: '{"ok":false,"code":"not_implemented","outcome":"not_started"}',
        },
      ],
      details: {
        ok: false,
        code: "not_implemented",
        outcome: "not_started",
      },
    };

    await expect(
      tools[0]?.tool.execute("request-call", {
        providerConfigKey: "amocrm-crm",
        method: "GET",
        path: "api/v4/leads",
      }),
    ).resolves.toMatchObject({
      details: {
        ok: false,
        error: { code: "invalid_runtime_config" },
        outcome: "not_started",
      },
    });
    await expect(
      tools[1]?.tool.execute("paginate-call", {
        providerConfigKey: "amocrm-crm",
        method: "GET",
        path: "api/v4/leads",
        mode: "single",
        maxPages: 1,
        maxItems: 1,
      }),
    ).resolves.toMatchObject({
      details: {
        ok: false,
        error: { code: "invalid_runtime_config" },
        outcome: "not_started",
      },
    });
    await expect(
      tools[2]?.tool.execute("action-call", {}),
    ).resolves.toEqual(placeholder);
    await expect(
      tools[3]?.tool.execute("disk-call", {}),
    ).resolves.toEqual(placeholder);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("wires one parsed config and the proxy client into real execution", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { tools } = registerScaffold({
      cloudru: {
        proxyBaseUrl: "https://proxy.example.test",
        projectId: "project",
        evoClawId: "evoclaw",
        apiKey: "runtime-secret-sentinel",
      },
    });

    const result = await tools[0]?.tool.execute("wired-request", {
      providerConfigKey: "amocrm-crm",
      method: "GET",
      path: "api/v4/leads",
    });

    expect(result).toMatchObject({
      details: {
        ok: true,
        response: { body: { accepted: true } },
      },
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Api-Key runtime-secret-sentinel",
    );
    expect(JSON.stringify(result)).not.toContain(
      "runtime-secret-sentinel",
    );
  });
});
