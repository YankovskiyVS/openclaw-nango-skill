import { afterEach, describe, expect, test } from "vitest";

import {
  resetGlobalHookRunner,
  initializeGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-runtime";
import { wrapToolWithBeforeToolCallHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import { Type } from "typebox";

import {
  APPROVAL_PROOF_PARAM,
  APPROVAL_TIMEOUT_MS,
  canonicalizeBusinessParams,
  classifyNangoToolCall,
  createApprovalController,
  type ApprovalController,
} from "../src/approval.js";
import plugin from "../src/index.js";

const FIXED_KEY = new Uint8Array(32).fill(7);

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

function mutationDecision(
  controller: ApprovalController,
  params: Record<string, unknown> = requestParams({
    method: "PATCH",
    jsonBody: { name: "private-payload-sentinel" },
    headers: { "X-Provider-Trace": "header-secret-sentinel" },
  }),
  toolCallId = "call-1",
) {
  const decision = controller.beforeToolCall({
    toolName: "nango_proxy_request",
    toolCallId,
    params,
  });
  expect(decision).toBeDefined();
  expect(decision).toHaveProperty("requireApproval");
  return decision!;
}

function approveMutation(
  controller: ApprovalController,
  params?: Record<string, unknown>,
  toolCallId = "call-1",
) {
  const decision = mutationDecision(controller, params, toolCallId);
  decision.requireApproval?.onResolution?.("allow-once");
  expect(decision.params).toBeDefined();
  return decision.params!;
}

function registerPluginRuntime() {
  const tools: Array<{
    name: string;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
  }> = [];
  let beforeToolCall:
    | ((
        event: {
          toolName: string;
          toolCallId?: string;
          params: Record<string, unknown>;
        },
        context: { toolName: string; toolCallId?: string },
      ) => ReturnType<ApprovalController["beforeToolCall"]>)
    | undefined;

  plugin.register?.({
    registerTool(tool: (typeof tools)[number]) {
      tools.push(tool);
    },
    on(hookName: string, handler: typeof beforeToolCall) {
      if (hookName === "before_tool_call") {
        beforeToolCall = handler;
      }
    },
  } as never);

  return { tools, beforeToolCall };
}

afterEach(() => {
  resetGlobalHookRunner();
});

describe("pure semantic classification", () => {
  test.each(["GET", "HEAD", "OPTIONS", "PROPFIND", "REPORT"])(
    "classifies ordinary %s requests as reads",
    (method) => {
      expect(
        classifyNangoToolCall(
          "nango_proxy_request",
          requestParams({ method }),
        ),
      ).toMatchObject({
        status: "allowed",
        operationKind: "read",
        providerConfigKey: "amocrm-crm",
      });
    },
  );

  test.each(["POST", "PUT", "PATCH", "DELETE"])(
    "classifies ordinary %s requests as mutations",
    (method) => {
      expect(
        classifyNangoToolCall(
          "nango_proxy_request",
          requestParams({ method }),
        ),
      ).toMatchObject({
        status: "allowed",
        operationKind: "mutation",
      });
    },
  );

  test("lets Bitrix24 method semantics override a read-looking HTTP verb", () => {
    expect(
      classifyNangoToolCall(
        "nango_proxy_request",
        requestParams({
          providerConfigKey: "bitrix24-crm",
          method: "GET",
          path: "crm.deal.list",
        }),
      ),
    ).toMatchObject({ status: "allowed", operationKind: "read" });
    expect(
      classifyNangoToolCall(
        "nango_proxy_request",
        requestParams({
          providerConfigKey: "bitrix24-crm",
          method: "POST",
          path: "crm.deal.list",
          jsonBody: { filter: { STAGE_ID: "NEW" } },
        }),
      ),
    ).toMatchObject({ status: "allowed", operationKind: "read" });

    for (const path of [
      "crm.deal.update",
      "crm.lead.delete.json",
      "im.message.add",
      "crm.deal.futureCustomMethod",
    ]) {
      expect(
        classifyNangoToolCall(
          "nango_proxy_request",
          requestParams({
            providerConfigKey: "bitrix24-crm",
            method: "GET",
            path,
          }),
        ),
      ).toMatchObject({
        status: "allowed",
        operationKind: "mutation",
      });
    }
  });

  test("requires approval for mixed or unparseable Bitrix24 batches", () => {
    const allReads = requestParams({
      providerConfigKey: "bitrix24-crm",
      method: "GET",
      path: "batch",
      query: [
        { name: "cmd[lead]", value: "crm.lead.list?select[]=ID" },
        { name: "cmd[user]", value: "user.current" },
      ],
    });
    const mixed = requestParams({
      ...allReads,
      query: [
        { name: "cmd[lead]", value: "crm.lead.list" },
        { name: "cmd[deal]", value: "crm.deal.update?id=7" },
      ],
    });
    const unparseable = requestParams({
      ...allReads,
      query: [{ name: "halt", value: "0" }],
    });

    expect(
      classifyNangoToolCall("nango_proxy_request", allReads),
    ).toMatchObject({ status: "allowed", operationKind: "read" });
    expect(
      classifyNangoToolCall("nango_proxy_request", mixed),
    ).toMatchObject({ status: "allowed", operationKind: "mutation" });
    expect(
      classifyNangoToolCall("nango_proxy_request", unparseable),
    ).toMatchObject({ status: "allowed", operationKind: "mutation" });
  });

  test("blocks direct, passthrough and top-level method override attempts", () => {
    for (const params of [
      requestParams({
        headers: { "X-HTTP-Method-Override": "DELETE" },
      }),
      requestParams({
        headers: { "Nango-Proxy-X-HTTP-Method-Override": "DELETE" },
      }),
      requestParams({ operationKind: "read" }),
      requestParams({ methodOverride: "GET" }),
    ]) {
      expect(
        classifyNangoToolCall("nango_proxy_request", params),
      ).toMatchObject({ status: "blocked" });
    }
  });

  test("uses exact Yandex Direct JSON-RPC semantics", () => {
    const direct = requestParams({
      providerConfigKey: "yandex-direct",
      method: "POST",
      path: "json/v5/campaigns",
      jsonBody: {
        method: "get",
        params: { SelectionCriteria: {}, FieldNames: ["Id"] },
      },
    });

    expect(
      classifyNangoToolCall("nango_proxy_request", direct),
    ).toMatchObject({ status: "allowed", operationKind: "read" });
    expect(
      classifyNangoToolCall("nango_proxy_request", {
        ...direct,
        jsonBody: { method: "update", params: { Campaigns: [] } },
      }),
    ).toMatchObject({ status: "allowed", operationKind: "mutation" });
    expect(
      classifyNangoToolCall("nango_proxy_request", {
        ...direct,
        jsonBody: { method: "Get", params: {} },
      }),
    ).toMatchObject({ status: "allowed", operationKind: "mutation" });
    expect(
      classifyNangoToolCall("nango_proxy_request", {
        ...direct,
        path: "customer-specific-endpoint",
      }),
    ).toMatchObject({ status: "allowed", operationKind: "mutation" });
  });

  test("keeps pagination a registered semantic-read-only surface", () => {
    expect(
      classifyNangoToolCall("nango_proxy_paginate", {
        providerConfigKey: "yandex-direct",
        method: "POST",
        path: "json/v5/campaigns",
        jsonBody: { method: "get", params: {} },
        mode: "body-offset",
        maxPages: 2,
        maxItems: 20,
      }),
    ).toMatchObject({ status: "allowed", operationKind: "read" });

    expect(
      classifyNangoToolCall("nango_proxy_paginate", {
        providerConfigKey: "amocrm-crm",
        method: "GET",
        path: "api/v4/leads",
        mode: "link",
        maxPages: 2,
        maxItems: 20,
      }),
    ).toMatchObject({ status: "allowed", operationKind: "read" });
    expect(
      classifyNangoToolCall("nango_proxy_paginate", {
        providerConfigKey: "bitrix24-crm",
        method: "POST",
        path: "crm.deal.list",
        jsonBody: { filter: { STAGE_ID: "NEW" } },
        mode: "offset",
        maxPages: 2,
        maxItems: 20,
      }),
    ).toMatchObject({ status: "allowed", operationKind: "read" });

    for (const params of [
      {
        providerConfigKey: "yandex-direct",
        method: "POST",
        path: "json/v5/campaigns",
        jsonBody: { method: "update", params: {} },
      },
      {
        providerConfigKey: "yandex-delivery",
        method: "POST",
        path: "api/b2b/platform/offers/create",
        jsonBody: {},
      },
      {
        providerConfigKey: "bitrix24-crm",
        method: "GET",
        path: "crm.deal.update",
      },
      {
        providerConfigKey: "bitrix24-crm",
        method: "GET",
        path: "customer-specific-endpoint",
      },
      {
        providerConfigKey: "amocrm-crm",
        method: "GET",
        path: "api/v4/customer-specific-endpoint",
      },
    ]) {
      expect(
        classifyNangoToolCall("nango_proxy_paginate", {
          ...params,
          mode: "single",
          maxPages: 1,
          maxItems: 10,
        }),
      ).toMatchObject({ status: "blocked" });
    }
  });

  test("uses a fixed action registry and treats every disk transfer as a mutation", () => {
    expect(
      classifyNangoToolCall("nango_action", {
        providerConfigKey: "yandex-mail",
        actionName: "list-messages",
        input: { folder: "Inbox" },
      }),
    ).toMatchObject({ status: "allowed", operationKind: "read" });
    expect(
      classifyNangoToolCall("nango_action", {
        providerConfigKey: "yandex-mail",
        actionName: "send-message",
        input: { to: ["recipient@example.test"] },
      }),
    ).toMatchObject({ status: "allowed", operationKind: "mutation" });
    expect(
      classifyNangoToolCall("nango_action", {
        providerConfigKey: "yandex-mail",
        actionName: "caller-invented-read",
        input: {},
      }),
    ).toMatchObject({ status: "blocked" });
    expect(
      classifyNangoToolCall("nango_action", {
        providerConfigKey: "yandex-mail",
        actionName: "send-message",
        operationKind: "read",
        input: {},
      }),
    ).toMatchObject({ status: "blocked" });
    expect(
      classifyNangoToolCall("nango_action", {
        providerConfigKey: "amocrm-chats",
        actionName: "send-message",
        input: { text: "private-chat-message-sentinel" },
      }),
    ).toMatchObject({ status: "allowed", operationKind: "mutation" });

    for (const direction of ["upload", "download"]) {
      expect(
        classifyNangoToolCall("nango_disk_transfer", {
          providerConfigKey: "yandex-disk",
          direction,
          localPath: "/allowed/file.bin",
          remotePath: "disk:/file.bin",
        }),
      ).toMatchObject({
        status: "allowed",
        operationKind: "mutation",
      });
    }
  });

  test("blocks malformed action input but preserves the zero-input mailbox action", () => {
    expect(
      classifyNangoToolCall("nango_action", {
        providerConfigKey: "yandex-mail",
        actionName: "resolve-mailbox",
      }),
    ).toMatchObject({ status: "allowed", operationKind: "read" });

    for (const params of [
      {
        providerConfigKey: "yandex-mail",
        actionName: "list-messages",
      },
      {
        providerConfigKey: "yandex-mail",
        actionName: "get-message",
        input: "message-id",
      },
      {
        providerConfigKey: "yandex-mail",
        actionName: "send-message",
        input: ["recipient@example.test"],
      },
    ]) {
      expect(
        classifyNangoToolCall("nango_action", params),
      ).toMatchObject({ status: "blocked" });
    }
  });

  test("blocks malformed Disk paths and unexpected transfer controls", () => {
    for (const params of [
      {
        providerConfigKey: "yandex-disk",
        direction: "upload",
      },
      {
        providerConfigKey: "yandex-disk",
        direction: "upload",
        localPath: "",
        remotePath: "disk:/file.bin",
      },
      {
        providerConfigKey: "yandex-disk",
        direction: "download",
        localPath: "/allowed/file.bin",
        remotePath: "disk:/bad\npath",
      },
      {
        providerConfigKey: "yandex-disk",
        direction: "upload",
        localPath: "/allowed/file.bin",
        remotePath: "disk:/file.bin",
        untrustedControl: true,
      },
      {
        providerConfigKey: "yandex-disk",
        direction: "upload",
        localPath: "/allowed/file.bin",
        remotePath: "disk:/file.bin",
        timeoutMs: 0,
      },
    ]) {
      expect(
        classifyNangoToolCall("nango_disk_transfer", params),
      ).toMatchObject({ status: "blocked" });
    }
  });

  test("rejects missing or unknown pagination controls", () => {
    const valid = {
      providerConfigKey: "amocrm-crm",
      method: "GET",
      path: "api/v4/leads",
      mode: "link",
      maxPages: 2,
      maxItems: 20,
    };

    expect(
      classifyNangoToolCall("nango_proxy_paginate", {
        ...valid,
        untrustedControl: true,
      }),
    ).toMatchObject({ status: "blocked" });
    expect(
      classifyNangoToolCall("nango_proxy_paginate", {
        providerConfigKey: valid.providerConfigKey,
        method: valid.method,
        path: valid.path,
      }),
    ).toMatchObject({ status: "blocked" });
  });

  test("returns a synchronous block for malformed calls and ignores unrelated tools", () => {
    for (const params of [
      null,
      {},
      requestParams({ providerConfigKey: "unknown-provider" }),
      requestParams({ method: "TRACE" }),
      requestParams({ path: "../escape" }),
      requestParams({ jsonBody: Number.NaN }),
    ]) {
      expect(() =>
        classifyNangoToolCall("nango_proxy_request", params),
      ).not.toThrow();
      expect(
        classifyNangoToolCall("nango_proxy_request", params),
      ).toMatchObject({ status: "blocked" });
    }

    expect(classifyNangoToolCall("unrelated_tool", {})).toEqual({
      status: "unrelated",
    });
  });
});

describe("approval request contract", () => {
  test("does not prompt for a read", () => {
    const controller = createApprovalController({ key: FIXED_KEY });

    const result = controller.beforeToolCall({
      toolName: "nango_proxy_request",
      toolCallId: "read-call",
      params: requestParams(),
    });

    expect(result).toBeUndefined();
  });

  test("requests only bounded one-time approval without leaking payload data", () => {
    const controller = createApprovalController({
      key: FIXED_KEY,
      randomBytes: () => new Uint8Array(16).fill(3),
    });

    const decision = mutationDecision(controller);
    const request = decision.requireApproval!;

    expect(request.allowedDecisions).toEqual(["allow-once", "deny"]);
    expect(request.allowedDecisions).not.toContain("allow-always");
    expect(request.timeoutMs).toBe(APPROVAL_TIMEOUT_MS);
    expect(request).not.toHaveProperty("timeoutBehavior");
    expect(request.pluginId).toBe("nango-tools");
    expect(request.severity).toBe("warning");
    expect(request.title.length).toBeLessThanOrEqual(80);
    expect(request.description.length).toBeLessThanOrEqual(320);
    expect(request.description).toContain("amocrm-crm");
    expect(request.description).toContain("api/v4/leads");
    expect(request.description).not.toContain("private-payload-sentinel");
    expect(request.description).not.toContain("header-secret-sentinel");
    expect(decision.params).toHaveProperty(APPROVAL_PROOF_PARAM);
  });

  test("redacts dynamic provider path segments from the approval route", () => {
    const controller = createApprovalController({
      key: FIXED_KEY,
      randomBytes: () => new Uint8Array(16).fill(3),
    });
    const decision = mutationDecision(
      controller,
      requestParams({
        method: "PATCH",
        path: "api/v4/leads/private-path-token-sentinel",
      }),
      "dynamic-path-call",
    );
    const description = decision.requireApproval!.description;

    expect(description).toContain("api/v4/leads/{dynamic}");
    expect(description).not.toContain("private-path-token-sentinel");
    expect(description).toMatch(/path-[a-f0-9]{12}/);
  });

  test("uses critical severity for delete, overwrite and send operations", () => {
    const controller = createApprovalController({ key: FIXED_KEY });

    const deleteDecision = mutationDecision(
      controller,
      requestParams({ method: "DELETE" }),
      "delete-call",
    );
    const overwriteDecision = controller.beforeToolCall({
      toolName: "nango_disk_transfer",
      toolCallId: "overwrite-call",
      params: {
        providerConfigKey: "yandex-disk",
        direction: "download",
        localPath: "/allowed/file.bin",
        remotePath: "disk:/file.bin",
        overwrite: true,
      },
    });
    const sendDecision = controller.beforeToolCall({
      toolName: "nango_action",
      toolCallId: "send-call",
      params: {
        providerConfigKey: "yandex-mail",
        actionName: "send-message",
        input: {
          to: ["private-recipient-sentinel@example.test"],
          text: "private-message-sentinel",
        },
      },
    });

    for (const decision of [
      deleteDecision,
      overwriteDecision,
      sendDecision,
    ]) {
      expect(decision?.requireApproval?.severity).toBe("critical");
    }
    expect(sendDecision?.requireApproval?.description).not.toContain(
      "private-recipient-sentinel",
    );
    expect(sendDecision?.requireApproval?.description).not.toContain(
      "private-message-sentinel",
    );
  });

  test("does not disclose local or remote Disk paths in approval text", () => {
    const controller = createApprovalController({ key: FIXED_KEY });
    const decision = controller.beforeToolCall({
      toolName: "nango_disk_transfer",
      toolCallId: "disk-call",
      params: {
        providerConfigKey: "yandex-disk",
        direction: "upload",
        localPath: "/allowed/private-local-name-sentinel.bin",
        remotePath: "disk:/private-remote-name-sentinel.bin",
      },
    });
    const display = [
      decision?.requireApproval?.title,
      decision?.requireApproval?.description,
    ].join(" ");

    expect(display).toContain("yandex-disk");
    expect(display).toContain("upload");
    expect(display).not.toContain("private-local-name-sentinel");
    expect(display).not.toContain("private-remote-name-sentinel");
  });

  test("blocks malformed calls synchronously instead of throwing", () => {
    const controller = createApprovalController({ key: FIXED_KEY });

    const decision = controller.beforeToolCall({
      toolName: "nango_proxy_request",
      params: requestParams({ method: "TRACE" }),
    });

    expect(decision).not.toBeInstanceOf(Promise);
    expect(decision).toMatchObject({
      block: true,
      blockReason: expect.any(String),
    });
  });
});

describe("one-time proof", () => {
  test("allows a read without proof but rejects a model-supplied proof", () => {
    const controller = createApprovalController({ key: FIXED_KEY });

    expect(
      controller.authorizeExecution(
        "nango_proxy_request",
        "read-call",
        requestParams(),
      ),
    ).toEqual({ ok: true, operationKind: "read" });
    expect(
      controller.authorizeExecution(
        "nango_proxy_request",
        "read-call",
        requestParams({ [APPROVAL_PROOF_PARAM]: "model-forged" }),
      ),
    ).toMatchObject({ ok: false });
  });

  test("rejects a mutation before allow-once resolution and after denial", () => {
    const controller = createApprovalController({ key: FIXED_KEY });
    const params = requestParams({ method: "PATCH" });
    const pending = mutationDecision(controller, params);

    expect(
      controller.authorizeExecution(
        "nango_proxy_request",
        "call-1",
        pending.params!,
      ),
    ).toMatchObject({ ok: false });

    const denied = mutationDecision(controller, params, "denied-call");
    denied.requireApproval?.onResolution?.("deny");
    expect(
      controller.authorizeExecution(
        "nango_proxy_request",
        "denied-call",
        denied.params!,
      ),
    ).toMatchObject({ ok: false });

    const allowAlways = mutationDecision(
      controller,
      params,
      "allow-always-call",
    );
    allowAlways.requireApproval?.onResolution?.("allow-always");
    expect(
      controller.authorizeExecution(
        "nango_proxy_request",
        "allow-always-call",
        allowAlways.params!,
      ),
    ).toMatchObject({ ok: false });
  });

  test("rejects missing, forged, altered, mismatched and replayed proofs", () => {
    const controller = createApprovalController({
      key: FIXED_KEY,
      randomBytes: () => new Uint8Array(16).fill(5),
    });
    const params = requestParams({
      method: "PATCH",
      jsonBody: { id: 1, status: "open" },
    });

    expect(
      controller.authorizeExecution(
        "nango_proxy_request",
        "missing-call",
        params,
      ),
    ).toMatchObject({ ok: false });

    const forged = approveMutation(controller, params, "forged-call");
    const proof = String(forged[APPROVAL_PROOF_PARAM]);
    expect(
      controller.authorizeExecution(
        "nango_proxy_request",
        "forged-call",
        {
          ...forged,
          [APPROVAL_PROOF_PARAM]: `${proof.slice(0, -1)}${
            proof.endsWith("A") ? "B" : "A"
          }`,
        },
      ),
    ).toMatchObject({ ok: false });

    const altered = approveMutation(controller, params, "altered-call");
    expect(
      controller.authorizeExecution(
        "nango_proxy_request",
        "altered-call",
        {
          ...altered,
          jsonBody: { id: 1, status: "closed" },
        },
      ),
    ).toMatchObject({ ok: false });

    const mismatched = approveMutation(
      controller,
      params,
      "original-call",
    );
    expect(
      controller.authorizeExecution(
        "nango_proxy_request",
        "different-call",
        mismatched,
      ),
    ).toMatchObject({ ok: false });

    const approved = approveMutation(controller, params, "replay-call");
    expect(
      controller.authorizeExecution(
        "nango_proxy_request",
        "replay-call",
        approved,
      ),
    ).toEqual({ ok: true, operationKind: "mutation" });
    expect(
      controller.authorizeExecution(
        "nango_proxy_request",
        "replay-call",
        approved,
      ),
    ).toMatchObject({ ok: false });
  });

  test("rejects non-canonical proof encodings and UTF-8 replacement collisions", () => {
    const controller = createApprovalController({ key: FIXED_KEY });
    const params = requestParams({
      method: "PATCH",
      jsonBody: { value: "\ud800" },
    });

    const nonCanonicalMac = approveMutation(
      controller,
      params,
      "mac-call",
    );
    const proofParts = String(
      nonCanonicalMac[APPROVAL_PROOF_PARAM],
    ).split(".");
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const finalMac = proofParts[3]!;
    const lastIndex = alphabet.indexOf(finalMac.at(-1)!);
    proofParts[3] = `${finalMac.slice(0, -1)}${alphabet[lastIndex + 1]}`;
    expect(
      controller.authorizeExecution(
        "nango_proxy_request",
        "mac-call",
        {
          ...nonCanonicalMac,
          [APPROVAL_PROOF_PARAM]: proofParts.join("."),
        },
      ),
    ).toMatchObject({ ok: false });

    const nonCanonicalExpiry = approveMutation(
      controller,
      params,
      "expiry-call",
    );
    const expiryParts = String(
      nonCanonicalExpiry[APPROVAL_PROOF_PARAM],
    ).split(".");
    expiryParts[1] = `0${expiryParts[1]}`;
    expect(
      controller.authorizeExecution(
        "nango_proxy_request",
        "expiry-call",
        {
          ...nonCanonicalExpiry,
          [APPROVAL_PROOF_PARAM]: expiryParts.join("."),
        },
      ),
    ).toMatchObject({ ok: false });

    const unicodeCollision = approveMutation(
      controller,
      params,
      "unicode-call",
    );
    expect(
      controller.authorizeExecution(
        "nango_proxy_request",
        "unicode-call",
        {
          ...unicodeCollision,
          jsonBody: { value: "\ufffd" },
        },
      ),
    ).toMatchObject({ ok: false });
  });

  test("expires proofs and bounds retained approval state", () => {
    let now = 1_000;
    const controller = createApprovalController({
      key: FIXED_KEY,
      now: () => now,
      proofTtlMs: 1_000,
      maxRecords: 2,
    });
    const params = requestParams({ method: "PATCH" });
    const expired = approveMutation(controller, params, "expired-call");

    now = 2_001;
    expect(
      controller.authorizeExecution(
        "nango_proxy_request",
        "expired-call",
        expired,
      ),
    ).toMatchObject({ ok: false });

    mutationDecision(controller, params, "bounded-1");
    mutationDecision(controller, params, "bounded-2");
    mutationDecision(controller, params, "bounded-3");
    expect(controller.pendingRecordCount()).toBeLessThanOrEqual(2);
  });
});

describe("canonical business parameters", () => {
  test("is stable across object key order while preserving JSON type and array order", () => {
    expect(
      canonicalizeBusinessParams({ b: 2, a: ["1", 1, true, null] }),
    ).toBe(
      canonicalizeBusinessParams({ a: ["1", 1, true, null], b: 2 }),
    );
    expect(canonicalizeBusinessParams({ value: 1 })).not.toBe(
      canonicalizeBusinessParams({ value: "1" }),
    );
    expect(canonicalizeBusinessParams({ value: [1, 2] })).not.toBe(
      canonicalizeBusinessParams({ value: [2, 1] }),
    );
  });

  test("rejects non-JSON values, weird prototypes, cycles and reserved proof input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    for (const value of [
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: undefined },
      { value: BigInt(1) },
      { value: new Date(0) },
      circular,
      { nested: { [APPROVAL_PROOF_PARAM]: "forged" } },
    ]) {
      expect(() => canonicalizeBusinessParams(value)).toThrow();
    }
  });
});

