# Yandex Mail

- **Skill id:** `yandex-mail`
- **Nango provider_config_key:** `yandex-mail`
- **Family:** `yandex`
- **Scopes:** mail:imap_full, mail:smtp, login:email
- **Upstream base:** `https://login.yandex.ru (identity); mail via IMAP/SMTP`

## Operations

### Resolve mailbox email

- **Operation name:** `Resolve mailbox email`
- **Availability:** `ready`
- **Method:** Not applicable — the registered action owns its transport.
- **Path:** Not applicable — registered action `resolve-mailbox`.
- **Request shape:** Registered action `resolve-mailbox` with a strict `input` object.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Return only the confirmed mailbox address from the registered action.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_action",
  "arguments": {
    "providerConfigKey": "yandex-mail",
    "actionName": "resolve-mailbox",
    "input": {}
  }
}
```

#### Operator diagnostic fallback

This separate diagnostic fallback uses `proxy_http` and does not exercise `nango_action`. Its structured contract is:

```json
{
  "transport": "proxy_http",
  "operation_kind": "read",
  "provider_config_key": "yandex-mail",
  "method": "GET",
  "path": "info",
  "query": [
    {
      "name": "format",
      "value": "json"
    }
  ]
}
```

### List messages

- **Operation name:** `List messages`
- **Availability:** `ready`
- **Method:** Not applicable — the registered action owns its transport.
- **Path:** Not applicable — registered action `list-messages`.
- **Request shape:** Registered action `list-messages` with a strict `input` object.
- **Pagination:** `action-window`: page limit 25, caller max items 500. Use numeric nextCursor as beforeUid; stop on a non-positive or non-numeric cursor.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Return bounded message metadata. Continue only with a numeric nextCursor converted to beforeUid, and report the caller-side item bound.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_action",
  "arguments": {
    "providerConfigKey": "yandex-mail",
    "actionName": "list-messages",
    "input": {
      "folder": "INBOX",
      "limit": 25,
      "unseenOnly": false
    }
  }
}
```

### Get message

- **Operation name:** `Get message`
- **Availability:** `ready`
- **Method:** Not applicable — the registered action owns its transport.
- **Path:** Not applicable — registered action `get-message`.
- **Request shape:** Registered action `get-message` with a strict `input` object.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Return only the confirmed message for the requested folder and UID.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_action",
  "arguments": {
    "providerConfigKey": "yandex-mail",
    "actionName": "get-message",
    "input": {
      "folder": "INBOX",
      "uid": 12345
    }
  }
}
```

### Send message with attachment

- **Operation name:** `Send message with attachment`
- **Availability:** `ready`
- **Method:** Not applicable — the registered action owns its transport.
- **Path:** Not applicable — registered action `send-message`.
- **Request shape:** Registered action `send-message` with a strict `input` object.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `mutation` — one-time approval is required before execution.
- **Verification:** On confirmed success require mailbox and Message-ID. On unknown, keep the same idempotency key and do not retry until provider mailbox state is checked externally; current read actions cannot search exact Message-ID.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_action",
  "arguments": {
    "providerConfigKey": "yandex-mail",
    "actionName": "send-message",
    "input": {
      "idempotencyKey": "mail-20260723-0001",
      "to": [
        "recipient@example.com"
      ],
      "subject": "Verification message",
      "text": "Test message",
      "attachments": [
        {
          "filename": "check.txt",
          "contentType": "text/plain",
          "contentBase64": "dGVzdAo="
        }
      ]
    }
  }
}
```

## Notes

The Python fallback resolves identity only. Mailbox reads and sends use registered Nango actions backed by the fixed IMAP/SMTP bridge; never expose the OAuth token.
