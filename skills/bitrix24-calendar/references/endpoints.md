# Bitrix24 Calendar

- **Skill id:** `bitrix24-calendar`
- **Nango provider_config_key:** `bitrix24-calendar`
- **Family:** `bitrix24`
- **Scopes:** calendar
- **Upstream base:** `https://{domain}/rest`

## Operations

### Section list

- **Operation name:** `Section list`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `calendar.section.get`
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
    "providerConfigKey": "bitrix24-calendar",
    "method": "GET",
    "path": "calendar.section.get",
    "mode": "offset",
    "maxPages": 10,
    "maxItems": 500
  }
}
```