describe("OpenClaw 2026.6.11 hook parameter contract", () => {
  test("delivers a hook-added hidden field to execute without exposing it in the schema", async () => {
    initializeGlobalHookRunner({
      hooks: [],
      plugins: [{ id: "proof-contract-test", status: "loaded" }],
      typedHooks: [
        {
          pluginId: "proof-contract-test",
          hookName: "before_tool_call",
          source: "approval.test.ts",
          handler: () => ({
            params: { [APPROVAL_PROOF_PARAM]: "host-added-proof" },
          }),
        },
      ],
    });

    let received: unknown;
    const wrapped = wrapToolWithBeforeToolCallHook({
      name: "proof_contract_tool",
      label: "proof_contract_tool",
      description: "Test-only runtime contract.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        received = params;
        return {
          content: [{ type: "text" as const, text: "ok" }],
          details: { ok: true },
        };
      },
    });

    await wrapped.execute("runtime-call", {});

    expect(received).toEqual({
      [APPROVAL_PROOF_PARAM]: "host-added-proof",
    });
    expect(wrapped.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
  });
});

describe("plugin approval wiring", () => {
  test("replaces the scaffold block with the synchronous semantic policy", () => {
    const { beforeToolCall } = registerPluginRuntime();

    expect(
      beforeToolCall?.(
        {
          toolName: "nango_proxy_request",
          toolCallId: "read-call",
          params: requestParams(),
        },
        { toolName: "nango_proxy_request", toolCallId: "read-call" },
      ),
    ).toBeUndefined();

    const mutation = beforeToolCall?.(
      {
        toolName: "nango_proxy_request",
        toolCallId: "mutation-call",
        params: requestParams({ method: "PATCH" }),
      },
      { toolName: "nango_proxy_request", toolCallId: "mutation-call" },
    );
    expect(mutation?.requireApproval).toBeDefined();
    expect(mutation).not.toBeInstanceOf(Promise);
  });

  test("guards real execution with the same exact one-time proof", async () => {
    const { tools, beforeToolCall } = registerPluginRuntime();
    const tool = tools.find(
      (candidate) => candidate.name === "nango_proxy_request",
    )!;
    const params = requestParams({ method: "PATCH" });

    await expect(tool.execute("missing-call", params)).resolves.toMatchObject({
      details: {
        error: { code: "approval_required" },
        outcome: "not_started",
      },
    });

    const mutation = beforeToolCall?.(
      {
        toolName: "nango_proxy_request",
        toolCallId: "approved-call",
        params,
      },
      { toolName: "nango_proxy_request", toolCallId: "approved-call" },
    );
    mutation?.requireApproval?.onResolution("allow-once");
    await expect(
      tool.execute("approved-call", mutation!.params!),
    ).resolves.toMatchObject({
      details: {
        error: { code: "invalid_runtime_config" },
        outcome: "not_started",
      },
    });
    await expect(
      tool.execute("approved-call", mutation!.params!),
    ).resolves.toMatchObject({
      details: {
        error: { code: "approval_required" },
        outcome: "not_started",
      },
    });
  });
});
