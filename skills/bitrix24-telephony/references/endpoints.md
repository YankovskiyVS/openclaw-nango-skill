# Bitrix24 Telephony

- **Skill id:** `bitrix24-telephony`
- **Nango provider_config_key:** `bitrix24-telephony`
- **Family:** `bitrix24`
- **Scopes:** telephony, call
- **Upstream base:** `https://{domain}/rest`

## Examples

### External lines

```bash
python3 scripts/nango_proxy.py call bitrix24-telephony telephony.externalLine.get --json-output
```
