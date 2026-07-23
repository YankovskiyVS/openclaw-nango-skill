# amoCRM Chats

- **Skill id:** `amocrm-chats`
- **Nango provider_config_key:** `amocrm-chats`
- **Family:** `amocrm`
- **Scopes:** account data
- **Upstream base:** `https://{subdomain}.amocrm.ru`

## Operations

### Talks

- **Operation name:** `Talks`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `api/v4/talks`
- **Request shape:** method and relative path; see the exact typed arguments below.
- **Pagination:** `link` with `maxPages=10` and `maxItems=500`; report the termination reason.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Return bounded pages and the pagination termination reason; stop at provider end or configured bounds.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_proxy_paginate",
  "arguments": {
    "providerConfigKey": "amocrm-chats",
    "method": "GET",
    "path": "api/v4/talks",
    "mode": "link",
    "maxPages": 10,
    "maxItems": 500
  }
}
```

### Send message

- **Operation name:** `Send message`
- **Availability:** `ready`
- **Method:** Not applicable — the registered action owns its transport.
- **Path:** Not applicable — registered action `send-message`.
- **Request shape:** Registered action `send-message` with a strict `input` object.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `mutation` — one-time approval is required before execution.
- **Verification:** On confirmed success require result.refId to equal the input msgid and retain the provider msgid. On unknown, do not retry blindly: the registered talks read cannot prove delivery of the exact message.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_action",
  "arguments": {
    "providerConfigKey": "amocrm-chats",
    "actionName": "send-message",
    "input": {
      "msgid": "example-msg-20260723-0001",
      "conversationId": "example-conversation-001",
      "receiver": {
        "id": "example-receiver-001",
        "name": "Example receiver"
      },
      "text": "Hello",
      "silent": false
    }
  }
}
```

## Notes

Read Talks through `api/v4/talks`. Send outbound messages through the registered `nango_action` `send-message` action with `providerConfigKey` `amocrm-chats`; confirm the returned message id and inspect chat state before retrying an unknown outcome.
