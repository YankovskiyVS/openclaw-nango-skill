# ai-assistant-nango-proxy API reference

The Cloud.ru proxy is the internal service between OpenClaw and Nango OAuth
Manager. Skill packages also contain typed plugin guidance and an operator-only
Python compatibility client.

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

Supported fallback methods: `GET`, `HEAD`, `OPTIONS`, `POST`, `PUT`, `PATCH`,
`DELETE`, `PROPFIND`, and `REPORT`.

## Operator-only Python fallback

The compatibility client is `{baseDir}/scripts/nango_proxy.py`. An operator must
explicitly choose this path when the plugin is unavailable:

```bash
python3 {baseDir}/scripts/nango_proxy.py [common options] call PROVIDER PATH [call options]
python3 {baseDir}/scripts/nango_proxy.py [common options] health
```

Common options:

| Flag | Purpose |
| --- | --- |
| `--proxy-url` | Override `NANGO_PROXY_URL` |
| `--project-id` | Override `EVOLUTION_PROJECT_ID` |
| `--evoclaw-id` | Override `EVOCLAW_ID` |
| `--api-key-file` | Read a Cloud.ru API key from a bounded UTF-8 file |
| `--api-key` | Deprecated secret-in-arguments override; do not use in normal operation |
| `--timeout` | Set a bounded request timeout in seconds |

The `call` subcommand accepts:

| Flag | Purpose |
| --- | --- |
| `--method` | Select one of the supported methods above; default `GET` |
| `--query` | Supply a query string; repeated parameter names are preserved |
| `--header` | Add a safe provider header; repeat the flag for multiple headers |
| `--json` | Send one JSON body |
| `--text` | Send one UTF-8 text body |
| `--body-file` | Send one bounded raw body from a local file |
| `--json-output` | Return a bounded structured result envelope |

`--json`, `--text`, and `--body-file` are mutually exclusive. Authentication,
routing, method-override, hop-by-hop, and nested Nango control headers are
rejected. The fallback is generic HTTP compatibility, not a replacement for
typed pagination, actions, or Disk transfer.

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

## Typed plugin tools

### `nango_proxy_request`

Send one request to a catalog provider and a relative provider path. It supports
the same method set listed above, ordered query pairs, safe provider headers,
and exactly one JSON, text, or base64 body. Use it for one-shot reads and
mutations, including Bitrix24 method-style endpoints, Direct JSON RPC, and
CalDAV.

### `nango_proxy_paginate`

Use only for registered semantic reads. Every call has bounded `maxPages` and
`maxItems` and returns the pages plus a termination reason:

- `offset`: advance a query offset. For Bitrix24, consume the provider `next`
  value as the next request's `start`.
- `link`: follow only a verified same-origin next link, as required by amoCRM.
  The tool validates an absolute response link and forwards only its relative
  path and query.
- `body-offset`: advance Yandex Direct `Page.Offset` while preserving
  `Page.Limit`; return the terminal page when the provider ends the listing.
- `single`: return one bounded page for non-pageable registered reads.

If a configured bound stops the operation, report that bound instead of
claiming that the full provider collection was returned.

### `nango_action`

Run only a registered action. Yandex Mail mailbox operations and amoCRM Chats
`send-message` use this surface because their fixed protocol adapters cannot be
represented as generic provider HTTP. Read actions do not prompt; mutating
actions require one-time approval.

### `nango_disk_transfer`

Stream a Yandex Disk upload or download without exposing the transfer URL.
Every transfer writes local or provider state, requires one-time approval, and
returns bounded transfer metadata. After an upload, read the remote resource
metadata and compare it with the intended transfer.

## Approval and outcomes

The typed plugin requests exact one-time approval for semantic mutations,
including send, update, delete, upload, and download. Approval is tied to the
tool name and exact validated parameters. Reads run without a prompt.

Typed results use these outcomes:

- `confirmed`: the provider-confirmed operation completed; perform any required
  post-write read.
- `not_started`: validation or connection failed before dispatch; fix the input
  before retrying.
- `confirmed_failed`: the provider confirmed failure; report the safe error.
- `unknown`: dispatch may have happened; inspect provider state before any
  retry.

The operator-only Python fallback does not enforce the plugin approval proof.
Do not use it to bypass approval. The operator must obtain approval for semantic
mutations and perform the same post-write or unknown-outcome verification
outside the plugin.

## Security notes

- Never expose `CLOUDRU_API_KEY`, OAuth tokens, or Nango secret in logs or chat.
- Do not attempt to override `Connection-Id` — the proxy ignores client-supplied values by design.
- Provider API paths should be validated before calling; avoid SSRF-style user-controlled full URLs (only path segment after provider key is accepted).
