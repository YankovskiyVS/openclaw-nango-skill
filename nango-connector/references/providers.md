# Provider catalog

`provider_config_key` values must match Nango integration unique keys configured in the environment.

## yandex

Yandex OAuth via **Yandex ID** (scopes: `login:email`, `login:info`, `login:avatar`, …).

Nango proxy base URL: `https://login.yandex.ru`  
Auth header upstream: `Authorization: OAuth {access_token}` (not Bearer).

This integration is **not** Yandex Calendar and **not** legacy Translate API (`translate.yandex.net` + API key).

| Action | Method | Path |
| --- | --- | --- |
| Get connected user profile | GET | `info?format=json` |

Example (verify OAuth + proxy end-to-end):

```bash
python3 scripts/nango_proxy.py call yandex info \
  --query 'format=json' \
  --json-output
```

Expected **200** body (fields depend on granted scopes):

```json
{
  "login": "user",
  "id": "1000034426",
  "default_email": "user@yandex.ru",
  "client_id": "..."
}
```

Docs: https://yandex.com/dev/id/doc/en/user-information

### Yandex Calendar / Translate

- **Calendar** — CalDAV (`https://caldav.yandex.ru`), no Google-style `calendar/v3/events`. Needs a separate integration.
- **Translate (legacy v1.5)** — `https://translate.yandex.net/api/v1.5/tr.json/*` with API **key**, not OAuth. Needs a separate `API_KEY` integration.

## google

Google OAuth (Gmail, Calendar, Drive, etc. depending on scopes).

| Action | Method | Path |
| --- | --- | --- |
| List Gmail messages | GET | `gmail/v1/users/me/messages` |
| List calendar events | GET | `calendar/v3/calendars/primary/events` |

Example:

```bash
python3 scripts/nango_proxy.py call google calendar/v3/calendars/primary/events \
  --query 'maxResults=10'
```
