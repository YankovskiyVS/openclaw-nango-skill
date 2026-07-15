# Yandex Market Partner

- **Skill id:** `yandex-market`
- **Nango provider_config_key:** `yandex-market`
- **Family:** `yandex`
- **Scopes:** market:partner-api
- **Upstream base:** `https://api.partner.market.yandex.ru`

## Examples

### Campaigns v2

```bash
python3 scripts/nango_proxy.py call yandex-market v2/campaigns --json-output
```

## Notes

Market prefers Api-Key for new apps; OAuth still works for transitional setups.
