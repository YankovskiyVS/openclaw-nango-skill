---
name: amocrm-users
description: Call amoCRM users / account structure via Nango proxy
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
    family: amocrm
    provider_config_key: amocrm-users
---

> **Required env:** `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`  
> **Required pip:** `httpx`  
> **Install only if** this EvoClaw has OAuth connection for `amocrm-users` in Cloud.ru console.


## What this skill does

**amoCRM Users & Structure** — authenticated HTTP via **ai-assistant-nango-proxy** → Nango → provider API.

- Nango `provider_config_key`: **`amocrm-users`**
- Scopes / access: `account data`
- Upstream base (via Nango): `https://{{subdomain}}.amocrm.ru`

OpenClaw never sees OAuth tokens or the Nango secret.

## When to use

User asks about amoCRM managers, groups, account users.

Do **not** use for other vendors — install the matching skill (`yandex-*`, `bitrix24-*`, `amocrm-*`).

## Prerequisites

1. User completed OAuth for **`amocrm-users`** on this EvoClaw in Cloud.ru console.
2. Env injected (operator / pod): `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`.
3. `pip install httpx` once per session if needed.

Connection end-user id:

```text
project-{EVOLUTION_PROJECT_ID}-evoclaw-{EVOCLAW_ID}
```

## CLI

```bash
# Users
python3 {baseDir}/scripts/nango_proxy.py call amocrm-users api/v4/users --json-output
```

Flags: `--method`, `--json`, `--body-file`, `--query`, `--header`, `--timeout`, `--project-id`, `--evoclaw-id`, `--api-key`, `--proxy-url`, `--json-output`.

## Agent workflow

1. Confirm the request matches **amoCRM Users & Structure** (`amocrm-users`).
2. Prefer `python3 {baseDir}/scripts/nango_proxy.py call amocrm-users …`.
3. On **401** — API key / IAM; do not invent alternate auth.
4. On **404** — wrong `EVOCLAW_ID`.
5. On upstream **4xx/5xx** — missing/expired OAuth → ask user to reconnect **amocrm-users** in console.
6. Never log `CLOUDRU_API_KEY` or tokens.



## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
