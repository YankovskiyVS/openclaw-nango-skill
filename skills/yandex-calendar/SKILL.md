---
name: yandex-calendar
description: "Yandex Calendar tasks: Yandex Calendar events, availability, or meetings."
metadata: {"openclaw":{},"nango":{"family":"yandex","provider_config_key":"yandex-calendar"}}
---

# Yandex Calendar

Use this skill when the user requests Yandex Calendar events, availability, or meetings through the configured Nango connection.

- Route only to `providerConfigKey`: **`yandex-calendar`**.
- Scopes / access: `calendar:all`
- Upstream base (via Nango): `https://caldav.yandex.ru`

## Workflow

1. Use the exact provider key above; never route by a similar vendor name.
2. Use `nango_proxy_request` for one provider request and `nango_proxy_paginate` only for a registered bounded read contract.
3. Use `nango_action` only for a registered action and `nango_disk_transfer` only for Yandex Disk file transfer.
4. Reads run without a prompt. Every semantic mutation requires one-time approval tied to the exact tool call and parameters.
5. Treat `confirmed` as completed, `not_started` as safe to fix and retry, and `confirmed_failed` as a provider-confirmed failure. For `unknown`, inspect provider state and do not retry blindly.
6. Do not infer the failing layer from HTTP status alone. Return the tool's safe error code and outcome; never expose credentials.

Do not use the Python fallback to bypass approval.

## Typed tools

### CalDAV contract

This is CalDAV, not a JSON calendar API. Use `PROPFIND` for discovery and `REPORT` for bounded event queries; send XML with an explicit XML content type. Example discovery through `nango_proxy_paginate`:

```json
{
  "providerConfigKey": "yandex-calendar",
  "method": "PROPFIND",
  "path": "calendars/",
  "headers": {
    "Depth": "1"
  },
  "textBody": "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:displayname/></d:prop></d:propfind>",
  "contentType": "application/xml; charset=utf-8",
  "mode": "single",
  "maxPages": 1,
  "maxItems": 500
}
```

Creating or changing an `.ics` resource uses a mutating request and must be verified by reading its URL and ETag.

### Pagination result contract

Return the bounded pages and the tool's termination reason. If a configured page or item bound stops the read, report that bound instead of claiming the provider collection is complete.

Request inputs are strict: relative `path`, ordered `query` pairs, bounded headers/body, and no caller-supplied auth, raw Nango control headers, approval proof, or operation classification fields.

## Operator-only fallback

Keep this compatibility path for diagnostics or deployments where the plugin is unavailable. It requires `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`, Python 3, and `httpx`. An operator must explicitly choose it. Mutations still need approval and post-write verification.

```bash
# CalDAV root
python3 {baseDir}/scripts/nango_proxy.py call yandex-calendar calendars/ --method PROPFIND --header 'Depth: 1' --header 'Content-Type: application/xml; charset=utf-8' --text '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>' --json-output
```

The fallback preserves the full generic HTTP flags documented in `{baseDir}/references/api-reference.md`.

## Notes

CalDAV (ICS), not Google Calendar JSON API.

## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
