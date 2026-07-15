# Bitrix24 Disk

- **Skill id:** `bitrix24-disk`
- **Nango provider_config_key:** `bitrix24-disk`
- **Family:** `bitrix24`
- **Scopes:** disk
- **Upstream base:** `https://{domain}/rest`

## Examples

### Storage list

```bash
python3 scripts/nango_proxy.py call bitrix24-disk disk.storage.getlist --json-output
```
