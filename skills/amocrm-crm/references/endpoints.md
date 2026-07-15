# amoCRM Deals & Pipeline

- **Skill id:** `amocrm-crm`
- **Nango provider_config_key:** `amocrm-crm`
- **Family:** `amocrm`
- **Scopes:** account data (selected in amoМаркет)
- **Upstream base:** `https://{subdomain}.amocrm.ru`

## Examples

### Leads

```bash
python3 scripts/nango_proxy.py call amocrm-crm api/v4/leads --json-output
```

### Contacts

```bash
python3 scripts/nango_proxy.py call amocrm-crm api/v4/contacts --json-output
```
