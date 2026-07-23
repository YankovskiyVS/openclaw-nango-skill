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

Upstream auth header is Bearer (set by Nango provider template).
