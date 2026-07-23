# Yandex Calendar

- **Skill id:** `yandex-calendar`
- **Nango provider_config_key:** `yandex-calendar`
- **Family:** `yandex`
- **Scopes:** calendar:all
- **Upstream base:** `https://caldav.yandex.ru`

## Examples

### CalDAV root

```bash
python3 {baseDir}/scripts/nango_proxy.py call yandex-calendar calendars/ --json-output
```

## Notes

CalDAV (ICS), not Google Calendar JSON API.
