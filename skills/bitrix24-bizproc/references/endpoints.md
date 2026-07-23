# Bitrix24 Business Processes

- **Skill id:** `bitrix24-bizproc`
- **Nango provider_config_key:** `bitrix24-bizproc`
- **Family:** `bitrix24`
- **Scopes:** bizproc
- **Upstream base:** `https://{domain}/rest`

## Operations

### Workflow templates

- **Operation name:** `Workflow templates`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `bizproc.workflow.template.list`
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
    "providerConfigKey": "bitrix24-bizproc",
    "method": "GET",
    "path": "bizproc.workflow.template.list",
    "mode": "offset",
    "maxPages": 10,
    "maxItems": 500
  }
}
```
