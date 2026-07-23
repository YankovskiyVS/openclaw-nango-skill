# Bitrix24 Telephony

- **Skill id:** `bitrix24-telephony`
- **Nango provider_config_key:** `bitrix24-telephony`
- **Family:** `bitrix24`
- **Scopes:** telephony, call
- **Upstream base:** `https://{domain}/rest`

## Operations

### External lines

- **Operation name:** `External lines`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `telephony.externalLine.get`
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
    "providerConfigKey": "bitrix24-telephony",
    "method": "GET",
    "path": "telephony.externalLine.get",
    "mode": "offset",
    "maxPages": 10,
    "maxItems": 500
  }
}
```
