import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test, vi } from "vitest";

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

function registerScaffold() {
  const tools: Array<{
    tool: RegisteredTool;
    options: { optional?: boolean } | undefined;
  }> = [];
  let beforeToolCall: BeforeToolCallHook | undefined;
  let beforeToolCallOptions: HookOptions | undefined;

  plugin.register?.({
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

describe("temporary runtime scaffold", () => {
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
        properties: {},
      });
    }
  });

  test("synchronously blocks every scaffold tool and leaves other tools alone", () => {
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
      expect(decision).toEqual({
        block: true,
        blockReason: "Nango tools are not implemented",
      });
    }
    expect(
      beforeToolCall!(
        { toolName: "unrelated_tool", params: {} },
        { toolName: "unrelated_tool" },
      ),
    ).toBeUndefined();
  });

  test("returns a stable not-started result from every placeholder without I/O", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network I/O"));
    const { tools } = registerScaffold();
    const expected = {
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

    for (const { tool } of tools) {
      await expect(tool.execute("test-call", {})).resolves.toEqual(expected);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
