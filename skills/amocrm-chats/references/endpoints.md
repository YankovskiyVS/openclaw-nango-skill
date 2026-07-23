# amoCRM Chats

- **Skill id:** `amocrm-chats`
- **Nango provider_config_key:** `amocrm-chats`
- **Family:** `amocrm`
- **Scopes:** account data
- **Upstream base:** `https://{subdomain}.amocrm.ru`

## Examples

### Talks

```bash
python3 {baseDir}/scripts/nango_proxy.py call amocrm-chats api/v4/talks --json-output
```

## Notes

Read Talks through `api/v4/talks`. Send outbound messages through the registered `nango_action` `send-message` action with `providerConfigKey` `amocrm-chats`; confirm the returned message id and inspect chat state before retrying an unknown outcome.
