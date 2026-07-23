# Yandex Disk

- **Skill id:** `yandex-disk`
- **Nango provider_config_key:** `yandex-disk`
- **Family:** `yandex`
- **Scopes:** cloud_api:disk.read, cloud_api:disk.write, cloud_api:disk.info, cloud_api:disk.app_folder
- **Upstream base:** `https://cloud-api.yandex.net`

## Operations

### Disk meta

- **Operation name:** `Disk meta`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `v1/disk`
- **Request shape:** method and relative path; see the exact typed arguments below.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Return only the confirmed disk metadata response.
- **Authoritative docs:** [verified provider documentation](https://yandex.com/dev/disk/api/concepts/about.html)

#### Typed tool call

```json
{
  "tool": "nango_proxy_request",
  "arguments": {
    "providerConfigKey": "yandex-disk",
    "method": "GET",
    "path": "v1/disk"
  }
}
```

### List root

- **Operation name:** `List root`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `v1/disk/resources`
- **Request shape:** method and relative path, ordered `query` name/value pairs; see the exact typed arguments below.
- **Pagination:** `offset` with `maxPages=10` and `maxItems=500`; report the termination reason.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Return bounded resource pages and the pagination termination reason.
- **Authoritative docs:** [verified provider documentation](https://yandex.com/dev/disk/api/concepts/about.html)

#### Typed tool call

```json
{
  "tool": "nango_proxy_paginate",
  "arguments": {
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
}
```

### Upload file

- **Operation name:** `Upload file`
- **Availability:** `template`
- **Method:** Not applicable — the transfer tool owns its provider phases.
- **Path:** Not applicable — use typed `localPath` and `remotePath`; never supply a presigned URL.
- **Request shape:** Typed direction, configured-root local path, provider-relative remote path, and overwrite flag.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `mutation` — one-time approval is required before execution.
- **Verification:** After transfer success, read v1/disk/resources for disk:/report.csv and compare remote path and size; compare checksum only when the provider response includes one.
- **Authoritative docs:** [verified provider documentation](https://yandex.com/dev/disk/api/concepts/about.html)

This is a **non-executable template**. Replace every `REPLACE_WITH_...` value with a confirmed value inside the configured runtime boundary before execution.

#### Typed tool call

```json
{
  "tool": "nango_disk_transfer",
  "arguments": {
    "providerConfigKey": "yandex-disk",
    "direction": "upload",
    "localPath": "/REPLACE_WITH_CONFIGURED_UPLOAD_ROOT/report.csv",
    "remotePath": "disk:/report.csv",
    "overwrite": false
  }
}
```

### Download file

- **Operation name:** `Download file`
- **Availability:** `template`
- **Method:** Not applicable — the transfer tool owns its provider phases.
- **Path:** Not applicable — use typed `localPath` and `remotePath`; never supply a presigned URL.
- **Request shape:** Typed direction, configured-root local path, provider-relative remote path, and overwrite flag.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `mutation` — one-time approval is required before execution.
- **Verification:** Require the confirmed transfer size and sha256, then verify the final local file inside the configured download root.
- **Authoritative docs:** [verified provider documentation](https://yandex.com/dev/disk/api/concepts/about.html)

This is a **non-executable template**. Replace every `REPLACE_WITH_...` value with a confirmed value inside the configured runtime boundary before execution.

#### Typed tool call

```json
{
  "tool": "nango_disk_transfer",
  "arguments": {
    "providerConfigKey": "yandex-disk",
    "direction": "download",
    "localPath": "/REPLACE_WITH_CONFIGURED_DOWNLOAD_ROOT/report.csv",
    "remotePath": "disk:/report.csv",
    "overwrite": false
  }
}
```

## Notes

Docs: https://yandex.com/dev/disk/api/concepts/about.html
