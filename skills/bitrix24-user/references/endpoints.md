# Bitrix24 Users & Structure

- **Skill id:** `bitrix24-user`
- **Nango provider_config_key:** `bitrix24-user`
- **Family:** `bitrix24`
- **Scopes:** user, department
- **Upstream base:** `https://{domain}/rest`

## Operations

### Current user

- **Operation name:** `Current user`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `user.current`
- **Request shape:** method and relative path; see the exact typed arguments below.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Return only the confirmed current-user response.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_proxy_request",
  "arguments": {
    "providerConfigKey": "bitrix24-user",
    "method": "GET",
    "path": "user.current"
  }
}
```

### Departments

- **Operation name:** `Departments`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `department.get`
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
    "providerConfigKey": "bitrix24-user",
    "method": "GET",
    "path": "department.get",
    "mode": "offset",
    "maxPages": 10,
    "maxItems": 500
  }
}
```
