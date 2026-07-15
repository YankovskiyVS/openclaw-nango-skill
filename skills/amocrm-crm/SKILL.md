---
name: amocrm-crm
description: Call amoCRM deals/contacts/pipelines via Nango proxy
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
    provider_config_key: amocrm-crm
---

> **Required env:** `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`  
> **Required pip:** `httpx`  
> **Install only if** this EvoClaw has OAuth connection for `amocrm-crm` in Cloud.ru console.


## What this skill does

**amoCRM Deals & Pipeline** — authenticated HTTP via **ai-assistant-nango-proxy** → Nango → provider API.

- Nango `provider_config_key`: **`amocrm-crm`**
- Scopes / access: `account data (selected in amoМаркет)`
- Upstream base (via Nango): `https://{{subdomain}}.amocrm.ru`

OpenClaw never sees OAuth tokens or the Nango secret.

## When to use

User asks about amoCRM deals, contacts, companies, pipelines, stages.

Do **not** use for other vendors — install the matching skill (`yandex-*`, `bitrix24-*`, `amocrm-*`).

## Prerequisites

1. User completed OAuth for **`amocrm-crm`** on this EvoClaw in Cloud.ru console.
2. Env injected (operator / pod): `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`.
3. `pip install httpx` once per session if needed.

Connection end-user id:

```text
project-{EVOLUTION_PROJECT_ID}-evoclaw-{EVOCLAW_ID}
```

## CLI

```bash
# Leads
python3 {baseDir}/scripts/nango_proxy.py call amocrm-crm api/v4/leads --json-output
# Contacts
python3 {baseDir}/scripts/nango_proxy.py call amocrm-crm api/v4/contacts --json-output
```

Flags: `--method`, `--json`, `--body-file`, `--query`, `--header`, `--timeout`, `--project-id`, `--evoclaw-id`, `--api-key`, `--proxy-url`, `--json-output`.

## Agent workflow

1. Confirm the request matches **amoCRM Deals & Pipeline** (`amocrm-crm`).
2. Prefer `python3 {baseDir}/scripts/nango_proxy.py call amocrm-crm …`.
3. On **401** — API key / IAM; do not invent alternate auth.
4. On **404** — wrong `EVOCLAW_ID`.
5. On upstream **4xx/5xx** — missing/expired OAuth → ask user to reconnect **amocrm-crm** in console.
6. Never log `CLOUDRU_API_KEY` or tokens.



## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
