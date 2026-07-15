---
name: yandex-id
description: Call Yandex ID (login.info/email/avatar) via Nango proxy after OAuth connect
timeout_sec: 300
required_pip:
  - httpx
required_env:
  - NANGO_PROXY_URL
  - EVOLUTION_PROJECT_ID
  - EVOCLAW_ID
  - CLOUDRU_API_KEY
allowed-tools: Fetch HTTP
metadata:
  openclaw:
    requires:
      env:
        - NANGO_PROXY_URL
        - EVOLUTION_PROJECT_ID
        - EVOCLAW_ID
        - CLOUDRU_API_KEY
    primaryEnv: CLOUDRU_API_KEY
  nango:
    family: yandex
    provider_config_key: yandex-id
---

> **Required env:** `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`  
> **Required pip:** `httpx`  
> **Install only if** this EvoClaw has OAuth connection for `yandex-id` in Cloud.ru console.


## What this skill does

**Yandex ID** — authenticated HTTP via **ai-assistant-nango-proxy** → Nango → provider API.

- Nango `provider_config_key`: **`yandex-id`**
- Scopes / access: `login:info, login:email, login:avatar`
- Upstream base (via Nango): `https://login.yandex.ru`
- Also accepted unique key(s): `yandex`

OpenClaw never sees OAuth tokens or the Nango secret.

## When to use

User asks about Yandex profile, login, email, avatar, or account identity.

Do **not** use for other vendors — install the matching skill (`yandex-*`, `bitrix24-*`, `amocrm-*`).

## Prerequisites

1. User completed OAuth for **`yandex-id`** on this EvoClaw in Cloud.ru console.
2. Env injected (operator / pod): `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`.
3. `pip install httpx` once per session if needed.

Connection end-user id:

```text
project-{EVOLUTION_PROJECT_ID}-evoclaw-{EVOCLAW_ID}
```

## CLI

```bash
# GET profile
python3 {baseDir}/scripts/nango_proxy.py call yandex-id info --query 'format=json' --json-output
# legacy key
python3 {baseDir}/scripts/nango_proxy.py call yandex info --query 'format=json' --json-output
```

Flags: `--method`, `--json`, `--body-file`, `--query`, `--header`, `--timeout`, `--project-id`, `--evoclaw-id`, `--api-key`, `--proxy-url`, `--json-output`.

## Agent workflow

1. Confirm the request matches **Yandex ID** (`yandex-id`).
2. Prefer `python3 {baseDir}/scripts/nango_proxy.py call yandex-id …`.
3. On **401** — API key / IAM; do not invent alternate auth.
4. On **404** — wrong `EVOCLAW_ID`.
5. On upstream **4xx/5xx** — missing/expired OAuth → ask user to reconnect **yandex-id** in console.
6. Never log `CLOUDRU_API_KEY` or tokens.

## Notes

Legacy Nango unique key `yandex` still works if that is what was connected.


## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
