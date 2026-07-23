---
name: yandex-disk
description: "Call Yandex Disk REST API via Nango proxy after OAuth connect"
allowed-tools: Fetch HTTP
metadata:
  openclaw:
    requires:
      env: [NANGO_PROXY_URL, EVOLUTION_PROJECT_ID, EVOCLAW_ID, CLOUDRU_API_KEY]
      bins: [python3]
    primaryEnv: CLOUDRU_API_KEY
  nango:
    family: yandex
    provider_config_key: yandex-disk
---

> **Required env:** `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`  
> **Required pip:** `httpx`  
> **Install only if** this EvoClaw has OAuth connection for `yandex-disk` in Cloud.ru console.

## What this skill does

**Yandex Disk** — authenticated HTTP via **ai-assistant-nango-proxy** → Nango → provider API.

- Nango `provider_config_key`: **`yandex-disk`**
- Scopes / access: `cloud_api:disk.read, cloud_api:disk.write, cloud_api:disk.info, cloud_api:disk.app_folder`
- Upstream base (via Nango): `https://cloud-api.yandex.net`

OpenClaw never sees OAuth tokens or the Nango secret.

## When to use

User asks to list/upload/download files on Yandex Disk.

Do **not** use for other vendors — install the matching skill (`yandex-*`, `bitrix24-*`, `amocrm-*`).

## Prerequisites

1. User completed OAuth for **`yandex-disk`** on this EvoClaw in Cloud.ru console.
2. Env injected (operator / pod): `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`.
3. `pip install httpx` once per session if needed.

Connection end-user id:

```text
project-{EVOLUTION_PROJECT_ID}-evoclaw-{EVOCLAW_ID}
```

## CLI

```bash
# Disk meta
python3 {baseDir}/scripts/nango_proxy.py call yandex-disk v1/disk --json-output
# List root
python3 {baseDir}/scripts/nango_proxy.py call yandex-disk 'v1/disk/resources' --query 'path=/' --json-output
```

Flags: `--method`, `--json`, `--body-file`, `--query`, `--header`, `--timeout`, `--project-id`, `--evoclaw-id`, `--api-key`, `--proxy-url`, `--json-output`.

## Agent workflow

1. Confirm the request matches **Yandex Disk** (`yandex-disk`).
2. Prefer `python3 {baseDir}/scripts/nango_proxy.py call yandex-disk …`.
3. On **401** — API key / IAM; do not invent alternate auth.
4. On **404** — wrong `EVOCLAW_ID`.
5. On upstream **4xx/5xx** — missing/expired OAuth → ask user to reconnect **yandex-disk** in console.
6. Never log `CLOUDRU_API_KEY` or tokens.

## Notes

Docs: https://yandex.com/dev/disk/api/concepts/about.html

## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
