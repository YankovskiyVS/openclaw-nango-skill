---
name: yandex-mail
description: Use Yandex Mail OAuth token (IMAP/SMTP XOAUTH2) obtained via Nango
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
    provider_config_key: yandex-mail
---

> **Required env:** `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`  
> **Required pip:** `httpx`  
> **Install only if** this EvoClaw has OAuth connection for `yandex-mail` in Cloud.ru console.


## What this skill does

**Yandex Mail** — authenticated HTTP via **ai-assistant-nango-proxy** → Nango → provider API.

- Nango `provider_config_key`: **`yandex-mail`**
- Scopes / access: `mail:imap_full, mail:smtp, login:email`
- Upstream base (via Nango): `https://login.yandex.ru (identity); mail via IMAP/SMTP`

OpenClaw never sees OAuth tokens or the Nango secret.

## When to use

User asks to read or send Yandex Mail.

Do **not** use for other vendors — install the matching skill (`yandex-*`, `bitrix24-*`, `amocrm-*`).

## Prerequisites

1. User completed OAuth for **`yandex-mail`** on this EvoClaw in Cloud.ru console.
2. Env injected (operator / pod): `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`.
3. `pip install httpx` once per session if needed.

Connection end-user id:

```text
project-{EVOLUTION_PROJECT_ID}-evoclaw-{EVOCLAW_ID}
```

## CLI

```bash
# Resolve mailbox email
python3 {baseDir}/scripts/nango_proxy.py call yandex-mail info --query 'format=json' --json-output
```

Flags: `--method`, `--json`, `--body-file`, `--query`, `--header`, `--timeout`, `--project-id`, `--evoclaw-id`, `--api-key`, `--proxy-url`, `--json-output`.

## Agent workflow

1. Confirm the request matches **Yandex Mail** (`yandex-mail`).
2. Prefer `python3 {baseDir}/scripts/nango_proxy.py call yandex-mail …`.
3. On **401** — API key / IAM; do not invent alternate auth.
4. On **404** — wrong `EVOCLAW_ID`.
5. On upstream **4xx/5xx** — missing/expired OAuth → ask user to reconnect **yandex-mail** in console.
6. Never log `CLOUDRU_API_KEY` or tokens.

## Notes

HTTP proxy does not speak IMAP. Use token with XOAUTH2 on imap.yandex.com / smtp.yandex.com.


## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
