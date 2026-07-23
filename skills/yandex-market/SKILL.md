---
name: yandex-market
description: "Yandex Market Partner tasks: Market partner campaigns, offers, or partner cabinet data."
metadata: {"openclaw":{},"nango":{"family":"yandex","provider_config_key":"yandex-market"}}
---

# Yandex Market Partner

Use this skill when the user requests Market partner campaigns, offers, or partner cabinet data through the configured Nango connection.

- Route only to `providerConfigKey`: **`yandex-market`**.
- Scopes / access: `market:partner-api`
- Upstream base (via Nango): `https://api.partner.market.yandex.ru`

## Workflow

1. Use the exact provider key above; never route by a similar vendor name.
2. Use `nango_proxy_request` for one provider request and `nango_proxy_paginate` only for a registered bounded read contract.
3. Use `nango_action` only for a registered action and `nango_disk_transfer` only for Yandex Disk file transfer.
4. Reads run without a prompt. Every semantic mutation requires one-time approval tied to the exact tool call and parameters.
5. Treat `confirmed` as completed, `not_started` as safe to fix and retry, and `confirmed_failed` as a provider-confirmed failure. For `unknown`, inspect provider state and do not retry blindly.
6. Do not infer the failing layer from HTTP status alone. Return the tool's safe error code and outcome; never expose credentials.

Do not use the Python fallback to bypass approval.

## Typed tools

### Preferred call

Use `nango_proxy_paginate` with:

```json
{
  "providerConfigKey": "yandex-market",
  "method": "GET",
  "path": "v2/campaigns",
  "mode": "offset",
  "maxPages": 10,
  "maxItems": 500
}
```

### Authentication caveat

The repository has not live-tested this OAuth connection against the current Partner API. Use only the connection configured for `yandex-market`; report provider authorization errors without claiming that OAuth or Api-Key is universally required.

### Pagination result contract

Return the bounded pages and the tool's termination reason. If a configured page or item bound stops the read, report that bound instead of claiming the provider collection is complete.

Request inputs are strict: relative `path`, ordered `query` pairs, bounded headers/body, and no caller-supplied auth, raw Nango control headers, approval proof, or operation classification fields.

## Operator-only fallback

Keep this compatibility path for diagnostics or deployments where the plugin is unavailable. It requires `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`, Python 3, and `httpx`. An operator must explicitly choose it. Mutations still need approval and post-write verification.

```bash
# Campaigns v2
python3 {baseDir}/scripts/nango_proxy.py call yandex-market v2/campaigns --json-output
```

The fallback preserves the full generic HTTP flags documented in `{baseDir}/references/api-reference.md`.

## Notes

Authentication behavior depends on the configured Nango provider and has not been live-verified by this repository.

## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
