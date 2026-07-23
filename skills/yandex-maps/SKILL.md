---
name: yandex-maps
description: "Yandex Maps tasks: Yandex Maps bookmarks / saved places (msps:public_bookmarks)."
metadata: {"openclaw":{},"nango":{"family":"yandex","provider_config_key":"yandex-maps"}}
---

# Yandex Maps

Use this skill when the user requests Yandex Maps bookmarks / saved places (msps:public_bookmarks) through the configured Nango connection.

- Route only to `providerConfigKey`: **`yandex-maps`**.
- Scopes / access: `msps:public_bookmarks`
- Upstream base (via Nango): `No verified public bookmarks REST base`

## Workflow

1. Use the exact provider key above; never route by a similar vendor name.
2. Use `nango_proxy_request` for one provider request and `nango_proxy_paginate` only for a registered bounded read contract.
3. Use `nango_action` only for a registered action and `nango_disk_transfer` only for Yandex Disk file transfer.
4. Reads run without a prompt. Every semantic mutation requires one-time approval tied to the exact tool call and parameters.
5. Treat `confirmed` as completed, `not_started` as safe to fix and retry, and `confirmed_failed` as a provider-confirmed failure. For `unknown`, inspect provider state and do not retry blindly.
6. Do not infer the failing layer from HTTP status alone. Return the tool's safe error code and outcome; never expose credentials.

Do not use the Python fallback to bypass approval.

## Typed tools

### Unsupported endpoint boundary

No public bookmarks endpoint is confirmed for the declared scope. Do not invent `v1/`, a host, or a response schema. Do not call `nango_proxy_request` until the operator supplies a documented endpoint for the connected Maps product; otherwise report the capability as unsupported.

Request inputs are strict: relative `path`, ordered `query` pairs, bounded headers/body, and no caller-supplied auth, raw Nango control headers, approval proof, or operation classification fields.

## Operator-only fallback

Keep this compatibility path for diagnostics or deployments where the plugin is unavailable. It requires `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`, Python 3, and `httpx`. An operator must explicitly choose it. Mutations still need approval and post-write verification.

No catalog fallback command is published for this unavailable product contract. The generic client remains packaged for an operator-supplied documented path.

The fallback preserves the full generic HTTP flags documented in `{baseDir}/references/api-reference.md`.

## Notes

No public bookmarks route is confirmed. Keep generic HTTP capability available for an operator-supplied documented product endpoint, but never invent a path or schema.

## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
