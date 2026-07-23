import {
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

import { createApprovalController } from "./approval.js";
import {
  parseRuntimeConfig,
  type RuntimeConfig,
} from "./config.js";
import {
  createProxyClient,
  type ProxyClient,
} from "./proxy-client.js";
import { createPaginateTool } from "./tools/paginate.js";
import { createRequestTool } from "./tools/request.js";

const TOOL_NAMES = [
  "nango_proxy_request",
  "nango_proxy_paginate",
  "nango_action",
  "nango_disk_transfer",
] as const;

const TOOL_NAME_SET = new Set<string>(TOOL_NAMES);
const PLACEHOLDER_TOOL_NAMES = [
  "nango_action",
  "nango_disk_transfer",
] as const;
const PLACEHOLDER_TOOL_NAME_SET = new Set<string>(
  PLACEHOLDER_TOOL_NAMES,
);
const PLACEHOLDER_PARAMETERS = Type.Object(
  {},
  { additionalProperties: false },
);
const PLACEHOLDER_DETAILS = {
  ok: false,
  code: "not_implemented",
  outcome: "not_started",
} as const;
const PLACEHOLDER_TEXT = JSON.stringify(PLACEHOLDER_DETAILS);

function isEmptyRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "nango-tools",
  name: "Nango Tools",
  description: "Typed Nango provider tools for OpenClaw.",
  register(api) {
    const approvals = createApprovalController();
    let runtimeConfig: RuntimeConfig | undefined;
    let proxyClient: ProxyClient | undefined;
    try {
      runtimeConfig = parseRuntimeConfig(api.pluginConfig);
      proxyClient = createProxyClient(runtimeConfig, {
        fetch: (input, init) => globalThis.fetch(input, init),
      });
    } catch {
      // Registration remains deterministic. Real tool execution reports the
      // stable invalid_runtime_config result without network I/O.
    }

    api.registerTool(
      createRequestTool({
        approvals,
        ...(runtimeConfig === undefined ? {} : { config: runtimeConfig }),
        ...(proxyClient === undefined ? {} : { client: proxyClient }),
      }),
      { optional: true },
    );
    api.registerTool(
      createPaginateTool({
        approvals,
        ...(runtimeConfig === undefined ? {} : { config: runtimeConfig }),
        ...(proxyClient === undefined ? {} : { client: proxyClient }),
      }),
      { optional: true },
    );

    for (const toolName of PLACEHOLDER_TOOL_NAMES) {
      api.registerTool(
        {
          name: toolName,
          label: toolName,
          description: `${toolName} is not implemented yet.`,
          parameters: PLACEHOLDER_PARAMETERS,
          async execute(toolCallId, params) {
            if (!isEmptyRecord(params)) {
              const authorization = approvals.authorizeExecution(
                toolName,
                toolCallId,
                params,
              );
              if (!authorization.ok) {
                const details = {
                  ok: false,
                  code: authorization.code,
                  outcome: "not_started",
                } as const;
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify(details),
                    },
                  ],
                  details,
                };
              }
            }
            return {
              content: [{ type: "text" as const, text: PLACEHOLDER_TEXT }],
              details: { ...PLACEHOLDER_DETAILS },
            };
          },
        },
        { optional: true },
      );
    }

    api.on(
      "before_tool_call",
      (event, context) => {
        if (!TOOL_NAME_SET.has(event.toolName)) {
          return;
        }
        const toolCallId = event.toolCallId ?? context.toolCallId;
        const decision = approvals.beforeToolCall({
          toolName: event.toolName,
          params: event.params,
          ...(toolCallId ? { toolCallId } : {}),
        });
        if (
          decision?.block &&
          isEmptyRecord(event.params) &&
          PLACEHOLDER_TOOL_NAME_SET.has(event.toolName)
        ) {
          return {
            block: true,
            blockReason: "Nango tools are not implemented",
          };
        }
        return decision;
      },
      { priority: 100, timeoutMs: 1_000 },
    );
  },
});

export default plugin;
