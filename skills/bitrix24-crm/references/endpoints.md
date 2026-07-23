# Bitrix24 CRM

- **Skill id:** `bitrix24-crm`
- **Nango provider_config_key:** `bitrix24-crm`
- **Family:** `bitrix24`
- **Scopes:** crm
- **Upstream base:** `https://{domain}/rest`

## Operations

### List leads

- **Operation name:** `List leads`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `crm.lead.list`
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
    "providerConfigKey": "bitrix24-crm",
    "method": "GET",
    "path": "crm.lead.list",
    "mode": "offset",
    "maxPages": 10,
    "maxItems": 500
  }
}
```

### List deals

- **Operation name:** `List deals`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `crm.deal.list`
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
    "providerConfigKey": "bitrix24-crm",
    "method": "GET",
    "path": "crm.deal.list",
    "mode": "offset",
    "maxPages": 10,
    "maxItems": 500
  }
}
```

### Update deal

- **Operation name:** `Update deal`
- **Availability:** `ready`
- **Method:** `POST`
- **Path:** `crm.deal.update`
- **Request shape:** method and relative path, `jsonBody`; see the exact typed arguments below.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `mutation` — one-time approval is required before execution.
- **Verification:** After confirmed success read the deal through crm.deal.get and compare intended fields. After unknown, inspect the same deal before any retry.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_proxy_request",
  "arguments": {
    "providerConfigKey": "bitrix24-crm",
    "method": "POST",
    "path": "crm.deal.update",
    "jsonBody": {
      "id": 123,
      "fields": {
        "TITLE": "Updated deal title"
      }
    }
  }
}
```

## Notes

Requires OAuth connection for provider_config_key bitrix24-crm. Primary deal updates use nango_proxy_request with crm.deal.update; after confirmed success, read the deal with crm.deal.get, and after an uncertain dispatch inspect it before retrying.
