# Yandex Direct

- **Skill id:** `yandex-direct`
- **Nango provider_config_key:** `yandex-direct`
- **Family:** `yandex`
- **Scopes:** direct:api
- **Upstream base:** `https://api.direct.yandex.com`

## Operations

### JSON v5 campaigns

- **Operation name:** `JSON v5 campaigns`
- **Availability:** `ready`
- **Method:** `POST`
- **Path:** `json/v5/campaigns`
- **Request shape:** method and relative path, `jsonBody`; see the exact typed arguments below.
- **Pagination:** `body-offset` with `maxPages=10` and `maxItems=500`; report the termination reason.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Advance Page.Offset within configured bounds and return the terminal page and termination reason.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_proxy_paginate",
  "arguments": {
    "providerConfigKey": "yandex-direct",
    "method": "POST",
    "path": "json/v5/campaigns",
    "jsonBody": {
      "method": "get",
      "params": {
        "SelectionCriteria": {},
        "FieldNames": [
          "Id",
          "Name"
        ],
        "Page": {
          "Limit": 100,
          "Offset": 0
        }
      }
    },
    "mode": "body-offset",
    "maxPages": 10,
    "maxItems": 500
  }
}
```

### Update campaign (replace provider-documented payload)

- **Operation name:** `Update campaign (replace provider-documented payload)`
- **Availability:** `template`
- **Method:** `POST`
- **Path:** `json/v5/campaigns`
- **Request shape:** method and relative path, `jsonBody`; see the exact typed arguments below.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `mutation` — one-time approval is required before execution.
- **Verification:** After confirmed success read the campaign and compare intended fields. After unknown, inspect campaign state before any retry.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

This is a **non-executable template**. Replace every `REPLACE_WITH_...` value with a confirmed value inside the configured runtime boundary before execution.

#### Typed tool call

```json
{
  "tool": "nango_proxy_request",
  "arguments": {
    "providerConfigKey": "yandex-direct",
    "method": "POST",
    "path": "json/v5/campaigns",
    "jsonBody": {
      "method": "update",
      "params": "REPLACE_WITH_PROVIDER_DOCUMENTED_CAMPAIGN_UPDATE_PAYLOAD"
    }
  }
}
```

## Notes

Nango injects the provider credential. The caller must not supply or override auth and Nango control headers. After a confirmed Direct mutation, read the campaign and compare intended fields; after an uncertain dispatch, inspect campaign state before retrying.
