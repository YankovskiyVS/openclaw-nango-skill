# Bitrix24 Messenger

- **Skill id:** `bitrix24-im`
- **Nango provider_config_key:** `bitrix24-im`
- **Family:** `bitrix24`
- **Scopes:** im, imbot, imopenlines
- **Upstream base:** `https://{domain}/rest`

## Operations

### Recent dialogs

- **Operation name:** `Recent dialogs`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `im.recent.get`
- **Request shape:** method and relative path; see the exact typed arguments below.
- **Pagination:** `offset` with `maxPages=10` and `maxItems=500`; report the termination reason.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Return bounded pages and the pagination termination reason; stop at provider end or configured bounds.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_proxy_paginate",
  "arguments": {
    "providerConfigKey": "bitrix24-im",
    "method": "GET",
    "path": "im.recent.get",
    "mode": "offset",
    "maxPages": 10,
    "maxItems": 500
  }
}
```
