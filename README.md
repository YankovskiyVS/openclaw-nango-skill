# openclaw-nango-skill

OpenClaw skill **`nango-connector`**: вызовы сторонних API (Yandex, Google, …) через **ai-assistant-nango-proxy** и OAuth-коннекты Nango.

Агент **не** видит OAuth-токены и Nango secret key — только proxy URL и project API key.

## Layout

```
nango-connector/
  SKILL.md                 # инструкция для агента (frontmatter + workflow)
  scripts/nango_proxy.py   # CLI helper
  references/
    providers.md           # provider_config_key и примеры путей
    api-reference.md       # контракт proxy
```

Этот репозиторий — дистрибутив скилла для установки в EvoClaw / OpenClaw. Исходник рядом с proxy: `ai-assistant-nango-proxy/.openclaw/nango-connector/`.

## Required env

| Variable | Required | Notes |
| --- | --- | --- |
| `NANGO_PROXY_URL` | yes | Base URL proxy **без** trailing slash |
| `EVOLUTION_PROJECT_ID` | yes | UUID проекта (часто уже есть в pod OpenClaw) |
| `EVOCLAW_ID` | yes | UUID этого EvoClaw |
| `CLOUDRU_API_KEY` | yes | Project API key; IAM `ai-agents.systems.invoke` |

Stage (in-cluster):

```text
NANGO_PROXY_URL=http://ai-assistant-nango-proxy.ai-assistant-nango-proxy.svc.cluster.local:8080
```

Если `NANGO_PROXY_URL` не задан, CLI использует тот же stage URL по умолчанию.

## Install into OpenClaw

1. Скопировать каталог `nango-connector/` в skills workspace агента (рядом с другими skills), например:
   ```text
   …/.openclaw/workspace/<agent>/skills/nango-connector/
   ```
   или в bundled skills, если ваш init подхватывает bundled каталог.

2. Прокинуть в pod OpenClaw недостающие env (`NANGO_PROXY_URL`, `EVOCLAW_ID`).  
   `EVOLUTION_PROJECT_ID` и `CLOUDRU_API_KEY` обычно уже выставляет evoclaw-operator.

3. Один раз в сессии (если pip ещё не поставил зависимость):
   ```bash
   pip install httpx
   ```

4. OAuth для нужного провайдера должен быть выполнен в Cloud.ru console для **этого** EvoClaw. Connection id в Nango строится как:
   ```text
   project-{EVOLUTION_PROJECT_ID}-evoclaw-{EVOCLAW_ID}
   ```

Скилл **не** создаёт и не отключает OAuth — только вызывает proxy.

## How the agent learns connected providers

**Живого списка «что подключено» нет.**

- Возможные провайдеры: `nango-connector/references/providers.md` (статический каталог).
- Факт connection: только в момент вызова. Proxy ищет запись в evoclaw-manager, иначе в Nango по `end_user.id`. Нет коннекта → ошибка → агент просит reconnect в console.

## Smoke test

Из pod с выставленными env:

```bash
cd nango-connector
python3 scripts/nango_proxy.py call yandex info \
  --query 'format=json' \
  --json-output
```

Ожидается HTTP 200 и JSON профиля Yandex ID (`login`, `default_email`, …).

Для текущего stage-интеграции `yandex` это единственный стабильный путь. Calendar / Translate — **другие** интеграции (см. `providers.md`).

## API shape

```text
{METHOD} {NANGO_PROXY_URL}/api/v1/{project_id}/evo-claws/{evoclaw_id}/proxy/{provider_config_key}/{upstream_path}
Authorization: Api-Key {CLOUDRU_API_KEY}
```

Не передавать `Connection-Id` / Nango secret — их выставляет proxy.

Подробности: `nango-connector/references/api-reference.md`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `Missing required value: …` | Не задан env / CLI override |
| HTTP 401 from proxy | API key / IAM `ai-agents.systems.invoke` |
| HTTP 404 from proxy | Неверный `EVOCLAW_ID` / evo-claw не найден |
| `nango connection not found` | OAuth не завершён или webhook не записал connection |
| Timeout | Нет сети / Istio egress до nango-proxy |
| Upstream 4xx | Неверный path провайдера или протухший токен → reconnect |

## Dependency

- Python 3 + `httpx` (см. `required_pip` в `SKILL.md`)
