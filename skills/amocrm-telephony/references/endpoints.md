# amoCRM Telephony

- **Skill id:** `amocrm-telephony`
- **Nango provider_config_key:** `amocrm-telephony`
- **Family:** `amocrm`
- **Scopes:** account data
- **Upstream base:** `https://{subdomain}.amocrm.ru`

## Operations

### Events notes

- **Operation name:** `Events notes`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `api/v4/events`
- **Request shape:** method and relative path, ordered `query` name/value pairs; see the exact typed arguments below.
- **Pagination:** `link` with `maxPages=10` and `maxItems=500`; report the termination reason.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Return bounded pages and the pagination termination reason; stop at provider end or configured bounds.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_proxy_paginate",
  "arguments": {
    "providerConfigKey": "amocrm-telephony",
    "method": "GET",
    "path": "api/v4/events",
    "query": [
      {
        "name": "filter[type]",
        "value": "incoming_call"
      }
    ],
    "mode": "link",
    "maxPages": 10,
    "maxItems": 500
  }
}
```
