# Yandex Direct

- **Skill id:** `yandex-direct`
- **Nango provider_config_key:** `yandex-direct`
- **Family:** `yandex`
- **Scopes:** direct:api
- **Upstream base:** `https://api.direct.yandex.com`

## Examples

### JSON v5 campaigns

```bash
python3 {baseDir}/scripts/nango_proxy.py call yandex-direct json/v5/campaigns --method POST --json '{"method":"get","params":{"SelectionCriteria":{},"FieldNames":["Id","Name"]}}' --json-output
```

## Notes

Nango injects the provider credential. The caller must not supply or override auth and Nango control headers. After a confirmed Direct mutation, read the campaign and compare intended fields; after an uncertain dispatch, inspect campaign state before retrying.
