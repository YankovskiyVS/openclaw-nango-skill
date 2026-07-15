---
name: bitrix24-bizproc
description: Call Bitrix24 business processes / robots REST via Nango proxy
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
    family: bitrix24
    provider_config_key: bitrix24-bizproc
---

> **Required env:** `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`  
> **Required pip:** `httpx`  
> **Install only if** this EvoClaw has OAuth connection for `bitrix24-bizproc` in Cloud.ru console.


## What this skill does

**Bitrix24 Business Processes** — authenticated HTTP via **ai-assistant-nango-proxy** → Nango → provider API.

- Nango `provider_config_key`: **`bitrix24-bizproc`**
- Scopes / access: `bizproc`
- Upstream base (via Nango): `https://{{domain}}/rest`

OpenClaw never sees OAuth tokens or the Nango secret.

## When to use

User asks to start or inspect Bitrix24 workflows, robots, or bizproc.

Do **not** use for other vendors — install the matching skill (`yandex-*`, `bitrix24-*`, `amocrm-*`).

## Prerequisites

1. User completed OAuth for **`bitrix24-bizproc`** on this EvoClaw in Cloud.ru console.
2. Env injected (operator / pod): `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`.
3. `pip install httpx` once per session if needed.

Connection end-user id:

```text
project-{EVOLUTION_PROJECT_ID}-evoclaw-{EVOCLAW_ID}
```

## CLI

```bash
# Workflow templates
python3 {baseDir}/scripts/nango_proxy.py call bitrix24-bizproc bizproc.workflow.template.list --json-output
```

Flags: `--method`, `--json`, `--body-file`, `--query`, `--header`, `--timeout`, `--project-id`, `--evoclaw-id`, `--api-key`, `--proxy-url`, `--json-output`.

## Agent workflow

1. Confirm the request matches **Bitrix24 Business Processes** (`bitrix24-bizproc`).
2. Prefer `python3 {baseDir}/scripts/nango_proxy.py call bitrix24-bizproc …`.
3. On **401** — API key / IAM; do not invent alternate auth.
4. On **404** — wrong `EVOCLAW_ID`.
5. On upstream **4xx/5xx** — missing/expired OAuth → ask user to reconnect **bitrix24-bizproc** in console.
6. Never log `CLOUDRU_API_KEY` or tokens.



## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
