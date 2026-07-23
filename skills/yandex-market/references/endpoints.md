# Yandex Market Partner

- **Skill id:** `yandex-market`
- **Nango provider_config_key:** `yandex-market`
- **Family:** `yandex`
- **Scopes:** market:partner-api
- **Upstream base:** `https://api.partner.market.yandex.ru`

## Operations

### Campaigns v2

- **Operation name:** `Campaigns v2`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `v2/campaigns`
- **Request shape:** method and relative path; see the exact typed arguments below.
- **Pagination:** `offset` with `maxPages=10` and `maxItems=500`; report the termination reason.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Return bounded campaign pages and the pagination termination reason; do not claim the provider authentication was live-tested.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_proxy_paginate",
  "arguments": {
    "providerConfigKey": "yandex-market",
    "method": "GET",
    "path": "v2/campaigns",
    "mode": "offset",
    "maxPages": 10,
    "maxItems": 500
  }
}
```

## Notes

Authentication behavior depends on the configured Nango provider and has not been live-verified by this repository.
