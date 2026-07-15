# Bitrix24 Messenger

- **Skill id:** `bitrix24-im`
- **Nango provider_config_key:** `bitrix24-im`
- **Family:** `bitrix24`
- **Scopes:** im, imbot, imopenlines
- **Upstream base:** `https://{domain}/rest`

## Examples

### Recent dialogs

```bash
python3 scripts/nango_proxy.py call bitrix24-im im.recent.get --json-output
```
