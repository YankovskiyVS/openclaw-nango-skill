# Yandex Market Partner

- **Skill id:** `yandex-market`
- **Nango provider_config_key:** `yandex-market`
- **Family:** `yandex`
- **Scopes:** market:partner-api
- **Upstream base:** `https://api.partner.market.yandex.ru`

## Examples

### Campaigns v2

```bash
python3 {baseDir}/scripts/nango_proxy.py call yandex-market v2/campaigns --json-output
```

## Notes

Authentication behavior depends on the configured Nango provider and has not been live-verified by this repository.
