---
name: nango-connector
description: Call third-party APIs (Yandex, Google, etc.) via ai-assistant-nango-proxy using OAuth connections managed by Nango
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
---

> **Required env:** `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`
> **Required pip:** `httpx`

## What this skill does

Routes authenticated HTTP calls from OpenClaw to external SaaS APIs through **ai-assistant-nango-proxy**. The proxy:

- validates the project API key via IAM (`ai-agents.systems.invoke`);
- checks that the EvoClaw instance exists;
- builds the Nango `Connection-Id` as `project-{project_id}-evoclaw-{evoclaw_id}`;
- forwards the request to Nango OAuth Manager `/proxy/*` with the server-side secret key.

OpenClaw never sees OAuth tokens or the Nango secret key.

## When to use

- Read or write data in a connected third-party service (calendar, mail, CRM, etc.).
- The user mentions Yandex, Google, Slack, or any integration configured in Nango.
- The user asks to "call the API", "fetch events", "send a message" through an OAuth-connected service.
- You need to integrate with an external API and a Nango connection already exists for this EvoClaw.

Do **not** use this skill for Cloud.ru platform APIs — use the dedicated `cloudru-*` skills instead.

## Prerequisites

1. **OAuth connection** must exist for this EvoClaw and provider. The connection is bound to end-user id:
   ```
   project-{EVOLUTION_PROJECT_ID}-evoclaw-{EVOCLAW_ID}
   ```
   If the user has not connected the service yet, tell them to complete OAuth in the Cloud.ru console (connect flow for this EvoClaw).

2. **Environment variables** (injected by the EvoClaw operator):

   | Variable | Purpose |
   | --- | --- |
   | `NANGO_PROXY_URL` | Base URL of ai-assistant-nango-proxy (no trailing slash) |
   | `EVOLUTION_PROJECT_ID` | Cloud.ru project UUID |
   | `EVOCLAW_ID` | This EvoClaw instance UUID |
   | `CLOUDRU_API_KEY` | Project API key for `Authorization: Api-Key …` |

   Stage internal default (when `NANGO_PROXY_URL` is unset locally):
   `http://ai-assistant-nango-proxy.ai-assistant-nango-proxy.svc.cluster.local:8080`

3. Install dependency once per session:
   ```bash
   pip install httpx
   ```

## API shape

```
{method} {NANGO_PROXY_URL}/api/v1/{project_id}/evo-claws/{evoclaw_id}/proxy/{provider_config_key}/{upstream_path}
Authorization: Api-Key {CLOUDRU_API_KEY}
```

- `{provider_config_key}` — Nango integration unique key (e.g. `yandex`, `google`).
- `{upstream_path}` — provider REST path **without** leading slash (e.g. `info` for Yandex ID, `gmail/v1/users/me/messages` for Google).
- Request body, `Content-Type`, and `Accept` are forwarded as-is.
- Optional passthrough headers: `Nango-Proxy-*` (stripped prefix, forwarded to Nango).

**Do not** send `Connection-Id`, `Provider-Config-Key`, or Nango secret headers — the proxy sets them.

There is **no** live “list connected integrations” API for the agent: use `./references/providers.md` for possible keys, and treat call failures as “not connected / reconnect in console”.

## CLI helper

Use the bundled script from `{baseDir}`:

```bash
# Smoke — Yandex ID profile (current stage integration)
python3 {baseDir}/scripts/nango_proxy.py call yandex info \
  --query 'format=json' \
  --json-output

# Google Gmail (only if google OAuth is connected + scoped)
python3 {baseDir}/scripts/nango_proxy.py call google gmail/v1/users/me/messages \
  --query 'maxResults=5' \
  --header 'Accept: application/json'

# POST with JSON body
python3 {baseDir}/scripts/nango_proxy.py call google calendar/v3/calendars/primary/events \
  --method POST \
  --json '{"summary":"Meeting","start":{"dateTime":"2026-07-15T10:00:00+03:00"},"end":{"dateTime":"2026-07-15T11:00:00+03:00"}}'

# Override env for one call
python3 {baseDir}/scripts/nango_proxy.py call yandex info \
  --query 'format=json' \
  --project-id <uuid> --evoclaw-id <uuid> --api-key <key> \
  --proxy-url http://localhost:8080
```

Flags: `--method`, `--json`, `--body-file`, `--query`, `--header`, `--timeout`, `--project-id`, `--evoclaw-id`, `--api-key`, `--proxy-url`, `--json-output` (machine-readable envelope).

Exit codes: `0` on HTTP 2xx, `1` on HTTP error or transport failure.

## Workflow for the agent

1. Identify the **provider** (`provider_config_key`) and **upstream API path** from the user's request.
2. Check `./references/providers.md` for known providers and example paths.
3. Prefer `python3 {baseDir}/scripts/nango_proxy.py call …` over hand-written curl.
4. On **401** from proxy — API key or IAM permission issue; do not retry with different auth.
5. On **404** — EvoClaw id mismatch or instance not found; verify `EVOCLAW_ID`.
6. On **4xx/5xx** from upstream (passed through) — parse provider error body; common cause is missing OAuth connection or expired refresh token → ask user to reconnect in console.
7. Never log or echo `CLOUDRU_API_KEY` or response tokens.

## Direct HTTP (when CLI is not suitable)

```bash
curl -sS -X GET \
  "${NANGO_PROXY_URL}/api/v1/${EVOLUTION_PROJECT_ID}/evo-claws/${EVOCLAW_ID}/proxy/yandex/info?format=json" \
  -H "Authorization: Api-Key ${CLOUDRU_API_KEY}" \
  -H "Accept: application/json"
```

## References

- `{baseDir}/references/providers.md` — provider keys and example endpoints
- `{baseDir}/references/api-reference.md` — full proxy contract, headers, error codes

## Limitations

- Only providers configured in Nango for this environment are available.
- OAuth connect/disconnect lifecycle is handled in the Cloud.ru console, not by this skill.
- Large file uploads/downloads: stream via `--body-file`; default timeout is 300s.
- Rate limits and quotas are enforced by the upstream provider, not the proxy.
