# amoCRM Telephony

- **Skill id:** `amocrm-telephony`
- **Nango provider_config_key:** `amocrm-telephony`
- **Family:** `amocrm`
- **Scopes:** account data
- **Upstream base:** `https://{subdomain}.amocrm.ru`

## Examples

### Events notes

```bash
python3 {baseDir}/scripts/nango_proxy.py call amocrm-telephony api/v4/events --query 'filter[type]=incoming_call' --json-output
```
