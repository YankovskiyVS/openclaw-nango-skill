# Yandex Delivery Partner

- **Skill id:** `yandex-delivery`
- **Nango provider_config_key:** `yandex-delivery`
- **Family:** `yandex`
- **Scopes:** delivery:partner-api
- **Upstream base:** `https://b2b.taxi.yandex.net`

## Examples

### Legacy create shape — do not execute without real required fields

```bash
python3 {baseDir}/scripts/nango_proxy.py call yandex-delivery api/b2b/platform/offers/create --method POST --json '{}' --json-output
```

## Notes

The create route requires the exact matching Delivery product schema. Never send an empty create body as a connectivity test.
