---
name: yandex-delivery
description: "Yandex Delivery Partner tasks: Yandex Delivery offers, claims, or partner logistics API."
metadata: {"openclaw":{},"nango":{"family":"yandex","provider_config_key":"yandex-delivery"}}
---

# Yandex Delivery Partner

Use this skill when the user requests Yandex Delivery offers, claims, or partner logistics API through the configured Nango connection.

- Route only to `providerConfigKey`: **`yandex-delivery`**.
- Scopes / access: `delivery:partner-api`
- Upstream base (via Nango): `https://b2b.taxi.yandex.net`

## Workflow

1. Use the exact provider key above; never route by a similar vendor name.
2. Use `nango_proxy_request` for one provider request and `nango_proxy_paginate` only for a registered bounded read contract.
3. Use `nango_action` only for a registered action and `nango_disk_transfer` only for Yandex Disk file transfer.
4. Reads run without a prompt. Every semantic mutation requires one-time approval tied to the exact tool call and parameters.
5. Treat `confirmed` as completed, `not_started` as safe to fix and retry, and `confirmed_failed` as a provider-confirmed failure. For `unknown`, inspect provider state and do not retry blindly.
6. Do not infer the failing layer from HTTP status alone. Return the tool's safe error code and outcome; never expose credentials.

Do not use the Python fallback to bypass approval.

## Typed tools

### Product-contract boundary

`api/b2b/platform/offers/create` is a mutation, not a probe. Never use an empty create request as a health probe. Require the exact Delivery API product schema and real required fields before calling `nango_proxy_request`; after success, fetch the created entity. On an uncertain dispatch, inspect provider state before retrying.

Request inputs are strict: relative `path`, ordered `query` pairs, bounded headers/body, and no caller-supplied auth, raw Nango control headers, approval proof, or operation classification fields.

## Operator-only fallback

Keep this compatibility path for diagnostics or deployments where the plugin is unavailable. It requires `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`, Python 3, and `httpx`. An operator must explicitly choose it. Mutations still need approval and post-write verification.

```bash
# Legacy create shape — do not execute without real required fields
python3 {baseDir}/scripts/nango_proxy.py call yandex-delivery api/b2b/platform/offers/create --method POST --json '{}' --json-output
```

The fallback preserves the full generic HTTP flags documented in `{baseDir}/references/api-reference.md`.

## Notes

The create route requires the exact matching Delivery product schema. Never send an empty create body as a connectivity test.

## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
