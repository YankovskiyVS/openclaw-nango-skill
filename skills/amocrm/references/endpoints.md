# amoCRM

- **Skill id:** `amocrm`
- **Nango provider_config_key:** `amocrm`
- **Family:** `amocrm`
- **Scopes:** account data (coarse OAuth scopes in amoМаркет)
- **Upstream base:** `https://{subdomain}.amocrm.ru`

## Examples

### Account

```bash
python3 scripts/nango_proxy.py call amocrm api/v4/account --json-output
```

## Notes

amoCRM OAuth scopes are coarse; module skills are separate apps for UX/isolation.
