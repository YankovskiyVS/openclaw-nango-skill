# Bitrix24 CRM

- **Skill id:** `bitrix24-crm`
- **Nango provider_config_key:** `bitrix24-crm`
- **Family:** `bitrix24`
- **Scopes:** crm
- **Upstream base:** `https://{domain}/rest`

## Examples

### List leads

```bash
python3 scripts/nango_proxy.py call bitrix24-crm crm.lead.list --json-output
```

### List deals

```bash
python3 scripts/nango_proxy.py call bitrix24-crm crm.deal.list --json-output
```

## Notes

Requires OAuth connection for provider_config_key bitrix24-crm.
