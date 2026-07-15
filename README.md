# openclaw-nango-skill

Marketplace of **granular OpenClaw skills** for Nango integrations (Yandex, Bitrix24, amoCRM, …).

Each skill maps 1:1 to a Nango `provider_config_key`. Install **only** skills for OAuth integrations the user connected on this EvoClaw — not the whole tree.

Agent never sees OAuth tokens or Nango secrets — only proxy URL and project API key.

## Layout

```text
openclaw-nango-skill/
  CATALOG.md              # install matrix: skill ↔ provider_config_key
  _shared/                # source of truth for CLI + API docs
    scripts/nango_proxy.py
    references/api-reference.md
  scripts/generate_skills.py
  skills/
    yandex-disk/          # one directory = one installable skill
      SKILL.md
      scripts/nango_proxy.py
      references/…
    bitrix24-crm/
    amocrm-crm/
    …
```

Regenerate skill packages after editing the catalog:

```bash
python3 scripts/generate_skills.py
```

## Install rule

| User connected in console | Install skill dir |
| --- | --- |
| Yandex Disk | `skills/yandex-disk/` |
| Bitrix24 CRM | `skills/bitrix24-crm/` |
| amoCRM deals | `skills/amocrm-crm/` |
| … | see [CATALOG.md](CATALOG.md) |

Copy each chosen directory into the agent skills workspace, e.g.:

```text
…/.openclaw/workspace/<agent>/skills/yandex-disk/
…/.openclaw/workspace/<agent>/skills/bitrix24-crm/
```

Do **not** install skills for providers without a completed OAuth connection.

## Required env

| Variable | Required | Notes |
| --- | --- | --- |
| `NANGO_PROXY_URL` | yes | Base URL proxy **without** trailing slash |
| `EVOLUTION_PROJECT_ID` | yes | Project UUID |
| `EVOCLAW_ID` | yes | This EvoClaw UUID |
| `CLOUDRU_API_KEY` | yes | Project API key; IAM `ai-agents.systems.invoke` |

Stage (in-cluster):

```text
NANGO_PROXY_URL=http://ai-assistant-nango-proxy.ai-assistant-nango-proxy.svc.cluster.local:8080
```

If `NANGO_PROXY_URL` is unset, the CLI defaults to that stage URL.

Connection id in Nango:

```text
project-{EVOLUTION_PROJECT_ID}-evoclaw-{EVOCLAW_ID}
```

Skills only **call** the proxy; they do not create or revoke OAuth.

## How connected providers are known

There is no live “what is connected” list inside the skill.

- Which skill to ship: driven by console OAuth + [CATALOG.md](CATALOG.md).
- At call time: proxy looks up the connection; missing OAuth → error → agent asks the user to reconnect that `provider_config_key` in console.

## Smoke test

With env set and Yandex ID OAuth connected:

```bash
cd skills/yandex-id
python3 scripts/nango_proxy.py call yandex-id info \
  --query 'format=json' \
  --json-output
```

(`yandex` is an alias of `yandex-id` where configured.)

## API shape

```text
{METHOD} {NANGO_PROXY_URL}/api/v1/{project_id}/evo-claws/{evoclaw_id}/proxy/{provider_config_key}/{upstream_path}
Authorization: Api-Key {CLOUDRU_API_KEY}
```

Details: `_shared/references/api-reference.md` (copied into each skill).

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `Missing required value: …` | Env / CLI override missing |
| HTTP 401 from proxy | API key / IAM `ai-agents.systems.invoke` |
| HTTP 404 from proxy | Wrong `EVOCLAW_ID` / evo-claw not found |
| `nango connection not found` | OAuth not finished or webhook did not store connection |
| Timeout | No network / Istio egress to nango-proxy |
| Upstream 4xx | Wrong provider path or expired token → reconnect |

## Dependency

Python 3 + `httpx` (`required_pip` in each `SKILL.md`).
