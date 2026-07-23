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
import { createActionTool } from "./tools/action.js";
import { createDiskTransferExecutor } from "./tools/disk-transfer.js";
import { createPaginateTool } from "./tools/paginate.js";
import {
  createRequestTool,
  runtimeConfigFailure,
  toolExecutionResult,
} from "./tools/request.js";

const TOOL_NAMES = [
  "nango_proxy_request",
  "nango_proxy_paginate",
  "nango_action",
  "nango_disk_transfer",
] as const;

const TOOL_NAME_SET = new Set<string>(TOOL_NAMES);
const DISK_DIRECTION = Type.Union([
  Type.Literal("upload"),
  Type.Literal("download"),
]);
const DISK_TRANSFER_PARAMETERS = Type.Object(
  {
    providerConfigKey: Type.Literal("yandex-disk"),
    direction: Type.Optional(DISK_DIRECTION),
    operation: Type.Optional(DISK_DIRECTION),
    localPath: Type.String({ minLength: 1, maxLength: 4_096 }),
    remotePath: Type.String({ minLength: 1, maxLength: 4_096 }),
    overwrite: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 3_600_000 }),
    ),
  },
  { additionalProperties: false },
);

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
    api.registerTool(
      createActionTool({
        approvals,
        ...(runtimeConfig === undefined ? {} : { config: runtimeConfig }),
        fetch: (input, init) => globalThis.fetch(input, init),
      }),
      { optional: true },
    );

    const diskExecutor =
      runtimeConfig !== undefined && proxyClient !== undefined
        ? createDiskTransferExecutor(runtimeConfig, {
            approvalVerifier: approvals,
            proxyClient,
          })
        : undefined;
    api.registerTool(
      {
        name: "nango_disk_transfer",
        label: "Nango Yandex Disk transfer",
        description:
          "Upload or download one bounded Yandex Disk file through approved roots.",
        parameters: DISK_TRANSFER_PARAMETERS,
        async execute(toolCallId, params) {
          if (diskExecutor === undefined) {
            return toolExecutionResult(runtimeConfigFailure());
          }
          return toolExecutionResult(
            await diskExecutor.execute(toolCallId, params),
          );
        },
      },
      { optional: true },
    );

    api.on(
      "before_tool_call",
      (event, context) => {
        if (!TOOL_NAME_SET.has(event.toolName)) {
          return;
        }
        const toolCallId = event.toolCallId ?? context.toolCallId;
        return approvals.beforeToolCall({
          toolName: event.toolName,
          params: event.params,
          ...(toolCallId ? { toolCallId } : {}),
        });
      },
      { priority: 100, timeoutMs: 1_000 },
    );
  },
});

export default plugin;
