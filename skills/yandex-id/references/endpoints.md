# Yandex ID

- **Skill id:** `yandex-id`
- **Nango provider_config_key:** `yandex-id`
- **Family:** `yandex`
- **Scopes:** login:info, login:email, login:avatar
- **Upstream base:** `https://login.yandex.ru`

## Operations

### GET profile

- **Operation name:** `GET profile`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `info`
- **Request shape:** method and relative path, ordered `query` name/value pairs; see the exact typed arguments below.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Return only the confirmed profile response.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_proxy_request",
  "arguments": {
    "providerConfigKey": "yandex-id",
    "method": "GET",
    "path": "info",
    "query": [
      {
        "name": "format",
        "value": "json"
      }
    ]
  }
}
```

### legacy key

- **Operation name:** `legacy key`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `info`
- **Request shape:** method and relative path, ordered `query` name/value pairs; see the exact typed arguments below.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Return only the confirmed profile response for the explicitly selected legacy connection key.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_proxy_request",
  "arguments": {
    "providerConfigKey": "yandex-id",
    "method": "GET",
    "path": "info",
    "query": [
      {
        "name": "format",
        "value": "json"
      }
    ]
  }
}
```

## Notes

Legacy Nango unique key `yandex` still works if that is what was connected.
