# amoCRM Tasks & Calendar

- **Skill id:** `amocrm-tasks`
- **Nango provider_config_key:** `amocrm-tasks`
- **Family:** `amocrm`
- **Scopes:** account data
- **Upstream base:** `https://{subdomain}.amocrm.ru`

## Operations

### Tasks

- **Operation name:** `Tasks`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `api/v4/tasks`
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
    "providerConfigKey": "amocrm-tasks",
    "method": "GET",
    "path": "api/v4/tasks",
    "mode": "link",
    "maxPages": 10,
    "maxItems": 500
  }
}
```
