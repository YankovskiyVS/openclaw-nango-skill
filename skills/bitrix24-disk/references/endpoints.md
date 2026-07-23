# Bitrix24 Disk

- **Skill id:** `bitrix24-disk`
- **Nango provider_config_key:** `bitrix24-disk`
- **Family:** `bitrix24`
- **Scopes:** disk
- **Upstream base:** `https://{domain}/rest`

## Operations

### Storage list

- **Operation name:** `Storage list`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `disk.storage.getlist`
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
    "providerConfigKey": "bitrix24-disk",
    "method": "GET",
    "path": "disk.storage.getlist",
    "mode": "offset",
    "maxPages": 10,
    "maxItems": 500
  }
}
```
