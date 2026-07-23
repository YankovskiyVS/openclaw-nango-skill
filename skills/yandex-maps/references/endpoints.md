# Yandex Maps

- **Skill id:** `yandex-maps`
- **Nango provider_config_key:** `yandex-maps`
- **Family:** `yandex`
- **Scopes:** msps:public_bookmarks
- **Upstream base:** `https://api-maps.yandex.ru`

## Examples

### After OAuth, call Maps endpoints as documented for bookmarks API

```bash
python3 {baseDir}/scripts/nango_proxy.py call yandex-maps v1/ --json-output
```

## Notes

Exact bookmark REST paths depend on Maps product API; keep OAuth connection scoped to bookmarks.
