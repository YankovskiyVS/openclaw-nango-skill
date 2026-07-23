---
name: yandex-calendar
description: "Call Yandex Calendar CalDAV API via Nango proxy after OAuth connect"
allowed-tools: Fetch HTTP
metadata:
  openclaw:
    requires:
      env: [NANGO_PROXY_URL, EVOLUTION_PROJECT_ID, EVOCLAW_ID, CLOUDRU_API_KEY]
      bins: [python3]
    primaryEnv: CLOUDRU_API_KEY
  nango:
    family: yandex
    provider_config_key: yandex-calendar
---

> **Required env:** `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`  
> **Required pip:** `httpx`  
> **Install only if** this EvoClaw has OAuth connection for `yandex-calendar` in Cloud.ru console.

## What this skill does

**Yandex Calendar** — authenticated HTTP via **ai-assistant-nango-proxy** → Nango → provider API.

- Nango `provider_config_key`: **`yandex-calendar`**
- Scopes / access: `calendar:all`
- Upstream base (via Nango): `https://caldav.yandex.ru`

OpenClaw never sees OAuth tokens or the Nango secret.

## When to use

User asks about Yandex Calendar events, availability, or meetings.

Do **not** use for other vendors — install the matching skill (`yandex-*`, `bitrix24-*`, `amocrm-*`).

## Prerequisites

1. User completed OAuth for **`yandex-calendar`** on this EvoClaw in Cloud.ru console.
2. Env injected (operator / pod): `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`.
3. `pip install httpx` once per session if needed.

Connection end-user id:

```text
project-{EVOLUTION_PROJECT_ID}-evoclaw-{EVOCLAW_ID}
```

## CLI

```bash
# CalDAV root
python3 {baseDir}/scripts/nango_proxy.py call yandex-calendar calendars/ --json-output
```

Flags: `--method`, `--json`, `--body-file`, `--query`, `--header`, `--timeout`, `--project-id`, `--evoclaw-id`, `--api-key`, `--proxy-url`, `--json-output`.

## Agent workflow

1. Confirm the request matches **Yandex Calendar** (`yandex-calendar`).
2. Prefer `python3 {baseDir}/scripts/nango_proxy.py call yandex-calendar …`.
3. On **401** — API key / IAM; do not invent alternate auth.
4. On **404** — wrong `EVOCLAW_ID`.
5. On upstream **4xx/5xx** — missing/expired OAuth → ask user to reconnect **yandex-calendar** in console.
6. Never log `CLOUDRU_API_KEY` or tokens.

## Notes

CalDAV (ICS), not Google Calendar JSON API.

## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
