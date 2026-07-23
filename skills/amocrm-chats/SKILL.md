---
name: amocrm-chats
description: "amoCRM Chats tasks: amoCRM chats, messengers, inbound channels."
metadata: {"openclaw":{},"nango":{"family":"amocrm","provider_config_key":"amocrm-chats"}}
---

# amoCRM Chats

Use this skill when the user requests amoCRM chats, messengers, inbound channels through the configured Nango connection.

- Route only to `providerConfigKey`: **`amocrm-chats`**.
- Scopes / access: `account data`
- Upstream base (via Nango): `https://{subdomain}.amocrm.ru`

## Workflow

1. Use the exact provider key above; never route by a similar vendor name.
2. Use `nango_proxy_request` for one provider request and `nango_proxy_paginate` only for a registered bounded read contract.
3. Use `nango_action` only for a registered action and `nango_disk_transfer` only for Yandex Disk file transfer.
4. Reads run without a prompt. Every semantic mutation requires one-time approval tied to the exact tool call and parameters.
5. Treat `confirmed` as completed, `not_started` as safe to fix and retry, and `confirmed_failed` as a provider-confirmed failure. For `unknown`, inspect provider state and do not retry blindly.
6. Do not infer the failing layer from HTTP status alone. Return the tool's safe error code and outcome; never expose credentials.

Do not use the Python fallback to bypass approval.

## Typed tools

### Preferred call

Use `nango_proxy_paginate` with:

```json
{
  "providerConfigKey": "amocrm-chats",
  "method": "GET",
  "path": "api/v4/talks",
  "mode": "link",
  "maxPages": 10,
  "maxItems": 500
}
```

### Chats action

Use `nango_proxy_paginate` for read-only `api/v4/talks`. Use `nango_action` with the registered `send-message` action for outbound chat messages; follow the exposed input schema rather than inventing amoJo fields:

```json
{
  "providerConfigKey": "amocrm-chats",
  "actionName": "send-message",
  "input": {
    "conversationId": "<confirmed-conversation-id>",
    "message": {
      "type": "text",
      "text": "Hello"
    },
    "idempotencyKey": "<stable-key>"
  }
}
```

Sending is a mutation. Confirm the returned message id, or inspect chat state if the outcome is `unknown`.

Request inputs are strict: relative `path`, ordered `query` pairs, bounded headers/body, and no caller-supplied auth, raw Nango control headers, approval proof, or operation classification fields.

## Operator-only fallback

Keep this compatibility path for diagnostics or deployments where the plugin is unavailable. It requires `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`, Python 3, and `httpx`. An operator must explicitly choose it. Mutations still need approval and post-write verification.

```bash
# Talks
python3 {baseDir}/scripts/nango_proxy.py call amocrm-chats api/v4/talks --json-output
```

The fallback preserves the full generic HTTP flags documented in `{baseDir}/references/api-reference.md`.

## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
