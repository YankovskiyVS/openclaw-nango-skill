import { describe, expect, test, vi } from "vitest";

import {
  APPROVAL_PROOF_PARAM,
  classifyNangoToolCall,
  createApprovalController,
} from "../src/approval.js";
import {
  ACTION_PARAMETERS,
  ACTION_REGISTRY,
  resolveActionRegistration,
} from "../src/action-registry.js";
import { parseRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import { createActionTool } from "../src/tools/action.js";

const CLOUD_SECRET = "cloud-api-key-secret-sentinel";
const NANGO_SECRET = "nango-secret-key-sentinel";

function runtimeConfig(
  mode: "proxy" | "direct" = "proxy",
  overrides: Record<string, unknown> = {},
): RuntimeConfig {
  return parseRuntimeConfig({
    cloudru: {
      proxyBaseUrl: "https://proxy.example.test",
      projectId: "project-7",
      evoClawId: "evo-9",
      apiKey: CLOUD_SECRET,
    },
    actions: {
      transport:
        mode === "proxy"
          ? {
              mode,
              endpointUrl:
                "https://actions.example.test/v1/nango/action",
            }
          : {
              mode,
              baseUrl: "https://api.nango.dev",
              secretKey: NANGO_SECRET,
            },
      syncTimeoutMs: 20_000,
      maxInputBytes: 1_048_576,
      maxOutputBytes: 1_048_576,
      ...overrides,
    },
  });
}

function approvals(operationKind: "read" | "mutation") {
  return {
    authorizeExecution: vi.fn(() => ({
      ok: true as const,
      operationKind,
    })),
  };
}

function yandexSendParams(overrides: Record<string, unknown> = {}) {
  return {
    providerConfigKey: "yandex-mail",
    actionName: "send-message",
    input: {
      idempotencyKey: "mail-message-001",
      to: ["recipient@example.test"],
      subject: "Hello",
      text: "Body",
    },
    ...overrides,
  };
}

function amoSendParams(overrides: Record<string, unknown> = {}) {
  return {
    providerConfigKey: "amocrm-chats",
    actionName: "send-message",
    input: {
      msgid: "amo-message-001",
      conversationId: "conversation-1",
      receiver: {
        id: "receiver-1",
        name: "Receiver",
      },
      text: "Hello from OpenClaw",
    },
    ...overrides,
  };
}

function confirmedYandexSend() {
  return {
    ok: true,
    outcome: "confirmed",
    result: {
      mailbox: "sender@example.test",
      messageId: "<message@example.test>",
    },
  } as const;
}

describe("Action registry", () => {
  test("is the single five-action mapping used by approval classification", () => {
    expect(
      ACTION_REGISTRY.map(
        ({
          publicProviderConfigKey,
          publicActionName,
          internalProviderConfigKey,
          internalActionName,
          operationKind,
        }) => ({
          publicProviderConfigKey,
          publicActionName,
          internalProviderConfigKey,
          internalActionName,
          operationKind,
        }),
      ),
    ).toEqual([
      {
        publicProviderConfigKey: "yandex-mail",
        publicActionName: "resolve-mailbox",
        internalProviderConfigKey: "yandex-mail",
        internalActionName: "resolve-mailbox",
        operationKind: "read",
      },
      {
        publicProviderConfigKey: "yandex-mail",
        publicActionName: "list-messages",
        internalProviderConfigKey: "yandex-mail",
        internalActionName: "list-messages",
        operationKind: "read",
      },
      {
        publicProviderConfigKey: "yandex-mail",
        publicActionName: "get-message",
        internalProviderConfigKey: "yandex-mail",
        internalActionName: "get-message",
        operationKind: "read",
      },
      {
        publicProviderConfigKey: "yandex-mail",
        publicActionName: "send-message",
        internalProviderConfigKey: "yandex-mail",
        internalActionName: "send-message",
        operationKind: "mutation",
      },
      {
        publicProviderConfigKey: "amocrm-chats",
        publicActionName: "send-message",
        internalProviderConfigKey: "amocrm-chats-channel",
        internalActionName: "send-message",
        operationKind: "mutation",
      },
    ]);

    for (const registration of ACTION_REGISTRY) {
      expect(
        resolveActionRegistration(
          registration.publicProviderConfigKey,
          registration.publicActionName,
        ),
      ).toBe(registration);
      expect(
        classifyNangoToolCall("nango_action", {
          providerConfigKey: registration.publicProviderConfigKey,
          actionName: registration.publicActionName,
          ...(registration.publicActionName === "resolve-mailbox"
            ? {}
            : { input: {} }),
        }),
      ).toMatchObject({
        status: "allowed",
        operationKind: registration.operationKind,
      });
    }
  });

  test("exposes only strict public routing/input/timeout fields", () => {
    expect(ACTION_PARAMETERS).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(Object.keys(ACTION_PARAMETERS.properties).sort()).toEqual([
      "action",
      "actionName",
      "input",
      "providerConfigKey",
      "timeoutMs",
    ]);
    expect(JSON.stringify(ACTION_PARAMETERS)).not.toContain(
      APPROVAL_PROOF_PARAM,
    );
    expect(JSON.stringify(ACTION_PARAMETERS)).not.toContain(
      "internalProviderConfigKey",
    );
  });

  test("preserves the exact action alias and rejects conflicting aliases", () => {
    expect(
      classifyNangoToolCall("nango_action", {
        providerConfigKey: "yandex-mail",
        action: "resolve-mailbox",
      }),
    ).toMatchObject({ status: "allowed", operationKind: "read" });
    expect(
      classifyNangoToolCall("nango_action", {
        providerConfigKey: "yandex-mail",
        actionName: "resolve-mailbox",
        action: "send-message",
        input: {},
      }),
    ).toMatchObject({ status: "blocked" });
  });

  test.each(["x", "ü", "m".repeat(255)])(
    "accepts provider amoCRM msgid %j with the same output contract as the Action",
    (msgid) => {
      const registration = resolveActionRegistration(
        "amocrm-chats",
        "send-message",
      );

      expect(
        registration?.validateSuccessResult({
          conversationId: "conversation-1",
          senderId: "sender-1",
          receiverId: "receiver-1",
          msgid,
          refId: "amo-message-001",
        }),
      ).toBe(true);
    },
  );

  test("rejects an amoCRM provider msgid beyond the shared output bound", () => {
    const registration = resolveActionRegistration(
      "amocrm-chats",
      "send-message",
    );

    expect(
      registration?.validateSuccessResult({
        conversationId: "conversation-1",
        senderId: "sender-1",
        receiverId: null,
        msgid: "m".repeat(256),
        refId: "amo-message-001",
      }),
    ).toBe(false);
  });
});

describe("Action transport", () => {
  test("posts the exact bounded proxy envelope and unwraps it once", async () => {
    const businessResult = confirmedYandexSend();
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: true, result: businessResult }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            authorization: "must-not-leak",
          },
        },
      ),
    );
    const tool = createActionTool({
      config: runtimeConfig("proxy"),
      approvals: approvals("mutation"),
      fetch,
    });

    const result = await tool.execute("call-proxy", yandexSendParams());

    expect(result).toMatchObject({
      details: {
        ok: true,
        request: {
          providerConfigKey: "yandex-mail",
          method: "POST",
          path: "action/trigger",
        },
        response: {
          status: 200,
          contentType: "application/json",
          headers: {},
          body: businessResult,
        },
        outcome: "confirmed",
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      "https://actions.example.test/v1/nango/action",
    );
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
    });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Api-Key ${CLOUD_SECRET}`,
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      projectId: "project-7",
      evoClawId: "evo-9",
      connectionId: "project-project-7-evoclaw-evo-9",
      providerConfigKey: "yandex-mail",
      actionName: "send-message",
      input: yandexSendParams().input,
    });
    expect(JSON.stringify(result)).not.toContain(CLOUD_SECRET);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  test("uses the fixed direct Nango path, headers, body and amoCRM integration key", async () => {
    const businessResult = {
      ok: true,
      outcome: "confirmed",
      result: {
        conversationId: "conversation-1",
        senderId: "sender-1",
        receiverId: "receiver-1",
        msgid: "amo-message-001",
        refId: "amo-message-001",
      },
    } as const;
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify(businessResult), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const tool = createActionTool({
      config: runtimeConfig("direct"),
      approvals: approvals("mutation"),
      fetch,
    });

    const result = await tool.execute("call-direct", amoSendParams());

    expect(result).toMatchObject({
      details: {
        ok: true,
        response: { body: businessResult },
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.nango.dev/action/trigger");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(
      `Bearer ${NANGO_SECRET}`,
    );
    expect(headers.get("connection-id")).toBe(
      "project-project-7-evoclaw-evo-9",
    );
    expect(headers.get("provider-config-key")).toBe(
      "amocrm-chats-channel",
    );
    expect(headers.get("retries")).toBeNull();
    expect(JSON.parse(String(init?.body))).toEqual({
      action_name: "send-message",
      input: {
        ...amoSendParams().input,
        silent: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain(NANGO_SECRET);
  });

  test("fails closed before I/O when Actions are unavailable or params try to override trust fields", async () => {
    const fetch = vi.fn();
    const configWithoutActions = parseRuntimeConfig({
      cloudru: {
        proxyBaseUrl: "https://proxy.example.test",
        projectId: "project-7",
        evoClawId: "evo-9",
        apiKey: CLOUD_SECRET,
      },
    });
    const unavailable = createActionTool({
      config: configWithoutActions,
      approvals: approvals("mutation"),
      fetch,
    });
    await expect(
      unavailable.execute("missing-actions", yandexSendParams()),
    ).resolves.toMatchObject({
      details: {
        ok: false,
        error: { code: "capability_unavailable" },
        outcome: "not_started",
      },
    });

    const strict = createActionTool({
      config: runtimeConfig(),
      approvals: approvals("mutation"),
      fetch,
    });
    for (const params of [
      yandexSendParams({ connectionId: "attacker-connection" }),
      amoSendParams({
        input: {
          ...amoSendParams().input,
          senderId: "attacker-sender",
        },
      }),
      amoSendParams({
        internalProviderConfigKey: "amocrm-chats",
      }),
    ]) {
      await expect(
        strict.execute("invalid-override", params),
      ).resolves.toMatchObject({
        details: {
          ok: false,
          error: { code: "invalid_action_request" },
          outcome: "not_started",
        },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test("validates exact action inputs and their configured byte/timeout bounds before dispatch", async () => {
    const fetch = vi.fn();
    const tool = createActionTool({
      config: runtimeConfig("proxy", {
        syncTimeoutMs: 100,
        maxInputBytes: 64,
      }),
      approvals: approvals("read"),
      fetch,
    });

    for (const params of [
      {
        providerConfigKey: "yandex-mail",
        actionName: "get-message",
        input: { uid: 0 },
      },
      {
        providerConfigKey: "yandex-mail",
        actionName: "list-messages",
        input: { folder: "INBOX", unexpected: true },
      },
      {
        providerConfigKey: "yandex-mail",
        actionName: "list-messages",
        input: { subject: "x".repeat(100) },
      },
      {
        providerConfigKey: "yandex-mail",
        actionName: "resolve-mailbox",
        timeoutMs: 101,
      },
    ]) {
      await expect(
        tool.execute("invalid-input", params),
      ).resolves.toMatchObject({
        details: {
          ok: false,
          error: { code: "invalid_action_request" },
          outcome: "not_started",
        },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test("reports post-dispatch mutation uncertainty and conservative read failure", async () => {
    const fetch = vi.fn(async () => {
      throw new Error(`network ${CLOUD_SECRET}`);
    });
    const mutation = createActionTool({
      config: runtimeConfig(),
      approvals: approvals("mutation"),
      fetch,
    });
    const read = createActionTool({
      config: runtimeConfig(),
      approvals: approvals("read"),
      fetch,
    });

    const mutationResult = await mutation.execute(
      "mutation-network",
      yandexSendParams(),
    );
    const readResult = await read.execute("read-network", {
      providerConfigKey: "yandex-mail",
      actionName: "resolve-mailbox",
    });

    expect(mutationResult).toMatchObject({
      details: {
        ok: false,
        error: { code: "network_error", retryable: false },
        outcome: "unknown",
      },
    });
    expect(readResult).toMatchObject({
      details: {
        ok: false,
        error: { code: "network_error", retryable: true },
        outcome: "confirmed_failed",
      },
    });
    expect(JSON.stringify([mutationResult, readResult])).not.toContain(
      CLOUD_SECRET,
    );
  });

  test("promotes a validated business failure instead of hiding it in an ok transport wrapper", async () => {
    const businessFailure = {
      ok: false,
      outcome: "unknown",
      error: {
        code: "mail_bridge_outcome_unknown",
        message: "Delivery state must be inspected before retrying",
        retryable: true,
      },
    } as const;
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: true, result: businessFailure }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const tool = createActionTool({
      config: runtimeConfig(),
      approvals: approvals("mutation"),
      fetch,
    });

    const result = await tool.execute(
      "business-failure",
      yandexSendParams(),
    );

    expect(result).toMatchObject({
      details: {
        ok: false,
        error: {
          layer: "provider",
          code: businessFailure.error.code,
          message: businessFailure.error.message,
          retryable: false,
        },
        outcome: "unknown",
      },
    });
    expect(result.details).not.toHaveProperty("response");
  });

  test("keeps the action timeout active while a response body stalls", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  '{"ok":true,"result":{"ok":true,',
                ),
              );
              // Intentionally neither close nor enqueue another chunk.
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
      const tool = createActionTool({
        config: runtimeConfig("proxy", { syncTimeoutMs: 10 }),
        approvals: approvals("mutation"),
        fetch,
      });

      const execution = tool.execute(
        "slow-body",
        yandexSendParams(),
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(11);

      await expect(execution).resolves.toMatchObject({
        details: {
          ok: false,
          error: { code: "action_timeout" },
          outcome: "unknown",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not retry direct calls and only marks transient read statuses retryable", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("{}", {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("{}", {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      );
    const tool = createActionTool({
      config: runtimeConfig("direct"),
      approvals: approvals("read"),
      fetch,
    });
    const params = {
      providerConfigKey: "yandex-mail",
      actionName: "resolve-mailbox",
    };

    const permanent = await tool.execute("read-400", params);
    const transient = await tool.execute("read-503", params);

    expect(permanent).toMatchObject({
      details: {
        ok: false,
        error: {
          code: "action_http_error",
          status: 400,
          retryable: false,
        },
        outcome: "confirmed_failed",
      },
    });
    expect(transient).toMatchObject({
      details: {
        ok: false,
        error: {
          code: "action_http_error",
          status: 503,
          retryable: true,
        },
        outcome: "confirmed_failed",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("rejects oversized, malformed and secret-bearing responses without leaking them", async () => {
    const responses = [
      new Response("x".repeat(257), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response('{"ok":true,"result":{"not":"an envelope"}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            layer: "nango",
            code: "upstream_error",
            message: NANGO_SECRET,
            retryable: false,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
      new Response(
        JSON.stringify({
          ok: false,
          outcome: "unknown",
          error: {
            code: "unsafe\ncode",
            message: "Unsafe error code",
            retryable: false,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    ];
    const fetch = vi.fn(async () => responses.shift()!);
    const tool = createActionTool({
      config: runtimeConfig("direct", { maxOutputBytes: 256 }),
      approvals: approvals("mutation"),
      fetch,
    });

    for (const expectedCode of [
      "response_too_large",
      "invalid_action_response",
      "invalid_action_response",
      "invalid_action_response",
    ]) {
      const result = await tool.execute(
        `response-${expectedCode}`,
        yandexSendParams(),
      );
      expect(result).toMatchObject({
        details: {
          ok: false,
          error: { code: expectedCode },
          outcome: "unknown",
        },
      });
      expect(JSON.stringify(result)).not.toContain(NANGO_SECRET);
    }
  });

  test("rejects a JSON-escaped runtime secret after response decoding", async () => {
    const escapedSecret = 'nango"slash\\tail';
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          outcome: "confirmed",
          result: {
            mailbox: "sender@example.test",
            messageId: escapedSecret,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const tool = createActionTool({
      config: runtimeConfig("direct", {
        transport: {
          mode: "direct",
          baseUrl: "https://api.nango.dev",
          secretKey: escapedSecret,
        },
      }),
      approvals: approvals("mutation"),
      fetch,
    });

    const result = await tool.execute(
      "escaped-secret-response",
      yandexSendParams(),
    );

    expect(result).toMatchObject({
      details: {
        ok: false,
        error: { code: "invalid_action_response" },
        outcome: "unknown",
      },
    });
    expect(JSON.stringify(result)).not.toContain(escapedSecret);
  });

  test("consumes a real one-time mutation approval before any transport result", async () => {
    const controller = createApprovalController({
      key: new Uint8Array(32).fill(9),
    });
    const params = yandexSendParams();
    const decision = controller.beforeToolCall({
      toolName: "nango_action",
      toolCallId: "approved-action",
      params,
    });
    decision?.requireApproval?.onResolution("allow-once");
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: confirmedYandexSend(),
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const tool = createActionTool({
      config: runtimeConfig(),
      approvals: controller,
      fetch,
    });

    await expect(
      tool.execute("approved-action", decision!.params!),
    ).resolves.toMatchObject({ details: { ok: true } });
    await expect(
      tool.execute("approved-action", decision!.params!),
    ).resolves.toMatchObject({
      details: {
        ok: false,
        error: { code: "approval_required" },
        outcome: "not_started",
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
