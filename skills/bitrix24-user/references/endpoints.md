# Bitrix24 Users & Structure

- **Skill id:** `bitrix24-user`
- **Nango provider_config_key:** `bitrix24-user`
- **Family:** `bitrix24`
- **Scopes:** user, department
- **Upstream base:** `https://{domain}/rest`

## Examples

### Current user

```bash
python3 scripts/nango_proxy.py call bitrix24-user user.current --json-output
```

### Departments

```bash
python3 scripts/nango_proxy.py call bitrix24-user department.get --json-output
```
