---
name: yandex-direct
description: "Yandex Direct tasks: Yandex Direct campaigns, ads, or reports."
metadata: {"openclaw":{},"nango":{"family":"yandex","provider_config_key":"yandex-direct"}}
---

# Yandex Direct

Use this skill when the user requests Yandex Direct campaigns, ads, or reports through the configured Nango connection.

- Route only to `providerConfigKey`: **`yandex-direct`**.
- Scopes / access: `direct:api`
- Upstream base (via Nango): `https://api.direct.yandex.com`

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
```

### JSON-RPC semantics

Yandex Direct reads use HTTP `POST`. A body with `"method": "get"` on `json/v5/<service>` is a semantic read; other methods are mutations and require approval. For bounded listing, use `nango_proxy_paginate` with `body-offset` and preserve the request's `Page.Limit`.

Use `nango_proxy_request` for a Direct mutation. After a confirmed mutation, read the campaign with a `get` request and compare the intended fields. If the outcome is `unknown`, including a dispatched timeout, inspect campaign state before any retry.

### Pagination result contract

Return the bounded pages and the tool's termination reason. If a configured page or item bound stops the read, report that bound instead of claiming the provider collection is complete.

For Yandex Direct `body-offset` pagination, advance `Page.Offset` by the preserved `Page.Limit`. Return the terminal page and the termination reason.

Request inputs are strict: relative `path`, ordered `query` pairs, bounded headers/body, and no caller-supplied auth, raw Nango control headers, approval proof, or operation classification fields.

## Operator-only fallback

Keep this compatibility path for diagnostics or deployments where the plugin is unavailable. It requires `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`, Python 3, and `httpx`. An operator must explicitly choose it. Mutations still need approval and post-write verification.

```bash
# JSON v5 campaigns
python3 {baseDir}/scripts/nango_proxy.py call yandex-direct json/v5/campaigns --method POST --json '{"method":"get","params":{"SelectionCriteria":{},"FieldNames":["Id","Name"]}}' --json-output
```

The fallback preserves the full generic HTTP flags documented in `{baseDir}/references/api-reference.md`.

## Notes

Nango injects the provider credential. The caller must not supply or override auth and Nango control headers. After a confirmed Direct mutation, read the campaign and compare intended fields; after an uncertain dispatch, inspect campaign state before retrying.

## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
