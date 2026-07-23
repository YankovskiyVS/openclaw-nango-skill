---
name: yandex-disk
description: "Yandex Disk tasks: list/upload/download files on Yandex Disk."
metadata: {"openclaw":{},"nango":{"family":"yandex","provider_config_key":"yandex-disk"}}
---

# Yandex Disk

Use this skill when the user requests list/upload/download files on Yandex Disk through the configured Nango connection.

- Route only to `providerConfigKey`: **`yandex-disk`**.
- Scopes / access: `cloud_api:disk.read, cloud_api:disk.write, cloud_api:disk.info, cloud_api:disk.app_folder`
- Upstream base (via Nango): `https://cloud-api.yandex.net`

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
  "providerConfigKey": "yandex-disk",
  "method": "GET",
  "path": "v1/disk/resources",
  "query": [
    {
      "name": "path",
      "value": "/"
    }
  ],
  "mode": "offset",
  "maxPages": 10,
  "maxItems": 500
}
```

### Disk-specific calls

Use `nango_proxy_paginate` for bounded metadata listings. Use `nango_disk_transfer` for file bytes:

```json
{
  "providerConfigKey": "yandex-disk",
  "direction": "upload",
  "localPath": "/allowed/root/report.csv",
  "remotePath": "disk:/report.csv",
  "overwrite": false
}
```

Upload and download are mutations because they write either remote or local state. After upload, read `v1/disk/resources` for the remote path and compare metadata.

### Pagination result contract

Return the bounded pages and the tool's termination reason. If a configured page or item bound stops the read, report that bound instead of claiming the provider collection is complete.

Request inputs are strict: relative `path`, ordered `query` pairs, bounded headers/body, and no caller-supplied auth, raw Nango control headers, approval proof, or operation classification fields.

## Operator-only fallback

Keep this compatibility path for diagnostics or deployments where the plugin is unavailable. It requires `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`, Python 3, and `httpx`. An operator must explicitly choose it. Mutations still need approval and post-write verification.

```bash
# Disk meta
python3 {baseDir}/scripts/nango_proxy.py call yandex-disk v1/disk --json-output
# List root
python3 {baseDir}/scripts/nango_proxy.py call yandex-disk 'v1/disk/resources' --query 'path=/' --json-output
```

The fallback preserves the full generic HTTP flags documented in `{baseDir}/references/api-reference.md`.

## Notes

Docs: https://yandex.com/dev/disk/api/concepts/about.html

## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
