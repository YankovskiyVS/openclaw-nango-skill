# amoCRM Deals & Pipeline

- **Skill id:** `amocrm-crm`
- **Nango provider_config_key:** `amocrm-crm`
- **Family:** `amocrm`
- **Scopes:** account data (selected in amoМаркет)
- **Upstream base:** `https://{subdomain}.amocrm.ru`

## Operations

### Leads

- **Operation name:** `Leads`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `api/v4/leads`
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
    "providerConfigKey": "amocrm-crm",
    "method": "GET",
    "path": "api/v4/leads",
    "mode": "link",
    "maxPages": 10,
    "maxItems": 500
  }
}
```

### Contacts

- **Operation name:** `Contacts`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `api/v4/contacts`
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
    "providerConfigKey": "amocrm-crm",
    "method": "GET",
    "path": "api/v4/contacts",
    "mode": "link",
    "maxPages": 10,
    "maxItems": 500
  }
}
```
