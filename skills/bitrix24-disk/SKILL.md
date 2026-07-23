---
name: bitrix24-disk
description: "Bitrix24 Disk tasks: Bitrix24 Drive files, folders, public links."
metadata: {"openclaw":{},"nango":{"family":"bitrix24","provider_config_key":"bitrix24-disk"}}
---

# Bitrix24 Disk

Use this skill when the user requests Bitrix24 Drive files, folders, public links through the configured Nango connection.

- Route only to `providerConfigKey`: **`bitrix24-disk`**.
- Scopes / access: `disk`
- Upstream base (via Nango): `https://{domain}/rest`

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
  "providerConfigKey": "bitrix24-disk",
  "method": "GET",
  "path": "disk.storage.getlist",
  "mode": "offset",
  "maxPages": 10,
  "maxItems": 500
}
```

### Pagination result contract

Return the bounded pages and the tool's termination reason. If a configured page or item bound stops the read, report that bound instead of claiming the provider collection is complete.

For Bitrix24 `offset` pagination, use the provider `next` value as the next request's `start`; stop at provider end or the configured bounds.

Request inputs are strict: relative `path`, ordered `query` pairs, bounded headers/body, and no caller-supplied auth, raw Nango control headers, approval proof, or operation classification fields.

## Operator-only fallback

Keep this compatibility path for diagnostics or deployments where the plugin is unavailable. It requires `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`, Python 3, and `httpx`. An operator must explicitly choose it. Mutations still need approval and post-write verification.

```bash
# Storage list
python3 {baseDir}/scripts/nango_proxy.py call bitrix24-disk disk.storage.getlist --json-output
```

The fallback preserves the full generic HTTP flags documented in `{baseDir}/references/api-reference.md`.

## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
