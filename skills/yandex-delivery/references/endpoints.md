# Yandex Delivery Partner

- **Skill id:** `yandex-delivery`
- **Nango provider_config_key:** `yandex-delivery`
- **Family:** `yandex`
- **Scopes:** delivery:partner-api
- **Upstream base:** `https://b2b.taxi.yandex.net`

## Examples

### Platform probe

```bash
python3 scripts/nango_proxy.py call yandex-delivery api/b2b/platform/offers/create --method POST --json '{}' --json-output
```

## Notes

Upstream auth header is Bearer (set by Nango provider template).
