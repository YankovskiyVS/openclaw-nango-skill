# Bitrix24 Tasks

- **Skill id:** `bitrix24-tasks`
- **Nango provider_config_key:** `bitrix24-tasks`
- **Family:** `bitrix24`
- **Scopes:** task, tasks_extended, sonet_group
- **Upstream base:** `https://{domain}/rest`

## Operations

### List tasks

- **Operation name:** `List tasks`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `tasks.task.list`
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
    "providerConfigKey": "bitrix24-tasks",
    "method": "GET",
    "path": "tasks.task.list",
    "mode": "offset",
    "maxPages": 10,
    "maxItems": 500
  }
}
```
