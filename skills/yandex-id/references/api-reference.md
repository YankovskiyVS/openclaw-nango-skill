# ai-assistant-nango-proxy API reference

Internal service between OpenClaw and Nango OAuth Manager.

## Base URL

| Environment | URL |
| --- | --- |
| Stage (in-cluster) | `http://ai-assistant-nango-proxy.ai-assistant-nango-proxy.svc.cluster.local:8080` |
| Local dev | `http://localhost:8080` (when running `go run ./cmd/ai-assistant-nango-proxy`) |

Env var: `NANGO_PROXY_URL` (no trailing slash).

## Endpoints

### Health

```
GET /health
```

No auth. Returns `{"status":"ok"}`.

### Proxy (all HTTP methods)

```
{METHOD} /api/v1/{project_id}/evo-claws/{evoclaw_id}/proxy/{provider_config_key}/{path}
```

Path parameters:

| Name | Description |
| --- | --- |
| `project_id` | Evolution project UUID (`EVOLUTION_PROJECT_ID`) |
| `evoclaw_id` | EvoClaw instance UUID (`EVOCLAW_ID`) |
| `provider_config_key` | Nango integration key (e.g. `yandex`) |
| `path` | Remainder of URL — upstream provider API path |

Supported methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`.

## Authentication

```
Authorization: Api-Key {CLOUDRU_API_KEY}
```

Also accepted by IAM exchange (not used from OpenClaw): `Basic`, `Bearer`.

Required IAM permission: `ai-agents.systems.invoke`.

## Headers

### Sent by client (optional)

| Header | Purpose |
| --- | --- |
| `Content-Type` | Request body media type |
| `Accept` | Preferred response format |
| `Nango-Proxy-*` | Passthrough to Nango proxy (prefix stripped) |

### Set by proxy (do not send from client)

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer {NANGO_SECRET_KEY}` (server-side) |
| `Provider-Config-Key` | From URL path |
| `Connection-Id` | From template: `project-{project_id}-evoclaw-{evoclaw_id}` |

## Response

Upstream provider response is streamed back unchanged (status, headers, body).

Common proxy-level errors:

| Status | Meaning |
| --- | --- |
| 401 | Missing/invalid API key or insufficient IAM permissions |
| 404 | EvoClaw not found or wrong project |
| 400 | Missing path parameters |
| 500 | Internal / Nango forward failure |

Upstream OAuth errors (examples from Nango) often appear as 401/403/424 with provider JSON body — usually means no connection or expired token.

## Connection lifecycle

1. User connects a provider in Cloud.ru console for this EvoClaw.
2. Nango stores tokens keyed by `provider_config_key` + connection id derived from project and EvoClaw ids.
3. OpenClaw calls this proxy; proxy resolves connection id and forwards to Nango `/proxy/{upstream_path}`.

OpenClaw cannot create or revoke OAuth connections — that remains a console / BFF concern.

## Security notes

- Never expose `CLOUDRU_API_KEY`, OAuth tokens, or Nango secret in logs or chat.
- Do not attempt to override `Connection-Id` — the proxy ignores client-supplied values by design.
- Provider API paths should be validated before calling; avoid SSRF-style user-controlled full URLs (only path segment after provider key is accepted).
