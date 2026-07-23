---
name: bitrix24-crm
description: "Bitrix24 CRM tasks: Bitrix24 leads, deals, contacts, companies, invoices, SPA."
metadata: {"openclaw":{},"nango":{"family":"bitrix24","provider_config_key":"bitrix24-crm"}}
---

# Bitrix24 CRM

Use this skill when the user requests Bitrix24 leads, deals, contacts, companies, invoices, SPA through the configured Nango connection.

- Route only to `providerConfigKey`: **`bitrix24-crm`**.
- Scopes / access: `crm`
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
  "providerConfigKey": "bitrix24-crm",
  "method": "GET",
  "path": "crm.lead.list",
  "mode": "offset",
  "maxPages": 10,
  "maxItems": 500
}
```

### Deal update

Use `nango_proxy_request` for a deal update:

```json
{
  "providerConfigKey": "bitrix24-crm",
  "method": "POST",
  "path": "crm.deal.update",
  "jsonBody": {
    "id": "<confirmed-deal-id>",
    "fields": {
      "TITLE": "<new-title>"
    }
  }
}
```

After a confirmed update, read the deal through `crm.deal.get` and compare the intended fields. If the outcome is `unknown`, including a dispatched timeout, inspect the same deal before any retry.

### Pagination result contract

Return the bounded pages and the tool's termination reason. If a configured page or item bound stops the read, report that bound instead of claiming the provider collection is complete.

For Bitrix24 `offset` pagination, use the provider `next` value as the next request's `start`; stop at provider end or the configured bounds.

Request inputs are strict: relative `path`, ordered `query` pairs, bounded headers/body, and no caller-supplied auth, raw Nango control headers, approval proof, or operation classification fields.

## Operator-only fallback

Keep this compatibility path for diagnostics or deployments where the plugin is unavailable. It requires `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`, Python 3, and `httpx`. An operator must explicitly choose it. Mutations still need approval and post-write verification.

```bash
# List leads
python3 {baseDir}/scripts/nango_proxy.py call bitrix24-crm crm.lead.list --json-output
# List deals
python3 {baseDir}/scripts/nango_proxy.py call bitrix24-crm crm.deal.list --json-output
```

The fallback preserves the full generic HTTP flags documented in `{baseDir}/references/api-reference.md`.

## Notes

Requires OAuth connection for provider_config_key bitrix24-crm. Primary deal updates use nango_proxy_request with crm.deal.update; after confirmed success, read the deal with crm.deal.get, and after an uncertain dispatch inspect it before retrying.

## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
